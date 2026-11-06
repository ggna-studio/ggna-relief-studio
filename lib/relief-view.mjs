import { resample } from './heightmap.mjs';
export function createReliefView(canvas) {
  const gl = canvas.getContext('webgl', { antialias:true, alpha:false });
  if (!gl) throw new Error('Thiết bị không hỗ trợ WebGL. Bạn vẫn có thể dùng chế độ ảnh xám.');
  function shader(type, text) { const s=gl.createShader(type);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('Không tạo được shader 3D.');return s; }
  const vert=shader(gl.VERTEX_SHADER,`attribute vec3 p;attribute vec3 n;uniform mat4 m;uniform mat3 r;varying vec3 normal;void main(){normal=r*n;gl_Position=m*vec4(p,1.0);}`);
  const frag=shader(gl.FRAGMENT_SHADER,`precision mediump float;varying vec3 normal;void main(){vec3 N=normalize(normal);vec3 L=normalize(vec3(-.45,.7,1.3));float d=max(dot(N,L),0.);float s=pow(max(dot(reflect(-L,N),vec3(0.,0.,1.)),0.),22.)*.12;gl_FragColor=vec4(vec3(.78,.79,.75)*(.28+.72*d)+s,1.);}`);
  const program=gl.createProgram();gl.attachShader(program,vert);gl.attachShader(program,frag);gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Không tạo được trình xem 3D.');gl.useProgram(program);
  const pb=gl.createBuffer(),nb=gl.createBuffer(),ib=gl.createBuffer(),pl=gl.getAttribLocation(program,'p'),nl=gl.getAttribLocation(program,'n'),ml=gl.getUniformLocation(program,'m'),rl=gl.getUniformLocation(program,'r');
  let count=0,rx=-.62,ry=-.25,zoom=1,dragging=false,last=[0,0],disposed=false;
  function multiply(a,b){const o=new Float32Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++)for(let k=0;k<4;k++)o[c*4+r]+=a[k*4+r]*b[c*4+k];return o;}
  function draw(){
    if(disposed)return;
    const dpr=Math.min(devicePixelRatio||1,2),w=Math.max(1,Math.round(canvas.clientWidth*dpr)),h=Math.max(1,Math.round(canvas.clientHeight*dpr));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
    gl.viewport(0,0,w,h);gl.clearColor(.055,.067,.06,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
    const cx=Math.cos(rx),sx=Math.sin(rx),cy=Math.cos(ry),sy=Math.sin(ry),r=new Float32Array([cy,sx*sy,-cx*sy,0,0,cx,sx,0,sy,-sx*cy,cx*cy,0,0,0,0,1]);
    const a=w/h,z=1.24/zoom,p=new Float32Array([1/(z*Math.max(1,a)),0,0,0,0,1/(z*Math.max(1,1/a)),0,0,0,0,-.3,0,0,0,0,1]);
    gl.uniformMatrix4fv(ml,false,multiply(p,r));gl.uniformMatrix3fv(rl,false,new Float32Array([r[0],r[1],r[2],r[4],r[5],r[6],r[8],r[9],r[10]]));
    gl.bindBuffer(gl.ARRAY_BUFFER,pb);gl.enableVertexAttribArray(pl);gl.vertexAttribPointer(pl,3,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ARRAY_BUFFER,nb);gl.enableVertexAttribArray(nl);gl.vertexAttribPointer(nl,3,gl.FLOAT,false,0,0);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_SHORT,0);
  }
  function update(data,width,height,depthMM=3,widthMM=100,exaggeration=3){
    const nx=170,ny=Math.max(16,Math.min(220,Math.round(nx*height/width))),s=resample(data,width,height,nx,ny),ww=1.78*width/Math.max(width,height),hh=1.78*height/Math.max(width,height),scale=ww*depthMM/widthMM*exaggeration;
    const p=new Float32Array(nx*ny*3),n=new Float32Array(p.length),indices=[];
    for(let y=0;y<ny;y++)for(let x=0;x<nx;x++){const i=y*nx+x;p[i*3]=(x/(nx-1)-.5)*ww;p[i*3+1]=(.5-y/(ny-1))*hh;p[i*3+2]=s[i]*scale;
      const dx=(s[y*nx+Math.min(nx-1,x+1)]-s[y*nx+Math.max(0,x-1)])*scale/(2*ww/(nx-1)),dy=(s[Math.max(0,y-1)*nx+x]-s[Math.min(ny-1,y+1)*nx+x])*scale/(2*hh/(ny-1)),len=Math.hypot(dx,dy,1);n[i*3]=-dx/len;n[i*3+1]=-dy/len;n[i*3+2]=1/len;
      if(x<nx-1&&y<ny-1)indices.push(i,i+nx,i+1,i+1,i+nx,i+nx+1);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER,pb);gl.bufferData(gl.ARRAY_BUFFER,p,gl.STATIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,nb);gl.bufferData(gl.ARRAY_BUFFER,n,gl.STATIC_DRAW);gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ib);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,new Uint16Array(indices),gl.STATIC_DRAW);count=indices.length;draw();
  }
  const down=e=>{dragging=true;last=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);},move=e=>{if(!dragging)return;ry+=(e.clientX-last[0])*.008;rx=Math.max(-1.35,Math.min(1.35,rx+(e.clientY-last[1])*.008));last=[e.clientX,e.clientY];draw();},up=()=>{dragging=false;},wheel=e=>{e.preventDefault();zoom=Math.max(.55,Math.min(2.8,zoom*Math.exp(-e.deltaY*.001)));draw();};
  canvas.addEventListener('pointerdown',down);canvas.addEventListener('pointermove',move);canvas.addEventListener('pointerup',up);canvas.addEventListener('pointercancel',up);canvas.addEventListener('wheel',wheel,{passive:false});const observer=new ResizeObserver(draw);observer.observe(canvas);
  return {update,reset(){rx=-.62;ry=-.25;zoom=1;draw();},dispose(){disposed=true;observer.disconnect();canvas.removeEventListener('pointerdown',down);canvas.removeEventListener('pointermove',move);canvas.removeEventListener('pointerup',up);canvas.removeEventListener('pointercancel',up);canvas.removeEventListener('wheel',wheel);gl.deleteBuffer(pb);gl.deleteBuffer(nb);gl.deleteBuffer(ib);gl.deleteProgram(program);gl.deleteShader(vert);gl.deleteShader(frag);}};
}
