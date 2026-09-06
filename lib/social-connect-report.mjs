const DATE_ONLY=/^\d{4}-\d{2}-\d{2}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUSES=new Set(['all','active','paused','other']);

function iso(date){
  return date.toISOString().slice(0,10);
}

function validDate(value){
  if(!DATE_ONLY.test(value))return false;
  const date=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())&&iso(date)===value;
}

function minusDays(value,days){
  const date=new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()-days);
  return iso(date);
}

export function normalizeSocialReportQuery(query={},now=new Date()){
  const today=iso(now);
  const requestedTo=String(query.to||'').trim();
  const requestedFrom=String(query.from||'').trim();
  let dateTo=validDate(requestedTo)&&requestedTo<=today?requestedTo:today;
  let dateFrom=validDate(requestedFrom)?requestedFrom:minusDays(dateTo,29);
  const days=Math.round((Date.parse(`${dateTo}T00:00:00Z`)-Date.parse(`${dateFrom}T00:00:00Z`))/86_400_000);
  if(dateFrom>dateTo||days>92)dateFrom=minusDays(dateTo,29);
  const status=STATUSES.has(String(query.status||''))?String(query.status):'all';
  const campaign=UUID.test(String(query.campaign||''))?String(query.campaign):'';
  const pageNumber=Number.parseInt(String(query.page||'1'),10);
  return {
    dateFrom,dateTo,status,campaign,
    search:String(query.q||'').trim().slice(0,80),
    page:Number.isFinite(pageNumber)?Math.max(1,Math.min(pageNumber,10000)):1,
    pageSize:25,
    today
  };
}

export function socialReportHref(slug,filters,overrides={}){
  const next={...filters,...overrides};
  const params=new URLSearchParams();
  if(next.dateFrom)params.set('from',next.dateFrom);
  if(next.dateTo)params.set('to',next.dateTo);
  if(next.search)params.set('q',next.search);
  if(next.campaign)params.set('campaign',next.campaign);
  if(next.status&&next.status!=='all')params.set('status',next.status);
  if(Number(next.page)>1)params.set('page',String(next.page));
  return `/tenant/${encodeURIComponent(slug)}/addons/social-connect?${params}`;
}
