export const ASSIGNMENT_METRIC_CONTRACT_VERSION='assignment-events-v1';
export const DEFAULT_REPORT_TIMEZONE='Asia/Riyadh';

const DATE_BASIS=Object.freeze({
  assignments:Object.freeze({
    field:'assigned_at',
    label:'تاريخ الإسناد فقط'
  }),
  team:Object.freeze({
    field:'assigned_at',
    label:'تاريخ الإسناد فقط'
  }),
  queue:Object.freeze({
    field:'queue_events',
    label:'تاريخ الرفع أو الإسناد أو أول استجابة'
  }),
  batches:Object.freeze({
    field:'batch_events',
    label:'تاريخ الرفع أو آخر توزيع'
  }),
  analytics:Object.freeze({
    field:'lead_events',
    label:'تاريخ الرفع أو الإسناد أو أول استجابة'
  })
});

export function leadIntakeDateBasis(section){
  return DATE_BASIS[section]||DATE_BASIS.assignments;
}

export function zonedDateKey(value,timeZone=DEFAULT_REPORT_TIMEZONE){
  if(!value)return null;
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return null;
  try{
    const parts=new Intl.DateTimeFormat('en-CA',{
      timeZone,
      year:'numeric',
      month:'2-digit',
      day:'2-digit'
    }).formatToParts(date);
    const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
    if(!values.year||!values.month||!values.day)return null;
    return `${values.year}-${values.month}-${values.day}`;
  }catch{
    return null;
  }
}

export function dateMatches(
  values,
  filters,
  timeZone=DEFAULT_REPORT_TIMEZONE
){
  if(!filters?.from&&!filters?.to)return true;
  return values.some(value=>{
    const day=zonedDateKey(value,timeZone);
    if(!day)return false;
    if(filters.from&&day<filters.from)return false;
    if(filters.to&&day>filters.to)return false;
    return true;
  });
}

export function assignmentDateMatches(
  assignment,
  filters,
  timeZone=DEFAULT_REPORT_TIMEZONE
){
  return dateMatches([assignment?.assignedAt],filters,timeZone);
}
