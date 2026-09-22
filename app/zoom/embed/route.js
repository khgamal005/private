import {randomBytes} from 'node:crypto';
import {ZOOM_SDK_VERSION} from '../../../supabase/functions/_shared/zoom-sdk.mjs';
export const dynamic='force-dynamic';
export async function GET(){
 const nonce=randomBytes(20).toString('base64');const version=ZOOM_SDK_VERSION;
 const scripts=['react.min.js','react-dom.min.js','redux.min.js','redux-thunk.min.js','lodash.min.js'].map(name=>`<script src="https://source.zoom.us/${version}/lib/vendor/${name}"></script>`).join('');
 return new Response(`<!doctype html><html lang="ar"><head><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>اجتماع زووم</title></head><body><div id="zmmtg-root"></div>${scripts}<script src="https://source.zoom.us/zoom-meeting-${version}.min.js"></script><script nonce="${nonce}">
let started=false;const send=type=>parent.postMessage({type},location.origin);
addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin||event.data?.type!=='zoom-start'||started)return;started=true;const c=event.data.config;
try{ZoomMtg.setZoomJSLib('https://source.zoom.us/${version}/lib','/av');ZoomMtg.preLoadWasm();ZoomMtg.prepareWebSDK();ZoomMtg.i18n.load('ar-SA');ZoomMtg.init({leaveUrl:location.origin+'/training/'+encodeURIComponent(c.tenantSlug)+'/zoom',patchJsMedia:true,success:()=>ZoomMtg.join({sdkKey:c.clientId,signature:c.signature,meetingNumber:c.meetingNumber,passWord:c.password||'',userName:c.name,userEmail:c.email,tk:c.registrantToken||'',zak:c.zak||'',success:()=>send('zoom-joined'),error:()=>send('zoom-error')}),error:()=>send('zoom-error')});}catch{send('zoom-error');}});send('zoom-ready');
</script></body></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-frame-options':'SAMEORIGIN','content-security-policy':`frame-ancestors 'self'; base-uri 'none'; object-src 'none'; script-src 'nonce-${nonce}' https://source.zoom.us 'wasm-unsafe-eval';`}});
}
