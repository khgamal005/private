import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {sameOriginMutation} from '../../../../lib/social-connect-protocol.mjs';
import {campaignFilters,campaignReportArgs,campaignCsv} from '../../../../lib/campaign-revenue.mjs';

export const dynamic='force-dynamic';
const headers={'cache-control':'private, no-store, max-age=0','x-content-type-options':'nosniff'};
const json=(data,status=200)=>NextResponse.json(data,{status,headers});
async function rpc(name,args){
  const token=(await cookies()).get(ACCESS_COOKIE)?.value;
  if(!token)return {error:'session_expired',status:401};
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',
    headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${token}`,'content-type':'application/json'},
    body:JSON.stringify(args),cache:'no-store',signal:AbortSignal.timeout(15000)});
  const data=await response.json();
  if(!response.ok){
    const allowed=['forbidden','addon_not_enabled','campaign_report_not_enabled','source_changed_refresh_preview','command_id_reused','campaign_not_found','ad_not_found','invalid_review'];
    return {error:allowed.includes(data.message)?data.message:'request_failed',status:response.status===401?401:400};
  }
  return {data};
}
function tenant(value){return /^[a-z0-9][a-z0-9-]{1,79}$/.test(value||'')?value:null;}
export async function GET(request){
  try{
    const q=new URL(request.url).searchParams;
    const slug=tenant(q.get('tenantSlug'));
    if(!slug)return json({error:'invalid_tenant'},400);
    const mode=q.get('action');
    if(!['sources','export'].includes(mode))return json({error:'not_found'},404);
    const access=mode==='export'?await rpc('v1_tenant_campaign_report_access',{p_slug:slug}):null;
    if(access?.error)return json({error:access.error},access.status);
    const f=campaignFilters(Object.fromEntries(q),new Date(),access?.data?.timezone||'Asia/Riyadh');
    const result=await rpc(mode==='sources'?'v1_tenant_campaign_sources':'v1_tenant_campaign_revenue_report',
      mode==='sources'?{p_slug:slug,p_batch_id:q.get('batch')||null,p_offset:f.offset}:campaignReportArgs(slug,f));
    if(result.error)return json({error:result.error},result.status);
    if(mode==='sources')return json(result.data);
    if(!result.data?.enabled)return json({error:'campaign_report_not_enabled'},403);
    return new NextResponse(campaignCsv(result.data),{headers:{...headers,'content-type':'text/csv; charset=utf-8',
      'content-disposition':'attachment; filename="campaign-revenue.csv"'}});
  }catch{return json({error:'service_unavailable'},503);}
}
export async function POST(request){
  if(!sameOriginMutation(request))return json({error:'forbidden'},403);
  try{
    if(Number(request.headers.get('content-length')||0)>100000)return json({error:'invalid_review'},413);
    const body=await request.json();
    const slug=tenant(body.tenantSlug);
    if(!slug||!Array.isArray(body.rows)||body.rows.length>200)return json({error:'invalid_review'},400);
    const result=await rpc('v1_tenant_campaign_source_review',{p_slug:slug,p_command_id:body.commandId,
      p_rows:body.rows,p_campaign_id:body.campaignId||null,p_ad_external_id:body.adExternalId||null,p_reason:body.reason});
    return result.error?json({error:result.error},result.status):json(result.data);
  }catch{return json({error:'service_unavailable'},503);}
}
