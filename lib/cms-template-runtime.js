export const TEMPLATE_RUNTIME_LIMITS=Object.freeze({
  htmlBytes:2*1024*1024,
  overrideCount:300,
  overrideBytes:20*1024
});

const TEMPLATE_ENTRY_PATH=/^\/storage\/v1\/object\/public\/cms-template-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/r([1-9][0-9]*)\/index\.html$/i;

export class TemplateRuntimeError extends Error{
  constructor(message,code='template_runtime_failed',status=500){
    super(message);
    this.name='TemplateRuntimeError';
    this.code=code;
    this.status=status;
  }
}

export function normalizeTemplateEntryUrl(value,supabaseUrl){
  let entry;
  let storage;
  try{
    entry=new URL(String(value||'').trim());
    storage=new URL(String(supabaseUrl||'').trim());
  }catch{
    throw new TemplateRuntimeError('رابط القالب غير صالح.','template_url_invalid',400);
  }
  if(entry.protocol!=='https:'||storage.protocol!=='https:'||entry.origin!==storage.origin){
    throw new TemplateRuntimeError('مصدر القالب غير مسموح.','template_origin_invalid',400);
  }
  if(entry.username||entry.password||entry.hash||!TEMPLATE_ENTRY_PATH.test(entry.pathname)){
    throw new TemplateRuntimeError('مسار ملف بداية القالب غير صالح.','template_path_invalid',400);
  }
  entry.search='';
  entry.hash='';
  return entry;
}

export function templateAssetBase(entryUrl){
  const url=entryUrl instanceof URL?new URL(entryUrl.href):new URL(String(entryUrl));
  url.pathname=url.pathname.replace(/index\.html$/i,'');
  url.search='';
  url.hash='';
  return url.href;
}

export function buildTemplateCsp(entryUrl){
  const origin=(entryUrl instanceof URL?entryUrl:new URL(String(entryUrl))).origin;
  return [
    "default-src 'none'",
    "script-src https: 'unsafe-inline'",
    "script-src-attr 'unsafe-inline'",
    "style-src https: 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "img-src https: data: blob:",
    "media-src https: data: blob:",
    "font-src https: data:",
    "connect-src 'none'",
    "frame-src https:",
    "worker-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    `base-uri ${origin}`,
    "form-action 'none'"
  ].join('; ');
}

export function rewriteTemplateDocument(input,entryUrl){
  const html=decodeHtml(input);
  const entry=entryUrl instanceof URL?entryUrl:new URL(String(entryUrl));
  const base=templateAssetBase(entry);
  const csp=buildTemplateCsp(entry);
  const cleaned=html
    .replace(/^\uFEFF/,'')
    .replace(/<base\b[^>]*>/gi,'')
    .replace(/<meta\b(?=[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy))[^>]*>/gi,'')
    .replace(/<meta\b(?=[^>]*http-equiv\s*=\s*(?:"refresh"|'refresh'|refresh))[^>]*>/gi,'')
    .replace(/<meta\b(?=[^>]*name\s*=\s*(?:"referrer"|'referrer'|referrer))[^>]*>/gi,'')
    .replace(/<style\b[^>]*data-marktone-runtime[^>]*>[\s\S]*?<\/style\s*>/gi,'')
    .replace(/<script\b[^>]*(?:data-marktone-bridge|data-marktone-runtime-bridge)[^>]*>[\s\S]*?<\/script\s*>/gi,'');
  const head=[
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">`,
    '<meta name="referrer" content="no-referrer">',
    `<base href="${escapeAttribute(base)}">`,
    `<style data-marktone-runtime>${RUNTIME_STYLE}</style>`
  ].join('');
  let document=/<html[\s>]/i.test(cleaned)?cleaned:`<!doctype html><html><head></head><body>${cleaned}</body></html>`;
  document=/<head[\s>]/i.test(document)
    ?document.replace(/<head([^>]*)>/i,`<head$1>${head}`)
    :document.replace(/<html([^>]*)>/i,`<html$1><head>${head}</head>`);
  if(/<\/body\s*>/i.test(document))document=document.replace(/<\/body\s*>/i,`${RUNTIME_BRIDGE}</body>`);
  else if(/<\/html\s*>/i.test(document))document=document.replace(/<\/html\s*>/i,`${RUNTIME_BRIDGE}</html>`);
  else document+=RUNTIME_BRIDGE;
  return document;
}

export function buildTemplateErrorDocument(message='تعذر عرض القالب المستورد.'){
  const value=String(message||'تعذر عرض القالب المستورد.').slice(0,500);
  const safe=escapeHtml(value);
  const payload=JSON.stringify(value).replace(/</g,'\\u003c');
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>html,body{margin:0;min-height:100%;font-family:Tahoma,Arial,sans-serif;background:#fff7f3;color:#6f2d16}body{display:grid;place-items:center;padding:28px;box-sizing:border-box}.box{max-width:620px;border:1px solid #f1c8b6;border-radius:18px;background:#fff;padding:28px;box-shadow:0 18px 60px rgba(91,38,17,.1)}strong{display:block;font-size:20px;margin-bottom:8px}p{margin:0;line-height:1.8}</style></head><body><div class="box"><strong>تعذر تشغيل القالب</strong><p>${safe}</p></div><script>parent.postMessage({type:'marktone:template-error',version:2,message:${payload}},'*')</script></body></html>`;
}

export function runtimeResponseHeaders(){
  return {
    'Content-Type':'text/html; charset=utf-8',
    'Content-Disposition':'inline',
    'Cache-Control':'public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Robots-Tag':'noindex, nofollow',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
  };
}

function decodeHtml(input){
  if(typeof input==='string'){
    if(Buffer.byteLength(input,'utf8')>TEMPLATE_RUNTIME_LIMITS.htmlBytes){
      throw new TemplateRuntimeError('ملف index.html أكبر من الحد المسموح.','template_html_too_large',413);
    }
    return input;
  }
  const buffer=Buffer.isBuffer(input)?input:Buffer.from(input||'');
  if(buffer.length>TEMPLATE_RUNTIME_LIMITS.htmlBytes){
    throw new TemplateRuntimeError('ملف index.html أكبر من الحد المسموح.','template_html_too_large',413);
  }
  try{return new TextDecoder('utf-8',{fatal:true}).decode(buffer)}
  catch{throw new TemplateRuntimeError('ترميز index.html غير صالح؛ يجب استخدام UTF-8.','template_html_encoding',422)}
}

function escapeAttribute(value){return String(value||'').replace(/[&"<>]/g,char=>({'&':'&amp;','"':'&quot;','<':'&lt;','>':'&gt;'}[char]))}
function escapeHtml(value){return String(value||'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}

const RUNTIME_STYLE=`
html[data-marktone-editor="true"] [data-marktone-text-id]{cursor:text;border-radius:4px;outline:1px dashed transparent;outline-offset:3px;transition:outline-color .15s ease,background-color .15s ease;caret-color:#f06c2b}
html[data-marktone-editor="true"] [data-marktone-text-id]:hover{outline-color:rgba(244,111,47,.72);background:rgba(255,246,238,.12)}
html[data-marktone-editor="true"] [data-marktone-text-id]:focus{outline:2px solid #f06c2b;background:rgba(255,246,238,.18)}
html[data-marktone-editor="true"] a,html[data-marktone-editor="true"] button{cursor:text!important}
`;

const RUNTIME_BRIDGE=`<script data-marktone-runtime-bridge>!function(){
'use strict';
var VERSION=2,SELECTOR='h1,h2,h3,h4,h5,h6,p,li,a,button,small,label,figcaption,blockquote,dt,dd,th,td',MAX_OVERRIDES=300,MAX_VALUE=20480,MAX_EDITABLE=5000;
var state={editor:false,overrides:{},nextId:1,raf:0,ready:false,layoutMode:'document',ids:new WeakMap()};
function post(type,payload){try{parent.postMessage(Object.assign({type:type,version:VERSION},payload||{}),'*')}catch(e){}}
function cleanOverrides(value){var source=value&&typeof value==='object'?value:{},next={},count=0;Object.keys(source).forEach(function(key){if(count>=MAX_OVERRIDES||!/^t[0-9]+$/.test(key))return;next[key]=String(source[key]||'').slice(0,MAX_VALUE);count++});return next}
function cleanClass(value){return String(value||'').replace(/[^a-zA-Z0-9_\\- ]/g,'').slice(0,500)}
function cleanStyle(value){return String(value||'').replace(/(?:expression|javascript:|@import|-moz-binding|behavior\\s*:|url\\s*\\()/gi,'').replace(/[<>]/g,'').slice(0,1500)}
function sanitize(value){var template=document.createElement('template');template.innerHTML=String(value||'').slice(0,MAX_VALUE);var allowed={BR:1,B:1,STRONG:1,EM:1,I:1,U:1,S:1,MARK:1,SPAN:1,SMALL:1,SUB:1,SUP:1};var nodes=Array.prototype.slice.call(template.content.querySelectorAll('*')).reverse();nodes.forEach(function(node){if(!allowed[node.tagName]){node.replaceWith.apply(node,Array.prototype.slice.call(node.childNodes));return}Array.prototype.slice.call(node.attributes).forEach(function(attribute){var name=attribute.name.toLowerCase(),next='';if(name==='class')next=cleanClass(attribute.value);else if(name==='style')next=cleanStyle(attribute.value);else if(name==='dir'&&/^(rtl|ltr|auto)$/i.test(attribute.value))next=attribute.value.toLowerCase();else if(name==='lang'&&/^[a-z0-9-]{1,20}$/i.test(attribute.value))next=attribute.value;node.removeAttribute(attribute.name);if(next)node.setAttribute(name,next)})});return template.innerHTML.slice(0,MAX_VALUE)}
function eligible(element){if(!element||!element.textContent||!element.textContent.trim())return false;if(element.closest('script,style,noscript,template,svg,canvas,[data-marktone-no-edit],[data-marktone-editable="false"]'))return false;return !element.querySelector(SELECTOR)}
function register(applyOverrides){var elements=document.querySelectorAll(SELECTOR),count=0,limit=Math.min(elements.length,MAX_EDITABLE);for(var index=0;index<limit;index++){var element=elements[index];if(!eligible(element))continue;var id=state.ids.get(element),fresh=!id;if(fresh){id='t'+state.nextId++;state.ids.set(element,id);element.setAttribute('data-marktone-text-id',id)}var override=state.overrides[id];if((applyOverrides||fresh)&&override!==undefined&&document.activeElement!==element)element.innerHTML=sanitize(override);if(state.editor){element.setAttribute('contenteditable','true');element.setAttribute('spellcheck','true')}else{element.removeAttribute('contenteditable');element.removeAttribute('spellcheck')}count++}return count}
function setEditor(enabled){state.editor=!!enabled;document.documentElement.setAttribute('data-marktone-editor',state.editor?'true':'false');register(false)}
function explicitLayoutMode(){var value=(document.documentElement.getAttribute('data-marktone-layout')||(document.body&&document.body.getAttribute('data-marktone-layout'))||'').toLowerCase();return value==='viewport'||value==='document'?value:''}
function detectLayoutMode(){var explicit=explicitLayoutMode();if(explicit)return explicit;var viewport=Math.max(window.innerHeight||0,320),body=document.body,doc=document.documentElement,total=Math.max(body?body.scrollHeight:0,doc?doc.scrollHeight:0),nodes=Array.prototype.slice.call(body?body.querySelectorAll('*'):[]).slice(0,1200);for(var index=0;index<nodes.length;index++){var style;try{style=getComputedStyle(nodes[index])}catch(e){continue}if(style.position==='sticky'||style.position==='fixed')return 'viewport';if(style.scrollSnapType&&style.scrollSnapType!=='none')return 'viewport';if(total>viewport*1.2){var values=[parseFloat(style.height),parseFloat(style.minHeight),parseFloat(style.maxHeight)];for(var valueIndex=0;valueIndex<values.length;valueIndex++)if(Number.isFinite(values[valueIndex])&&Math.abs(values[valueIndex]-viewport)<4)return 'viewport'}}return 'document'}
function height(){var body=document.body,doc=document.documentElement;return Math.ceil(Math.max(body?body.scrollHeight:0,doc?doc.scrollHeight:0,320))}
function measure(){if(state.raf)cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(function(){state.raf=0;var count=register(false),nextHeight=height(),nextMode=state.layoutMode;if(!state.ready||state.layoutMode!=='viewport')nextMode=detectLayoutMode();state.layoutMode=nextMode;if(!state.ready){state.ready=true;post('marktone:template-ready',{height:nextHeight,layoutMode:state.layoutMode,editableCount:count,title:document.title||'',capabilities:{inlineText:true,smartHeight:true}})}post('marktone:template-height',{height:nextHeight,layoutMode:state.layoutMode})})}
function configure(event){if(event.source!==parent||!event.data||event.data.type!=='marktone:template-config'||event.data.version!==VERSION)return;state.overrides=cleanOverrides(event.data.overrides);setEditor(event.data.editor);register(true);measure()}
addEventListener('message',configure);
document.addEventListener('pointerdown',function(){if(state.editor)post('marktone:template-activate')},true);
document.addEventListener('click',function(event){if(!state.editor)return;var control=event.target&&event.target.closest&&event.target.closest('a,button,input,textarea,select,form');if(control){event.preventDefault();event.stopImmediatePropagation()}},true);
document.addEventListener('submit',function(event){if(state.editor){event.preventDefault();event.stopImmediatePropagation()}},true);
document.addEventListener('input',function(event){if(state.editor&&event.target&&event.target.closest&&event.target.closest('[data-marktone-text-id]'))measure()},true);
document.addEventListener('focusout',function(event){if(!state.editor)return;var element=event.target&&event.target.closest&&event.target.closest('[data-marktone-text-id]');if(!element)return;var value=sanitize(element.innerHTML);element.innerHTML=value;post('marktone:template-text-change',{id:state.ids.get(element)||element.getAttribute('data-marktone-text-id'),value:value});measure()},true);
document.addEventListener('keydown',function(event){if(!state.editor||!event.target||!event.target.closest('[data-marktone-text-id]'))return;if(event.key==='Escape'||((event.ctrlKey||event.metaKey)&&event.key==='Enter')){event.preventDefault();event.target.blur()}},true);
document.addEventListener('paste',function(event){if(!state.editor||!event.target||!event.target.closest('[data-marktone-text-id]'))return;event.preventDefault();var text=String(event.clipboardData&&event.clipboardData.getData('text/plain')||'').slice(0,MAX_VALUE);document.execCommand('insertText',false,text)},true);
document.addEventListener('error',function(event){var target=event.target||{},url=target.currentSrc||target.src||target.href||'';if(url)post('marktone:template-asset-error',{tag:String(target.tagName||'asset').toLowerCase(),url:String(url).slice(0,700)})},true);
function boot(){Array.prototype.forEach.call(document.querySelectorAll('[data-marktone-text-id]'),function(element){element.removeAttribute('data-marktone-text-id')});if(window.ResizeObserver){var observer=new ResizeObserver(measure);observer.observe(document.documentElement);if(document.body)observer.observe(document.body)}if(window.MutationObserver&&document.body)new MutationObserver(measure).observe(document.body,{subtree:true,childList:true,characterData:true});addEventListener('resize',measure);measure()}
if(document.readyState==='complete')setTimeout(boot,0);else addEventListener('load',boot,{once:true});
}();</script>`;
