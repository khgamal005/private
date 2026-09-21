const FALLBACK_TIME_ZONE='UTC';
const CUSTOMER_FOLLOWUP_SOURCES=new Set([
  'lead_assignment',
  'opportunity_next_action',
  'activity_next_action',
  'lead_next_action',
  'sales_followup'
]);

function validDate(value){
  if(value==null||value==='')return null;
  const date=value instanceof Date?value:new Date(value);
  return Number.isNaN(date.getTime())?null:date;
}

const wallClockFormatters=new Map();

function wallClockFormatter(timeZone){
  const zone=timeZone||FALLBACK_TIME_ZONE;
  if(!wallClockFormatters.has(zone)){
    try{
      const formatter=new Intl.DateTimeFormat('en-GB',{
        timeZone:zone,calendar:'gregory',numberingSystem:'latn',
        year:'numeric',month:'2-digit',day:'2-digit',
        hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'
      });
      if(wallClockFormatters.size>=32)wallClockFormatters.clear();
      wallClockFormatters.set(zone,formatter);
    }catch{
      throw new Error('المنطقة الزمنية للمنشأة غير صالحة؛ راجع الإعدادات قبل حفظ الموعد');
    }
  }
  return wallClockFormatters.get(zone);
}

function wallClockParts(date,timeZone){
  return Object.fromEntries(wallClockFormatter(timeZone).formatToParts(date)
    .filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
}

// A datetime-local field has no timezone. Always interpret its wall clock in
// the tenant's IANA zone rather than the employee's browser timezone.
export function businessDateTimeInput(value,timeZone=FALLBACK_TIME_ZONE){
  const date=validDate(value);
  if(!date)return '';
  const parts=wallClockParts(date,timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export function businessDateTimeToInstant(
  value,
  timeZone=FALLBACK_TIME_ZONE,
  {originalInstant}={}
){
  const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value));
  if(!match)throw new Error('أدخل تاريخًا ووقتًا صالحين للموعد');
  const [,year,month,day,hour,minute]=match.map(Number);
  const wall=new Date(0);
  wall.setUTCFullYear(year,month-1,day);
  wall.setUTCHours(hour,minute,0,0);
  if(year<1||wall.getUTCFullYear()!==year||wall.getUTCMonth()!==month-1
     ||wall.getUTCDate()!==day||wall.getUTCHours()!==hour
     ||wall.getUTCMinutes()!==minute){
    throw new Error('أدخل تاريخًا ووقتًا صالحين للموعد');
  }
  // Preserve an unchanged existing timestamp, including its seconds and the
  // selected occurrence of a repeated DST hour, when another field is edited.
  const original=validDate(originalInstant);
  if(original&&businessDateTimeInput(original,timeZone)===value){
    return original.toISOString();
  }
  const candidates=new Set();
  // Sample both sides of the local date to discover the offsets at DST and
  // civil-time transitions. Round-trip every candidate; never shift a gap.
  for(const hours of [-36,-24,-12,0,12,24,36]){
    const probe=new Date(wall.getTime()+hours*3600000);
    const parts=wallClockParts(probe,timeZone);
    const local=new Date(0);
    local.setUTCFullYear(Number(parts.year),Number(parts.month)-1,Number(parts.day));
    local.setUTCHours(Number(parts.hour),Number(parts.minute),Number(parts.second),0);
    const candidate=new Date(wall.getTime()-(local.getTime()-probe.getTime()));
    if(businessDateTimeInput(candidate,timeZone)===value)candidates.add(candidate.toISOString());
  }
  if(!candidates.size){
    throw new Error('هذا الموعد غير موجود بسبب تغيير التوقيت الصيفي في منطقة المنشأة؛ اختر وقتًا آخر');
  }
  if(candidates.size>1){
    throw new Error('هذا الموعد يتكرر بسبب تغيير التوقيت الصيفي في منطقة المنشأة؛ اختر وقتًا خارج الساعة المتكررة');
  }
  return [...candidates][0];
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
