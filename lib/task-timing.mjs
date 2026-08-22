const FALLBACK_TIME_ZONE='UTC';
const CUSTOMER_FOLLOWUP_SOURCES=new Set([
  'lead_assignment',
  'opportunity_next_action',
  'activity_next_action',
  'lead_next_action',
  'sales_followup'
]);

function validDate(value){
  const date=value instanceof Date?value:new Date(value);
  return Number.isNaN(date.getTime())?null:date;
}

function dateFormatter(timeZone){
  try{
    return new Intl.DateTimeFormat('en-CA',{
      timeZone:timeZone||FALLBACK_TIME_ZONE,
      year:'numeric',
      month:'2-digit',
      day:'2-digit'
    });
  }catch{
    return new Intl.DateTimeFormat('en-CA',{
      timeZone:FALLBACK_TIME_ZONE,
      year:'numeric',
      month:'2-digit',
      day:'2-digit'
    });
  }
}

export function businessDateKey(value,timeZone=FALLBACK_TIME_ZONE){
  const date=validDate(value);
  if(!date)return null;
  const parts=dateFormatter(timeZone).formatToParts(date);
  const valueByType=Object.fromEntries(
    parts.map(part=>[part.type,part.value])
  );
  if(!valueByType.year||!valueByType.month||!valueByType.day)return null;
  return `${valueByType.year}-${valueByType.month}-${valueByType.day}`;
}

export function isSameBusinessDay(
  first,
  second,
  timeZone=FALLBACK_TIME_ZONE
){
  const firstDay=businessDateKey(first,timeZone);
  const secondDay=businessDateKey(second,timeZone);
  return Boolean(firstDay&&secondDay&&firstDay===secondDay);
}

export function isPastBusinessDay(
  dueAt,
  {now=new Date(),timeZone=FALLBACK_TIME_ZONE}={}
){
  const dueDay=businessDateKey(dueAt,timeZone);
  const currentDay=businessDateKey(now,timeZone);
  return Boolean(dueDay&&currentDay&&dueDay<currentDay);
}

export function isCustomerFollowupTask(task){
  if(!task||typeof task!=='object')return false;
  const source=task.taskSource
    ||task.source
    ||task.metadata?.source
    ||task.metadata_source;
  return Boolean(
    task.contactId
    ||task.contact_id
    ||CUSTOMER_FOLLOWUP_SOURCES.has(source)
  );
}

export function isTaskOverdue(
  task,
  {now=new Date(),timeZone=FALLBACK_TIME_ZONE}={}
){
  const dueAt=task?.dueAt??task?.due_at;
  if(isCustomerFollowupTask(task)){
    return isPastBusinessDay(dueAt,{now,timeZone});
  }
  const dueDate=validDate(dueAt);
  const currentDate=validDate(now);
  return Boolean(dueDate&&currentDate&&dueDate<currentDate);
}

export function isCompletedLateByDay(
  completedAt,
  dueAt,
  timeZone=FALLBACK_TIME_ZONE
){
  const completedDay=businessDateKey(completedAt,timeZone);
  const dueDay=businessDateKey(dueAt,timeZone);
  return Boolean(completedDay&&dueDay&&completedDay>dueDay);
}
