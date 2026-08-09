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
  const response=await fetch(`/api/cms/templates/native?${params}`,{cache:'no-store'});
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
  const externalStyles=[...doc.querySelectorAll('link[rel~="stylesheet"][href]')]
    .map(node=>resolveAttributeUrl(node.getAttribute('href'),baseUrl,'href'))
    .filter(isAllowedExternalStylesheet)
    .map(href=>`@import url("${href.replaceAll('"','%22')}");`);
  const cssParts=[
    nativeBaseCss(),
    ...externalStyles,
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),
    ...(Array.isArray(bundle.stylesheets)?bundle.stylesheets:[]).map(sheet=>{
      const sheetBase=resolveDirectory(sheet.path,baseUrl);
      return rewriteCss(String(sheet.css||''),sheetBase);
    })
  ].filter(Boolean);

  sanitizeDocument(doc,baseUrl);
  markScriptlessScenes(doc);
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
    legacyGenerated:Boolean(bundle.legacyGenerated),
    direction:normalizeDirection(doc.documentElement.getAttribute('dir')||doc.body.getAttribute('dir')),
    language:normalizeLanguage(doc.documentElement.getAttribute('lang')||doc.body.getAttribute('lang')),
    bodyClass:safeClass(doc.body.className,320),
    bodyStyle:String(doc.body.getAttribute('style')||'').slice(0,5000)
  };
}

function sanitizeDocument(doc,baseUrl){
  doc.querySelectorAll(REMOVE_TAGS).forEach(node=>node.remove());
  const elements=[doc.body,...doc.body.querySelectorAll('*')];
  let imageIndex=0;
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
    if(tag==='IMG'){
      imageIndex+=1;
      if(!element.hasAttribute('decoding'))element.setAttribute('decoding','async');
      if(isPriorityImage(element,imageIndex)){
        element.setAttribute('loading','eager');
        element.setAttribute('fetchpriority','high');
      }
      element.setAttribute('data-marktone-native-asset','image');
    }else if(['VIDEO','AUDIO','SOURCE'].includes(tag)){
      element.setAttribute('data-marktone-native-asset',tag.toLowerCase());
    }
    if(isMotionRevealElement(element))element.setAttribute('data-marktone-native-reveal','true');
    if(element.hasAttribute('data-aos'))element.classList.add('aos-animate');
    if(element.hasAttribute('data-reveal')||element.classList.contains('wow'))element.classList.add('is-visible');
  }
}

function markScriptlessScenes(doc){
  const markers=[...doc.querySelectorAll('[data-start][data-end]')];
  const scenes=new Set();
  for(const marker of markers){
    let current=marker.parentElement;
    let fallback=null;
    let named=null;
    for(let depth=0;current&&current!==doc.body&&depth<10;depth+=1,current=current.parentElement){
      if(current.querySelectorAll('[data-start][data-end]').length<2)continue;
      fallback=current;
      if(/scroll|sticky|challenge|journey|story|timeline|scene|sequence|chapter|pin/.test(elementIdentity(current)))named=current;
    }
    const scene=named||fallback;
    if(scene)scenes.add(scene);
  }

  for(const scene of scenes){
    const sceneMarkers=[...scene.querySelectorAll('[data-start][data-end]')];
    if(sceneMarkers.length<2)continue;
    const sticky=findScriptlessSticky(scene,sceneMarkers);
    scene.setAttribute('data-marktone-scriptless-scene','true');
    sticky.setAttribute('data-marktone-scriptless-sticky','true');

    for(const child of [...sticky.children]){
      if(isScriptlessDecoration(child)){
        child.setAttribute('data-marktone-scriptless-decoration','true');
        continue;
      }
      if(!hasMeaningfulNativeContent(child))continue;
      child.setAttribute('data-marktone-scriptless-item','true');
      if(child.querySelector('h1,h2,h3')||/title|heading|bridge|summary|outro|final|intro/.test(elementIdentity(child))){
        child.setAttribute('data-marktone-scriptless-wide','true');
      }
    }
    for(const marker of sceneMarkers)marker.setAttribute('data-marktone-scriptless-item','true');
  }
}

function findScriptlessSticky(scene,markers){
  let current=markers[0]?.parentElement||scene;
  while(current&&current!==scene&&!markers.every(marker=>current.contains(marker)))current=current.parentElement;
  let candidate=current||scene;
  for(let node=candidate;node&&node!==scene.parentElement;node=node.parentElement){
    if(/sticky|pin|viewport|stage/.test(elementIdentity(node)))return node;
    if(node===scene)break;
  }
  return candidate;
}

function isScriptlessDecoration(element){
  const identity=elementIdentity(element);
  const hasMedia=Boolean(element.querySelector('img,picture,video,svg:not([aria-hidden="true"]),canvas'));
  const hasText=Boolean(element.textContent?.trim());
  if(element.getAttribute('aria-hidden')==='true'&&!hasMedia&&!hasText)return true;
  return !hasMedia&&!hasText&&/aura|progress|particle|noise|grid|glow|blob|background|overlay|decor|ornament|cursor/.test(identity);
}

function hasMeaningfulNativeContent(element){
  return Boolean(element.textContent?.trim()||element.querySelector('img,picture,video,audio,svg:not([aria-hidden="true"]),canvas,form,button,a[href]'));
}

function isMotionRevealElement(element){
  if(element.hasAttribute('data-aos')||element.hasAttribute('data-reveal')||element.classList.contains('wow'))return true;
  return /(^|\s)(reveal|fade-in|fade-up|animate-on-scroll|scroll-reveal|motion-reveal)(\s|$)/i.test(String(element.className||''));
}

function isPriorityImage(element,index){
  if(index<=2)return true;
  const owner=element.closest('header,main,section,article,div');
  return /hero|banner|masthead|cover|above-fold/.test(elementIdentity(owner));
}

function elementIdentity(element){return `${element?.id||''} ${String(element?.className||'')}`.toLowerCase()}

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
  const pairs=[
    ['data-src','src'],['data-lazy-src','src'],['data-original','src'],['data-url','src'],['data-lazy','src'],
    ['data-srcset','srcset'],['data-lazy-srcset','srcset'],['data-poster','poster']
  ];
  for(const [source,target] of pairs){
    if(!element.hasAttribute(target)&&element.hasAttribute(source)){
      const value=element.getAttribute(source);
      const next=target==='srcset'?rewriteSrcset(value,baseUrl):resolveAttributeUrl(value,baseUrl,target);
      if(next)element.setAttribute(target,next);
    }
  }
  const background=element.getAttribute('data-bg')||element.getAttribute('data-background-image')||
    element.getAttribute('data-bg-src')||element.getAttribute('data-background');
  if(background){
    const raw=String(background).trim();
    if(/url\(/i.test(raw))element.style.backgroundImage=rewriteCss(raw,baseUrl);
    else{
      const url=resolveAttributeUrl(raw,baseUrl,'src');
      if(url)element.style.backgroundImage=`url("${url.replaceAll('"','%22')}")`;
    }
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

function isAllowedExternalStylesheet(value){
  try{
    const url=new URL(String(value||''));
    return url.protocol==='https:'&&['fonts.googleapis.com','fonts.bunny.net'].includes(url.hostname);
  }catch{return false}
}
function normalizeDirection(value){return /^(rtl|ltr)$/i.test(String(value||''))?String(value).toLowerCase():'auto'}
function normalizeLanguage(value){
  const language=String(value||'').trim();
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)?language.slice(0,40):'';
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
.native-root [data-aos],.native-root [data-reveal],.native-root .wow,.native-root [data-marktone-native-reveal="true"]{opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important}
.native-root [data-marktone-scriptless-scene="true"]{position:relative!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important;scroll-snap-type:none!important}
.native-root [data-marktone-scriptless-sticky="true"]{position:relative!important;inset:auto!important;top:auto!important;right:auto!important;bottom:auto!important;left:auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:clamp(16px,2.4vw,30px)!important;align-items:stretch!important;justify-items:center!important;padding:clamp(72px,8vw,128px) clamp(20px,5vw,72px)!important;contain:none!important;transform:none!important}
.native-root [data-marktone-scriptless-item="true"]{position:relative!important;inset:auto!important;top:auto!important;right:auto!important;bottom:auto!important;left:auto!important;display:block!important;width:min(100%,760px)!important;max-width:100%!important;height:auto!important;min-height:0!important;margin:0 auto!important;opacity:1!important;visibility:visible!important;filter:none!important;transform:none!important;grid-column:auto!important}
.native-root [data-marktone-scriptless-item="true"][data-start][data-end]{width:min(100%,360px)!important}
.native-root [data-marktone-scriptless-wide="true"]{grid-column:1/-1!important}
.native-root [data-marktone-scriptless-decoration="true"]{display:none!important}
@media(max-width:900px){.native-root [data-marktone-scriptless-sticky="true"]{grid-template-columns:minmax(0,1fr)!important;padding:clamp(58px,12vw,92px) clamp(16px,5vw,28px)!important}.native-root [data-marktone-scriptless-item="true"],.native-root [data-marktone-scriptless-wide="true"]{grid-column:1!important}}
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
