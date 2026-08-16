const ISO_DATE=/^\d{4}-\d{2}-\d{2}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REPORT_DATE_PRESETS=[
  {key:'today',label:'اليوم'},
  {key:'yesterday',label:'أمس'},
  {key:'last7',label:'آخر 7 أيام'},
  {key:'last30',label:'آخر 30 يومًا'},
  {key:'this_month',label:'هذا الشهر'},
  {key:'previous_month',label:'الشهر السابق'}
];

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

export function reportPresetRange(period,today=dateParts()){
  if(!validDate(today))return null;
  switch(period){
    case 'today':
      return {from:today,to:today};
    case 'yesterday':{
      const yesterday=addDays(today,-1);
      return {from:yesterday,to:yesterday};
    }
    case 'last7':
      return {from:addDays(today,-6),to:today};
    case 'last30':
      return {from:addDays(today,-29),to:today};
    case 'this_month':
      return {from:`${today.slice(0,7)}-01`,to:today};
    case 'previous_month':{
      const to=addDays(`${today.slice(0,7)}-01`,-1);
      return {from:`${to.slice(0,7)}-01`,to};
    }
    default:
      return null;
  }
}

export function resolveReportRange(searchParams={},options={}){
  const today=validDate(options.today)
    ?options.today
    :dateParts(options.timeZone||'Asia/Riyadh');
  const defaultPeriod=REPORT_DATE_PRESETS.some(
    preset=>preset.key===options.defaultPeriod
  )?options.defaultPeriod:'last30';
  const requestedPeriod=REPORT_DATE_PRESETS.some(
    preset=>preset.key===first(searchParams.period)
  )?first(searchParams.period):null;
  const hasManualRange=validDate(first(searchParams.from))
    ||validDate(first(searchParams.to));
  const period=requestedPeriod||(!hasManualRange?defaultPeriod:'custom');
  const preset=reportPresetRange(period,today);
  let to=preset?.to||first(searchParams.to);
  let from=preset?.from||first(searchParams.from);
  if(!validDate(to))to=today;
  if(to>today)to=today;
  if(!validDate(from))from=addDays(to,-29);
  if(from>to)from=addDays(to,-29);
  if(inclusiveDays(from,to)>366)from=addDays(to,-365);
  const staffId=first(searchParams.staffId);
  const page=Math.max(1,Math.min(1000,Number(first(searchParams.page))||1));
  return {
    from,
    to,
    period:preset?period:'custom',
    staffId:UUID.test(staffId||'')?staffId:null,
    page,
    limit:50
  };
}

export function resolveDashboardRange(searchParams={},options={}){
  const today=validDate(options.today)
    ?options.today
    :dateParts(options.timeZone||'Asia/Riyadh');
  return {
    ...resolveReportRange(searchParams,{
      ...options,
      today,
      defaultPeriod:'this_month'
    }),
    today
  };
}

export function reportQuery(range,extra={}){
  const params=new URLSearchParams({
    from:range.from,
    to:range.to
  });
  if(range?.period)params.set('period',range.period);
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
