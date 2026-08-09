'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {loadNativeTemplatePackage,sanitizeEditableMarkup} from '../lib/cms-native-template-client';
import styles from './native-template-section.module.css';

const MAX_OVERRIDES=300;
const MAX_OVERRIDE_BYTES=20*1024;

export default function NativeTemplateSection({
  entryUrl='',nativeUrl='',checksum='',templateId='',title='قالب ZIP مستورد',
  sectionKey='',sectionIndex=0,textOverrides={},editor=false,target,
  onInlineEdit,onActivate,renderAll=false
}){
  const hostRef=useRef(null);
  const callbacksRef=useRef({onInlineEdit,onActivate,target,overrides:{},editor:false});
  const [template,setTemplate]=useState(null);
  const [status,setStatus]=useState('loading');
  const [error,setError]=useState('');
  const [editableCount,setEditableCount]=useState(0);
  const overrides=useMemo(()=>normalizeOverrides(textOverrides),[textOverrides]);
  const descriptor=useMemo(()=>({
    id:templateId,templateId,entryUrl,nativeUrl,checksum,title
  }),[checksum,entryUrl,nativeUrl,templateId,title]);

  useEffect(()=>{
    callbacksRef.current={onInlineEdit,onActivate,target,overrides,editor:Boolean(editor)};
  },[editor,onActivate,onInlineEdit,overrides,target]);

  useEffect(()=>{
    let cancelled=false;
    setStatus('loading');
    setError('');
    setTemplate(null);
    loadNativeTemplatePackage(descriptor)
      .then(result=>{
        if(cancelled)return;
        setTemplate(result);
        setStatus('ready');
      })
      .catch(reason=>{
        if(cancelled)return;
        setError(reason instanceof Error?reason.message:'تعذر تجهيز القالب الأصلي.');
        setStatus('error');
      });
    return()=>{cancelled=true;};
  },[descriptor]);

  useEffect(()=>{
    const host=hostRef.current;
    if(!host||!template||status!=='ready')return undefined;
    const shadow=host.shadowRoot||host.attachShadow({mode:'open'});
    shadow.replaceChildren();
    host.toggleAttribute('data-marktone-editor',Boolean(editor));
    host.setAttribute('data-template-package',template.id);

    const style=document.createElement('style');
    style.textContent=template.css;
    const root=document.createElement('div');
    root.className='native-root';
    root.dir=template.direction||'auto';
    if(template.language)root.lang=template.language;

    const selected=selectSections(template,sectionKey,sectionIndex,renderAll);
    if(!selected.length){
      setError('لم يعد هذا القسم موجودًا داخل القالب. أعد إدراج القالب من المكتبة.');
      setStatus('error');
      return undefined;
    }

    for(const section of selected){
      const shell=document.createElement('div');
      shell.setAttribute('data-marktone-native-section',section.key);
      shell.setAttribute('data-section-index',String(section.index));
      shell.innerHTML=section.html;
      root.append(shell);
    }

    applyOverrides(root,overrides);
    const editable=configureEditable(root,Boolean(editor));
    setEditableCount(editable.length);
    shadow.append(style,root);
    const releaseLayout=normalizeNativeLayout(root);

    const activate=()=>callbacksRef.current.onActivate?.(callbacksRef.current.target);
    const click=event=>handleClick(event,host,Boolean(editor));
    const submit=event=>{
      event.preventDefault();
      if(editor)event.stopImmediatePropagation();
    };
    const focusout=event=>{
      if(!callbacksRef.current.editor)return;
      const element=event.target?.closest?.('[data-marktone-text-id]');
      if(!element||!root.contains(element))return;
      const id=String(element.getAttribute('data-marktone-text-id')||'');
      if(!isTextId(id))return;
      const value=sanitizeEditableMarkup(element.innerHTML).slice(0,MAX_OVERRIDE_BYTES);
      element.innerHTML=value;
      const current=callbacksRef.current.overrides;
      if(String(current[id]??'')===value)return;
      const next=normalizeOverrides({...current,[id]:value});
      callbacksRef.current.overrides=next;
      callbacksRef.current.onInlineEdit?.(callbacksRef.current.target,'props.textOverrides',next);
    };
    const keydown=event=>{
      if(!callbacksRef.current.editor||!event.target?.closest?.('[data-marktone-text-id]'))return;
      if(event.key==='Escape'||((event.ctrlKey||event.metaKey)&&event.key==='Enter')){
        event.preventDefault();
        event.target.blur?.();
      }
    };
    const paste=event=>{
      if(!callbacksRef.current.editor||!event.target?.closest?.('[data-marktone-text-id]'))return;
      event.preventDefault();
      insertPlainText(event.clipboardData?.getData('text/plain')||'');
    };

    shadow.addEventListener('pointerdown',activate,true);
    shadow.addEventListener('click',click,true);
    shadow.addEventListener('submit',submit,true);
    shadow.addEventListener('focusout',focusout,true);
    shadow.addEventListener('keydown',keydown,true);
    shadow.addEventListener('paste',paste,true);
    return()=>{
      shadow.removeEventListener('pointerdown',activate,true);
      shadow.removeEventListener('click',click,true);
      shadow.removeEventListener('submit',submit,true);
      shadow.removeEventListener('focusout',focusout,true);
      shadow.removeEventListener('keydown',keydown,true);
      shadow.removeEventListener('paste',paste,true);
      releaseLayout();
    };
  },[editor,overrides,renderAll,sectionIndex,sectionKey,status,template]);

  return <div className={styles.root} data-template-status={status} data-template-renderer="native-shadow-dom">
    <div ref={hostRef} className={styles.host}/>
    {status==='loading'&&<div className={styles.loading} role="status" aria-live="polite">
      <span/>
      <strong>جارٍ تحويل القالب إلى أقسام أصلية…</strong>
      <small>HTML وCSS بعرض الصفحة، من دون iframe.</small>
    </div>}
    {status==='error'&&<div className={styles.error} role="alert">
      <strong>تعذر عرض القسم المستورد</strong>
      <p>{error||'تعذر تجهيز القالب الأصلي.'}</p>
    </div>}
    {editor&&status==='ready'&&<div className={styles.editorBadge}>
      <strong>قسم أصلي قابل للتحرير</strong>
      <span>{editableCount} نص قابل للتعديل مباشرة · بدون iframe</span>
    </div>}
  </div>;
}

function normalizeNativeLayout(root){
  let frame=0;
  const listeners=[];
  const schedule=()=>{
    if(frame)return;
    frame=window.requestAnimationFrame(apply);
  };
  const apply=()=>{
    frame=0;
    for(const element of collectLayoutCandidates(root))relaxLayoutElement(element,root);
  };
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(schedule):null;
  observer?.observe(root);
  for(const asset of root.querySelectorAll('img,video')){
    asset.addEventListener('load',schedule);
    asset.addEventListener('loadedmetadata',schedule);
    listeners.push(()=>{
      asset.removeEventListener('load',schedule);
      asset.removeEventListener('loadedmetadata',schedule);
    });
  }
  schedule();
  return()=>{
    if(frame)window.cancelAnimationFrame(frame);
    observer?.disconnect();
    listeners.forEach(release=>release());
  };
}

function collectLayoutCandidates(root){
  const candidates=new Set([root]);
  for(const shell of root.querySelectorAll('[data-marktone-native-shell="true"]'))candidates.add(shell);
  for(const section of root.children){
    candidates.add(section);
    let current=section.firstElementChild;
    for(let depth=0;current&&depth<6;depth+=1){
      if(isPageShell(current)||current.hasAttribute('data-marktone-native-shell'))candidates.add(current);
      if(current.children.length!==1)break;
      current=current.firstElementChild;
    }
  }
  return [...candidates].slice(0,160);
}

function relaxLayoutElement(element,root){
  let computed;
  try{computed=window.getComputedStyle(element);}catch{return}
  const forced=element===root||element.hasAttribute('data-marktone-native-shell');
  const pageLike=forced||element.hasAttribute('data-marktone-native-section')||isPageShell(element);
  const overflowValue=`${computed.overflow} ${computed.overflowX} ${computed.overflowY}`;
  const scrollMode=/(auto|scroll|clip)/.test(overflowValue);
  const clipped=/(hidden|clip)/.test(overflowValue);
  const overflowing=element.clientHeight>0&&element.scrollHeight>element.clientHeight+6;
  const viewportHeight=Math.max(window.innerHeight||0,320);
  const height=Number.parseFloat(computed.height);
  const maxHeight=Number.parseFloat(computed.maxHeight);
  const viewportLocked=Number.isFinite(height)&&Math.abs(height-viewportHeight)<12||
    Number.isFinite(maxHeight)&&Math.abs(maxHeight-viewportHeight)<12;
  if(!forced&&!viewportLocked&&!(pageLike&&overflowing&&(scrollMode||clipped)))return;

  element.style.setProperty('overflow','visible','important');
  element.style.setProperty('overflow-x','visible','important');
  element.style.setProperty('overflow-y','visible','important');
  element.style.setProperty('max-height','none','important');
  element.style.setProperty('scroll-snap-type','none','important');
  element.style.setProperty('overscroll-behavior','auto','important');
  if(element!==root){
    element.style.setProperty('height','auto','important');
    element.style.setProperty('min-height','0','important');
  }
  if(pageLike){
    element.style.setProperty('contain','none','important');
    if(computed.position==='fixed'||computed.position==='sticky')element.style.setProperty('position','relative','important');
    if(element.hasAttribute('data-marktone-native-shell'))element.style.setProperty('transform','none','important');
  }
}

function isPageShell(element){
  const identity=`${element?.id||''} ${element?.className||''}`.toLowerCase();
  return /\b(app|root|page|site|website|wrapper|shell|layout|viewport|smooth|scroll|main-content)\b/.test(identity);
}

function selectSections(template,key,index,renderAll){
  const sections=Array.isArray(template?.sections)?template.sections:[];
  if(renderAll)return sections;
  const exact=sections.find(section=>section.key===key);
  if(exact)return [exact];
  const fallback=sections[clamp(index,0,Math.max(0,sections.length-1),0)];
  return fallback?[fallback]:[];
}

function configureEditable(root,editor){
  const elements=[...root.querySelectorAll('[data-marktone-text-id]')];
  for(const element of elements){
    if(editor){
      element.setAttribute('contenteditable','true');
      element.setAttribute('spellcheck','true');
    }else{
      element.removeAttribute('contenteditable');
      element.removeAttribute('spellcheck');
    }
  }
  return elements;
}

function applyOverrides(root,overrides){
  if(!overrides||!Object.keys(overrides).length)return;
  for(const element of root.querySelectorAll('[data-marktone-text-id]')){
    const id=String(element.getAttribute('data-marktone-text-id')||'');
    if(Object.prototype.hasOwnProperty.call(overrides,id)){
      element.innerHTML=sanitizeEditableMarkup(overrides[id]);
    }
  }
}

function handleClick(event,host,editor){
  const control=event.target?.closest?.('a,button,input,textarea,select,label,[role="button"]');
  if(editor&&control){
    event.preventDefault();
    event.stopImmediatePropagation();
    return;
  }
  const anchor=event.target?.closest?.('a[href^="#"]');
  if(anchor){
    const id=decodeURIComponent(String(anchor.getAttribute('href')||'').slice(1));
    if(id){
      event.preventDefault();
      scrollToNativeAnchor(host,id);
    }
    return;
  }
  const toggle=event.target?.closest?.('[data-bs-toggle="collapse"],[data-toggle="collapse"],[aria-controls]');
  if(toggle)toggleControlledElement(toggle);
}

function scrollToNativeAnchor(host,id){
  const local=findInShadow(host.shadowRoot,id);
  if(local){local.scrollIntoView({behavior:'smooth',block:'start'});return}
  for(const candidate of document.querySelectorAll('[data-template-package]')){
    const match=findInShadow(candidate.shadowRoot,id);
    if(match){match.scrollIntoView({behavior:'smooth',block:'start'});return}
  }
}

function findInShadow(shadow,id){
  if(!shadow)return null;
  for(const element of shadow.querySelectorAll('[id]')){
    if(element.id===id)return element;
  }
  return null;
}

function toggleControlledElement(toggle){
  const selector=toggle.getAttribute('data-bs-target')||toggle.getAttribute('data-target')||
    (toggle.getAttribute('aria-controls')?`#${toggle.getAttribute('aria-controls')}`:'');
  if(!selector||!selector.startsWith('#'))return;
  const root=toggle.getRootNode();
  const target=[...(root.querySelectorAll?.('[id]')||[])].find(element=>`#${element.id}`===selector);
  if(!target)return;
  const open=target.hasAttribute('hidden')||!target.classList.contains('show');
  target.toggleAttribute('hidden',!open);
  target.classList.toggle('show',open);
  toggle.setAttribute('aria-expanded',open?'true':'false');
}

function insertPlainText(value){
  const selection=window.getSelection?.();
  if(!selection?.rangeCount)return;
  const range=selection.getRangeAt(0);
  range.deleteContents();
  const node=document.createTextNode(String(value||''));
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function normalizeOverrides(value){
  const source=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  const output={};
  for(const [key,entry] of Object.entries(source)){
    if(Object.keys(output).length>=MAX_OVERRIDES)break;
    if(!isTextId(key))continue;
    output[key]=String(entry||'').slice(0,MAX_OVERRIDE_BYTES);
  }
  return output;
}

function isTextId(value){return /^section-[a-z0-9-]+-t[0-9]+$/i.test(String(value||''))}
function clamp(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(Math.max(Math.round(number),min),max):fallback}
