const ms=value=>typeof value==='number'?value:Date.parse(value);
export function unionIntervals(intervals){
 const sorted=intervals.map(([a,b])=>[ms(a),ms(b)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b)&&b>a).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
 const result=[];for(const span of sorted){const last=result.at(-1);if(last&&span[0]<=last[1])last[1]=Math.max(last[1],span[1]);else result.push([...span]);}return result;
}
export function subtractIntervals(intervals,breaks){
 let result=unionIntervals(intervals);for(const [a,b] of unionIntervals(breaks))result=result.flatMap(([x,y])=>b<=x||a>=y?[[x,y]]:[[x,Math.min(a,y)],[Math.max(x,b),y]].filter(([s,e])=>e>s));return result;
}
export function attendanceEvidence(intervals,teachingWindow,breaks=[],{complete=false}={}){
 const base=subtractIntervals([teachingWindow],breaks);const seconds=parts=>parts.reduce((sum,[a,b])=>sum+(b-a)/1000,0);
 const denominator=seconds(base);
 const incomplete=intervals.some(x=>x.leftAt==null||x.joinedAt==null);
 const present=intervals.filter(x=>x.kind!=='waiting_room'&&x.leftAt!=null&&x.joinedAt!=null).map(x=>[ms(x.joinedAt),ms(x.leftAt)]);
 const clipped=[];for(const [a,b] of present)for(const [x,y] of base){if(Math.max(a,x)<Math.min(b,y))clipped.push([Math.max(a,x),Math.min(b,y)]);}
 const merged=unionIntervals(clipped);const attendedSeconds=seconds(merged);
 return {attendedSeconds,requiredSeconds:denominator,percent:denominator>0?Math.min(100,100*attendedSeconds/denominator):null,
  quality:complete&&!incomplete&&denominator>0?'complete':'incomplete',firstJoin:merged[0]?.[0]??null,lastLeave:merged.at(-1)?.[1]??null};
}
export function matchParticipant(participant,registrations){
 const by=(predicate)=>registrations.filter(predicate);
 let candidates=[];
 if(participant.registrant_id)candidates=by(r=>r.registrantId===participant.registrant_id);
 if(!candidates.length&&participant.user_id)candidates=by(r=>r.verifiedZoomUserId===participant.user_id);
 if(!candidates.length&&participant.user_email)candidates=by(r=>r.emailVerified&&r.email?.toLowerCase()===participant.user_email.toLowerCase());
 return candidates.length===1?{enrollmentId:candidates[0].enrollmentId,quality:'matched'}:{enrollmentId:null,quality:candidates.length?'ambiguous':'unmatched'};
}
export function csvCell(value){const text=String(value??'');return `"${(/^[\s]*[=+@\-\t\r]/u.test(text)?"'":'')+text.replaceAll('"','""')}"`;}
export function reportCsv(rows){return '\ufeff'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n');}
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export async function sha256(value){return hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)));}
export async function hmac(secret,value){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return hex(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(value)));}
export function constantEqual(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}
export async function verifyWebhook(raw,headers,secret,now=Date.now()){
 const timestamp=headers.get('x-zm-request-timestamp')||'';const signature=headers.get('x-zm-signature')||'';
 if(!secret||!/^\d{10}$/.test(timestamp)||Math.abs(now/1000-Number(timestamp))>300||!/^v0=[0-9a-f]{64}$/.test(signature))return false;
 return constantEqual(signature,`v0=${await hmac(secret,`v0:${timestamp}:${raw}`)}`);
}
export function eventProjection(event){
 const object=event.payload?.object||{};const participant=object.participant||{};
 return {event:event.event,eventTs:event.event_ts,accountId:event.payload?.account_id||event.payload?.account_id,
  meetingId:object.id==null?null:String(object.id),uuid:object.uuid||null,hostId:object.host_id||null,
  startTime:object.start_time||null,endTime:object.end_time||null,
  participant:{id:participant.id||null,userId:participant.user_id||null,registrantId:participant.registrant_id||null,
   email:participant.email||participant.user_email||null,name:participant.user_name||participant.name||null,
   joinTime:participant.join_time||null,leaveTime:participant.leave_time||null},
  deauthorization:event.event==='app_deauthorized',userId:event.payload?.user_id||null};
}
