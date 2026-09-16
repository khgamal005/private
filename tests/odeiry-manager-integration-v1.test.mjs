import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const paths={
  env:'.env.example',
  migration:'supabase/migrations/20260830191014_odeiry_manager_v1.sql',
  contract:'lib/odeiry-contract.mjs',
  agent:'lib/odeiry-agent.js',
  memorySafety:'lib/odeiry-manager-memory-safety.mjs',
  route:'app/api/odeiry/chat/route.js',
  service:'lib/odeiry-service-rpc.js',
  managerContract:'lib/odeiry-manager-contract.mjs',
  managerUi:'components/odeiry-manager-panel.js'
};

let sourcePromise;
function sources(){
  sourcePromise??=Promise.all(Object.entries(paths).map(async([key,path])=>[
    key,await readFile(new URL(path,root),'utf8')
  ])).then(Object.fromEntries);
  return sourcePromise;
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

function routine(sql,name){
  const pattern=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(name)}\\s*\\(`,
    'i'
  );
  const start=sql.search(pattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const tail=sql.slice(start);
  const bodyMarker=/\bas\s+(\$[a-zA-Z0-9_]*\$)/i.exec(tail);
  assert.ok(bodyMarker,`${name} must have a dollar-quoted body`);
  const delimiter=bodyMarker[1];
  const bodyStart=bodyMarker.index+bodyMarker[0].length;
  const end=tail.indexOf(`${delimiter};`,bodyStart);
  assert.notEqual(end,-1,`${name} must have a complete body`);
  return tail.slice(0,end+delimiter.length+1);
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
  let quoted=false;
  for(let index=open;index<sql.length;index+=1){
    const character=sql[index];
    if(character==="'"){
      if(quoted&&sql[index+1]==="'"){index+=1;continue;}
      quoted=!quoted;
      continue;
    }
    if(quoted)continue;
    if(character==='(')depth+=1;
    if(character===')'){
      depth-=1;
      if(depth===0)return sql.slice(start,index+1);
    }
  }
  assert.fail(`${name} must have a complete definition`);
}

function namedSet(source,name){
  const match=new RegExp(
    `const ${escapeRegExp(name)}=new Set\\(\\[([\\s\\S]*?)\\]\\);`
  ).exec(source);
  assert.ok(match,`${name} must be a literal allowlist`);
  return [...match[1].matchAll(/['"]([A-Za-z][A-Za-z0-9]*)['"]/g)]
    .map(item=>item[1]);
}

function lineKeys(source){
  return [...source.matchAll(/^\s*'([A-Za-z][A-Za-z0-9]*)',/gm)]
    .map(item=>item[1]);
}

test('manager rollout is additive, independently disabled, and narrowly assigned',async()=>{
  const {env,migration,route}=await sources();
  const normalized=compactSql(migration);
  assert.match(normalized,/^begin;/);
  assert.match(normalized,/commit;$/);
  assert.equal((migration.match(/^begin;\s*$/gmi)||[]).length,1);
  assert.equal((migration.match(/^commit;\s*$/gmi)||[]).length,1);
  assert.match(env,/^ODEIRY_MANAGER_ENABLED=false$/m);
  assert.doesNotMatch(env,/^NEXT_PUBLIC_ODEIRY_MANAGER/m);

  const settings=compactSql(tableDefinition(
    migration,'core.odeiry_manager_settings'
  ));
  assert.match(settings,/enabled boolean not null default false/);
  assert.doesNotMatch(normalized,
    /update core\.odeiry_manager_settings[^;]+set enabled\s*=\s*true/,
    'the migration must not activate a tenant implicitly');

  assert.match(normalized,
    /'tenant\.odeiry_manager\.use','ai_assistant'/);
  const roleGrant=normalized.slice(
    normalized.indexOf('insert into access_control.role_permissions'),
    normalized.indexOf('on conflict do nothing',
      normalized.indexOf('insert into access_control.role_permissions'))
  );
  for(const role of ['tenant_owner','tenant_admin','executive_manager']){
    assert.match(roleGrant,new RegExp(`'${role}'`));
  }
  assert.doesNotMatch(roleGrant,
    /sales|support|data_officer|admissions|accountant|employee/,
    'ordinary employee roles must not inherit manager capability');

  const managerFlag=route.indexOf(
    "process.env.ODEIRY_MANAGER_ENABLED!=='true'"
  );
  const snapshot=route.indexOf("'v3_tenant_odeiry_snapshot'");
  const provider=route.indexOf('process.env.OPENAI_API_KEY');
  assert.ok(managerFlag>=0&&snapshot>managerFlag&&provider>snapshot,
    'manager flag and tenant capability must fail before provider access');
});

test('the database kill switch gates analysis and preserves reviewed-memory cleanup',async()=>{
  const {migration}=await sources();
  const normalized=compactSql(migration);
  assert.match(normalized,
    /alter table platform\.odeiry_runtime_settings add column manager_enabled boolean not null default false/);

  const runtimeEnabled=compactSql(routine(
    migration,'private_app.odeiry_manager_runtime_enabled'
  ));
  assert.match(runtimeEnabled,
    /platform\.odeiry_runtime_settings runtime/);
  assert.match(runtimeEnabled,/runtime\.singleton/);
  assert.match(runtimeEnabled,/runtime\.manager_enabled/);

  const available=compactSql(routine(
    migration,'private_app.odeiry_manager_is_available'
  ));
  assert.match(available,
    /private_app\.odeiry_manager_runtime_enabled\(\)/);

  for(const name of [
    'public.v1_tenant_odeiry_manager_memory_context',
    'public.v1_tenant_odeiry_manager_analytics',
    'public.v1_tenant_odeiry_manager_thread'
  ])assert.match(
    compactSql(routine(migration,name)),
    /private_app\.odeiry_manager_is_available\(v_tenant\.id\)/,
    `${name} must fail closed through the database kill switch`
  );
  const workspace=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_workspace'
  ));
  assert.match(workspace,
    /private_app\.odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(workspace,
    /if private_app\.odeiry_manager_is_available\(v_tenant\.id\) then[\s\S]+?core\.odeiry_manager_threads[\s\S]+?else v_threads:='\[\]'::jsonb/);
  const memoryAction=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_memory_action'
  ));
  assert.match(memoryAction,
    /private_app\.odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(memoryAction,
    /if v_action='approve' and not private_app\.odeiry_manager_is_available\(v_tenant\.id\) then raise exception 'odeiry_manager_unavailable'/);

  const action=compactSql(routine(
    migration,'public.v3_tenant_odeiry_action'
  ));
  assert.match(action,
    /if v_mode='manager_v1'[\s\S]+?private_app\.odeiry_manager_is_available\(v_tenant\.id\)/);

  const propose=compactSql(routine(
    migration,'public.v1_service_odeiry_manager_memory_propose'
  ));
  assert.match(propose,
    /private_app\.odeiry_manager_runtime_enabled\(\)/);

  const finalize=compactSql(routine(
    migration,'public.v4_service_odeiry_finalize'
  ));
  assert.match(finalize,
    /private_app\.odeiry_manager_runtime_enabled\(\)/);

  const snapshot=compactSql(routine(
    migration,'public.v3_tenant_odeiry_snapshot'
  ));
  assert.match(snapshot,
    /'globalenabled',coalesce\(v_runtime\.manager_enabled,false\)/);
  assert.match(snapshot,/'reviewavailable',v_manager_review_available/);
  assert.match(snapshot,/manager_globally_disabled/);
});

test('manager state is tenant-and-owner scoped, RLS protected, and not directly writable',async()=>{
  const {migration}=await sources();
  const normalized=compactSql(migration);
  const tables=[
    'core.odeiry_manager_settings','core.odeiry_manager_threads',
    'core.odeiry_manager_memories','core.odeiry_manager_memory_requests'
  ];
  for(const table of tables){
    const definition=compactSql(tableDefinition(migration,table));
    assert.match(definition,/tenant_id uuid (?:not null|primary key)/);
    assert.match(definition,/references core\.tenants\(id\) on delete restrict/);
    assert.match(normalized,new RegExp(
      `alter table ${escapeRegExp(table)} enable row level security`
    ));
    assert.match(normalized,new RegExp(
      `revoke all on table ${escapeRegExp(table)} from public,anon,authenticated,service_role`
    ));
  }
  assert.doesNotMatch(normalized,
    /grant (?:select|insert|update|delete|all) on table core\.odeiry_manager_/,
    'manager tables must be reachable only through reviewed functions');

  const marker=compactSql(tableDefinition(
    migration,'core.odeiry_manager_threads'
  ));
  assert.match(marker,/primary key \(tenant_id,thread_id\)/);
  assert.match(marker,/unique \(tenant_id,thread_id,owner_subject_id\)/);
  assert.match(marker,
    /foreign key \(tenant_id,thread_id,owner_subject_id\)[^;]+references core\.odeiry_threads\( tenant_id,id,created_by_subject_id \)/);

  const memories=compactSql(tableDefinition(
    migration,'core.odeiry_manager_memories'
  ));
  assert.match(memories,/owner_subject_id uuid not null/);
  assert.match(memories,
    /status text not null default 'proposed'[^;]+approved[^;]+rejected[^;]+archived/);
  assert.match(memories,
    /foreign key \(tenant_id,source_thread_id,owner_subject_id\)[^;]+references core\.odeiry_manager_threads/);
  assert.match(normalized,
    /create trigger odeiry_manager_memory_requests_append_only before update or delete on core\.odeiry_manager_memory_requests/);
});

test('manager authorization requires real tenant membership and excludes platform preview',async()=>{
  const {migration,route}=await sources();
  const normalized=compactSql(migration);
  const canUse=compactSql(routine(
    migration,'private_app.odeiry_manager_can_use'
  ));
  assert.match(canUse,/security definer set search_path\s*=\s*''/);
  assert.match(canUse,/auth\.uid\(\) is not null/);
  assert.match(canUse,
    /private_app\.support_is_active_tenant_member\(p_tenant_id\)/);
  assert.match(canUse,
    /platform_membership\.scope='platform' and platform_membership\.status='active'/,
    'any active platform membership must explicitly bar manager mode');
  assert.match(canUse,/access_control\.membership_roles membership_role/);
  assert.match(canUse,/role\.scope='tenant'/);
  assert.match(canUse,
    /role_permission\.permission_key='tenant\.odeiry_manager\.use'/);
  assert.doesNotMatch(canUse,
    /has_tenant_permission|platform\.control\.read|odeiry_is_active_tenant_member/,
    'manager access must use the exact tenant role permission, never a platform shortcut');
  assert.match(canUse,
    /and not private_app\.odeiry_is_platform_operator\(p_tenant_id\)/,
    'platform preview must be an explicit deny even if other permissions evolve');

  const snapshot=compactSql(routine(
    migration,'public.v3_tenant_odeiry_snapshot'
  ));
  assert.match(snapshot,
    /v_manager_allowed:=v_access_mode='tenant_member' and not private_app\.odeiry_is_platform_operator\(v_tenant\.id\) and private_app\.odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(snapshot,
    /'manager',jsonb_build_object\( 'allowed',v_manager_allowed,[^;]+'available',v_manager_available/);
  assert.match(snapshot,/'reviewavailable',v_manager_review_available/);
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_snapshot\(text\) to authenticated/);

  const managerModeGate=route.slice(
    route.indexOf("if(input.assistantMode==='manager_v1')"),
    route.indexOf('// A tenant member',
      route.indexOf("if(input.assistantMode==='manager_v1')"))
  );
  assert.match(managerModeGate,
    /snapshot\.mode!==['"]tenant_member['"]\|\|!snapshot\.manager\.allowed/);
  assert.match(route,
    /assistantMode===['"]manager_v1['"]&&viewer\.platformAccess===true/);
});

test('the authoritative action wrapper separates manager and operations capabilities',async()=>{
  const {migration,contract,route}=await sources();
  const normalized=compactSql(migration);
  const action=compactSql(routine(
    migration,'public.v3_tenant_odeiry_action'
  ));
  assert.match(normalized,
    /alter function public\.v3_tenant_odeiry_action\(text,text,jsonb\) rename to v3_tenant_odeiry_action_operations_v2_internal/);
  assert.match(normalized,
    /revoke all on function public\.v3_tenant_odeiry_action_operations_v2_internal\(text,text,jsonb\) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v3_tenant_odeiry_action_operations_v2_internal/,
    'the renamed v3 compatibility implementation must remain private');
  assert.match(action,
    /p_payload->>'assistantmode','operations_v2'/);
  assert.match(action,/v_mode not in \('operations_v2','manager_v1'\)/);
  assert.match(action,/v_forward_payload:=p_payload-'assistantmode'/);
  assert.match(action,
    /return public\.v3_tenant_odeiry_action_operations_v2_internal\( p_slug,p_action,v_forward_payload \)/,
    'the compatibility implementation remains the operations-only dispatcher');
  const managerGate=action.slice(
    action.indexOf("if v_mode='manager_v1'"),
    action.indexOf("if v_action='start_run'")
  );
  assert.match(managerGate,/odeiry_manager_can_use\(v_tenant\.id\)/);
  assert.match(managerGate,/odeiry_manager_is_available\(v_tenant\.id\)/);
  assert.match(action,
    /pg_advisory_xact_lock[^;]+v_client_request_id/,
    'cross-mode idempotency checks must share the existing start-run lock');
  assert.ok((action.match(/odeiry_manager_cross_mode_forbidden/g)||[]).length>=3);
  assert.match(action,
    /insert into core\.odeiry_manager_threads\( tenant_id,thread_id,owner_subject_id,created_at \)/);
  assert.match(action,
    /request_context=run\.request_context\|\|jsonb_build_object\( 'assistantmode',v_mode \)/);
  assert.match(action,
    /manager_analytics_count=case when v_mode='manager_v1' and coalesce\(v_result->>'recovered','false'\)='true' then 0 else run\.manager_analytics_count end/,
    'only a recovered manager run may reset its two-read analytics budget');
  assert.match(action,
    /v_action='link_ticket'[^;]+v_mode='manager_v1'[^;]+odeiry_manager_execution_forbidden/);
  assert.match(action,
    /join core\.odeiry_manager_threads marker[^;]+raise exception 'odeiry_manager_execution_forbidden'/);

  assert.match(contract,
    /ODEIRY_ASSISTANT_MODES=new Set\(\[\s*'operations_v2','manager_v1'/);
  assert.match(contract,
    /source\.assistantMode\|\|['"]operations_v2['"]/);
  assert.match(route,
    /\.\.\.\(input\.assistantMode===['"]manager_v1['"]\s*\?\{assistantMode:['"]manager_v1['"]\}:\{\}\)/,
    'legacy operations payloads stay unchanged while manager runs are explicit');
});

test('only explicitly approved personal memory can enter model context',async()=>{
  const {migration}=await sources();
  const normalized=compactSql(migration);
  const memoryTable=compactSql(tableDefinition(
    migration,'core.odeiry_manager_memories'
  ));
  assert.match(memoryTable,/evidence_hash text not null/);
  assert.doesNotMatch(memoryTable,/evidence_quote/,
    'literal evidence is verified once and must never be stored');
  const context=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_memory_context'
  ));
  assert.match(context,/private_app\.odeiry_manager_is_available\(v_tenant\.id\)/);
  assert.match(context,
    /join core\.odeiry_manager_threads marker[^;]+run\.requested_by_subject_id=v_subject_id[^;]+run\.request_context->>'assistantmode'='manager_v1'/);
  assert.match(context,/item\.owner_subject_id=v_subject_id/);
  assert.match(context,/item\.status='approved'/);
  assert.match(context,
    /item\.expires_at is null or item\.expires_at>now\(\)/);
  assert.match(context,/v_limit integer:=least\(greatest\(coalesce\(p_limit,8\),1\),8\)/);
  assert.doesNotMatch(context,
    /item\.status\s+in\s*\([^)]*(?:proposed|rejected|archived)/);

  const propose=compactSql(routine(
    migration,'public.v1_service_odeiry_manager_memory_propose'
  ));
  assert.match(propose,
    /run\.status='completed'[^;]+run\.request_context->>'assistantmode'='manager_v1'/);
  assert.match(propose,
    /message\.message_role='user'/);
  assert.match(propose,
    /v_evidence_basis<>'current_user_explicit'/);
  assert.match(propose,
    /strpos\( lower\(v_user_message\),lower\(v_evidence_quote\) \)=0/);
  assert.match(propose,
    /odeiry_manager_memory_text_safe\(v_statement\)[^;]+odeiry_manager_memory_text_safe\(v_evidence_quote\)/);
  assert.match(propose,
    /v_evidence_hash:=private_app\.odeiry_sha256\( to_jsonb\(v_evidence_quote\) \)/);
  assert.match(propose,
    /v_evidence_hash,v_content_hash,'proposed'/);
  assert.match(propose,/'acceptedcount',v_accepted/);
  assert.doesNotMatch(propose,/private_app\.write_audit/,
    'service proposal extraction has no authenticated audit actor');

  const safeText=compactSql(routine(
    migration,'private_app.odeiry_manager_memory_text_safe'
  ));
  assert.match(safeText,/pg_catalog\.regexp_replace/);
  assert.match(safeText,
    /'\[\^0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹\]'/,
    'all non-digits, including arbitrary separators, must be removed first');
  assert.match(safeText,
    /!~ '\[0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹\]\{8,\}'/,
    'eight-digit phone-like sequences must be rejected in every supported numeral set');
  for(const personPattern of ['عندنا','لدينا','manager','employee','customer']){
    assert.match(safeText,new RegExp(personPattern),
      'facts about identifiable people must be rejected from manager memory');
  }
  for(const personPattern of ['هو|هي','يدير|تدير','leads?']){
    assert.match(safeText,new RegExp(personPattern),
      'plain person-role statements must be rejected without relying on prompts');
  }
  assert.ok(safeText.includes('(to[ ]+)?'));
  const catalogSafe=compactSql(routine(
    migration,'private_app.odeiry_manager_memory_catalog_safe'
  ));
  for(const memoryKey of [
    'goal_increase_registrations','goal_improve_conversion',
    'goal_reduce_response_time','goal_improve_follow_up',
    'goal_improve_data_completeness','preference_concise_answers',
    'preference_detailed_answers','preference_summary_first',
    'preference_weekly_review','principle_data_first_decisions',
    'principle_review_before_adoption','constraint_verified_numbers_only',
    'constraint_read_only_recommendations','priority_sales',
    'priority_operations','priority_cash_collection'
  ])assert.match(catalogSafe,new RegExp(`'${memoryKey}'`));
  for(const parameter of [
    'p_memory_key','p_category','p_statement','p_evidence_quote',
    'p_source_message'
  ])assert.match(catalogSafe,new RegExp(parameter));
  assert.match(catalogSafe,
    /v_evidence_assertion<>v_source_assertion/,
    'the literal quote and whole current message must normalize to one exact assertion');
  assert.match(catalogSafe,/v_source_assertion in \(/,
    'catalog evidence must use exact reviewed phrases rather than substring regexes');
  const evidenceNormalizer=compactSql(routine(
    migration,'private_app.odeiry_manager_memory_evidence_normalized'
  ));
  for(const marker of ['احفظ','remember','save','يا أوديري']){
    assert.match(evidenceNormalizer,new RegExp(marker));
  }
  assert.match(propose,
    /odeiry_manager_memory_catalog_safe\( v_memory_key,v_category,v_statement,v_evidence_quote,v_user_message \)/,
    'the database must validate the complete tuple against the whole user message');
  assert.doesNotMatch(propose,/odeiry_manager_memory_category_safe/,
    'category grammar alone must not admit arbitrary pending statements');

  const review=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_memory_action'
  ));
  assert.match(review,/memory\.owner_subject_id=v_subject_id/);
  assert.match(review,/v_memory\.version<>p_expected_version/);
  const requestLedger=compactSql(tableDefinition(
    migration,'core.odeiry_manager_memory_requests'
  ));
  assert.match(requestLedger,
    /unique \(tenant_id,owner_subject_id,client_request_id\)/);
  assert.match(review,/odeiry_manager_idempotency_conflict/);
  assert.match(normalized,
    /revoke all on function public\.v1_service_odeiry_manager_memory_propose\( text,uuid,jsonb \) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v1_service_odeiry_manager_memory_propose/,
    'only the unified finalizer may invoke the private proposal step');

  const settings=compactSql(tableDefinition(
    migration,'core.odeiry_manager_settings'
  ));
  const workspace=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_workspace'
  ));
  assert.match(settings,
    /max_approved_memories_per_owner smallint not null default 50 check \(max_approved_memories_per_owner between 5 and 100\)/);
  assert.match(workspace,/item\.status='approved'[^;]+limit 100/,
    'the review workspace must expose the full configured approved capacity');
});

test('review workspace limits agree across SQL, API validation, and UI normalization',async()=>{
  const {migration,managerContract,managerUi}=await sources();
  const workspace=compactSql(routine(
    migration,'public.v1_tenant_odeiry_manager_workspace'
  ));
  assert.match(workspace,/item\.status='proposed'[^;]+limit 50/);
  assert.match(workspace,/item\.status='approved'[^;]+limit 100/);
  assert.match(workspace,/item\.status='archived'[^;]+limit 20/);
  assert.match(managerContract,
    /memoryList\(memorySource\.pending,['"]proposed['"],50\)/);
  assert.match(managerContract,
    /memoryList\(memorySource\.approved,['"]approved['"],100\)/);
  assert.match(managerContract,
    /memoryList\(memorySource\.archived,['"]archived['"],20\)/);
  assert.match(managerUi,
    /MANAGER_MEMORY_LIMITS=\{pending:50,approved:100,archived:20\}/);
  for(const status of ['pending','approved','archived']){
    assert.match(managerUi,new RegExp(
      `slice\\(0,MANAGER_MEMORY_LIMITS\\.${status}\\)`
    ));
  }
});

test('one service dispatcher atomically finalizes manager completion and proposals',async()=>{
  const {migration,route,service}=await sources();
  const normalized=compactSql(migration);
  const finalize=compactSql(routine(
    migration,'public.v4_service_odeiry_finalize'
  ));
  assert.match(finalize,/select run\.\* into v_run[^;]+for update/);
  assert.match(finalize,/core\.odeiry_manager_threads marker/);
  assert.match(finalize,/odeiry_manager_mode_invariant_failed/);

  const operationsBranch=finalize.slice(
    finalize.indexOf('if not v_is_manager then'),
    finalize.indexOf("if v_status<>'completed' then")
  );
  assert.match(operationsBranch,
    /p_manager_memory_proposals is not null[^;]+odeiry_manager_cross_mode_forbidden/);
  assert.match(operationsBranch,/public\.v3_tenant_odeiry_finalize/,
    'operations completion must retain the reviewed legacy finalizer');

  const errorBranch=finalize.slice(
    finalize.indexOf("if v_status<>'completed' then"),
    finalize.indexOf('if p_manager_memory_proposals is null')
  );
  assert.match(errorBranch,
    /p_manager_memory_proposals is not null[^;]+odeiry_manager_payload_invalid/);
  assert.match(errorBranch,/public\.v3_tenant_odeiry_finalize/,
    'manager errors and cancellations must retain the reviewed legacy finalizer');

  assert.match(finalize,
    /jsonb_array_length\(p_manager_memory_proposals\)>2/);
  assert.match(finalize,/v_batch_hash:=private_app\.odeiry_sha256/);
  assert.match(finalize,
    /v_run\.manager_memory_batch_hash is distinct from v_batch_hash/);
  assert.match(finalize,/set manager_memory_batch_hash=v_batch_hash/);
  assert.match(finalize,/'memoryproposalcount',v_persisted_count/);
  assert.doesNotMatch(finalize,/exception\s+when/,
    'finalize, proposal validation, and receipt must share one transaction');
  const v3Call=finalize.lastIndexOf('public.v3_tenant_odeiry_finalize');
  const proposalCall=finalize.indexOf(
    'public.v1_service_odeiry_manager_memory_propose',v3Call
  );
  const receipt=finalize.indexOf(
    'set manager_memory_batch_hash=v_batch_hash',proposalCall
  );
  assert.ok(v3Call>=0&&proposalCall>v3Call&&receipt>proposalCall,
    'manager completion must finalize, propose, then persist its receipt');

  assert.match(normalized,
    /grant execute on function public\.v4_service_odeiry_finalize\( text,uuid,text,jsonb,jsonb \) to service_role/);
  const v3Compatibility=compactSql(routine(
    migration,'public.v3_tenant_odeiry_finalize'
  ));
  assert.match(v3Compatibility,/v_mode<>'operations_v2'/);
  assert.match(v3Compatibility,/core\.odeiry_manager_threads marker/);
  assert.match(v3Compatibility,/odeiry_manager_finalize_requires_v4/);
  assert.match(v3Compatibility,
    /public\.v3_tenant_odeiry_finalize_operations_v3_internal/);
  assert.match(normalized,
    /revoke all on function public\.v3_tenant_odeiry_finalize_operations_v3_internal\( text,uuid,text,jsonb \) from public,anon,authenticated,service_role/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v3_tenant_odeiry_finalize_operations_v3_internal/);
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_finalize\( text,uuid,text,jsonb \) to service_role/,
    'the rollout compatibility signature must remain service-only and operations-only');
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v1_service_odeiry_manager_memory_propose/);

  assert.match(service,
    /rest\/v1\/rpc\/v4_service_odeiry_finalize/);
  assert.match(service,
    /p_manager_memory_proposals:normalizedProposals/);
  assert.match(service,
    /normalizedProposals===null&&isMissingV4Finalizer\(response,data\)/,
    'only proposal-free operations and error paths may use the rollout fallback');
  assert.doesNotMatch(service,
    /rest\/v1\/rpc\/v1_service_odeiry_manager_memory_propose/);

  assert.match(route,
    /responseData:persistableOutput\(result\.output\)[\s\S]+?if\(input\.assistantMode===['"]manager_v1['"]\)[\s\S]+?finalizeWithRetry\([\s\S]+?result\.output\.memoryProposals/,
    'manager response and proposals must enter the unified finalizer together');
  assert.doesNotMatch(route,
    /persistManagerProposalsSafely|proposeOdeiryManagerMemories/);
});

test('manager analytics are two bounded aggregate reads with an exact allowlist',async()=>{
  const {migration,agent,route}=await sources();
  const normalized=compactSql(migration);
  const analytics=routine(
    migration,'public.v1_tenant_odeiry_manager_analytics'
  );
  const compactAnalytics=compactSql(analytics);
  assert.match(normalized,
    /manager_analytics_count smallint not null default 0/);
  assert.match(normalized,
    /odeiry_runs_manager_analytics_count_check check \(manager_analytics_count between 0 and 2\)/);
  assert.match(compactAnalytics,
    /v_period not in \('last_7_days','last_30_days'\)/);
  assert.match(compactAnalytics,
    /run\.manager_analytics_count<2/);
  assert.match(compactAnalytics,
    /run\.request_context->>'assistantmode'='manager_v1'/);
  assert.match(compactAnalytics,
    /public\.v5_tenant_reports_snapshot\( p_slug,v_from,v_to,null,'overview',50,0 \)/);
  assert.match(compactAnalytics,/v_report->'summary'/);
  assert.match(compactAnalytics,/v_report->'daily'/);
  assert.doesNotMatch(compactAnalytics,
    /v_report->'(?:employees|customers|staff|rows|sales|campaigns|tasks)'/,
    'the reports snapshot may be consumed only through aggregate summary and daily');
  assert.match(compactAnalytics,
    /private_app\.odeiry_manager_safe_number\(/,
    'every returned metric must pass the database numeric scalar boundary');
  assert.match(compactAnalytics,
    /jsonb_typeof\(item->'date'\)='string'/);
  assert.match(compactAnalytics,
    /octet_length\(v_result::text\)>32768/,
    'the direct RPC response must have a fixed database byte ceiling');

  const expectedMetrics=[
    'activities','answeredCalls','assignmentOperations','averageFirstResponseMinutes',
    'averageSaleMinor','callAnswerRate','calls','campaignCount',
    'contactedAssignedLeads','conversionRate','dataCompletenessRate',
    'firstResponseSlaRate','leadsAssigned','leadsCreated','overdueTasks',
    'paidContacts','pipelineValueMinor','realizedRevenueMinor',
    'talkSeconds','taskCompletionRate','tasksCompleted','tasksTotal',
    'validAssignedLeads','wonRevenueMinor'
  ].sort();
  const metricStart=analytics.indexOf("'metrics',jsonb_build_object(");
  const metricEnd=analytics.indexOf("\n    ),\n    'daily'",metricStart);
  assert.ok(metricStart>=0&&metricEnd>metricStart);
  assert.deepEqual(
    [...new Set(lineKeys(analytics.slice(metricStart,metricEnd)))]
      .filter(key=>key!=='metrics').sort(),
    expectedMetrics
  );
  assert.deepEqual([...namedSet(agent,'MANAGER_METRICS')].sort(),expectedMetrics);

  const expectedDaily=[
    'activities','calls','date','leadsAssigned','leadsCreated','paid',
    'tasksCompleted'
  ].sort();
  const dailyStart=analytics.indexOf('jsonb_agg(jsonb_build_object(');
  const dailyEnd=analytics.indexOf(') order by daily_item',dailyStart);
  assert.ok(dailyStart>=0&&dailyEnd>dailyStart);
  assert.deepEqual(
    [...new Set(lineKeys(analytics.slice(dailyStart,dailyEnd)))].sort(),
    expectedDaily
  );
  assert.deepEqual(
    [...namedSet(agent,'DAILY_METRICS'),'date'].sort(),expectedDaily
  );

  assert.match(agent,/MAX_MANAGER_ANALYTICS_CALLS=2/);
  assert.match(agent,/MAX_MANAGER_READ_CALLS=3/);
  assert.match(agent,
    /isEnabled:[\s\S]+?assistantMode===['"]manager_v1['"][\s\S]+?platformAccess!==true/);
  assert.match(agent,/byteLength<=8\*1024/);
  assert.match(route,
    /['"]v1_tenant_odeiry_manager_analytics['"][\s\S]+?p_slug:input\.slug[\s\S]+?p_run_id:started\.runId[\s\S]+?p_period:period/);
  assert.doesNotMatch(route,
    /v1_tenant_odeiry_manager_analytics[\s\S]{0,240}(?:tenantId|subjectId|query|sql|filter)/i);
});

test('manager runtime keeps memory reviewed and makes all execution impossible',async()=>{
  const {agent,memorySafety,route,service,managerUi}=await sources();
  assert.equal((agent.match(/new Agent\(/g)||[]).length,1);
  assert.match(agent,
    /instructions:runContext=>runContext\.context\?\.assistantMode===['"]manager_v1['"][\s\S]+?MANAGER_INSTRUCTIONS\):OPERATIONS_INSTRUCTIONS/);
  assert.match(agent,
    /mode===['"]manager_v1['"]\s*\?normalizeApprovedMemories\(approvedMemories\):\[\]/);
  assert.match(agent,
    /item\?\.status&&item\.status!==['"]approved['"]/);
  assert.match(agent,/budget\+size>4\*1024/);
  assert.match(agent,/memories\.length>=8/);
  assert.match(agent,
    /evidenceBasis!==['"]current_user_explicit['"][\s\S]+?!message\.includes\(evidenceQuote\)/);
  assert.match(agent,/safeText\(proposal\?\.evidenceQuote,160\)/);
  assert.match(agent,
    /containsSensitiveOrInstructionalText\(statement\)[\s\S]+?containsSensitiveOrInstructionalText\(evidenceQuote\)/);
  assert.match(memorySafety,/export const MANAGER_MEMORY_CATALOG=/);
  assert.match(memorySafety,/export function canonicalManagerMemoryProposal\(/);
  for(const source of [agent,service]){
    assert.match(source,/canonicalManagerMemoryProposal\(/,
      'both application boundaries must canonicalize proposals');
    assert.doesNotMatch(source,/hasDurableManagerMemoryShape/,
      'the former open-ended grammar must not remain in a persistence path');
    assert.match(source,
      /memoryKey:canonical\.memoryKey[\s\S]{0,240}category:canonical\.category[\s\S]{0,240}statement:canonical\.statement/,
      'only server-owned catalog fields may cross a persistence boundary');
  }
  assert.match(agent,
    /canonicalManagerMemoryProposal\(\{[\s\S]{0,180}sourceMessage:message/,
    'the application boundary must validate the quote against the whole message');
  for(const personPattern of ['عندنا','لدينا','manager','employee','customer']){
    assert.match(agent,new RegExp(personPattern),
      'the application boundary must reject facts about identifiable people');
  }
  assert.match(agent,
    /ignore (?:\(\?:all \|the \)\?)?\(\?:previous\|system\|developer\)|تجاهل/iu,
    'memory filtering must include prompt-injection phrases');
  assert.match(agent,
    /assistantMode===['"]manager_v1['"][\s\S]+?needsEscalation:false[\s\S]+?ticketDraft:null/);
  assert.doesNotMatch(agent,
    /name:['"](?:create|update|delete|send|assign|execute|link)_/i,
    'the model must have no action tool');

  const persistable=route.slice(
    route.indexOf('function persistableOutput'),
    route.length
  );
  assert.match(persistable,/memoryProposals:\[\]/,
    'evidence-bearing proposals must not be copied into stored model output');
  assert.match(route,
    /const finalized=await finalizeWithRetry\([\s\S]+?result\.output\.memoryProposals[\s\S]+?boundedProposalCount\(finalized\?\.memoryProposalCount\)/);
  assert.doesNotMatch(route,
    /persistManagerProposalsSafely|proposeOdeiryManagerMemories/);

  assert.match(service,/managerMemoryProposals\.length>2/);
  assert.match(service,
    /value\.evidenceBasis!==['"]current_user_explicit['"]/);
  assert.match(service,
    /unsafeMemoryText\(statement\)\|\|unsafeMemoryText\(evidenceQuote\)/);
  assert.match(service,/const digitCount=\(digits\.match\(\/\[0-9\]\/g\)\|\|\[\]\)\.length/);
  assert.match(service,/\|\|digitCount>=8/,
    'service validation must reject eight digits regardless of separators');
  assert.match(service,
    /normalizedProposals===null&&isMissingV4Finalizer\(response,data\)/);

  assert.match(managerUi,
    /this\.retryWithNewRequestId=result\?\.retryWithNewRequestId===true/);
  assert.match(managerUi,
    /retryWithNewRequestId=requestError instanceof ManagerRequestError[\s\S]+?setRetryAttempt\(retryWithNewRequestId\?\{[\s\S]+?requestId:clientRequestId\(\),[\s\S]+?startsNewRun:true/,
    'a terminal run must retry under a fresh idempotency key');
  assert.doesNotMatch(`${agent}\n${route}`,
    /create_ticket|v3_tenant_support_action|insert into core\.|update core\.|delete from core\./i);
});

