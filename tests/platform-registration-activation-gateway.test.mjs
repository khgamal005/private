import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const ROUTE='app/api/platform/registration-requests/route.js';
const GATEWAY='supabase/functions/odeir-registration-manual-activation/index.ts';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

test('Hostinger no longer needs a privileged Supabase key for manual activation',async()=>{
  const [route,gateway]=await Promise.all([read(ROUTE),read(GATEWAY)]);

  assert.doesNotMatch(route,/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(route,/const ACTIVATION_GATEWAY=/);
  assert.match(route,/apikey:SUPABASE_KEY/);
  assert.match(route,/Authorization:`Bearer \$\{token\}`/);
  assert.match(gateway,/SUPABASE_PUBLISHABLE_KEYS/);
  assert.match(gateway,/SUPABASE_SECRET_KEYS/);
  assert.match(gateway,/environmentKey\('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY'\)/);
  assert.doesNotMatch(gateway,/NEXT_PUBLIC_|ODEIR_REGISTRATION_INGRESS_TOKEN/);
});

test('the activation gateway supports rotated Supabase keys with a legacy fallback',async()=>{
  const gateway=await read(GATEWAY);
  const keyResolver=section(gateway,'function environmentKey','function looksLikeJwt');

  assert.match(keyResolver,/JSON\.parse\(keySet\)/);
  assert.match(keyResolver,/parsed\.default/);
  assert.match(keyResolver,/Deno\.env\.get\(legacyName\)/);
  assert.ok(
    keyResolver.indexOf('parsed.default')
      <keyResolver.indexOf('return (Deno.env.get(legacyName)')
  );
});

test('the activation gateway preserves user authorization and narrows service access',async()=>{
  const gateway=await read(GATEWAY);
  const userRpc=section(gateway,'async function rpcUser','async function rpcService');
  const serviceRpc=section(gateway,'async function rpcService','async function rpc<T>');

  assert.match(userRpc,/rpc<T>\(name,body,ANON_KEY,authorization,options\)/);
  assert.match(serviceRpc,/SERVICE_ROLE_KEY/);
  assert.match(serviceRpc,/looksLikeJwt\(SERVICE_ROLE_KEY\)/);
  assert.match(gateway,/v1_platform_registration_activation_attestation_prepare/);
  assert.match(gateway,/v1_registration_activation_attestation_complete/);
  assert.match(gateway,/v1_platform_registration_approve_and_activate/);
  assert.equal(
    (gateway.match(/v1_registration_activation_attestation_complete/g)||[]).length,
    1
  );
});

test('request and upstream responses are bounded before JSON parsing',async()=>{
  const [route,gateway]=await Promise.all([read(ROUTE),read(GATEWAY)]);
  const ingress=section(gateway,'Deno.serve','async function activate');
  const requestReader=section(
    gateway,'async function boundedRequestText','async function boundedResponseText'
  );
  const responseReader=section(
    gateway,'async function boundedResponseText','function decodeChunks'
  );

  assert.match(ingress,/content-length/);
  assert.ok(ingress.indexOf('boundedRequestText')<ingress.indexOf('JSON.parse'));
  for(const reader of [requestReader,responseReader]){
    assert.match(reader,/\.body\.getReader\(\)/);
    assert.match(reader,/total\+=value\.byteLength/);
    assert.match(reader,/if\(total>maxBytes\)/);
    assert.match(reader,/await reader\.cancel\(\)/);
    assert.doesNotMatch(reader,/\.text\(\)|\.json\(\)/);
  }
  assert.match(route,/boundedResponseText\(response,MAX_GATEWAY_RESPONSE_BYTES\)/);
});

test('lost responses and repeated clicks cannot create a second tenant',async()=>{
  const gateway=await read(GATEWAY);
  const replay=section(
    gateway,
    "if(status==='converted'&&isUuid(provisionedTenantId))",
    "const state=clean(valueOf(requestRow"
  );

  assert.match(replay,/await activate\(/);
  assert.doesNotMatch(replay,/attestation_prepare|verifyDirectoryInstitution/);
  assert.match(gateway,/requestId,expectedVersion,notes,payload/);
  assert.match(gateway,/return json\(\{ok:true,data:replay,replayed:true\}\)/);
});

test('the gateway fails closed without mutating existing tenant data',async()=>{
  const gateway=await read(GATEWAY);

  assert.match(gateway,/registration_activation_gateway_unavailable/);
  assert.match(gateway,/directory_identity_mismatch/);
  assert.match(gateway,/registration_attestation_unavailable/);
  assert.doesNotMatch(gateway,/insert into|update core\.|delete from/i);
  assert.doesNotMatch(gateway,/reef|ريف/i);
  assert.match(gateway,/cache-control':'no-store/);
  assert.match(gateway,/console\.error\('odeir-registration-manual-activation',normalized\.code\)/);
});
