// Operator-only maintenance tool. Never invoked by builds, CI, or the app.
import {readFile,writeFile,stat} from 'node:fs/promises';
import {signZoomDeletionLedger,replayZoomDeletionLedger} from '../lib/zoom-deletion-ledger.mjs';

const [mode,tenantId,file,expectedOrigin,ack]=process.argv.slice(2);
try{
 if(!['export','replay'].includes(mode)||!file||!expectedOrigin||!tenantId)throw Error('Usage: node scripts/zoom-deletion-ledger.mjs export|replay TENANT_UUID FILE EXACT_ORIGIN [--isolated-restore-approved]');
 if(mode==='replay'&&ack!=='--isolated-restore-approved')throw Error('An approved isolated restore is required before replay.');
 const url=new URL(process.env.ZOOM_LEDGER_SUPABASE_URL||'');
 if(url.origin!==expectedOrigin||url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('Exact HTTPS database origin required.');
 const credential=process.env.ZOOM_LEDGER_SERVICE_ROLE_KEY,key=process.env.ZOOM_DELETION_SIGNING_KEY;
 if(!credential||!key)throw Error('Service credential and separately held ledger signing key required.');
 const rpc=async(name,args)=>{
  const response=await fetch(`${url.origin}/rest/v1/rpc/${name}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',apikey:credential,authorization:`Bearer ${credential}`},body:JSON.stringify(args)});
  if(!response.ok)throw Error(`Ledger RPC failed (${response.status}); stop and review before opening the restore.`);
  return response.json();
 };
 if(mode==='export'){
  let after=null,entries=[];
  do{const page=await rpc('v1_zoom_derivative_ledger',{p_tenant_id:tenantId,p_after:after});entries.push(...page.entries);if(entries.length>10000)throw Error('Ledger exceeds reviewed batch limit.');if(!page.hasMore)break;const next=page.entries.at(-1)?.draft_id;if(!next||next===after)throw Error('Invalid ledger cursor.');after=next;}while(true);
  await writeFile(file,JSON.stringify(signZoomDeletionLedger(tenantId,entries,key),null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`Exported ${entries.length} derivative tombstones. Store outside database backups.`);
 }else{
  if((await stat(file)).size>20000000)throw Error('Ledger too large.');
  const results=await replayZoomDeletionLedger(JSON.parse(await readFile(file,'utf8')),tenantId,key,rpc);
  console.log(JSON.stringify({processed:results.length,changedCopies:results.reduce((n,r)=>n+(r.changedCopies||0),0),absentInBackup:results.filter(r=>r.status==='source_absent_in_backup').length,backupDeletion:'requires_storage_policy'}));
 }
}catch(error){console.error(error.message);process.exitCode=1;}
