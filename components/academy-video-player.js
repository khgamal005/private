'use client';
import {useEffect,useState} from 'react';
import {academyMediaId,academyMediaPath} from '../lib/academy-media.mjs';

export default function AcademyVideoPlayer({url,title}) {
  const assetId=academyMediaId(url),[info,setInfo]=useState(null),[error,setError]=useState('');
  const path=assetId?academyMediaPath(assetId):null;
  useEffect(()=>{
    if(!path)return;
    const controller=new AbortController();
    fetch(`${path}&info=1`,{signal:controller.signal}).then(async response=>{
      const data=await response.json();if(!response.ok)throw new Error(data.error||'تعذر فتح الفيديو.');setInfo(data);
    }).catch(failure=>{if(failure.name!=='AbortError')setError(failure.message);});
    return ()=>controller.abort();
  },[path]);
  if(!path)return null;
  if(error)return <p role="alert">{error}</p>;
  if(!info)return <p role="status">جارٍ تجهيز الفيديو…</p>;
  return <div><video key={path} controls playsInline preload="metadata" src={path} controlsList={info.allowDownload?undefined:'nodownload'} aria-label={title} style={{display:'block',width:'100%',maxHeight:560,borderRadius:12,background:'#092b4e'}} onError={()=>setError('تعذر تشغيل الفيديو. حدّث الصفحة للتحقق من تسجيل الدخول ثم حاول مرة أخرى.')} />{info.allowDownload&&<a href={`${path}&download=1`}>تنزيل الفيديو</a>}</div>;
}
