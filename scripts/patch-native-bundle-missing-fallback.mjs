import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

const VERSION='2.0.0-beta.27';

async function read(path){return readFile(path,'utf8')}
async function write(path,value){await writeFile(path,value)}
function replaceOnce(source,from,to,label){
  assert.ok(source.includes(from),`Missing patch target: ${label}`);
  return source.replace(from,to);
}

let route=await read('app/api/cms/templates/native/route.js');
const readStart=route.indexOf('async function readStoredBundle(resolved){');
const readEnd=route.indexOf('\nasync function buildLegacyBundle(resolved){',readStart);
assert.ok(readStart>=0&&readEnd>readStart,'readStoredBundle boundaries missing');
const newRead=`async function readStoredBundle(resolved){
  const response=await fetch(resolved.nativeUrl,{
    headers:{Accept:'application/json'},cache:'no-store'
  });
  if(!response.ok){
    const detail=await response.text().catch(()=> '');
    if(isMissingStorageObject(response.status,detail))return null;
    throw new NativeTemplateError('تعذر قراءة حزمة القالب الأصلية.','native_template_source_failed',502);
  }
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>NATIVE_TEMPLATE_LIMITS.bundleBytes){
    throw new NativeTemplateError('حزمة القالب أكبر من الحد المسموح.','native_template_bundle_too_large',413);
  }
  const text=await response.text();
  if(Buffer.byteLength(text,'utf8')>NATIVE_TEMPLATE_LIMITS.bundleBytes){
    throw new NativeTemplateError('حزمة القالب أكبر من الحد المسموح.','native_template_bundle_too_large',413);
  }
  let parsed;
  try{parsed=JSON.parse(text);}catch{
    throw new NativeTemplateError('حزمة القالب غير صالحة.','native_template_bundle_invalid',422);
  }
  return normalizeStoredNativeBundle(parsed,resolved);
}

function isMissingStorageObject(status,detail=''){
  if(status===404)return true;
  if(status!==400)return false;
  let parsed={};
  try{parsed=JSON.parse(String(detail||''))}catch{}
  const marker=[parsed?.statusCode,parsed?.error,parsed?.message,detail]
    .filter(Boolean).join(' ').toLowerCase();
  return /(?:^|\\D)404(?:\\D|$)/.test(marker)||/object[ _-]*not[ _-]*found|not[ _-]*found/.test(marker);
}
`;
route=`${route.slice(0,readStart)}${newRead}${route.slice(readEnd)}`;
route=route.replaceAll("cache:'force-cache',next:{revalidate:31536000}","cache:'no-store'");
await write('app/api/cms/templates/native/route.js',route);

let client=await read('lib/cms-native-template-client.js');
client=replaceOnce(
  client,
  "const response=await fetch(`/api/cms/templates/native?${params}`,{cache:'force-cache'});",
  "const response=await fetch(`/api/cms/templates/native?${params}`,{cache:'no-store'});",
  'native client no-store'
);
await write('lib/cms-native-template-client.js',client);

let provider=await read('components/template-import-mode-provider.js');
provider=replaceOnce(
  provider,
  '<span>{request.sectionCount} قسمًا أصليًا · {request.fileCount} ملفًا</span>',
  "<span>{request.pendingAnalysis?'سيتم تحليل أقسام القالب بعد اختيار طريقة الإدراج':`${request.sectionCount} قسمًا أصليًا · ${request.fileCount} ملفًا`}</span>",
  'provider pending summary'
);
provider=replaceOnce(
  provider,
  "scriptCount:clamp(value.scriptCount,0,250,0)\n  };",
  "scriptCount:clamp(value.scriptCount,0,250,0),\n    pendingAnalysis:Boolean(value.pendingAnalysis)\n  };",
  'provider pending details'
);
await write('components/template-import-mode-provider.js',provider);

let hook=await read('components/use-page-builder.js');
const oldFlow=`    if(busy)return;
    setBusy('compile-template');
    setNotice({type:'success',text:'جارٍ تحليل القالب وتقسيمه إلى أقسام أصلية…'});
    try{
      const compiled=await loadNativeTemplatePackage(template);
      const mode=await chooseTemplateImportMode({
        title:compiled.title,
        sectionCount:compiled.sectionCount,
        fileCount:compiled.fileCount,
        scriptCount:compiled.scriptCount
      });
      if(!mode){
        setNotice({type:'success',text:'تم إلغاء إدراج القالب ولم تتغير المسودة.'});
        return;
      }
`;
const newFlow=`    if(busy)return;
    const mode=await chooseTemplateImportMode({
      title:String(template.name||template.title||'قالب ZIP مستورد'),
      sectionCount:Number(template.sectionCount)||1,
      fileCount:Number(template.fileCount)||0,
      scriptCount:Number(template.scriptCount)||0,
      pendingAnalysis:true
    });
    if(!mode){
      setNotice({type:'success',text:'تم إلغاء إدراج القالب ولم تتغير المسودة.'});
      return;
    }
    setBusy('compile-template');
    setNotice({type:'success',text:'جارٍ تحليل القالب وتقسيمه إلى أقسام أصلية…'});
    try{
      const compiled=await loadNativeTemplatePackage(template);
`;
hook=replaceOnce(hook,oldFlow,newFlow,'prompt before native package read');
await write('components/use-page-builder.js',hook);

let wrapper=await read('components/page-builder-with-library.js');
wrapper=wrapper.replace(/const BUILDER_RUNTIME_VERSION='[^']+';/,`const BUILDER_RUNTIME_VERSION='${VERSION}';`);
assert.match(wrapper,new RegExp(VERSION.replaceAll('.','\\.')));
await write('components/page-builder-with-library.js',wrapper);

for(const path of ['package.json','package-lock.json']){
  let value=await read(path);
  value=value.replace(/"version": "2\.0\.0-beta\.26"/g,`"version": "${VERSION}"`);
  assert.ok(value.includes(`"version": "${VERSION}"`),`${path} version not updated`);
  await write(path,value);
}

const test=`import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
async function source(path){return readFile(new URL(path,root),'utf8')}

test('missing legacy native bundle falls back to index html and css',async()=>{
  const route=await source('app/api/cms/templates/native/route.js');
  assert.match(route,/isMissingStorageObject/);
  assert.match(route,/status===400/);
  assert.match(route,/object\[ _-\]\*not/);
  assert.match(route,/buildLegacyBundle/);
  assert.match(route,/cache:'no-store'/);
});

test('template insertion asks append or replace before reading the native package',async()=>{
  const [hook,provider,client,wrapper,pkg]=await Promise.all([
    source('components/use-page-builder.js'),
    source('components/template-import-mode-provider.js'),
    source('lib/cms-native-template-client.js'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  const choose=hook.indexOf('await chooseTemplateImportMode');
  const load=hook.indexOf('await loadNativeTemplatePackage',choose);
  assert.ok(choose>=0&&load>choose);
  assert.match(provider,/pendingAnalysis/);
  assert.match(client,/templates\\/native\\?\\$\\{params\\}.*cache:'no-store'/s);
  assert.match(wrapper,/2\\.0\\.0-beta\\.27/);
  assert.match(pkg,/"version": "2\\.0\\.0-beta\\.27"/);
});
`;
await write('tests/cms-native-bundle-fallback.test.mjs',test);

console.log('Applied native bundle fallback and deterministic import choice.');
