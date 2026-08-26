import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION=
  'supabase/migrations/20260826134558_registration_email_production_canary_v1.sql';

function functionSql(source,name){
  const marker=`create or replace function ${name}(`;
  const from=source.indexOf(marker);
  assert.notEqual(from,-1,`missing function: ${name}`);
  const to=source.indexOf('\n$$;',from);
  assert.notEqual(to,-1,`missing function terminator: ${name}`);
  return source.slice(from,to+4);
}

test('public confirmation is a one-time capability while admin operations require a verified JWT',async()=>{
  const [route,confirm,edge]=await Promise.all([
    read('app/api/public/registration/route.js'),
    read('app/api/public/registration/confirm/route.js'),
    read('supabase/functions/odeir-registration-intake/index.ts')
  ]);
  assert.match(route,/body\.action!=='submit'/);
  assert.match(route,/typeof body\.challenge!=='string'/);
  assert.match(route,/apikey:SUPABASE_KEY/);
  assert.doesNotMatch(route,
    /ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token|SUPABASE_SECRET_KEY/
  );
  assert.match(confirm,/body:JSON\.stringify\(\{action:'confirm',token\}\)/);
  assert.match(confirm,/origin!==publicAppOrigin\(\)/);
  assert.doesNotMatch(confirm,
    /ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token|SUPABASE_SECRET_KEY|serverKey/
  );
  const submit=edge.slice(
    edge.indexOf("if(action!=='submit')"),
    edge.indexOf("const allowed=await rpc<boolean>('v1_registration_rate_limit_consume")
  );
  assert.match(submit,/if\(!challenge\)/);
  assert.doesNotMatch(submit,/authorizedPlatformAdminRequest/);
  assert.match(edge,
    /if\(action==='confirm'\)\{\s*return confirmRegistration\(body\);/
  );
  assert.match(edge,
    /if\(action==='health'\)\{[\s\S]*?!await authorizedWorkerRequest\(request\)[\s\S]*?!await authorizedPlatformAdminRequest\(request\)/
  );
  assert.match(edge,
    /v1_platform_registration_policy_snapshot[\s\S]*?authorization:`Bearer \$\{accessToken\}`/
  );
  assert.match(edge,/apikey:ANON_KEY/);
  const adminAuthorization=edge.slice(
    edge.indexOf('async function authorizedPlatformAdminRequest'),
    edge.indexOf('async function authorizedWorkerRequest')
  );
  assert.doesNotMatch(adminAuthorization,/apikey:SERVICE_ROLE_KEY/);
  assert.doesNotMatch(edge,/ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token/);
});

test('automatic activation requires send, signed telemetry, and a recent delivered canary',async()=>{
  const [edge,helper,route,ui]=await Promise.all([
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('lib/platform-registration-policy.js'),
    read('app/api/platform/registration-policy/route.js'),
    read('components/registration-activation-policy.js')
  ]);
  assert.match(edge,/const activationReady=sendReady&&telemetryReady&&canaryReady/);
  assert.match(edge,/p_configuration_fingerprint:configurationFingerprint/);
  assert.match(edge,/PRODUCTION_PROJECT_REF='gswpbwdactcstkasddta'/);
  assert.match(edge,/emailReady:activationReady/);
  assert.match(helper,/result\.activationReady===true/);
  assert.match(helper,/emailReady:emailReadiness\.activationReady/);
  assert.match(route,/!emailReadiness\.activationReady/);
  assert.match(ui,/disabled=\{!policy\.emailReady\}/);
  assert.match(ui,/اختبار تسليم الإنتاج المعزول/);
});

test('canary ledger is PII-minimized, service-only, and reconciles signed webhooks',async()=>{
  const [migration,edge,route]=await Promise.all([
    read(MIGRATION),
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('app/api/platform/registration-email-canary/route.js')
  ]);
  const tableStart=migration.indexOf(
    'create table if not exists platform.registration_email_canaries'
  );
  const table=migration.slice(tableStart,migration.indexOf('\n);',tableStart)+3);
  assert.match(table,/recipient_hash text not null/);
  assert.doesNotMatch(table,/recipient_email|email_address|contact_email/);
  assert.match(migration,
    /alter table platform\.registration_email_canaries enable row level security/
  );
  for(const signature of [
    'public.v1_registration_email_canary_start(text,text)',
    'public.v1_registration_email_canary_record_event(text)',
    'public.v1_registration_email_canary_health(text)',
    'public.v1_registration_email_activation_grant_issue(text)'
  ]){
    assert.ok(migration.includes(`revoke all on function ${signature}`));
    assert.ok(migration.includes(`grant execute on function ${signature}`));
  }
  assert.match(table,/configuration_fingerprint text not null/);
  assert.match(migration,/registration_email_canary_rate_limited/);
  assert.match(migration,/expected_policy_version bigint not null/);
  assert.match(migration,/v1_platform_registration_policy_save_email/);
  assert.match(migration,/v1_registration_email_runtime_guard/);
  assert.match(migration,/v3_public_submit_registration_request/);
  assert.match(migration,/pg_advisory_xact_lock_shared/);
  const v3=functionSql(
    migration,'public.v3_public_submit_registration_request'
  );
  assert.match(v3,/if coalesce\(\(v_guard->>'failClosed'\)::boolean,false\)/);
  assert.match(v3,/return jsonb_build_object\('_retryManual',true\)/);
  assert.ok(
    v3.indexOf("return jsonb_build_object('_retryManual',true)")
      <v3.indexOf('public.v2_public_submit_registration_request'),
    'the fail-closed settings transaction must end before request locks'
  );
  assert.match(migration,
    /revoke all on function public\.v3_public_submit_registration_request\([\s\S]*?from public,anon,authenticated,service_role/
  );
  assert.match(migration,
    /grant execute on function public\.v3_public_submit_registration_request\([\s\S]*?to service_role/
  );
  assert.match(edge,/if\(action==='canary'\)/);
  assert.match(edge,/sendRegistrationEmailCanary/);
  assert.match(edge,/v1_registration_email_canary_start/);
  assert.match(edge,/v1_registration_email_canary_finish/);
  assert.match(edge,/v1_registration_email_canary_record_event/);
  assert.match(edge,/ODEIR REGISTRATION EMAIL/);
  assert.match(route,/v1_platform_registration_policy_snapshot/);
  assert.match(route,/origin!==publicAppOrigin\(\)/);
  assert.doesNotMatch(route,/request\.nextUrl\.origin/);
  assert.match(route,/Authorization:`Bearer \$\{token\}`/);
  assert.doesNotMatch(route,
    /ODEIR_REGISTRATION_INGRESS_TOKEN|x-odeir-intake-token|SUPABASE_SECRET_KEY/
  );
});

test('terminal, expired, and idempotency-conflict paths fail closed',async()=>{
  const [migration,edge]=await Promise.all([
    read(MIGRATION),
    read('supabase/functions/odeir-registration-intake/index.ts')
  ]);
  const failSafe=functionSql(
    migration,'public.v1_registration_email_delivery_fail_safe'
  );
  assert.match(failSafe,/activation_mode<>'email_verified_trial'/);
  assert.match(failSafe,/token_expires_at<=now\(\)/);
  assert.match(failSafe,/private_app\.registration_email_fallback_to_manual/);
  assert.doesNotMatch(failSafe,/provision_tenant_core|insert into core\.tenants/);
  const due=functionSql(
    migration,'public.v1_registration_email_delivery_due_ids'
  );
  assert.match(due,/delivery\.state='terminal_failed'/);
  assert.match(due,/delivery\.state='accepted'[\s\S]*?delivery\.token_expires_at<=now\(\)/);
  assert.match(due,/request\.activation_mode='email_verified_trial'/);
  assert.match(due,/request\.status='pending_review'/);
  assert.match(due,/request\.email_confirmed_at is null/);
  assert.match(due,/request\.provisioned_tenant_id is null/);
  assert.match(edge,/v2_registration_email_delivery_fail_safe/);
  assert.match(edge,/for\(let attempt=0;attempt<3;attempt\+\+\)/);
  assert.match(edge,/if\(guarded\._retryManual!==true\)/);
  assert.match(edge,/liveReady=false/);
  assert.doesNotMatch(edge,/if\(result\._retryManual===true\)[\s\S]*?v2_public_submit_registration_request/);
  assert.match(edge,
    /response\.status===409[\s\S]*?errorCode==='resend_concurrent_idempotent_requests'/
  );
  assert.match(edge,/invalid_idempotent_request/);
  assert.match(edge,/const concurrency=Math\.min\(4,deliveryIds\.length\)/);
  assert.doesNotMatch(edge,/Promise\.allSettled\(\s*deliveryIds\.map/);
});
