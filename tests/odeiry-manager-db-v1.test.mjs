import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const migrationPath=
  'supabase/migrations/20260830191014_odeiry_manager_v1.sql';

let migrationPromise;
function migration(){
  migrationPromise??=readFile(new URL(migrationPath,root),'utf8');
  return migrationPromise;
}

function compactSql(value){
  return value
    .replace(/--[^\n]*/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .toLowerCase();
}

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function tableDefinition(sql,name){
  const pattern=new RegExp(
    `create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+${escapeRegExp(name)}\\s*\\(`,
    'i'
  );
  const start=sql.search(pattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const open=sql.indexOf('(',start);
  let depth=0;
  let singleQuoted=false;
  for(let index=open;index<sql.length;index+=1){
    const character=sql[index];
    if(character==="'"){
      if(singleQuoted&&sql[index+1]==="'"){
        index+=1;
        continue;
      }
      singleQuoted=!singleQuoted;
      continue;
    }
    if(singleQuoted)continue;
    if(character==='(')depth+=1;
    if(character===')'){
      depth-=1;
      if(depth===0)return sql.slice(start,index+1);
    }
  }
  assert.fail(`${name} must have a complete definition`);
}

function routine(sql,name){
  const pattern=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(name)}\\s*\\(`,
    'i'
  );
  const start=sql.search(pattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const tail=sql.slice(start);
  const marker=/\bas\s+(\$[a-zA-Z0-9_]*\$)/i.exec(tail);
  assert.ok(marker,`${name} must have a dollar-quoted body`);
  const delimiter=marker[1];
  const bodyStart=marker.index+marker[0].length;
  const end=tail.indexOf(`${delimiter};`,bodyStart);
  assert.notEqual(end,-1,`${name} must have a complete body`);
  return tail.slice(0,end+delimiter.length+1);
}

test('manager migration is additive, transactional, and disabled by default',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  assert.match(sql,/^begin;/);
  assert.match(sql,/commit;$/);
  assert.equal((source.match(/^begin;\s*$/gmi)||[]).length,1);
  assert.equal((source.match(/^commit;\s*$/gmi)||[]).length,1);
  assert.match(sql,/odeiry_manager_missing_required_schema/);
  assert.match(sql,/odeiry_manager_missing_required_function/);
  assert.match(sql,
    /public\.v5_tenant_reports_snapshot\(text,date,date,uuid,text,integer,integer\)/);

  const settings=compactSql(tableDefinition(
    source,'core.odeiry_manager_settings'
  ));
  assert.match(settings,/enabled boolean not null default false/);
  assert.match(sql,
    /alter table platform\.odeiry_runtime_settings add column manager_enabled boolean not null default false/,
    'the independent database kill switch must start disabled');
  assert.doesNotMatch(sql,
    /insert into core\.odeiry_manager_settings[^;]+enabled[^;]+true/,
    'no tenant may be enabled by the migration itself');
  assert.doesNotMatch(sql,
    /update core\.odeiry_tenant_settings[^;]+set\s+enabled\s*=/,
    'manager v1 must not alter the existing tenant rollout gate');
  assert.doesNotMatch(sql,
    /update platform\.odeiry_runtime_settings[^;]+set\s+enabled\s*=/,
    'manager configuration must not mutate the base Odeiry kill switch');
});

test('the global database kill switch gates analysis but preserves memory cleanup',async()=>{
  const source=await migration();
  const runtimeEnabled=compactSql(routine(
    source,'private_app.odeiry_manager_runtime_enabled'
  ));
  assert.match(runtimeEnabled,/runtime\.manager_enabled/);
  const available=compactSql(routine(
    source,'private_app.odeiry_manager_is_available'
  ));
  assert.match(available,
    /private_app\.odeiry_manager_runtime_enabled\(\)/);

  const configure=compactSql(routine(
    source,'public.v1_platform_odeiry_manager_runtime_configure'
  ));
  assert.match(configure,
    /private_app\.has_platform_permission\('platform\.settings\.manage'\)/);
  assert.match(configure,/where runtime\.singleton for update/);
  assert.match(configure,/v_expected_version<>v_runtime\.version/);
  assert.match(configure,/set manager_enabled=v_enabled/);
  assert.match(configure,/version=runtime\.version\+1/);
  assert.doesNotMatch(configure,/set\s+enabled\s*=/);

  for(const name of [
    'public.v1_tenant_odeiry_manager_memory_context',
    'public.v1_tenant_odeiry_manager_analytics',
    'public.v1_tenant_odeiry_manager_thread'
  ])assert.match(
    compactSql(routine(source,name)),
    /private_app\.odeiry_manager_is_available\(v_tenant\.id\)/,
    `${name} must fail closed through the global gate`
  );
  const workspace=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_workspace'
  ));
  assert.match(workspace,
    /private_app\.odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(workspace,
    /if private_app\.odeiry_manager_is_available\(v_tenant\.id\) then[\s\S]+?core\.odeiry_manager_threads[\s\S]+?else v_threads:='\[\]'::jsonb/,
    'review-only workspace must return memory without exposing thread metadata');
  const memoryAction=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_memory_action'
  ));
  assert.match(memoryAction,
    /private_app\.odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(memoryAction,
    /if v_action='approve' and not private_app\.odeiry_manager_is_available\(v_tenant\.id\) then raise exception 'odeiry_manager_unavailable'/,
    'disabled Manager may reject/archive existing memory but never approve it');
  const propose=compactSql(routine(
    source,'public.v1_service_odeiry_manager_memory_propose'
  ));
  assert.match(propose,/private_app\.odeiry_manager_runtime_enabled\(\)/);
  const snapshot=compactSql(routine(
    source,'public.v3_tenant_odeiry_snapshot'
  ));
  assert.match(snapshot,
    /'globalenabled',coalesce\(v_runtime\.manager_enabled,false\)/);
  assert.match(snapshot,
    /v_manager_review_available:=v_manager_allowed and exists\([^;]+core\.odeiry_manager_memories/);
  assert.match(snapshot,/'reviewavailable',v_manager_review_available/);
  assert.match(snapshot,/manager_globally_disabled/);
});

test('the independent permission is granted only to executive tenant roles',async()=>{
  const sql=compactSql(await migration());
  assert.match(sql,
    /'tenant\.odeiry_manager\.use','ai_assistant'/);
  assert.match(sql,
    /role\.role_key in \( 'tenant_owner','tenant_admin','executive_manager' \)/);
  assert.doesNotMatch(sql,
    /permission_key\s+like\s+'tenant\.%'/,
    'the new manager permission must never be assigned through a wildcard');
  assert.doesNotMatch(sql,
    /role_key in \([^)]*(?:sales_user|sales_manager|support|data_officer)/,
    'operational roles must not receive the manager capability implicitly');
});

test('expired approved memories are hidden and archived before review limits',async()=>{
  const source=await migration();
  const workspace=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_workspace'
  ));
  const action=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_memory_action'
  ));
  assert.match(workspace,
    /item\.status='approved' and \(item\.expires_at is null or item\.expires_at>now\(\)\)/);
  assert.match(action,
    /set status='archived', version=memory\.version\+1, archived_at=v_now,[\s\S]+?memory\.status='approved'[\s\S]+?memory\.expires_at<=v_now/);
  assert.match(action,/memory\.id<>p_memory_id/,
    'the requested stale archive must remain actionable instead of rolling cleanup back');
  assert.match(action,/get diagnostics v_expired_count=row_count/);
  assert.match(action,/odeiry\.manager\.memory\.expire/);
  assert.ok(
    action.indexOf("set status='archived'")<
      action.indexOf("memory.status='approved' )>=v_setting.max_approved_memories_per_owner"),
    'expiry cleanup must happen before enforcing the approved-memory limit'
  );
});

test('audit actor foreign keys cannot be nulled through subject deletion',async()=>{
  const source=await migration();
  const settings=compactSql(tableDefinition(
    source,'core.odeiry_manager_settings'
  ));
  const memories=compactSql(tableDefinition(
    source,'core.odeiry_manager_memories'
  ));
  assert.match(settings,
    /enabled_by_subject_id uuid references access_control\.subjects\(id\) on delete restrict/);
  assert.match(memories,
    /reviewed_by_subject_id uuid references access_control\.subjects\(id\) on delete restrict/);
});

test('manager storage is tenant-and-owner scoped, RLS protected, and directly denied',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  const tables=[
    'core.odeiry_manager_settings',
    'core.odeiry_manager_threads',
    'core.odeiry_manager_memories',
    'core.odeiry_manager_memory_requests'
  ];
  for(const table of tables){
    const definition=compactSql(tableDefinition(source,table));
    assert.match(definition,/tenant_id uuid (?:not null|primary key)/);
    assert.match(definition,
      /references core\.tenants\(id\) on delete restrict/);
    assert.match(sql,new RegExp(
      `alter table ${escapeRegExp(table)} enable row level security`
    ));
    assert.match(sql,new RegExp(
      `revoke all on table ${escapeRegExp(table)} from public,anon,authenticated,service_role`
    ));
  }
  const marker=compactSql(tableDefinition(
    source,'core.odeiry_manager_threads'
  ));
  assert.match(marker,
    /foreign key \(tenant_id,thread_id,owner_subject_id\) references core\.odeiry_threads\( tenant_id,id,created_by_subject_id \)/);

  const memory=compactSql(tableDefinition(
    source,'core.odeiry_manager_memories'
  ));
  assert.match(memory,/owner_subject_id uuid not null/);
  assert.match(memory,
    /status in \('proposed','approved','rejected','archived'\)/);
  assert.match(memory,/evidence_hash text not null/);
  assert.doesNotMatch(memory,/evidence_quote/,
    'the literal evidence quote must never be stored');
  assert.match(sql,/one_proposed_key_uidx[^;]+where status='proposed'/);
  assert.match(sql,/one_approved_key_uidx[^;]+where status='approved'/);
  assert.match(sql,/memory_requests_append_only/);
  for(const [indexName,table] of [
    ['core_odeiry_manager_threads_owner_subject_idx',
      'core.odeiry_manager_threads'],
    ['core_odeiry_manager_memories_owner_subject_idx',
      'core.odeiry_manager_memories'],
    ['core_odeiry_manager_memory_requests_owner_subject_idx',
      'core.odeiry_manager_memory_requests']
  ])assert.match(sql,new RegExp(
    `create index ${indexName} on ${escapeRegExp(table)}\\(owner_subject_id\\)`
  ));
});

test('manager authorization requires real membership and never the platform compatibility helper',async()=>{
  const source=await migration();
  const canUse=compactSql(routine(
    source,'private_app.odeiry_manager_can_use'
  ));
  assert.match(canUse,/security definer set search_path\s*=\s*''/);
  assert.match(canUse,
    /private_app\.support_is_active_tenant_member\(p_tenant_id\)/);
  assert.match(canUse,
    /not private_app\.odeiry_is_platform_operator\(p_tenant_id\)/,
    'a platform operator remains barred even when they also hold membership');
  assert.match(canUse,
    /platform_membership\.scope='platform' and platform_membership\.status='active'/,
    'any active platform membership must bar manager mode');
  assert.match(canUse,/access_control\.membership_roles membership_role/);
  assert.match(canUse,/role\.scope='tenant'/);
  assert.match(canUse,
    /role_permission\.permission_key='tenant\.odeiry_manager\.use'/);
  assert.doesNotMatch(canUse,/has_tenant_permission|platform\.control\.read/,
    'manager authorization must not inherit a platform permission shortcut');
  assert.doesNotMatch(canUse,/odeiry_is_active_tenant_member/,
    'the compatibility helper includes platform operators and is forbidden');

  const snapshot=compactSql(routine(
    source,'public.v3_tenant_odeiry_snapshot'
  ));
  assert.match(snapshot,/'manager',jsonb_build_object/);
  assert.match(snapshot,/'allowed',v_manager_allowed/);
  assert.match(snapshot,
    /v_manager_allowed:=v_access_mode='tenant_member' and not private_app\.odeiry_is_platform_operator\(v_tenant\.id\)/);
  assert.match(snapshot,/'available',v_manager_available/);
  assert.match(snapshot,/'reviewavailable',v_manager_review_available/);
  assert.match(snapshot,/'permission_required'/);
});

test('the public action wrapper separates modes and forbids manager execution',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  assert.match(sql,
    /alter function public\.v3_tenant_odeiry_action\(text,text,jsonb\) rename to v3_tenant_odeiry_action_operations_v2_internal/);
  assert.match(sql,
    /revoke all on function public\.v3_tenant_odeiry_action_operations_v2_internal\(text,text,jsonb\) from public,anon,authenticated,service_role/);
  const action=compactSql(routine(
    source,'public.v3_tenant_odeiry_action'
  ));
  assert.match(action,/v_mode not in \('operations_v2','manager_v1'\)/);
  assert.match(action,/p_payload->>'assistantmode','operations_v2'/);
  assert.match(action,/core\.odeiry_manager_threads marker/);
  assert.match(action,/odeiry_manager_cross_mode_forbidden/);
  assert.match(action,
    /'odeir:odeiry:start:'\|\|v_tenant\.id::text\|\|':' \|\|v_subject_id::text\|\|':'\|\|v_client_request_id/,
    'mode checks must run under the same idempotency lock as run creation');
  assert.match(action,/request_context=run\.request_context\|\|jsonb_build_object\( 'assistantmode',v_mode \)/);
  assert.match(action,
    /when v_mode='manager_v1' and coalesce\(v_result->>'recovered','false'\)='true' then 0 else run\.manager_analytics_count/,
    'only recovered manager attempts reset their analytics budget');
  assert.match(action,
    /if v_action='link_ticket' then if v_mode='manager_v1' then raise exception 'odeiry_manager_execution_forbidden'/);
  assert.match(action,
    /join core\.odeiry_manager_threads marker[^;]+raise exception 'odeiry_manager_execution_forbidden'/);
});

test('memory proposals require literal current-message evidence and remain pending',async()=>{
  const source=await migration();
  const propose=compactSql(routine(
    source,'public.v1_service_odeiry_manager_memory_propose'
  ));
  assert.match(propose,/jsonb_array_length\(p_proposals\)>2/);
  assert.match(propose,/run\.status='completed'/);
  assert.match(propose,/run\.request_context->>'assistantmode'='manager_v1'/);
  assert.match(propose,/message\.message_role='user'/);
  assert.match(propose,/v_evidence_basis<>'current_user_explicit'/);
  assert.match(propose,
    /pg_catalog\.strpos\( lower\(v_user_message\),lower\(v_evidence_quote\) \)=0/);
  assert.match(propose,/private_app\.odeiry_manager_memory_text_safe\(v_statement\)/);
  assert.match(propose,/private_app\.odeiry_manager_memory_text_safe\(v_evidence_quote\)/);
  assert.match(propose,/'proposed',v_run\.thread_id,v_run\.id,1/);
  assert.doesNotMatch(propose,/private_app\.write_audit/,
    'service-role proposal extraction has no authenticated audit actor');
  assert.match(propose,/'acceptedcount',v_accepted/);
  assert.doesNotMatch(propose,/insert into[^;]+status[^;]+approved/,
    'the model/service path must never approve memory');

  const grants=compactSql(source);
  assert.doesNotMatch(grants,
    /grant execute on function public\.v1_service_odeiry_manager_memory_propose/,
    'proposal persistence must be callable only by the unified definer');
  assert.match(grants,
    /revoke all on function public\.v1_service_odeiry_manager_memory_propose\( text,uuid,jsonb \) from public,anon,authenticated,service_role/);

  const safeText=compactSql(routine(
    source,'private_app.odeiry_manager_memory_text_safe'
  ));
  assert.match(safeText,/pg_catalog\.regexp_replace/);
  assert.match(safeText,
    /'\[\^0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹\]','',\s*'g'/,
    'all non-digits must be removed, not only known separators');
  assert.match(safeText,
    /!~ '\[0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹\]\{8,\}'/,
    'ASCII and both Arabic digit sets must fail at eight digits');
});

test('only approved, unexpired personal memory enters bounded model context',async()=>{
  const source=await migration();
  const context=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_memory_context'
  ));
  assert.match(context,/v_limit integer:=least\(greatest\(coalesce\(p_limit,8\),1\),8\)/);
  assert.match(context,/item\.tenant_id=v_tenant\.id/);
  assert.match(context,/item\.owner_subject_id=v_subject_id/);
  assert.match(context,/item\.status='approved'/);
  assert.match(context,
    /item\.expires_at is null or item\.expires_at>now\(\)/);
  assert.doesNotMatch(context,/status\s+in\s+\([^)]*proposed/);
  assert.match(context,/run\.request_context->>'assistantmode'='manager_v1'/);
});

test('the workspace exposes every reviewable memory without volatile time',async()=>{
  const source=await migration();
  const workspace=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_workspace'
  ));
  assert.match(workspace,/language plpgsql stable security definer/);
  assert.match(workspace,/item\.status='proposed'[^;]+limit 50/);
  assert.match(workspace,/item\.status='approved'[^;]+limit 100/);
  assert.match(workspace,/statement_timestamp\(\)/);
  assert.doesNotMatch(workspace,/clock_timestamp\(\)/,
    'a STABLE workspace function must not call a volatile clock');
});

test('rolling rollback keeps v3 operations-only and manager finalization on v4',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  assert.match(sql,
    /alter function public\.v3_tenant_odeiry_finalize\(text,uuid,text,jsonb\) rename to v3_tenant_odeiry_finalize_operations_v3_internal/);
  assert.match(sql,
    /revoke all on function public\.v3_tenant_odeiry_finalize_operations_v3_internal\( text,uuid,text,jsonb \) from public,anon,authenticated,service_role/);
  const compatibility=compactSql(routine(
    source,'public.v3_tenant_odeiry_finalize'
  ));
  assert.match(compatibility,/security definer set search_path\s*=\s*''/);
  assert.match(compatibility,
    /v_run\.request_context->>'assistantmode','operations_v2'/);
  assert.match(compatibility,/core\.odeiry_manager_threads marker/);
  assert.match(compatibility,/v_mode<>'operations_v2'/);
  assert.match(compatibility,/odeiry_manager_finalize_requires_v4/);
  assert.match(compatibility,
    /public\.v3_tenant_odeiry_finalize_operations_v3_internal\(/);
  assert.match(sql,
    /grant execute on function public\.v3_tenant_odeiry_finalize\( text,uuid,text,jsonb \) to service_role/);
  assert.match(sql,/remove only in a later migration after old app revisions drain/,
    'the temporary compatibility lifecycle must be explicit');
});

test('one service dispatcher finalizes every mode and closes manager memory atomically',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  assert.match(sql,/manager_memory_batch_hash text/);
  assert.match(sql,
    /manager_memory_persisted_count smallint not null default 0/);
  assert.match(sql,/manager_memory_batch_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(sql,/manager_memory_persisted_count between 0 and 2/);

  const finalize=compactSql(routine(
    source,'public.v4_service_odeiry_finalize'
  ));
  assert.match(finalize,/for update/);
  assert.match(finalize,/core\.odeiry_manager_threads marker/);
  assert.match(finalize,/odeiry_manager_mode_invariant_failed/);
  assert.match(finalize,
    /if not v_is_manager then if p_manager_memory_proposals is not null then/);
  assert.match(finalize,
    /if v_status<>'completed' then if p_manager_memory_proposals is not null then/);
  assert.match(finalize,/jsonb_typeof\(p_manager_memory_proposals\)<>'array'/);
  assert.match(finalize,/private_app\.odeiry_manager_runtime_enabled\(\)/);
  assert.match(finalize,/v_batch_hash:=private_app\.odeiry_sha256/);
  assert.match(finalize,/v_run\.manager_memory_batch_hash is distinct from v_batch_hash/);
  assert.match(finalize,/v_run\.manager_memory_persisted_count/);
  assert.match(finalize,/memory\.source_run_id=v_run\.id/);
  assert.match(finalize,/set manager_memory_batch_hash=v_batch_hash/);
  assert.match(finalize,/'memoryproposalcount',v_persisted_count/);
  assert.doesNotMatch(finalize,/exception\s+when/,
    'finalize, propose, and receipt must share one uncaught transaction');
  assert.doesNotMatch(finalize,
    /public\.v3_tenant_odeiry_finalize\s*\(/,
    'v4 must bypass the operations-only compatibility wrapper');
  assert.match(finalize,
    /public\.v3_tenant_odeiry_finalize_operations_v3_internal\(/);
  const v3Call=finalize.lastIndexOf(
    'public.v3_tenant_odeiry_finalize_operations_v3_internal'
  );
  const proposalCall=finalize.indexOf(
    'public.v1_service_odeiry_manager_memory_propose',v3Call
  );
  const receipt=finalize.indexOf(
    'set manager_memory_batch_hash=v_batch_hash',proposalCall
  );
  assert.ok(v3Call>=0&&proposalCall>v3Call&&receipt>proposalCall,
    'manager completion must finalize, propose, then persist the receipt');

  assert.match(sql,
    /grant execute on function public\.v4_service_odeiry_finalize\( text,uuid,text,jsonb,jsonb \) to service_role/);
  assert.match(sql,
    /grant execute on function public\.v3_tenant_odeiry_finalize\( text,uuid,text,jsonb \) to service_role/);
  assert.doesNotMatch(sql,
    /grant execute on function public\.v1_service_odeiry_manager_memory_propose[^;]+to service_role/);
  assert.match(sql,
    /revoke all on function public\.v3_tenant_odeiry_finalize\( text,uuid,text,jsonb \) from public,anon,authenticated,service_role/);
});

test('analytics are aggregate-only, allowlisted, and capped at two reads per run',async()=>{
  const source=await migration();
  const sql=compactSql(source);
  assert.match(sql,
    /manager_analytics_count smallint not null default 0/);
  assert.match(sql,
    /manager_analytics_count between 0 and 2/);
  const analytics=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_analytics'
  ));
  assert.match(analytics,
    /v_period not in \('last_7_days','last_30_days'\)/);
  assert.match(analytics,/run\.manager_analytics_count<2/);
  assert.match(analytics,/odeiry_manager_analytics_limit/);
  assert.match(analytics,
    /public\.v5_tenant_reports_snapshot\( p_slug,v_from,v_to,null,'overview',50,0 \)/);
  assert.match(analytics,
    /clock_timestamp\(\) at time zone coalesce\( nullif\(v_tenant\.timezone,''\),'utc' \)/,
    'report dates must be calculated in the tenant timezone');
  assert.match(analytics,/'sourceid','tenant_reports_v5_aggregate'/);
  assert.match(analytics,/'scope','authorized_tenant_scope'/);
  for(const key of [
    'leadsCreated','tasksCompleted','realizedRevenueMinor',
    'conversionRate','firstResponseSlaRate','averageFirstResponseMinutes'
  ])assert.match(analytics,new RegExp(`'${key.toLowerCase()}'`));
  for(const forbidden of [
    'employees','staffid','viewer','customername','phone','email'
  ])assert.doesNotMatch(analytics,new RegExp(forbidden),
    `analytics output must not expose ${forbidden}`);
  assert.match(analytics,/limit 31/);
});

test('memory review is owner-only, versioned, idempotent, and audits no raw content',async()=>{
  const source=await migration();
  const review=compactSql(routine(
    source,'public.v1_tenant_odeiry_manager_memory_action'
  ));
  assert.match(review,/memory\.owner_subject_id=v_subject_id/);
  assert.match(review,/v_memory\.version<>p_expected_version/);
  assert.match(review,/odeiry_manager_version_conflict/);
  assert.match(review,/odeiry_manager_idempotency_conflict/);
  assert.match(review,/status in \('approve','reject','archive'\)|v_action not in \('approve','reject','archive'\)/);
  assert.match(review,/insert into core\.odeiry_manager_memory_requests/);
  assert.match(review,/private_app\.write_audit/);
  assert.match(review,/'contenthash',v_memory\.content_hash/);
  const auditStart=review.indexOf('private_app.write_audit');
  const audit=review.slice(auditStart);
  assert.doesNotMatch(audit,/v_memory\.statement|evidence_quote/,
    'audit metadata must contain hashes and identifiers only');
});

test('tenant deletion remains fail-closed for manager memory and history',async()=>{
  const source=await migration();
  const preview=compactSql(routine(
    source,'private_app.v1_tenant_deletion_preview_document'
  ));
  for(const table of [
    'core.odeiry_manager_settings','core.odeiry_manager_threads',
    'core.odeiry_manager_memories','core.odeiry_manager_memory_requests'
  ])assert.match(preview,new RegExp(escapeRegExp(table)));
  assert.match(preview,/odeiry_manager_memory_exists/);
  assert.match(preview,/'\{candelete\}'/);
  assert.match(preview,/dependencyfingerprint/);
  assert.match(preview,/previewdigest/);
});

test('every manager RPC has a closed signature and exact role grant',async()=>{
  const sql=compactSql(await migration());
  const tenantSignatures=[
    'v1_tenant_odeiry_manager_workspace\\(text\\)',
    'v1_tenant_odeiry_manager_thread\\(text,uuid\\)',
    'v1_tenant_odeiry_manager_memory_action\\( text,text,uuid,integer,text \\)',
    'v1_tenant_odeiry_manager_memory_context\\( text,uuid,text,integer \\)',
    'v1_tenant_odeiry_manager_analytics\\( text,uuid,text \\)'
  ];
  for(const signature of tenantSignatures){
    assert.match(sql,new RegExp(
      `grant execute on function public\\.${signature} to authenticated`
    ));
  }
  assert.match(sql,
    /grant execute on function public\.v1_platform_odeiry_manager_configure\( text,jsonb \) to authenticated/);
  assert.match(sql,
    /grant execute on function public\.v1_platform_odeiry_manager_runtime_configure\(jsonb\) to authenticated/);
  assert.match(sql,
    /grant execute on function public\.v4_service_odeiry_finalize\( text,uuid,text,jsonb,jsonb \) to service_role/);
});
