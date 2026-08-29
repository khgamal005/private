const TRUSTED_SUPPORT_HOSTS=new Set([
  'odeir.com','www.odeir.com','staging.odeir.com'
]);

export function isTrustedSupportRequestOrigin(request,{allowLocal=process.env.NODE_ENV!=='production'}={}){
  const fetchSite=String(request?.headers?.get?.('sec-fetch-site')||'')
    .trim().toLowerCase();
  if(fetchSite&&fetchSite!=='same-origin')return false;

  const rawOrigin=String(request?.headers?.get?.('origin')||'').trim();
  if(!rawOrigin)return false;

  let source;
  try{source=new URL(rawOrigin);}catch{return false;}
  if(source.origin!==rawOrigin||source.username||source.password)return false;
  if(!trustedSource(source,{allowLocal}))return false;

  const candidates=[
    request.headers.get('host'),
    firstForwardedValue(request.headers.get('x-forwarded-host')),
    request.url
  ];
  return candidates.some(candidate=>targetHost(candidate)===source.host.toLowerCase());
}

function trustedSource(source,{allowLocal}){
  const hostname=source.hostname.toLowerCase();
  if(source.protocol==='https:'&&source.port===''&&TRUSTED_SUPPORT_HOSTS.has(hostname)){
    return true;
  }
  return Boolean(
    allowLocal
    &&source.protocol==='http:'
    &&['localhost','127.0.0.1'].includes(hostname)
  );
}

function firstForwardedValue(value){
  return String(value||'').split(',')[0].trim();
}

function targetHost(value){
  const normalized=String(value||'').trim();
  if(!normalized)return null;
  try{
    const parsed=normalized.includes('://')
      ?new URL(normalized)
      :new URL(`https://${normalized}`);
    return parsed.host.toLowerCase();
  }catch{return null;}
}
