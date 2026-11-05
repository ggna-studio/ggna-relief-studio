"""GGNA bundled web runtime. Python standard library only; no Node.js needed."""
from __future__ import annotations
import argparse
import base64
import copy
import email.parser
import email.policy
import hashlib
import hmac
import http.client
import http.server
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
import webbrowser

APP_ID = "ggna.relief.web"
VERSION = "1.2.0"
MODEL_FILES = [
    ("diffusion_models", "flux1-dev-kontext_fp8_scaled.safetensors"),
    ("loras", "斑马数字科技_Lora.safetensors"),
    ("text_encoders", "clip_l.safetensors"),
    ("text_encoders", "t5xxl_fp8_e4m3fn_scaled.safetensors"),
    ("vae", "ae.safetensors"), ("upscale_models", "BANMAsharp_V3.pt"),
]
NODE_PACKS = ["ComfyUI_essentials", "ComfyUI-Easy-Use", "ComfyUI-Image-Filters", "was-node-suite-comfyui"]
SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]{1,160}$")
PNG = b"\x89PNG\r\n\x1a\n"

class UserError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def atomic_json(file, value):
    file = Path(file)
    temporary = file.with_suffix(file.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(file)

def b64(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

def unb64(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

def sign_ticket(payload, secret):
    body = b64(json.dumps(payload, separators=(",", ":")).encode())
    return body + "." + b64(hmac.digest(secret, body.encode(), "sha256"))

def verify_ticket(ticket, secret):
    try:
        if not isinstance(ticket, str) or len(ticket) > 3000:
            raise ValueError()
        body, signature = ticket.split(".")
        if not hmac.compare_digest(hmac.digest(secret, body.encode(), "sha256"), unb64(signature)):
            raise ValueError()
        value = json.loads(unb64(body))
        if value.get("owner") != "local" or value.get("expires", 0) < time.time() * 1000 or not SAFE_ID.fullmatch(value.get("id", "")):
            raise ValueError()
        return value
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise UserError("Vé tác vụ không hợp lệ hoặc đã hết hạn.", 403) from None

def validate_source(image, preset, seed, request_id):
    limits = {"draft": 768, "balanced": 1152, "original": 2048}
    limit = limits.get(preset, 0)
    if not image or len(image) > 8 * 1024 * 1024 or len(image) < 33 or image[:8] != PNG or image[12:16] != b"IHDR" or image[24] != 8:
        raise UserError("Cần ảnh PNG 8-bit tối đa 8 MB.")
    width, height = struct.unpack(">II", image[16:24])
    if not limit or min(width, height) < 1 or max(width, height) > limit or width * height > 4194304:
        raise UserError("Kích thước ảnh vượt giới hạn preset.")
    try:
        number = int(seed)
        if str(number) != str(seed).strip() or not 0 <= number <= 9007199254740991:
            raise ValueError()
    except (TypeError, ValueError):
        raise UserError("Seed phải là số nguyên không âm an toàn.") from None
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{16,100}", request_id):
        raise UserError("Request ID không hợp lệ.")
    return number

def parse_form(content_type, body):
    if not content_type.startswith("multipart/form-data;"):
        raise UserError("Cần ảnh được gửi bằng multipart/form-data.")
    message = email.parser.BytesParser(policy=email.policy.default).parsebytes(
        ("Content-Type: " + content_type + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body)
    if not message.is_multipart():
        raise UserError("Dữ liệu upload không hợp lệ.")
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name not in {"image", "preset", "seed", "requestId"} or name in fields:
            continue
        value = part.get_payload(decode=True) or b""
        fields[name] = value if name == "image" else value.decode("utf-8", errors="strict")
    return fields

def gpu_health(stats, info, graph):
    device = next((d for d in stats.get("devices", []) if d.get("type") == "cuda" or "NVIDIA" in d.get("name", "")), None)
    if not device:
        return {"ready": False, "message": "ComfyUI chưa nhận GPU CUDA. Kiểm tra GPU NVIDIA và driver."}
    missing_nodes = sorted({n["class_type"] for n in graph.values()} - info.keys())
    selectors = [("UNETLoader", "unet_name", 0), ("LoraLoaderModelOnly", "lora_name", 1),
                 ("DualCLIPLoader", "clip_name1", 2), ("DualCLIPLoader", "clip_name2", 3),
                 ("VAELoader", "vae_name", 4), ("UpscaleModelLoader", "model_name", 5)]
    missing_models = []
    for node, field, index in selectors:
        selector = info.get(node, {}).get("input", {}).get("required", {}).get(field, [])
        options = selector[0] if selector and isinstance(selector[0], list) else (selector[1].get("options", []) if len(selector) > 1 and isinstance(selector[1], dict) else [])
        if MODEL_FILES[index][1] not in options:
            missing_models.append(MODEL_FILES[index][1])
    ready = not missing_nodes and not missing_models
    return {"ready": ready, "gpuName": device["name"], "vramMB": round(device.get("vram_total", 0) / 1048576),
            "missingNodes": missing_nodes, "missingModels": missing_models,
            "message": "GPU, model và node relief đã sẵn sàng." if ready else "ComfyUI thiếu node hoặc model relief."}

class Runtime:
    def __init__(self, root, data, comfy_port=8190):
        self.root, self.data = Path(root).resolve(), Path(data).resolve()
        self.comfy_port = comfy_port
        self.comfy_root = self.root / "engine" / "ComfyUI"
        self.python = self.root / "engine" / "python_embeded" / "python.exe"
        self.ui = self.root / "app" / "ui"
        self.child = None
        self.error = ""
        self.lock = threading.RLock()
        self.health_lock = threading.Lock()
        self.health_cache = None
        self.health_time = 0
        self.instance = hashlib.sha256(str(self.root).casefold().encode()).hexdigest()[:24]
        for name in ["logs", "input", "output", "temp", "user", "cache"]:
            (self.data / name).mkdir(parents=True, exist_ok=True)
        secret_file = self.data / "secret.key"
        if not secret_file.exists():
            secret_file.write_bytes(secrets.token_bytes(32))
        self.secret = secret_file.read_bytes()
        if len(self.secret) < 32:
            raise UserError("Khóa tác vụ trong thư mục dữ liệu không hợp lệ.")
        self.graph = json.loads((self.root / "app" / "workflow_api.json").read_text(encoding="utf-8"))
        self.submissions_file = self.data / "submissions.json"
        try:
            self.submissions = json.loads(self.submissions_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            self.submissions = {}

    def upstream(self, path, method="GET", body=None, headers=None, binary=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.comfy_port, timeout=30)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            content = response.read(128 * 1024 * 1024 + 1)
            if len(content) > 128 * 1024 * 1024:
                raise UserError("File kết quả vượt giới hạn 128 MB.", 413)
            if not 200 <= response.status < 300:
                detail = ""
                try:
                    data = json.loads(content)
                    error = data.get("error", "")
                    detail = error.get("message", "") if isinstance(error, dict) else str(error)
                except (ValueError, TypeError):
                    pass
                raise UserError(f"ComfyUI trả lỗi {response.status}. {detail[:240]}", 502)
            return content if binary else json.loads(content)
        finally:
            connection.close()

    def missing_files(self):
        missing = []
        if not self.python.is_file():
            missing.append("engine/python_embeded/python.exe")
        for folder, name in MODEL_FILES:
            if not (self.comfy_root / "models" / folder / name).is_file():
                missing.append(name)
        for name in NODE_PACKS:
            if not (self.comfy_root / "custom_nodes" / name / "__init__.py").is_file():
                missing.append(name)
        return missing

    def app_state(self):
        return {"appId": APP_ID, "version": VERSION, "instance": self.instance, "bundle": True, "missingFiles": self.missing_files(),
                "starting": bool(self.child and self.child.poll() is None and not (self.health_cache and self.health_cache.get("ready"))),
                "running": bool(self.child and self.child.poll() is None), "error": self.error,
                "message": "Bộ Python, ComfyUI và model đã được đóng gói sẵn."}

    def health(self):
        with self.health_lock:
            if self.health_cache and time.monotonic() - self.health_time < 8:
                return self.health_cache
            result = {"provider": "ComfyUI local", "workflow": "BANMA_AIGCv3"}
            try:
                stats = self.upstream("/system_stats")
                if not self.same_bundle_engine(stats):
                    raise UserError("Cổng GPU đang thuộc một bộ ComfyUI khác. Đổi cổng hoặc dừng phiên đó.", 409)
                result.update(gpu_health(stats, self.upstream("/object_info"), self.graph))
            except (OSError, ValueError, http.client.HTTPException, UserError):
                exited = self.child and self.child.poll() is not None
                result.update(ready=False, message=self.error or ("ComfyUI đã dừng. Xem data/logs/comfy-stderr.log." if exited else "Đang khởi động ComfyUI. Lần đầu có thể mất nhiều phút."))
            self.health_cache, self.health_time = result, time.monotonic()
            return result

    def start_gpu(self):
        with self.lock:
            if self.child and self.child.poll() is None:
                return self.app_state()
            try:
                stats = self.upstream("/system_stats")
                if not self.same_bundle_engine(stats):
                    raise UserError(f"Cổng GPU {self.comfy_port} đang được ComfyUI khác dùng. Dừng phiên đó hoặc chọn cổng khác bằng launcher.", 409)
                return self.app_state()
            except (OSError, http.client.HTTPException, ValueError):
                pass
            missing = self.missing_files()
            if missing:
                self.error = "Giải nén chưa đủ file: " + ", ".join(missing)
                return self.app_state()
            args = [str(self.python), "-B", "-X", "utf8", "-s", str(self.comfy_root / "main.py"),
                    "--windows-standalone-build", "--disable-auto-launch", "--listen", "127.0.0.1", "--port", str(self.comfy_port),
                    "--lowvram", "--reserve-vram", "1.5", "--preview-method", "none", "--disable-api-nodes",
                    "--disable-all-custom-nodes", "--whitelist-custom-nodes", *NODE_PACKS]
            for name in ["user", "input", "output", "temp"]:
                args += [f"--{name}-directory", str(self.data / name)]
            args += ["--database-url", "sqlite:///" + (self.data / "user" / "comfyui.db").as_posix()]
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            with (self.data / "logs" / "comfy-stdout.log").open("ab") as out, (self.data / "logs" / "comfy-stderr.log").open("ab") as err:
                self.child = subprocess.Popen(args, cwd=self.comfy_root, stdin=subprocess.DEVNULL, stdout=out, stderr=err, creationflags=flags,
                                              env={**os.environ, "PYTHONUTF8": "1", "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1", "DO_NOT_TRACK": "1",
                                                   "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HOME": str(self.data / "cache" / "huggingface"),
                                                   "TORCH_HOME": str(self.data / "cache" / "torch"), "XDG_CACHE_HOME": str(self.data / "cache")})
            self.error = ""
            self.health_cache = None
            return self.app_state()

    def same_bundle_engine(self, stats):
        argv = [str(value).casefold() for value in stats.get("system", {}).get("argv", [])]
        return str(self.comfy_root / "main.py").casefold() in argv and str(self.data / "user").casefold() in argv

    def stop_gpu(self):
        if self.child and self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                self.child.kill()

    def submit(self, fields):
        image, preset = fields.get("image", b""), fields.get("preset", "balanced")
        key = fields.get("requestId", "")
        seed = validate_source(image, preset, fields.get("seed", "408416742087713"), key)
        with self.lock:
            previous = self.submissions.get(key)
            if previous:
                if previous.get("response"):
                    return previous["response"]
                raise UserError("Yêu cầu này đã được gửi hoặc chưa rõ kết quả. Kiểm tra hàng đợi ComfyUI trước khi tạo lại.", 409)
            if len(self.submissions) >= 1000:
                self.submissions.pop(next(iter(self.submissions)))
            self.submissions[key] = {"phase": "sending", "created": time.time()}
            atomic_json(self.submissions_file, self.submissions)
        filename = "ggna-" + uuid.uuid4().hex + ".png"
        boundary = "----GGNA" + uuid.uuid4().hex
        prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\ninput\r\n'
                  f'--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\nfalse\r\n'
                  f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{filename}"\r\nContent-Type: image/png\r\n\r\n').encode()
        uploaded = self.upstream("/upload/image", "POST", prefix + image + f"\r\n--{boundary}--\r\n".encode(), {"Content-Type": "multipart/form-data; boundary=" + boundary})
        if uploaded.get("type") != "input" or not uploaded.get("name"):
            raise UserError("ComfyUI không trả ảnh upload hợp lệ.", 502)
        graph = copy.deepcopy(self.graph)
        graph["23"]["inputs"]["image"] = (uploaded.get("subfolder", "").rstrip("/") + "/" if uploaded.get("subfolder") else "") + uploaded["name"]
        graph["34:28"]["inputs"].update(seed=seed, steps=20 if preset == "draft" else 24)
        graph["34:10"]["inputs"]["filename_prefix"] = "ggna/result"
        job = self.upstream("/prompt", "POST", json.dumps({"prompt": graph, "client_id": "ggna-" + uuid.uuid4().hex}).encode(), {"Content-Type": "application/json"})
        job_id = job.get("prompt_id", "")
        if not SAFE_ID.fullmatch(job_id):
            raise UserError("Chưa có ID tác vụ; kiểm tra hàng đợi trước khi gửi lại.", 502)
        result = {"id": job_id, "ticket": sign_ticket({"id": job_id, "owner": "local", "expires": int(time.time() * 1000) + 23 * 3600000}, self.secret), "status": "queued"}
        with self.lock:
            self.submissions[key] = {"phase": "submitted", "response": result}
            atomic_json(self.submissions_file, self.submissions)
        return result

    def read_job(self, ticket):
        job_id = verify_ticket(ticket, self.secret)["id"]
        history = self.upstream("/history/" + job_id)
        record = history.get(job_id)
        if record:
            status = record.get("status", {})
            state = "failed" if status.get("status_str") == "error" else "succeeded" if status.get("completed") or status.get("status_str") == "success" else "running"
            images = record.get("outputs", {}).get("34:10", {}).get("images", [])
            image = next((i for i in images if i.get("type") == "output" and i.get("filename")), None)
            return {"id": job_id, "status": state, "progress": 1 if state == "succeeded" else None, "queue": None, "hasImage": bool(image),
                    "error": "Tác vụ GPU thất bại. Xem data/logs/comfy-stderr.log." if state == "failed" else None}, image
        queue = self.upstream("/queue")
        running = any(row[1] == job_id for row in queue.get("queue_running", []))
        waiting = next((i for i, row in enumerate(queue.get("queue_pending", [])) if row[1] == job_id), None)
        return {"id": job_id, "status": "running" if running else "queued" if waiting is not None else "expired", "queue": waiting + 1 if waiting is not None else None,
                "progress": None, "hasImage": False, "error": None}, None

    def image_result(self, ticket):
        job, image = self.read_job(ticket)
        if job["status"] != "succeeded":
            raise UserError("Ảnh chưa sẵn sàng.", 409)
        if not image:
            raise UserError("Không có PNG từ node xuất relief.", 404)
        query = urllib.parse.urlencode({"filename": image["filename"], "subfolder": image.get("subfolder", ""), "type": "output"})
        return self.upstream("/view?" + query, binary=True)

def make_handler(runtime):
    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "GGNA/1.2"
        def log_message(self, message, *args):
            # Do not write job tickets, query strings or image metadata to logs.
            if not self.path.startswith("/api/jobs/"):
                print(time.strftime("%H:%M:%S"), self.command, self.path.split("?")[0], flush=True)

        def send(self, content, status=200, content_type="application/json; charset=utf-8"):
            if not isinstance(content, bytes):
                content = json.dumps(content, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(content)

        def check_origin(self):
            host = self.headers.get("Host", "")
            allowed = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if host not in allowed or self.headers.get("Origin", "http://" + host) != "http://" + host:
                raise UserError("Nguồn yêu cầu không hợp lệ.", 403)

        def do_GET(self):
            self.handle_request()

        def do_HEAD(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def handle_request(self):
            try:
                self.check_origin()
                url = urllib.parse.urlsplit(self.path)
                if self.command in {"GET", "HEAD"}:
                    if url.path == "/api/app":
                        return self.send(runtime.app_state())
                    if url.path == "/api/health":
                        return self.send(runtime.health())
                    if url.path in {"/api/jobs/status", "/api/jobs/result"}:
                        ticket = urllib.parse.parse_qs(url.query).get("ticket", [""])[0]
                        if url.path.endswith("status"):
                            return self.send(runtime.read_job(ticket)[0])
                        return self.send(runtime.image_result(ticket), content_type="image/png")
                    if url.path.startswith("/api/"):
                        raise UserError("Không có API này.", 404)
                    relative = "standalone/index.html" if url.path == "/" else urllib.parse.unquote(url.path).lstrip("/")
                    file = (runtime.ui / relative).resolve()
                    if not file.is_relative_to(runtime.ui.resolve()):
                        raise UserError("Đường dẫn không hợp lệ.", 403)
                    if not file.is_file():
                        raise UserError("Không tìm thấy file.", 404)
                    return self.send(file.read_bytes(), content_type=mimetypes.guess_type(file.name)[0] or "application/octet-stream")
                if self.command == "POST":
                    if self.headers.get("Transfer-Encoding"):
                        raise UserError("Yêu cầu cần Content-Length.", 411)
                    length = int(self.headers.get("Content-Length", "0"))
                    if not 0 <= length <= 9 * 1024 * 1024:
                        raise UserError("Upload tối đa 8 MB.", 413)
                    body = self.rfile.read(length)
                    if url.path == "/api/jobs":
                        return self.send(runtime.submit(parse_form(self.headers.get("Content-Type", ""), body)), 201)
                    if url.path == "/api/gpu/start":
                        return self.send(runtime.start_gpu())
                    if url.path == "/api/control/stop":
                        if not hmac.compare_digest(self.headers.get("X-GGNA-Control", ""), b64(runtime.secret)):
                            raise UserError("Không có quyền dừng ứng dụng.", 403)
                        self.send({"stopping": True})
                        def shutdown():
                            runtime.stop_gpu()
                            self.server.shutdown()
                        threading.Thread(target=shutdown, daemon=True).start()
                        return
                raise UserError("Không có API này.", 404)
            except UserError as error:
                self.send({"error": str(error)}, error.status)
            except (OSError, http.client.HTTPException, ValueError) as error:
                self.send({"error": "Chưa nhận được phản hồi hợp lệ từ GPU. Xem log và kiểm tra tác vụ trước khi tạo lại."}, 502)

    return Handler

def local_request(port, path, method="GET", headers=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request(method, path, headers=headers or {})
        response = connection.getresponse()
        value = json.loads(response.read())
        if response.status != 200:
            raise UserError(value.get("error", "Yêu cầu không thành công."))
        return value
    finally:
        connection.close()

def descriptor(data):
    try:
        return json.loads((Path(data) / "server.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None

def existing_server(root, data):
    saved = descriptor(data)
    if not saved:
        return None
    instance = hashlib.sha256(str(root.resolve()).casefold().encode()).hexdigest()[:24]
    try:
        state = local_request(saved["port"], "/api/app")
        if state.get("appId") == APP_ID and state.get("instance") == instance and saved.get("instance") == instance:
            return saved
    except (OSError, ValueError, KeyError, http.client.HTTPException, UserError):
        pass
    return None

def main():
    parser = argparse.ArgumentParser(description="GGNA Relief Studio bundled web launcher")
    parser.add_argument("mode", choices=["start", "serve", "stop"], nargs="?", default="start")
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--data-dir", type=Path)
    parser.add_argument("--port", type=int, default=4180)
    parser.add_argument("--comfy-port", type=int, default=8190)
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--no-gpu", action="store_true", help="Chỉ mở web, không tự khởi động ComfyUI")
    args = parser.parse_args()
    root = args.root.resolve()
    data = (args.data_dir or root / "data").resolve()
    if not all(1024 <= p <= 65535 for p in [args.port, args.comfy_port]):
        raise UserError("Cổng phải trong khoảng 1024–65535.")
    data.mkdir(parents=True, exist_ok=True)
    saved = existing_server(root, data)
    if args.mode == "stop":
        if not saved:
            print("GGNA hiện không chạy.")
            return
        secret = (data / "secret.key").read_bytes()
        local_request(saved["port"], "/api/control/stop", "POST", {"X-GGNA-Control": b64(secret)})
        print("Đã yêu cầu dừng GGNA và GPU do phiên này mở.")
        return
    if saved:
        if not args.no_browser:
            webbrowser.open(f"http://127.0.0.1:{saved['port']}/")
        print(f"GGNA đang chạy: http://127.0.0.1:{saved['port']}/")
        return
    if args.mode == "start":
        logs = data / "logs"
        logs.mkdir(exist_ok=True)
        pythonw = Path(sys.executable).with_name("pythonw.exe")
        executable = pythonw if pythonw.is_file() else Path(sys.executable)
        command = [str(executable), "-B", "-X", "utf8", "-s", str(Path(__file__).resolve()), "serve", "--root", str(root), "--data-dir", str(data), "--port", str(args.port), "--comfy-port", str(args.comfy_port)]
        if args.no_gpu:
            command.append("--no-gpu")
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        with (logs / "web.log").open("ab") as log:
            child = subprocess.Popen(command, cwd=root, stdout=log, stderr=log, stdin=subprocess.DEVNULL, creationflags=flags)
        for _ in range(80):
            saved = existing_server(root, data)
            if saved:
                if not args.no_browser:
                    webbrowser.open(f"http://127.0.0.1:{saved['port']}/")
                print(f"GGNA đã mở: http://127.0.0.1:{saved['port']}/")
                print("Dùng DUNG_TOOL.bat để dừng web và GPU khi dùng xong.")
                return
            if child.poll() is not None:
                break
            time.sleep(0.25)
        raise UserError("Chưa mở được web. Xem data/logs/web.log; kiểm tra gói đã giải nén đầy đủ.")
    runtime = Runtime(root, data, args.comfy_port)
    try:
        server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(runtime))
    except OSError as error:
        if getattr(error, "winerror", None) != 10048 and getattr(error, "errno", None) != 98:
            raise
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), make_handler(runtime))
    atomic_json(data / "server.json", {"appId": APP_ID, "instance": runtime.instance, "pid": os.getpid(), "port": server.server_port})
    if not args.no_gpu:
        def boot():
            try:
                runtime.start_gpu()
            except Exception as error:
                runtime.error = str(error)
        threading.Thread(target=boot, daemon=True).start()
    print(f"GGNA web: http://127.0.0.1:{server.server_port}/", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        runtime.stop_gpu()

if __name__ == "__main__":
    try:
        main()
    except (UserError, OSError) as error:
        print("GGNA: " + str(error), file=sys.stderr)
        sys.exit(1)
