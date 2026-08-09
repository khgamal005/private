import {SUPABASE_URL} from '../../../../../lib/config';
import {
  TEMPLATE_RUNTIME_LIMITS,TemplateRuntimeError,buildTemplateErrorDocument,
  normalizeTemplateEntryUrl,rewriteTemplateDocument,runtimeResponseHeaders
} from '../../../../../lib/cms-template-runtime';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;

export async function GET(request){
  try{
    const source=request.nextUrl.searchParams.get('src');
    const entry=normalizeTemplateEntryUrl(source,SUPABASE_URL);
    const upstream=await fetch(entry.href,{
      headers:{Accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'},
      cache:'force-cache',next:{revalidate:31536000}
    });
    if(!upstream.ok){
      throw new TemplateRuntimeError(
        upstream.status===404?'لم يعد ملف القالب موجودًا. أعد استيراد ملف ZIP.':'تعذر قراءة ملف القالب من التخزين.',
        'template_source_failed',upstream.status===404?404:502
      );
    }
    const declared=Number(upstream.headers.get('content-length')||0);
    if(declared>TEMPLATE_RUNTIME_LIMITS.htmlBytes){
      throw new TemplateRuntimeError('ملف index.html أكبر من الحد المسموح.','template_html_too_large',413);
    }
    const sourceBuffer=Buffer.from(await upstream.arrayBuffer());
    if(sourceBuffer.length>TEMPLATE_RUNTIME_LIMITS.htmlBytes){
      throw new TemplateRuntimeError('ملف index.html أكبر من الحد المسموح.','template_html_too_large',413);
    }
    const document=rewriteTemplateDocument(sourceBuffer,entry);
    return new Response(document,{status:200,headers:runtimeResponseHeaders()});
  }catch(error){
    const known=error instanceof TemplateRuntimeError;
    const message=known?error.message:'تعذر تجهيز القالب للعرض الآمن.';
    console.error('cms_template_runtime_failed',known?{code:error.code,message:error.message}:error);
    return new Response(buildTemplateErrorDocument(message),{
      status:known?error.status:500,
      headers:{...runtimeResponseHeaders(),'Cache-Control':'no-store'}
    });
  }
}
