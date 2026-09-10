import {NextResponse} from 'next/server';
import {accessToken} from '../../../../lib/server-auth';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN=/^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SEARCH_DIGITS=/[0-9\u0660-\u0669\u06f0-\u06f9]/g;
const SEARCH_LETTERS=/\p{L}/gu;
const FILTERS=new Set([
  'all',
  'awaiting_payment',
  'payment_submitted',
  'very_interested',
  'excellent',
  'unqualified',
  'overdue',
  'closed',
  'paid'
]);
const NO_STORE={'Cache-Control':'private, no-store, max-age=0'};

function json(body,status=200,headers={}){
  return NextResponse.json(body,{
    status,
    headers:{...NO_STORE,...headers}
  });
}

function validSlug(value){
  return typeof value==='string'
    &&value.length<=64
    &&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function validDate(value){
  if(!value)return null;
  if(!DATE_PATTERN.test(value))return false;
  const parsed=new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime())
    &&parsed.toISOString().slice(0,10)===value
    ?value
    :false;
}

function validInstant(value){
  if(!value)return null;
  if(value.length>40)return false;
  const match=INSTANT_PATTERN.exec(value);
  if(!match)return false;
  const [,yearValue,monthValue,dayValue,hourValue,minuteValue,
    secondValue,,offsetHourValue,offsetMinuteValue]=match;
  const year=Number(yearValue);
  const month=Number(monthValue);
  const day=Number(dayValue);
  const hour=Number(hourValue);
  const minute=Number(minuteValue);
  const second=Number(secondValue);
  const offsetHour=Number(offsetHourValue||0);
  const offsetMinute=Number(offsetMinuteValue||0);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  if(
    year<1
    ||month<1
    ||month>12
    ||day<1
    ||day>days[month-1]
    ||hour>23
    ||minute>59
    ||second>59
    ||offsetHour>14
    ||offsetMinute>59
    ||(offsetHour===14&&offsetMinute!==0)
  )return false;
  const parsed=new Date(value);
  return Number.isNaN(parsed.getTime())?false:value;
}

function nonNegativeInteger(value){
  return Number.isSafeInteger(value)&&value>=0;
}

function validSnapshotPayload(payload,expectedLimit){
  const viewer=payload?.viewer;
  const summary=payload?.summary;
  const pagination=payload?.pagination;
  const pipelineCounts=pagination?.pipelineCounts;
  const nextCursor=pagination?.nextCursor;
  const summaryKeys=[
    'activeLeads',
    'awaitingPayment',
    'paymentSubmitted',
    'veryInterested',
    'excellentLeads',
    'unqualifiedLeads',
    'paidThisMonth',
    'overdueFollowups'
  ];
  const pipelineKeys=['new','interested','very_interested','awaiting_payment'];
  const auxiliaryKeys=[
    'activities',
    'registrationHandoffs',
    'staff',
    'courses',
    'courseRuns'
  ];
  const validRecordArray=key=>Array.isArray(payload?.[key])
    &&payload[key].every(item=>Boolean(
      item
      &&typeof item==='object'
      &&UUID_PATTERN.test(item.id)
    ));
  const validCursor=nextCursor===null||Boolean(
    nextCursor
    &&UUID_PATTERN.test(nextCursor.id)
    &&validInstant(nextCursor.createdAt)
    &&typeof nextCursor.nextActionIsNull==='boolean'
    &&(
      nextCursor.nextActionIsNull
        ?nextCursor.nextActionAt===null
        :Boolean(validInstant(nextCursor.nextActionAt))
    )
  );

  return Boolean(
    payload
    &&payload.schemaVersion==='tenant-sales-workspace-v1'
    &&typeof payload.generatedAt==='string'
    &&validInstant(payload.generatedAt)
    &&typeof payload.timezone==='string'
    &&payload.timezone.length>0
    &&viewer
    &&(viewer.staffId===null||UUID_PATTERN.test(viewer.staffId))
    &&typeof viewer.viewTeam==='boolean'
    &&typeof viewer.canWriteCrm==='boolean'
    &&typeof viewer.canReassign==='boolean'
    &&summary
    &&summaryKeys.every(key=>nonNegativeInteger(summary[key]))
    &&validRecordArray('contacts')
    &&pagination
    &&pagination.limit===expectedLimit
    &&nonNegativeInteger(pagination.total)
    &&nonNegativeInteger(pagination.returned)
    &&pagination.returned===payload.contacts.length
    &&pagination.returned<=expectedLimit
    &&typeof pagination.hasMore==='boolean'
    &&pipelineCounts
    &&pipelineKeys.every(key=>nonNegativeInteger(pipelineCounts[key]))
    &&validCursor
    &&(!pagination.hasMore||nextCursor!==null)
    &&(pagination.hasMore||nextCursor===null)
    &&typeof payload.auxiliaryIncluded==='boolean'
    &&auxiliaryKeys.every(validRecordArray)
    &&(
      payload.focusedContact===null
      ||Boolean(
        payload.focusedContact
        &&typeof payload.focusedContact==='object'
        &&UUID_PATTERN.test(payload.focusedContact.id)
      )
    )
  );
}

function requestId(response){
  return response.headers.get('sb-request-id')
    ||response.headers.get('x-request-id')
    ||response.headers.get('cf-ray')
    ||null;
}

function translatedError(message,status){
  const value=String(message||'');
  if(status===401)return ['انتهت الجلسة',401,'session_expired',false];
  if(status===403||value.includes('forbidden')){
    return ['ليس لديك صلاحية لعرض بيانات المبيعات',403,'forbidden',false];
  }
  if(value.includes('tenant_not_found')){
    return ['المنشأة غير موجودة',404,'tenant_not_found',false];
  }
  if(value.includes('invalid_')){
    return ['معايير عرض العملاء غير صالحة',400,'invalid_request',false];
  }
  if(status===429){
    return ['الخدمة مشغولة مؤقتًا، حاول مرة أخرى',429,'rate_limited',true];
  }
  return ['تعذر تحميل بيانات المبيعات الآن',503,'sales_read_unavailable',true];
}

export async function GET(request){
  const token=await accessToken();
  if(!token){
    return json({
      error:'انتهت الجلسة',
      code:'session_expired',
      retryable:false
    },401);
  }

  const params=new URL(request.url).searchParams;
  const slug=params.get('slug');
  const filter=params.get('filter')||'all';
  const query=String(params.get('q')||'').trim();
  const limitValue=params.get('limit')||'80';
  const limit=Number(limitValue);
  const from=validDate(params.get('from'));
  const to=validDate(params.get('to'));
  const focusContactId=params.get('contact')||null;
  const includeAuxiliaryValue=params.get('includeAuxiliary')||'false';
  const afterId=params.get('afterId')||null;
  const afterCreatedAt=validInstant(params.get('afterCreatedAt'));
  const afterNextActionAt=validInstant(params.get('afterNextActionAt'));
  const afterNextActionIsNullValue=params.get('afterNextActionIsNull');
  const afterNextActionIsNull=afterNextActionIsNullValue==='true';
  const hasCursor=Boolean(afterId||afterCreatedAt||afterNextActionAt);

  if(!validSlug(slug)){
    return json({error:'معرّف المنشأة غير صالح',code:'invalid_slug'},400);
  }
  if(!FILTERS.has(filter)){
    return json({error:'مرشح العملاء غير صالح',code:'invalid_filter'},400);
  }
  if(query.length>100){
    return json({error:'نص البحث أطول من المسموح',code:'invalid_query'},400);
  }
  const queryDigits=(query.match(SEARCH_DIGITS)||[]).length;
  const queryLetters=(query.match(SEARCH_LETTERS)||[]).length;
  if(query&&(
    (queryLetters===0&&queryDigits<3)
    ||(queryLetters>0&&queryLetters<2)
  )){
    return json({error:'اكتب حرفين أو ثلاثة أرقام على الأقل',code:'invalid_query'},400);
  }
  if(
    !Number.isInteger(limit)
    ||String(limit)!==limitValue
    ||limit<1
    ||limit>100
  ){
    return json({error:'حجم الصفحة غير صالح',code:'invalid_limit'},400);
  }
  if(from===false||to===false){
    return json({error:'نطاق التاريخ غير صالح',code:'invalid_date'},400);
  }
  if(from&&to){
    const fromTime=Date.parse(`${from}T00:00:00.000Z`);
    const toTime=Date.parse(`${to}T00:00:00.000Z`);
    if(toTime<fromTime||toTime-fromTime>366*24*60*60*1000){
      return json({error:'نطاق التاريخ غير صالح',code:'invalid_date'},400);
    }
  }
  if(focusContactId&&!UUID_PATTERN.test(focusContactId)){
    return json({error:'معرّف العميل غير صالح',code:'invalid_contact'},400);
  }
  if(!['true','false'].includes(includeAuxiliaryValue)){
    return json({error:'طلب بيانات المساندة غير صالح',code:'invalid_request'},400);
  }
  if(
    (afterId&&!UUID_PATTERN.test(afterId))
    ||afterCreatedAt===false
    ||afterNextActionAt===false
    ||(
      afterNextActionIsNullValue
      &&!['true','false'].includes(afterNextActionIsNullValue)
    )
    ||(afterNextActionIsNull&&!afterId)
    ||(hasCursor&&(!afterId||!afterCreatedAt))
    ||(hasCursor&&!afterNextActionIsNull&&!afterNextActionAt)
  ){
    return json({error:'مؤشر الصفحة غير صالح',code:'invalid_cursor'},400);
  }

  const startedAt=Date.now();
  try{
    const response=await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/v2_tenant_sales_workspace_snapshot`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          Authorization:`Bearer ${token}`,
          'Content-Type':'application/json'
        },
        body:JSON.stringify({
          p_slug:slug,
          p_limit:limit,
          p_query:query||null,
          p_filter:filter,
          p_from:from||null,
          p_to:to||null,
          p_focus_contact_id:focusContactId,
          p_include_auxiliary:includeAuxiliaryValue==='true',
          p_after_next_action_at:afterNextActionIsNull
            ?null
            :afterNextActionAt,
          p_after_created_at:afterCreatedAt||null,
          p_after_id:afterId,
          p_after_next_action_is_null:afterNextActionIsNull
        }),
        cache:'no-store',
        signal:AbortSignal.timeout(4500)
      }
    );
    const rpcRequestId=requestId(response);
    const text=await response.text();
    let payload;
    try{
      payload=JSON.parse(text);
    }catch{
      payload={message:'invalid_response'};
    }

    if(response.ok&&validSnapshotPayload(payload,limit)){
      return json({data:payload});
    }
    if(response.ok){
      console.error('[tenant-sales-workspace-invalid-response]',{
        status:response.status,
        durationMs:Date.now()-startedAt,
        requestId:rpcRequestId
      });
      return json({
        error:'تعذر تحميل بيانات المبيعات الآن',
        code:'sales_read_invalid_response',
        retryable:true,
        requestId:rpcRequestId
      },503,{'Retry-After':'2'});
    }

    const [error,status,code,retryable]=translatedError(
      payload?.message||payload?.error,
      response.status
    );
    console.error('[tenant-sales-workspace-read-failed]',{
      status:response.status,
      durationMs:Date.now()-startedAt,
      requestId:rpcRequestId
    });
    return json(
      {error,code,retryable,requestId:rpcRequestId},
      status,
      retryable?{'Retry-After':'2'}:{}
    );
  }catch(error){
    const timeout=error instanceof Error
      &&['TimeoutError','AbortError'].includes(error.name);
    console.error('[tenant-sales-workspace-read-failed]',{
      status:timeout?504:503,
      durationMs:Date.now()-startedAt,
      requestId:null,
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return json({
      error:'تعذر تحميل بيانات المبيعات الآن',
      code:timeout?'sales_read_timeout':'sales_read_unavailable',
      retryable:true,
      requestId:null
    },timeout?504:503,{'Retry-After':'2'});
  }
}
