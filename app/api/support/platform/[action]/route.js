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
  supportRpc,
  text,
  uuid
} from '../../_shared';

const ACTIONS=new Map([
  ['add_message','add_message'],['reply','add_message'],
  ['add_internal_note','add_internal_note'],['internal_note','add_internal_note'],
  ['assign_ticket','assign_ticket'],['assign','assign_ticket'],
  ['update_ticket','update_ticket'],['set_status','update_ticket'],['set_priority','update_ticket'],
  ['mark_read','mark_read']
]);
const STATUSES=new Set([
  'new','triage','in_progress','waiting_tenant','waiting_external',
  'resolved','closed','reopened'
]);
const PRIORITIES=new Set(['urgent','high','medium','low']);

export async function POST(request,{params}){
  try{
    if(!sameOrigin(request))return failure('forbidden',403);
    const {action}=await params;
    const supportAction=ACTIONS.get(action);
    if(!supportAction)return failure('invalid_support_action',404);
    const token=await sessionToken();
    if(!token)return failure('authentication_required',401);
    const body=await jsonBody(request);
    const result=await supportRpc(token,'v3_platform_support_action',{
      p_action:supportAction,
      p_payload:platformPayload(supportAction,plainObject(body.payload),body.ticketId,action)
    });
    return NextResponse.json({success:true,data:result},{
      headers:{'cache-control':'no-store'}
    });
  }catch(error){
    if(error instanceof SupportHttpError)return failure(error.code,error.status);
    console.error('[platform-support-route-failure]',{errorName:error instanceof Error?error.name:'UnknownError'});
    return failure('support_request_failed',500);
  }
}

function platformPayload(action,value,outerTicketId,routeAction){
  const ticketId=uuid(value.ticketId||outerTicketId,{required:true});
  const needsVersion=action!=='mark_read';
  const expectedVersion=value.expectedVersion===undefined
    ?null:Number(value.expectedVersion);
  if((needsVersion&&expectedVersion===null)
     ||(expectedVersion!==null&&(!Number.isSafeInteger(expectedVersion)||expectedVersion<1))){
    throw new SupportHttpError('invalid_number');
  }
  if(action==='add_message'||action==='add_internal_note')return {
    ticketId,
    content:text(value.content||value.body,{required:true,min:1,max:12000}),
    clientRequestId:uuid(value.clientRequestId,{required:true}),
    expectedVersion
  };
  if(action==='assign_ticket')return {
    ticketId,
    assigneeSubjectId:uuid(value.assigneeSubjectId),
    clientRequestId:uuid(value.clientRequestId,{required:true}),
    expectedVersion
  };
  if(action==='update_ticket'){
    const payload={
      ticketId,
      clientRequestId:uuid(value.clientRequestId,{required:true}),
      expectedVersion
    };
    if(Object.hasOwn(value,'status')||routeAction==='set_status'){
      payload.status=oneOf(value.status,STATUSES,{required:true});
    }
    if(Object.hasOwn(value,'priority')||routeAction==='set_priority'){
      payload.priority=oneOf(value.priority,PRIORITIES,{required:true});
    }
    if(Object.hasOwn(value,'moduleKey')){
      payload.moduleKey=text(value.moduleKey,{required:true,max:80});
    }
    if(Object.hasOwn(value,'impact')){
      payload.impact=text(value.impact,{required:true,max:40});
    }
    if(Object.hasOwn(value,'resolutionSummary')){
      payload.resolutionSummary=text(value.resolutionSummary,{max:4000});
    }
    if(Object.hasOwn(value,'assigneeSubjectId')){
      payload.assigneeSubjectId=uuid(value.assigneeSubjectId);
    }
    return payload;
  }
  if(action==='mark_read')return {
    ticketId,
    readThrough:isoTimestamp(value.readThrough)
  };
  return {ticketId};
}