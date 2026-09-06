const MAX_BYTES=2_000_000;
export function privateAddress(input:string){
 const value=input.toLowerCase().replace(/^\[|\]$/g,'');
 if(value.includes(':')) return value==='::'||value==='::1'||value.startsWith('fc')||value.startsWith('fd')||value.startsWith('fe8')||value.startsWith('fe9')||value.startsWith('fea')||value.startsWith('feb')||value.startsWith('ff')||value.includes('::ffff:');
 const p=value.split('.').map(Number);
 return p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127||p[0]===198&&[18,19].includes(p[1]);
}
export function publicHttps(value:string){
 const url=new URL(value);
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443')throw new Error('knowledge_https_required');
 if(!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname.endsWith('.internal')||url.hostname.includes(':')||/^\d+[.\d]*$/.test(url.hostname))throw new Error('knowledge_private_url_rejected');
 return url;
}
async function validateDns(url:URL,signal:AbortSignal){
 signal.throwIfAborted();
 let onAbort:()=>void=()=>{};
 const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener('abort',onAbort,{once:true});});
 try{
  const results=await Promise.race([Promise.allSettled([Deno.resolveDns(url.hostname,'A'),Deno.resolveDns(url.hostname,'AAAA')]),aborted]);
  const addresses=results.flatMap(r=>r.status==='fulfilled'?r.value:[]);
  if(!addresses.length||addresses.some(privateAddress))throw new Error('knowledge_source_dns_rejected');
 }finally{signal.removeEventListener('abort',onAbort);}
}
export async function fetchText(value:string,timeout=12_000){
 let url=publicHttps(value);
 const controller=new AbortController(); const timer=setTimeout(()=>controller.abort(),timeout);
 try{
  for(let redirect=0;redirect<4;redirect++){
   await validateDns(url,controller.signal);
   const response=await fetch(url,{headers:{'user-agent':'Odeir-Knowledge/2.0 (+https://odeir.com)','accept':'text/html,application/rss+xml,application/atom+xml,application/xml,application/json','accept-language':'ar-SA,ar;q=0.9,en;q=0.5','cookie':'frontend_lang=ar_001'},redirect:'manual',signal:controller.signal});
   if(response.status>=300&&response.status<400){const next=response.headers.get('location');await response.body?.cancel();if(!next)throw new Error('knowledge_redirect_invalid');url=publicHttps(new URL(next,url).toString());continue;}
   if(!response.ok){await response.body?.cancel();throw new Error(`remote_http_${response.status}`);}
   const type=response.headers.get('content-type')||'';
   if(!/html|xml|rss|atom|json|text\/plain/i.test(type)){await response.body?.cancel();throw new Error('knowledge_content_type_invalid');}
   if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw new Error('knowledge_source_too_large');}
   const reader=response.body?.getReader();if(!reader)throw new Error('knowledge_empty_response');
   const chunks:Uint8Array[]=[];let length=0;
   try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES)throw new Error('knowledge_source_too_large');chunks.push(value);}}finally{await reader.cancel();}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   return {body:new TextDecoder().decode(bytes),type,url:url.toString()};
  }
  throw new Error('knowledge_too_many_redirects');
 }finally{clearTimeout(timer);}
}
