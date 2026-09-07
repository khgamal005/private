import assert from 'node:assert/strict';
import test from 'node:test';
import {matchesBrowserState,stateDigest,stateCookieName,sameOriginMutation,trustedAuthorizeUrl,publicRequestOrigin,
  safeCompletionPath} from '../lib/social-connect-protocol.mjs';

test('OAuth callback requires the state of the initiating browser',()=>{
  const state='a'.repeat(64), other='b'.repeat(64);
  assert.equal(matchesBrowserState(state,stateDigest(state)),true);
  for(const saved of ['',undefined,stateDigest(other),state,'a']){
    assert.equal(matchesBrowserState(state,saved),false);
  }
  assert.equal(matchesBrowserState(other,stateDigest(state)),false);
  assert.notEqual(stateCookieName(state),stateCookieName(other));
  assert.equal(stateCookieName('invalid'),'');
});

test('cookie-authenticated mutations reject foreign origins and form posts',()=>{
  const req=(origin,type='application/json',site='same-origin')=>new Request(
    'https://odeir.com/api/tenant/social-connect/start',{
      method:'POST',headers:{origin,'content-type':type,'sec-fetch-site':site}
    });
  assert.equal(sameOriginMutation(req('https://odeir.com')),true);
  assert.equal(sameOriginMutation(req('https://attacker.example')),false);
  assert.equal(sameOriginMutation(req('https://odeir.com','text/plain')),false);
  assert.equal(sameOriginMutation(req('https://odeir.com','application/json','cross-site')),false);
});

test('authorization cannot send code or browser state to another callback',()=>{
  const url=new URL('https://www.facebook.com/v26.0/dialog/oauth');
  url.searchParams.set('state','c'.repeat(64));
  url.searchParams.set('redirect_uri','https://odeir.com/api/tenant/social-connect/callback');
  assert.equal(trustedAuthorizeUrl(url.toString(),'https://odeir.com').origin,'https://www.facebook.com');
  url.searchParams.set('redirect_uri','https://attacker.example/callback');
  assert.throws(()=>trustedAuthorizeUrl(url.toString(),'https://odeir.com'));
  assert.equal(safeCompletionPath('//attacker.example/path'),'/');
  assert.equal(safeCompletionPath('/tenant/demo/addons/social-connect?social_connect=connected'),
    '/tenant/demo/reports/campaigns?social_connect=connected');
});

test('Hostinger forwarding resolves only an approved HTTPS public origin',()=>{
  const headers={origin:'https://odeir.com','x-forwarded-host':'odeir.com',
    'x-forwarded-proto':'https','content-type':'application/json'};
  const request=new Request('http://0.0.0.0:3000/api/tenant/social-connect/start',{headers});
  assert.equal(publicRequestOrigin(request),'https://odeir.com');
  assert.equal(sameOriginMutation(request),true);
  for(const host of ['attacker.example','odeir.com,attacker.example','odeir.com:443']){
    const invalid=new Request(request.url,{headers:{...headers,'x-forwarded-host':host}});
    assert.equal(publicRequestOrigin(invalid),'');
    assert.equal(sameOriginMutation(invalid),false);
  }
});
