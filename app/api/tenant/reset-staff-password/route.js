import {randomInt} from 'node:crypto';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {SUPABASE_SECRET_KEY} from '../../../../lib/admin-config';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const runtime='nodejs';

export async function POST(request){
  try{
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token){
      return json({error:'انتهت الجلسة'},{status:401});
    }
    if(!SUPABASE_SECRET_KEY){
      return json({
        error:'إعادة تعيين كلمة المرور غير مفعّلة على الخادم'
      },{status:503});
    }

    const body=await request.json();
    const tenantSlug=String(body?.p_tenant_slug||'').trim();
    const staffId=String(body?.p_staff_id||'').trim();
    if(!tenantSlug||!isUuid(staffId)){
      return json({error:'بيانات الموظف غير مكتملة'},{status:400});
    }

    const prepared=await rpc(
      'v2_tenant_prepare_staff_password_reset',
      {
        p_tenant_slug:tenantSlug,
        p_staff_id:staffId
      },
      token,
      SUPABASE_KEY
    );
    if(!prepared.ok){
      return json({
        error:translate(prepared.data),
        detail:prepared.data
      },{status:prepared.status});
    }

    const temporaryPassword=generateTemporaryPassword();
    const authResponse=await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(
        prepared.data.targetAuthUserId
      )}`,
      {
        method:'PUT',
        headers:adminHeaders(),
        body:JSON.stringify({password:temporaryPassword}),
        cache:'no-store'
      }
    );
    const authData=await parse(authResponse);
    if(!authResponse.ok){
      return json({
        error:'تعذر تحديث كلمة مرور الموظف',
        detail:authData
      },{status:authResponse.status});
    }

    let completed;
    for(let attempt=0;attempt<3;attempt+=1){
      completed=await rpc(
        'v2_tenant_complete_staff_password_reset',
        {
          p_tenant_id:prepared.data.tenantId,
          p_staff_id:prepared.data.staffId,
          p_target_auth_user_id:prepared.data.targetAuthUserId,
          p_actor_subject_id:prepared.data.actorSubjectId
        },
        SUPABASE_SECRET_KEY,
        SUPABASE_SECRET_KEY
      );
      if(completed.ok)break;
    }
    if(!completed?.ok){
      return json({
        error:'تم تحديث كلمة المرور لكن تعذر إكمال سجل الأمان؛ أعد المحاولة',
        detail:completed?.data
      },{status:500});
    }

    return json({
      success:true,
      data:{
        ...completed.data,
        temporaryPassword,
        shownOnce:true
      }
    });
  }catch(error){
    return json({
      error:'تعذر إعادة تعيين كلمة المرور',
      detail:error.message
    },{status:500});
  }
}

async function rpc(name,body,token,apiKey){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:apiKey,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(body),
    cache:'no-store'
  });
  return {
    ok:response.ok,
    status:response.status,
    data:await parse(response)
  };
}

function adminHeaders(){
  return {
    apikey:SUPABASE_SECRET_KEY,
    Authorization:`Bearer ${SUPABASE_SECRET_KEY}`,
    'Content-Type':'application/json'
  };
}

async function parse(response){
  const text=await response.text();
  if(!text)return null;
  try{return JSON.parse(text)}catch{return {detail:text}}
}

function json(body,init){
  const response=NextResponse.json(body,init);
  response.headers.set('Cache-Control','no-store, max-age=0');
  return response;
}

function isUuid(value){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function generateTemporaryPassword(){
  const groups=[
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#$%*-_'
  ];
  const all=groups.join('');
  const characters=groups.map(group=>pick(group));
  while(characters.length<18)characters.push(pick(all));
  for(let index=characters.length-1;index>0;index-=1){
    const target=randomInt(index+1);
    [characters[index],characters[target]]=[characters[target],characters[index]];
  }
  return characters.join('');
}

function pick(characters){
  return characters[randomInt(characters.length)];
}

function translate(payload){
  const code=String(
    payload?.message
    ||payload?.error
    ||payload?.detail
    ||''
  );
  const messages={
    forbidden:'ليس لديك صلاحية لإعادة تعيين كلمة المرور',
    tenant_not_found:'المنشأة غير موجودة',
    staff_account_not_active:'إعادة التعيين متاحة للحسابات النشطة فقط',
    cannot_reset_own_password:'غيّر كلمة مرور حسابك من صفحة تغيير كلمة المرور',
    protected_staff_account:'لا يمكنك إعادة تعيين كلمة مرور مدير بصلاحية مساوية أو أعلى'
  };
  return messages[code]||'تعذر التحقق من صلاحية إعادة التعيين';
}
