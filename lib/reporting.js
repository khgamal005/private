const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function first(value){
  return Array.isArray(value)?value[0]:value;
}

function dateParts(timeZone='Asia/Riyadh'){
  const parts=new Intl.DateTimeFormat('en-CA',{
    timeZone,
    year:'numeric',
    month:'2-digit',
    day:'2-digit'
  }).formatToParts(new Date());
  const value=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function validDate(value){
  if(!ISO_DATE.test(value||''))return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    &&parsed.toISOString().slice(0,10)===value;
}

function addDays(value,days){
  const date=new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}

function inclusiveDays(from,to){
  const start=new Date(`${from}T00:00:00Z`);
  const end=new Date(`${to}T00:00:00Z`);
  return Math.floor((end-start)/86400000)+1;
}

export function resolveReportRange(searchParams={}){
  const today=dateParts();
  let to=first(searchParams.to);
  let from=first(searchParams.from);
  if(!validDate(to))to=today;
  if(!validDate(from))from=addDays(to,-29);
  if(from>to)from=addDays(to,-29);
  if(inclusiveDays(from,to)>366)from=addDays(to,-365);
  const staffId=first(searchParams.staffId);
  const page=Math.max(1,Math.min(1000,Number(first(searchParams.page))||1));
  return {
    from,
    to,
    staffId:UUID.test(staffId||'')?staffId:null,
    page,
    limit:50
  };
}

export function reportQuery(range,extra={}){
  const params=new URLSearchParams({
    from:range.from,
    to:range.to
  });
  if(range?.staffId)params.set('staffId',range.staffId);
  for(const [key,value] of Object.entries(extra)){
    if(value!==null&&value!==undefined&&value!==''){
      params.set(key,String(value));
    }
  }
  return params.toString();
}

export function isUuid(value){
  return UUID.test(value||'');
}
