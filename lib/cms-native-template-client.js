'use client';

export const NATIVE_TEMPLATE_WIDGET_KEY='native-template-section';

const PACKAGE_CACHE=new Map();
const MAX_CACHE_ENTRIES=12;
const MAX_SECTIONS=60;
const TEXT_SELECTOR='h1,h2,h3,h4,h5,h6,p,li,a,button,small,label,figcaption,blockquote,dt,dd,th,td,span';
const REMOVE_TAGS='script,noscript,iframe,frame,frameset,object,embed,applet,portal,base,meta,link,style';

export function nativeTemplatePackageId(template={}){
  const explicit=String(template.id||template.templateId||'').replace(/[^a-zA-Z0-9_-]/g,'').slice(0,80);
  if(explicit)return `native-${explicit}`;
  return `native-${hashString(`${template.nativeUrl||''}|${template.entryUrl||''}|${template.checksum||''}`)}`;
}

export async function loadNativeTemplatePackage(template={}){
  const source=String(template.nativeUrl||template.entryUrl||'').trim();
  if(!source)throw new Error('رابط القالب المستورد غير صالح.');
  const checksum=String(template.checksum||'').replace(/[^a-f0-9]/gi,'').slice(0,64);
  const key=`${source}|${checksum}`;
  if(PACKAGE_CACHE.has(key))return PACKAGE_CACHE.get(key);
  const promise=fetchAndCompile(template,source,checksum);
  PACKAGE_CACHE.set(key,promise);
  trimCache();
  try{return await promise;}
  catch(error){PACKAGE_CACHE.delete(key);throw error}
}

export function sanitizeEditableMarkup(value){
  if(typeof document==='undefined')return String(value||'').replace(/<[^>]+>/g,'').slice(0,20480);
  const template=document.createElement('template');
  template.innerHTML=String(value||'').slice(0,20480);
  const allowed=new Set(['BR','B','STRONG','EM','I','U','S','MARK','SPAN','SMALL','SUB','SUP']);
  for(const node of [...template.content.querySelectorAll('*')].reverse()){
    if(!allowed.has(node.tagName)){
      node.replaceWith(...node.childNodes);
      continue;
    }
    for(const attribute of [...node.attributes]){
      const name=attribute.name.toLowerCase();
      const next=name==='class'
        ?safeClass(attribute.value,300)
        :name==='style'
          ?sanitizeInlineStyle(attribute.value,'')
          :name==='dir'&&/^(rtl|ltr|auto)$/i.test(attribute.value)
            ?attribute.value.toLowerCase()
            :'';
      node.removeAttribute(attribute.name);
      if(next)node.setAttribute(name,next);
    }
  }
  return template.innerHTML.slice(0,20480);
}

async function fetchAndCompile(template,source,checksum){
  const params=new URLSearchParams({src:source});
  if(checksum)params.set('v',checksum);
  const response=await fetch(`/api/cms/templates/native?${params}`,{cache:'force-cache'});
  const result=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(result.error||'تعذر تجهيز القالب الأصلي.');
  return compileNativeTemplate(result,template);
}

function compileNativeTemplate(bundle,template){
  if(typeof DOMParser==='undefined')throw new Error('متصفحك لا يدعم محرك استيراد القوالب الحديث.');
  const parser=new DOMParser();
  const doc=parser.parseFromString(String(bundle.html||''),'text/html');
  if(doc.querySelector('parsererror'))throw new Error('ملف index.html داخل القالب غير صالح.');

  const baseUrl=ensureBase(bundle.baseUrl||template.entryUrl);
  const inlineStyles=[...doc.querySelectorAll('style')].map(node=>String(node.textContent||''));
  const cssParts=[
    nativeBaseCss(),
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),
    ...(Array.isArray(bundle.stylesheets)?bundle.stylesheets:[]).map(sheet=>{
      const sheetBase=resolveDirectory(sheet.path,baseUrl);
      return rewriteCss(String(sheet.css||''),sheetBase);
    })
  ].filter(Boolean);

  sanitizeDocument(doc,baseUrl);
  const candidates=collectSectionCandidates(doc.body);
  const sections=(candidates.length?candidates:[{node:doc.body,ancestors:[]}])
    .slice(0,MAX_SECTIONS)
    .map((candidate,index)=>serializeSection(candidate,index))
    .filter(section=>section.html.trim());

  if(!sections.length)throw new Error('لم نجد أقسامًا قابلة للإدراج داخل القالب.');

  const scriptCount=Math.max(
    Number(bundle.scriptCount)||0,
    Array.isArray(bundle.scripts)?bundle.scripts.length:0
  );

  return {
    id:nativeTemplatePackageId(template),
    title:String(template.name||template.title||doc.title||'قالب مستورد').slice(0,120),
    baseUrl,
    css:cssParts.join('\n'),
    sections,
    sectionCount:sections.length,
    scriptCount,
    fileCount:Number(template.fileCount)||0,
    totalBytes:Number(template.totalBytes)||0,
    checksum:String(template.checksum||bundle.checksum||''),
    entryUrl:String(template.entryUrl||''),
    nativeUrl:String(template.nativeUrl||''),
    legacyGenerated:Boolean(bundle.legacyGenerated)
  };
}

function sanitizeDocument(doc,baseUrl){
  doc.querySelectorAll(REMOVE_TAGS).forEach(node=>node.remove());
  const elements=[...doc.body.querySelectorAll('*')];
  for(const element of elements){
    const tag=element.tagName;
    if(['SCRIPT','IFRAME','FRAME','OBJECT','EMBED','APPLET','PORTAL'].includes(tag)){
      element.remove();
      continue;
    }

    promoteLazyAsset(element,baseUrl);

    for(const attribute of [...element.attributes]){
      const name=attribute.name.toLowerCase();
      const value=attribute.value;
      if(name.startsWith('on')||['srcdoc','nonce','integrity'].includes(name)){
        element.removeAttribute(attribute.name);
        continue;
      }
      if(name==='style'){
        const next=sanitizeInlineStyle(value,baseUrl);
        if(next)element.setAttribute('style',next);else element.removeAttribute('style');
        continue;
      }
      if(['src','poster','href','action','formaction','xlink:href'].includes(name)){
        const next=resolveAttributeUrl(value,baseUrl,name);
        if(next)element.setAttribute(attribute.name,next);else element.removeAttribute(attribute.name);
        continue;
      }
      if(name==='srcset'){
        const next=rewriteSrcset(value,baseUrl);
        if(next)element.setAttribute('srcset',next);else element.removeAttribute('srcset');
      }
    }

    if(tag==='FORM'){
      element.removeAttribute('action');
      element.removeAttribute('method');
      element.setAttribute('data-marktone-native-form','true');
    }
    if(tag==='A'&&element.getAttribute('target')==='_blank')element.setAttribute('rel','noopener noreferrer');
    if(tag==='IMG'&&!element.hasAttribute('loading'))element.setAttribute('loading','lazy');
    if(element.hasAttribute('data-aos'))element.classList.add('aos-animate');
    if(element.hasAttribute('data-reveal')||element.classList.contains('wow'))element.classList.add('is-visible');
  }
}

function collectSectionCandidates(body){
  const children=meaningfulChildren(body);
  if(!children.length)return [];
  if(children.length===1&&isExpandableWrapper(children[0],true)){
    return explodeContainer(children[0],[children[0]],0);
  }
  return children.flatMap(child=>{
    if(child.tagName==='MAIN'||isExpandableWrapper(child,false)){
      const expanded=explodeContainer(child,[child],0);
      if(expanded.length>1)return expanded;
    }
    return [{node:child,ancestors:[]}];
  });
}

function explodeContainer(container,ancestors,depth){
  const children=meaningfulChildren(container);
  if(!children.length)return [{node:container,ancestors:ancestors.slice(0,-1)}];
  const output=[];
  for(const child of children){
    const shouldExpand=child.tagName==='MAIN'||isExpandableWrapper(child,false);
    if(shouldExpand&&depth<3){
      const expanded=explodeContainer(child,[...ancestors,child],depth+1);
      if(expanded.length>1){output.push(...expanded);continue}
    }
    output.push({node:child,ancestors});
  }
  return output;
}

function meaningfulChildren(node){
  return [...(node?.children||[])].filter(child=>!['SCRIPT','STYLE','LINK','META','TEMPLATE'].includes(child.tagName));
}

function isExpandableWrapper(node,onlyChild){
  if(!node||['SECTION','ARTICLE','HEADER','FOOTER','NAV','ASIDE'].includes(node.tagName))return false;
  const children=meaningfulChildren(node);
  if(children.length<2)return false;
  if(node.tagName==='MAIN')return true;
  const identity=`${node.id||''} ${node.className||''}`.toLowerCase();
  if(/\b(app|root|page|site|website|wrapper|shell|layout|main-content)\b/.test(identity))return true;
  const structural=children.filter(child=>['SECTION','ARTICLE','HEADER','FOOTER','MAIN','NAV'].includes(child.tagName)).length;
  return onlyChild?structural>=2:structural===children.length&&structural>=2;
}

function serializeSection(candidate,index){
  const wrapper=document.createElement('div');
  let content=candidate.node===candidate.node.ownerDocument.body
    ?cloneBodyContents(candidate.node)
    :candidate.node.cloneNode(true);
  if(content?.nodeType===1)content.setAttribute('data-marktone-native-content','true');
  for(let cursor=candidate.ancestors.length-1;cursor>=0;cursor-=1){
    const shell=candidate.ancestors[cursor].cloneNode(false);
    shell.setAttribute('data-marktone-native-shell','true');
    stripShellConstraints(shell);
    shell.append(content);
    content=shell;
  }
  wrapper.append(content);
  const title=findSectionTitle(wrapper,index);
  const key=`section-${String(index+1).padStart(2,'0')}-${hashString(`${title}|${wrapper.innerHTML.slice(0,900)}`)}`;
  let editableIndex=0;
  for(const element of wrapper.querySelectorAll(TEXT_SELECTOR)){
    if(!isEditableText(element))continue;
    editableIndex+=1;
    element.setAttribute('data-marktone-text-id',`${key}-t${editableIndex}`);
  }
  return {
    key,
    index,
    title,
    html:wrapper.innerHTML,
    editableCount:editableIndex
  };
}

function cloneBodyContents(body){
  const fragment=document.createElement('div');
  for(const child of [...body.childNodes])fragment.append(child.cloneNode(true));
  return fragment;
}

function stripShellConstraints(element){
  const style=element?.style;
  if(style){
    for(const property of [
      'height','min-height','max-height','overflow','overflow-x','overflow-y',
      'position','inset','top','right','bottom','left','transform','contain',
      'scroll-snap-type','overscroll-behavior','overscroll-behavior-y'
    ])style.removeProperty(property);
  }
  for(const attribute of ['data-scroll-container','data-scroll','data-lenis-prevent','data-lenis-prevent-wheel']){
    element?.removeAttribute?.(attribute);
  }
}

function findSectionTitle(wrapper,index){
  const heading=wrapper.querySelector('h1,h2,h3,[aria-label]');
  const value=heading?.textContent?.trim()||heading?.getAttribute?.('aria-label')||'';
  if(value)return value.replace(/\s+/g,' ').slice(0,90);
  const node=wrapper.firstElementChild;
  const identity=node?.id||String(node?.className||'').split(/\s+/).find(Boolean)||node?.tagName?.toLowerCase();
  return identity?String(identity).slice(0,90):`القسم ${index+1}`;
}

function isEditableText(element){
  if(!element?.textContent?.trim())return false;
  if(element.closest('svg,canvas,code,pre,[data-marktone-no-edit],[data-marktone-editable="false"]'))return false;
  return !element.querySelector(TEXT_SELECTOR);
}

function promoteLazyAsset(element,baseUrl){
  const pairs=[['data-src','src'],['data-lazy-src','src'],['data-original','src'],['data-srcset','srcset']];
  for(const [source,target] of pairs){
    if(!element.hasAttribute(target)&&element.hasAttribute(source)){
      const value=element.getAttribute(source);
      const next=target==='srcset'?rewriteSrcset(value,baseUrl):resolveAttributeUrl(value,baseUrl,target);
      if(next)element.setAttribute(target,next);
    }
  }
  const background=element.getAttribute('data-bg')||element.getAttribute('data-background-image');
  if(background){
    const url=resolveAttributeUrl(background,baseUrl,'src');
    if(url)element.style.backgroundImage=`url("${url.replaceAll('"','%22')}")`;
  }
}

function rewriteCss(input,baseUrl){
  let css=String(input||'')
    .replace(/^\s*@charset[^;]+;/gim,'')
    .replace(/expression\s*\([^)]*\)/gi,'')
    .replace(/-moz-binding\s*:[^;}]*/gi,'')
    .replace(/behavior\s*:[^;}]*/gi,'')
    .replace(/position\s*:\s*fixed\b/gi,'position:absolute')
    .replace(/\b100(?:d|s|l)?vw\b/gi,'100%');

  css=css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi,(match,quote,value)=>{
    const clean=String(value||'').trim();
    if(!clean||clean.startsWith('#')||/^(data:|blob:)/i.test(clean))return `url(${quote}${clean}${quote})`;
    const resolved=resolveAttributeUrl(clean,baseUrl,'src');
    return resolved?`url("${resolved.replaceAll('"','%22')}")`:'url("")';
  });

  css=css.replace(/@import\s+(?:url\(\s*)?(['"])(.*?)\1\s*\)?/gi,(match,quote,value)=>{
    const resolved=resolveAttributeUrl(value,baseUrl,'src');
    return resolved?`@import url("${resolved.replaceAll('"','%22')}")`:'';
  });

  return css
    .replace(/(^|[\s,>+~])(:root)(?=[\s,>+~.#:[{])/gi,'$1:host')
    .replace(/(^|[\s,>+~])html(?=[\s,>+~.#:[{])/gi,'$1:host')
    .replace(/(^|[\s,>+~])body(?=[\s,>+~.#:[{])/gi,'$1.native-root');
}

function sanitizeInlineStyle(value,baseUrl){
  return rewriteCss(String(value||''),baseUrl)
    .replace(/[<>]/g,'')
    .replace(/javascript\s*:/gi,'')
    .slice(0,5000);
}

function resolveAttributeUrl(value,baseUrl,name){
  const raw=String(value||'').trim();
  if(!raw)return '';
  if(raw.startsWith('#'))return raw;
  if(name==='href'&&/^(mailto:|tel:)/i.test(raw))return raw;
  if(/^(javascript:|vbscript:|file:|filesystem:)/i.test(raw))return '';
  if(/^data:/i.test(raw))return /^(data:image\/|data:video\/|data:audio\/)/i.test(raw)?raw:'';
  try{
    const url=new URL(raw,baseUrl);
    return ['https:','http:','blob:'].includes(url.protocol)?url.href:'';
  }catch{return ''}
}

function rewriteSrcset(value,baseUrl){
  return String(value||'').split(',').map(item=>{
    const [url,...descriptor]=item.trim().split(/\s+/);
    const resolved=resolveAttributeUrl(url,baseUrl,'src');
    return resolved?[resolved,...descriptor].join(' '):'';
  }).filter(Boolean).join(', ');
}

function resolveDirectory(path,baseUrl){
  try{return new URL(String(path||'').replace(/[^/]*$/,''),baseUrl).href;}
  catch{return baseUrl}
}

function ensureBase(value){
  try{
    const url=new URL(String(value||''));
    if(/index\.html$/i.test(url.pathname))url.pathname=url.pathname.replace(/index\.html$/i,'');
    if(!url.pathname.endsWith('/'))url.pathname+='/';
    url.search='';
    url.hash='';
    return url.href;
  }catch{throw new Error('مسار أصول القالب غير صالح.')}
}

function nativeBaseCss(){
  return `
:host{display:block;width:100%;min-width:0;box-sizing:border-box;color:inherit;font:inherit;isolation:isolate}
:host *,:host *::before,:host *::after{box-sizing:border-box}
.native-root{display:block;width:100%;min-width:0;margin:0;padding:0;overflow:visible!important;background:transparent}
.native-root>[data-marktone-native-section]{display:block;width:100%;min-width:0;max-width:none;overflow:visible!important}
.native-root [data-marktone-native-shell="true"]{position:relative!important;inset:auto!important;display:block!important;width:100%!important;max-width:none!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;overflow-x:visible!important;overflow-y:visible!important;transform:none!important;contain:none!important;scroll-snap-type:none!important;overscroll-behavior:auto!important}
.native-root img,.native-root video,.native-root canvas,.native-root svg{max-width:100%}
.native-root iframe,.native-root frame,.native-root object,.native-root embed{display:none!important}
.native-root [hidden]{display:none}
.native-root [data-aos],.native-root [data-reveal],.native-root .wow{opacity:1!important;visibility:visible!important;transform:none!important}
:host([data-marktone-editor="true"]) [data-marktone-text-id]{cursor:text;outline:1px dashed transparent;outline-offset:3px;border-radius:4px;caret-color:#f36b21}
:host([data-marktone-editor="true"]) [data-marktone-text-id]:hover{outline-color:rgba(243,107,33,.72)}
:host([data-marktone-editor="true"]) [data-marktone-text-id]:focus{outline:2px solid #f36b21;background:rgba(255,246,238,.18)}
`;
}

function safeClass(value,max=160){return String(value||'').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,max)}
function hashString(value){
  let hash=2166136261;
  for(const character of String(value||'')){
    hash^=character.charCodeAt(0);
    hash=Math.imul(hash,16777619);
  }
  return (hash>>>0).toString(36);
}
function trimCache(){
  while(PACKAGE_CACHE.size>MAX_CACHE_ENTRIES){
    PACKAGE_CACHE.delete(PACKAGE_CACHE.keys().next().value);
  }
}
