import {cookies} from 'next/headers';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from './config';
import {trainingProblem} from './training-request.mjs';

export async function zoomGateway(action,body){
 const token=(await cookies()).get(ACCESS_COOKIE)?.value;
 if(!token)throw trainingProblem('zoom_forbidden',401);
 let response;try{response=await fetch(`${SUPABASE_URL}/functions/v1/zoom-connect/${action}`,{method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(action==='sync_hosts'?55000:35000)});}catch{throw trainingProblem('zoom_request_failed',503);}
 const result=await response.json().catch(()=>null);
 if(!response.ok||!result)throw trainingProblem(result?.error||'zoom_request_failed',response.status||503);
 return result;
}
