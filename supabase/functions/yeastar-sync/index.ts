const SUPABASE_URL=Deno.env.get('SUPABASE_URL')||'';
const SERVICE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
const PUBLISHABLE_KEY=Deno.env.get('SUPABASE_ANON_KEY')||'';
const USER_AGENT='Marktone-Yeastar-P550/1.0';
const JSON_HEADERS={'content-type':'application/json'};

type Json=Record<string,unknown>;

function response(body:unknown,status=200){
  return new Response(JSON.stringify(body),{
    status,
    headers:{...JSON_HEADERS,'cache-control':'no-store'}
  });
}

function cleanError(value:unknown){
  const text=String(value||'yeastar_connection_failed')
    .replace(/access_token=[^&\s]+/gi,'access_token=[REDACTED]')
    .replace(/(client[_ -]?secret|password)["':=\s]+[^,\s"}]+/gi,'$1=[REDACTED]');
  return text.slice(0,500);
}

async function rpc(name:string,args:Json,token:string){
  const request=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{
      apikey:token===SERVICE_KEY?SERVICE_KEY:PUBLISHABLE_KEY,
      authorization:`Bearer ${token}`,
      ...JSON_HEADERS
    },
    body:JSON.stringify(args)
  });
  const text=await request.text();
  let payload:unknown;
  try{payload=JSON.parse(text)}catch{payload={message:text}}
  if(!request.ok){
    const detail=(payload as Json)?.message||(payload as Json)?.error||text;
    throw new Error(cleanError(detail));
  }
  return payload as Json;
}

function bearer(request:Request){
  return request.headers.get('authorization')?.replace(/^Bearer\s+/i,'')||'';
}

function semver(value:unknown){
  const match=String(value||'').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  return match?match.slice(1).map(Number):[0,0,0,0];
}

function versionAtLeast(value:unknown,target:number[]){
  const current=semver(value);
  for(let index=0;index<target.length;index+=1){
    if(current[index]>target[index])return true;
    if(current[index]<target[index])return false;
  }
  return true;
}

function safeBaseUrl(value:unknown){
  const url=new URL(String(value||''));
  const host=url.hostname.toLowerCase();
  if(url.protocol!=='https:')throw new Error('yeastar_public_https_required');
  if(
    host==='localhost'||host==='0.0.0.0'||host==='::1'
    ||/^127\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)
    ||/^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )throw new Error('yeastar_public_https_required');
  url.pathname=url.pathname.replace(/\/+$/,'');
  url.search='';url.hash='';
  return url.toString().replace(/\/$/,'');
}

async function yeastarFetch(
  baseUrl:string,
  path:string,
  options:RequestInit={},
  timeoutMs=20000
){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{
    const request=await fetch(`${baseUrl}${path}`,{
      ...options,
      redirect:'error',
      signal:controller.signal,
      headers:{
        'User-Agent':USER_AGENT,
        ...(options.body?{'Content-Type':'application/json'}:{}),
        ...(options.headers||{})
      }
    });
    const text=await request.text();
    let payload:Json;
    try{payload=JSON.parse(text)}catch{throw new Error(`yeastar_invalid_response_${request.status}`)}
    if(!request.ok||Number(payload.errcode||0)!==0){
      throw new Error(
        cleanError(payload.errmsg||payload.message||`yeastar_http_${request.status}`)
      );
    }
    return payload;
  }finally{
    clearTimeout(timer);
  }
}

async function accessToken(baseUrl:string,clientId:string,clientSecret:string){
  const payload=await yeastarFetch(baseUrl,'/openapi/v1.0/get_token',{
    method:'POST',
    body:JSON.stringify({username:clientId,password:clientSecret})
  });
  const token=String(payload.access_token||'');
  if(!token)throw new Error('yeastar_token_missing');
  return token;
}

async function revokeToken(baseUrl:string,token:string){
  try{
    await yeastarFetch(
      baseUrl,
      `/openapi/v1.0/del_token?access_token=${encodeURIComponent(token)}`,
      {method:'GET'},
      8000
    );
  }catch{/* token expiry/revoke failure must not hide a successful sync */}
}

function stringList(value:unknown,key?:string){
  if(!Array.isArray(value))return [];
  return [...new Set(value.map(item=>{
    if(typeof item==='string')return item;
    if(item&&typeof item==='object'&&key)return String((item as Json)[key]||'');
    return '';
  }).filter(Boolean))];
}

function pbxDateParts(value:unknown,dateFormat:string){
  const match=String(value||'').match(
    /^(\d{1,4})[\/-](\d{1,2})[\/-](\d{1,4})[ T](\d{1,2}):(\d{2}):(\d{2})(?:\s*(AM|PM))?$/i
  );
  if(!match)return null;
  let [,first,second,third,hour,minute,secondValue,ampm]=match;
  let year:number,month:number,day:number;
  if(dateFormat.startsWith('YYYY')){
    year=Number(first);month=Number(second);day=Number(third);
  }else if(dateFormat.startsWith('DD')){
    day=Number(first);month=Number(second);year=Number(third);
  }else{
    month=Number(first);day=Number(second);year=Number(third);
  }
  let hourValue=Number(hour);
  if(ampm){
    if(hourValue===12)hourValue=0;
    if(ampm.toUpperCase()==='PM')hourValue+=12;
  }
  return {year,month,day,hour:hourValue,minute:Number(minute),second:Number(secondValue)};
}

function zonedIso(value:unknown,dateFormat:string,timeZone:string){
  const parts=pbxDateParts(value,dateFormat);
  if(!parts)return null;
  const wall=Date.UTC(
    parts.year,parts.month-1,parts.day,parts.hour,parts.minute,parts.second
  );
  const formatter=new Intl.DateTimeFormat('en-CA',{
    timeZone,year:'numeric',month:'2-digit',day:'2-digit',
    hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
  });
  const observed=Object.fromEntries(
    formatter.formatToParts(new Date(wall))
      .filter(part=>part.type!=='literal')
      .map(part=>[part.type,Number(part.value)])
  );
  const observedWall=Date.UTC(
    observed.year,observed.month-1,observed.day,
    observed.hour,observed.minute,observed.second
  );
  return new Date(wall-(observedWall-wall)).toISOString();
}

function pbxTime(date:Date,dateFormat:string,timeFormat:string,timeZone:string){
  const parts=Object.fromEntries(
    new Intl.DateTimeFormat('en-US',{
      timeZone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
    }).formatToParts(date)
      .filter(part=>part.type!=='literal')
      .map(part=>[part.type,part.value])
  );
  const datePart=dateFormat.startsWith('DD')
    ?`${parts.day}/${parts.month}/${parts.year}`
    :dateFormat.startsWith('MM')
      ?`${parts.month}/${parts.day}/${parts.year}`
      :`${parts.year}/${parts.month}/${parts.day}`;
  if(/12|hh/i.test(timeFormat)){
    let hour=Number(parts.hour);
    const suffix=hour>=12?'PM':'AM';
    hour=hour%12||12;
    return `${datePart} ${String(hour).padStart(2,'0')}:${parts.minute}:${parts.second} ${suffix}`;
  }
  return `${datePart} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function normalizedExtensions(config:Json){
  return String(config.extensions||'')
    .split(/[,\s]+/).map(value=>value.trim()).filter(Boolean);
}

function normalizeCall(
  source:Json,
  apiVersion:string,
  dateFormat:string,
  timeZone:string,
  monitored:string[]
){
  const numbers=[
    source.call_from_number,
    source.call_to_number,
    source.second_participant_number,
    source.last_participant_number
  ].map(String).filter(Boolean);
  const involved=[...new Set(numbers.filter(number=>monitored.includes(number)))];
  if(monitored.length&&involved.length===0)return null;
  const note=(source.call_notes||{}) as Json;
  const recording=source.recording_files||source.recordings||source.recording;
  const recordingList=Array.isArray(recording)?recording:recording?[recording]:[];
  return {
    uid:String(source.uid||source.id||''),
    sourceRecordId:String(source.id||''),
    apiVersion,
    startedAt:zonedIso(source.time,dateFormat,timeZone),
    callType:String(source.call_type||'Unknown'),
    finalStatus:String(source.last_status||source.disposition||'UNKNOWN').toUpperCase(),
    callerNumber:String(source.call_from_number||''),
    callerName:String(source.call_from_name||''),
    calleeNumber:String(source.call_to_number||''),
    calleeName:String(source.call_to_name||''),
    secondParticipantNumber:String(source.second_participant_number||''),
    secondParticipantName:String(source.second_participant_name||''),
    lastParticipantNumber:String(source.last_participant_number||''),
    lastParticipantName:String(source.last_participant_name||''),
    involvedExtensions:involved,
    callDuration:Number(source.call_duration||source.duration||0),
    routingDuration:Number(source.routing_duration||source.ring_duration||0),
    handlingDuration:Number(source.handling_duration||source.talk_duration||0),
    disconnectedBy:String(source.disconnected_by||''),
    segments:Number(source.segments||1),
    queueNames:stringList(source.queues,'name'),
    ringGroupNames:stringList(source.ring_groups,'name'),
    sourceTrunks:stringList(source.source_trunks,'name'),
    destinationTrunks:stringList(source.destination_trunks,'name'),
    didNumbers:stringList(source.dids,'number'),
    hasRecording:Boolean(
      recordingList.length||source.recording_file||source.recording_path
    ),
    recordingReference:String(
      (recordingList[0] as Json)?.file
      ||(recordingList[0] as Json)?.id
      ||source.recording_file
      ||''
    ),
    callNote:String(note.remark||source.call_note_remark||''),
    dispositionCodes:Array.isArray(note.disposition_code_list)
      ?(note.disposition_code_list as Json[]).map(item=>String(item.name||'')).filter(Boolean)
      :[],
    queues:source.queues||null,
    ringGroups:source.ring_groups||null,
    dids:source.dids||null
  };
}

async function getConfiguration(connectionId:string,tenantId:string){
  return rpc('v2_integration_provider_configuration',{
    p_tenant_id:tenantId,
    p_channel:'api',
    p_connection_id:connectionId,
    p_include_draft:true
  },SERVICE_KEY);
}

async function systemInformation(baseUrl:string,token:string){
  const payload=await yeastarFetch(
    baseUrl,
    `/openapi/v1.0/system/information?access_token=${encodeURIComponent(token)}`
  );
  const data=(payload.data||{}) as Json;
  return {
    modelName:String(data.model_name||'Yeastar P-Series'),
    firmwareVersion:String(data.firmware_version||''),
    dateFormat:String(data.system_date_format||'YYYY/MM/DD'),
    timeFormat:String(data.system_time_format||'HH:mm:ss'),
    systemTime:String(data.system_time||''),
    timestamp:Number(data.timestamp||0)
  };
}

async function extensionList(baseUrl:string,token:string){
  const payload=await yeastarFetch(
    baseUrl,
    `/openapi/v1.0/extension/list?access_token=${encodeURIComponent(token)}&page_size=1000`
  );
  return Array.isArray(payload.data)?payload.data as Json[]:[];
}

async function fetchCalls(
  baseUrl:string,
  token:string,
  device:Json,
  config:Json,
  from:Date,
  to:Date
){
  const requestedMode=String(config.apiMode||'auto');
  const supportsV2Search=versionAtLeast(device.firmwareVersion,[37,23,0,123]);
  const apiVersion=requestedMode==='v1.0'
    ?'v1.0'
    :requestedMode==='v2.0'&&supportsV2Search
      ?'v2.0'
      :supportsV2Search?'v2.0':'v1.0';
  const monitored=normalizedExtensions(config);
  const timeZone=String(config.timezone||'Asia/Riyadh');
  const dateFormat=String(device.dateFormat||'YYYY/MM/DD');
  const timeFormat=String(device.timeFormat||'HH:mm:ss');
  const all:Json[]=[];
  for(let page=1;page<=10;page+=1){
    const query=new URLSearchParams({
      access_token:token,
      page:String(page),
      page_size:'1000',
      order_by:'asc',
      sort_by:'time',
      time_begin:pbxTime(from,dateFormat,timeFormat,timeZone),
      time_end:pbxTime(to,dateFormat,timeFormat,timeZone)
    });
    const payload=await yeastarFetch(
      baseUrl,
      `/openapi/${apiVersion}/cdr/search?${query.toString()}`
    );
    const rows=Array.isArray(payload.data)?payload.data as Json[]:[];
    all.push(...rows);
    if(rows.length<1000||all.length>=Number(payload.total_number||0))break;
  }
  return {
    apiVersion,
    calls:all.map(item=>normalizeCall(
      item,apiVersion,dateFormat,timeZone,monitored
    )).filter(Boolean)
  };
}

async function handleTest(connectionId:string,tenantId:string){
  const config=await getConfiguration(connectionId,tenantId);
  const publicConfig=(config.publicConfig||{}) as Json;
  const secrets=(config.secrets||{}) as Json;
  const baseUrl=safeBaseUrl(publicConfig.baseUrl);
  let token='';
  try{
    token=await accessToken(
      baseUrl,
      String(secrets.clientId||''),
      String(secrets.clientSecret||'')
    );
    const [device,extensions]=await Promise.all([
      systemInformation(baseUrl,token),
      extensionList(baseUrl,token)
    ]);
    const monitored=normalizedExtensions(publicConfig);
    const available=new Set(
      extensions.map(item=>String(
        item.number||item.extension||item.ext_num||''
      ))
    );
    const missing=monitored.filter(number=>!available.has(number));
    if(missing.length){
      throw new Error(`yeastar_extensions_not_found:${missing.join(',')}`);
    }
    const result=await rpc('v2_yeastar_test_complete',{
      p_connection_id:connectionId,
      p_state:'ready',
      p_device:{
        modelName:device.modelName,
        firmwareVersion:device.firmwareVersion,
        apiVersion:versionAtLeast(device.firmwareVersion,[37,23,0,123])
          ?'v2.0':'v1.0'
      },
      p_detail:`${device.modelName} · ${device.firmwareVersion}`
    },SERVICE_KEY);
    return {
      success:true,
      device,
      extensions:monitored,
      recommendedApiVersion:versionAtLeast(
        device.firmwareVersion,[37,23,0,123]
      )?'v2.0':'v1.0',
      result
    };
  }catch(error){
    await rpc('v2_yeastar_test_complete',{
      p_connection_id:connectionId,
      p_state:'error',
      p_device:{},
      p_detail:cleanError(error)
    },SERVICE_KEY).catch(()=>null);
    throw error;
  }finally{
    if(token)await revokeToken(baseUrl,token);
  }
}

async function handleSync(
  connectionId:string,
  tenantId:string,
  triggerType:'manual'|'scheduled'
){
  const [config,context]=await Promise.all([
    getConfiguration(connectionId,tenantId),
    rpc('v2_yeastar_sync_context',{
      p_connection_id:connectionId
    },SERVICE_KEY)
  ]);
  const publicConfig=(config.publicConfig||{}) as Json;
  const secrets=(config.secrets||{}) as Json;
  const baseUrl=safeBaseUrl(publicConfig.baseUrl);
  const to=new Date();
  const last=context.lastSuccessfulAt
    ?new Date(String(context.lastSuccessfulAt))
    :null;
  const from=last
    ?new Date(last.getTime()-5*60*1000)
    :new Date(
      to.getTime()-Number(context.initialHistoryDays||30)*86400000
    );
  let token='';
  try{
    token=await accessToken(
      baseUrl,
      String(secrets.clientId||''),
      String(secrets.clientSecret||'')
    );
    const device=await systemInformation(baseUrl,token);
    const result=await fetchCalls(
      baseUrl,token,device,publicConfig,from,to
    );
    const stored=await rpc('v2_yeastar_store_sync',{
      p_connection_id:connectionId,
      p_trigger_type:triggerType,
      p_requested_from:from.toISOString(),
      p_requested_to:to.toISOString(),
      p_device:{
        modelName:device.modelName,
        firmwareVersion:device.firmwareVersion
      },
      p_api_version:result.apiVersion,
      p_calls:result.calls
    },SERVICE_KEY);
    return {
      success:true,
      device,
      apiVersion:result.apiVersion,
      ...stored
    };
  }catch(error){
    await rpc('v2_yeastar_sync_failed',{
      p_connection_id:connectionId,
      p_trigger_type:triggerType,
      p_requested_from:from.toISOString(),
      p_requested_to:to.toISOString(),
      p_detail:cleanError(error)
    },SERVICE_KEY).catch(()=>null);
    throw error;
  }finally{
    if(token)await revokeToken(baseUrl,token);
  }
}

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST')return response({error:'method_not_allowed'},405);
  if(!SUPABASE_URL||!SERVICE_KEY)return response({error:'server_configuration_missing'},500);
  try{
    const body=await request.json().catch(()=>({})) as Json;
    const action=String(body.action||'');

    if(action==='scheduled'){
      const scheduleSecret=request.headers.get('x-marktone-yeastar-secret')||'';
      const authorized=await rpc('v2_yeastar_schedule_authorize',{
        p_secret:scheduleSecret
      },SERVICE_KEY);
      if(authorized!==true)return response({error:'forbidden'},403);
      const due=await rpc('v2_yeastar_due_connections',{},SERVICE_KEY);
      const connections=Array.isArray(due)?due as Json[]:[];
      const results=[];
      for(const item of connections.slice(0,25)){
        try{
          results.push(await handleSync(
            String(item.connectionId),
            String(item.tenantId),
            'scheduled'
          ));
        }catch(error){
          results.push({
            success:false,
            connectionId:item.connectionId,
            error:cleanError(error)
          });
        }
      }
      return response({success:true,processed:results.length,results});
    }

    const token=bearer(request);
    if(!token)return response({error:'authentication_required'},401);
    if(!['test','sync'].includes(action)){
      return response({error:'invalid_yeastar_action'},400);
    }
    const tenantSlug=String(body.tenantSlug||'');
    const authorization=await rpc('v2_tenant_yeastar_authorize',{
      p_tenant_slug:tenantSlug,
      p_action:action
    },token);
    const connectionId=String(authorization.connectionId||'');
    const tenantId=String(authorization.tenantId||'');
    const result=action==='test'
      ?await handleTest(connectionId,tenantId)
      :await handleSync(connectionId,tenantId,'manual');
    return response(result);
  }catch(error){
    return response({error:cleanError(error)},502);
  }
});
