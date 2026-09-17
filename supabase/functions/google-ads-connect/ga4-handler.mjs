import {createGA4Client,GA4_SCOPE} from '../_shared/ga4-client.mjs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=code=>{throw Object.assign(new Error(code),{code});};
export async function handleGA4({route,body,tenantSlug,user,service,google,fetchImpl,signal,publicError}) {
  if(route==='ga4-status')return {ok:true,...await user('ga4_status',{p_slug:tenantSlug})};
  if(route==='ga4-disable')return {ok:true,...await user('ga4_disable',{p_slug:tenantSlug})};
  if(route==='ga4-report')return {ok:true,...await user('ga4_report',{p_slug:tenantSlug,p_from:body.dateFrom,p_to:body.dateTo,
    p_as_of:body.asOf||null,p_page:body.page??1,p_status:body.status||'all',p_campaign:body.campaignId||null})};
  if(!UUID.test(body.commandId||''))fail('invalid_request');
  const kind={'ga4-assets':'discover','ga4-streams':'streams','ga4-select':'configure','ga4-sync':'sync'}[route];
  if(!kind)fail('not_found');
  if(['configure','streams'].includes(kind)&&!/^\d{1,20}$/.test(body.propertyId||''))fail('invalid_request');
  if(kind==='configure'&&((body.connectionId!=null&&body.connectionId!==''&&!UUID.test(body.connectionId))
    ||(body.streamId!=null&&body.streamId!==''&&!/^\d{1,20}$/.test(body.streamId))))fail('invalid_request');
  if(kind==='configure'&&!body.connectionId&&!body.streamId)fail('ga4_stream_required');
  const run=await user('ga4_begin_v2',{p_slug:tenantSlug,p_kind:kind,p_command:body.commandId,
    p_property:body.propertyId||null,p_connection:kind==='configure'?body.connectionId||null:null,
    p_stream:kind==='configure'?body.streamId||null:null,p_from:body.dateFrom||null,p_to:body.dateTo||null});
  if(run.duplicate)return {ok:true,status:run.status,duplicate:true,...(Array.isArray(run.streams)?{streams:run.streams}: {})};
  const lease={p_run:run.runId,p_lease:run.leaseToken};
  try {
    const context=await service('ga4_credentials',lease);
    const tokens=await google().refreshAccessToken({refreshToken:context.refreshToken,signal});
    if(!String(tokens.scope||'').split(/\s+/).includes(GA4_SCOPE))fail('ga4_consent_required');
    const ga4=createGA4Client({fetchImpl,signal});let payload;
    if(kind==='discover')payload={properties:await ga4.properties(tokens.accessToken)};
    else if(kind==='streams')payload={streams:await ga4.streams(tokens.accessToken,context.propertyId)};
    else if(kind==='configure')payload={property:await ga4.property(tokens.accessToken,context.propertyId,context.storeUrl,context.streamId)};
    else {
      // Recheck remote timezone/currency/domain: silently accepting drift corrupts money comparisons.
      const current=await ga4.property(tokens.accessToken,context.property.id,context.storeUrl,context.property.streamId);
      if(current.currency!==context.property.currency||current.timezone!==context.property.timezone||current.hostname!==context.property.hostname)fail('ga4_property_changed');
      payload=await ga4.reports(tokens.accessToken,current,context.dateFrom,context.dateTo);
    }
    return {ok:true,...await service('ga4_finish',{...lease,p_payload:payload,p_success:true,p_error:null})};
  }catch(error){
    await service('ga4_finish',{...lease,p_payload:{},p_success:false,p_error:publicError(error)}).catch(()=>{});
    throw error;
  }
}
