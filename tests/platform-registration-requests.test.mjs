import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

const MIGRATION='supabase/migrations/20260823193000_platform_registration_requests_v1.sql';
const DETAIL_ROW_HOTFIX='supabase/migrations/20260824003000_registration_request_detail_row_assignment_v1.sql';
const MANUAL_ACTIVATION_INTEGRITY=
  'supabase/migrations/20260824170000_registration_manual_activation_integrity_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

function compact(source){
  return source.replace(/\s+/g,'');
}

function position(source,needle,label=needle){
  const at=source.indexOf(needle);
  assert.notEqual(at,-1,`missing contract marker: ${label}`);
  return at;
}

function assertOrdered(source,markers){
  let previous=-1;
  for(const marker of markers){
    const at=position(source,marker);
    assert.ok(at>previous,`contract marker is out of order: ${marker}`);
    previous=at;
  }
}

function assertBoundedStreamingReader(source){
  assertOrdered(source,[
    'request.body.getReader()',
    'await reader.read()',
    'total+=value.byteLength',
    'if(total>maxBytes)',
    'await reader.cancel()',
    'return null'
  ]);
  assert.ok(source.includes('finally{reader.releaseLock();}'));
  assert.equal(source.includes('request.text()'),false);
  assert.equal(source.includes('request.json()'),false);
}

test('registration storage is private by default and privileged functions are hardened',async()=>{
  const migration=await read(MIGRATION);

  for(const table of [
    'platform.registration_requests',
    'platform.registration_request_events',
    'platform.registration_rate_limits'
  ]){
    assert.match(migration,new RegExp(`alter table ${table.replace('.','\\.')} enable row level security;`));
    assert.match(
      migration,
      new RegExp(`revoke all on table ${table.replace('.','\\.')}\\s+from public,anon,authenticated;`)
    );
  }

  for(const signature of [
    'public.v1_registration_rate_limit_consume(text,integer,integer)',
    'public.v1_public_submit_registration_request(jsonb,text,text)',
    'public.v1_platform_registration_requests_summary()',
    'public.v1_platform_registration_requests_snapshot(text,text,integer,integer)',
    'public.v1_platform_registration_request_detail(uuid)',
    'public.v1_platform_registration_request_action(uuid,text,integer,text,jsonb)'
  ]){
    assert.match(
      migration,
      new RegExp(`revoke all on function ${signature.replace(/[().]/g,'\\$&')}\\s+from public,anon,authenticated;`)
    );
  }

  const functions=[...migration.matchAll(/create or replace function (public\.\w+)[\s\S]*?\n\$\$;/g)];
  const expectedFunctions=[
    'public.v1_registration_rate_limit_consume',
    'public.v1_public_submit_registration_request',
    'public.v1_platform_registration_requests_summary',
    'public.v1_platform_registration_requests_snapshot',
    'public.v1_platform_registration_request_detail',
    'public.v1_platform_registration_request_action'
  ];
  for(const name of expectedFunctions){
    const match=functions.find(candidate=>candidate[1]===name);
    assert.ok(match,`missing function: ${name}`);
    assert.match(match[0],/security definer\s+set search_path=''/);
  }
  assert.match(migration,/v1_public_submit_registration_request\(jsonb,text,text\)[\s\S]*?to service_role;/);
  assert.doesNotMatch(
    migration,
    /grant execute on function public\.v1_public_submit_registration_request\(jsonb,text,text\)\s+to (?:anon|authenticated);/
  );
  assert.match(migration,/has_platform_permission\('platform\.tenants\.manage'\)/);
});

test('approval is a review decision and provisioning remains a separate explicit transition',async()=>{
  const migration=await read(MIGRATION);
  const approve=section(migration,"elsif v_action='approve' then","elsif v_action='reject' then");
  const provision=section(migration,"elsif v_action='provision' then","else\n    raise exception 'registration_action_invalid'");

  assert.match(approve,/v_request\.status<>'under_review'/);
  assert.match(approve,/v_to_status:='approved'/);
  assert.doesNotMatch(approve,/v2_platform_provision_tenant|insert into core\.tenants/);
  assert.match(provision,/v_request\.status<>'approved'/);
  assert.match(provision,/v2_platform_provision_tenant\(/);
  assert.match(provision,/v_to_status:='converted'/);
});

test('request actions lock rows, detect stale versions, and replay completed provisioning safely',async()=>{
  const migration=await read(MIGRATION);
  const action=section(
    migration,
    'create or replace function public.v1_platform_registration_request_action',
    'revoke all on function public.v1_registration_rate_limit_consume'
  );
  const lockIndex=action.indexOf('for update;');
  const conflictIndex=action.indexOf("raise exception 'registration_request_conflict'");
  const replayIndex=action.indexOf("v_request.status='converted'");

  assert.ok(lockIndex>0,'the request row must be locked');
  assert.ok(replayIndex>lockIndex,'completed provisioning must be detected after the lock');
  assert.ok(conflictIndex>replayIndex,'an idempotent provision retry must replay before version rejection');
  assert.match(action,/p_expected_version[^\n]*<>v_request\.version/);
  assert.match(action,/version=version\+1/g);
  assert.match(action,/'replayed',true/);
  assert.match(migration,/provisioned_tenant_id uuid unique/);
  assert.match(action,/public\.v2_platform_provision_tenant\(/);
  assert.doesNotMatch(action,/insert into core\.tenants/);
});

test('public registration obtains a one-time Edge challenge without exposing privileged credentials',async()=>{
  const [landing,route]=await Promise.all([
    read('components/free-trial-landing.js'),
    read('app/api/public/registration/route.js')
  ]);

  assert.match(landing,/['"]\/api\/public\/registration['"]/);
  assert.match(landing,/action\s*===?\s*['"]submit['"]/);
  assert.match(landing,/action: "challenge_bootstrap"/);
  assert.match(landing,/body: JSON\.stringify\(\{ action: "challenge" \}\)/);
  assert.match(landing,/credentials: "omit"/);
  assert.match(landing,/const challenge = await requestRegistrationChallenge\(\)/);
  assert.match(landing,/submitLockRef\.current/);
  assert.match(landing,/aria-busy=\{busy === "submit"\}/);
  assert.match(route,/odeir-registration-intake/);
  assert.match(route,/SUPABASE_KEY/);
  assert.match(route,/body\.action==='challenge_bootstrap'/);
  assert.match(route,/publishableKey:SUPABASE_KEY/);
  assert.match(route,/body\.action!=='submit'/);
  assert.match(route,/typeof body\.challenge!=='string'/);
  assert.match(route,/apikey:SUPABASE_KEY/);
  assert.doesNotMatch(route,
    /ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token|SUPABASE_SECRET_KEY/
  );
  assert.doesNotMatch(landing,/SUPABASE_SERVICE_ROLE_KEY|service[_\s.-]?role|SUPABASE_SECRET/i);
  assert.doesNotMatch(landing,/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)/i);
  assert.doesNotMatch(route,/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)/i);
});

test('edge intake verifies admin JWTs and rate limits public capabilities',async()=>{
  const [edge,config]=await Promise.all([
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('supabase/config.toml')
  ]);

  assert.doesNotMatch(edge,/ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token/);
  assert.match(edge,
    /const RATE_SALT=Deno\.env\.get\('ODEIR_REGISTRATION_RATE_SALT'\)\?\.trim\(\)\?\?'';/
  );
  assert.doesNotMatch(edge,
    /const RATE_SALT=[\s\S]{0,160}\|\|(?:SERVICE_ROLE_KEY|INTAKE_TOKEN)/
  );
  assert.match(edge,/authorizedPlatformAdminRequest/);
  assert.match(edge,/v1_platform_registration_policy_snapshot/);
  assert.match(edge,/apikey:ANON_KEY/);
  assert.match(edge,/authorization:`Bearer \$\{accessToken\}`/);
  const adminAuthorization=section(
    edge,'async function authorizedPlatformAdminRequest',
    'async function authorizedWorkerRequest'
  );
  assert.doesNotMatch(adminAuthorization,/apikey:SERVICE_ROLE_KEY/);
  assert.match(edge,
    /if\(action==='canary'\)\{[\s\S]*?authorizedPlatformAdminRequest\(request\)/
  );
  assert.match(edge,
    /if\(action==='activation_grant'\)\{[\s\S]*?authorizedPlatformAdminRequest\(request\)/
  );
  assert.match(edge,
    /p_rate_key:`confirm-capability-burst:\$\{shard\}`[\s\S]*?p_limit:30[\s\S]*?p_window_seconds:60/
  );
  assert.match(edge,
    /p_rate_key:`confirm-capability-sustained:\$\{shard\}`[\s\S]*?p_limit:120[\s\S]*?p_window_seconds:600/
  );
  assert.doesNotMatch(edge,/confirm-source|x-odeir-client-ip/);
  assert.match(edge,/v1_registration_rate_limit_consume/);
  assert.match(edge,/request\.method==='OPTIONS'/);
  assert.match(edge,/'access-control-allow-origin':origin/);
  assert.match(edge,/'access-control-allow-headers':'apikey, content-type'/);
  assert.match(edge,/'vary':'Origin'/);
  assert.match(edge,/CHALLENGE_TTL_SECONDS=300/);
  assert.match(edge,/CHALLENGE_AUDIENCE='registration-submit'/);
  assert.match(edge,/randomHex\(32\)/);
  assert.match(edge,/\{name:'HMAC',hash:'SHA-256'\}/);
  assert.match(edge,/request\.headers\.get\('cf-connecting-ip'\)/);
  assert.match(edge,/request\.headers\.get\('x-forwarded-for'\)/);
  assert.match(edge,/p_rate_key:`challenge-issue:\$\{ipHash\}`[\s\S]*?p_limit:5[\s\S]*?p_window_seconds:3_600/);
  assert.match(edge,/p_rate_key:`challenge:\$\{await sha256\(claims\.jti\)\}`[\s\S]*?p_limit:1[\s\S]*?p_window_seconds:600/);
  assert.match(edge,/p_limit:3/);
  assert.match(edge,/p_window_seconds:86_400/);
  assert.match(edge,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edge,/v3_public_submit_registration_request/);
  assert.match(edge,
    /payload\.institutionState==='new'&&!payload\.accountId[\s\S]*?registrationEmailHealth\(false\)[\s\S]*?v3_public_submit_registration_request/
  );
  assert.match(edge,
    /for\(let attempt=0;attempt<3;attempt\+\+\)[\s\S]*?v3_public_submit_registration_request[\s\S]*?liveReady=false/
  );
  const challengeConsumed=position(
    edge,
    'const claims=await consumeRegistrationChallenge(challenge)'
  );
  const v3Submit=position(
    edge,
    'const guarded=await rpc<JsonRecord>('
  );
  const v2Submit=position(
    edge,
    "result=await rpc<JsonRecord>('v2_public_submit_registration_request'"
  );
  assert.ok(challengeConsumed<v3Submit,'challenge must precede the guarded v3 submit');
  assert.ok(challengeConsumed<v2Submit,'challenge must precede the v2 submit');
  assert.doesNotMatch(edge,/result=await rpc<JsonRecord>\('v1_public_submit_registration_request'/);
  const submitIngress=section(
    edge,"if(action!=='submit')",'const allowed=await rpc<boolean>'
  );
  assert.match(submitIngress,/if\(!challenge\)/);
  assert.doesNotMatch(submitIngress,/authorizedPlatformAdminRequest/);
  assert.match(config,/\[functions\.odeir-registration-intake\][\s\S]*?verify_jwt\s*=\s*false/);
});

test('every anonymous or platform JSON ingress bounds the streamed body before parsing',async()=>{
  const [publicRoute,platformRoute,edge]=await Promise.all([
    read('app/api/public/registration/route.js'),
    read('app/api/platform/registration-requests/route.js'),
    read('supabase/functions/odeir-registration-intake/index.ts')
  ]);
  const readers=[
    section(publicRoute,'async function boundedRequestText','function publicStatus'),
    section(platformRoute,'async function boundedRequestText','function provisionPayload'),
    section(edge,'async function boundedRequestText','function bytesToHex')
  ];

  for(const reader of readers)assertBoundedStreamingReader(reader);

  const publicPost=section(publicRoute,'export async function POST','async function boundedRequestText');
  const platformBody=section(platformRoute,'async function limitedBody','async function boundedRequestText');
  const edgeIngress=section(edge,'Deno.serve','function allowedChallengeOrigin');
  for(const ingress of [publicPost,platformBody,edgeIngress]){
    assert.ok(ingress.includes("headers.get('content-length')"));
    assertOrdered(ingress,['content-length','boundedRequestText','JSON.parse']);
  }
});

test('platform inbox is permission guarded and appears only in the authorized navigation',async()=>{
  const [page,helper,shell]=await Promise.all([
    read('app/control/registration-requests/page.js'),
    read('lib/platform-registration-requests.js'),
    read('components/workspace-shell.js')
  ]);

  assert.match(page,/requirePlatformPermission\(['"]platform\.tenants\.manage['"]\)/);
  assert.match(page,/getPlatformRegistrationRequests/);
  assert.match(helper,/v1_platform_registration_requests_snapshot/);
  assert.match(helper,/v1_platform_registration_request_detail/);
  assert.match(shell,/label:['"]طلبات التسجيل['"]/);
  assert.match(shell,/href:['"]\/control\/registration-requests['"]/);
  assert.match(shell,/permission:['"]platform\.tenants\.manage['"]/);
});

test('registration detail expands the table row before assigning it to the rowtype variable',async()=>{
  const migration=await read(DETAIL_ROW_HOTFIX);
  const detail=section(
    migration,
    'create or replace function public.v1_platform_registration_request_detail',
    'revoke all on function public.v1_platform_registration_request_detail'
  );

  assert.match(detail,/select request\.\*\s+into v_request/);
  assert.doesNotMatch(detail,/select request\s+into v_request/);
  assert.match(detail,/security definer\s+set search_path=''/);
  assert.match(detail,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(migration,/revoke all on function public\.v1_platform_registration_request_detail\(uuid\)[\s\S]*?from public,anon,authenticated/);
  assert.match(migration,/grant execute on function public\.v1_platform_registration_request_detail\(uuid\)[\s\S]*?to authenticated/);
});

test('platform action API uses an allowlist and reports optimistic-lock conflicts as HTTP 409',async()=>{
  const route=await read('app/api/platform/registration-requests/route.js');

  for(const action of ['start_review','approve','reject','reopen','provision']){
    assert.match(route,new RegExp(`['"]${action}['"]`));
  }
  assert.match(route,/registration_action_invalid|invalid_action|action_not_allowed/);
  assert.match(route,/v1_platform_registration_request_action/);
  assert.match(route,/registration_request_conflict/);
  assert.match(route,/source\.includes\(['"]conflict['"]\)[\s\S]{0,240}?return 409;/);
  assert.match(route,/return 503;/);
  assert.match(route,/status===503\?'service_unavailable':'request_failed'/);
  assert.match(route,/platform_registration_rpc_failed/);
  assert.match(route,/databaseCode:error\.databaseCode\|\|'unknown'/);
  assert.doesNotMatch(route,/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|rpcService/);
  assert.match(route,/async function activateExistingInstitution/);
  assert.match(route,/apikey:SUPABASE_KEY/);
});

test('terminal email failures expose only the versioned manual-review rescue action',async()=>{
  const [route,component,ledger]=await Promise.all([
    read('app/api/platform/registration-requests/route.js'),
    read('components/platform-registration-requests.js'),
    read('supabase/migrations/20260824171000_registration_email_delivery_ledger_v1.sql')
  ]);
  const post=section(route,'export async function POST','function activationPayload');
  assert.match(route,/['"]move_to_manual_review['"]/);
  assert.match(route,/v1_platform_registration_email_delivery_status/);
  assert.match(post,
    /action==='move_to_manual_review'[\s\S]*v1_platform_registration_email_move_to_manual/
  );
  assert.match(post,
    /p_request_id:requestId,[\s\S]*p_expected_version:expectedVersion,[\s\S]*p_notes:notes/
  );
  assert.match(route,/registration_email_fallback_reason_required/);
  assert.match(route,/registration_email_fallback_not_allowed/);

  assert.match(component,/move_to_manual_review:'pending_review'/);
  assert.match(component,/email_fallback_manual:/);
  assert.match(component,
    /selectedEmailDeliveryState==='terminal_failed'[\s\S]*openConfirmation\('move_to_manual_review'\)/
  );
  assert.match(component,
    /confirm\?\.type==='move_to_manual_review'[\s\S]*runAction\('move_to_manual_review'/
  );
  assert.match(component,
    /type==='move_to_manual_review'[\s\S]*reason\.trim\(\)\.length>=8/
  );
  const rescue=section(
    ledger,
    'create or replace function public.v1_platform_registration_email_move_to_manual',
    'revoke all on function public.v2_public_submit_registration_request'
  );
  assert.doesNotMatch(rescue,/provision_tenant_core|insert into core\.tenants/);
});

test('manual activation delegates existing-directory proof to an authenticated Edge gateway',async()=>{
  const [route,gateway,config,migration]=await Promise.all([
    read('app/api/platform/registration-requests/route.js'),
    read('supabase/functions/odeir-registration-manual-activation/index.ts'),
    read('supabase/config.toml'),
    read(MANUAL_ACTIVATION_INTEGRITY)
  ]);
  const post=section(route,'export async function POST','function activationPayload');
  const activation=section(route,'function activationPayload','async function rpc(');
  const approve=section(
    migration,
    'create or replace function public.v1_platform_registration_approve_and_activate',
    'revoke all on function public.v1_platform_registration_activation_attestation_prepare'
  );

  assert.match(post,/delegatedActivation=await activateExistingInstitution/);
  assert.match(route,/functions\/v1\/odeir-registration-manual-activation/);
  assert.match(route,/apikey:SUPABASE_KEY/);
  assert.match(route,/Authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(route,/SUPABASE_SECRET_KEY|SUPABASE_SERVICE_ROLE_KEY|rpcService/);
  assert.match(
    config,
    /\[functions\.odeir-registration-manual-activation\][\s\S]*?verify_jwt\s*=\s*true/
  );

  assertOrdered(gateway,[
    "'v1_platform_registration_request_detail'",
    "'v1_platform_registration_activation_attestation_prepare'",
    'const evidence=await verifyDirectoryInstitution',
    "'v1_registration_activation_attestation_complete'",
    'payload:{...(payload as JsonRecord),attestationId}',
    "'v1_platform_registration_approve_and_activate'"
  ]);
  assert.match(
    gateway,
    /const SERVICE_ROLE_KEY=environmentKey\('SUPABASE_SECRET_KEYS','SUPABASE_SERVICE_ROLE_KEY'\)/
  );
  assert.match(gateway,/rpcUser<JsonRecord>[\s\S]*?authorization/);
  assert.match(gateway,/rpcService\([\s\S]*?'v1_registration_activation_attestation_complete'/);
  assert.match(gateway,/p_attestation_id:attestationId/);
  assert.match(gateway,/p_nonce:nonce/);
  assert.match(gateway,/p_directory_evidence:evidence/);

  assert.ok(activation.includes("if(resolution!=='create_new')"));
  assert.ok(activation.includes('if(body.identityVerified!==true)'));
  assert.ok(activation.includes('identityVerified:true'));
  assert.equal(activation.includes('attestationId'),false);
  assert.equal(route.includes('attestationId:null'),false);
  assert.doesNotMatch(gateway,/reef|ريف/i);

  const approveCompact=compact(approve);
  assert.ok(approveCompact.includes(
    "ifp_payload->'identityVerified'isdistinctfrom'true'::jsonbthen"
  ));
  assert.ok(approveCompact.includes(
    "trim(coalesce(p_payload->>'resolution',''))<>'create_new'"
  ));
  assert.ok(approve.includes("v_attestation.status<>'completed'"));
  assert.ok(approve.includes('v_attestation.requested_by_subject_id is distinct from v_actor'));
  assert.ok(approve.includes("set status='consumed',consumed_at=now()"));
  assert.equal(approve.includes('link_existing'),false);

  const migrationCompact=compact(migration);
  assert.ok(migrationCompact.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_activation_attestation_prepare(uuid,integer)toauthenticated;'
  ));
  assert.ok(migrationCompact.includes(
    'grantexecuteonfunctionpublic.v1_registration_activation_attestation_complete(uuid,text,jsonb)toservice_role;'
  ));
  assert.equal(
    migrationCompact.includes(
      'grantexecuteonfunctionpublic.v1_registration_activation_attestation_complete(uuid,text,jsonb)toauthenticated;'
    ),
    false
  );
  assert.ok(migrationCompact.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_approve_and_activate(uuid,integer,text,jsonb)toauthenticated;'
  ));
});

test('activation accepts only a strict converted active create-new response',async()=>{
  const route=await read('app/api/platform/registration-requests/route.js');
  const validator=section(route,'function validActivationResult','function withInvitationUrl');
  const post=section(route,'export async function POST','function activationPayload');

  for(const contract of [
    "requestStatus==='converted'",
    'isUuid(requestTenantId)',
    'tenantId===requestTenantId',
    "/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)",
    "clean(provisioning.status,24).toLowerCase()==='active'",
    "clean(provisioning.resolution,24).toLowerCase()==='create_new'"
  ])assert.ok(validator.includes(contract),`missing activation response contract: ${contract}`);

  assertOrdered(post,[
    "?'v1_platform_registration_approve_and_activate'",
    "if(action==='approve_and_activate'&&!validActivationResult(result.data))",
    "'registration_activation_response_invalid'",
    'const data=withInvitationUrl(result.data)'
  ]);
});

test('registration snapshot applies composite filters before total and pagination while summary stays global',async()=>{
  const [route,migration]=await Promise.all([
    read('app/api/platform/registration-requests/route.js'),
    read(MANUAL_ACTIVATION_INTEGRITY)
  ]);
  const snapshot=section(
    migration,
    'create or replace function public.v1_platform_registration_requests_snapshot',
    'create or replace function public.v1_platform_registration_activation_attestation_prepare'
  );
  const compactSnapshot=compact(snapshot);

  for(const status of ['manual_attention','trust_attention','restricted']){
    assert.ok(route.includes(`'${status}'`),`route must accept ${status}`);
    assert.ok(snapshot.includes(`'${status}'`),`database must accept ${status}`);
  }
  for(const filterContract of [
    "v_status='manual_attention'andrequest.queue_statusin('pending_review','under_review')",
    "v_status='trust_attention'andrequest.queue_statusin('trust_pending','trust_review')",
    "v_status='restricted'andrequest.queue_statusin('rejected','trust_restricted')"
  ])assert.ok(
    compactSnapshot.includes(filterContract),
    `missing composite filter contract: ${filterContract}`
  );

  assert.ok(compactSnapshot.includes("'total',(selectcount(*)frommatched)"));
  assert.ok(compactSnapshot.includes('fromclassifiedrequest'));
  const classifiedAt=position(snapshot,'with classified as materialized');
  const matchedAt=position(snapshot,'matched as materialized');
  const summaryAt=position(snapshot,"'summary'");
  const globalSummaryAt=snapshot.indexOf('from classified request',summaryAt);
  const matchedTotalAt=snapshot.indexOf("'total',(select count(*) from matched)",summaryAt);
  const pageAt=snapshot.indexOf('from matched filtered',matchedTotalAt);
  const paginationAt=snapshot.indexOf('limit v_limit offset v_offset',pageAt);
  for(const [at,label] of [
    [globalSummaryAt,'global classified summary'],
    [matchedTotalAt,'matched total'],
    [pageAt,'matched page'],
    [paginationAt,'server pagination']
  ])assert.notEqual(at,-1,`missing snapshot contract: ${label}`);
  assert.ok(classifiedAt<matchedAt);
  assert.ok(matchedAt<summaryAt);
  assert.ok(summaryAt<globalSummaryAt);
  assert.ok(globalSummaryAt<matchedTotalAt);
  assert.ok(matchedTotalAt<pageAt);
  assert.ok(pageAt<paginationAt);
});

test('the new registration path is isolated from Reef and tenant records until provisioning',async()=>{
  const sources=await Promise.all([
    read(MIGRATION),
    read(MANUAL_ACTIVATION_INTEGRITY),
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('app/api/public/registration/route.js'),
    read('app/api/platform/registration-requests/route.js'),
    read('lib/platform-registration-requests.js'),
    read('app/control/registration-requests/page.js')
  ]);
  const combined=sources.join('\n');

  assert.doesNotMatch(combined,/reef|ريف/i);
  assert.equal(combined.toLowerCase().includes('link_existing'),false);
  assert.doesNotMatch(
    sources[1],
    /'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/i
  );
  assert.ok(sources[1].includes("'registrationRequestId',v_request.id::text"));
  assert.ok(sources[1].includes("'registrationResolution','create_new'"));
  const beforeProvision=section(
    sources[0],
    'create table if not exists platform.registration_requests',
    "elsif v_action='provision' then"
  );
  assert.doesNotMatch(beforeProvision,/insert into core\.tenants|update core\.tenants|delete from core\.tenants/);
});
