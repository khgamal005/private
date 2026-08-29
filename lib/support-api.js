import {authRpc} from './server-auth';

function cappedInteger(value,{fallback,min,max}){
  const parsed=Number.parseInt(String(value??''),10);
  if(!Number.isFinite(parsed))return fallback;
  return Math.min(max,Math.max(min,parsed));
}

function nullableText(value,maxLength=200){
  const normalized=String(value??'').trim();
  return normalized?normalized.slice(0,maxLength):null;
}

export async function getTenantSupport(slug,options={}){
  return authRpc('v3_tenant_support_snapshot',{
    p_slug:slug,
    p_ticket_id:nullableText(options.ticketId,36),
    p_filters:{
      scope:options.scope==='tenant'||options.scope==='all'?'all':'mine',
      status:nullableText(options.status,40),
      priority:nullableText(options.priority,20),
      moduleKey:nullableText(options.moduleKey,80),
      search:nullableText(options.query||options.search,120)
    },
    p_page_size:cappedInteger(options.limit,{fallback:50,min:1,max:100}),
    p_cursor_updated_at:nullableText(options.cursorUpdatedAt,40),
    p_cursor_id:nullableText(options.cursorId,36)
  },{retryTransient:true,timeoutMs:8000});
}

export async function getPlatformSupport(options={}){
  return authRpc('v3_platform_support_snapshot',{
    p_ticket_id:nullableText(options.ticketId,36),
    p_filters:{
      queue:nullableText(options.queue,40)||'all',
      search:nullableText(options.query||options.search,120),
      tenantId:nullableText(options.tenantId,36),
      status:nullableText(options.status,40),
      priority:nullableText(options.priority,20),
      moduleKey:nullableText(options.moduleKey,80),
      assigneeSubjectId:nullableText(options.assigneeId,36)
    },
    p_page_size:cappedInteger(options.limit,{fallback:50,min:1,max:100}),
    p_cursor_updated_at:nullableText(options.cursorUpdatedAt,40),
    p_cursor_id:nullableText(options.cursorId,36)
  },{retryTransient:true,timeoutMs:8000});
}