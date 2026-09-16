import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from './config';
import {trainingErrorMessage,trainingProblem} from './training-request.mjs';

export function trainingJson(body,status=200){
  return NextResponse.json(body,{status,headers:{
    'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
    'CDN-Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'
  }});
}

export async function trainingRpc(name,body,{token,publicAccess=false}={}){
  const bearer=token||(!publicAccess?(await cookies()).get(ACCESS_COOKIE)?.value:null);
  if(!publicAccess&&!bearer)throw trainingProblem('unauthenticated',401);
  let response;
  try{
    response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
      method:'POST',headers:{apikey:SUPABASE_KEY,...(bearer?{Authorization:`Bearer ${bearer}`} : {}),'Content-Type':'application/json'},
      body:JSON.stringify(body),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(15000)
    });
  }catch{throw trainingProblem('network_unavailable',503);}
  const data=await response.json().catch(()=>null);
  if(!response.ok){
    const code=String(data?.message||'request_failed').split('\n')[0];
    throw trainingProblem(code,response.status===401?401:/forbidden|permission|unauthorized/.test(code)?403:/not_found/.test(code)?404:409);
  }
  if(data===null)throw trainingProblem('network_unavailable',503);
  return data;
}

export function trainingFailure(error){
  const code=typeof error?.code==='string'?error.code:'request_failed';
  return trainingJson({error:trainingErrorMessage(code),retryable:code==='network_unavailable'},error?.status||503);
}
