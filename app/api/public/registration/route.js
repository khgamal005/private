import {NextResponse} from 'next/server';
import {SUPABASE_KEY,SUPABASE_URL} from '../../../../lib/config';
import {SUPABASE_SECRET_KEY} from '../../../../lib/admin-config';

const MAX_BODY_BYTES=16*1024;
const EDGE_FUNCTION='odeir-registration-intake';

export async function POST(request){
  const ingressToken=process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'';
  const serverKey=SUPABASE_SECRET_KEY||'';

  try{
    const contentLength=Number(request.headers.get('content-length')||0);
    if(contentLength>MAX_BODY_BYTES){
      return NextResponse.json({ok:false,error:'request_too_large'},{status:413});
    }

    const rawBody=await request.text();
    if(Buffer.byteLength(rawBody,'utf8')>MAX_BODY_BYTES){
      return NextResponse.json({ok:false,error:'request_too_large'},{status:413});
    }

    let body={};
    try{body=JSON.parse(rawBody);}catch{
      return NextResponse.json({ok:false,error:'invalid_json'},{status:400});
    }
    if(!body||Array.isArray(body)||typeof body!=='object'){
      return NextResponse.json({ok:false,error:'invalid_json'},{status:400});
    }

    if(body.action==='challenge_bootstrap'){
      return NextResponse.json({
        ok:true,
        endpoint:`${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
        publishableKey:SUPABASE_KEY
      },{
        headers:{
          'Cache-Control':'private, no-store, max-age=0',
          'Referrer-Policy':'no-referrer'
        }
      });
    }

    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:ingressToken?SUPABASE_KEY:(serverKey||SUPABASE_KEY),
          'content-type':'application/json',
          ...(ingressToken?{'x-odeir-intake-token':ingressToken}:{}),
          'x-odeir-client-ip':clientIp(request),
          'x-odeir-user-agent':clean(request.headers.get('user-agent'),300)
        },
        body:JSON.stringify(body),
        cache:'no-store',
        signal:AbortSignal.timeout(10_000)
      }
    );

    const payload=await response.json().catch(()=>({
      ok:false,
      error:'service_unavailable'
    }));
    const status=response.ok?response.status:publicStatus(payload?.error,response.status);
    return NextResponse.json(payload,{status});
  }catch(error){
    console.error('odeir_registration_proxy_failed',{
      errorName:error instanceof Error?error.name:'UnknownError'
    });
    return NextResponse.json({ok:false,error:'service_unavailable'},{status:503});
  }
}

function clientIp(request){
  const forwarded=request.headers.get('x-vercel-forwarded-for')
    ||request.headers.get('x-forwarded-for')
    ||'';
  return clean(
    forwarded.split(',')[0]
      ||request.headers.get('x-real-ip')
      ||'unknown',
    80
  );
}

function clean(value,max){
  return String(value??'').replace(/[\u0000-\u001F\u007F]/g,' ')
    .trim().slice(0,max);
}

function publicStatus(code,fallback){
  if(code==='rate_limited')return 429;
  if(code==='request_too_large')return 413;
  if(code==='unauthorized'||code==='service_unavailable')return 503;
  if(Number(fallback)>=400&&Number(fallback)<500)return Number(fallback);
  return 503;
}
