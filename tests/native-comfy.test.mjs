import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReadJob, nativeSubmit, nativeHealth, nativeResult } from '../lib/native-comfy.mjs';
import { buildWorkflow, MODEL_FILES } from '../lib/workflow.mjs';
const cfg={base:'http://127.0.0.1:8188',key:''};
test('Native health verifies actual CUDA device, every node and all six model selectors',async()=>{
  const saved=fetch,info={};for(const node of Object.values(buildWorkflow('x')))info[node.class_type]={input:{required:{}}};
  for(const [node,input,index] of [['UNETLoader','unet_name',0],['LoraLoaderModelOnly','lora_name',1],['DualCLIPLoader','clip_name1',2],['DualCLIPLoader','clip_name2',3],['VAELoader','vae_name',4],['UpscaleModelLoader','model_name',5]])info[node].input.required[input]=[[MODEL_FILES[index][1]]];
  info.UpscaleModelLoader.input.required.model_name=['COMBO',{options:[MODEL_FILES[5][1]]}];
  globalThis.fetch=async url=>Response.json(String(url).endsWith('system_stats')?{devices:[{name:'NVIDIA RTX 3060',type:'cuda',vram_total:12884901888}]}:info);
  try{const result=await nativeHealth(cfg);assert.equal(result.ready,true);assert.equal(result.vramMB,12288);delete info.ReferenceLatent;assert.deepEqual((await nativeHealth(cfg)).missingNodes,['ReferenceLatent']);}finally{globalThis.fetch=saved;}
});
test('Native submissions deduplicate one request and use uploaded image path',async()=>{
  const saved=fetch,calls=[];globalThis.fetch=async(url,init)=>{calls.push(String(url));if(String(url).endsWith('/upload/image'))return Response.json({name:'unique.png',subfolder:'',type:'input'});const body=JSON.parse(init.body);assert.equal(body.prompt['23'].inputs.image,'unique.png');return Response.json({prompt_id:'native-job-id'});};
  try{const key=crypto.randomUUID(),results=await Promise.all([nativeSubmit(cfg,new Uint8Array([1]),buildWorkflow('pending'),key),nativeSubmit(cfg,new Uint8Array([1]),buildWorkflow('pending'),key)]);assert.equal(calls.length,2);assert.equal(results[0].id,results[1].id);}finally{globalThis.fetch=saved;}
});
test('Native status follows queue and history without inventing sampling progress',async()=>{
  const saved=fetch;let done=false;
  globalThis.fetch=async url=>Response.json(String(url).includes('/history/')?(done?{'id-1':{status:{status_str:'success',completed:true},outputs:{'34:10':{images:[{filename:'result.png',subfolder:'relief-studio',type:'output'}]}}}}:{}):{queue_running:[[0,'id-1']],queue_pending:[]});
  try{assert.equal((await nativeReadJob(cfg,'id-1')).status,'running');done=true;const job=await nativeReadJob(cfg,'id-1');assert.equal(job.status,'succeeded');assert.equal(job.outputs[0].native.filename,'result.png');}finally{globalThis.fetch=saved;}
});
test('Native result fetches only output assets; input files are refused',async()=>{
  const saved=fetch;globalThis.fetch=async url=>{assert.equal(new URL(url).searchParams.get('type'),'output');return new Response('PNG');};
  try{assert.equal(await(await nativeResult(cfg,{native:{filename:'x.png',subfolder:'a',type:'output'}})).text(),'PNG');await assert.rejects(()=>nativeResult(cfg,{native:{filename:'x.png',type:'input'}}),/output/);}finally{globalThis.fetch=saved;}
});
