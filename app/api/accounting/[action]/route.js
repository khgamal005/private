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
  'classify-refund':'classify_refund',
  'approve-refund':'approve_refund',
  'reject-refund':'reject_refund',
  'complete-refund':'complete_refund',
  'save-settings':'save_settings',
  'import-handoff-payment':'import_handoff_payment',
  'preview-governance':'preview_governance',
  'set-governance':'set_governance',
  'apply-customer-credit':'apply_customer_credit',
  'review-incentive-adjustment':'review_incentive_adjustment'
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
    refund_self_approval_forbidden:'يجب أن يعتمد الطلب شخص مخول غير مقدمه.',
    refund_effect_required:'حدد أثر الاسترداد على التسجيل أو الرصيد.',
    refund_not_classifiable:'يمكن تعديل تصنيف طلب الاسترداد قبل اكتماله فقط.',
    refund_changed_retry:'تغيّر ربط طلب الاسترداد أثناء التنفيذ. حدّث البيانات وراجع الطلب ثم أعد المحاولة.',
    refund_handoff_required:'حدد التسجيل المرتبط بالإلغاء.',
    refund_handoff_mismatch:'التسجيل لا يرتبط بهذه الدفعة.',
    refund_invoice_required:'اختر الفاتورة التي سيخفض الاسترداد تحصيلها.',
    refund_invoice_allocation_required:'هذه الدفعة غير موزعة على الفاتورة المختارة.',
    refund_exceeds_invoice_allocation:'المبلغ يتجاوز نصيب هذه الفاتورة من الدفعة بعد الاستردادات السابقة والمعلقة.',
    refund_linked_credit_note_required:'يلزم إشعار دائن صادر مرتبط بالفاتورة ويغطي مبلغ الاسترداد.',
    refund_execution_reference_required:'أدخل مرجع تنفيذ رد المبلغ قبل إتمامه.',
    completed_training_requires_reversal_review:'التدريب المكتمل يحتاج مراجعة أكاديمية مستقلة. يمكن رد فرق السعر مع حفظ إكمال التدريب.',
    allocation_currency_mismatch:'عملة الدفعة لا تطابق عملة الفاتورة.',
    tenant_currency_mismatch:'استخدم عملة المنشأة المعتمدة.',
    verified_payment_immutable:'الدفع المتحقق محفوظ؛ صححه بتسوية موثقة.',
    credit_exceeds_available:'المبلغ يتجاوز الرصيد المتاح أو المتبقي على الفاتورة.',
    credit_target_invalid:'اختر فاتورة صادرة لنفس صاحب الرصيد وعملته.',
    credit_note_parent_invalid:'اربط الإشعار بفاتورة صادرة لنفس العميل والعملة.',
    credit_note_exceeds_invoice:'إجمالي الإشعارات الدائنة يتجاوز قيمة الفاتورة الأصلية.',
    command_id_required:'حدّث الصفحة لتجهيز معرف العملية.',
    governance_confirmation_required:'راجع المعاينة ثم أكد التفعيل.',
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
