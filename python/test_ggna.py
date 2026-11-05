import copy
import http.client
import http.server
import json
from pathlib import Path
import secrets
import struct
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
sys.path.insert(0,str(Path(__file__).resolve().parent))
from ggna_server import (Runtime, UserError, MODEL_FILES, NODE_PACKS, PNG, sign_ticket,
                             verify_ticket, validate_source, gpu_health, make_handler)

GRAPH = json.loads(Path(__file__).with_name("workflow_api.json").read_text(encoding="utf-8"))
IMAGE = PNG + struct.pack(">I",13) + b"IHDR" + struct.pack(">II",64,64) + bytes([8,2,0,0,0]) + bytes(4)

def object_info():
    info = {n["class_type"]:{"input":{"required":{}}} for n in GRAPH.values()}
    for node,field,index in [("UNETLoader","unet_name",0),("LoraLoaderModelOnly","lora_name",1),
                             ("DualCLIPLoader","clip_name1",2),("DualCLIPLoader","clip_name2",3),
                             ("VAELoader","vae_name",4),("UpscaleModelLoader","model_name",5)]:
        info[node]["input"]["required"][field] = [[MODEL_FILES[index][1]]]
    info["UpscaleModelLoader"]["input"]["required"]["model_name"] = ["COMBO",{"options":[MODEL_FILES[5][1]]}]
    return info

class FakeComfy(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):
        pass
    def reply(self,value):
        content=value if isinstance(value,bytes) else json.dumps(value).encode()
        self.send_response(200);self.send_header("Content-Length",str(len(content)));self.end_headers();self.wfile.write(content)
    def do_GET(self):
        p=urllib.parse.urlsplit(self.path)
        if p.path=="/system_stats":
            return self.reply({"system":{"argv":[str(self.server.runtime.comfy_root/"main.py"),"--user-directory",str(self.server.runtime.data/"user")]},"devices":[{"type":"cuda","name":"RTX test","vram_total":12884901888}]})
        if p.path=="/object_info":return self.reply(object_info())
        if p.path=="/history/test-job":
            return self.reply({"test-job":{"status":{"status_str":"success","completed":True},"outputs":{"34:10":{"images":[{"filename":"result.png","subfolder":"ggna","type":"output"}]}}}} if self.server.finished else {})
        if p.path=="/queue":return self.reply({"queue_pending":[],"queue_running":[[0,"test-job"]]})
        if p.path=="/view":
            self.server.view=urllib.parse.parse_qs(p.query)
            return self.reply(IMAGE)
        self.send_error(404)
    def do_POST(self):
        body=self.rfile.read(int(self.headers["Content-Length"]))
        if self.path=="/upload/image":
            self.server.uploads+=1
            self.server.upload=body
            return self.reply({"name":"unique.png","type":"input","subfolder":""})
        if self.path=="/prompt":
            self.server.prompts+=1;self.server.graph=json.loads(body)["prompt"]
            return self.reply({"prompt_id":"test-job"})
        self.send_error(404)

class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="GGNA web Unicode ")
        self.root=Path(self.temp.name)/"Bộ cho khách"
        (self.root/"app/ui/standalone").mkdir(parents=True)
        (self.root/"app/workflow_api.json").write_text(json.dumps(GRAPH),encoding="utf-8")
        (self.root/"app/ui/standalone/index.html").write_text("GGNA web",encoding="utf-8")
        self.runtime=Runtime(self.root,self.root/"data")
    def tearDown(self):
        self.temp.cleanup()
    def test_tickets_are_signed_expire_and_cannot_cross_bundle_keys(self):
        key=secrets.token_bytes(32);payload={"id":"test-job","owner":"local","expires":int(time.time()*1000)+60000}
        ticket=sign_ticket(payload,key)
        self.assertEqual(verify_ticket(ticket,key)["id"],"test-job")
        for bad,key2 in [(ticket,secrets.token_bytes(32)),(sign_ticket({**payload,"expires":0},key),key),(sign_ticket({**payload,"id":"../private"},key),key)]:
            with self.assertRaises(UserError):verify_ticket(bad,key2)
    def test_cuda_and_all_models_are_verified_including_new_combo_schema(self):
        stats={"devices":[{"type":"cuda","name":"RTX 3060","vram_total":12884901888}]}
        self.assertTrue(gpu_health(stats,object_info(),GRAPH)["ready"])
        info=object_info();del info["ReferenceLatent"]
        self.assertIn("ReferenceLatent",gpu_health(stats,info,GRAPH)["missingNodes"])
        info=object_info();info["UpscaleModelLoader"]["input"]["required"]["model_name"][1]["options"]=[]
        self.assertEqual(gpu_health(stats,info,GRAPH)["missingModels"],["BANMAsharp_V3.pt"])
        self.assertFalse(gpu_health({"devices":[]},info,GRAPH)["ready"])
    def test_upload_limits_and_safe_seed_are_enforced_before_gpu_contact(self):
        self.assertEqual(validate_source(IMAGE,"draft","42","request-1234567890"),42)
        large=bytearray(IMAGE);large[16:24]=struct.pack(">II",2048,2048)
        for image,preset,seed,key in [(b"x","draft","42","request-1234567890"),(bytes(large),"draft","42","request-1234567890"),(IMAGE,"draft","9007199254740992","request-1234567890"),(IMAGE,"draft","42","x")]:
            with self.assertRaises(UserError):validate_source(image,preset,seed,key)
    def test_preflight_finds_missing_files_without_importing_torch(self):
        self.assertEqual(len(self.runtime.missing_files()),11)
        self.runtime.python.parent.mkdir(parents=True);self.runtime.python.touch()
        for folder,name in MODEL_FILES:
            target=self.runtime.comfy_root/"models"/folder/name;target.parent.mkdir(parents=True,exist_ok=True);target.touch()
        for name in NODE_PACKS:
            target=self.runtime.comfy_root/"custom_nodes"/name/"__init__.py";target.parent.mkdir(parents=True);target.touch()
        self.assertEqual(self.runtime.missing_files(),[])
    def test_native_submit_is_persistently_idempotent_and_result_uses_verified_output(self):
        server=http.server.ThreadingHTTPServer(("127.0.0.1",0),FakeComfy)
        server.runtime=self.runtime;server.uploads=server.prompts=0;server.finished=False
        self.runtime.comfy_port=server.server_port
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        try:
            fields={"image":IMAGE,"preset":"draft","seed":"42","requestId":"request-1234567890"}
            response=self.runtime.submit(fields)
            self.assertEqual(self.runtime.submit(fields),response)
            reopened=Runtime(self.root,self.root/"data",server.server_port)
            self.assertEqual(reopened.submit(fields),response)
            self.assertEqual((server.uploads,server.prompts),(1,1))
            self.assertEqual(server.graph["23"]["inputs"]["image"],"unique.png")
            self.assertEqual(server.graph["34:28"]["inputs"]["steps"],20)
            self.assertEqual(server.graph["34:28"]["inputs"]["seed"],42)
            self.assertIn(IMAGE,server.upload)
            self.assertEqual(self.runtime.read_job(response["ticket"])[0]["status"],"running")
            server.finished=True
            self.assertEqual(self.runtime.image_result(response["ticket"]),IMAGE)
            self.assertEqual(server.view,{"filename":["result.png"],"subfolder":["ggna"],"type":["output"]})
            self.assertTrue(self.runtime.health()["ready"])
        finally:
            server.shutdown();server.server_close();thread.join()
    def test_http_host_origin_traversal_and_shutdown_token_are_restricted(self):
        server=http.server.ThreadingHTTPServer(("127.0.0.1",0),make_handler(self.runtime))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def request(path,method="GET",headers=None):
            conn=http.client.HTTPConnection("127.0.0.1",server.server_port);conn.request(method,path,headers=headers or {});res=conn.getresponse();result=(res.status,dict(res.headers),res.read());conn.close();return result
        try:
            status,headers,body=request("/");self.assertEqual(status,200);self.assertEqual(body,b"GGNA web");self.assertIn("script-src 'self'",headers["Content-Security-Policy"])
            self.assertEqual(request("/api/app")[0],200)
            self.assertEqual(request("/",headers={"Host":"evil.example"})[0],403)
            self.assertEqual(request("/api/gpu/start","POST",{"Origin":"https://evil.example"})[0],403)
            self.assertEqual(request("/%2e%2e%5csecret.key")[0],403)
            self.assertEqual(request("/api/control/stop","POST")[0],403)
            self.assertEqual(request("/api/jobs/status?ticket=bad")[0],403)
            self.assertEqual(server.server_address[0],"127.0.0.1")
        finally:
            server.shutdown();server.server_close();thread.join()

if __name__=="__main__":unittest.main(verbosity=2)
