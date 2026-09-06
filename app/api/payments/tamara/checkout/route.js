import {cookies} from 'next/headers';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {tamaraGateway} from '../../../../../lib/tamara-gateway.mjs';
export const POST=request=>tamaraGateway({getToken:async()=>(await cookies()).get(ACCESS_COOKIE)?.value,url:SUPABASE_URL,key:SUPABASE_KEY})(request,'checkout');
