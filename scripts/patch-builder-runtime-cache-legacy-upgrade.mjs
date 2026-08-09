import {readFile,writeFile} from 'node:fs/promises';

const VERSION='2.0.0-beta.26';

async function text(path){return readFile(path,'utf8')}
async function save(path,value){await writeFile(path,value)}
function replaceOnce(source,needle,replacement,label){
  if(!source.includes(needle))throw new Error(`Missing patch target: ${label}`);
  return source.replace(needle,replacement);
}

// 1) Never cache authenticated builder HTML or its mutation endpoints.
await save('next.config.mjs',`const securityHeaders=[
  {key:'X-Content-Type-Options',value:'nosniff'},
  {key:'X-Frame-Options',value:'DENY'},
  {key:'Referrer-Policy',value:'strict-origin-when-cross-origin'},
  {key:'Permissions-Policy',value:'camera=(), microphone=(), geolocation=()'},
  {key:'Cross-Origin-Opener-Policy',value:'same-origin'},
  {key:'Strict-Transport-Security',value:'max-age=31536000; includeSubDomains'}
];

const noStoreHeaders=[
  {key:'Cache-Control',value:'private, no-store, no-cache, max-age=0, must-revalidate'},
  {key:'CDN-Cache-Control',value:'no-store'},
  {key:'Pragma',value:'no-cache'},
  {key:'Expires',value:'0'}
];

const nextConfig={
  poweredByHeader:false,
  reactStrictMode:true,
  async headers(){
    return [
      {source:'/control/website/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/tenant/:slug/website/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/api/cms/templates/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/api/cms/builder/:path*',headers:[...securityHeaders,...noStoreHeaders]},
      {source:'/:path*',headers:securityHeaders}
    ];
  }
};

export default nextConfig;
`);

for(const path of [
  'app/control/website/builder/[entityType]/[entityId]/page.js',
  'app/tenant/[slug]/website/builder/[entityType]/[entityId]/page.js'
]){
  let source=await text(path);
  source=replaceOnce(
    source,
    "export const dynamic='force-dynamic';",
    "export const dynamic='force-dynamic';\nexport const revalidate=0;\nexport const fetchCache='force-no-store';",
    `${path}: route cache`
  );
  await save(path,source);
}

// 2) Force a versioned builder URL and display the loaded runtime visibly.
{
  const path='components/page-builder-with-library.js';
  let source=await text(path);
  source=replaceOnce(
    source,
    "import {TemplateImportModeProvider} from './template-import-mode-provider';\n",
    "import {TemplateImportModeProvider} from './template-import-mode-provider';\n\nconst BUILDER_RUNTIME_VERSION='2.0.0-beta.26';\nconst BUILDER_RUNTIME_QUERY='_builder';\n",
    'builder runtime constants'
  );
  source=replaceOnce(
    source,
    "  const [ready,setReady]=useState(false);",
    "  const [ready,setReady]=useState(false);\n  const [runtimeReady,setRuntimeReady]=useState(false);",
    'builder runtime state'
  );
  source=replaceOnce(
    source,
    "  useEffect(()=>{\n    try{\n      const parsed=JSON.parse(localStorage.getItem(storageKey)||'[]');",
    "  useEffect(()=>{\n    try{\n      const url=new URL(window.location.href);\n      if(url.searchParams.get(BUILDER_RUNTIME_QUERY)!==BUILDER_RUNTIME_VERSION){\n        url.searchParams.set(BUILDER_RUNTIME_QUERY,BUILDER_RUNTIME_VERSION);\n        window.location.replace(url.toString());\n        return;\n      }\n      localStorage.setItem('marktone-builder-runtime-version',BUILDER_RUNTIME_VERSION);\n    }catch{}\n    setRuntimeReady(true);\n  },[]);\n\n  useEffect(()=>{\n    try{\n      const parsed=JSON.parse(localStorage.getItem(storageKey)||'[]');",
    'builder runtime guard'
  );
  source=replaceOnce(
    source,
    "  if(!ready)return <div dir=\"rtl\"",
    "  if(!ready||!runtimeReady)return <div dir=\"rtl\"",
    'builder ready gate'
  );
  source=replaceOnce(
    source,
    "      <PageBuilder initialData={initialData}/>\n      <style jsx global>{TOOLBAR_LAYOUT_FIX}</style>",
    "      <PageBuilder initialData={initialData}/>\n      <span className=\"marktone-builder-runtime-badge\" dir=\"ltr\">Builder {BUILDER_RUNTIME_VERSION}</span>\n      <style jsx global>{TOOLBAR_LAYOUT_FIX}</style>",
    'builder runtime badge'
  );
  source=replaceOnce(
    source,
    "const TOOLBAR_LAYOUT_FIX=`\n",
    "const TOOLBAR_LAYOUT_FIX=`\n.marktone-builder-runtime-badge{position:fixed;z-index:2200;left:10px;bottom:9px;padding:5px 8px;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(6,24,46,.88);color:#fff;font:700 8px/1.2 Tahoma,Arial,sans-serif;letter-spacing:.02em;pointer-events:none;box-shadow:0 6px 18px rgba(0,0,0,.2);backdrop-filter:blur(8px)}\n",
    'builder runtime badge css'
  );
  await save(path,source);
}

// 3) Convert old one-column imported-template blocks into real native sections.
{
  const path='components/use-page-builder.js';
  let source=await text(path);
  source=replaceOnce(
    source,
    "  const selected=useMemo(()=>locateSelection(document,selection),[document,selection]);",
    "  const selected=useMemo(()=>locateSelection(document,selection),[document,selection]);\n  const legacyTemplateCount=useMemo(()=>countUpgradeableLegacyTemplates(document),[document]);",
    'legacy template count'
  );

  const oldFactory=`      const packageId=nativeTemplatePackageId(template);\n      const importedBlocks=compiled.sections.map((section,index)=>createBuilderBlock('widget',{\n        props:{\n          title:section.title||\`قسم \${index+1}\`,\n          body:'قسم أصلي مستورد من قالب ZIP.',\n          widgetKey:NATIVE_TEMPLATE_WIDGET_KEY,\n          templateId:String(template.id||template.templateId||''),\n          templatePackageId:packageId,\n          entryUrl,\n          nativeUrl:String(template.nativeUrl||compiled.nativeUrl||''),\n          checksum:String(template.checksum||compiled.checksum||''),\n          fileCount:Number(template.fileCount||compiled.fileCount)||0,\n          totalBytes:Number(template.totalBytes||compiled.totalBytes)||0,\n          scriptCount:Number(compiled.scriptCount)||0,\n          templateOwnsPageShell:true,\n          sectionKey:section.key,\n          sectionIndex:index,\n          sectionCount:compiled.sectionCount,\n          textOverrides:{}\n        },\n        style:{\n          paddingY:0,maxWidth:'full',background:'transparent',borderWidth:0,\n          borderRadius:0,shadow:'none',variant:'light',align:'right'\n        }\n      }));`;
  source=replaceOnce(
    source,
    oldFactory,
    "      const importedBlocks=createNativeTemplateBlocks(template,compiled,{});",
    'native block factory reuse'
  );

  source=replaceOnce(
    source,
    "\n  function previewAssistantPlan(operations){",
    `\n  async function upgradeLegacyTemplates(){\n    if(!legacyTemplateCount||busy)return;\n    if(!window.confirm(\`سيتم تحويل \${legacyTemplateCount} قالب ZIP قديم إلى أقسام أصلية مستقلة بعرض الصفحة، مع إزالة العمود والحاوية القديمة. متابعة؟\`))return;\n    setBusy('upgrade-legacy-templates');\n    setNotice({type:'success',text:'جارٍ ترقية القالب القديم إلى أقسام أصلية بدون iframe…'});\n    try{\n      const blocks=[];\n      let upgraded=0;\n      for(const sourceBlock of document.blocks){\n        const legacy=extractUpgradeableLegacyTemplate(sourceBlock);\n        if(!legacy){\n          if(!isEmptyLayoutRow(sourceBlock))blocks.push(sourceBlock);\n          continue;\n        }\n        const p=legacy.props||{};\n        const descriptor={\n          id:String(p.templateId||''),templateId:String(p.templateId||''),\n          name:String(p.title||'قالب ZIP قديم'),title:String(p.title||'قالب ZIP قديم'),\n          entryUrl:String(p.entryUrl||''),nativeUrl:String(p.nativeUrl||''),\n          checksum:String(p.checksum||''),fileCount:Number(p.fileCount)||0,\n          totalBytes:Number(p.totalBytes)||0\n        };\n        if(!descriptor.entryUrl)throw new Error('أحد القوالب القديمة لا يحتوي رابط ملف صالحًا. أعد رفع ملف ZIP.');\n        const compiled=await loadNativeTemplatePackage(descriptor);\n        const nativeBlocks=createNativeTemplateBlocks(descriptor,compiled,p.textOverrides||{});\n        if(!nativeBlocks.length)throw new Error('تعذر استخراج أقسام من أحد القوالب القديمة.');\n        if(blocks.length+nativeBlocks.length>80)throw new Error('لا يمكن ترقية القالب لأن الصفحة ستتجاوز 80 قسمًا.');\n        blocks.push(...nativeBlocks);\n        upgraded+=1;\n      }\n      if(!upgraded)throw new Error('لم نجد قالبًا قديمًا قابلًا للترقية داخل المسودة.');\n      const first=blocks.find(isNativeTemplateBlock);\n      commit({...document,blocks},{\n        selection:first?{kind:'block',blockId:first.id}:firstSelection({blocks}),\n        noticeMessage:\`تم تحويل \${upgraded} قالب قديم إلى أقسام أصلية مستقلة بعرض الصفحة. احفظ المسودة بعد المراجعة.\`\n      });\n    }catch(error){\n      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر ترقية القالب القديم.'});\n    }finally{\n      setBusy('');\n    }\n  }\n\n  function previewAssistantPlan(operations){`,
    'legacy upgrade action'
  );

  source=replaceOnce(
    source,
    "    updateSelected,updateInline,updatePageSetting,importDocument,insertImportedTemplate,\n    previewAssistantPlan,applyAssistantDocument,saveDraft,publish,restore,applyTemplate",
    "    updateSelected,updateInline,updatePageSetting,importDocument,insertImportedTemplate,\n    legacyTemplateCount,upgradeLegacyTemplates,\n    previewAssistantPlan,applyAssistantDocument,saveDraft,publish,restore,applyTemplate",
    'legacy upgrade exports'
  );

  source=replaceOnce(
    source,
    "\nfunction normalizeEditorDocument(value){",
    `\nfunction createNativeTemplateBlocks(template,compiled,textOverrides={}){\n  const entryUrl=String(template.entryUrl||'').trim();\n  const packageId=nativeTemplatePackageId(template);\n  return (Array.isArray(compiled?.sections)?compiled.sections:[]).map((section,index)=>createBuilderBlock('widget',{\n    props:{\n      title:section.title||\`قسم \${index+1}\`,\n      body:'قسم أصلي مستورد من قالب ZIP.',\n      widgetKey:NATIVE_TEMPLATE_WIDGET_KEY,\n      templateId:String(template.id||template.templateId||''),\n      templatePackageId:packageId,\n      entryUrl,\n      nativeUrl:String(template.nativeUrl||compiled.nativeUrl||''),\n      checksum:String(template.checksum||compiled.checksum||''),\n      fileCount:Number(template.fileCount||compiled.fileCount)||0,\n      totalBytes:Number(template.totalBytes||compiled.totalBytes)||0,\n      scriptCount:Number(compiled.scriptCount)||0,\n      templateOwnsPageShell:true,\n      sectionKey:section.key,\n      sectionIndex:index,\n      sectionCount:Number(compiled.sectionCount)||1,\n      textOverrides:textOverrides&&typeof textOverrides==='object'&&!Array.isArray(textOverrides)?{...textOverrides}:{}\n    },\n    style:{\n      paddingY:0,maxWidth:'full',background:'transparent',borderWidth:0,\n      borderRadius:0,shadow:'none',variant:'light',align:'right'\n    }\n  }));\n}\nfunction extractUpgradeableLegacyTemplate(block){\n  if(isLegacyTemplateBlock(block))return block;\n  if(block?.type!=='columns'||block.props?.row!==true)return null;\n  const modules=(Array.isArray(block.props?.items)?block.props.items:[])\n    .flatMap(column=>Array.isArray(column?.modules)?column.modules:[]);\n  return modules.length===1&&isLegacyTemplateBlock(modules[0])?modules[0]:null;\n}\nfunction countUpgradeableLegacyTemplates(value){\n  return (Array.isArray(value?.blocks)?value.blocks:[]).reduce((count,block)=>count+(extractUpgradeableLegacyTemplate(block)?1:0),0);\n}\nfunction isLegacyTemplateBlock(block){\n  return block?.type==='widget'&&block.props?.widgetKey==='imported-template';\n}\n\nfunction normalizeEditorDocument(value){`,
    'legacy upgrade helpers'
  );
  await save(path,source);
}

// 4) Surface the legacy conversion action in the editor.
{
  const path='components/page-builder.js';
  let source=await text(path);
  source=replaceOnce(
    source,
    "    updatePageSetting,importDocument,insertImportedTemplate,previewAssistantPlan,applyAssistantDocument,\n    saveDraft,publish,restore,applyTemplate",
    "    updatePageSetting,importDocument,insertImportedTemplate,legacyTemplateCount,upgradeLegacyTemplates,\n    previewAssistantPlan,applyAssistantDocument,saveDraft,publish,restore,applyTemplate",
    'builder legacy action destructure'
  );
  source=replaceOnce(
    source,
    "    {notice&&!assistantPreview&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}><span>{notice.text}</span><button type=\"button\" onClick={()=>setNotice(null)}>×</button></div>}\n    {assistantPreview&&",
    "    {notice&&!assistantPreview&&<div className={`${styles.notice} ${notice.type==='error'?styles.noticeError:styles.noticeSuccess}`}><span>{notice.text}</span><button type=\"button\" onClick={()=>setNotice(null)}>×</button></div>}\n    {legacyTemplateCount>0&&!assistantPreview&&<div className={styles.legacyUpgradeBar}><div><b>تم اكتشاف قالب ZIP قديم داخل عمود</b><span>حوّله إلى أقسام أصلية مستقلة حتى يختفي ارتفاع 720 وشريط التمرير والحاوية القديمة.</span></div><button type=\"button\" disabled={Boolean(busy)} onClick={upgradeLegacyTemplates}>{busy==='upgrade-legacy-templates'?'جارٍ الترقية…':'ترقية القالب الآن'}</button></div>}\n    {assistantPreview&&",
    'legacy upgrade banner'
  );
  await save(path,source);
}

{
  const path='components/page-builder.module.css';
  let source=await text(path);
  source+=`\n.legacyUpgradeBar{min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:8px 16px;direction:rtl;background:#fff3d8;color:#6a4300;border-block:1px solid #edcf8b}.legacyUpgradeBar>div{display:grid;gap:3px}.legacyUpgradeBar b{font-size:10px}.legacyUpgradeBar span{font-size:8px;line-height:1.5}.legacyUpgradeBar button{border:0;border-radius:8px;background:#0b2949;color:#fff;padding:9px 13px;font:800 9px Tahoma,Arial,sans-serif;white-space:nowrap;cursor:pointer}.legacyUpgradeBar button:disabled{opacity:.55;cursor:wait}@media(max-width:760px){.legacyUpgradeBar{align-items:stretch;flex-direction:column}.legacyUpgradeBar button{width:100%}}\n`;
  await save(path,source);
}

// 5) Version and regression coverage.
{
  const pkg=JSON.parse(await text('package.json'));
  pkg.version=VERSION;
  await save('package.json',`${JSON.stringify(pkg,null,2)}\n`);
  const lock=JSON.parse(await text('package-lock.json'));
  lock.version=VERSION;
  if(lock.packages?.[''])lock.packages[''].version=VERSION;
  await save('package-lock.json',`${JSON.stringify(lock,null,2)}\n`);
}

await save('tests/cms-builder-runtime-cache-legacy-upgrade.test.mjs',`import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport {readFile} from 'node:fs/promises';\n\nconst root=new URL('../',import.meta.url);\nconst source=path=>readFile(new URL(path,root),'utf8');\n\ntest('builder runtime is versioned and authenticated builder routes are never cached',async()=>{\n  const [wrapper,config,platformRoute,tenantRoute,pkg]=await Promise.all([\n    source('components/page-builder-with-library.js'),source('next.config.mjs'),\n    source('app/control/website/builder/[entityType]/[entityId]/page.js'),\n    source('app/tenant/[slug]/website/builder/[entityType]/[entityId]/page.js'),\n    source('package.json')\n  ]);\n  assert.match(wrapper,/BUILDER_RUNTIME_VERSION='2\\.0\\.0-beta\\.26'/);\n  assert.match(wrapper,/marktone-builder-runtime-badge/);\n  assert.match(wrapper,/window\\.location\\.replace/);\n  assert.match(config,/private, no-store, no-cache/);\n  assert.match(config,/\\/control\\/website\\/builder/);\n  assert.match(config,/\\/tenant\\/:slug\\/website\\/builder/);\n  assert.match(platformRoute,/fetchCache='force-no-store'/);\n  assert.match(tenantRoute,/fetchCache='force-no-store'/);\n  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.26');\n});\n\ntest('legacy one-column ZIP widgets can be upgraded into native sections',async()=>{\n  const [hook,builder]=await Promise.all([source('components/use-page-builder.js'),source('components/page-builder.js')]);\n  assert.match(hook,/upgradeLegacyTemplates/);\n  assert.match(hook,/extractUpgradeableLegacyTemplate/);\n  assert.match(hook,/createNativeTemplateBlocks/);\n  assert.match(hook,/widgetKey==='imported-template'/);\n  assert.match(builder,/ترقية القالب الآن/);\n  assert.match(builder,/legacyUpgradeBar/);\n});\n`);

console.log(`Applied builder runtime hardening ${VERSION}.`);
