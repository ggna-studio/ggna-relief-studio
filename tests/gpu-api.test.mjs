import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAPI, signTicket, verifyTicket } from '../lib/gpu-api.mjs';
import { buildWorkflow } from '../lib/workflow.mjs';
import { encodePNG } from '../lib/heightmap.mjs';
const env={COMFY_BASE_URL:'https://gpu.example.test',COMFY_API_KEY:'test-server-key-not-for-browser',RELIEF_JOB_SECRET:'test-signing-secret-at-least-thirty-two-characters'};
test('Runtime workflow preserves core settings and excludes unneeded outputs',()=>{
  const graph=buildWorkflow('input.png');assert.equal(graph['34:28'].inputs.steps,24);assert.equal(graph['34:12'].inputs.guidance,.73);assert.equal(graph['34:29'].inputs.strength_model,1.0000000000000002);assert.equal(graph['23'].inputs.image,'input.png');
  for(const id of ['1','34:6','34:9','34:172'])assert.equal(graph[id],undefined);
  assert.equal(graph['34:10'].inputs.images[0],'34:149');assert.equal(buildWorkflow('x',{preset:'draft'} )['34:28'].inputs.steps,20);
  assert.throws(()=>buildWorkflow('x',{seed:-1}),/Seed/);
});
test('Health endpoint is honest when no GPU is configured',async()=>{
  const response=await handleAPI(new Request('https://studio.test/api/health'));assert.equal((await response.json()).ready,false);
  const result=await handleAPI(new Request('https://studio.test/api/jobs',{method:'POST'}));assert.equal(result.status,503);
});
test('Signed job tickets are bound to user and expiry',async()=>{
  const ticket=await signTicket({id:'job-123',owner:'alice',expires:Date.now()+10000},env.RELIEF_JOB_SECRET);
  assert.equal((await verifyTicket(ticket,env.RELIEF_JOB_SECRET,'alice')).id,'job-123');await assert.rejects(()=>verifyTicket(ticket,env.RELIEF_JOB_SECRET,'bob'),/không thuộc/);
  await assert.rejects(()=>verifyTicket(ticket.slice(0,-3)+'xxx',env.RELIEF_JOB_SECRET,'alice'),/không hợp lệ/);
  const expired=await signTicket({id:'job-123',owner:'alice',expires:1},env.RELIEF_JOB_SECRET);await assert.rejects(()=>verifyTicket(expired,env.RELIEF_JOB_SECRET,'alice'),/hết hạn/);
});
test('Cross-origin paid submit and arbitrary image uploads are rejected before any fetch',async()=>{
  const forbidden=await handleAPI(new Request('https://studio.test/api/jobs',{method:'POST',headers:{Origin:'https://evil.test'}}),env,'alice');assert.equal(forbidden.status,403);
  const form=new FormData();form.set('image',new Blob(['fake'],{type:'image/png'}),'bad.png');const bad=await handleAPI(new Request('https://studio.test/api/jobs',{method:'POST',body:form}),env,'alice');assert.equal(bad.status,400);
});
test('Comfy v2 upload fields precede file, asset reference is typed, paid job submits once',async()=>{
  const realFetch=globalThis.fetch,seen=[];let graph;
  globalThis.fetch=async(url,init)=>{seen.push(String(url));assert.equal(new Headers(init.headers).get('Authorization'),'Bearer '+env.COMFY_API_KEY);
    if(String(url).endsWith('/assets')){assert.deepEqual(Array.from(init.body.keys()),['content_type','file_path','file']);return Response.json({id:'asset-123'});}
    assert.equal(new Headers(init.headers).get('Idempotency-Key'),'relief-alice-12345678-1234-1234-1234-123456789abc');graph=JSON.parse(init.body).workflow;return Response.json({id:'job-456',status:'queued'},{status:201});};
  try{const form=new FormData();form.set('image',new Blob([await encodePNG(new Float32Array([0,1,1,0]),2,2,8)],{type:'image/png'}),'input.png');form.set('requestId','12345678-1234-1234-1234-123456789abc');form.set('preset','balanced');
    const response=await handleAPI(new Request('https://studio.test/api/jobs',{method:'POST',body:form}),env,'alice'),result=await response.json();assert.equal(response.status,201);assert.equal(seen.length,2);assert.equal(result.id,'job-456');assert.deepEqual(graph['23'].inputs.image,{__type:'core/ASSET',info:{id:'asset-123'}});assert.equal(JSON.stringify(result).includes(env.COMFY_API_KEY),false);
  }finally{globalThis.fetch=realFetch;}
});
test('Result proxy uses only asset from verified job and never leaks key to signed storage URL',async()=>{
  const realFetch=globalThis.fetch,ticket=await signTicket({id:'job-123',owner:'alice',expires:Date.now()+10000},env.RELIEF_JOB_SECRET),calls=[];
  globalThis.fetch=async(url,init={})=>{calls.push(String(url));
    if(String(url).endsWith('/jobs/job-123'))return Response.json({status:'succeeded',outputs:[{id:'asset-out',node_id:'34:10',content_type:'image/png'}]});
    if(String(url).includes('/assets/asset-out/content'))return new Response(null,{status:302,headers:{Location:'https://storage.example.test/signed.png'}});
    assert.equal(new Headers(init.headers).has('Authorization'),false);return new Response(new Uint8Array([137,80,78,71]),{headers:{'Content-Type':'image/png'}});
  };
  try{const response=await handleAPI(new Request('https://studio.test/api/jobs/result?ticket='+encodeURIComponent(ticket)),env,'alice');assert.equal(response.status,200);assert.equal(calls.length,3);assert.equal((await response.arrayBuffer()).byteLength,4);
    const denied=await handleAPI(new Request('https://studio.test/api/jobs/result?ticket='+encodeURIComponent(ticket)),env,'bob');assert.equal(denied.status,403);assert.equal(calls.length,3);
  }finally{globalThis.fetch=realFetch;}
});
