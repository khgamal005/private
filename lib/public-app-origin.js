import 'server-only';

const PRODUCTION_PUBLIC_ORIGIN='https://odeir.com';
const TRUSTED_PUBLIC_HOSTS=new Set([
  'odeir.com','www.odeir.com','staging.odeir.com'
]);

export function publicAppOrigin(){
  const configured=String(process.env.ODEIR_PUBLIC_APP_URL||'').trim();
  try{
    const url=new URL(configured||PRODUCTION_PUBLIC_ORIGIN);
    const localHost=url.hostname==='localhost'||url.hostname==='127.0.0.1';
    const production=process.env.NODE_ENV==='production';
    const trustedHttps=url.protocol==='https:'
      &&(
        production
          ?url.origin===PRODUCTION_PUBLIC_ORIGIN
          :TRUSTED_PUBLIC_HOSTS.has(url.hostname)
      )
      &&url.port==='';
    const trustedLocal=!production
      &&url.protocol==='http:'&&localHost;
    if(
      (trustedHttps||trustedLocal)
      &&!url.username&&!url.password
      &&url.pathname==='/'&&!url.search&&!url.hash
    )return url.origin;
  }catch{
    // A bad deployment value must not turn an internal request origin into a
    // public redirect or CSRF authority.
  }
  return PRODUCTION_PUBLIC_ORIGIN;
}
