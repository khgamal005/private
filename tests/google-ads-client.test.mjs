import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleAdsClient, GOOGLE_ADS_SCOPE, googleMicrosToMinor, normalizeGoogleCustomerId} from '../lib/google-ads/client.mjs';

const config = {clientId: 'odeir-client', clientSecret: 'server-secret', developerToken: 'developer-secret', redirectUri: 'https://odeir.com/api/google-ads/callback'};
const now = () => Date.parse('2026-09-09T12:00:00Z');
const customer = (id, extra = {}) => ({id, descriptiveName: `Account ${id}`, currencyCode: 'SAR', timeZone: 'Asia/Riyadh', ...extra});
const account = {customerId: '1234567890', loginCustomerId: ''};
const ok = value => new Response(JSON.stringify(value), {status: 200, headers: {'content-type': 'application/json'}});
const errorCode = code => error => error.code === code;
const client = (fetchImpl, extra = {}) => createGoogleAdsClient(config, {fetchImpl, now, ...extra});

test('OAuth uses server client credentials, offline PKCE and validates granted scope', async () => {
  let sent;
  const instance = client(async (url, init) => {
    sent = {url, init};
    return ok({access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_ADS_SCOPE});
  });
  const url = new URL(instance.authorizationUrl({state: 's'.repeat(43), codeChallenge: 'c'.repeat(43)}));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('scope'), GOOGLE_ADS_SCOPE);
  assert.equal(url.searchParams.has('client_secret'), false);
  const tokens = await instance.exchangeCode({code: 'returned-code', codeVerifier: 'v'.repeat(43)});
  assert.equal(tokens.refreshToken, 'refresh-secret');
  assert.equal(tokens.expiresAt, '2026-09-09T13:00:00.000Z');
  assert.equal(sent.url, 'https://oauth2.googleapis.com/token');
  const body = new URLSearchParams(sent.init.body);
  assert.equal(body.get('code_verifier'), 'v'.repeat(43));
  assert.equal(body.get('client_secret'), 'server-secret');
  assert.equal(sent.init.redirect, 'error');
  assert.equal(sent.init.cache, 'no-store');
  const denied = client(async () => ok({access_token: 'secret', expires_in: 3600, token_type: 'Bearer', scope: 'email'}));
  await assert.rejects(denied.exchangeCode({code: 'code', codeVerifier: 'v'.repeat(43)}), errorCode('google_scope_missing'));
});

test('refresh preserves refresh credential; OAuth failures redact provider details', async () => {
  const instance = client(async () => ok({access_token: 'new-access', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_ADS_SCOPE}));
  const result = await instance.refreshAccessToken({refreshToken: 'old-refresh'});
  assert.equal(result.refreshToken, 'old-refresh');
  const denied = client(async () => new Response(JSON.stringify({error: 'invalid_grant', error_description: 'URL includes access-secret server-secret'}), {status: 400}));
  await assert.rejects(denied.refreshAccessToken({refreshToken: 'old-refresh'}), error => {
    assert.equal(error.code, 'google_reconnect_required');
    assert.equal(JSON.stringify(error).includes('secret'), false);
    assert.equal(error.stack.includes('server-secret'), false);
    return true;
  });
});

test('invalid OAuth client is a platform configuration failure even with HTTP 401', async () => {
  const instance = client(async () => new Response(JSON.stringify({error:'invalid_client',error_description:'private-secret'}), {status:401}));
  await assert.rejects(instance.exchangeCode({code:'private-code',codeVerifier:'v'.repeat(43)}), errorCode('google_oauth_configuration_invalid'));
});

test('Ads errors classify fixed provider enums without exposing response text', async () => {
  const detail = errorCode => ({'@type':'type.googleapis.com/google.ads.googleads.v25.errors.GoogleAdsFailure',
    errors:[{errorCode,message:'private-token'}]});
  for (const [providerDetail,expected] of [
    [detail({authorizationError:'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION'}),'google_cloud_project_access_required'],
    [detail({authenticationError:'NOT_ADS_USER'}),'google_ads_user_required'],
    [{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'SERVICE_DISABLED',metadata:{secret:'private-token'}},'google_api_not_enabled'],
    [detail({authorizationError:'private-token'}),'google_access_denied']
  ]) {
    const instance = client(async () => new Response(JSON.stringify({error:{message:'private-token',details:[providerDetail]}}), {status:403}));
    await assert.rejects(instance.discoverAccounts({accessToken:'private-token'}), error => {
      assert.equal(error.code,expected);
      assert.doesNotMatch(JSON.stringify(error),/private-token/);
      return true;
    });
  }
});

test('account discovery walks managers, preserves login route, dedupes direct access and excludes test accounts', async () => {
  const calls = [];
  const instance = client(async (url, init) => {
    if (url.endsWith(':listAccessibleCustomers')) return ok({resourceNames: ['customers/1111111111', 'customers/3333333333']});
    const query = JSON.parse(init.body).query;
    const id = url.match(/customers\/(\d+)/)[1];
    calls.push({id, query, login: init.headers['login-customer-id'] || ''});
    if (query.includes('FROM customer LIMIT')) return ok({results: [{customer: customer(id, {manager: id === '1111111111'})}]});
    if (id === '1111111111') return ok({results: [
      {customerClient: customer('2222222222', {manager: true})},
      {customerClient: customer('3333333333')},
      {customerClient: customer('4444444444', {testAccount: true})}
    ]});
    return ok({results: [{customerClient: customer('5555555555')}, {customerClient: customer('1111111111', {manager: true})}]});
  });
  const {accounts, truncated} = await instance.discoverAccounts({accessToken: 'access'});
  assert.equal(truncated, false);
  assert.equal(accounts.length, 5);
  assert.equal(accounts.find(row => row.customerId === '3333333333').loginCustomerId, '');
  assert.equal(accounts.find(row => row.customerId === '5555555555').loginCustomerId, '1111111111');
  assert.equal(accounts.find(row => row.customerId === '4444444444').selectable, false);
  assert.equal(accounts.find(row => row.customerId === '1111111111').selectable, false);
  assert.equal(calls.filter(row => row.query.includes('FROM customer_client')).length, 2);
  assert.equal(calls.find(row => row.id === '2222222222').login, '1111111111');
});

test('account discovery fails rather than silently dropping accounts beyond its configured bound', async () => {
  const instance = client(async () => ok({resourceNames: ['customers/1111111111', 'customers/2222222222']}), {maxAccounts: 1});
  await assert.rejects(instance.discoverAccounts({accessToken: 'access'}), errorCode('google_account_limit_exceeded'));
});

test('selection revalidates identity and rejects managers, tests or account mismatch', async () => {
  for (const [extra, code] of [[{manager: true}, 'google_advertiser_account_required'], [{testAccount: true}, 'google_advertiser_account_required'], [{id: '9999999999'}, 'google_account_mismatch']]) {
    const instance = client(async () => ok({results: [{customer: customer(account.customerId, extra)}]}));
    await assert.rejects(instance.revalidateAccount({accessToken: 'access', account}), errorCode(code));
  }
});

test('report reads every page and distinguishes Google conversions from CRM results', async () => {
  const calls = [];
  const instance = client(async (url, init) => {
    const {query, pageToken} = JSON.parse(init.body);
    calls.push({url, query, pageToken});
    if (query.includes('FROM customer LIMIT')) return ok({results: [{customer: customer(account.customerId)}]});
    if (query.includes('metrics.cost_micros')) return ok({results: [{campaign: {id: '9007199254740993'}, segments: {date: '2026-09-08'}, metrics: {costMicros: '125005000', impressions: '4000', clicks: '89', conversions: 4.5, conversionsValue: 765.25}}]});
    if (!pageToken) return ok({results: [{campaign: {id: '9007199254740993', name: 'Campaign A', status: 'ENABLED', advertisingChannelType: 'SEARCH'}}], nextPageToken: 'page-two'});
    return ok({results: [{campaign: {id: '9007199254740994', name: 'Campaign B', status: 'PAUSED'}}]});
  });
  const report = await instance.fetchCampaignReport({accessToken: 'access', account, dateFrom: '2026-09-01', dateTo: '2026-09-09'});
  assert.equal(report.campaigns.length, 2);
  assert.equal(report.campaigns[0].externalCampaignId, '9007199254740993');
  assert.equal(report.daily[0].costMicros, '125005000');
  assert.equal(report.daily[0].costMinor, 12501);
  assert.equal(report.daily[0].googleConversions, 4.5);
  assert.equal('registeredStudents' in report.daily[0], false);
  assert.equal('revenueMinor' in report.daily[0], false);
  assert.ok(calls.every(call => call.url.includes('/v25/') && call.url.endsWith('/googleAds:search')));
  assert.ok(calls.every(call => !call.query.includes('campaign.start_date')));
});

test('money conversion uses exact micros and actual currency digits without float loss', () => {
  assert.equal(googleMicrosToMinor('1004999', 'SAR'), 100);
  assert.equal(googleMicrosToMinor('1005000', 'SAR'), 101);
  assert.equal(googleMicrosToMinor('1500000', 'JPY'), 2);
  assert.equal(googleMicrosToMinor('1234500', 'KWD'), 1235);
  assert.equal(googleMicrosToMinor('-1005000', 'SAR'), -101);
  assert.equal(googleMicrosToMinor('90071992547409910000', 'SAR'), Number.MAX_SAFE_INTEGER);
  assert.throws(() => googleMicrosToMinor('90071992547409920000', 'SAR'), errorCode('google_cost_overflow'));
  assert.throws(() => googleMicrosToMinor(9007199254740993, 'SAR'), errorCode('google_cost_invalid'));
});

test('invalid calendar dates, injected dates, overlong ranges and unsafe identifiers fail before requests', async () => {
  let calls = 0;
  const instance = client(async () => { calls++; return ok({}); });
  for (const [dateFrom, dateTo] of [['2026-02-30', '2026-03-01'], ["2026-01-01' OR 1=1", '2026-01-02'], ['2026-07-01', '2026-09-01']]) {
    await assert.rejects(instance.fetchCampaignReport({accessToken: 'access', account, dateFrom, dateTo}), /google_date/);
  }
  assert.equal(calls, 0);
  assert.equal(normalizeGoogleCustomerId('123-456-7890'), '1234567890');
  assert.throws(() => normalizeGoogleCustomerId('prefix1234567890'), /google_customer_id_invalid/);
});

test('repeated page tokens and page limits fail atomically', async () => {
  const fetchImpl = async (_url, init) => {
    const {query} = JSON.parse(init.body);
    if (query.includes('FROM customer LIMIT')) return ok({results: [{customer: customer(account.customerId)}]});
    return ok({results: [{campaign: {id: '1', name: 'A'}}], nextPageToken: 'same-page'});
  };
  const input = {accessToken: 'access', account, dateFrom: '2026-09-01', dateTo: '2026-09-09'};
  await assert.rejects(client(fetchImpl).fetchCampaignReport(input), errorCode('google_pagination_invalid'));
  await assert.rejects(client(fetchImpl, {maxPages: 1}).fetchCampaignReport(input), errorCode('google_page_limit_exceeded'));
});

test('duplicate campaign-day records are rejected so pagination cannot double advertising spend', async () => {
  const instance = client(async (_url, init) => {
    const {query} = JSON.parse(init.body);
    if (query.includes('FROM customer LIMIT')) return ok({results: [{customer: customer(account.customerId)}]});
    if (!query.includes('metrics.cost_micros')) return ok({results: [{campaign: {id: '1'}}]});
    const row = {campaign: {id: '1'}, segments: {date: '2026-09-08'}, metrics: {costMicros: '1000000'}};
    return ok({results: [row, row]});
  });
  await assert.rejects(instance.fetchCampaignReport({accessToken: 'access', account, dateFrom: '2026-09-01', dateTo: '2026-09-09'}), errorCode('google_response_duplicate_metric'));
});

test('rate limits retry within bounds, then return a sanitized error', async () => {
  let calls = 0;
  const delays = [];
  const instance = client(async () => { calls++; return new Response('{"error":{"message":"secret"}}', {status: 429, headers: {'retry-after': '99999'}}); }, {sleep: async ms => delays.push(ms)});
  await assert.rejects(instance.discoverAccounts({accessToken: 'access'}), errorCode('google_rate_limited'));
  assert.equal(calls, 3);
  assert.deepEqual(delays, [3000, 3000]);
});

test('explicit cancellation and request timeout never expose fetch errors', async () => {
  const controller = new AbortController();
  controller.abort();
  const noFetch = client(async () => { throw new Error('should not be called'); });
  await assert.rejects(noFetch.discoverAccounts({accessToken: 'access', signal: controller.signal}), errorCode('google_request_aborted'));
  const hanging = client(async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('secret-url')), {once: true})), {timeoutMs: 5});
  await assert.rejects(hanging.discoverAccounts({accessToken: 'access'}), errorCode('google_request_timeout'));
});
