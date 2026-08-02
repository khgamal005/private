import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const clean=value=>String(value||'').trim()||null;
const uuid=value=>{
  const candidate=clean(value);
  if(!candidate)return null;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)
    ?candidate
    :null;
};

export async function GET(request){
  try{
    const token=await accessToken();
    if(!token)return NextResponse.json({error:'انتهت الجلسة'},{status:401});

    const {searchParams}=new URL(request.url);
    const slug=clean(searchParams.get('tenantSlug'));
    if(!slug){
      return NextResponse.json({error:'لم يتم تحديد المنشأة'},{status:400});
    }

    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_customer_search`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_slug:slug,
          p_phone:clean(searchParams.get('phone')),
          p_name:clean(searchParams.get('name')),
          p_email:clean(searchParams.get('email')),
          p_course_id:uuid(searchParams.get('courseId')),
          p_status:clean(searchParams.get('status')),
          p_owner_staff_id:uuid(searchParams.get('ownerStaffId')),
          p_source:clean(searchParams.get('source')),
          p_limit:50,
          p_offset:0
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
          data?.message||data?.error||data?.detail||'تعذر البحث عن العملاء'
        )
      },{status:response.status});
    }
    return NextResponse.json({data},{headers:{'Cache-Control':'no-store'}});
  }catch(error){
    return NextResponse.json({
      error:'تعذر البحث عن العملاء',
      detail:error instanceof Error?error.message:String(error)
    },{status:500});
  }
}

function translate(value){
  const raw=String(value||'').split(':')[0];
  return ({
    forbidden:'ليس لديك صلاحية للبحث في العملاء',
    tenant_not_found:'المنشأة غير موجودة'
  })[raw]||'تعذر البحث عن العملاء';
}
