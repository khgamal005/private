import assert from 'node:assert/strict';
import test from 'node:test';
import {isTrustedSupportRequestOrigin} from '../lib/support-request-origin.mjs';

function request({
  origin='https://odeir.com',
  fetchSite='same-origin',
  host='127.0.0.1:3000',
  forwardedHost='odeir.com',
  url='http://127.0.0.1:3000/api/support/tenant/create_ticket'
}={}){
  const headers=new Headers();
  if(origin!==null)headers.set('origin',origin);
  if(fetchSite!==null)headers.set('sec-fetch-site',fetchSite);
  if(host!==null)headers.set('host',host);
  if(forwardedHost!==null)headers.set('x-forwarded-host',forwardedHost);
  return {headers,url};
}

test('support accepts Odeir browser mutations behind the Hostinger proxy',()=>{
  assert.equal(isTrustedSupportRequestOrigin(request(),{allowLocal:false}),true);
  assert.equal(isTrustedSupportRequestOrigin(request({
    host:'odeir.com',forwardedHost:null,url:'https://odeir.com/api/support/tenant/create_ticket'
  }),{allowLocal:false}),true);
  assert.equal(isTrustedSupportRequestOrigin(request({
    origin:'https://www.odeir.com',host:'www.odeir.com',forwardedHost:null
  }),{allowLocal:false}),true);
  assert.equal(isTrustedSupportRequestOrigin(request({
    origin:'https://staging.odeir.com',host:'staging.odeir.com',forwardedHost:null
  }),{allowLocal:false}),true);
});

test('support keeps cross-site and forged proxy mutations fail closed',()=>{
  assert.equal(isTrustedSupportRequestOrigin(request({origin:null}),{allowLocal:false}),false);
  assert.equal(isTrustedSupportRequestOrigin(request({fetchSite:'cross-site'}),{allowLocal:false}),false);
  assert.equal(isTrustedSupportRequestOrigin(request({origin:'https://attacker.example'}),{allowLocal:false}),false);
  assert.equal(isTrustedSupportRequestOrigin(request({forwardedHost:'attacker.example'}),{allowLocal:false}),false);
  assert.equal(isTrustedSupportRequestOrigin(request({
    origin:'https://preview.example',host:'preview.example',forwardedHost:null
  }),{allowLocal:false}),false);
  assert.equal(isTrustedSupportRequestOrigin(request({
    origin:'http://odeir.com',host:'odeir.com',forwardedHost:null
  }),{allowLocal:false}),false);
});

test('local HTTP mutations are allowed only outside production',()=>{
  const local=request({
    origin:'http://localhost:3000',host:'localhost:3000',forwardedHost:null,
    url:'http://localhost:3000/api/support/tenant/create_ticket'
  });
  assert.equal(isTrustedSupportRequestOrigin(local,{allowLocal:true}),true);
  assert.equal(isTrustedSupportRequestOrigin(local,{allowLocal:false}),false);
});
