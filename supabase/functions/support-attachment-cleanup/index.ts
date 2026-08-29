import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CRON_SECRET_HEADER='x-odeir-support-cleanup-secret';
const CRON_SECRET_ENV='ODEIR_SUPPORT_ATTACHMENT_CLEANUP_SECRET';
const SUPPORT_BUCKET='support-attachments';
const BATCH_SIZE=50;
const MAX_BATCHES=4;
const MAX_ITEMS_PER_RUN=BATCH_SIZE*MAX_BATCHES;
const FINALIZE_CONCURRENCY=8;
const OPERATION_TIMEOUT_MS=25_000;
const UPSTREAM_TIMEOUT_MS=6_000;
const MAX_RESPONSE_BYTES=256*1024;

const UUID_PART='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID=new RegExp(`^${UUID_PART}$`,'i');
const OBJECT_PATH=new RegExp(
  `^${UUID_PART}/${UUID_PART}/${UUID_PART}/${UUID_PART}\\.(?:png|jpg|webp|gif|pdf|txt)$`,
  'i'
);

const JSON_HEADERS={
  'content-type':'application/json; charset=utf-8',
  'cache-control':'no-store, max-age=0',
  'x-content-type-options':'nosniff',
  'referrer-policy':'no-referrer'
};

type JsonRecord=Record<string,unknown>;
type CleanupItem={
  attachmentId:string;
  bucket:string;
  objectPath:string;
};
type CleanupSnapshot={
  items:CleanupItem[];
  hasMore:boolean;
};
type CleanupResult={
  success:boolean;
  idempotent:boolean;
  attachmentId:string;
};

class CleanupError extends Error{
  constructor(readonly code:string,readonly status=502){super(code);}
}

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST'){
    return json(405,{ok:false,error:'method_not_allowed'},{allow:'POST'});
  }

  const supabaseUrl=(Deno.env.get('SUPABASE_URL')||'').replace(/\/$/,'');
  const serviceRoleKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  const cronSecret=Deno.env.get(CRON_SECRET_ENV)||'';
  const suppliedSecret=request.headers.get(CRON_SECRET_HEADER)||'';
  if(!supabaseUrl||!serviceRoleKey||new TextEncoder().encode(cronSecret).byteLength<32){
    return json(503,{ok:false,error:'cleanup_unavailable'});
  }
  if(!await constantTimeEqual(suppliedSecret,cronSecret)){
    return json(401,{ok:false,error:'cleanup_not_authorized'});
  }

  const deadlineAt=Date.now()+OPERATION_TIMEOUT_MS;
  try{
    const snapshot=parseSnapshot(await rpc<JsonRecord>(
      supabaseUrl,
      serviceRoleKey,
      'v3_support_attachment_cleanup_snapshot',
      {p_limit:MAX_ITEMS_PER_RUN},
      deadlineAt
    ));
    const batches=chunk(snapshot.items,BATCH_SIZE).slice(0,MAX_BATCHES);
    let deleteAccepted=0;
    let finalized=0;
    let idempotent=0;
    let failed=0;

    for(const batch of batches){
      ensureTime(deadlineAt);
      await deleteStorageObjects(
        supabaseUrl,serviceRoleKey,batch,deadlineAt
      );
      deleteAccepted+=batch.length;
      const results=await mapWithConcurrency(
        batch,
        FINALIZE_CONCURRENCY,
        async item=>{
          try{
            const result=await rpc<CleanupResult>(
              supabaseUrl,
              serviceRoleKey,
              'v3_support_attachment_cleanup_finalize',
              {p_attachment_id:item.attachmentId},
              deadlineAt
            );
            if(result?.success!==true||!UUID.test(String(result.attachmentId||''))){
              throw new CleanupError('cleanup_finalize_invalid_response');
            }
            return {ok:true,idempotent:result.idempotent===true};
          }catch{
            return {ok:false,idempotent:false};
          }
        }
      );
      for(const result of results){
        if(!result.ok){failed+=1;continue;}
        finalized+=1;
        if(result.idempotent)idempotent+=1;
      }
    }

    const summary={
      batches:batches.length,
      selected:snapshot.items.length,
      deleteAccepted,
      finalized,
      idempotent,
      failed,
      hasMore:snapshot.hasMore
    };
    console.info('[support-attachment-cleanup]',{
      outcome:failed?'partial':'complete',
      batches:summary.batches,
      selected:summary.selected,
      finalized:summary.finalized,
      failed:summary.failed,
      hasMore:summary.hasMore
    });
    return failed
      ?json(502,{ok:false,error:'cleanup_partial_failure',...summary})
      :json(200,{ok:true,...summary});
  }catch(error){
    const normalized=normalizeError(error);
    console.error('[support-attachment-cleanup]',{
      code:normalized.code,
      status:normalized.status
    });
    return json(normalized.status,{ok:false,error:normalized.code});
  }
});

async function constantTimeEqual(provided:string,expected:string){
  const encoder=new TextEncoder();
  const [providedHash,expectedHash]=await Promise.all([
    crypto.subtle.digest('SHA-256',encoder.encode(provided)),
    crypto.subtle.digest('SHA-256',encoder.encode(expected))
  ]);
  const left=new Uint8Array(providedHash);
  const right=new Uint8Array(expectedHash);
  let difference=left.length^right.length;
  for(let index=0;index<Math.max(left.length,right.length);index+=1){
    difference|=(left[index%left.length]||0)^(right[index%right.length]||0);
  }
  return difference===0
    &&encoder.encode(provided).byteLength>=32
    &&encoder.encode(expected).byteLength>=32;
}

function parseSnapshot(value:unknown):CleanupSnapshot{
  if(!value||typeof value!=='object'||Array.isArray(value)){
    throw new CleanupError('cleanup_snapshot_invalid_response');
  }
  const source=value as JsonRecord;
  if(!Array.isArray(source.items)||source.items.length>MAX_ITEMS_PER_RUN){
    throw new CleanupError('cleanup_snapshot_invalid_response');
  }
  const seenIds=new Set<string>();
  const seenPaths=new Set<string>();
  const items=source.items.map(raw=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)){
      throw new CleanupError('cleanup_snapshot_invalid_response');
    }
    const item=raw as JsonRecord;
    const attachmentId=String(item.attachmentId||'').toLowerCase();
    const bucket=String(item.bucket||'');
    const objectPath=String(item.objectPath||'').toLowerCase();
    if(
      !UUID.test(attachmentId)
      ||bucket!==SUPPORT_BUCKET
      ||!OBJECT_PATH.test(objectPath)
      ||seenIds.has(attachmentId)
      ||seenPaths.has(objectPath)
    )throw new CleanupError('cleanup_snapshot_invalid_response');
    seenIds.add(attachmentId);
    seenPaths.add(objectPath);
    return {attachmentId,bucket,objectPath};
  });
  return {items,hasMore:source.hasMore===true};
}

async function deleteStorageObjects(
  supabaseUrl:string,
  serviceRoleKey:string,
  items:CleanupItem[],
  deadlineAt:number
){
  if(items.length<1||items.length>BATCH_SIZE){
    throw new CleanupError('cleanup_batch_invalid');
  }
  const response=await fetch(
    `${supabaseUrl}/storage/v1/object/${encodeURIComponent(SUPPORT_BUCKET)}`,
    {
      method:'DELETE',
      headers:serviceHeaders(serviceRoleKey),
      body:JSON.stringify({prefixes:items.map(item=>item.objectPath)}),
      cache:'no-store',
      signal:deadlineSignal(deadlineAt,UPSTREAM_TIMEOUT_MS)
    }
  );
  await boundedResponseText(response,MAX_RESPONSE_BYTES);
  if(!response.ok&&response.status!==404){
    throw new CleanupError('cleanup_storage_delete_failed');
  }
}

async function rpc<T>(
  supabaseUrl:string,
  serviceRoleKey:string,
  name:string,
  body:JsonRecord,
  deadlineAt:number
):Promise<T>{
  const response=await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:serviceHeaders(serviceRoleKey),
    body:JSON.stringify(body),
    cache:'no-store',
    signal:deadlineSignal(deadlineAt,UPSTREAM_TIMEOUT_MS)
  });
  const raw=await boundedResponseText(response,MAX_RESPONSE_BYTES);
  if(!response.ok)throw new CleanupError('cleanup_database_request_failed');
  try{return JSON.parse(raw||'{}') as T;}
  catch{throw new CleanupError('cleanup_database_invalid_response');}
}

function serviceHeaders(serviceRoleKey:string){
  return {
    apikey:serviceRoleKey,
    authorization:`Bearer ${serviceRoleKey}`,
    'content-type':'application/json'
  };
}

async function boundedResponseText(response:Response,maxBytes:number){
  if(!response.body)return '';
  const reader=response.body.getReader();
  const decoder=new TextDecoder();
  let size=0;
  let output='';
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    size+=value.byteLength;
    if(size>maxBytes){
      await reader.cancel();
      throw new CleanupError('cleanup_upstream_response_too_large');
    }
    output+=decoder.decode(value,{stream:true});
  }
  return output+decoder.decode();
}

function deadlineSignal(deadlineAt:number,maxMs:number){
  const remaining=deadlineAt-Date.now();
  if(remaining<250)throw new CleanupError('cleanup_timeout',503);
  return AbortSignal.timeout(Math.max(250,Math.min(maxMs,remaining)));
}

function ensureTime(deadlineAt:number){
  if(deadlineAt-Date.now()<500)throw new CleanupError('cleanup_timeout',503);
}

function chunk<T>(items:T[],size:number){
  const result:T[][]=[];
  for(let index=0;index<items.length;index+=size){
    result.push(items.slice(index,index+size));
  }
  return result;
}

async function mapWithConcurrency<T,R>(
  items:T[],
  concurrency:number,
  callback:(item:T)=>Promise<R>
):Promise<R[]>{
  const results=new Array<R>(items.length);
  let cursor=0;
  const workers=Array.from(
    {length:Math.min(Math.max(1,concurrency),items.length)},
    async()=>{
      while(true){
        const index=cursor;
        cursor+=1;
        if(index>=items.length)return;
        results[index]=await callback(items[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function normalizeError(error:unknown){
  if(error instanceof CleanupError)return error;
  if(error instanceof DOMException&&error.name==='TimeoutError'){
    return new CleanupError('cleanup_timeout',503);
  }
  if(error instanceof Error&&error.name==='AbortError'){
    return new CleanupError('cleanup_timeout',503);
  }
  return new CleanupError('cleanup_internal_error',500);
}

function json(
  status:number,
  body:JsonRecord,
  additionalHeaders:Record<string,string>={}
){
  return new Response(JSON.stringify(body),{
    status,
    headers:{...JSON_HEADERS,...additionalHeaders}
  });
}