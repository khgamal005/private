import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const CORE_ACTIONS=Object.freeze({
  'create-customer-account':'create_customer_account',
  'update-customer-account':'update_customer_account',
  'create-document':'create_document',
  'update-document':'update_document',
  'issue-document':'issue_document',
  'cancel-document':'cancel_document',
  'record-payment':'record_payment',
  'verify-payment':'verify_payment',
  'allocate-payment':'allocate_payment',
  'issue-receipt':'issue_receipt',
  'create-schedule':'create_schedule',
  'record-collection-action':'record_collection_action',
  'request-refund':'request_refund',
  'approve-refund':'approve_refund',
  'reject-refund':'reject_refund',
  'complete-refund':'complete_refund',
  'save-settings':'save_settings',
  'import-handoff-payment':'import_handoff_payment'
});

const ZATCA_ACTIONS=Object.freeze({
  'save-zatca-config':'save_config'
});

function json(body,status=200){
  return NextResponse.json(body,{
    status,
    headers:{'Cache-Control':'no-store'}
  });
}

const clean=value=>String(value||'').trim()||null;

async function rpc(token,name,args){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:SUPABASE_KEY,
      Authorization:`Bearer ${token}`,
      'Content-Type':'application/json'
    },
    body:JSON.stringify(args),
    cache:'no-store'
  });
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={detail:text}}
  if(!response.ok){
    const error=new Error(data?.message||data?.error||data?.detail||'accounting_request_failed');
    error.status=response.status;
    throw error;
  }
  return data;
}

function message(error){
  const raw=String(error?.message||error||'').split(':')[0];
  return ({
    authentication_required:'انتهت الجلسة. سجّل الدخول مرة أخرى.',
    forbidden:'ليست لديك صلاحية لتنفيذ هذا الإجراء.',
    tenant_not_found:'المنشأة غير موجودة.',
    addon_required:'يجب تفعيل إضافة زاتكا أولًا.',
    accounting_action_invalid:'إجراء الحسابات غير صالح.',
    issued_document_immutable:'المستند المثبت لا يمكن تعديله؛ استخدم إشعارًا دائنًا أو مدينًا.',
    payment_allocation_exceeds_available:'المبلغ أكبر من الرصيد غير الموزع في الدفعة.',
    payment_allocation_exceeds_invoice:'المبلغ أكبر من المتبقي على الفاتورة.',
    refund_exceeds_payment:'الاسترداد أكبر من المتاح في الدفعة.',
    command_id_reused_with_different_payload:'تعارض في مفتاح العملية. حدّث الصفحة وأعد المحاولة.',
    zatca_action_invalid:'إجراء زاتكا غير صالح.',
    zatca_config_invalid:'راجع بيانات إعداد زاتكا.'
  })[raw]||'تعذر تنفيذ العملية المحاسبية.';
}

async function tokenOrResponse(){
  const token=await accessToken();
  return token||json({error:'انتهت الجلسة. سجّل الدخول مرة أخرى.'},401);
}

export async function GET(request,{params}){
  try{
    const token=await tokenOrResponse();
    if(typeof token!=='string')return token;
    const {action}=await params;
    if(action!=='snapshot')return json({error:'غير موجود'},404);
    const slug=clean(new URL(request.url).searchParams.get('tenantSlug'));
    if(!slug)return json({error:'لم يتم تحديد المنشأة'},400);
    const accounting=await rpc(token,'v1_tenant_accounting_snapshot',{p_slug:slug});
    let zatca={addonEnabled:false,availability:'addon_required'};
    try{
      zatca=await rpc(token,'v1_tenant_zatca_snapshot',{p_slug:slug});
    }catch(error){
      if(!String(error?.message||'').includes('PGRST202'))throw error;
    }
    return json({...accounting,zatca});
  }catch(error){
    return json({error:message(error)},Number(error?.status)||500);
  }
}

export async function POST(request,{params}){
  try{
    const token=await tokenOrResponse();
    if(typeof token!=='string')return token;
    const {action}=await params;
    const coreAction=CORE_ACTIONS[action];
    const zatcaAction=ZATCA_ACTIONS[action];
    if(!coreAction&&!zatcaAction)return json({error:'غير موجود'},404);
    const body=await request.json().catch(()=>({}));
    const slug=clean(body.tenantSlug);
    if(!slug)return json({error:'لم يتم تحديد المنشأة'},400);
    const name=zatcaAction
      ?'v1_tenant_zatca_action'
      :'v1_tenant_accounting_action';
    return json(await rpc(token,name,{
      p_slug:slug,
      p_action:zatcaAction||coreAction,
      p_payload:body.payload||{}
    }));
  }catch(error){
    return json({error:message(error)},Number(error?.status)||500);
  }
}
