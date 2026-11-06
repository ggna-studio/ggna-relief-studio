import { buildWorkflow, MODEL_FILES } from './workflow.mjs';

const submissions = new Map();
export async function nativeFetch(cfg, path, init = {}) {
  const headers = new Headers(init.headers);
  if (cfg.key) headers.set('Authorization', `Bearer ${cfg.key}`);
  const response = await fetch(cfg.base + path, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) {
    let detail = '';
    try { const body = await response.json(); detail = body.error?.message || body.error || ''; } catch {}
    const error = new Error(`ComfyUI local trả lỗi ${response.status}. ${typeof detail === 'string' ? detail.slice(0, 240) : ''}`);
    error.status = response.status >= 500 ? 502 : response.status;
    throw error;
  }
  return response;
}

export async function nativeHealth(cfg) {
  const stats = await (await nativeFetch(cfg, '/system_stats')).json();
  const device = stats.devices?.find(d => d.type === 'cuda' || /NVIDIA/.test(d.name));
  if (!device) return { ready: false, gpuName: null, message: 'ComfyUI chưa nhận GPU CUDA.' };
  const classes = [...new Set(Object.values(buildWorkflow('probe.png')).map(n => n.class_type))];
  const info = await (await nativeFetch(cfg, '/object_info')).json();
  const missingNodes = classes.filter(c => !info[c]);
  const modelSelectors = [
    ['UNETLoader','unet_name',MODEL_FILES[0][1]], ['LoraLoaderModelOnly','lora_name',MODEL_FILES[1][1]],
    ['DualCLIPLoader','clip_name1',MODEL_FILES[2][1]], ['DualCLIPLoader','clip_name2',MODEL_FILES[3][1]],
    ['VAELoader','vae_name',MODEL_FILES[4][1]], ['UpscaleModelLoader','model_name',MODEL_FILES[5][1]],
  ];
  const missingModels = modelSelectors.filter(([node, input, name]) => {
    const selector = info[node]?.input?.required?.[input];
    const options = Array.isArray(selector?.[0]) ? selector[0] : selector?.[1]?.options;
    return !options?.includes(name);
  }).map(row => row[2]);
  return { ready: !missingNodes.length && !missingModels.length, gpuName: device.name, vramMB: Math.round(device.vram_total / 1048576), missingNodes, missingModels,
    message: missingNodes.length || missingModels.length ? 'ComfyUI đang thiếu node hoặc model BANMA.' : 'Đã kết nối ComfyUI và GPU trên máy này.' };
}

export async function nativeSubmit(cfg, bytes, graph, requestId) {
  if (submissions.has(requestId)) return submissions.get(requestId).promise;
  if (submissions.size >= 1000) { const first = submissions.keys().next().value; submissions.delete(first); }
  const promise = (async () => {
    const form = new FormData();
    form.set('type', 'input'); form.set('overwrite', 'false');
    form.set('image', new Blob([bytes], { type: 'image/png' }), `relief-${crypto.randomUUID()}.png`);
    const file = await (await nativeFetch(cfg, '/upload/image', { method: 'POST', body: form })).json();
    if (!file.name || file.type !== 'input') throw new Error('ComfyUI không trả ảnh đầu vào hợp lệ.');
    graph['23'].inputs.image = file.subfolder ? `${file.subfolder}/${file.name}` : file.name;
    const result = await (await nativeFetch(cfg, '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph, client_id: `relief-${crypto.randomUUID()}` }) })).json();
    if (!result.prompt_id) throw new Error('Chưa nhận được ID tác vụ; kiểm tra hàng đợi ComfyUI trước khi tạo lại.');
    return { id: result.prompt_id, status: 'queued' };
  })();
  submissions.set(requestId, { promise });
  return promise;
}

export async function nativeReadJob(cfg, id) {
  const history = await (await nativeFetch(cfg, '/history/' + encodeURIComponent(id))).json();
  const record = history[id];
  if (record) {
    const status = record.status?.status_str === 'error' ? 'failed' : record.status?.completed || record.status?.status_str === 'success' ? 'succeeded' : 'running';
    const outputs = [];
    for (const [nodeId, output] of Object.entries(record.outputs || {})) for (const image of output.images || []) outputs.push({ node_id: nodeId, content_type: 'image/png', native: image });
    return { id, status, outputs, progress: { value: status === 'succeeded' ? 1 : null }, error: status === 'failed' ? {} : null };
  }
  const queue = await (await nativeFetch(cfg, '/queue')).json();
  const waiting = queue.queue_pending?.findIndex(row => row[1] === id) ?? -1;
  const running = queue.queue_running?.some(row => row[1] === id);
  return { id, status: running ? 'running' : waiting >= 0 ? 'queued' : 'expired', queue_position: waiting >= 0 ? waiting + 1 : null, outputs: [] };
}

export async function nativeResult(cfg, output) {
  const image = output.native;
  if (!image?.filename || image.type !== 'output') throw new Error('Không có ảnh output hợp lệ của tác vụ này.');
  const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: 'output' });
  return nativeFetch(cfg, '/view?' + query.toString());
}
