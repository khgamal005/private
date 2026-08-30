const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SAFE_PATH_CLASS=/^workspace\.[a-z_]+$/;
const CONTROL_CHARACTERS=/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const KNOWLEDGE_ARTICLE_KEY=/^[a-z][a-z0-9_.-]{2,119}$/;

export const ODEIRY_JSON_LIMIT=16*1024;
export const ODEIRY_MESSAGE_MAX_CHARACTERS=4000;
export const ODEIRY_MESSAGE_MAX_BYTES=12*1024;
export const ODEIRY_HISTORY_MAX_BYTES=16*1024;
export const ODEIRY_MAX_TURNS=3;
export const ODEIRY_RATE_LIMIT=8;
export const ODEIRY_RATE_WINDOW_MS=60*1000;
export const ODEIRY_MODEL='gpt-5.6-luna';
export const ODEIRY_ALLOWED_MODELS=new Set([
  'gpt-5.6-luna','gpt-5.6-terra'
]);

export const ODEIRY_MODULES=new Set([
  'login_access','dashboard','tasks_calendar','courses','sales_crm','admissions',
  'marketing_automation','accounting','team_permissions','reports','website',
  'integrations','addons_marketplace','performance','support','other'
]);

const REQUEST_KEYS=new Set([
  'slug','message','clientRequestId','threadId','context'
]);
const TICKET_LINK_KEYS=new Set([
  'slug','runId','ticketId','clientRequestId'
]);
const CONTEXT_KEYS=new Set(['module','pathClass']);

export const ODEIRY_PATH_CLASSES=new Map([
  ['workspace.support','support'],
  ['workspace.dashboard','dashboard'],
  ['workspace.tasks_calendar','tasks_calendar'],
  ['workspace.courses','courses'],
  ['workspace.sales_crm','sales_crm'],
  ['workspace.admissions','admissions'],
  ['workspace.marketing_automation','marketing_automation'],
  ['workspace.accounting','accounting'],
  ['workspace.team_permissions','team_permissions'],
  ['workspace.reports','reports'],
  ['workspace.website','website'],
  ['workspace.integrations','integrations'],
  ['workspace.addons_marketplace','addons_marketplace'],
  ['workspace.performance','performance'],
  ['workspace.other','other']
]);

export class OdeiryContractError extends Error{
  constructor(code,status=400){
    super(code);
    this.name='OdeiryContractError';
    this.code=code;
    this.status=status;
  }
}

export function parseOdeiryRequest(value){
  const source=record(value,'odeiry_payload_invalid');
  rejectUnknownKeys(source,REQUEST_KEYS);

  const slug=boundedString(source.slug,{
    code:'odeiry_slug_invalid',required:true,maxCharacters:100
  }).toLowerCase();
  if(!SLUG.test(slug))throw new OdeiryContractError('odeiry_slug_invalid');

  const message=boundedString(source.message,{
    code:'odeiry_message_invalid',required:true,minCharacters:2,
    maxCharacters:ODEIRY_MESSAGE_MAX_CHARACTERS,
    maxBytes:ODEIRY_MESSAGE_MAX_BYTES
  });
  if(CONTROL_CHARACTERS.test(message)){
    throw new OdeiryContractError('odeiry_message_invalid');
  }

  const clientRequestId=parseUuid(
    source.clientRequestId,
    'odeiry_client_request_id_invalid',
    true
  );
  const threadId=parseUuid(source.threadId,'odeiry_thread_id_invalid',false);
  const context=parseRequestContext(source.context);

  return {
    slug,
    message,
    clientRequestId,
    threadId,
    context:classifyOdeiryContext(context,slug)
  };
}

export function parseOdeiryTicketLinkRequest(value){
  const source=record(value,'odeiry_payload_invalid');
  rejectUnknownKeys(source,TICKET_LINK_KEYS);
  const slug=boundedString(source.slug,{
    code:'odeiry_slug_invalid',required:true,maxCharacters:100
  }).toLowerCase();
  if(!SLUG.test(slug))throw new OdeiryContractError('odeiry_slug_invalid');
  return {
    slug,
    runId:parseUuid(source.runId,'odeiry_run_id_invalid',true),
    ticketId:parseUuid(source.ticketId,'odeiry_ticket_id_invalid',true),
    clientRequestId:parseUuid(
      source.clientRequestId,
      'odeiry_client_request_id_invalid',
      true
    )
  };
}

export function classifyOdeiryContext(value,_slug){
  const context=value||{module:null,pathClass:null};
  if(!context.pathClass){
    return {module:context.module||null,pathClass:null};
  }
  const inferred=ODEIRY_PATH_CLASSES.get(context.pathClass);
  if(!inferred)throw new OdeiryContractError('odeiry_context_invalid');
  if(context.module&&context.module!==inferred){
    throw new OdeiryContractError('odeiry_context_invalid');
  }
  return {
    module:inferred,
    pathClass:context.pathClass
  };
}

export function resolveOdeiryModel(value){
  const model=String(value||'').trim()||ODEIRY_MODEL;
  if(!ODEIRY_ALLOWED_MODELS.has(model)){
    throw new OdeiryContractError('odeiry_model_invalid',500);
  }
  return model;
}

export function parseOdeirySnapshot(value){
  const source=record(value,'odeiry_snapshot_invalid');
  return {
    available:source.available===true,
    enabled:source.enabled===true,
    mode:typeof source.mode==='string'?source.mode:null
  };
}

export function parseOdeiryStartResult(value){
  const source=record(value,'odeiry_start_result_invalid',502);
  const status=boundedString(source.status,{
    code:'odeiry_start_result_invalid',required:true,maxCharacters:32,status:502
  });
  if(!new Set(['reserved','running','completed','failed','cancelled']).has(status)){
    throw new OdeiryContractError('odeiry_start_result_invalid',502);
  }
  const reservedUnits=Number(source.reservedUnits);
  if(!Number.isSafeInteger(reservedUnits)||reservedUnits<0||reservedUnits>10000){
    throw new OdeiryContractError('odeiry_start_result_invalid',502);
  }
  return {
    runId:parseUuid(source.runId,'odeiry_start_result_invalid',true,502),
    threadId:parseUuid(source.threadId,'odeiry_start_result_invalid',true,502),
    userMessageId:parseUuid(
      source.userMessageId||source.messageId,
      'odeiry_start_result_invalid',
      false,
      502
    ),
    status,
    reservedUnits,
    idempotent:source.idempotent===true,
    responseText:nullableBoundedString(source.responseText,6000),
    responseData:parseResponseData(source.responseData),
    contextMessages:parseContextMessages(source.contextMessages)
  };
}

export function estimateOdeiryUnits(message){
  const characters=codePointLength(String(message||''));
  return Math.min(10,Math.max(4,4+Math.ceil(characters/800)));
}

export function calculateOdeiryActualUnits(usage){
  const inputTokens=safeNonNegativeInteger(usage?.inputTokens);
  const outputTokens=safeNonNegativeInteger(usage?.outputTokens);
  return Math.max(1,Math.min(10000,Math.ceil((inputTokens+outputTokens*4)/1000)));
}

export function settleOdeiryUnits(usage,reservedUnits){
  const measured=calculateOdeiryActualUnits(usage);
  const reserved=safeNonNegativeInteger(reservedUnits);
  return {
    measured,
    settled:Math.min(measured,reserved)
  };
}

export function cachedInputTokens(usage){
  const details=Array.isArray(usage?.inputTokensDetails)
    ?usage.inputTokensDetails:[];
  return details.reduce((total,item)=>{
    if(!item||typeof item!=='object')return total;
    return total+Object.entries(item).reduce((sum,[key,value])=>{
      return /cached/i.test(key)?sum+safeNonNegativeInteger(value):sum;
    },0);
  },0);
}

export function reasoningTokens(usage){
  const details=Array.isArray(usage?.outputTokensDetails)
    ?usage.outputTokensDetails:[];
  return details.reduce((total,item)=>{
    if(!item||typeof item!=='object')return total;
    return total+Object.entries(item).reduce((sum,[key,value])=>{
      return /reasoning/i.test(key)?sum+safeNonNegativeInteger(value):sum;
    },0);
  },0);
}

export function normalizeOdeiryKnowledgeArticles(value){
  const candidates=Array.isArray(value)
    ?value
    :Array.isArray(value?.articles)
      ?value.articles
      :Array.isArray(value?.items)?value.items:[];
  return candidates.slice(0,6).map(item=>{
    const articleId=knowledgeText(
      item?.articleKey||item?.articleId||item?.id||item?.slug,
      120
    );
    return {
      articleId:KNOWLEDGE_ARTICLE_KEY.test(articleId)?articleId:'',
      title:knowledgeText(item?.title,180),
      moduleKey:ODEIRY_MODULES.has(String(item?.moduleKey||''))
        ?String(item.moduleKey):'other',
      content:knowledgeText(
        item?.content||item?.body||item?.excerpt||item?.summary,
        1200
      )
    };
  }).filter(item=>item.articleId&&item.title&&item.content);
}

export function replayOdeiryOutput(responseText){
  return {
    reply:nullableBoundedString(responseText,6000)
      ||'تمت معالجة هذا الطلب مسبقًا.',
    steps:[],
    suggestions:[],
    confidence:'medium',
    needsEscalation:false,
    escalationReason:null,
    sources:[],
    ticketDraft:null
  };
}

function parseRequestContext(value){
  if(value===null||value===undefined){
    return {module:null,pathClass:null};
  }
  const source=record(value,'odeiry_context_invalid');
  rejectUnknownKeys(source,CONTEXT_KEYS);
  const module=nullableBoundedString(source.module,80);
  if(module&&!ODEIRY_MODULES.has(module)){
    throw new OdeiryContractError('odeiry_module_invalid');
  }
  const pathClass=nullableBoundedString(source.pathClass,320);
  if(pathClass&&(
    !SAFE_PATH_CLASS.test(pathClass)
    ||pathClass.includes('?')
    ||pathClass.includes('#')
    ||pathClass.includes('%')
    ||pathClass.includes('\\')
  )){
    throw new OdeiryContractError('odeiry_context_invalid');
  }
  return {module,pathClass};
}

function parseContextMessages(value){
  if(value===null||value===undefined)return [];
  if(!Array.isArray(value)||value.length>12){
    throw new OdeiryContractError('odeiry_start_result_invalid',502);
  }
  const parsed=value.map(item=>{
    const source=record(item,'odeiry_start_result_invalid',502);
    const role=String(source.role||'').trim();
    if(!new Set(['user','assistant']).has(role)){
      throw new OdeiryContractError('odeiry_start_result_invalid',502);
    }
    const content=boundedString(source.content,{
      code:'odeiry_start_result_invalid',required:true,
      maxCharacters:4000,maxBytes:12*1024,status:502
    });
    return {role,content};
  });
  const retained=[];
  let retainedBytes=0;
  for(let index=parsed.length-1;index>=0;index-=1){
    const item=parsed[index];
    const itemBytes=new TextEncoder().encode(item.content).byteLength+32;
    if(retainedBytes+itemBytes>ODEIRY_HISTORY_MAX_BYTES)continue;
    retained.unshift(item);
    retainedBytes+=itemBytes;
  }
  return retained;
}

function parseResponseData(value){
  if(value===null||value===undefined)return null;
  const source=record(value,'odeiry_start_result_invalid',502);
  let serialized='';
  try{serialized=JSON.stringify(source);}catch{
    throw new OdeiryContractError('odeiry_start_result_invalid',502);
  }
  if(new TextEncoder().encode(serialized).byteLength>32*1024){
    throw new OdeiryContractError('odeiry_start_result_invalid',502);
  }
  return source;
}

function record(value,code,status=400){
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw new OdeiryContractError(code,status);
  }
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null){
    throw new OdeiryContractError(code,status);
  }
  return value;
}

function rejectUnknownKeys(source,allowed){
  if(Object.keys(source).some(key=>!allowed.has(key))){
    throw new OdeiryContractError('odeiry_payload_invalid');
  }
}

function parseUuid(value,code,required,status=400){
  const normalized=String(value??'').trim().toLowerCase();
  if(!normalized&&!required)return null;
  if(!UUID.test(normalized))throw new OdeiryContractError(code,status);
  return normalized;
}

function boundedString(value,{
  code,required=false,minCharacters=0,maxCharacters=4000,
  maxBytes=Number.MAX_SAFE_INTEGER,status=400
}){
  if(typeof value!=='string'){
    if(!required&&(value===null||value===undefined))return '';
    throw new OdeiryContractError(code,status);
  }
  const normalized=value.trim();
  const length=codePointLength(normalized);
  if((required&&!normalized)||length<minCharacters||length>maxCharacters){
    throw new OdeiryContractError(code,status);
  }
  if(new TextEncoder().encode(normalized).byteLength>maxBytes){
    throw new OdeiryContractError(code,status);
  }
  return normalized;
}

function nullableBoundedString(value,maxCharacters){
  if(value===null||value===undefined||value==='')return null;
  if(typeof value!=='string')return null;
  const normalized=value.trim();
  if(!normalized||codePointLength(normalized)>maxCharacters)return null;
  return normalized;
}

function codePointLength(value){
  return [...value].length;
}

function safeNonNegativeInteger(value){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=0?parsed:0;
}

function knowledgeText(value,maxCharacters){
  if(typeof value!=='string')return '';
  const normalized=value.trim();
  if(!normalized||CONTROL_CHARACTERS.test(normalized))return '';
  return [...normalized].slice(0,maxCharacters).join('');
}
