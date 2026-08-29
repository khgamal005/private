import {NextResponse} from 'next/server';
import {
  SupportHttpError,
  failure,
  isoTimestamp,
  jsonBody,
  oneOf,
  plainObject,
  sameOrigin,
  sessionToken,
  slug,
  supportRpc,
  text,
  uuid
} from '../../_shared';

const ACTIONS=new Map([
  ['create_ticket','create_ticket'],['create','create_ticket'],
  ['add_message','add_message'],['reply','add_message'],
  ['mark_read','mark_read'],
  ['reopen_ticket','reopen_ticket'],['reopen','reopen_ticket'],
  ['close_ticket','close_ticket'],['confirm_resolution','close_ticket']
]);
const IMPACTS=new Set(['blocked','multiple_users','single_user','minor','question','security']);
const MODULES=new Set([
  'login_access','dashboard','tasks_calendar','courses','sales_crm','admissions',
  'marketing_automation','accounting','team_permissions','reports','website',
  'integrations','addons_marketplace','performance','other'
]);

export async function POST(request,{params}){
  try{
    if(!sameOrigin(request))return failure('forbidden',403);
    const {action}=await params;
    const supportAction=ACTIONS.get(action);
    if(!supportAction)return failure('invalid_support_action',404);
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const body=await jsonBody(request);
    const payload=tenantPayload(supportAction,plainObject(body.payload),body.ticketId);
    const result=await supportRpc(token,'v3_tenant_support_action',{
      p_slug:slug(body.slug),
      p_action:supportAction,
      p_payload:payload
    });
    return NextResponse.json({success:true,data:result},{
      headers:{'cache-control':'no-store'}
    });
  }catch(error){
    if(error instanceof SupportHttpError)return failure(error.code,error.status);
    console.error('[tenant-support-route-failure]',{errorName:error instanceof Error?error.name:'UnknownError'});
    return failure('support_request_failed',500);
  }
}

function tenantPayload(action,value,outerTicketId){
  const ticketId=uuid(value.ticketId||outerTicketId,{required:action!=='create_ticket'});
  const needsVersion=!['create_ticket','mark_read'].includes(action);
  const expectedVersion=value.expectedVersion===undefined
    ?null:Number(value.expectedVersion);
  if((needsVersion&&expectedVersion===null)
     ||(expectedVersion!==null&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<1))){
    throw new SupportHttpError('invalid_number');
  }
  if(action==='create_ticket'){
    const sourceUrl=safeSourceUrl(value.sourceUrl||value.diagnostics?.sourceUrl);
    return {
      title:text(value.title,{required:true,min:4,max:180}),
      description:text(value.description,{required:true,min:10,max:12000}),
      moduleKey:oneOf(value.moduleKey,MODULES,{required:true}),
      impact:oneOf(value.impact,IMPACTS,{required:true}),
      priority:oneOf(value.priority,new Set(['urgent','high','medium','low'])),
      diagnostics:{
        reproductionSteps:text(value.reproductionSteps||value.diagnostics?.reproductionSteps,{max:8000}),
        expectedResult:text(value.expectedResult||value.diagnostics?.expectedResult,{max:5000}),
        actualResult:text(value.actualResult||value.diagnostics?.actualResult,{max:5000}),
        sourceUrl,
        browserContext:browserContext(
          value.browserContext||value.diagnostics?.browserContext,
          sourceUrl
        )
      },
      clientRequestId:uuid(value.clientRequestId,{required:true})
    };
  }
  if(action==='add_message')return {
    ticketId,
    content:text(value.content||value.body,{required:true,min:1,max:12000}),
    clientRequestId:uuid(value.clientRequestId,{required:true}),
    expectedVersion
  };
  if(action==='mark_read')return {
    ticketId,
    readThrough:isoTimestamp(value.readThrough)
  };
  if(action==='reopen_ticket')return {
    ticketId,
    reason:text(value.reason,{required:true,min:3,max:4000}),
    clientRequestId:uuid(value.clientRequestId,{required:true}),
    expectedVersion
  };
  if(action==='close_ticket')return {
    ticketId,
    note:text(value.note,{max:4000}),
    clientRequestId:uuid(value.clientRequestId,{required:true}),
    expectedVersion
  };
  return {ticketId};
}

function safeSourceUrl(value){
  const normalized=text(value,{max:1000});
  if(!normalized)return null;
  try{
    const parsed=new URL(normalized);
    return ['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password
      ?`${parsed.origin}${parsed.pathname}`:null;
  }catch{return null;}
}

function browserContext(value,sourceUrl){
  const source=plainObject(value);
  return {
    appVersion:text(source.appVersion,{max:120}),
    route:safeRoute(source.route,sourceUrl),
    browser:text(source.browser||source.userAgent,{max:120}),
    operatingSystem:text(source.operatingSystem||source.platform,{max:120}),
    locale:text(source.locale||source.language,{max:40}),
    timezone:text(source.timezone,{max:80})
  };
}

function safeRoute(value,sourceUrl){
  for(const candidate of [value,sourceUrl]){
    const normalized=text(candidate,{max:1500});
    if(!normalized)continue;
    try{
      const parsed=new URL(normalized,'https://support.invalid');
      return parsed.pathname.slice(0,500)||'/';
    }catch{
      continue;
    }
  }
  return null;
}