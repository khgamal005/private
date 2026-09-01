const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG=/^[a-z0-9](?:[a-z0-9_-]{0,118}[a-z0-9])?$/;

const PRIVATE_HEADERS={
  'Cache-Control':'private, no-store, no-cache, max-age=0, must-revalidate',
  'Referrer-Policy':'no-referrer',
  'X-Content-Type-Options':'nosniff',
  'Content-Security-Policy':"default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  'Permissions-Policy':'camera=(), microphone=(), geolocation=()'
};

export function GET(request){
  const url=new URL(request.url);
  const slugs=url.searchParams.getAll('slug');
  const attempts=url.searchParams.getAll('attempt');
  if(slugs.length!==1||attempts.length!==1
     ||!SLUG.test(slugs[0])||!UUID.test(attempts[0])){
    return new Response(null,{status:400,headers:PRIVATE_HEADERS});
  }

  // All other query keys are provider-owned presentation fields and are
  // deliberately ignored. This handler cannot inspect or mutate payment
  // state. Infrastructure access logs must also redact the inbound query,
  // because they run before application-level cleanup.
  const location='/tenant/'+encodeURIComponent(slugs[0])
    +'/payments/paymob/return?attempt='+encodeURIComponent(attempts[0]);
  return new Response(null,{
    status:303,
    headers:{...PRIVATE_HEADERS,Location:location}
  });
}
