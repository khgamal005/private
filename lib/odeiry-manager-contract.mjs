import {OdeiryContractError} from './odeiry-contract.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MEMORY_KEY=/^[a-z][a-z0-9_.-]{2,119}$/;
const ISO_TIMESTAMP=/^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const MANAGER_ACTIONS=new Set(['workspace','thread','review_memory']);
const MEMORY_DECISIONS=new Set(['approve','reject','archive']);
const THREAD_STATUSES=new Set(['active','archived']);
const MESSAGE_ROLES=new Set(['user','assistant']);
const MEMORY_CATEGORIES=new Set([
  'goal','preference','constraint','operating_principle','decision_context'
]);
const MEMORY_STATUSES=new Set(['proposed','approved','rejected','archived']);

const BASE_KEYS=new Set(['action','slug']);
const THREAD_KEYS=new Set([...BASE_KEYS,'threadId']);
const REVIEW_KEYS=new Set([
  ...BASE_KEYS,'memoryId','decision','expectedVersion','clientRequestId'
]);

export function parseOdeiryManagerRequest(value){
  const source=record(value,'odeiry_manager_payload_invalid');
  const action=boundedString(source.action,{
    code:'odeiry_manager_action_invalid',required:true,maxCharacters:32
  });
  if(!MANAGER_ACTIONS.has(action)){
    throw new OdeiryContractError('odeiry_manager_action_invalid');
  }

  rejectUnknownKeys(
    source,
    action==='workspace'?BASE_KEYS:action==='thread'?THREAD_KEYS:REVIEW_KEYS
  );

  const slug=boundedString(source.slug,{
    code:'odeiry_manager_slug_invalid',required:true,maxCharacters:100
  }).toLowerCase();
  if(!SLUG.test(slug)){
    throw new OdeiryContractError('odeiry_manager_slug_invalid');
  }

  if(action==='workspace')return {action,slug};
  if(action==='thread')return {
    action,
    slug,
    threadId:uuid(source.threadId,'odeiry_manager_thread_id_invalid')
  };

  const decision=boundedString(source.decision,{
    code:'odeiry_manager_memory_action_invalid',required:true,maxCharacters:16
  });
  if(!MEMORY_DECISIONS.has(decision)){
    throw new OdeiryContractError('odeiry_manager_memory_action_invalid');
  }
  return {
    action,
    slug,
    memoryId:uuid(source.memoryId,'odeiry_manager_memory_id_invalid'),
    decision,
    expectedVersion:positiveInteger(
      source.expectedVersion,
      'odeiry_manager_expected_version_invalid'
    ),
    clientRequestId:uuid(
      source.clientRequestId,
      'odeiry_manager_client_request_id_invalid'
    )
  };
}

export function parseOdeiryManagerCapability(value){
  if(!isRecord(value))return failClosedCapability();
  const mode=['tenant_member','platform_operator'].includes(value.mode)
    ?value.mode:null;
  const manager=isRecord(value.manager)?value.manager:{};
  const allowed=mode==='tenant_member'&&manager.allowed===true;
  const globalEnabled=manager.globalEnabled===true;
  const enabled=manager.enabled===true;
  const reviewAvailable=allowed&&manager.reviewAvailable===true;
  return {
    mode,
    allowed,
    globalEnabled,
    enabled,
    reviewAvailable,
    available:value.available===true
      &&value.enabled===true
      &&allowed
      &&globalEnabled
      &&enabled
      &&manager.available===true
  };
}

export function parseOdeiryManagerWorkspaceResult(value){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const memorySource=isRecord(source.memories)
    ?source.memories
    :isRecord(source.memory)?source.memory:{};
  const pending=memoryList(memorySource.pending,'proposed',50);
  const approved=memoryList(memorySource.approved,'approved',100);
  const archived=memoryList(memorySource.archived,'archived',20);
  return {
    schemaVersion:schemaVersion(source.schemaVersion),
    generatedAt:timestamp(source.generatedAt,'odeiry_manager_response_invalid'),
    threads:threadList(source.threads),
    memories:{pending,approved,archived},
    pendingCount:pending.length
  };
}

export function parseOdeiryManagerThreadResult(value){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const messages=array(source.messages,'odeiry_manager_response_invalid',40)
    .map(item=>message(item));
  return {
    schemaVersion:schemaVersion(source.schemaVersion),
    thread:thread(source.thread),
    messages
  };
}

export function parseOdeiryManagerMemoryActionResult(value,expected={}){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const action=boundedString(source.action,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:16,status:502
  });
  if(!MEMORY_DECISIONS.has(action))responseInvalid();
  const memoryId=uuid(
    source.memoryId,
    'odeiry_manager_response_invalid',
    502
  );
  const status=boundedString(source.status,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:16,status:502
  });
  if(!MEMORY_STATUSES.has(status))responseInvalid();
  if(typeof source.idempotent!=='boolean')responseInvalid();
  const result={
    action,
    memoryId,
    status,
    version:positiveInteger(
      source.version,
      'odeiry_manager_response_invalid',
      502
    ),
    idempotent:source.idempotent
  };
  if(expected.action&&result.action!==expected.action)responseInvalid();
  if(expected.memoryId&&result.memoryId!==expected.memoryId)responseInvalid();
  return result;
}

function threadList(value){
  return array(value,'odeiry_manager_response_invalid',20).map(item=>thread(item));
}

function thread(value){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const status=boundedString(source.status,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:16,status:502
  });
  if(!THREAD_STATUSES.has(status))responseInvalid();
  return {
    threadId:uuid(source.threadId,'odeiry_manager_response_invalid',502),
    title:nullableString(source.title,160),
    status,
    version:positiveInteger(
      source.version,
      'odeiry_manager_response_invalid',
      502
    ),
    lastMessageAt:nullableTimestamp(source.lastMessageAt),
    createdAt:timestamp(source.createdAt,'odeiry_manager_response_invalid')
  };
}

function message(value){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const role=boundedString(source.role,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:16,status:502
  });
  if(!MESSAGE_ROLES.has(role))responseInvalid();
  return {
    messageId:uuid(source.messageId,'odeiry_manager_response_invalid',502),
    role,
    content:boundedString(source.content,{
      code:'odeiry_manager_response_invalid',required:true,
      maxCharacters:6000,maxBytes:18*1024,status:502
    }),
    createdAt:timestamp(source.createdAt,'odeiry_manager_response_invalid')
  };
}

function memoryList(value,defaultStatus,maxItems){
  return array(value,'odeiry_manager_response_invalid',maxItems)
    .map(item=>memory(item,defaultStatus));
}

function memory(value,defaultStatus){
  const source=record(value,'odeiry_manager_response_invalid',502);
  const category=boundedString(source.category,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:32,status:502
  });
  if(!MEMORY_CATEGORIES.has(category))responseInvalid();
  const status=source.status===undefined
    ?defaultStatus
    :boundedString(source.status,{
      code:'odeiry_manager_response_invalid',required:true,
      maxCharacters:16,status:502
    });
  if(!MEMORY_STATUSES.has(status))responseInvalid();
  const memoryKey=boundedString(source.memoryKey,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters:120,status:502
  });
  if(!MEMORY_KEY.test(memoryKey))responseInvalid();
  return {
    memoryId:uuid(source.memoryId,'odeiry_manager_response_invalid',502),
    memoryKey,
    category,
    statement:boundedString(source.statement,{
      code:'odeiry_manager_response_invalid',required:true,
      maxCharacters:240,maxBytes:1200,status:502
    }),
    reason:nullableString(source.reason,300),
    status,
    version:positiveInteger(
      source.version,
      'odeiry_manager_response_invalid',
      502
    ),
    createdAt:timestamp(source.createdAt,'odeiry_manager_response_invalid'),
    reviewedAt:nullableTimestamp(source.reviewedAt),
    expiresAt:nullableTimestamp(source.expiresAt)
  };
}

function failClosedCapability(){
  return {
    mode:null,allowed:false,globalEnabled:false,
    enabled:false,reviewAvailable:false,available:false
  };
}

function schemaVersion(value){
  if(value!==1)responseInvalid();
  return 1;
}

function positiveInteger(value,code,status=400){
  if(!Number.isSafeInteger(value)||value<1||value>2147483647){
    throw new OdeiryContractError(code,status);
  }
  return value;
}

function uuid(value,code,status=400){
  const normalized=String(value??'').trim().toLowerCase();
  if(!UUID.test(normalized))throw new OdeiryContractError(code,status);
  return normalized;
}

function timestamp(value,code){
  const normalized=String(value??'').trim();
  const match=normalized.length<=40?ISO_TIMESTAMP.exec(normalized):null;
  const calendarDate=match?`${match[1]}-${match[2]}-${match[3]}`:null;
  const parsed=match?Date.parse(normalized):Number.NaN;
  const parsedCalendar=calendarDate
    ?Date.parse(`${calendarDate}T00:00:00Z`):Number.NaN;
  if(!match||!Number.isFinite(parsed)||!Number.isFinite(parsedCalendar)
     ||new Date(parsedCalendar).toISOString().slice(0,10)!==calendarDate){
    throw new OdeiryContractError(code,502);
  }
  return new Date(parsed).toISOString();
}

function nullableTimestamp(value){
  if(value===null||value===undefined||value==='')return null;
  return timestamp(value,'odeiry_manager_response_invalid');
}

function nullableString(value,maxCharacters){
  if(value===null||value===undefined||value==='')return null;
  return boundedString(value,{
    code:'odeiry_manager_response_invalid',required:true,
    maxCharacters,status:502
  });
}

function boundedString(value,{
  code,required=false,maxCharacters=4000,
  maxBytes=Number.MAX_SAFE_INTEGER,status=400
}){
  if(typeof value!=='string'){
    if(!required&&(value===null||value===undefined))return '';
    throw new OdeiryContractError(code,status);
  }
  const normalized=value.trim();
  if((required&&!normalized)||[...normalized].length>maxCharacters){
    throw new OdeiryContractError(code,status);
  }
  if(new TextEncoder().encode(normalized).byteLength>maxBytes){
    throw new OdeiryContractError(code,status);
  }
  return normalized;
}

function array(value,code,maxItems){
  if(!Array.isArray(value)||value.length>maxItems){
    throw new OdeiryContractError(code,502);
  }
  return value;
}

function record(value,code,status=400){
  if(!isRecord(value))throw new OdeiryContractError(code,status);
  return value;
}

function isRecord(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function rejectUnknownKeys(source,allowed){
  if(Object.keys(source).some(key=>!allowed.has(key))){
    throw new OdeiryContractError('odeiry_manager_payload_invalid');
  }
}

function responseInvalid(){
  throw new OdeiryContractError('odeiry_manager_response_invalid',502);
}
