export const NATIVE_TEMPLATE_FORMAT='marktone-native-template';
export const NATIVE_TEMPLATE_VERSION=1;
export const NATIVE_TEMPLATE_FILENAME='marktone-native-v1.json';

export const NATIVE_TEMPLATE_LIMITS=Object.freeze({
  htmlBytes:2*1024*1024,
  cssFileBytes:1024*1024,
  cssTotalBytes:4*1024*1024,
  bundleBytes:8*1024*1024,
  stylesheets:80,
  scripts:250
});

const ENTRY_PATH=/^\/storage\/v1\/object\/public\/cms-template-assets\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/r([1-9][0-9]*)\/(index\.html|marktone-native-v1\.json)$/i;

export class NativeTemplateError extends Error{
  constructor(message,code='native_template_failed',status=500){
    super(message);
    this.name='NativeTemplateError';
    this.code=code;
    this.status=status;
  }
}

export function normalizeNativeTemplateSource(value,supabaseUrl){
  let source;
  let storage;
  try{
    source=new URL(String(value||'').trim());
    storage=new URL(String(supabaseUrl||'').trim());
  }catch{
    throw new NativeTemplateError('رابط القالب غير صالح.','native_template_url_invalid',400);
  }
  if(source.protocol!=='https:'||storage.protocol!=='https:'||source.origin!==storage.origin){
    throw new NativeTemplateError('مصدر القالب غير مسموح.','native_template_origin_invalid',400);
  }
  if(source.username||source.password||source.hash||!ENTRY_PATH.test(source.pathname)){
    throw new NativeTemplateError('مسار القالب غير صالح.','native_template_path_invalid',400);
  }
  source.search='';
  source.hash='';
  const prefixPath=source.pathname.replace(/(?:index\.html|marktone-native-v1\.json)$/i,'');
  const assetBase=new URL(prefixPath,source.origin);
  const entryUrl=new URL('index.html',assetBase);
  const nativeUrl=new URL(NATIVE_TEMPLATE_FILENAME,assetBase);
  return {source,assetBase,entryUrl,nativeUrl,prefixPath,origin:source.origin};
}

export function nativeTemplateUrlFromEntry(value){
  const source=new URL(String(value||''));
  source.pathname=source.pathname.replace(/index\.html$/i,NATIVE_TEMPLATE_FILENAME);
  source.search='';
  source.hash='';
  return source.href;
}

export function buildNativeTemplateBundle(parsed,{baseUrl,checksum=''}={}){
  const files=Array.isArray(parsed?.files)?parsed.files:[];
  const indexFile=files.find(file=>file.path==='index.html');
  if(!indexFile)throw new NativeTemplateError('ملف index.html غير موجود.','native_template_index_missing',422);
  const html=decodeUtf8(indexFile.data,'index.html');
  enforceBytes(html,NATIVE_TEMPLATE_LIMITS.htmlBytes,'ملف index.html أكبر من الحد المسموح.','native_template_html_too_large');

  const stylesheets=[];
  let cssBytes=0;
  for(const file of files){
    if(!String(file.mimeType||'').startsWith('text/css'))continue;
    if(stylesheets.length>=NATIVE_TEMPLATE_LIMITS.stylesheets){
      throw new NativeTemplateError('عدد ملفات CSS أكبر من الحد المسموح.','native_template_css_limit',422);
    }
    const css=decodeUtf8(file.data,file.path);
    const bytes=utf8Bytes(css);
    if(bytes>NATIVE_TEMPLATE_LIMITS.cssFileBytes){
      throw new NativeTemplateError(`ملف CSS كبير جدًا: ${file.path}`,'native_template_css_file_too_large',422);
    }
    cssBytes+=bytes;
    if(cssBytes>NATIVE_TEMPLATE_LIMITS.cssTotalBytes){
      throw new NativeTemplateError('إجمالي ملفات CSS أكبر من الحد المسموح.','native_template_css_total_too_large',422);
    }
    stylesheets.push({path:file.path,css,sha256:String(file.sha256||'')});
  }

  const scripts=files
    .filter(file=>/javascript/i.test(String(file.mimeType||'')))
    .slice(0,NATIVE_TEMPLATE_LIMITS.scripts)
    .map(file=>({path:file.path,sha256:String(file.sha256||''),size:Number(file.size)||0}));

  const normalizedBase=normalizeBaseUrl(baseUrl);
  return normalizeStoredNativeBundle({
    format:NATIVE_TEMPLATE_FORMAT,
    version:NATIVE_TEMPLATE_VERSION,
    baseUrl:normalizedBase,
    html,
    stylesheets,
    scripts,
    scriptCount:files.filter(file=>/javascript/i.test(String(file.mimeType||''))).length,
    checksum:String(checksum||''),
    capabilities:{shadowDom:true,sections:true,inlineText:true,javascript:'disabled'}
  },{assetBase:new URL(normalizedBase)});
}

export function serializeNativeTemplateBundle(bundle){
  const normalized=normalizeStoredNativeBundle(bundle,{assetBase:new URL(String(bundle?.baseUrl||''))});
  const output=JSON.stringify(normalized);
  enforceBytes(output,NATIVE_TEMPLATE_LIMITS.bundleBytes,'حزمة القالب الأصلية أكبر من الحد المسموح.','native_template_bundle_too_large');
  return Buffer.from(output,'utf8');
}

export function normalizeStoredNativeBundle(value,source){
  const assetBase=source?.assetBase instanceof URL?source.assetBase:new URL(normalizeBaseUrl(value?.baseUrl));
  const html=String(value?.html||'');
  enforceBytes(html,NATIVE_TEMPLATE_LIMITS.htmlBytes,'ملف index.html أكبر من الحد المسموح.','native_template_html_too_large');

  const stylesheets=[];
  let cssBytes=0;
  for(const item of Array.isArray(value?.stylesheets)?value.stylesheets:[]){
    if(stylesheets.length>=NATIVE_TEMPLATE_LIMITS.stylesheets)break;
    const path=normalizeRelativePath(item?.path||`style-${stylesheets.length+1}.css`);
    const css=String(item?.css||'');
    const bytes=utf8Bytes(css);
    if(bytes>NATIVE_TEMPLATE_LIMITS.cssFileBytes)continue;
    cssBytes+=bytes;
    if(cssBytes>NATIVE_TEMPLATE_LIMITS.cssTotalBytes)break;
    stylesheets.push({path,css,sha256:String(item?.sha256||'').slice(0,128)});
  }

  const scripts=(Array.isArray(value?.scripts)?value.scripts:[])
    .slice(0,NATIVE_TEMPLATE_LIMITS.scripts)
    .map((item,index)=>({
      path:normalizeRelativePath(item?.path||`script-${index+1}.js`),
      sha256:String(item?.sha256||'').slice(0,128),
      size:Math.max(0,Number(item?.size)||0)
    }));

  return {
    format:NATIVE_TEMPLATE_FORMAT,
    version:NATIVE_TEMPLATE_VERSION,
    baseUrl:ensureTrailingSlash(assetBase.href),
    html,
    stylesheets,
    scripts,
    scriptCount:Math.max(scripts.length,Math.min(NATIVE_TEMPLATE_LIMITS.scripts,Number(value?.scriptCount)||0)),
    checksum:String(value?.checksum||'').replace(/[^a-f0-9]/gi,'').slice(0,64),
    capabilities:{shadowDom:true,sections:true,inlineText:true,javascript:'disabled'},
    legacyGenerated:Boolean(value?.legacyGenerated)
  };
}

export function extractStylesheetHrefs(html){
  const output=[];
  const seen=new Set();
  const tags=String(html||'').match(/<link\b[^>]*>/gi)||[];
  for(const tag of tags){
    const rel=attribute(tag,'rel').toLowerCase().split(/\s+/);
    if(!rel.includes('stylesheet'))continue;
    const href=attribute(tag,'href').trim();
    if(!href||seen.has(href))continue;
    seen.add(href);
    output.push(href);
    if(output.length>=NATIVE_TEMPLATE_LIMITS.stylesheets)break;
  }
  return output;
}

export function nativeTemplateResponseHeaders(){
  return {
    'Content-Type':'application/json; charset=utf-8',
    'Cache-Control':'public, max-age=300, s-maxage=31536000, stale-while-revalidate=86400',
    'X-Content-Type-Options':'nosniff',
    'Referrer-Policy':'no-referrer',
    'X-Robots-Tag':'noindex, nofollow',
    'Cross-Origin-Resource-Policy':'same-origin'
  };
}

function attribute(tag,name){
  const pattern=new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,'i');
  const match=String(tag||'').match(pattern);
  return match?String(match[1]??match[2]??match[3]??''):'';
}

function normalizeBaseUrl(value){
  let url;
  try{url=new URL(String(value||''));}catch{
    throw new NativeTemplateError('مسار أصول القالب غير صالح.','native_template_base_invalid',422);
  }
  if(url.protocol!=='https:')throw new NativeTemplateError('مسار أصول القالب غير آمن.','native_template_base_invalid',422);
  url.search='';
  url.hash='';
  return ensureTrailingSlash(url.href);
}

function normalizeRelativePath(value){
  const path=String(value||'').replaceAll('\\','/').replace(/^\/+/,'');
  const parts=path.split('/').filter(Boolean);
  if(!parts.length||parts.some(part=>part==='.'||part==='..'))return 'asset';
  return parts.join('/').slice(0,500);
}

function decodeUtf8(value,path){
  try{return new TextDecoder('utf-8',{fatal:true}).decode(value);}
  catch{throw new NativeTemplateError(`ترميز الملف غير صالح: ${path}`,'native_template_encoding',422)}
}

function ensureTrailingSlash(value){return String(value||'').replace(/\/?$/,'/')}
function utf8Bytes(value){return new TextEncoder().encode(String(value||'')).byteLength}
function enforceBytes(value,max,message,code){if(utf8Bytes(value)>max)throw new NativeTemplateError(message,code,413)}
