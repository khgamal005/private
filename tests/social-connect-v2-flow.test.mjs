import assert from 'node:assert/strict';
import test from 'node:test';
import {connectionNeedsReauthorization,loadDeletionStatus,runConnectionAction} from '../lib/social-connect-v2.mjs';
import {addonHref} from '../lib/addons/placement-registry.js';

test('a failed start releases the busy state and permits a successful retry',async()=>{
  let busy=false;
  let error='';
  let destination='';
  let attempts=0;
  const run=()=>runConnectionAction({
    name:'start',slug:'example-center',
    fetcher:async(url,options)=>{
      assert.equal(url,'/api/tenant/social-connect/start');
      assert.deepEqual(JSON.parse(options.body),{tenantSlug:'example-center'});
      attempts++;
      return attempts===1
        ?new Response(JSON.stringify({error:'service_unavailable'}),{status:503})
        :new Response(JSON.stringify({authorizeUrl:'https://www.facebook.com/v26.0/dialog/oauth?state=test'}));
    },
    navigate:url=>{destination=url;},
    onStart(){busy=true;error='';},
    onDisconnected(){assert.fail('start must not disconnect');},
    onError:code=>{error=code;},
    onSettled(){busy=false;}
  });
  await run();
  assert.equal(busy,false);
  assert.equal(error,'service_unavailable');
  assert.equal(destination,'');
  await run();
  assert.equal(attempts,2);
  assert.equal(error,'');
  assert.equal(busy,true);
  assert.equal(destination,'https://www.facebook.com/v26.0/dialog/oauth?state=test');
});

test('network and invalid redirect failures release controls without navigation',async()=>{
  for(const fetcher of [
    async()=>{throw new TypeError('network unavailable');},
    async()=>new Response(JSON.stringify({authorizeUrl:'https://example.com/'}))
  ]){
    let busy=false;
    let error='';
    await runConnectionAction({
      name:'start',slug:'example-center',fetcher,
      navigate(){assert.fail('unexpected navigation');},
      onStart(){busy=true;},
      onDisconnected(){assert.fail('unexpected disconnect');},
      onError:code=>{error=code;},
      onSettled(){busy=false;}
    });
    assert.equal(busy,false);
    assert.ok(error);
  }
});

test('selection sends only the tenant and chosen Meta account',async()=>{
  let completed=false;
  await runConnectionAction({
    name:'select',slug:'example-center',payload:{externalAccountId:'123456789'},
    fetcher:async(url,options)=>{
      assert.equal(url,'/api/tenant/social-connect/select');
      assert.deepEqual(JSON.parse(options.body),{
        tenantSlug:'example-center',externalAccountId:'123456789'
      });
      return new Response(JSON.stringify({ok:true,status:'selected'}));
    },
    navigate(){assert.fail('selection must not navigate');},
    onStart(){},onDisconnected(){assert.fail('selection must not disconnect');},
    onSuccess(result){completed=result.status==='selected';},
    onError:code=>assert.fail(code),onSettled(){}
  });
  assert.equal(completed,true);
});

test('manual sync sends the exact selected report range',async()=>{
  await runConnectionAction({
    name:'sync',slug:'example-center',
    payload:{dateFrom:'2026-07-01',dateTo:'2026-09-01'},
    fetcher:async(url,options)=>{
      assert.equal(url,'/api/tenant/social-connect/sync');
      assert.deepEqual(JSON.parse(options.body),{
        tenantSlug:'example-center',dateFrom:'2026-07-01',dateTo:'2026-09-01'
      });
      return new Response(JSON.stringify({ok:true,status:'completed'}));
    },
    navigate(){assert.fail('sync must not navigate');},onStart(){},
    onDisconnected(){assert.fail('sync must not disconnect');},onSuccess(){},
    onError:code=>assert.fail(code),onSettled(){}
  });
});

test('either expired token or expired data access requires reauthorization',()=>{
  const now=Date.parse('2026-09-06T12:00:00Z');
  const future='2026-09-07T12:00:00Z';
  const past='2026-09-05T12:00:00Z';
  assert.equal(connectionNeedsReauthorization({status:'connected',tokenExpiresAt:past,dataAccessExpiresAt:future},now),true);
  assert.equal(connectionNeedsReauthorization({status:'connected',tokenExpiresAt:future,dataAccessExpiresAt:past},now),true);
  assert.equal(connectionNeedsReauthorization({status:'connected',tokenExpiresAt:future,dataAccessExpiresAt:future},now),false);
  assert.equal(connectionNeedsReauthorization({status:'disabled',tokenExpiresAt:past},now),false);
});

test('a well-formed deletion code is not confirmation without a provider lookup',async()=>{
  const code='a'.repeat(48);
  let calls=0;
  const result=await loadDeletionStatus({code,supabaseUrl:'https://example.supabase.co',fetcher:async(url,options)=>{
    calls++;
    assert.equal(url.pathname,'/functions/v1/meta-oauth-v2/data-deletion/status');
    assert.equal(url.searchParams.get('code'),code);
    assert.equal(options.cache,'no-store');
    assert.equal(options.headers,undefined);
    return new Response(JSON.stringify({status:'not_found'}),{status:404});
  }});
  assert.equal(calls,1);
  assert.deepEqual(result,{status:'not_found'});
});

test('deletion lookup fails honestly and accepts only verified recognized statuses',async()=>{
  const base={code:'b'.repeat(48),supabaseUrl:'https://example.supabase.co'};
  assert.deepEqual(await loadDeletionStatus({...base,fetcher:async()=>new Response(JSON.stringify({ok:true,status:'completed'}))}),{status:'completed'});
  assert.deepEqual(await loadDeletionStatus({...base,fetcher:async()=>new Response(JSON.stringify({status:'completed'}))}),{status:'unavailable'});
  assert.deepEqual(await loadDeletionStatus({...base,fetcher:async()=>new Response('{}',{status:503})}),{status:'unavailable'});
  assert.deepEqual(await loadDeletionStatus({...base,code:'invalid',fetcher:async()=>{assert.fail('invalid code must not fetch');}}),{status:'invalid_code'});
});

test('the add-on opens its dedicated connection page',()=>{
  assert.equal(addonHref('example-center',{key:'social_connect'}),'/tenant/example-center/reports/campaigns');
  assert.equal(addonHref('example-center',{key:'social_connect',actions:{openPlacementKey:'tenant.social_connect'}}),'/tenant/example-center/reports/campaigns');
});
