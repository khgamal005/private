import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260823194500_platform_email_verified_trial_v1.sql';
const PASSWORD_GATE_HOTFIX='supabase/migrations/20260823203000_registration_restore_password_gate_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
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
  assert.match(post,/apikey:ingressToken\?SUPABASE_KEY:\(serverKey\|\|SUPABASE_KEY\)/);
  assert.doesNotMatch(post,/if\(!ingressToken&&!serverKey\)/);
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
  assert.match(route,/registrationEmailReady\(\)/);
  assert.match(route,/const emailReady=await registrationEmailReady\(\)/);
  assert.match(route,/activationMode==='email_verified_trial'&&!emailReady/);
  assert.match(route,/v1_platform_registration_policy_save/);
  assert.match(helper,/import 'server-only'/);
  assert.match(helper,/apikey:ingressToken\?SUPABASE_KEY:\(serverKey\|\|SUPABASE_KEY\)/);
  assert.match(settings,/hasPlatformPermission\([\s\S]*?'platform\.settings\.manage'/);
  assert.match(settings,/RegistrationActivationPolicy/);
  assert.match(ui,/value="manual_review"/);
  assert.match(ui,/value="email_verified_trial"/);
  assert.match(ui,/disabled=\{!policy\.emailReady\}/);
  assert.match(ui,/data-block-reason=\{!policy\.emailReady\?emailBlockReason:undefined\}/);
  assert.match(ui,/data-block-next-step=\{!policy\.emailReady\?emailBlockNextStep:undefined\}/);
  assert.match(ui,/مفتاح Resend وبريد إرسال موثّق/);
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
