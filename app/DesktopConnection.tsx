import {useEffect,useState} from 'react';
import {Play,RefreshCw,LoaderCircle,CheckCircle2,PackageCheck} from 'lucide-react';
type BundleState={version:string;missingFiles:string[];starting:boolean;running:boolean;error:string};
export default function BundleConnection({gpu,onRefresh,expanded}:{gpu:any;onRefresh:()=>void;expanded:boolean}){
  const [state,setState]=useState<BundleState|null>(null),[working,setWorking]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let alive=true;async function read(){try{const r=await fetch('/api/app');if(!r.ok)throw Error();const next=await r.json();if(alive){setState(next);setError('');}}catch{if(alive)setError('Chưa nhận được phản hồi. Mở lại bằng KHOI-DONG.bat.');}}read();const timer=setInterval(read,5000);return()=>{alive=false;clearInterval(timer);};},[]);
  async function start(){setWorking(true);setError('');try{const r=await fetch('/api/gpu/start',{method:'POST'}),next=await r.json();if(!r.ok)throw Error(next.error);setState(next);onRefresh();}catch(e:any){setError(e.message||'Không khởi động được GPU.');}finally{setWorking(false);}}
  if(!state&&!error||!expanded&&gpu.ready)return null;
  const starting=state?.starting&&!gpu.ready;
  return <section className="desktop-connection" aria-label="Bộ ComfyUI và model đi kèm">
    <div className="desktop-connection-title"><span className="desktop-badge"><PackageCheck size={21}/></span><div><div className="eyebrow">GGNA · WEB LOCAL</div><h2>{gpu.ready?'Bộ GPU đã sẵn sàng':'Đang chuẩn bị bộ ComfyUI đi kèm'}</h2><p>{gpu.ready?gpu.gpuName:'Python, ComfyUI và sáu tệp model đã được đóng gói trong bộ tải về.'}</p></div><span className={'desktop-state '+(gpu.ready?'ready':'')}>{gpu.ready?<CheckCircle2 size={14}/>:starting?<LoaderCircle size={14} className="spin"/>:null}{gpu.ready?'Đã kết nối':starting?'Đang khởi động':'Cần kiểm tra'}</span></div>
    <div className="desktop-actions" style={{marginTop:18}}><button className="primary-button" disabled={working||!!starting||!!state?.missingFiles?.length} onClick={()=>gpu.ready?onRefresh():start()}>{starting?<LoaderCircle size={15} className="spin"/>:<Play size={15}/>}{starting?'Đang nạp ComfyUI…':gpu.ready?'Kiểm tra kết nối':'Khởi động GPU'}</button><button className="text-button" onClick={onRefresh}><RefreshCw size={14}/>Kiểm tra lại</button><a className="text-button" href="/setup.html" target="_blank" rel="noreferrer">Hướng dẫn sử dụng</a></div>
    {(error||state?.error)&&<p className="desktop-error" role="alert">{error||state?.error}</p>}
    {!!state?.missingFiles?.length&&<p className="desktop-error">Gói chưa được giải nén đủ: {state.missingFiles.join(', ')}</p>}
    {!!gpu.missingNodes?.length&&<p className="desktop-error">Thiếu node: {gpu.missingNodes.join(', ')}</p>}
    {!!gpu.missingModels?.length&&<p className="desktop-error">Thiếu model: {gpu.missingModels.join(', ')}</p>}
    <p className="desktop-footnote">{starting?'Lần đầu cần thời gian nạp model vào GPU. Bạn có thể chỉnh heightmap có sẵn trong lúc chờ.':gpu.message||'Cần GPU NVIDIA và driver tương thích. Mở bằng KHOI-DONG.bat, dùng DUNG_TOOL.bat khi dùng xong. Không cần cài Node.js hoặc Python riêng.'}</p>
  </section>;
}
