import { buildWorkflow, modelManifest } from './workflow.mjs';
import { nativeHealth, nativeSubmit, nativeReadJob, nativeResult } from './native-comfy.mjs';

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const enc = new TextEncoder();
function config(env) {
  const base = (env.COMFY_BASE_URL || '').trim().replace(/\/$/, '');
  if (!base || !env.RELIEF_JOB_SECRET) return null;
  const url = new URL(base);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Cấu hình COMFY_BASE_URL không hợp lệ.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Máy chủ GPU từ xa phải dùng HTTPS.');
  if (env.RELIEF_JOB_SECRET.length < 32) throw new Error('RELIEF_JOB_SECRET cần ít nhất 32 ký tự.');
  const mode = env.COMFY_API_MODE === 'native' ? 'native' : 'v2';
  if (mode === 'native' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Chế độ native chỉ dùng cho ComfyUI trên máy này.');
  return { base, key: env.COMFY_API_KEY || '', secret: env.RELIEF_JOB_SECRET, mode };
}
const b64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function hmac(secret) { return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']); }
export async function signTicket(payload, secret) {
  const body = b64(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmac(secret), enc.encode(body));
  return body + '.' + b64(new Uint8Array(sig));
}
export async function verifyTicket(ticket, secret, owner) {
  if (typeof ticket !== 'string' || ticket.length > 3000) throw new Error('Vé tác vụ không hợp lệ.');
  const [body, sig, extra] = ticket.split('.');
  if (!body || !sig || extra || !await crypto.subtle.verify('HMAC', await hmac(secret), unb64(sig), enc.encode(body))) throw new Error('Vé tác vụ không hợp lệ.');
  const value = JSON.parse(new TextDecoder().decode(unb64(body)));
  if (value.owner !== owner || !Number.isFinite(value.expires) || value.expires < Date.now() || !/^[a-zA-Z0-9_-]{1,160}$/.test(value.id)) throw new Error('Tác vụ đã hết hạn hoặc không thuộc tài khoản này.');
  return value;
}
async function upstream(cfg, path, init = {}) {
  const headers = new Headers(init.headers);
  if (cfg.key) headers.set('Authorization', `Bearer ${cfg.key}`);
  const result = await fetch(cfg.base + path, { ...init, headers, signal: AbortSignal.timeout(55000), redirect: 'manual' });
  if (!result.ok) {
    let code = '';
    try { const body = await result.json(); code = body.error?.code || ''; } catch {}
    const messages = { 401: 'API key GPU không hợp lệ.', 402: 'Tài khoản GPU đã hết credit.', 403: 'Không có quyền truy cập máy chủ GPU.', 422: 'Workflow hoặc model chưa sẵn sàng trên GPU.', 429: 'Máy chủ GPU đang bận. Hãy kiểm tra tác vụ trước khi gửi lại.' };
    const error = new Error((messages[result.status] || `Máy chủ GPU trả lỗi ${result.status}.`) + (code ? ` (${String(code).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80)})` : ''));
    error.status = result.status >= 500 ? 502 : result.status;
    throw error;
  }
  return result;
}
async function readJob(cfg, ticket, owner) {
  const value = await verifyTicket(ticket, cfg.secret, owner);
  if (cfg.mode === 'native') return nativeReadJob(cfg, value.id);
  return (await upstream(cfg, '/api/v2/jobs/' + encodeURIComponent(value.id))).json();
}

export async function handleAPI(request, env = {}, owner = 'local') {
  const url = new URL(request.url), path = url.pathname;
  try {
    if (path === '/api/health' && request.method === 'GET') {
      const configured = config(env);
      if (configured?.mode === 'native') {
        try { return json({ provider: 'ComfyUI local', workflow: 'BANMA_AIGCv3', ...await nativeHealth(configured) }); }
        catch { return json({ ready: false, provider: 'ComfyUI local', message: 'ComfyUI local chưa sẵn sàng. Chờ khởi động hoặc mở START-LOCAL-GPU.bat.' }); }
      }
      const ready = Boolean(configured);
      return json({ ready, provider: 'Comfy API v2', workflow: 'BANMA_AIGCv3', model: 'FLUX Kontext + BANMA LoRA',
        message: ready ? 'Đã cấu hình GPU. Kết nối được xác nhận khi máy chủ phản hồi.' : 'Chưa kết nối GPU. Bạn có thể chỉnh và xuất heightmap có sẵn.', manifest: modelManifest() });
    }
    const cfg = config(env);
    if (!cfg) return json({ error: 'Chưa cấu hình máy chủ GPU. Xem hướng dẫn Kết nối GPU.', code: 'gpu_not_configured' }, 503);
    if (request.method === 'POST') {
      const origin = request.headers.get('origin');
      if (origin && origin !== url.origin) return json({ error: 'Nguồn yêu cầu không hợp lệ.' }, 403);
    }
    if (path === '/api/jobs' && request.method === 'POST') {
      if (Number(request.headers.get('content-length') || 0) > 9 * 1024 * 1024) return json({ error: 'Ảnh gửi lên GPU tối đa 8 MB.' }, 413);
      const form = await request.formData(), file = form.get('image'), preset = String(form.get('preset') || 'balanced');
      if (!(file instanceof Blob) || file.size > 8 * 1024 * 1024 || !file.size) return json({ error: 'Cần ảnh PNG từ 1 byte đến 8 MB.' }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer()), view = new DataView(bytes.buffer);
      if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a || bytes[24] !== 8) return json({ error: 'Ảnh gửi lên phải là PNG 8-bit đã chuẩn bị.' }, 400);
      const width = view.getUint32(16), height = view.getUint32(20), limit = preset === 'original' ? 2048 : preset === 'balanced' ? 1152 : preset === 'draft' ? 768 : 0;
      if (!width || !height || !limit || Math.max(width, height) > limit || width * height > 4194304) return json({ error: 'Kích thước ảnh vượt giới hạn preset.' }, 400);
      const key = String(form.get('requestId') || '');
      if (!/^[a-zA-Z0-9-]{20,80}$/.test(key)) return json({ error: 'Mã yêu cầu không hợp lệ.' }, 400);
      const graph = buildWorkflow('pending.png', { seed: form.get('seed') || undefined, preset });
      if (cfg.mode === 'native') {
        const job = await nativeSubmit(cfg, bytes, graph, owner + ':' + key);
        const ticket = await signTicket({ id: job.id, owner, expires: Date.now() + 23 * 3600000 }, cfg.secret);
        return json({ ticket, id: job.id, status: job.status }, 201);
      }
      const upload = new FormData();
      upload.set('content_type', 'image/png'); upload.set('file_path', `relief-${crypto.randomUUID()}.png`);
      upload.set('file', new Blob([bytes], { type: 'image/png' }), 'source.png'); // file must be last in Comfy v2
      const asset = await (await upstream(cfg, '/api/v2/assets', { method: 'POST', body: upload })).json();
      if (!asset.id) throw new Error('GPU không trả asset ID hợp lệ.');
      graph['23'].inputs.image = { __type: 'core/ASSET', info: { id: asset.id } };
      const job = await (await upstream(cfg, '/api/v2/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `relief-${owner.replace(/[^a-zA-Z0-9]/g, '').slice(0, 30)}-${key}` }, body: JSON.stringify({ workflow: graph }) })).json();
      if (!job.id) throw new Error('GPU không trả job ID hợp lệ; hãy kiểm tra dashboard trước khi gửi lại.');
      const ticket = await signTicket({ id: job.id, owner, expires: Date.now() + 23 * 3600000 }, cfg.secret);
      return json({ ticket, id: job.id, status: job.status || 'queued' }, 201);
    }
    if (path === '/api/jobs/status' && request.method === 'GET') {
      const job = await readJob(cfg, url.searchParams.get('ticket'), owner);
      return json({ id: job.id, status: job.status, progress: job.progress?.value ?? null, queue: job.queue_position ?? null,
        error: job.error ? 'Tác vụ GPU thất bại. Kiểm tra model, node và log tại nhà cung cấp.' : null,
        hasImage: Array.isArray(job.outputs) && job.outputs.some(o => o.node_id === '34:10' && o.content_type === 'image/png') });
    }
    if (path === '/api/jobs/result' && request.method === 'GET') {
      const job = await readJob(cfg, url.searchParams.get('ticket'), owner);
      if (job.status !== 'succeeded') return json({ error: 'Ảnh chưa sẵn sàng.' }, 409);
      const output = job.outputs?.find(o => o.node_id === '34:10' && o.content_type === 'image/png');
      if (cfg.mode === 'native' && output) {
        const image = await nativeResult(cfg, output);
        return new Response(image.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
      }
      if (!output?.id) return json({ error: 'Không tìm thấy PNG từ node xuất relief.' }, 404);
      // Only fetch the authenticated asset belonging to this verified job. Never accept a visitor-supplied URL.
      const contentURL = cfg.base + '/api/v2/assets/' + encodeURIComponent(output.id) + '/content';
      const headers = cfg.key ? { Authorization: `Bearer ${cfg.key}` } : {};
      let image = await fetch(contentURL, { headers, redirect: 'manual', signal: AbortSignal.timeout(55000) });
      if ([301, 302, 303, 307, 308].includes(image.status)) {
        const location = new URL(image.headers.get('location'), cfg.base);
        if (location.protocol !== 'https:') throw new Error('Đường tải kết quả không an toàn.');
        image = await fetch(location, { redirect: 'error', signal: AbortSignal.timeout(55000) }); // no API key sent to storage
      }
      if (!image.ok) return json({ error: 'Không tải được ảnh kết quả từ GPU.' }, 502);
      return new Response(image.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    return json({ error: 'Không tìm thấy API.' }, 404);
  } catch (error) {
    const status = error.status || (/Vé tác vụ|hết hạn|không thuộc/.test(error.message) ? 403 : 502);
    const message = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'GPU phản hồi quá lâu. Tác vụ có thể đã được tạo: kiểm tra dashboard trước khi gửi lại để tránh tính phí hai lần.'
      : error.message || 'Không kết nối được GPU.';
    return json({ error: message }, status);
  }
}
