import {SUPABASE_URL} from '../../../../../lib/config';
import {
  NATIVE_TEMPLATE_LIMITS,NativeTemplateError,extractStylesheetHrefs,
  nativeTemplateResponseHeaders,normalizeNativeTemplateSource,normalizeStoredNativeBundle
} from '../../../../../lib/cms-native-template';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;

export async function GET(request){
  try{
    const resolved=normalizeNativeTemplateSource(request.nextUrl.searchParams.get('src'),SUPABASE_URL);
    let bundle=await readStoredBundle(resolved);
    if(!bundle)bundle=await buildLegacyBundle(resolved);
    const output=JSON.stringify(bundle);
    if(Buffer.byteLength(output,'utf8')>NATIVE_TEMPLATE_LIMITS.bundleBytes){
      throw new NativeTemplateError('حزمة القالب أكبر من الحد المسموح.','native_template_bundle_too_large',413);
    }
    return new Response(output,{status:200,headers:nativeTemplateResponseHeaders()});
  }catch(error){
    const known=error instanceof NativeTemplateError;
    console.error('cms_native_template_failed',known?{code:error.code,message:error.message}:error);
    return new Response(JSON.stringify({
      error:known?error.message:'تعذر تجهيز القالب للعرض الأصلي.',
      code:known?error.code:'native_template_failed'
    }),{
      status:known?error.status:500,
      headers:{...nativeTemplateResponseHeaders(),'Cache-Control':'no-store'}
    });
  }
}

async function readStoredBundle(resolved){
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
  return /(?:^|\D)404(?:\D|$)/.test(marker)||/object[ _-]*not[ _-]*found|not[ _-]*found/.test(marker);
}

async function buildLegacyBundle(resolved){
  const htmlResponse=await fetch(resolved.entryUrl,{
    headers:{Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'},
    cache:'no-store'
  });
  if(!htmlResponse.ok){
    throw new NativeTemplateError(
      htmlResponse.status===404?'لم يعد ملف القالب موجودًا. أعد استيراد ملف ZIP.':'تعذر قراءة ملف القالب.',
      'native_template_entry_failed',htmlResponse.status===404?404:502
    );
  }
  const html=await readLimitedText(htmlResponse,NATIVE_TEMPLATE_LIMITS.htmlBytes,'ملف index.html أكبر من الحد المسموح.');
  const hrefs=extractStylesheetHrefs(html);
  const stylesheets=[];
  let cssTotal=0;
  for(const href of hrefs){
    let url;
    try{url=new URL(href,resolved.assetBase);}catch{continue}
    if(url.origin!==resolved.origin||!url.pathname.startsWith(resolved.prefixPath))continue;
    const response=await fetch(url,{headers:{Accept:'text/css,*/*;q=0.1'},cache:'no-store'});
    if(!response.ok)continue;
    const css=await readLimitedText(response,NATIVE_TEMPLATE_LIMITS.cssFileBytes,`ملف CSS كبير جدًا: ${url.pathname.split('/').at(-1)}`);
    cssTotal+=Buffer.byteLength(css,'utf8');
    if(cssTotal>NATIVE_TEMPLATE_LIMITS.cssTotalBytes)break;
    stylesheets.push({
      path:url.pathname.slice(resolved.prefixPath.length),
      css,
      sha256:''
    });
  }
  return normalizeStoredNativeBundle({
    html,
    stylesheets,
    scripts:[],
    scriptCount:(html.match(/<script\b/gi)||[]).length,
    checksum:'',
    legacyGenerated:true
  },resolved);
}

async function readLimitedText(response,max,message){
  const declared=Number(response.headers.get('content-length')||0);
  if(declared>max)throw new NativeTemplateError(message,'native_template_source_too_large',413);
  const text=await response.text();
  if(Buffer.byteLength(text,'utf8')>max)throw new NativeTemplateError(message,'native_template_source_too_large',413);
  return text;
}
