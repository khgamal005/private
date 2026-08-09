import {createHash} from 'node:crypto';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {parseTemplateArchive,prepareTemplateIndex,TEMPLATE_ARCHIVE_LIMITS} from '../../../../../lib/cms-template-archive';
import {NATIVE_TEMPLATE_FILENAME,buildNativeTemplateBundle,serializeNativeTemplateBundle} from '../../../../../lib/cms-native-template';

export const runtime='nodejs';
export const maxDuration=60;

export async function POST(request){
  let token=null;
  let templateId='';
  let started=false;
  let assetBucket='cms-template-assets';
  const uploaded=[];
  try{
    token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const body=await request.json();
    templateId=String(body?.templateId||'').trim();
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(templateId)){
      return NextResponse.json({error:'معرّف القالب غير صالح'},{status:400});
    }

    const start=await rpcJson('v3_cms_template_import_action',token,{
      p_template_id:templateId,p_action:'start',p_payload:{}
    });
    started=true;
    assetBucket=start.assetBucket;
    const archiveResponse=await fetch(
      `${SUPABASE_URL}/storage/v1/object/${encodePath(start.stagingBucket)}/${encodePath(start.stagingPath)}`,
      {headers:authHeaders(token),cache:'no-store'}
    );
    if(!archiveResponse.ok)throw new TemplateImportError('تعذر قراءة ملف ZIP المرفوع.','archive_download_failed');
    const declaredSize=Number(archiveResponse.headers.get('content-length')||0);
    if(declaredSize>TEMPLATE_ARCHIVE_LIMITS.compressedBytes)throw new TemplateImportError('حجم ملف ZIP يتجاوز 20 ميجابايت.','archive_too_large');
    const archive=Buffer.from(await archiveResponse.arrayBuffer());
    const parsed=parseTemplateArchive(archive);
    if(parsed.files.some(file=>file.path.toLowerCase()===NATIVE_TEMPLATE_FILENAME)){
      throw new TemplateImportError(`اسم الملف ${NATIVE_TEMPLATE_FILENAME} محجوز لمحرك ماركتون.`,'archive_reserved_file');
    }
    const prefix=`${start.siteId}/${templateId}/r1`;
    const publicBase=`${SUPABASE_URL}/storage/v1/object/public/${encodePath(assetBucket)}/${encodePath(prefix)}`;
    const indexFile=parsed.files.find(file=>file.path==='index.html');
    const assetFiles=parsed.files.filter(file=>file.path!=='index.html');
    async function uploadFile(file){
      const targetPath=`${prefix}/${file.path}`;
      const directory=file.path.includes('/')?file.path.slice(0,file.path.lastIndexOf('/')):'';
      const source=file.mimeType.startsWith('text/html')
        ?prepareTemplateIndex(file.data,directory?`${publicBase}/${encodePath(directory)}`:publicBase)
        :file.data;
      const response=await fetch(
        `${SUPABASE_URL}/storage/v1/object/${encodePath(assetBucket)}/${encodePath(targetPath)}`,
        {
          method:'POST',
          headers:{...authHeaders(token),'Content-Type':contentType(file.mimeType),'cache-control':'max-age=31536000','x-upsert':'false'},
          body:source,cache:'no-store'
        }
      );
      if(!response.ok){
        const detail=await response.text();
        console.error('cms_template_asset_upload_failed',{path:file.path,status:response.status,detail:detail.slice(0,300)});
        throw new TemplateImportError(`تعذر حفظ ملف داخل القالب: ${file.path}`,'asset_upload_failed');
      }
      uploaded.push(targetPath);
    }
    for(let offset=0;offset<assetFiles.length;offset+=6){
      await Promise.all(assetFiles.slice(offset,offset+6).map(uploadFile));
    }
    await uploadFile(indexFile);

    const manifest=parsed.files.map(file=>({path:file.path,mimeType:contentType(file.mimeType),size:file.size,sha256:file.sha256}));
    const checksum=createHash('sha256').update(manifest.map(file=>`${file.path}:${file.sha256}`).join('\n')).digest('hex');
    const nativeBundle=buildNativeTemplateBundle(parsed,{baseUrl:`${publicBase}/`,checksum});
    const nativeFile=serializeNativeTemplateBundle(nativeBundle);
    await uploadFile({path:NATIVE_TEMPLATE_FILENAME,mimeType:'application/json',data:nativeFile});
    const entryPath=`${prefix}/index.html`;
    const complete=await rpcJson('v3_cms_template_import_action',token,{
      p_template_id:templateId,p_action:'complete',
      p_payload:{entryPath,fileCount:manifest.length,totalBytes:parsed.totalBytes,manifest,checksum}
    });
    await removeObjects(start.stagingBucket,[start.stagingPath],token);
    return NextResponse.json({
      success:true,
      template:{
        id:complete.templateId,name:complete.name,status:'ready',entryUrl:`${SUPABASE_URL}/storage/v1/object/public/${encodePath(complete.assetBucket)}/${encodePath(complete.entryPath)}`,
        nativeUrl:`${SUPABASE_URL}/storage/v1/object/public/${encodePath(complete.assetBucket)}/${encodePath(complete.entryPath.replace(/index\.html$/i,NATIVE_TEMPLATE_FILENAME))}`,
        fileCount:complete.fileCount,totalBytes:complete.totalBytes,checksum:complete.checksum
      },
      warnings:['تم تحويل HTML وCSS إلى أقسام أصلية بعرض الصفحة دون iframe.','تم تعطيل JavaScript داخل القالب لحماية جلسة ماركتون، ولن يظهر المحتوى للعامة قبل الحفظ والنشر.']
    });
  }catch(error){
    if(token&&uploaded.length)await removeObjects(assetBucket,uploaded,token);
    if(token&&templateId&&started){
      try{await rpcJson('v3_cms_template_import_action',token,{p_template_id:templateId,p_action:'fail',p_payload:{message:error instanceof Error?error.message:'تعذر الاستيراد'}})}catch{}
    }
    console.error('cms_template_process_failed',error);
    const status=error?.code?.startsWith('archive_')?422:error?.code==='template_import_busy'?409:500;
    return NextResponse.json({error:error instanceof TemplateImportError||error?.code?.startsWith('archive_')?error.message:'تعذر معالجة القالب. لم يتم نشر أي محتوى.'},{status});
  }
}

async function rpcJson(name,token,body){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',headers:{...authHeaders(token),'Content-Type':'application/json'},body:JSON.stringify(body),cache:'no-store'
  });
  const text=await response.text();
  let data={};try{data=JSON.parse(text)}catch{data={detail:text}}
  if(!response.ok){
    const message=String(data?.message||data?.error||data?.detail||'');
    const code=message.includes('template_import_busy')?'template_import_busy':'template_rpc_failed';
    throw new TemplateImportError(code==='template_import_busy'?'توجد عملية استيراد أخرى لهذا القالب.':'تعذر تحديث سجل القالب.',code);
  }
  return data;
}

async function removeObjects(bucket,paths,token){
  if(!paths.length)return;
  try{
    await fetch(`${SUPABASE_URL}/storage/v1/object/${encodePath(bucket)}`,{
      method:'DELETE',headers:{...authHeaders(token),'Content-Type':'application/json'},
      body:JSON.stringify({prefixes:paths}),cache:'no-store'
    });
  }catch(error){console.error('cms_template_cleanup_failed',error)}
}

function authHeaders(token){return {apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`}}
function encodePath(path){return String(path||'').split('/').map(encodeURIComponent).join('/')}
function contentType(value){return String(value||'application/octet-stream').split(';')[0].trim().toLowerCase()}
class TemplateImportError extends Error{constructor(message,code){super(message);this.code=code}}
