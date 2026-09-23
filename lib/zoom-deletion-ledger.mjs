import {createHmac,timingSafeEqual} from 'node:crypto';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields=['tenant_id','draft_id','course_id','topic_hash','unit_hash','header_hash','redacted_topic_hash','redacted_unit_hash','redacted_header_hash','deleted_at','deleted_by'].sort();
function signingKey(key){if(typeof key!=='string'||! /^[0-9a-f]{64,128}$/i.test(key)||key.length%2)throw Error('zoom_deletion_key_required');return Buffer.from(key,'hex');}
function validPayload(payload,tenantId){
 if(!uuid.test(tenantId)||!payload||payload.version!==1||payload.tenantId!==tenantId||!Array.isArray(payload.entries)||payload.entries.length>10000||Object.keys(payload).sort().join()!=='entries,tenantId,version')throw Error('zoom_deletion_ledger_invalid');
 const seen=new Set();
 for(const entry of payload.entries){
  if(!entry||Object.keys(entry).sort().join()!==fields.join()||entry.tenant_id!==tenantId||!uuid.test(entry.draft_id)||!uuid.test(entry.course_id)||!uuid.test(entry.deleted_by)||typeof entry.deleted_at!=='string'||!Number.isFinite(Date.parse(entry.deleted_at))||seen.has(entry.draft_id))throw Error('zoom_deletion_ledger_invalid');
  for(const key of fields.filter(key=>key.endsWith('_hash')))if(!/^[0-9a-f]{64}$/.test(entry[key]))throw Error('zoom_deletion_ledger_invalid');
  seen.add(entry.draft_id);
 }
 return payload;
}
export function signZoomDeletionLedger(tenantId,entries,key){
 const payload=validPayload({version:1,tenantId,entries},tenantId),serialized=JSON.stringify(payload);
 return {payload:serialized,signature:createHmac('sha256',signingKey(key)).update(serialized).digest('hex')};
}
export function verifyZoomDeletionLedger(envelope,tenantId,key){
 if(typeof envelope?.payload!=='string'||Buffer.byteLength(envelope.payload)>16000000||! /^[0-9a-f]{64}$/.test(envelope?.signature||''))throw Error('zoom_deletion_ledger_invalid');
 const expected=createHmac('sha256',signingKey(key)).update(envelope.payload).digest();
 if(!timingSafeEqual(expected,Buffer.from(envelope.signature,'hex')))throw Error('zoom_deletion_signature_invalid');
 let payload;try{payload=JSON.parse(envelope.payload);}catch{throw Error('zoom_deletion_ledger_invalid');}
 return validPayload(payload,tenantId);
}
export async function replayZoomDeletionLedger(envelope,tenantId,key,rpc){
 // Verify the ENTIRE tenant-scoped manifest before making the first write.
 const payload=verifyZoomDeletionLedger(envelope,tenantId,key),results=[];
 for(const entry of payload.entries)results.push(await rpc('v1_zoom_derivative_replay',{p_tenant_id:tenantId,p_tombstone:entry}));
 return results;
}
