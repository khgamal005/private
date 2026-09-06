import assert from 'node:assert/strict';
import test from 'node:test';
import {
  base64UrlEncode,
  normalizedGraphVersion,
  safeReturnUrl,
  sha256Hex,
  validReturnPath,
  verifySignedRequest
} from '../supabase/functions/meta-oauth-v2/security.mjs';

async function signedRequest(payload,secret){
  const encodedPayload=base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const key=await crypto.subtle.importKey(
    'raw',new TextEncoder().encode(secret),
    {name:'HMAC',hash:'SHA-256'},false,['sign']
  );
  const signature=new Uint8Array(await crypto.subtle.sign(
    'HMAC',key,new TextEncoder().encode(encodedPayload)
  ));
  return `${base64UrlEncode(signature)}.${encodedPayload}`;
}

test('verifies a fresh HMAC-SHA256 provider signed_request',async()=>{
  const secret='test-secret-with-at-least-sixteen-characters';
  const now=1_788_000_000;
  const token=await signedRequest({
    algorithm:'HMAC-SHA256',user_id:'1234567890',issued_at:now-15
  },secret);
  const result=await verifySignedRequest(token,secret,{nowSeconds:now});
  assert.equal(result.userId,'1234567890');
});

test('rejects tampering, weak algorithms, and stale signed requests',async()=>{
  const secret='test-secret-with-at-least-sixteen-characters';
  const now=1_788_000_000;
  const valid=await signedRequest({
    algorithm:'HMAC-SHA256',user_id:'1234567890',issued_at:now-15
  },secret);
  await assert.rejects(
    verifySignedRequest(`${valid.slice(0,-1)}x`,secret,{nowSeconds:now}),
    /signed_request_invalid/
  );

  const weak=await signedRequest({
    algorithm:'HMAC-SHA1',user_id:'1234567890',issued_at:now-15
  },secret);
  await assert.rejects(
    verifySignedRequest(weak,secret,{nowSeconds:now}),
    /signed_request_invalid/
  );

  const stale=await signedRequest({
    algorithm:'HMAC-SHA256',user_id:'1234567890',issued_at:now-901
  },secret);
  await assert.rejects(
    verifySignedRequest(stale,secret,{nowSeconds:now,maxAgeSeconds:900}),
    /signed_request_invalid/
  );
});

test('allows only local return paths on the configured exact origin',()=>{
  for(const path of [
    '/tenant/demo/marketing',
    '/tenant/demo/marketing?tab=connections'
  ])assert.equal(validReturnPath(path),true);

  for(const path of [
    'https://evil.example/path','//evil.example/path','/\\evil','/ok\nnext'
  ])assert.equal(validReturnPath(path),false);

  assert.equal(
    safeReturnUrl('https://staging.odeir.com','/tenant/demo/marketing',{
      social_connect:'connected'
    }),
    'https://staging.odeir.com/tenant/demo/marketing?social_connect=connected'
  );
  assert.throws(
    ()=>safeReturnUrl('https://staging.odeir.com','//evil.example/path'),
    /invalid_return_path/
  );
});

test('pins a valid version and hashes state without echoing it',async()=>{
  assert.equal(normalizedGraphVersion('v26.0'),'v26.0');
  assert.throws(()=>normalizedGraphVersion('latest'),/invalid_graph_version/);
  assert.equal(
    await sha256Hex('state-value'),
    'a6b030ed072d78a2caca42e89ea32156d2568ec2988a048d9b684ce1e71ecd3b'
  );
});

