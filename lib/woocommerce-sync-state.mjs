const TERMINAL_STATUSES=new Set([
  'success','completed','partial','failed'
]);

export function findWooSyncRun(snapshot,runId){
  const recent=Array.isArray(snapshot?.recentRuns)
    ?snapshot.recentRuns
    :[];
  const fallback=snapshot?.lastSync?[snapshot.lastSync]:[];
  return [...recent,...fallback].find(run=>run?.runId===runId)||null;
}

export async function pollWooSyncRun({
  fetchSnapshot,
  runId,
  wait,
  isActive=()=>true,
  maxAttempts=80,
  intervalMs=2500
}){
  for(let attempt=0;attempt<maxAttempts;attempt+=1){
    if(!isActive())return null;
    await wait(intervalMs,attempt);
    if(!isActive())return null;
    let snapshot;
    try{
      snapshot=await fetchSnapshot();
    }catch{
      // A transient status request must not be reported as a sync failure.
      continue;
    }
    const run=findWooSyncRun(snapshot,runId);
    if(run&&TERMINAL_STATUSES.has(run.status))return run;
  }
  return null;
}

export function wooSyncReviewedCount(run){
  const direct=Number(run?.fetchedCount);
  if(Number.isFinite(direct)&&direct>0)return direct;
  const totals=run?.totals||run?.stats?.totals||run?.stats||{};
  return Object.values(totals).reduce(
    (sum,value)=>sum+(Number.isFinite(Number(value))?Number(value):0),
    0
  );
}
