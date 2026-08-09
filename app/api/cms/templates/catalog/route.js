import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';

export const runtime='nodejs';

export async function GET(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول'},{status:401});
    const url=new URL(request.url);
    const siteKey=String(url.searchParams.get('siteKey')||'marktone-main').trim().slice(0,120);
    const tenantSlug=String(url.searchParams.get('tenantSlug')||'').trim().slice(0,120)||null;
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v3_cms_template_catalog`,{
      method:'POST',
      headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_site_key:siteKey,p_tenant_slug:tenantSlug}),
      cache:'no-store'
    });
    const text=await response.text();
    let data={};try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      console.error('cms_template_catalog_upstream_failed',{status:response.status,detail:text.slice(0,500)});
      return NextResponse.json({error:'تعذر تحميل مكتبة القوالب'},{status:response.status>=400&&response.status<500?response.status:502});
    }
const templates=(Array.isArray(data?.templates)?data.templates:[]).map(template=>{
  const entryUrl=`${SUPABASE_URL}/storage/v1/object/public/${encodePath(template.assetBucket)}/${encodePath(template.entryPath)}`;
  return {
    id:template.id,name:template.name,status:template.status,entryUrl,
    nativeUrl:entryUrl.replace(/index\.html$/i,'marktone-native-v1.json'),
    fileCount:Number(template.fileCount)||0,totalBytes:Number(template.totalBytes)||0,
    checksum:template.checksum||'',createdAt:template.createdAt||null
  };
});
    return NextResponse.json({templates});
  }catch(error){
    console.error('cms_template_catalog_failed',error);
    return NextResponse.json({error:'تعذر تحميل مكتبة القوالب'},{status:500});
  }
}

function encodePath(path){return String(path||'').split('/').map(encodeURIComponent).join('/')}
