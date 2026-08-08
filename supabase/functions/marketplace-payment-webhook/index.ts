import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MAX_BODY_BYTES=64*1024;

function json(status:number,body:Record<string,unknown>){
  return new Response(JSON.stringify(body),{
    status,
    headers:{
      'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store',
      'x-content-type-options':'nosniff'
    }
  });
}

Deno.serve(async(request:Request)=>{
  if(request.method!=='POST')return json(405,{ok:false,error:'method_not_allowed'});

  const timestamp=request.headers.get('x-marktone-timestamp')?.trim();
  const signature=request.headers.get('x-marktone-signature')?.trim();
  if(!timestamp||!signature)return json(401,{ok:false,error:'payment_confirmation_rejected'});

  const declaredLength=Number(request.headers.get('content-length')||0);
  if(Number.isFinite(declaredLength)&&declaredLength>MAX_BODY_BYTES){
    return json(413,{ok:false,error:'payload_too_large'});
  }

  try{
    const rawBody=await request.text();
    if(new TextEncoder().encode(rawBody).byteLength>MAX_BODY_BYTES){
      return json(413,{ok:false,error:'payload_too_large'});
    }

    const supabaseUrl=Deno.env.get('SUPABASE_URL');
    const serviceRoleKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if(!supabaseUrl||!serviceRoleKey){
      console.error('[marketplace-payment-webhook] Supabase runtime credentials are unavailable');
      return json(503,{ok:false,error:'service_unavailable'});
    }

    const response=await fetch(
      `${supabaseUrl}/rest/v1/rpc/v1_marketplace_payment_webhook_receive`,
      {
        method:'POST',
        headers:{
          apikey:serviceRoleKey,
          authorization:`Bearer ${serviceRoleKey}`,
          'content-type':'application/json'
        },
        body:JSON.stringify({
          p_timestamp:timestamp,
          p_signature:signature,
          p_raw_body:rawBody
        })
      }
    );

    if(!response.ok){
      console.warn('[marketplace-payment-webhook] Payment confirmation rejected',response.status);
      return json(401,{ok:false,error:'payment_confirmation_rejected'});
    }

    const result=await response.json();
    return json(200,{ok:true,order:result});
  }catch(error){
    console.error(
      '[marketplace-payment-webhook] Unexpected failure',
      error instanceof Error?error.name:'unknown_error'
    );
    return json(500,{ok:false,error:'internal_error'});
  }
});
