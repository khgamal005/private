import {cookies} from 'next/headers';
import {timingSafeEqual} from 'node:crypto';
import {NextResponse} from 'next/server';
import {zoomGateway} from '../../../../lib/zoom-server';
export const dynamic='force-dynamic';
export async function GET(request){
 const jar=await cookies();const callback=new URL(request.url);let saved;
 try{saved=JSON.parse(jar.get('odeir_zoom_oauth')?.value||'null');}catch{saved=null;}
 jar.delete({name:'odeir_zoom_oauth',path:'/api/zoom'});
 const fallback='/';let target=fallback;
 try{
  const state=callback.searchParams.get('state')||'';
  if(!saved||!/^[a-z0-9][a-z0-9-]{1,79}$/.test(saved.tenantSlug)||!/^[a-f0-9]{64}$/.test(state)||!/^[a-f0-9]{64}$/.test(saved.state)||!timingSafeEqual(Buffer.from(state),Buffer.from(saved.state)))throw Error();
  target=`/tenant/${saved.tenantSlug}/addons/zoom`;
  const result=await zoomGateway('complete',{tenantSlug:saved.tenantSlug,state,code:callback.searchParams.get('code'),cancelled:callback.searchParams.has('error')});
  if(result.returnPath!==target)throw Error();
  target+='?view=accounts&zoom='+encodeURIComponent(result.outcome);
 }catch{target+=(target.includes('?')?'&':'?')+'view=accounts&zoom=failed';}
 const response=NextResponse.redirect(new URL(target,request.url),303);response.headers.set('cache-control','no-store');response.headers.set('referrer-policy','no-referrer');return response;
}
