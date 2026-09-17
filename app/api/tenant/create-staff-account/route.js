import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {staffAccountError} from '../../../../lib/staff-account-errors.mjs';
export const runtime='nodejs';

function json(body,status=200){
  return NextResponse.json(body,{status,headers:{
    'Cache-Control':'private, no-store, no-cache, max-age=0',
    'CDN-Cache-Control':'no-store'
  }});
}

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return json({error:'انتهت الجلسة؛ سجل الدخول مرة أخرى'},401);
    const body=await request.json();
    if(typeof body.password!=='string'||body.password.length<12||body.password.length>128){
      return json({error:staffAccountError('weak_password')},400);
    }
    if(typeof body.p_tenant_slug!=='string'||!body.p_tenant_slug.trim()
      ||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.p_staff_id||'')){
      return json({error:'بيانات الموظف غير مكتملة'},400);
    }
    const response=await fetch(`${SUPABASE_URL}/functions/v1/tenant-staff-account`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({p_tenant_slug:body.p_tenant_slug.trim(),p_staff_id:body.p_staff_id,password:body.password}),
      cache:'no-store',signal:AbortSignal.timeout(50000)
    });
    const data=await response.json().catch(()=>({}));
    if(!response.ok)return json({error:staffAccountError(data.error)},response.status);
    return json({success:true,data:{completed:Boolean(data.data?.completed),passwordUnchanged:Boolean(data.data?.passwordUnchanged)}});
  }catch{return json({error:staffAccountError('activation_incomplete')},503);}
}
