import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, crc32 } from 'node:zlib';
import { boxBlur, processHeight, rgbaToHeight, resample, encodeBMP, encodePNG, decodeGray16PNG } from '../lib/heightmap.mjs';
test('Alpha composites onto black; color brightness has known weights',()=>{
  const values=rgbaToHeight(new Uint8Array([255,255,255,0,255,0,0,255,255,255,255,128]));
  assert.equal(values[0],0);assert.ok(Math.abs(values[1]-.2126)<1e-6);assert.ok(Math.abs(values[2]-128/255)<1e-6);
});
test('Smoothing matches a direct edge-clamped box convolution',()=>{
  const w=7,h=4,r=2,input=Float32Array.from({length:w*h},(_,i)=>((i*19)%31)/31),actual=boxBlur(input,w,h,r);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){let expected=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++)expected+=input[Math.max(0,Math.min(h-1,y+dy))*w+Math.max(0,Math.min(w-1,x+dx))];assert.ok(Math.abs(actual[y*w+x]-expected/25)<1e-6);}
});
test('Flat maps remain finite and inversion preserves endpoints',()=>{
  const flat=new Float32Array(16).fill(.5),out=processHeight(flat,4,4,{smooth:3});assert.ok(out.every(Number.isFinite));assert.ok(out.every(x=>Math.abs(x-.5)<1e-6));
  const inverted=processHeight(new Float32Array([0,.5,1]),3,1,{invert:true});assert.deepEqual(Array.from(inverted),[1,.5,0]);
});
test('Bilinear resampling preserves corners and yields midpoint',()=>{
  assert.deepEqual(Array.from(resample(new Float32Array([0,1,1,0]),2,2,3,3)),[0,.5,1,.5,.5,.5,1,.5,0]);
});
test('BMP grayscale palette, padding and bottom-up rows are correct',()=>{
  const a=encodeBMP(new Float32Array([0,.5,1,1,.5,0]),3,2),v=new DataView(a.buffer),offset=v.getUint32(10,true);
  assert.equal(v.getUint16(28,true),8);assert.equal(v.getInt32(18,true),3);assert.equal(v.getInt32(22,true),2);assert.equal(a.length,offset+8);
  assert.deepEqual(Array.from(a.slice(offset,offset+8)),[255,128,0,0,0,128,255,0]);assert.deepEqual(Array.from(a.slice(54+127*4,54+127*4+4)),[127,127,127,0]);
});
test('PNG16 is true single-channel big-endian data, with no gamma transform',async()=>{
  const values=new Float32Array([0,1/65535,257/65535,.5,1]),a=await encodePNG(values,5,1,16),v=new DataView(a.buffer);
  assert.equal(a[24],16);assert.equal(a[25],0);const chunks=[];
  for(let p=8;p<a.length;){const length=v.getUint32(p),type=Buffer.from(a.subarray(p+4,p+8)).toString();assert.equal(crc32(a.subarray(p+4,p+8+length)),v.getUint32(p+8+length));assert.notEqual(type,'gAMA');if(type==='IDAT')chunks.push(a.slice(p+8,p+8+length));p+=length+12;}
  const raw=inflateSync(Buffer.concat(chunks));assert.deepEqual(Array.from(raw),[0,0,0,0,1,1,1,128,0,255,255]);
  const back=await decodeGray16PNG(a.buffer);assert.equal(back.width,5);for(let i=0;i<values.length;i++)assert.ok(Math.abs(back.data[i]-values[i])<=1/65535);
});
test('PNG16 roundtrip retains more than 256 grayscale levels',async()=>{
  const data=Float32Array.from({length:2048},(_,i)=>i/2047),a=await encodePNG(data,64,32,16),decoded=await decodeGray16PNG(a.buffer);
  assert.equal(new Set(decoded.data).size,2048);
});
test('PNG8 files stay 8-bit and are delegated to browser decode',async()=>{
  const bytes=await encodePNG(new Float32Array([0,1]),2,1,8);assert.equal(bytes[24],8);assert.equal(await decodeGray16PNG(bytes.buffer),null);
});
test('Malformed PNG dimensions and 16-bit color are refused',async()=>{
  const bytes=await encodePNG(new Float32Array([0]),1,1,16);const color=bytes.slice();color[25]=2;await assert.rejects(()=>decodeGray16PNG(color.buffer),/một kênh/);
  const huge=bytes.slice();new DataView(huge.buffer).setUint32(16,20000000);await assert.rejects(()=>decodeGray16PNG(huge.buffer),/16 triệu/);
});
