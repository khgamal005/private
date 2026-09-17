import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as protocol from '../lib/google-ads/protocol.mjs';
import {boundedJson, publicError} from '../supabase/functions/google-ads-connect/handler.mjs';

// Execute the actual route with injected platform boundaries, retaining the real
// request/response protocol and validation helpers. No Next server or network required.
const source = readFileSync(new URL('../app/api/tenant/google-ads/[action]/route.js', import.meta.url), 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '').replace(/\bexport\s+/g, '');
const BASE = 'https://odeir.com';
const CALLBACK = `${BASE}/api/tenant/google-ads/callback`;
const ACCESS_COOKIE = 'fixture_access';
const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});

function harness({token = 'session-secret', upstream} = {}) {
  const jar = new Map(token ? [[ACCESS_COOKIE, token]] : []);
  const edgeCalls = [];
  function withCookies(response) {
    response.cookieWrites = [];
    response.cookies = {set(name, value, options) {response.cookieWrites.push({name, value, options});}};
    return response;
  }
  const NextResponse = {
    json(body, options) {return withCookies(new Response(JSON.stringify(body), options));},
    redirect(url, status) {return withCookies(new Response(null, {status, headers: {location: String(url)}}));}
  };
  const route = vm.runInNewContext(`(() => {${source}\nreturn {GET, POST};})()`, {
    ...protocol, boundedJson, publicError, NextResponse, URL, URLSearchParams, AbortSignal,
    crypto: webcrypto, SUPABASE_URL: 'https://fixture.supabase.invalid', SUPABASE_KEY: 'public-anon-key', ACCESS_COOKIE,
    cookies: async () => ({get(name) {return jar.has(name) ? {value: jar.get(name)} : undefined;}}),
    fetch: async (url, options) => {
      const call = {url, options, payload: JSON.parse(options.body)};
      edgeCalls.push(call);
      return upstream ? upstream(call) : json({ok: true});
    }
  }, {filename: 'google-ads-route.fixture.js'});
  return {route, jar, edgeCalls, applyCookies(response) {
    for (const cookie of response.cookieWrites) {
      if (cookie.options.maxAge === 0) jar.delete(cookie.name);
      else jar.set(cookie.name, cookie.value);
    }
  }};
}
function postRequest(action, body = {tenantSlug: 'demo-a'}, headers = {}) {
  return new Request(`${BASE}/api/tenant/google-ads/${action}`, {
    method: 'POST', headers: {origin: BASE, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', ...headers},
    body: JSON.stringify(body)
  });
}
const params = action => ({params: Promise.resolve({action})});
function authorizeUrl(payload, overrides = {}) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({client_id: 'fixture-google-client', response_type: 'code',
    scope: 'https://www.googleapis.com/auth/adwords', redirect_uri: CALLBACK,
    state: payload.state, code_challenge: payload.codeChallenge, code_challenge_method: 'S256',
    ...overrides}).toString();
  return url.toString();
}

test('route rejects unauthenticated requests before contacting the Edge function', async () => {
  const fixture = harness({token: null});
  const response = await fixture.route.POST(postRequest('assets'), params('assets'));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {ok: false, error: 'authentication_required'});
  assert.equal(fixture.edgeCalls.length, 0);
});

test('cross-origin, cross-site, missing-origin and unsupported content types never reach Edge', async () => {
  const fixture = harness();
  const variations = [
    {origin: 'https://evil.invalid'},
    {origin: ''},
    {'sec-fetch-site': 'cross-site'},
    {'content-type': 'text/plain'},
    {'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'https'},
    {'x-forwarded-host': 'odeir.com', 'x-forwarded-proto': 'http'}
  ];
  for (const headers of variations) {
    const response = await fixture.route.POST(postRequest('sync', {tenantSlug: 'demo-a'}, headers), params('sync'));
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.equal(fixture.edgeCalls.length, 0);
});

test('both Reef aliases, malformed tenants and unknown actions are blocked before any Edge request', async () => {
  const fixture = harness();
  for (const tenantSlug of ['reefskills', 'reefskills', '../demo-a', 'Demo-A', 'a', '']) {
    const response = await fixture.route.POST(postRequest('start', {tenantSlug}), params('start'));
    assert.equal(response.status, 403, tenantSlug);
  }
  const response = await fixture.route.POST(postRequest('mutateCampaign'), params('mutateCampaign'));
  assert.equal(response.status, 404);
  assert.equal(fixture.edgeCalls.length, 0);
});

test('start generates independent state, keeps verifier in a secure state-specific cookie and checks authorize URL', async () => {
  const fixture = harness({upstream: call => json({ok: true, authorizeUrl: authorizeUrl(call.payload)})});
  const requestBody = {tenantSlug: 'demo-a', state: 'attacker-state', codeChallenge: 'attacker-challenge', codeVerifier: 'attacker-verifier', returnPath: 'https://evil.invalid', accessToken: 'attacker-token'};
  const first = await fixture.route.POST(postRequest('start', requestBody), params('start'));
  const second = await fixture.route.POST(postRequest('start', requestBody), params('start'));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  const firstCall = fixture.edgeCalls[0], secondCall = fixture.edgeCalls[1];
  assert.match(firstCall.payload.state, /^[a-f0-9]{64}$/);
  assert.notEqual(firstCall.payload.state, secondCall.payload.state);
  assert.deepEqual(Object.keys(firstCall.payload).sort(), ['codeChallenge', 'returnPath', 'state', 'tenantSlug']);
  assert.equal(firstCall.payload.returnPath, '/tenant/demo-a/reports/google-ads');
  assert.equal(firstCall.options.headers.authorization, 'Bearer session-secret');
  assert.equal(firstCall.options.cache, 'no-store');
  assert.equal(firstCall.options.headers.apikey, 'public-anon-key');
  const cookie = first.cookieWrites[0];
  assert.equal(first.cookieWrites.length, 2);
  assert.equal(first.cookieWrites[1].name, cookie.name+'_tenant');
  assert.equal(first.cookieWrites[1].value, 'demo-a');
  assert.deepEqual(first.cookieWrites[1].options, cookie.options);
  assert.equal(cookie.name, protocol.stateCookieName(firstCall.payload.state));
  assert.notEqual(cookie.name, second.cookieWrites[0].name);
  assert.equal(protocol.pkceChallenge(cookie.value), firstCall.payload.codeChallenge);
  assert.equal(cookie.options.httpOnly, true);
  assert.equal(cookie.options.secure, true);
  assert.equal(cookie.options.sameSite, 'lax');
  assert.equal(cookie.options.path, '/');
  assert.equal(cookie.options.maxAge, 600);
  assert.equal('domain' in cookie.options, false);
  const publicBody = await first.json();
  assert.deepEqual(Object.keys(publicBody).sort(), ['authorizeUrl', 'ok']);
  assert.equal(JSON.stringify(publicBody).includes(cookie.value), false);
  assert.match(first.headers.get('cache-control'), /no-store/);
  assert.equal(first.headers.get('referrer-policy'), 'no-referrer');
});

test('untrusted authorization targets or changed redirect/state cannot set a verifier cookie', async () => {
  for (const mode of ['host', 'redirect', 'state']) {
    const fixture = harness({upstream: call => {
      let url = authorizeUrl(call.payload, mode === 'redirect' ? {redirect_uri: 'https://evil.invalid/callback'} : mode === 'state' ? {state: 'f'.repeat(64)} : {});
      if (mode === 'host') url = url.replace('accounts.google.com', 'evil.invalid');
      return json({ok: true, authorizeUrl: url});
    }});
    const response = await fixture.route.POST(postRequest('start'), params('start'));
    assert.equal(response.status, 503);
    assert.equal(response.cookieWrites.length, 0);
    assert.equal((await response.json()).ok, false);
  }
});

test('callback missing session, mismatched state, malformed state or missing verifier cannot exchange code', async () => {
  const transaction = protocol.newBrowserTransaction();
  for (const mode of ['session', 'state', 'malformed', 'verifier']) {
    const fixture = harness({token: mode === 'session' ? null : 'session-secret'});
    if (mode !== 'verifier') fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
    const state = mode === 'state' ? 'f'.repeat(64) : mode === 'malformed' ? '../bad-state' : transaction.state;
    const request = new Request(`${CALLBACK}?state=${encodeURIComponent(state)}&code=secret-code`);
    const response = await fixture.route.GET(request, params('callback'));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `${BASE}/google-connection?google_ads=error&reason=${mode==='session'?'authentication_required':'oauth_state_invalid_or_used'}`);
    assert.equal(fixture.edgeCalls.length, 0, mode);
    assert.doesNotMatch(response.headers.get('location'), /secret-code/);
  }
});

test('successful callback uses only server verifier, clears that transaction and blocks browser replay', async () => {
  const transaction = protocol.newBrowserTransaction(), other = protocol.newBrowserTransaction();
  const fixture = harness({upstream: () => json({ok: true, returnPath: '/tenant/demo-a/reports/google-ads?google_ads=connected&code=must-not-leak#secret'})});
  fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
  fixture.jar.set(protocol.stateCookieName(other.state), other.verifier);
  const request = () => new Request(`${CALLBACK}?state=${transaction.state}&code=secret-code&codeVerifier=attacker-verifier&tenantSlug=reefskills&returnPath=https://evil.invalid`);
  const response = await fixture.route.GET(request(), params('callback'));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${BASE}/tenant/demo-a/addons/google-kit?google_ads=connected`);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('cache-control'), /no-store/);
  assert.equal(fixture.edgeCalls.length, 1);
  assert.ok(fixture.edgeCalls[0].url.endsWith('/google-ads-connect/complete'));
  assert.deepEqual(fixture.edgeCalls[0].payload, {state: transaction.state, codeVerifier: transaction.verifier, code: 'secret-code', cancelled: false});
  assert.equal(response.cookieWrites.length, 2);
  assert.equal(response.cookieWrites[0].name, protocol.stateCookieName(transaction.state));
  assert.equal(response.cookieWrites[0].options.maxAge, 0);
  fixture.applyCookies(response);
  assert.equal(fixture.jar.get(protocol.stateCookieName(other.state)), other.verifier);
  const replay = await fixture.route.GET(request(), params('callback'));
  assert.equal(replay.headers.get('location'), `${BASE}/google-connection?google_ads=error&reason=oauth_state_invalid_or_used`);
  assert.equal(fixture.edgeCalls.length, 1);
});

test('callback cannot redirect to external hosts or protected tenant paths even if Edge returns them', async () => {
  for (const returnPath of ['https://evil.invalid/path', '//evil.invalid/path', '/tenant/reefskills/reports/google-ads', '/tenant/demo-a/settings']) {
    const transaction = protocol.newBrowserTransaction();
    const fixture = harness({upstream: () => json({ok: true, returnPath})});
    fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
    const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${transaction.state}&code=secret-code`), params('callback'));
    assert.equal(response.headers.get('location'), `${BASE}/google-connection?google_ads=error&reason=oauth_state_invalid`, returnPath);
    assert.equal(response.cookieWrites[0].options.maxAge, 0);
  }
});

test('provider cancellation and upstream failure consume browser transaction without leaking error details', async () => {
  const transaction = protocol.newBrowserTransaction();
  const fixture = harness({upstream: () => json({ok: false, error: 'private-database-secret'}, 500)});
  fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
  const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${transaction.state}&error=access_denied&error_description=provider-secret`), params('callback'));
  assert.equal(fixture.edgeCalls[0].payload.cancelled, true);
  assert.equal(fixture.edgeCalls[0].payload.code, '');
  assert.equal(response.headers.get('location'), `${BASE}/google-connection?google_ads=error&reason=request_rejected`);
  assert.equal(response.cookieWrites[0].options.maxAge, 0);
  assert.equal(JSON.stringify(fixture.edgeCalls[0].payload).includes('provider-secret'), false);
});

test('mutation forwards only action-approved fields and sanitizes upstream failures', async () => {
  const fixture = harness();
  const extras = {tenantSlug: 'demo-a', accountId: '1234567890', loginCustomerId: '9999999999',
    refreshToken: 'attacker-refresh', serviceRoleKey: 'attacker-key', p_slug: 'reefskills', accessToken: 'attacker-access',
    dateFrom: '2026-09-01', dateTo: '2026-09-09', commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', offset: 50,
    rows: [{originKey: 'fixture-lead', previewToken: 'fixture-version'}], campaignId: '321', reason: 'مراجعة مصدر العميل'};
  const expectedKeys = {
    assets: ['tenantSlug'], select: ['accountId', 'tenantSlug'],
    sync: ['commandId', 'dateFrom', 'dateTo', 'tenantSlug'], disconnect: ['tenantSlug'], sources: ['offset', 'tenantSlug'],
    review: ['campaignId', 'commandId', 'reason', 'rows', 'tenantSlug']
  };
  for (const [action, fields] of Object.entries(expectedKeys)) {
    const response = await fixture.route.POST(postRequest(action, extras), params(action));
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(fixture.edgeCalls.at(-1).payload).sort(), fields.sort());
    assert.equal(fixture.edgeCalls.at(-1).options.headers.authorization, 'Bearer session-secret');
  }
  const failing = harness({upstream: () => json({ok: false, error: 'SQL vault-private-token'}, 500)});
  const response = await failing.route.POST(postRequest('assets'), params('assets'));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {ok: false, error: 'request_rejected'});
});

test('failed exchange returns to settings using only the claimed server transaction and a safe reason', async () => {
  const transaction = protocol.newBrowserTransaction();
  const fixture = harness({upstream: () => json({ok: false, error: 'no_eligible_ads_accounts',
    returnPath: '/tenant/demo-a/reports/google-ads?access_token=private'}, 400)});
  fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
  // Older transactions without a recovery cookie still use the authenticated Edge context.
  const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${transaction.state}&code=private&reason=attacker`), params('callback'));
  assert.equal(response.headers.get('location'), `${BASE}/tenant/demo-a/addons/google-kit?google_ads=error&reason=no_eligible_ads_accounts`);
  assert.doesNotMatch(response.headers.get('location'), /private|attacker/);
});

test('start-to-failed-callback retains tenant recovery through a network outage and clears only that transaction', async () => {
  let failing = false;
  const fixture = harness({upstream: call => {
    if (failing) throw new Error('network-error with private-token');
    return json({ok: true, authorizeUrl: authorizeUrl(call.payload)});
  }});
  for (const tenantSlug of ['demo-a', 'demo-b']) {
    fixture.applyCookies(await fixture.route.POST(postRequest('start', {tenantSlug}), params('start')));
  }
  const [first,second] = fixture.edgeCalls.map(call => call.payload);
  failing = true;
  const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${first.state}&code=private`), params('callback'));
  assert.equal(response.headers.get('location'), `${BASE}/tenant/demo-a/addons/google-kit?google_ads=error&reason=service_unavailable`);
  fixture.applyCookies(response);
  assert.equal(fixture.jar.has(protocol.stateCookieName(first.state)), false);
  assert.equal(fixture.jar.has(protocol.stateCookieName(first.state)+'_tenant'), false);
  assert.equal(fixture.jar.get(protocol.stateCookieName(second.state)+'_tenant'), 'demo-b');
  assert.equal(protocol.validVerifier(fixture.jar.get(protocol.stateCookieName(second.state))), true);
  const complete = fixture.edgeCalls.at(-1).payload;
  assert.deepEqual(Object.keys(complete).sort(), ['cancelled','code','codeVerifier','state']);
});

test('recovery context cannot turn a cross-tenant or untrusted completion into success', async () => {
  for (const returnPath of ['/tenant/demo-b/reports/google-ads?google_ads=connected',
    'https://evil.invalid/tenant/demo-a/reports/google-ads?google_ads=connected',
    '/tenant/demo-a/reports/google-ads?google_ads=error']) {
    const transaction = protocol.newBrowserTransaction();
    const fixture = harness({upstream: () => json({ok: true, returnPath})});
    fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
    fixture.jar.set(protocol.stateCookieName(transaction.state)+'_tenant', 'demo-a');
    const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${transaction.state}&code=private`), params('callback'));
    assert.equal(response.headers.get('location'), `${BASE}/tenant/demo-a/addons/google-kit?google_ads=error&reason=oauth_state_invalid`);
  }
});

test('cancellation returns to settings and unknown failure text is never reflected', async () => {
  for (const result of [{ok:true,returnPath:'/tenant/demo-a/reports/google-ads?google_ads=cancelled'},
    {ok:false,error:'private-token',returnPath:'/tenant/demo-a/reports/google-ads'}]) {
    const transaction = protocol.newBrowserTransaction();
    const fixture = harness({upstream: () => json(result)});
    fixture.jar.set(protocol.stateCookieName(transaction.state), transaction.verifier);
    const response = await fixture.route.GET(new Request(`${CALLBACK}?state=${transaction.state}&error=access_denied&error_description=private`), params('callback'));
    const expected = result.ok ? 'google_ads=cancelled' : 'google_ads=error&reason=request_rejected';
    assert.equal(response.headers.get('location'), `${BASE}/tenant/demo-a/addons/google-kit?${expected}`);
  }
});

test('oversize or non-object JSON is rejected before Edge forwarding', async () => {
  const fixture = harness();
  for (const [body,status] of [[{tenantSlug: 'demo-a', padding: 'x'.repeat(65536)},413], [[{tenantSlug: 'demo-a'}],400]]) {
    const response = await fixture.route.POST(postRequest('assets', body), params('assets'));
    assert.equal(response.status, status);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal(fixture.edgeCalls.length, 0);
});
