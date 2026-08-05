import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const clean=value=>String(value||'').trim()||null;
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request){
  try{
    const token=await accessToken();
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});

    const {searchParams}=new URL(request.url);
    const slug=clean(searchParams.get('tenantSlug'));
    const contactId=clean(searchParams.get('contactId'));
    if(!slug){
      return NextResponse.json({error:'لم يتم تحديد المنشأة'},{status:400});
    }
    if(!contactId||!UUID_PATTERN.test(contactId)){
      return NextResponse.json({error:'معرّف العميل غير صالح'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_customer_history_snapshot`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_slug:slug,
          p_contact_id:contactId,
          p_limit:250
        }),
        cache:'no-store'
      }
    );

    const text=await response.text();
    let data;
    try{data=JSON.parse(text)}catch{data={detail:text}}
    if(!response.ok){
      return NextResponse.json({
        error:translate(
          data?.message||data?.error||data?.detail||'تعذر تحميل سجل العميل'
        )
      },{status:response.status});
    }

    return NextResponse.json(
      {data},
      {headers:{'Cache-Control':'no-store, max-age=0'}}
    );
  }catch(error){
    return NextResponse.json({
      error:'تعذر تحميل سجل العميل',
      detail:error instanceof Error?error.message:String(error)
    },{status:500});
  }
}

function translate(value){
  const raw=String(value||'').split(':')[0];
  return ({
    forbidden:'ليس لديك صلاحية لعرض سجل هذا العميل',
    tenant_not_found:'المنشأة غير موجودة',
    contact_not_found:'العميل غير موجود'
  })[raw]||'تعذر تحميل سجل العميل';
}

