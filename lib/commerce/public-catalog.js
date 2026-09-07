import 'server-only';
import {SUPABASE_URL,SUPABASE_KEY} from '../config';

/** Public-safe commercial data only. Never send a service-role credential. */
export async function getPublicCommercialCatalog(){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v1_public_independent_commercial_catalog`,{
    method:'POST',headers:{apikey:SUPABASE_KEY,'Content-Type':'application/json'},
    body:'{}',cache:'no-store',signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw new Error('commercial_catalog_unavailable');
  const data=await response.json();
  if(!Array.isArray(data?.plans)||!Array.isArray(data?.addons))throw new Error('commercial_catalog_invalid');
  return data;
}
