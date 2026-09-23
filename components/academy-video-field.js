'use client';

import {useEffect, useRef, useState} from 'react';
import {academyMediaFile, academyMediaId, academyMediaError} from '../lib/academy-media.mjs';
import {startAcademyVideoUpload} from '../lib/academy-media-upload.mjs';
import styles from './academy-authoring.module.css';

export default function AcademyVideoField({slug, courseId, value, onChange, disabled=false, enabled=false}) {
  const [source,setSource] = useState(academyMediaId(value) ? 'upload' : 'link');
  const [state,setState] = useState('idle'), [progress,setProgress] = useState(0), [error,setError] = useState('');
  const [asset,setAsset] = useState(null), [fileName,setFileName] = useState('');
  const [policyBusy,setPolicyBusy] = useState(false);
  const cancelling=useRef(false),policyCommands=useRef(new Map());
  const upload = useRef(null), current = useRef(null), mounted = useRef(true), starting = useRef(false);
  const assetId = academyMediaId(value), uploading = ['preparing','uploading','finishing','cancelling'].includes(state);
  useEffect(() => {mounted.current=true;return () => {mounted.current=false;void upload.current?.abort();};}, []);
  useEffect(() => {
    if (!assetId) return;
    const controller = new AbortController();
    fetch(`/api/academy-media/${assetId}?tenantSlug=${slug}&info=1`, {signal:controller.signal}).then(async response => {
      if (!response.ok) return;
      const data = await response.json();setAsset({...data,assetId});
    }).catch(() => {});
    return () => controller.abort();
  }, [assetId,slug]);
  useEffect(() => {
    if (!uploading) return;
    const warn = event => {event.preventDefault();event.returnValue='';};
    window.addEventListener('beforeunload',warn);return () => window.removeEventListener('beforeunload',warn);
  }, [uploading]);
  async function request(action,payload,commandId) {
    const signature=JSON.stringify([action,payload]);
    if(!commandId)commandId=action==='set_download'?policyCommands.current.get(signature):null;
    if(!commandId)commandId=crypto.randomUUID();
    if(action==='set_download')policyCommands.current.set(signature,commandId);
    const response = await fetch(`/api/academy-media/${action}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,commandId,payload})});
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(academyMediaError(data.code)),{code:data.code});
    if(action==='set_download')policyCommands.current.delete(signature);
    return data;
  }
  async function finish(ticket, key) {
    if (!mounted.current || cancelling.current) return;
    setState('finishing');
    try {
      const result = await request('complete_upload',{assetId:ticket.assetId});
      try {sessionStorage.removeItem(key);} catch {}
      if (!mounted.current) return;
      setAsset(result);setState('ready');setProgress(100);onChange(result.playbackUrl);
    } catch (failure) {if (mounted.current) {setError(failure.message);setState('finish_failed');}}
  }
  async function selectFile(file) {
    if (!file || starting.current || uploading) return;
    starting.current=true;cancelling.current=false;setError('');
    let key;
    try {
      const metadata = academyMediaFile(file);
      key = `academy-upload:${slug}:${courseId}:${file.name}:${file.size}:${file.lastModified}`;
      let commandId;
      try {commandId=sessionStorage.getItem(key);} catch {}
      if (!commandId) {commandId=crypto.randomUUID();try {sessionStorage.setItem(key,commandId);} catch {}}
      setFileName(file.name);setState('preparing');setProgress(0);
      const ticket = await request('create_upload',{courseId,...metadata},commandId);
      current.current={ticket,key};
      if (!mounted.current) return;
      if (ticket.state === 'ready') {try {sessionStorage.removeItem(key);} catch {}setAsset(ticket);setState('ready');onChange(ticket.playbackUrl);return;}
      const client = await startAcademyVideoUpload({file,ticket,autoStart:false,onProgress:value => {if(mounted.current)setProgress(value);},
        onSuccess:() => void finish(ticket,key),onError:() => {if(mounted.current){setState('paused');setError('انقطع الرفع. اضغط استكمال، أو اختر نفس الملف عند عودتك.');}}});
      upload.current=client;
      if (!mounted.current) await client.abort();
      else {setState('uploading');client.start();}
    } catch (failure) {
      if(failure.code==='academy_media_upload_expired')try {sessionStorage.removeItem(key);} catch {}
      if(mounted.current){setError(failure.code ? academyMediaError(failure.code) : failure.message);setState('idle');}
    }
    finally {starting.current=false;}
  }
  async function cancel() {
    cancelling.current=true;setState('cancelling');
    try {
      await upload.current?.abort();
      if (current.current) {await request('cancel_upload',{assetId:current.current.ticket.assetId});try {sessionStorage.removeItem(current.current.key);} catch {}}
      current.current=null;upload.current=null;setState('idle');setProgress(0);setFileName('');setError('');
    } catch (failure) {cancelling.current=false;setError(failure.message);setState('paused');}
  }
  return <section className={styles.videoField} aria-label="مصدر الفيديو">
    <div className={styles.tabs} role="group" aria-label="طريقة إضافة الفيديو">
      <button type="button" disabled={disabled||uploading||state==='paused'} aria-pressed={source==='link'} onClick={() => setSource('link')}>إضافة رابط</button>
      <button type="button" disabled={disabled||!enabled||uploading||state==='paused'} aria-pressed={source==='upload'} onClick={() => setSource('upload')}>رفع فيديو</button>
    </div>
    {source==='link' ? <label className={styles.field}><span>رابط الفيديو</span><input type="url" dir="ltr" value={value||''} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder="https://…"/><small>أضف رابط فيديو آمنًا، أو اختر رفع فيديو من جهازك.</small></label> : <>
      <label className={styles.uploadZone}><strong>{asset?.fileName||fileName||'اختر الفيديو من جهازك'}</strong><span>MP4 أو WebM · حتى 500 ميجابايت</span><input type="file" accept="video/mp4,video/webm,.mp4,.webm" disabled={disabled||uploading||state==='paused'} onChange={event => {void selectFile(event.target.files?.[0]);event.target.value='';}}/></label>
      {(uploading||state==='paused'||state==='finish_failed')&&<div aria-live="polite"><progress max="100" value={progress} aria-label="تقدم رفع الفيديو"/><p>{state==='preparing'?'جارٍ تجهيز الرفع…':state==='cancelling'?'جارٍ إلغاء الرفع…':state==='finish_failed'?'اكتمل الرفع، وبقي التحقق من الملف.':state==='finishing'?'جارٍ التحقق من اكتمال الفيديو…':`${progress}% · ${state==='paused'?'متوقف مؤقتًا':'جارٍ الرفع'}`}</p><small>إذا أغلقت الدرس، اختر نفس الملف عند عودتك لاستكمال الرفع خلال 24 ساعة.</small><div className={styles.actions}>
        {state==='uploading'&&<button type="button" className={styles.secondary} onClick={async() => {await upload.current?.abort();setState(current=>current==='uploading'?'paused':current);}}>إيقاف مؤقت</button>}
        {state==='paused'&&<button type="button" className={styles.primary} onClick={() => {setError('');setState('uploading');upload.current?.start();}}>استكمال الرفع</button>}
        {state==='finish_failed'&&<button type="button" className={styles.primary} onClick={() => void finish(current.current.ticket,current.current.key)}>إعادة التحقق</button>}
        {['uploading','paused','finish_failed'].includes(state)&&<button type="button" className={styles.secondary} onClick={() => void cancel()}>إلغاء الرفع</button>}
      </div></div>}
      {assetId&&<><p className={styles.notice}>الفيديو جاهز. احفظ مسودة الدورة لحفظ ارتباطه بالدرس.</p><label className={styles.check}><input type="checkbox" checked={asset?.allowDownload===true} disabled={disabled||!asset||uploading||policyBusy} onChange={async event => {setError('');setPolicyBusy(true);try {setAsset(await request('set_download',{assetId,allowDownload:event.target.checked,expectedVersion:asset.policyVersion}));} catch(failure){setError(failure.message);}finally{setPolicyBusy(false);}}}/>السماح للطلاب بتنزيل هذا الفيديو</label><small className={styles.muted}>يتغير السماح بالتنزيل فورًا لكل استخدامات هذا الفيديو.</small></>}
    </>}
    {error&&<p className={styles.error} role="alert">{error}</p>}
  </section>;
}
