// The client-view SDK is isolated from Odeir's React/CSS tree and also supports
// mobile browsers. No credentials enter a URL, local storage or parent snapshot.
export async function startZoomSdk(config,root){
 if(!window.isSecureContext||!root)throw Error('zoom_sdk_browser_unsupported');
 const frame=document.createElement('iframe');frame.src='/zoom/embed';frame.title='اجتماع زووم';frame.allow='camera; microphone; display-capture; autoplay; fullscreen';frame.referrerPolicy='no-referrer';frame.style.cssText='width:100%;height:75vh;border:0';
 const finished=new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{cleanup();frame.remove();reject(Error('zoom_sdk_timeout'));},25000);
  const onMessage=event=>{if(event.origin!==window.location.origin||event.source!==frame.contentWindow)return;if(event.data?.type==='zoom-ready')frame.contentWindow.postMessage({type:'zoom-start',config},window.location.origin);if(event.data?.type==='zoom-joined'){cleanup();resolve();}if(event.data?.type==='zoom-error'){cleanup();frame.remove();reject(Error('zoom_sdk_join_failed'));}};
  function cleanup(){clearTimeout(timeout);window.removeEventListener('message',onMessage);}
  window.addEventListener('message',onMessage);
 });root.replaceChildren(frame);return finished;
}
