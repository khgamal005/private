import {cookies} from 'next/headers';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {createTamaraPreflight} from '../../../../lib/tamara-preflight.mjs';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=createTamaraPreflight({
  supabaseUrl:SUPABASE_URL,supabaseKey:SUPABASE_KEY,
  getAccessToken:async()=>(await cookies()).get(ACCESS_COOKIE)?.value||null
});
