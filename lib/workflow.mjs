import original from './banma-original.json' with { type: 'json' };

export const MODEL_FILES = [
  ['diffusion_models', 'flux1-dev-kontext_fp8_scaled.safetensors'],
  ['loras', '斑马数字科技_Lora.safetensors'],
  ['text_encoders', 'clip_l.safetensors'],
  ['text_encoders', 't5xxl_fp8_e4m3fn_scaled.safetensors'],
  ['vae', 'ae.safetensors'],
  ['upscale_models', 'BANMAsharp_V3.pt'],
];

export function buildWorkflow(imageReference, options = {}) {
  const graph = structuredClone(original);
  delete graph['1']; delete graph['34:6'];
  delete graph['34:9']; delete graph['34:172'];
  for (const node of Object.values(graph)) { delete node.is_changed; delete node._meta; }
  graph['23'].inputs.image = imageReference;
  const seed = Number(options.seed ?? 408416742087713);
  if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('Seed phải là số nguyên không âm an toàn.');
  graph['34:28'].inputs.seed = seed;
  const preset = options.preset || 'original';
  if (!['original', 'balanced', 'draft'].includes(preset)) throw new Error('Preset không hợp lệ.');
  // The browser/server validates the input limit separately. Do not change the original sampler recipe.
  graph['34:28'].inputs.steps = preset === 'draft' ? 20 : 24;
  graph['34:10'].inputs.filename_prefix = 'relief-studio/result';
  return graph;
}

export function modelManifest() {
  return { workflow: 'BANMA_AIGCv3', files: MODEL_FILES.map(([folder, name]) => ({ folder, name })),
    requiredCustomNodes: ['ComfyUI_essentials', 'ComfyUI-Easy-Use', 'ComfyUI-Image-Filters', 'was-node-suite-comfyui'],
    notes: 'Workflow giữ FLUX, LoRA, sampler và bộ lọc gốc; bỏ node so sánh, nhánh resize không nối, EXR/BMP phía GPU. Xuất file thực hiện trong web.' };
}
