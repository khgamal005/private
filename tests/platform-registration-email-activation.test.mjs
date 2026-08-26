import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260823194500_platform_email_verified_trial_v1.sql';
const PASSWORD_GATE_HOTFIX='supabase/migrations/20260823203000_registration_restore_password_gate_v1.sql';
const MANUAL_ACTIVATION_INTEGRITY=
  'supabase/migrations/20260824170000_registration_manual_activation_integrity_v1.sql';
const STRICT_ONE_TIME=
  'supabase/migrations/20260826170000_registration_confirmation_strict_one_time_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

function positionOf(source,needle){
  const at=source.indexOf(needle);
  assert.notEqual(at,-1,`missing contract marker: ${needle}`);
  return at;
}

test('activation policy and identity-claim storage stay behind RLS and narrow RPC grants',async()=>{
  const migration=await read(MIGRATION);
  const compact=migration.replace(/\s+/g,'');

  for(const table of [
    'platform.registration_settings',
    'platform.registration_identity_claims'
  ]){
    assert.match(migration,new RegExp(`alter table ${table.replace('.','\\.')} enable row level security;`));
    assert.match(
      migration,
      new RegExp(`revoke all on table ${table.replace('.','\\.')}\\s+from public,anon,authenticated;`)
    );
  }
  for(const signature of [
    'public.v1_platform_registration_policy_snapshot()',
    'public.v1_platform_registration_policy_save(text,integer,text)',
    'public.v1_registration_mark_confirmation_sent(uuid,text)',
    'public.v1_registration_confirm_email_and_provision(text)',
    'public.v1_platform_registration_trust_action(uuid,text,integer,text)'
  ]){
    assert.ok(
      compact.includes(`revokeallonfunction${signature}frompublic,anon,authenticated;`),
      `missing narrow revoke: ${signature}`
    );
  }
  assert.ok(
    compact.includes(
      'grantexecuteonfunctionpublic.v1_registration_confirm_email_and_provision(text)toservice_role;'
    )
  );
  assert.equal(
    /grantexecuteonfunctionpublic\.v1_registration_confirm_email_and_provision\(text\)to(?:anon|authenticated);/.test(compact),
    false
  );
  for(const name of [
    'v1_platform_registration_policy_snapshot',
    'v1_platform_registration_policy_save',
    'v1_registration_mark_confirmation_sent',
    'v1_registration_confirm_email_and_provision',
    'v1_platform_registration_trust_action'
  ]){
    const fn=section(
      migration,
      `create or replace function public.${name}`,
      '$$;'
    );
    assert.match(fn,/security definer\s+set search_path=''/);
  }
});

test('trial tenant access preserves the temporary-password security gate',async()=>{
  for(const migration of [await read(MIGRATION),await read(PASSWORD_GATE_HOTFIX)]){
    for(const name of ['can_access_tenant','has_tenant_permission']){
      const fn=section(
        migration,
        `create or replace function private_app.${name}`,
        '$$;'
      );
      assert.match(fn,/tenant\.status in \('trial','active'\)/);
      assert.match(fn,/and not subject\.must_change_password/);
    }
  }
});

test('email confirmation GET is read-only and POST delegates the mutation only to the Edge intake',async()=>{
  const route=await read('app/api/public/registration/confirm/route.js');
  const get=section(route,'export async function GET','export async function POST');
  const post=section(route,'export async function POST','function clearConfirmCookie');

  assert.match(get,/CONFIRM_COOKIE/);
  assert.match(get,/httpOnly:true/);
  assert.match(get,/sameSite:'strict'/);
  assert.doesNotMatch(get,/fetch\(|\/rest\/v1\/rpc|SUPABASE_URL|confirm_email_and_provision/);

  assert.match(post,/fetch\(/);
  assert.match(post,/\$\{SUPABASE_URL\}\/functions\/v1\/\$\{EDGE_FUNCTION\}/);
  assert.match(post,/body:JSON\.stringify\(\{action:'confirm',token\}\)/);
  assert.match(post,/apikey:SUPABASE_KEY/);
  assert.match(post,/'x-odeir-intake-token':ingressToken/);
  assert.match(post,/ingressToken\.length<32/);
  assert.doesNotMatch(post,/SUPABASE_SECRET_KEY|serverKey/);
  assert.doesNotMatch(post,/\/rest\/v1\/rpc|v1_registration_confirm_email_and_provision/);
  assert.doesNotMatch(route,/SUPABASE_SERVICE_ROLE_KEY|service[_\s.-]?role/i);
});

test('automatic activation is eligible only for a new unlinked institution with an unclaimed formal identifier',async()=>{
  const migration=await read(MIGRATION);
  const submit=section(
    migration,
    'create or replace function public.v1_public_submit_registration_request',
    'create or replace function public.v1_registration_mark_confirmation_sent'
  );
  const confirm=section(
    migration,
    'create or replace function public.v1_registration_confirm_email_and_provision',
    'create or replace function private_app.registration_manual_trust_sync'
  );

  assert.match(submit,/v_mode:=case when v_state='new'[\s\S]*?else 'manual_review' end/);
  assert.match(submit,/if v_state='new' and v_account_id is not null[\s\S]*?invalid_external_account/);
  assert.match(submit,/v_commercial is null and v_national is null and v_tvtc is null/);
  for(const type of ['commercial','national','tvtc']){
    assert.match(submit,new RegExp(`registration_identity_claims claim[\\s\\S]*?claim\\.identifier_type='${type}'`));
  }
  assert.match(submit,/then\s+v_mode:='manual_review'/);
  assert.match(confirm,/request\.institution_state='new'/);
  assert.match(confirm,/request\.external_account_id is null/);
  assert.match(confirm,/request\.email_confirmed_at is null/);
  assert.match(confirm,/from platform\.registration_identity_claims claim/);
  assert.match(confirm,/'manualHoldReason','official_identifier_requires_review'/);
  assert.match(confirm,/'identityGuardApplied',true/);

  assert.match(migration,/primary key \(identifier_type,identifier_hash\)/);
  assert.match(migration,/registration_identifier_already_provisioned/);
  assert.match(migration,/create trigger platform_registration_identity_claim_sync[\s\S]*?after insert or update of provisioned_tenant_id/);
});

test('public directory identifiers are null evidence and the account UUID is the only external claim',async()=>{
  const [gateway,migration]=await Promise.all([
    read('supabase/functions/odeir-registration-manual-activation/index.ts'),
    read(MANUAL_ACTIVATION_INTEGRITY)
  ]);
  const directoryVerification=section(
    gateway,
    'async function verifyDirectoryInstitution',
    'async function boundedResponseText'
  );
  const complete=section(
    migration,
    'create or replace function public.v1_registration_activation_attestation_complete',
    'create or replace function public.v1_platform_registration_approve_and_activate'
  );
  const evidenceSnapshot=section(
    complete,
    'v_snapshot:=jsonb_strip_nulls',
    'v_evidence_hash:='
  );

  assert.ok(directoryVerification.includes('accountId:externalAccountId'));
  assert.ok(directoryVerification.includes('officialIdentifiers:null'));
  for(const key of [
    'commercialRegistration','nationalRegistration','tvtcLicense'
  ])assert.equal(
    directoryVerification.includes(`'${key}'`),
    false,
    `directory ${key} must remain display-only`
  );
  assert.equal(gateway.includes('function officialIdentifier'),false);
  assert.ok(evidenceSnapshot.includes("'accountId',v_external_account_id"));
  assert.ok(evidenceSnapshot.includes("'institutionName',v_verified_name"));
  assert.equal(/officialIdentifiers|commercial|national|tvtc/i.test(evidenceSnapshot),false);
  assert.equal(complete.includes("p_directory_evidence->'officialIdentifiers'"),false);
});

test('manual review is the default and the current policy is rechecked as a kill switch at confirmation',async()=>{
  const migration=await read(MIGRATION);
  const confirm=section(
    migration,
    'create or replace function public.v1_registration_confirm_email_and_provision',
    'create or replace function private_app.registration_manual_trust_sync'
  );
  const hold=section(
    confirm,
    "if v_current_mode<>'email_verified_trial' then",
    'if exists(\n    select 1\n    from auth.users'
  );

  assert.match(migration,/activation_mode text not null default 'manual_review'/);
  assert.match(migration,/insert into platform\.registration_settings\(singleton\)[\s\S]*?values \(true\)/);
  assert.match(confirm,/select setting\.activation_mode,setting\.trial_plan_key[\s\S]*?into v_current_mode,v_plan_key/);
  assert.match(confirm,/from platform\.registration_settings setting[\s\S]*?where setting\.singleton[\s\S]*?for share;/);
  assert.match(hold,/set activation_mode='manual_review'/);
  assert.match(hold,/email_confirmation_token_hash=null/);
  assert.match(hold,/'manualReviewRequired',true/);
  assert.match(hold,/'killSwitchApplied',true/);
  assert.doesNotMatch(hold,/provision_tenant_core|insert into core\.tenants/);
  assert.ok(
    confirm.indexOf("if v_current_mode<>'email_verified_trial' then")
      <confirm.indexOf('v_provisioning:=private_app.provision_tenant_core'),
    'the live kill switch must be evaluated before provisioning'
  );
});

test('confirmation tokens are hashed, expiring, one-time, and protected by resend cooldowns',async()=>{
  const [migration,edge]=await Promise.all([
    read(MIGRATION),
    read('supabase/functions/odeir-registration-intake/index.ts')
  ]);
  const confirm=section(
    migration,
    'create or replace function public.v1_registration_confirm_email_and_provision',
    'create or replace function private_app.registration_manual_trust_sync'
  );

  assert.match(migration,/email_confirmation_token_hash text[\s\S]*?\^\[a-f0-9\]\{64\}\$/);
  assert.match(migration,/create unique index[^\n]*platform_registration_confirmation_token_idx[\s\S]*?email_confirmation_token_hash/);
  assert.match(migration,/v_token_hash:=encode\(extensions\.digest\(v_token,'sha256'\),'hex'\)/);
  assert.match(migration,/email_confirmation_sent_at>now\(\)-interval '2 minutes'/);
  assert.match(migration,/'confirmationAlreadySent',true/);
  assert.match(confirm,/v_hash:=encode\(extensions\.digest\(p_token,'sha256'\),'hex'\)/);
  assert.match(confirm,/request\.email_confirmation_token_hash=v_hash/);
  assert.match(confirm,/request\.email_confirmation_expires_at>now\(\)/);
  assert.match(confirm,/for update;/);
  assert.match(confirm,/email_confirmation_token_hash=null/);
  assert.match(confirm,/email_confirmation_expires_at=null/);
  assert.match(edge,/delete publicResult\._confirmationToken/);
  assert.match(edge,/delete publicResult\.contactEmail/);
  assert.match(edge,/const clientIp=sourceClientIp\(request\)/);
  assert.match(edge,/p_rate_key:`confirm-source:\$\{ipHash\}`[\s\S]*?p_limit:240[\s\S]*?p_window_seconds:3_600/);
  assert.doesNotMatch(edge,/p_rate_key:`confirm:\$\{(?:token|tokenRateHash)/);
});

test('a consumed confirmation can never replay or rotate an owner invitation',async()=>{
  const [migration,route]=await Promise.all([
    read(STRICT_ONE_TIME),
    read('app/api/public/registration/confirm/route.js')
  ]);
  const wrapper=section(
    migration,
    'create or replace function public.v1_registration_confirm_email_and_provision',
    '$$;'
  );

  assert.match(migration,
    /alter function public\.v1_registration_confirm_email_and_provision\(text\)[\s\S]*?set schema private_app/);
  assert.match(migration,
    /rename to registration_confirm_email_and_provision_legacy/);
  assert.match(wrapper,/pg_catalog\.pg_advisory_xact_lock/);
  assert.match(wrapper,/select alias\.id,alias\.request_id,alias\.delivery_id[\s\S]*?where alias\.token_hash=v_hash/);
  assert.match(wrapper,/if v_alias_id is null or v_request_id is null or v_delivery_id is null then[\s\S]*?registration_confirmation_invalid/);
  const requestLock=wrapper.indexOf('from platform.registration_requests request');
  const aliasLock=wrapper.indexOf('select alias.consumed_at,alias.expires_at');
  assert.ok(requestLock>=0&&aliasLock>requestLock,'lock request before alias');
  assert.match(wrapper,/from platform\.registration_requests request[\s\S]*?for update/);
  assert.match(wrapper,/from platform\.registration_confirmation_token_aliases alias[\s\S]*?for update/);
  assert.match(wrapper,/if v_consumed_at is not null then[\s\S]*?registration_confirmation_already_used/);
  assert.match(wrapper,/where alias\.id=v_alias_id[\s\S]*?for update/);
  assert.match(wrapper,/if v_expires_at<=clock_timestamp\(\) then[\s\S]*?registration_confirmation_invalid/);
  assert.ok(
    wrapper.indexOf("raise exception 'registration_confirmation_already_used'")
      <wrapper.indexOf('private_app.registration_confirm_email_and_provision_legacy'),
    'consumption must be rejected before the legacy transaction is entered'
  );
  assert.doesNotMatch(wrapper,/tenant_invitations|invitationToken|token_hash=encode/);
  assert.match(migration,
    /revoke all on function[\s\S]*?registration_confirm_email_and_provision_legacy\(text\)[\s\S]*?from public,anon,authenticated,service_role/);
  assert.match(migration,
    /grant execute on function public\.v1_registration_confirm_email_and_provision\(text\)[\s\S]*?to service_role/);
  assert.match(route,
    /registration_confirmation_invalid[\s\S]*?registration_confirmation_already_used[\s\S]*?invalidConfirmation\?'invalid':'unavailable'/);
});

test('activation policy is permission checked, server-gated, and wired to the platform settings UI',async()=>{
  const [migration,route,helper,settings,ui]=await Promise.all([
    read(MIGRATION),
    read('app/api/platform/registration-policy/route.js'),
    read('lib/platform-registration-policy.js'),
    read('app/control/settings/page.js'),
    read('components/registration-activation-policy.js')
  ]);

  assert.match(migration,/has_platform_permission\('platform\.settings\.manage'\)/);
  assert.match(migration,/v1_platform_registration_policy_save/);
  assert.match(route,/registrationEmailActivationGrant\(\)/);
  assert.match(route,/v1_platform_registration_policy_snapshot/);
  assert.match(route,/v1_platform_registration_policy_save_email/);
  assert.match(route,/if\(!emailReadiness\.activationReady\)/);
  assert.match(route,/activationMode==='manual_review'[\s\S]*?v1_platform_registration_policy_save/);
  assert.match(route,/v1_platform_registration_policy_save/);
  assert.match(route,/boundedRequestText\(request,MAX_BODY_BYTES\)/);
  assert.match(helper,/import 'server-only'/);
  assert.match(helper,/apikey:SUPABASE_KEY/);
  assert.match(helper,/'x-odeir-intake-token':ingressToken/);
  assert.doesNotMatch(helper,/SUPABASE_SECRET_KEY|serverKey/);
  assert.match(helper,/emailReady:emailReadiness\.activationReady/);
  assert.match(helper,/emailCanaryReady:emailReadiness\.canaryReady/);
  assert.match(settings,/hasPlatformPermission\([\s\S]*?'platform\.settings\.manage'/);
  assert.match(settings,/RegistrationActivationPolicy/);
  assert.match(ui,/value="manual_review"/);
  assert.match(ui,/value="email_verified_trial"/);
  assert.match(ui,/disabled=\{!policy\.emailReady\}/);
  assert.match(ui,/data-block-reason=\{!policy\.emailReady\?emailBlockReason:undefined\}/);
  assert.match(ui,/data-block-next-step=\{!policy\.emailReady\?emailBlockNextStep:undefined\}/);
  assert.ok(ui.includes('اختبار تسليم الإنتاج المعزول'));
  assert.ok(ui.includes('Webhook'));
  assert.match(ui,/registration-email-canary/);
  assert.match(ui,/data-block-reason=\{automaticFieldBlockReason\|\|undefined\}/);
  assert.match(ui,/data-block-reason=\{saveBlockReason\|\|undefined\}/);
  assert.match(ui,/fetch\('\/api\/platform\/registration-policy'/);
});

test('trust review actions are permissioned, versioned, and wired through the platform API and inbox UI',async()=>{
  const [migration,route,ui]=await Promise.all([
    read(MIGRATION),
    read('app/api/platform/registration-requests/route.js'),
    read('components/platform-registration-requests.js')
  ]);
  const trust=section(
    migration,
    'create or replace function public.v1_platform_registration_trust_action',
    'create or replace function private_app.can_access_tenant'
  );

  assert.match(trust,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(trust,/for update;/);
  assert.match(trust,/p_expected_version[^\n]*<>v_request\.version/);
  assert.match(trust,/v_request\.activation_mode<>'email_verified_trial'/);
  for(const action of ['trust_start','trust_approve','trust_restrict']){
    assert.match(trust,new RegExp(`v_action='${action}'`));
    assert.match(route,new RegExp(`['"]${action}['"]`));
    assert.match(ui,new RegExp(`['"]${action}['"]`));
  }
  assert.match(trust,/registration_trust_reason_required/);
  assert.match(trust,/set status='suspended'/);
  assert.match(trust,/tenant\.settings->>'registrationRequestId'=v_request\.id::text/);
  assert.match(trust,/tenant\.settings->>'registrationActivationMode'='email_verified_trial'/);
  assert.match(trust,/from core\.tenants tenant[\s\S]*?for update;[\s\S]*?if not found then/);
  assert.match(trust,/get diagnostics v_tenant_updated=row_count;/);
  assert.match(trust,/if v_tenant_updated<>1 then[\s\S]*?registration_trust_target_invalid/);
  assert.match(route,/v1_platform_registration_trust_action/);
  assert.match(ui,/trust_pending/);
  assert.match(ui,/trust_review/);
  assert.match(ui,/trust_restricted/);
});

test('automatic activation never names or targets an existing tenant',async()=>{
  const sources=await Promise.all([
    read(MIGRATION),
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('app/api/public/registration/confirm/route.js'),
    read('components/registration-activation-policy.js')
  ]);
  const combined=sources.join('\n');
  const confirm=section(
    sources[0],
    'create or replace function public.v1_registration_confirm_email_and_provision',
    'create or replace function private_app.registration_manual_trust_sync'
  );
  const provision=section(
    confirm,
    'v_provisioning:=private_app.provision_tenant_core',
    'update platform.registration_requests'
  );

  assert.doesNotMatch(combined,/reef|ريف/i);
  assert.doesNotMatch(sources[0],/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  assert.match(confirm,/v_provisioning:=private_app\.provision_tenant_core\(/);
  assert.match(provision,/'registrationRequestId',v_request\.id/);
  assert.match(provision,/'registrationActivationMode','email_verified_trial'/);
  assert.match(confirm,/update core\.tenants tenant[\s\S]+set status='active'/);
  assert.match(confirm,/tenant\.id=\(v_provisioning->>'id'\)::uuid/);
  assert.match(confirm,/tenant\.settings->>'registrationRequestId'=v_request\.id::text/);
  assert.match(confirm,/tenant\.settings->>'registrationActivationMode'='email_verified_trial'/);
  assert.doesNotMatch(confirm,/delete from core\.tenants/);
  assert.doesNotMatch(provision,/tenant\.slug=|tenant\.name=|tenant\.organization_id=/);
});

test('existing-institution success copy promises neither automatic email nor tenant linking',async()=>{
  const landing=await read('components/free-trial-landing.js');
  const state=section(landing,'const manualExisting','async function requestRegistrationChallenge');
  const success=section(
    landing,
    '{step === "success"',
    '{!registrationOnly && <>'
  );
  const existingMessageStart=positionOf(
    success,
    ':"لن نرسل رابط تفعيل تلقائيًا لهذا الطلب حمايةً للحساب'
  );
  const existingMessageEnd=success.indexOf('}</p>',existingMessageStart);
  assert.notEqual(existingMessageEnd,-1,'missing existing-institution message end');
  const existingMessage=success.slice(existingMessageStart,existingMessageEnd);
  const existingSteps=section(success,':manualExisting ? <>','</> : <>');

  assert.ok(state.includes('!confirmationRequired && !isNew'));
  assert.ok(existingMessage.includes('لن نرسل رابط تفعيل تلقائيًا'));
  assert.equal(/(?:ستُرسل|أرسلنا|سيصل|افحص بريدك)/.test(existingMessage),false);
  assert.ok(existingSteps.includes('تجهيز مساحة مستقلة'));
  assert.ok(existingSteps.includes('من دون المساس بأي مساحة قائمة'));
  assert.equal(/ربط|link/i.test(existingSteps),false);
});

test('the selected plan activates every entitled module in the new workspace',async()=>{
  const migration=await read(MIGRATION);
  const provision=section(
    migration,
    'create or replace function private_app.provision_tenant_core',
    'create or replace function public.v2_platform_provision_tenant'
  );

  assert.match(provision,/module\.status in \('active','beta'\)/);
  assert.match(provision,/from catalog\.plan_features plan_feature/);
  assert.match(provision,/plan_feature\.plan_id=v_plan_id/);
  assert.match(provision,/feature\.feature_key='module\.'\|\|module\.module_key/);
  assert.match(provision,/feature\.value_type='boolean'/);
  assert.match(provision,/plan_feature\.value='true'::jsonb/);
  assert.match(provision,/on conflict \(tenant_id,module_id\) do update[\s\S]*?set enabled=true/);
});


test('platform registration email transport is isolated from tenant automation',async()=>{
  const [edge,rootEnv,tenantEnv]=await Promise.all([
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('.env.example'),
    read('supabase/functions/training-automation-dispatch/.env.example')
  ]);

  assert.match(edge,/Deno\.env\.get\('ODEIR_REGISTRATION_RESEND_API_KEY'\)/);
  assert.match(edge,/Deno\.env\.get\('ODEIR_REGISTRATION_DOMAIN_VERIFIED_NAME'\)/);
  assert.match(edge,/Deno\.env\.get\('ODEIR_REGISTRATION_DOMAIN_VERIFIED_AT'\)/);
  assert.doesNotMatch(edge,/Deno\.env\.get\('RESEND_API_KEY'\)/);
  assert.doesNotMatch(edge,/Deno\.env\.get\('RESEND_FROM'\)/);
  assert.doesNotMatch(edge,/api\.resend\.com\/domains/);
  assert.match(edge,/registrationEmailTransportReady\(\)/);
  assert.match(edge,/registrationEmailHealth\(\)/);
  assert.match(edge,/isOdeirRegistrationSender/);
  assert.match(edge,/@odeir\\\.com/);
  assert.match(edge,/REGISTRATION_DOMAIN_VERIFIED_NAME===senderDomain/);
  assert.match(edge,/DOMAIN_VERIFICATION_MAX_AGE_MS=30\*24\*60\*60\*1000/);
  assert.match(edge,/emailReady:activationReady/);
  assert.match(edge,/const activationReady=sendReady&&telemetryReady&&canaryReady/);
  assert.match(edge,/registrationEmailConfigurationFingerprint/);
  assert.match(edge,/hmacSha256\(RATE_SALT,canonical\)/);
  assert.match(edge,/PRODUCTION_PROJECT_REF='gswpbwdactcstkasddta'/);
  assert.match(edge,/telemetryDegraded:sendReady&&!telemetryReady/);
  assert.match(edge,
    /legacyUnrecoverable=nonNegativeInteger\(outbox\.legacyUnrecoverable\)/
  );
  assert.match(edge,/&&legacyUnrecoverable===0/);
  assert.match(edge,/legacyUnrecoverable,/);

  assert.match(rootEnv,/^ODEIR_REGISTRATION_RESEND_API_KEY=$/m);
  assert.match(rootEnv,/^ODEIR_REGISTRATION_DOMAIN_VERIFIED_NAME=odeir\.com$/m);
  assert.match(rootEnv,/^ODEIR_REGISTRATION_DOMAIN_VERIFIED_AT=$/m);
  assert.match(rootEnv,/^ODEIR_REGISTRATION_INGRESS_TOKEN=$/m);
  assert.match(rootEnv,/^ODEIR_REGISTRATION_RATE_SALT=$/m);
  assert.doesNotMatch(rootEnv,/^RESEND_API_KEY=$/m);
  assert.match(tenantEnv,/^RESEND_API_KEY=$/m);
  assert.doesNotMatch(tenantEnv,/ODEIR_REGISTRATION_RESEND_API_KEY/);
});
