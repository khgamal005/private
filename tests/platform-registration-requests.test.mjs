import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

const MIGRATION='supabase/migrations/20260823193000_platform_registration_requests_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
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

test('public registration submits same-origin without exposing privileged credentials',async()=>{
  const [landing,route]=await Promise.all([
    read('components/free-trial-landing.js'),
    read('app/api/public/registration/route.js')
  ]);

  assert.match(landing,/['"]\/api\/public\/registration['"]/);
  assert.match(landing,/action\s*===?\s*['"]submit['"]/);
  assert.match(route,/odeir-registration-intake/);
  assert.match(route,/ODEIR_REGISTRATION_INGRESS_TOKEN/);
  assert.match(route,/x-odeir-intake-token/);
  assert.match(route,/SUPABASE_KEY/);
  assert.match(route,/SUPABASE_SECRET_KEY/);
  assert.match(route,/apikey:ingressToken\?SUPABASE_KEY:serverKey/);
  assert.doesNotMatch(landing,/SUPABASE_SERVICE_ROLE_KEY|service[_\s.-]?role|SUPABASE_SECRET/i);
  assert.doesNotMatch(landing,/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)/i);
  assert.doesNotMatch(route,/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|SERVICE)/i);
});

test('edge intake authenticates the server hop and rate limits anonymous submissions',async()=>{
  const [edge,config,serviceAuth]=await Promise.all([
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('supabase/config.toml'),
    read('supabase/migrations/20260823204500_registration_edge_service_auth_v1.sql')
  ]);

  assert.match(edge,/ODEIR_REGISTRATION_INGRESS_TOKEN/);
  assert.match(edge,/secureEqual\(/);
  assert.match(edge,/x-odeir-intake-token/);
  assert.match(edge,/v1_registration_edge_authorize/);
  assert.match(edge,/apikey:apiKey/);
  assert.match(serviceAuth,/revoke all on function public\.v1_registration_edge_authorize\(\)[\s\S]*?from public,anon,authenticated/);
  assert.match(serviceAuth,/grant execute on function public\.v1_registration_edge_authorize\(\)[\s\S]*?to service_role/);
  assert.match(edge,/v1_registration_rate_limit_consume/);
  assert.match(edge,/p_limit:3/);
  assert.match(edge,/p_window_seconds:86_400/);
  assert.match(edge,/SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edge,/v1_public_submit_registration_request/);
  assert.match(config,/\[functions\.odeir-registration-intake\][\s\S]*?verify_jwt\s*=\s*false/);
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

test('platform action API uses an allowlist and reports optimistic-lock conflicts as HTTP 409',async()=>{
  const route=await read('app/api/platform/registration-requests/route.js');

  for(const action of ['start_review','approve','reject','reopen','provision']){
    assert.match(route,new RegExp(`['"]${action}['"]`));
  }
  assert.match(route,/registration_action_invalid|invalid_action|action_not_allowed/);
  assert.match(route,/v1_platform_registration_request_action/);
  assert.match(route,/registration_request_conflict/);
  assert.match(route,/source\.includes\(['"]conflict['"]\)[\s\S]{0,240}?return 409;/);
  assert.doesNotMatch(route,/SUPABASE_SERVICE_ROLE_KEY|service[_\s.-]?role/i);
});

test('the new registration path is isolated from Reef and tenant records until provisioning',async()=>{
  const sources=await Promise.all([
    read(MIGRATION),
    read('supabase/functions/odeir-registration-intake/index.ts'),
    read('app/api/public/registration/route.js'),
    read('app/api/platform/registration-requests/route.js'),
    read('lib/platform-registration-requests.js'),
    read('app/control/registration-requests/page.js')
  ]);
  const combined=sources.join('\n');

  assert.doesNotMatch(combined,/reef|ريف/i);
  const beforeProvision=section(
    sources[0],
    'create table if not exists platform.registration_requests',
    "elsif v_action='provision' then"
  );
  assert.doesNotMatch(beforeProvision,/insert into core\.tenants|update core\.tenants|delete from core\.tenants/);
});
