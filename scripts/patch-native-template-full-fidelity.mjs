import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const VERSION_FROM='2.0.0-beta.27';
const VERSION_TO='2.0.0-beta.28';

async function text(path){return readFile(path,'utf8')}
async function replaceOnce(path,before,after){
  const source=await text(path);
  assert.ok(source.includes(before),`Missing patch anchor in ${path}`);
  assert.equal(source.indexOf(before),source.lastIndexOf(before),`Patch anchor is not unique in ${path}`);
  await writeFile(path,source.replace(before,after));
}

await replaceOnce('lib/cms-native-template-client.js',
`  const baseUrl=ensureBase(bundle.baseUrl||template.entryUrl);
  const inlineStyles=[...doc.querySelectorAll('style')].map(node=>String(node.textContent||''));
  const cssParts=[
    nativeBaseCss(),
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),`,
`  const baseUrl=ensureBase(bundle.baseUrl||template.entryUrl);
  const inlineStyles=[...doc.querySelectorAll('style')].map(node=>String(node.textContent||''));
  const externalStyles=[...doc.querySelectorAll('link[rel~="stylesheet"][href]')]
    .map(node=>resolveAttributeUrl(node.getAttribute('href'),baseUrl,'href'))
    .filter(isAllowedExternalStylesheet)
    .map(href=>\`@import url("\${href.replaceAll('"','%22')}");\`);
  const cssParts=[
    nativeBaseCss(),
    ...externalStyles,
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),`);

await replaceOnce('lib/cms-native-template-client.js',
`  sanitizeDocument(doc,baseUrl);
  const candidates=collectSectionCandidates(doc.body);`,
`  sanitizeDocument(doc,baseUrl);
  markScriptlessScenes(doc);
  const candidates=collectSectionCandidates(doc.body);`);

await replaceOnce('lib/cms-native-template-client.js',
`    nativeUrl:String(template.nativeUrl||''),
    legacyGenerated:Boolean(bundle.legacyGenerated)
  };`,
`    nativeUrl:String(template.nativeUrl||''),
    legacyGenerated:Boolean(bundle.legacyGenerated),
    direction:normalizeDirection(doc.documentElement.getAttribute('dir')||doc.body.getAttribute('dir')),
    language:normalizeLanguage(doc.documentElement.getAttribute('lang')||doc.body.getAttribute('lang')),
    bodyClass:safeClass(doc.body.className,320),
    bodyStyle:String(doc.body.getAttribute('style')||'').slice(0,5000)
  };`);

await replaceOnce('lib/cms-native-template-client.js',
`function sanitizeDocument(doc,baseUrl){
  doc.querySelectorAll(REMOVE_TAGS).forEach(node=>node.remove());
  const elements=[...doc.body.querySelectorAll('*')];
  for(const element of elements){`,
`function sanitizeDocument(doc,baseUrl){
  doc.querySelectorAll(REMOVE_TAGS).forEach(node=>node.remove());
  const elements=[doc.body,...doc.body.querySelectorAll('*')];
  let imageIndex=0;
  for(const element of elements){`);

await replaceOnce('lib/cms-native-template-client.js',
`    if(tag==='FORM'){
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

function collectSectionCandidates(body){`,
`    if(tag==='FORM'){
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
  return /(^|\\s)(reveal|fade-in|fade-up|animate-on-scroll|scroll-reveal|motion-reveal)(\\s|$)/i.test(String(element.className||''));
}

function isPriorityImage(element,index){
  if(index<=2)return true;
  const owner=element.closest('header,main,section,article,div');
  return /hero|banner|masthead|cover|above-fold/.test(elementIdentity(owner));
}

function elementIdentity(element){return \`\${element?.id||''} \${String(element?.className||'')}\`.toLowerCase()}

function collectSectionCandidates(body){`);

await replaceOnce('lib/cms-native-template-client.js',
`function promoteLazyAsset(element,baseUrl){
  const pairs=[['data-src','src'],['data-lazy-src','src'],['data-original','src'],['data-srcset','srcset']];`,
`function promoteLazyAsset(element,baseUrl){
  const pairs=[
    ['data-src','src'],['data-lazy-src','src'],['data-original','src'],['data-url','src'],['data-lazy','src'],
    ['data-srcset','srcset'],['data-lazy-srcset','srcset'],['data-poster','poster']
  ];`);

await replaceOnce('lib/cms-native-template-client.js',
`  const background=element.getAttribute('data-bg')||element.getAttribute('data-background-image');
  if(background){
    const url=resolveAttributeUrl(background,baseUrl,'src');
    if(url)element.style.backgroundImage=\`url("\${url.replaceAll('"','%22')}")\`;
  }
}`, 
`  const background=element.getAttribute('data-bg')||element.getAttribute('data-background-image')||
    element.getAttribute('data-bg-src')||element.getAttribute('data-background');
  if(background){
    const raw=String(background).trim();
    if(/url\\(/i.test(raw))element.style.backgroundImage=rewriteCss(raw,baseUrl);
    else{
      const url=resolveAttributeUrl(raw,baseUrl,'src');
      if(url)element.style.backgroundImage=\`url("\${url.replaceAll('"','%22')}")\`;
    }
  }
}`);

await replaceOnce('lib/cms-native-template-client.js',
`function ensureBase(value){
  try{
    const url=new URL(String(value||''));
    if(/index\\.html$/i.test(url.pathname))url.pathname=url.pathname.replace(/index\\.html$/i,'');
    if(!url.pathname.endsWith('/'))url.pathname+='/';
    url.search='';
    url.hash='';
    return url.href;
  }catch{throw new Error('مسار أصول القالب غير صالح.')}
}

function nativeBaseCss(){`,
`function ensureBase(value){
  try{
    const url=new URL(String(value||''));
    if(/index\\.html$/i.test(url.pathname))url.pathname=url.pathname.replace(/index\\.html$/i,'');
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

function nativeBaseCss(){`);

await replaceOnce('lib/cms-native-template-client.js',
`.native-root [data-aos],.native-root [data-reveal],.native-root .wow{opacity:1!important;visibility:visible!important;transform:none!important}
:host([data-marktone-editor="true"]) [data-marktone-text-id]{cursor:text;outline:1px dashed transparent;outline-offset:3px;border-radius:4px;caret-color:#f36b21}`,
`.native-root [data-aos],.native-root [data-reveal],.native-root .wow,.native-root [data-marktone-native-reveal="true"]{opacity:1!important;visibility:visible!important;transform:none!important;filter:none!important}
.native-root [data-marktone-scriptless-scene="true"]{position:relative!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;contain:none!important;scroll-snap-type:none!important}
.native-root [data-marktone-scriptless-sticky="true"]{position:relative!important;inset:auto!important;top:auto!important;right:auto!important;bottom:auto!important;left:auto!important;height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important;display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:clamp(16px,2.4vw,30px)!important;align-items:stretch!important;justify-items:center!important;padding:clamp(72px,8vw,128px) clamp(20px,5vw,72px)!important;contain:none!important;transform:none!important}
.native-root [data-marktone-scriptless-item="true"]{position:relative!important;inset:auto!important;top:auto!important;right:auto!important;bottom:auto!important;left:auto!important;display:block!important;width:min(100%,760px)!important;max-width:100%!important;height:auto!important;min-height:0!important;margin:0 auto!important;opacity:1!important;visibility:visible!important;filter:none!important;transform:none!important;grid-column:auto!important}
.native-root [data-marktone-scriptless-item="true"][data-start][data-end]{width:min(100%,360px)!important}
.native-root [data-marktone-scriptless-wide="true"]{grid-column:1/-1!important}
.native-root [data-marktone-scriptless-decoration="true"]{display:none!important}
@media(max-width:900px){.native-root [data-marktone-scriptless-sticky="true"]{grid-template-columns:minmax(0,1fr)!important;padding:clamp(58px,12vw,92px) clamp(16px,5vw,28px)!important}.native-root [data-marktone-scriptless-item="true"],.native-root [data-marktone-scriptless-wide="true"]{grid-column:1!important}}
:host([data-marktone-editor="true"]) [data-marktone-text-id]{cursor:text;outline:1px dashed transparent;outline-offset:3px;border-radius:4px;caret-color:#f36b21}`);

await replaceOnce('components/native-template-section.js',
`    const root=document.createElement('div');
    root.className='native-root';
    root.dir=template.direction||'auto';
    if(template.language)root.lang=template.language;`,
`    const root=document.createElement('div');
    root.className=['native-root',template.bodyClass||''].filter(Boolean).join(' ');
    root.dir=template.direction||'auto';
    if(template.language)root.lang=template.language;
    if(template.bodyStyle)root.setAttribute('style',template.bodyStyle);`);

for(const path of ['package.json','package-lock.json','components/page-builder-with-library.js']){
  const source=await text(path);
  assert.ok(source.includes(VERSION_FROM),`Missing ${VERSION_FROM} in ${path}`);
  await writeFile(path,source.replaceAll(VERSION_FROM,VERSION_TO));
}

for(const name of await readdir('tests')){
  if(!name.endsWith('.test.mjs'))continue;
  const path=join('tests',name);
  const source=await text(path);
  if(source.includes(VERSION_FROM))await writeFile(path,source.replaceAll(VERSION_FROM,VERSION_TO));
}

await writeFile('tests/cms-native-template-full-fidelity.test.mjs',`import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('native template renderer keeps media eager and materializes script-driven content safely',async()=>{
  const [client,section,wrapper,pkg]=await Promise.all([
    source('lib/cms-native-template-client.js'),
    source('components/native-template-section.js'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  assert.match(client,/markScriptlessScenes\\(doc\\)/);
  assert.match(client,/data-marktone-scriptless-scene/);
  assert.match(client,/\\[data-start\\]\\[data-end\\]/);
  assert.match(client,/height:auto!important/);
  assert.match(client,/opacity:1!important/);
  assert.match(client,/setAttribute\\('loading','eager'\\)/);
  assert.doesNotMatch(client,/setAttribute\\('loading','lazy'\\)/);
  assert.match(client,/fonts\\.googleapis\\.com/);
  assert.match(client,/bodyClass:safeClass/);
  assert.match(section,/template\\.bodyClass/);
  assert.match(section,/template\\.bodyStyle/);
  assert.match(wrapper,/2\\.0\\.0-beta\\.28/);
  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.28');
});
`);

console.log('Applied native template full-fidelity patch.');
