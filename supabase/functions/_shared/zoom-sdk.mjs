export const ZOOM_SDK_VERSION='5.1.4';
export function sdkDecision({enabled,reviewed,appAccountId,accountId,role,personalIdentity,browserSupported=true}){
 if(!enabled)return {available:false,reason:'configuration_required',reasonLabel:'الدخول المضمن بانتظار إعداد التطبيق. استخدم الانضمام عبر زووم.'};
 if(!browserSupported)return {available:false,reason:'browser_unsupported'};
 if(accountId!==appAccountId&&!reviewed)return {available:false,reason:'app_review_required',reasonLabel:'الدخول المضمن ينتظر مراجعة التطبيق لدى زووم. الدخول الخارجي متاح.'};
 if((role===1||accountId!==appAccountId)&&!personalIdentity)return {available:false,reason:'personal_authorization_required',reasonLabel:'هذه الهوية تحتاج تفويضًا شخصيًا لدى زووم للدخول المضمن. استخدم الدخول الخارجي.'};
 return {available:true,role,requiresZak:role===1||accountId!==appAccountId};
}
const b64=value=>btoa(typeof value==='string'?value:String.fromCharCode(...value)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export async function sdkSignature({clientId,secret,meetingId,role,now=Date.now()}){
 if(!clientId||!secret||!/^\d{9,13}$/.test(String(meetingId))||![0,1].includes(role))throw Error('zoom_sdk_configuration_missing');
 const iat=Math.floor(now/1000)-30,exp=iat+1800;const header=b64(JSON.stringify({alg:'HS256',typ:'JWT'}));const payload=b64(JSON.stringify({appKey:clientId,mn:String(meetingId),role,iat,exp,tokenExp:exp}));
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);const signature=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${header}.${payload}`)));
 return `${header}.${payload}.${b64(signature)}`;
}
