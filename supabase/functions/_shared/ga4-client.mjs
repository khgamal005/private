// GA4 is a read-only extension of the Google Ads entitlement. No event uploads.
export const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';
const TX_DIMS = ['date','transactionId','hostName','sessionSource','sessionMedium','sessionGoogleAdsCustomerId','sessionGoogleAdsCampaignId','sessionCampaignName','currencyCode'];
const TX_METRICS = ['ecommercePurchases','grossPurchaseRevenue'];
const TRAFFIC_DIMS = ['date','sessionSource','sessionMedium','sessionGoogleAdsCustomerId','sessionGoogleAdsCampaignId'];
const TRAFFIC_METRICS = ['sessions','engagedSessions','screenPageViews','addToCarts','checkouts','ecommercePurchases'];
const fail = code => { throw Object.assign(new Error(code), {code}); };
const id = value => { if(typeof value !== 'string' || !/^\d{1,20}$/.test(value)) fail('ga4_invalid_property'); return value; };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value,limit=300) => { if(typeof value !== 'string' || value.length>limit || /[\u0000-\u001f\u007f]/.test(value)) fail('ga4_invalid_response'); return value; };
export function ga4Hostname(value) {
  let url; try { url=new URL(value); } catch { fail('ga4_invalid_store'); }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port) fail('ga4_invalid_store');
  return url.hostname.toLowerCase().replace(/^www\./,'');
}
function day(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value) fail('invalid_date_range');
  return value;
}
function count(value) {
  if(typeof value!=='string'||!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))) fail('ga4_invalid_response');
  return Number(value);
}
function decimal(value) {
  if(typeof value!=='string'||!/^\d{1,18}(?:\.\d{1,9})?$/.test(value)) fail('ga4_invalid_response');
  return value; // Keep money decimal until PostgreSQL numeric conversion.
}
function metadata(value, expected) {
  const m=value||{};
  if(m.currencyCode!==expected.currency||m.timeZone!==expected.timezone) fail('ga4_property_changed');
  return {thresholded:m.subjectToThresholding===true,otherRow:m.dataLossFromOtherRow===true,
    sampled:(m.samplingMetadatas||[]).some(s=>BigInt(s.samplesReadCount||0)<BigInt(s.samplingSpaceSize||0)),
    restricted:Boolean(m.schemaRestrictionResponse?.activeMetricRestrictions?.length)};
}
async function permissionFailure(response,url) {
  // Only bounded, structured ErrorInfo enums are inspected. Never return provider
  // messages, metadata, activation URLs, project IDs or access tokens.
  const fallback='ga4_access_denied';
  const reader=response.body?.getReader();if(!reader)return fallback;
  const chunks=[];let size=0;
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>65536){await reader.cancel();return fallback;}chunks.push(value);}
  }catch{return fallback;}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let payload;try{payload=JSON.parse(new TextDecoder().decode(bytes));}catch{return fallback;}
  const details=payload?.error?.details;if(!Array.isArray(details)||details.length>20)return fallback;
  const reasons=details.filter(item=>plain(item)&&item['@type']==='type.googleapis.com/google.rpc.ErrorInfo'
    &&item.domain==='googleapis.com').map(item=>item.reason);
  if(reasons.includes('SERVICE_DISABLED'))return url.startsWith(ADMIN+'/')?'ga4_admin_api_disabled':'ga4_data_api_disabled';
  if(reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT'))return 'ga4_consent_required';
  return fallback;
}
export function createGA4Client({fetchImpl=fetch,signal,maxRows=20000,pageSize=1000,maxPages=30,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  async function request(url,token,body) {
    if(typeof token!=='string'||!token||/[\r\n]/.test(token)) fail('reauth_required');
    for(let attempt=0;attempt<3;attempt++) {
      const s=signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000);
      const res=await fetchImpl(url,{method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:s,redirect:'error'});
      if((res.status===429||res.status>=500)&&attempt<2) { const delay=Math.min(2000,500*2**attempt); await wait(delay); continue; }
      if(res.status===401) fail('reauth_required');
      if(res.status===403) fail(await permissionFailure(res,url));
      if(res.status===429) fail('rate_limited');
      if(!res.ok) fail('ga4_request_failed');
      // Bound bytes before parsing; never include provider errors or tokens in logs.
      const reader=res.body.getReader(); let size=0; const chunks=[];
      try { for(;;) { const {done,value}=await reader.read(); if(done)break; size+=value.length;if(size>8*1024*1024){await reader.cancel();fail('ga4_result_limit');}chunks.push(value); } } finally { reader.releaseLock(); }
      const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      let result;try {result=JSON.parse(new TextDecoder().decode(bytes));}catch{fail('ga4_invalid_response');}
      if(!plain(result))fail('ga4_invalid_response');return result;
    }
    fail('ga4_request_failed');
  }
  async function pagedAdmin(path,token,key) {
    const rows=[];let pageToken='';const seen=new Set();
    for(let p=0;p<10;p++) {
      const u=new URL(ADMIN+'/'+path);u.searchParams.set('pageSize','200');if(pageToken)u.searchParams.set('pageToken',pageToken);
      const body=await request(u.toString(),token);if(body[key]!=null&&!Array.isArray(body[key]))fail('ga4_invalid_response');
      rows.push(...(body[key]||[]));if(rows.length>1000)fail('ga4_result_limit');
      if(!body.nextPageToken)return rows;
      pageToken=text(body.nextPageToken,8192);if(seen.has(pageToken))fail('ga4_invalid_response');seen.add(pageToken);
    }fail('ga4_result_limit');
  }
  async function runReport(token,property,from,to,hostname,dimensions,metrics,purchasesOnly=false) {
    const hosts=[hostname,'www.'+hostname]; const filters=[{filter:{fieldName:'hostName',inListFilter:{values:hosts,caseSensitive:false}}}];
    if(purchasesOnly)filters.push({filter:{fieldName:'eventName',stringFilter:{matchType:'EXACT',value:'purchase'}}});
    const base={dateRanges:[{startDate:day(from),endDate:day(to)}],dimensions:dimensions.map(name=>({name})),metrics:metrics.map(name=>({name})),
      currencyCode:property.currency,dimensionFilter:{andGroup:{expressions:filters}},returnPropertyQuota:true,
      orderBys:dimensions.map(dimensionName=>({dimension:{dimensionName}})),limit:String(pageSize)};
    if((Date.parse(to)-Date.parse(from))/86400000>30||to<from)fail('invalid_date_range');
    const rows=[];let expected=null;let quality={thresholded:false,otherRow:false,sampled:false,restricted:false};const keys=new Set();
    for(let p=0;p<maxPages;p++) {
      const b=await request(DATA+'/properties/'+id(property.id)+':runReport',token,{...base,offset:String(rows.length)});
      if(b.rowCount===undefined&&(!b.rows||b.rows.length===0))b.rowCount=0;
      if(!Number.isSafeInteger(b.rowCount)||b.rowCount<0||b.rowCount>maxRows)fail('ga4_result_limit');
      if(expected!==null&&expected!==b.rowCount)fail('ga4_report_changed');expected=b.rowCount;
      if(JSON.stringify((b.dimensionHeaders||[]).map(x=>x.name))!==JSON.stringify(dimensions)||JSON.stringify((b.metricHeaders||[]).map(x=>x.name))!==JSON.stringify(metrics))fail('ga4_invalid_response');
      const q=metadata(b.metadata,property);for(const k of Object.keys(quality))quality[k] ||= q[k];
      if(!Array.isArray(b.rows||[]))fail('ga4_invalid_response');
      for(const row of b.rows||[]) {
        if(row.dimensionValues?.length!==dimensions.length||row.metricValues?.length!==metrics.length)fail('ga4_invalid_response');
        const values=row.dimensionValues.map(x=>text(x.value)); const key=JSON.stringify(values);
        if(keys.has(key))fail('ga4_report_changed');keys.add(key);
        const result=Object.fromEntries(dimensions.map((k,i)=>[k,values[i]]));
        metrics.forEach((k,i)=>{result[k]=k==='grossPurchaseRevenue'?decimal(row.metricValues[i].value):count(row.metricValues[i].value);});
        if(!/^\d{8}$/.test(result.date))fail('ga4_invalid_response');result.date=day(result.date.slice(0,4)+'-'+result.date.slice(4,6)+'-'+result.date.slice(6));
        if(result.date<from||result.date>to)fail('ga4_invalid_response');rows.push(result);
      }
      if(rows.length===expected)return {rows,quality};
      if(rows.length>expected||!(b.rows||[]).length)fail('ga4_incomplete_report');
    }fail('ga4_result_limit');
  }
  return {
    async properties(token) {
      const summaries=await pagedAdmin('accountSummaries',token,'accountSummaries');const result=[];const seen=new Set();
      for(const account of summaries)for(const p of account.propertySummaries||[]) {
        if(!/^properties\/\d{1,20}$/.test(p.property||''))fail('ga4_invalid_response');const propertyId=p.property.split('/')[1];
        if(!seen.has(propertyId)){seen.add(propertyId);result.push({id:propertyId,name:text(p.displayName||propertyId)});}
      }
      if(result.length>500)fail('ga4_result_limit');return result;
    },
    async property(token,propertyId,storeUrl) {
      const p=await request(ADMIN+'/properties/'+id(propertyId),token);if(p.name!=='properties/'+propertyId)fail('ga4_invalid_response');
      if(!/^[A-Z]{3}$/.test(p.currencyCode||''))fail('ga4_invalid_response');
      try{new Intl.DateTimeFormat('en',{timeZone:p.timeZone}).format();}catch{fail('ga4_invalid_response');}
      const hostname=ga4Hostname(storeUrl);const streams=await pagedAdmin('properties/'+propertyId+'/dataStreams',token,'dataStreams');
      if(!streams.some(s=>s.type==='WEB_DATA_STREAM'&&s.webStreamData?.defaultUri&&ga4Hostname(s.webStreamData.defaultUri)===hostname))fail('ga4_store_mismatch');
      return {id:propertyId,name:text(p.displayName||propertyId),currency:p.currencyCode,timezone:text(p.timeZone,100),hostname};
    },
    async reports(token,property,from,to) {
      const transactions=await runReport(token,property,from,to,property.hostname,TX_DIMS,TX_METRICS,true);
      const traffic=await runReport(token,property,from,to,property.hostname,TRAFFIC_DIMS,TRAFFIC_METRICS);
      return {transactions:transactions.rows,traffic:traffic.rows,quality:{transactions:transactions.quality,traffic:traffic.quality}};
    }
  };
}
