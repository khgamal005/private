'use client';

import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import styles from './imported-template-runtime.module.css';

const MESSAGE_VERSION=2;
const MAX_OVERRIDES=300;
const MAX_OVERRIDE_BYTES=20*1024;
const LOAD_TIMEOUT_MS=20000;
const BRIDGE_TIMEOUT_MS=10000;

export default function ImportedTemplateRuntime({
  entryUrl='',checksum='',title='قالب ZIP مستورد',height=720,displayMode='auto',
  textOverrides={},editor=false,target,onInlineEdit,onActivate
}){
  const frameRef=useRef(null);
  const callbacksRef=useRef({onInlineEdit,onActivate,target,overrides:{},editor:false});
  const configRef=useRef({editor:false,overrides:{}});
  const [reloadKey,setReloadKey]=useState(0);
  const [srcDoc,setSrcDoc]=useState('');
  const [status,setStatus]=useState(entryUrl?'loading':'invalid');
  const [error,setError]=useState('');
  const [contentHeight,setContentHeight]=useState(()=>clamp(height,320,12000,720));
  const [detectedMode,setDetectedMode]=useState('document');
  const [editableCount,setEditableCount]=useState(0);
  const [assetErrors,setAssetErrors]=useState([]);
  const overrides=useMemo(()=>normalizeOverrides(textOverrides),[textOverrides]);
  const runtimeUrl=useMemo(()=>templateRuntimeUrl(entryUrl,checksum,reloadKey),[entryUrl,checksum,reloadKey]);

  useEffect(()=>{
    callbacksRef.current={onInlineEdit,onActivate,target,overrides,editor:Boolean(editor)};
    configRef.current={editor:Boolean(editor),overrides};
  },[onInlineEdit,onActivate,target,overrides,editor]);

  const sendConfig=useCallback(()=>{
    const frameWindow=frameRef.current?.contentWindow;
    if(!frameWindow)return;
    const config=configRef.current;
    frameWindow.postMessage({
      type:'marktone:template-config',version:MESSAGE_VERSION,
      editor:config.editor,overrides:config.overrides
    },'*');
  },[]);

  useEffect(()=>{
    if(!runtimeUrl){
      setStatus('invalid');
      setError('رابط القالب المستورد غير صالح.');
      setSrcDoc('');
      return undefined;
    }
    const controller=new AbortController();
    const timer=window.setTimeout(()=>controller.abort(),LOAD_TIMEOUT_MS);
    setStatus('loading');
    setError('');
    setAssetErrors([]);
    setSrcDoc('');
    setDetectedMode('document');
    setEditableCount(0);
    fetch(runtimeUrl,{signal:controller.signal,cache:'force-cache'})
      .then(async response=>{
        const text=await response.text();
        if(!response.ok)throw new Error(extractRuntimeError(text)||'تعذر تحميل القالب المستورد.');
        setSrcDoc(text);
        setStatus('connecting');
      })
      .catch(reason=>{
        if(controller.signal.aborted)setError('استغرق تحميل القالب وقتًا أطول من المتوقع.');
        else setError(reason instanceof Error?reason.message:'تعذر تحميل القالب المستورد.');
        setStatus('error');
      })
      .finally(()=>window.clearTimeout(timer));
    return()=>{
      window.clearTimeout(timer);
      controller.abort();
    };
  },[runtimeUrl]);

  useEffect(()=>{
    function receive(event){
      if(event.source!==frameRef.current?.contentWindow||!event.data||event.data.version!==MESSAGE_VERSION)return;
      const data=event.data;
      if(data.type==='marktone:template-ready'){
        setStatus('ready');
        setEditableCount(clamp(data.editableCount,0,5000,0));
        if(data.layoutMode==='viewport'||data.layoutMode==='document')setDetectedMode(data.layoutMode);
        if(Number.isFinite(Number(data.height)))setContentHeight(clamp(Math.ceil(Number(data.height)),320,12000,720));
        sendConfig();
        return;
      }
      if(data.type==='marktone:template-height'){
        if(data.layoutMode==='viewport'||data.layoutMode==='document')setDetectedMode(data.layoutMode);
        if(Number.isFinite(Number(data.height)))setContentHeight(clamp(Math.ceil(Number(data.height)),320,12000,720));
        return;
      }
      if(data.type==='marktone:template-activate'){
        callbacksRef.current.onActivate?.(callbacksRef.current.target);
        return;
      }
      if(data.type==='marktone:template-text-change'&&callbacksRef.current.editor){
        const id=String(data.id||'');
        if(!/^t[0-9]+$/.test(id))return;
        const value=String(data.value||'').slice(0,MAX_OVERRIDE_BYTES);
        const next=normalizeOverrides({...callbacksRef.current.overrides,[id]:value});
        callbacksRef.current.overrides=next;
        configRef.current={...configRef.current,overrides:next};
        callbacksRef.current.onInlineEdit?.(callbacksRef.current.target,'props.textOverrides',next);
        return;
      }
      if(data.type==='marktone:template-asset-error'){
        const item={tag:String(data.tag||'asset').slice(0,30),url:String(data.url||'').slice(0,700)};
        setAssetErrors(current=>current.some(entry=>entry.url===item.url)?current:[...current.slice(-4),item]);
        return;
      }
      if(data.type==='marktone:template-error'){
        setError(String(data.message||'تعذر تشغيل القالب المستورد.').slice(0,500));
        setStatus('error');
      }
    }
    window.addEventListener('message',receive);
    return()=>window.removeEventListener('message',receive);
  },[sendConfig]);

  useEffect(()=>{
    if(srcDoc)sendConfig();
  },[srcDoc,editor,overrides,sendConfig]);

  useEffect(()=>{
    if(status!=='connecting')return undefined;
    const timer=window.setTimeout(()=>{
      setError('تم تحميل ملفات القالب، لكن محرك التشغيل لم يبدأ. أعد المحاولة أو أعد استيراد ملف ZIP.');
      setStatus('error');
    },BRIDGE_TIMEOUT_MS);
    return()=>window.clearTimeout(timer);
  },[status]);

  const requestedMode=['viewport','document'].includes(displayMode)?displayMode:'auto';
  const effectiveMode=requestedMode==='auto'?detectedMode:requestedMode;
  const renderedHeight=effectiveMode==='viewport'
    ?clamp(height,320,2000,720)
    :clamp(contentHeight,320,12000,clamp(height,320,12000,720));

  return <div
    className={`${styles.root} ${styles[`mode_${effectiveMode}`]||''}`}
    style={{height:`${renderedHeight}px`}}
    data-template-status={status}
    data-template-layout={effectiveMode}
  >
    {srcDoc&&<iframe
      ref={frameRef}
      srcDoc={srcDoc}
      title={title||'قالب ZIP مستورد'}
      sandbox={editor
        ?'allow-scripts allow-modals'
        :'allow-scripts allow-modals allow-popups allow-top-navigation-by-user-activation'}
      allow="autoplay; fullscreen; picture-in-picture"
      allowFullScreen
      loading="lazy"
      referrerPolicy="no-referrer"
      onLoad={()=>{
        setStatus(current=>current==='loading'?'connecting':current);
        sendConfig();
      }}
    />}

    {(status==='loading'||status==='connecting')&&<div className={styles.loading} role="status" aria-live="polite">
      <span/>
      <strong>{status==='loading'?'جارٍ تجهيز القالب…':'جارٍ تشغيل التصميم…'}</strong>
      <small>يتم تحميل HTML وCSS وJavaScript داخل عزل آمن.</small>
    </div>}

    {(status==='error'||status==='invalid')&&<div className={styles.error} role="alert">
      <strong>تعذر عرض القالب</strong>
      <p>{error||'رابط القالب غير صالح.'}</p>
      {runtimeUrl&&<button type="button" onClick={()=>setReloadKey(value=>value+1)}>إعادة المحاولة</button>}
    </div>}

    {editor&&status==='ready'&&<div className={styles.editorBadge}>
      <strong>✎ عدّل النص داخل التصميم مباشرة</strong>
      <span>{effectiveMode==='viewport'?'مرّر داخل القالب لمشاهدة الحركة.':'الارتفاع متوافق تلقائيًا مع المحتوى.'}</span>
      <small>{editableCount} نص قابل للتحرير{assetErrors.length?` · ${assetErrors.length} ملف لم يكتمل تحميله`:''}</small>
    </div>}
  </div>;
}

function templateRuntimeUrl(value,checksum,reloadKey){
  let url;
  try{url=new URL(String(value||'').trim())}catch{return ''}
  if(url.protocol!=='https:'||!/\/storage\/v1\/object\/public\/cms-template-assets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/r[1-9][0-9]*\/index\.html$/i.test(url.pathname))return '';
  url.search='';
  url.hash='';
  const params=new URLSearchParams({src:url.href});
  const version=String(checksum||'').replace(/[^a-f0-9]/gi,'').slice(0,64);
  if(version)params.set('v',version);
  if(reloadKey)params.set('retry',String(reloadKey));
  return `/api/cms/templates/runtime?${params.toString()}`;
}
function normalizeOverrides(value){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const output={};
  for(const key of Object.keys(source)){
    if(Object.keys(output).length>=MAX_OVERRIDES)break;
    if(!/^t[0-9]+$/.test(key))continue;
    output[key]=String(source[key]||'').slice(0,MAX_OVERRIDE_BYTES);
  }
  return output;
}
function extractRuntimeError(html){
  const match=String(html||'').match(/<p>([\s\S]*?)<\/p>/i);
  return match?match[1].replace(/<[^>]+>/g,'').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&').trim():'';
}
function clamp(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(Math.max(number,min),max):fallback}
