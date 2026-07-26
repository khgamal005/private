import {SUPABASE_KEY,SUPABASE_URL} from './config';

export async function publicRpc(name,body={}){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{
    method:'POST',
    headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
    body:JSON.stringify(body),
    cache:'no-store'
  });
  const text=await response.text();
  let data;
  try{data=JSON.parse(text)}catch{data={detail:text}}
  if(!response.ok){
    const error=new Error(data?.message||data?.detail||'request_failed');
    error.status=response.status;
    throw error;
  }
  return data;
}
