import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const migrationPath='supabase/migrations/20260830030000_odeiry_ai_foundation_v1.sql';

const sourcePaths={
  env:'.env.example',
  migration:migrationPath,
  fkIndexesMigration:
    'supabase/migrations/20260830104000_odeiry_fk_indexes_v1.sql',
  contract:'lib/odeiry-contract.mjs',
  requestGuard:'lib/odeiry-request-guard.mjs',
  agent:'lib/odeiry-agent.js',
  odeiryApi:'lib/odeiry-api.js',
  serviceRpc:'lib/odeiry-service-rpc.js',
  route:'app/api/odeiry/chat/route.js',
  linkRoute:'app/api/odeiry/link-ticket/route.js',
  assistant:'components/odeiry-assistant.js',
  shell:'components/workspace-shell.js',
  tenantLayout:'app/tenant/[slug]/layout.js',
  supportRoute:'app/api/support/tenant/[action]/route.js',
  supportMigration:'supabase/migrations/20260829164239_odeir_technical_support_v1.sql'
};

let sourcesPromise;
function sources(){
  sourcesPromise??=Promise.all(Object.entries(sourcePaths).map(async([key,path])=>[
    key,
    await readFile(new URL(path,root),'utf8')
  ])).then(Object.fromEntries);
  return sourcesPromise;
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
  const pattern=new RegExp(`create\\s+table(?:\\s+if\\s+not\\s+exists)?\\s+${escapeRegExp(name)}\\s*\\(`,'i');
  const start=sql.search(pattern);
  assert.notEqual(start,-1,`${name} must exist`);
  const open=sql.indexOf('(',start);
  let depth=0;
  let singleQuoted=false;
  let end=-1;
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
      if(depth===0){end=index+1;break;}
    }
  }
  assert.notEqual(end,-1,`${name} must have a complete definition`);
  return sql.slice(start,end);
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

function exportedHandler(source,name){
  const start=source.indexOf(`export async function ${name}`);
  assert.notEqual(start,-1,`${name} handler must exist`);
  return source.slice(start);
}

function callsTo(source,qualifiedName){
  const calls=[];
  let cursor=0;
  while(true){
    const start=source.indexOf(qualifiedName,cursor);
    if(start<0)break;
    const open=source.indexOf('(',start+qualifiedName.length);
    if(open<0)break;
    let depth=0;
    let quoted=null;
    let end=-1;
    for(let index=open;index<source.length;index+=1){
      const character=source[index];
      if(quoted){
        if(character===quoted&&source[index-1]!=='\\')quoted=null;
        continue;
      }
      if(character==="'"||character==='"'||character==='`'){
        quoted=character;
        continue;
      }
      if(character==='(')depth+=1;
      if(character===')'){
        depth-=1;
        if(depth===0){end=index+1;break;}
      }
    }
    assert.notEqual(end,-1,`${qualifiedName} call must be balanced`);
    calls.push(source.slice(start,end));
    cursor=end;
  }
  return calls;
}

test('Odeiry has independent global and tenant gates that are disabled by default',async()=>{
  const {env,migration,route,tenantLayout,odeiryApi}=await sources();
  const normalized=compactSql(migration);
  assert.match(normalized,/^begin;/);
  assert.match(normalized,/commit;$/,
    'the entire additive foundation must remain one reviewed transaction');
  assert.equal((migration.match(/^begin;\s*$/gmi)||[]).length,1);
  assert.equal((migration.match(/^commit;\s*$/gmi)||[]).length,1);
  assert.match(env,/^ODEIRY_AI_ENABLED=false$/m);
  assert.doesNotMatch(env,/^NEXT_PUBLIC_ODEIRY/m);
  assert.doesNotMatch(env,/^NEXT_PUBLIC_OPENAI/m);

  const runtimeConfig=compactSql(tableDefinition(
    migration,'platform.odeiry_runtime_settings'
  ));
  const tenantSettings=compactSql(tableDefinition(
    migration,'core.odeiry_tenant_settings'
  ));
  assert.match(runtimeConfig,/enabled boolean not null default false/);
  assert.match(tenantSettings,/enabled boolean not null default false/);
  assert.match(runtimeConfig,/billing_mode text not null default 'shadow'/);
  assert.match(normalized,
    /odeiry_runtime_settings_shadow_only_check[^;]+billing_mode\s*=\s*'shadow'/);
  assert.doesNotMatch(
    normalized,
    /update (?:core\.tenants|catalog\.plan_features)[^;]+(?:odeiry|feature\.ai\.contextual)/,
    'the foundation must not enable an existing tenant or plan implicitly'
  );

  const post=exportedHandler(route,'POST');
  const featureGuard=post.indexOf("process.env.ODEIRY_AI_ENABLED!=='true'");
  const keyGuard=post.indexOf('process.env.OPENAI_API_KEY');
  const serviceKeyGuard=post.indexOf('process.env.SUPABASE_SECRET_KEY');
  const credentialFailure=post.indexOf('if(!providerConfigured||!serviceRpcConfigured)');
  const startRun=post.indexOf("p_action:'start_run'");
  const tenantSnapshot=post.indexOf("'v3_tenant_odeiry_snapshot'");
  const providerBoundary=Math.max(
    post.indexOf("import('../../../../lib/odeiry-agent"),
    post.indexOf('runOdeiryAgent(')
  );
  assert.ok(featureGuard>=0,'the route must require an exact true feature flag');
  assert.ok(keyGuard>featureGuard,'the provider key check must follow the independent flag');
  assert.ok(serviceKeyGuard>featureGuard,
    'the privileged finalization channel must have a server key check');
  assert.ok(tenantSnapshot>=0&&keyGuard>tenantSnapshot,
    'credential state must not be probeable before authenticated tenant eligibility');
  assert.ok(credentialFailure>serviceKeyGuard&&startRun>credentialFailure,
    'both credentials must be present before a run reservation can start');
  assert.ok(providerBoundary>keyGuard,
    'both fail-closed guards must run before loading or calling the provider');
  assert.match(post,/odeiry_disabled/);
  assert.match(post,/odeiryFailure\(['"]odeiry_disabled['"],503\)/);
  assert.match(tenantLayout,/process\.env\.ODEIRY_AI_ENABLED==='true'/);
  assert.match(tenantLayout,/odeiryEnabled=\{odeiryEnabled\}/);
  assert.match(tenantLayout,
    /odeiryGloballyEnabled\s*\?optionalServerRead\([\s\S]+?:Promise\.resolve\(null\)/,
    'the disabled deployment path must not call an Odeiry database RPC');
  assert.match(tenantLayout,
    /odeirySnapshot\?\.available===true[\s\S]+?odeirySnapshot\?\.enabled===true/);
  assert.match(odeiryApi,/import ['"]server-only['"]/);
  assert.match(odeiryApi,/['"]v3_tenant_odeiry_snapshot['"]/);
  assert.doesNotMatch(odeiryApi,/tenantId|tenant_id/);
  assert.doesNotMatch(tenantLayout,/NEXT_PUBLIC_ODEIRY|OPENAI_API_KEY/);
});

test('provider and service credentials stay server-only and are never logged or serialized',async()=>{
  const {
    env,route,agent,assistant,migration,shell,tenantLayout,odeiryApi,serviceRpc
  }=await sources();
  assert.match(route,/import ['"]server-only['"]/);
  assert.match(agent,/import ['"]server-only['"]/);
  assert.match(serviceRpc,/import ['"]server-only['"]/);
  assert.match(`${route}\n${agent}`,/process\.env\.OPENAI_API_KEY/);
  assert.match(`${route}\n${serviceRpc}`,/process\.env\.SUPABASE_SECRET_KEY/);
  assert.doesNotMatch(`${route}\n${agent}`,/NEXT_PUBLIC_OPENAI|['"]sk-[a-z0-9_-]+/i);
  assert.doesNotMatch(`${assistant}\n${shell}\n${tenantLayout}\n${odeiryApi}\n${migration}`,
    /OPENAI_API_KEY|NEXT_PUBLIC_OPENAI|SUPABASE_SECRET_KEY|service[_-]?role[_-]?key/i);
  assert.match(env,/^OPENAI_API_KEY=$/m);
  assert.match(env,/server[- ]only|never expose|لا[^\n]+المتصفح/i);

  for(const logCall of [
    ...callsTo(route,'console.error'),
    ...callsTo(route,'console.warn'),
    ...callsTo(agent,'console.error'),
    ...callsTo(agent,'console.warn'),
    ...callsTo(serviceRpc,'console.error'),
    ...callsTo(serviceRpc,'console.warn')
  ]){
    assert.doesNotMatch(
      logCall,
      /apiKey|OPENAI_API_KEY|SUPABASE_SECRET_KEY|serviceKey|authorization|token|prompt|message|requestBody|responseText/i,
      'logs must contain controlled codes and metadata, never secrets or conversation text'
    );
  }
  for(const responseCall of callsTo(route,'NextResponse.json')){
    assert.doesNotMatch(
      responseCall,
      /OPENAI_API_KEY|apiKey|authorization|SUPABASE_SECRET_KEY/i,
      'HTTP responses must not serialize server credentials'
    );
  }
  assert.match(serviceRpc,/export async function finalizeOdeiryRun/);
  assert.doesNotMatch(serviceRpc,/export async function (?!finalizeOdeiryRun)/,
    'the service boundary must not expose a generic privileged RPC helper');
});

test('the request contract rejects arbitrary tenant identity and unclassified context',async()=>{
  const contract=await import(new URL('../lib/odeiry-contract.mjs',import.meta.url));
  const id='550e8400-e29b-41d4-a716-446655440000';
  const valid={
    slug:'reef-skills',
    message:'كيف أتابع تذكرة الدعم؟',
    clientRequestId:id,
    context:{module:'support',pathClass:'workspace.support'}
  };
  const parsed=contract.parseOdeiryRequest(valid);
  assert.equal(parsed.slug,'reef-skills');
  assert.deepEqual(parsed.context,{module:'support',pathClass:'workspace.support'});
  assert.deepEqual(
    Object.keys(parsed).sort(),
    ['clientRequestId','context','message','slug','threadId'].sort()
  );

  for(const payload of [
    {...valid,tenantId:'11111111-1111-4111-8111-111111111111'},
    {...valid,subjectId:id},
    {...valid,runId:id},
    {...valid,memberships:[{tenantSlug:'other'}]},
    {...valid,context:{...valid.context,tenantId:id}},
    {...valid,context:{module:'support',pathClass:'workspace.other'}},
    {...valid,context:{module:'support',pathClass:'workspace.support?token=secret'}},
    {...valid,context:{module:'support',pathClass:'workspace.support#private'}},
    {...valid,context:{module:'unknown',pathClass:'workspace.support'}}
  ])assert.throws(
    ()=>contract.parseOdeiryRequest(payload),
    error=>error instanceof contract.OdeiryContractError
  );

  const {route,assistant,migration}=await sources();
  assert.doesNotMatch(`${route}\n${assistant}`,/\btenantId\b|\btenant_id\b/);
  assert.doesNotMatch(assistant,
    /location\.(?:href|search|hash)|URLSearchParams|document\.(?:body|cookie)|innerHTML|outerHTML/);
  assert.match(route,/sameOrigin\(request\)/);
  assert.match(route,/sessionToken\(\)/);
  assert.match(route,/['"]v3_tenant_odeiry_snapshot['"]/);
  assert.doesNotMatch(route,/v2_current_user_context|context\?\.memberships/,
    'the route must leave membership resolution to the tenant-scoped RPC');

  const tenantSnapshot=compactSql(routine(
    migration,'public.v3_tenant_odeiry_snapshot'
  ));
  const tenantAction=compactSql(routine(
    migration,'public.v3_tenant_odeiry_action'
  ));
  for(const body of [tenantSnapshot,tenantAction]){
    assert.match(body,/p_slug text/);
    assert.doesNotMatch(body,/p_tenant_id uuid/);
    assert.match(body,/private_app\.odeiry_is_active_tenant_member\(v_tenant\.id\)/);
    assert.match(body,/v_subject_id[^;]+private_app\.current_subject_id\(\)/);
  }
  const membership=compactSql(routine(
    migration,'private_app.odeiry_is_active_tenant_member'
  ));
  assert.match(membership,/private_app\.support_is_active_tenant_member\(p_tenant_id\)/);
  assert.match(membership,/auth\.uid\(\) is not null/);
});

test('prompt, JSON, rate, turn, and output limits are explicit and fail closed',async()=>{
  const contract=await import(new URL('../lib/odeiry-contract.mjs',import.meta.url));
  const guard=await import(new URL('../lib/odeiry-request-guard.mjs',import.meta.url));
  const id='550e8400-e29b-41d4-a716-446655440000';
  const base={slug:'reef-skills',message:'ok',clientRequestId:id};
  assert.equal(contract.ODEIRY_JSON_LIMIT,16*1024);
  assert.equal(contract.ODEIRY_MESSAGE_MAX_CHARACTERS,4000);
  assert.equal(contract.ODEIRY_MESSAGE_MAX_BYTES,12*1024);
  assert.ok(contract.ODEIRY_RATE_LIMIT<=10);
  assert.equal(contract.ODEIRY_RATE_WINDOW_MS,60*1000);
  assert.ok(contract.ODEIRY_MAX_TURNS<=4);
  assert.doesNotThrow(()=>contract.parseOdeiryRequest({...base,message:'أ'.repeat(4000)}));
  assert.throws(()=>contract.parseOdeiryRequest({...base,message:'a'.repeat(4001)}));
  assert.throws(()=>contract.parseOdeiryRequest({...base,message:'🙂'.repeat(3073)}));
  assert.throws(()=>contract.parseOdeiryRequest({...base,message:'a\u0000b'}));

  await assert.rejects(
    guard.readOdeiryJson(new Request('https://odeir.test/api/odeiry/chat',{
      method:'POST',headers:{'content-type':'text/plain'},body:'{}'
    })),
    error=>error.code==='odeiry_unsupported_media_type'&&error.status===415
  );
  await assert.rejects(
    guard.readOdeiryJson(new Request('https://odeir.test/api/odeiry/chat',{
      method:'POST',headers:{
        'content-type':'application/json',
        'content-length':String(contract.ODEIRY_JSON_LIMIT+1)
      },body:'{}'
    })),
    error=>error.code==='odeiry_request_too_large'&&error.status===413
  );
  const oversized=JSON.stringify({message:'🙂'.repeat(contract.ODEIRY_JSON_LIMIT)});
  await assert.rejects(
    guard.readOdeiryJson(new Request('https://odeir.test/api/odeiry/chat',{
      method:'POST',headers:{'content-type':'application/json'},body:oversized
    })),
    error=>error.code==='odeiry_request_too_large'&&error.status===413
  );
  const limiter=new guard.OdeiryRateLimiter();
  const stamp=1_000_000;
  for(let index=0;index<contract.ODEIRY_RATE_LIMIT;index+=1){
    assert.equal(limiter.consume('subject:tenant',stamp+index).allowed,true);
  }
  const blocked=limiter.consume('subject:tenant',stamp+contract.ODEIRY_RATE_LIMIT);
  assert.equal(blocked.allowed,false);
  assert.ok(blocked.retryAfterSeconds>=1&&blocked.retryAfterSeconds<=60);
  assert.equal(limiter.consume('other-subject:same-tenant',stamp).allowed,true);
  const history=Array.from({length:12},(_,index)=>({
    role:index%2?'assistant':'user',
    content:`${index}:`+'س'.repeat(3990)
  }));
  const parsedStart=contract.parseOdeiryStartResult({
    runId:id,threadId:'7d444840-9dc0-11d1-b245-5ffdce74fad2',
    status:'reserved',reservedUnits:4,contextMessages:history
  });
  const historyBytes=parsedStart.contextMessages.reduce(
    (total,item)=>total+new TextEncoder().encode(item.content).byteLength+32,
    0
  );
  assert.ok(historyBytes<=contract.ODEIRY_HISTORY_MAX_BYTES);
  assert.match(parsedStart.contextMessages.at(-1).content,/^11:/,
    'the newest bounded history must be retained');

  const {
    route,agent,requestGuard,contract:contractSource
  }=await sources();
  assert.match(requestGuard,/content-type/i);
  assert.match(requestGuard,/ODEIRY_JSON_LIMIT/);
  assert.match(requestGuard,/TextEncoder\(\)\.encode\([^)]*\)\.byteLength/);
  assert.match(requestGuard,/415/);
  assert.match(requestGuard,/413/);
  assert.match(requestGuard,/ODEIRY_RATE_LIMIT/);
  assert.match(route,/['"]retry-after['"]/i);
  assert.match(route,/AbortSignal\.timeout|MODEL_TIMEOUT_MS/);
  assert.match(agent,/maxTurns:ODEIRY_MAX_TURNS/);
  assert.match(agent,/\.max\((?:4|6|8)\)/,
    'structured lists must have a bounded item count');
  assert.match(contractSource,/candidates\.slice\(0,6\)[\s\S]+?1200/,
    'knowledge context must be limited to six short snippets');
  assert.match(route,/cache-control['"]?:['"]no-store/i);
});

test('every Odeiry business table is tenant-scoped, indexed, and denied direct access',async()=>{
  const {migration,fkIndexesMigration}=await sources();
  const normalized=compactSql(migration);
  const tables=[
    'core.odeiry_tenant_settings','core.odeiry_threads','core.odeiry_messages',
    'core.odeiry_runs','core.odeiry_usage_events','core.odeiry_ticket_escalations'
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
    assert.match(normalized,new RegExp(
      `create (?:unique )?index(?: if not exists)? [^;]+ on ${escapeRegExp(table)}\\s*\\(\\s*tenant_id[,)]`
    ));
  }

  const messages=compactSql(tableDefinition(migration,'core.odeiry_messages'));
  const runs=compactSql(tableDefinition(migration,'core.odeiry_runs'));
  const escalations=compactSql(tableDefinition(
    migration,'core.odeiry_ticket_escalations'
  ));
  assert.match(messages,
    /foreign key \(tenant_id,run_id,thread_id\) references core\.odeiry_runs\(tenant_id,id,thread_id\)/);
  assert.match(runs,
    /foreign key \(tenant_id,thread_id,requested_by_subject_id\) references core\.odeiry_threads\(\s*tenant_id,id,created_by_subject_id\s*\)/);
  assert.match(escalations,
    /foreign key \(tenant_id,support_request_id\) references core\.support_requests\(tenant_id,id\)/);
  const fkIndexes=compactSql(fkIndexesMigration);
  assert.match(fkIndexes,
    /create index if not exists core_odeiry_runs_thread_owner_fk_idx on core\.odeiry_runs\( tenant_id,thread_id,requested_by_subject_id \)/);
  assert.match(fkIndexes,
    /create index if not exists core_odeiry_messages_run_thread_fk_idx on core\.odeiry_messages\( tenant_id,run_id,thread_id \)/);
  assert.match(fkIndexes,
    /create index if not exists core_odeiry_escalations_run_thread_fk_idx on core\.odeiry_ticket_escalations\( tenant_id,run_id,thread_id \)/);

  for(const rpc of [
    'public.v3_tenant_odeiry_snapshot','public.v3_tenant_odeiry_action',
    'public.v3_tenant_odeiry_finalize',
    'public.v3_tenant_odeiry_knowledge_search',
    'public.v3_platform_odeiry_configure'
  ]){
    const declarationPattern=new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(rpc)}\\s*\\(`,
      'i'
    );
    const declarations=migration.match(new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(rpc)}\\s*\\(`,
      'gi'
    ))||[];
    assert.equal(declarations.length,1,`${rpc} must have one authoritative definition`);
    const declarationIndex=migration.search(declarationPattern);
    for(const boundary of ['revoke all on function','grant execute on function','comment on function']){
      const boundaryIndex=migration.search(new RegExp(
        `${boundary.replace(/ /g,'\\s+')}\\s+${escapeRegExp(rpc)}\\s*\\(`,
        'i'
      ));
      assert.ok(boundaryIndex>declarationIndex,
        `${boundary} for ${rpc} must follow its authoritative definition`);
    }
    const body=compactSql(routine(migration,rpc));
    assert.match(body,/security definer set search_path\s*=\s*''/);
    assert.match(normalized,new RegExp(
      `revoke all on function ${escapeRegExp(rpc)}\\s*\\(`
    ));
  }
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_snapshot\(text\) to authenticated/);
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_action\(text\s*,\s*text\s*,\s*jsonb\) to authenticated/);
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_finalize\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*jsonb\s*\) to service_role/);
  assert.match(normalized,
    /grant execute on function public\.v3_tenant_odeiry_knowledge_search\(\s*text\s*,\s*uuid\s*,\s*text\s*,\s*integer\s*\) to authenticated/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v3_tenant_odeiry_finalize[^;]+to (?:public|anon|authenticated)/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v3_tenant_odeiry_knowledge_search[^;]+to service_role/);

  const finalize=compactSql(routine(
    migration,'public.v3_tenant_odeiry_finalize'
  ));
  const knowledgeSearch=compactSql(routine(
    migration,'public.v3_tenant_odeiry_knowledge_search'
  ));
  assert.match(knowledgeSearch,
    /private_app\.odeiry_is_active_tenant_member\(v_tenant\.id\)/);
  assert.match(finalize,/run\.tenant_id\s*=\s*v_tenant\.id/);
  assert.match(knowledgeSearch,/run\.tenant_id\s*=\s*v_tenant\.id/);
  assert.match(knowledgeSearch,/run\.requested_by_subject_id\s*=\s*v_subject_id/);
  assert.match(knowledgeSearch,/run\.id\s*=\s*p_run_id/);
  assert.match(finalize,
    /insert into core\.odeiry_usage_events[^;]+false/,
    'finalization must write only non-billable usage events');
  assert.doesNotMatch(finalize,/p_payload\s*->>\s*'billable'/);
});

test('knowledge sources are platform-curated, bounded, and restricted to Odeir references',async()=>{
  const contract=await import(new URL('../lib/odeiry-contract.mjs',import.meta.url));
  const fixture=Array.from({length:7},(_,index)=>({
    articleKey:`support.article_${index}`,
    title:`مقال ${index}`,
    moduleKey:'support',
    content:'م'.repeat(1400)
  }));
  fixture.splice(1,0,{
    articleKey:'https://evil.test/article',
    title:'مصدر غير صالح',moduleKey:'support',content:'غير موثوق'
  });
  const curated=contract.normalizeOdeiryKnowledgeArticles(fixture);
  assert.ok(curated.length<=6);
  assert.ok(curated.every(item=>/^support\.article_\d+$/.test(item.articleId)));
  assert.ok(curated.every(item=>[...item.content].length<=1200));

  const {migration,agent}=await sources();
  const normalized=compactSql(migration);
  const knowledge=compactSql(tableDefinition(
    migration,'platform.odeiry_knowledge_articles'
  ));
  assert.doesNotMatch(knowledge,/tenant_id|subject_id|email|phone/);
  assert.match(knowledge,/source_kind/);
  assert.match(knowledge,/source_reference/);
  assert.match(knowledge,/public_url/);
  assert.match(normalized,
    /odeiry_knowledge_source_kind_check[^;]+odeir_product_docs[^;]+odeir_support_policy[^;]+odeir_release_note/);
  assert.match(normalized,
    /odeiry_knowledge_source_reference_check[^;]+\(component\|route\|policy\|release\)\//);
  assert.match(normalized,
    /odeiry_knowledge_public_url_check[^;]+https:\/\/[^;]+odeir\\\.com\//);
  assert.doesNotMatch(normalized,
    /insert into platform\.odeiry_knowledge_articles[^;]+(?:reef|@|\+966|\+20)/);

  const search=compactSql(routine(
    migration,'public.v3_tenant_odeiry_knowledge_search'
  ));
  assert.match(search,
    /v_limit\s*:=\s*least\(\s*greatest\(coalesce\(p_limit,6\),1\),\s*v_runtime\.max_knowledge_results\s*\)/);
  assert.match(normalized,
    /max_knowledge_results smallint not null default 6 check \(max_knowledge_results between 1 and 12\)/);
  assert.doesNotMatch(normalized,
    /search_vector tsvector generated always as \([^;]*array_to_string\(/,
    'generated search vector must use immutable expressions only');
  assert.match(search,/article\.status\s*=\s*'published'/);
  const queryLimits=search.match(
    /if char_length\(v_query\) not between 2 and (\d+) or octet_length\(v_query\) > (\d+)/
  );
  assert.ok(queryLimits,'knowledge queries must have explicit character and byte limits');
  assert.ok(Number(queryLimits[1])<=4000,'knowledge query character limit must stay bounded');
  assert.ok(Number(queryLimits[2])<=12000,'knowledge query byte limit must stay bounded');
  assert.doesNotMatch(search,/select \* from platform\.odeiry_knowledge_articles/);
  assert.match(agent,/knowledgeSources:new Map\(\)/);
  assert.match(agent,
    /const trusted=verified\.get\(source\.articleId\)[\s\S]+?title:trusted\.title/,
    'model citations must be intersected with IDs returned by the trusted tool');
  assert.match(agent,
    /rejectedSource[\s\S]{0,120}output\.confidence===['"]high['"][\s\S]{0,80}['"]medium['"]/,
    'unverified citations must lower high confidence');
  assert.match(agent,
    /sources\.length===0[\s\S]{0,120}output\.confidence===['"]high['"][\s\S]{0,80}['"]medium['"]/,
    'an answer without a verified source must not retain high confidence');
});

test('runs and ticket creation are idempotent across retries',async()=>{
  const {migration,route,assistant,serviceRpc}=await sources();
  const normalized=compactSql(migration);
  const runs=compactSql(tableDefinition(migration,'core.odeiry_runs'));
  assert.match(runs,/client_request_id text not null/);
  assert.match(runs,/request_hash text not null/);
  assert.match(runs,/request_hash[^,]+\^\[a-f0-9\]\{64\}\$/);
  assert.match(runs,
    /constraint odeiry_runs_client_request_key unique \(tenant_id,requested_by_subject_id,client_request_id\)/);

  const tenantAction=compactSql(routine(
    migration,'public.v3_tenant_odeiry_action'
  ));
  assert.match(tenantAction,/pg_advisory_xact_lock|for update/);
  assert.match(tenantAction,/odeiry_idempotency_conflict/);
  assert.match(tenantAction,/request_hash/);
  assert.match(tenantAction,/'idempotent',true/);
  assert.match(route,/createHash\(['"]sha256['"]\)/);
  assert.match(route,/clientRequestId/);
  assert.match(route,/idempotent/);
  assert.match(route,
    /finalizeWithRetry\(input\.slug,started\.runId,['"]completed['"]/,
    'the privileged finalizer must use only the run reserved for this request');
  assert.doesNotMatch(route,/finalizeWithRetry\([^,]+,\s*input\.runId/);
  assert.match(serviceRpc,
    /\/rest\/v1\/rpc\/v3_tenant_odeiry_finalize/);

  assert.match(assistant,/ticketAttemptIds=useRef\(new Map\(\)\)/);
  assert.match(assistant,
    /ticketAttemptIds\.current\.get\(sourceMessageId\)[\s\S]+?ticketAttemptIds\.current\.set\(sourceMessageId,requestId\)/);
  assert.match(assistant,/clientRequestId:attemptId/);
  assert.match(assistant,/if\(!pendingTicket\|\|ticketBusy\)return/);
  assert.match(assistant,/retryWithNewRequestId=failure\.retryWithNewRequestId/);
  assert.match(assistant,
    /setRetryAttempt\(retryWithNewRequestId\?\{[\s\S]+?requestId:clientRequestId\(\),[\s\S]+?startsNewRun:true/,
    'a terminal run may be retried only with a fresh request id');
});

test('v1 usage is append-only shadow billing and never deducts a balance',async()=>{
  const {migration,route,agent}=await sources();
  const normalized=compactSql(migration);
  const usage=compactSql(tableDefinition(migration,'core.odeiry_usage_events'));
  assert.match(usage,/billable boolean not null default false/);
  assert.match(usage,/constraint odeiry_usage_events_shadow_only_check check \((?:not billable|billable=false)\)/);
  for(const eventType of [
    'reservation_created','usage_settled','reservation_released'
  ])assert.match(usage,new RegExp(`'${eventType}'`));
  assert.match(normalized,
    /create trigger odeiry_usage_events_append_only before update or delete on core\.odeiry_usage_events/);
  const appendOnly=compactSql(routine(
    migration,'private_app.odeiry_usage_events_append_only_guard'
  ));
  assert.match(appendOnly,/raise exception 'odeiry_usage_events_append_only'/);

  const runtime=`${migration}\n${route}\n${agent}`;
  assert.doesNotMatch(runtime,/v2_addon_usage_reserve|addon_usage_limit_reached/);
  assert.doesNotMatch(runtime,
    /update\s+catalog\.addon_usage_counters|(?:debit|deduct|charge)[a-z_]*\s*\(/i);
  assert.doesNotMatch(usage,/balance|available_credits|remaining_credits|charged_units/);
  assert.doesNotMatch(normalized,
    /billing_mode\s*=\s*'(?!shadow)'|billable\s*=\s*true/);
});

test('Odeiry only drafts tickets and the user explicitly confirms the canonical support API',async()=>{
  const {route,agent,assistant,migration}=await sources();
  assert.doesNotMatch(`${route}\n${agent}`,
    /create_ticket|v3_tenant_support_action|core\.support_requests/);
  assert.match(agent,/ticketDraft/);
  assert.match(agent,/needsEscalation/);

  const reviewIndex=assistant.indexOf('function reviewTicketDraft');
  const confirmIndex=assistant.indexOf('async function confirmTicketCreation');
  const supportFetch=assistant.indexOf("fetch('/api/support/tenant/create_ticket'");
  assert.ok(reviewIndex>=0&&confirmIndex>reviewIndex&&supportFetch>confirmIndex,
    'support POST must exist only in the explicit confirmation handler');
  assert.match(assistant,/role="alertdialog"/);
  assert.match(assistant,/لن تُرسل التذكرة إلا بعد تأكيدك/);
  assert.match(assistant,/مراجعة ثم إنشاء التذكرة/);
  assert.match(assistant,/onClick=\{confirmTicketCreation\}/);
  assert.match(assistant,/clientRequestId:attemptId/);
  const askBlock=assistant.slice(
    assistant.indexOf('async function askOdeiry'),
    reviewIndex
  );
  assert.match(askBlock,
    /const attemptSource=existingAttempt\|\|\{[\s\S]+?context:safeContext[\s\S]+?const attempt=\{\.\.\.attemptSource[\s\S]+?context:attempt\.context/);
  assert.doesNotMatch(askBlock,/\b(?:route|moduleKey|tenantId):/,
    'chat sends only the strict classified context contract');
  assert.match(assistant,
    /const diagnostics=value\.diagnostics[\s\S]+?diagnostics\.reproductionSteps[\s\S]+?diagnostics\.expectedResult[\s\S]+?diagnostics\.actualResult/,
    'nested agent diagnostics must survive into the reviewed support draft');
  assert.doesNotMatch(
    assistant.slice(assistant.indexOf('async function askOdeiry'),confirmIndex),
    /\/api\/support\/tenant\/create_ticket/,
    'asking Odeiry must never create a ticket as a side effect'
  );

  const escalations=compactSql(tableDefinition(
    migration,'core.odeiry_ticket_escalations'
  ));
  assert.match(escalations,
    /foreign key \(tenant_id,support_request_id\) references core\.support_requests\(tenant_id,id\)/);
  assert.doesNotMatch(migration,
    /insert into core\.support_requests|update core\.support_requests|delete from core\.support_requests/);
});

test('successful support tickets get best-effort idempotent Odeiry provenance',async()=>{
  const contract=await import(new URL('../lib/odeiry-contract.mjs',import.meta.url));
  const validLink={
    slug:'reef-skills',
    runId:'550e8400-e29b-41d4-a716-446655440000',
    ticketId:'7d444840-9dc0-41d1-a245-5ffdce74fad2',
    clientRequestId:'8a444840-9dc0-41d1-a245-5ffdce74fad2'
  };
  assert.deepEqual(contract.parseOdeiryTicketLinkRequest(validLink),validLink);
  for(const payload of [
    {...validLink,tenantId:validLink.runId},
    {...validLink,subjectId:validLink.runId},
    {...validLink,action:'link_ticket'},
    {...validLink,runId:'not-a-uuid'},
    {...validLink,ticketId:'not-a-uuid'},
    {...validLink,clientRequestId:'not-a-uuid'}
  ])assert.throws(
    ()=>contract.parseOdeiryTicketLinkRequest(payload),
    error=>error instanceof contract.OdeiryContractError
  );

  const {assistant,linkRoute,migration}=await sources();
  const confirmStart=assistant.indexOf('async function confirmTicketCreation');
  const confirmEnd=assistant.indexOf('\n  return <div',confirmStart);
  const confirmBlock=assistant.slice(confirmStart,confirmEnd);
  const supportCreate=confirmBlock.indexOf("fetch('/api/support/tenant/create_ticket'");
  const successCheck=confirmBlock.indexOf('if(!response.ok)');
  const outcome=confirmBlock.indexOf('setTicketOutcomes');
  const provenance=confirmBlock.indexOf('void linkTicketProvenance({');
  assert.ok(
    supportCreate>=0&&successCheck>supportCreate&&outcome>successCheck
      &&provenance>outcome,
    'provenance must run only after the canonical ticket creation succeeds'
  );
  assert.doesNotMatch(confirmBlock,/await linkTicketProvenance/,
    'provenance is best-effort and must never turn a linked ticket into a failed creation');
  assert.match(assistant,/ticketLinkAttemptIds=useRef\(new Map\(\)\)/);
  assert.match(assistant,
    /ticketLinkAttemptIds\.current\.get\(sourceMessageId\)[\s\S]+?ticketLinkAttemptIds\.current\.set\(sourceMessageId,linkClientRequestId\)/);
  assert.match(assistant,/runId:safeUuid\(source\.runId\?\?source\.run_id\)/);
  assert.match(assistant,
    /async function linkTicketProvenance[\s\S]+?fetch\('\/api\/odeiry\/link-ticket'[\s\S]+?catch\{[\s\S]+?return false/);

  assert.match(linkRoute,/import ['"]server-only['"]/);
  const linkHandler=exportedHandler(linkRoute,'POST');
  const featureGate=linkHandler.indexOf("process.env.ODEIRY_AI_ENABLED!=='true'");
  const originGate=linkHandler.indexOf('sameOrigin(request)');
  const sessionGate=linkHandler.indexOf('sessionToken()');
  assert.ok(featureGate>=0&&originGate>featureGate&&sessionGate>originGate,
    'feature, same-origin, and authenticated-session gates must precede linking');
  assert.match(linkRoute,/sameOrigin\(request\)/);
  assert.match(linkRoute,/sessionToken\(\)/);
  assert.match(linkRoute,/parseOdeiryTicketLinkRequest/);
  assert.doesNotMatch(linkRoute,/\btenantId\b|\bsubjectId\b|\bp_tenant_id\b/);
  const linkCalls=callsTo(linkHandler,'supportRpc');
  assert.equal(linkCalls.length,1,'the provenance route may invoke one tenant RPC only');
  assert.match(linkCalls[0],/['"]v3_tenant_odeiry_action['"]/);
  assert.match(linkCalls[0],/p_action:['"]link_ticket['"]/);
  assert.match(linkCalls[0],/runId:input\.runId/);
  assert.doesNotMatch(linkRoute,
    /create_ticket|v3_tenant_support_action|insert into core\.support_requests/i);
  assert.match(linkRoute,/['"]cache-control['"]:['"]no-store['"]/);

  const tenantAction=compactSql(routine(
    migration,'public.v3_tenant_odeiry_action'
  ));
  const escalations=compactSql(tableDefinition(
    migration,'core.odeiry_ticket_escalations'
  ));
  assert.match(tenantAction,/if v_action = 'link_ticket' then/);
  assert.match(tenantAction,/odeir:odeiry:ticket-link/);
  assert.match(tenantAction,
    /if v_action = 'link_ticket' then[\s\S]+?run\.tenant_id = v_tenant\.id[\s\S]+?run\.id = v_run_id[\s\S]+?run\.requested_by_subject_id = v_subject_id/,
    'the database must verify that the current subject owns the supplied run');
  assert.match(tenantAction,
    /private_app\.odeiry_is_active_tenant_member\(v_tenant\.id\)/);
  assert.match(tenantAction,/support_tenant_can_read_ticket/);
  assert.match(tenantAction,/odeiry_ticket_link_conflict/);
  assert.match(escalations,
    /constraint odeiry_ticket_escalations_client_request_key unique \(tenant_id,linked_by_subject_id,client_request_id\)/);
});

test('manual support remains independent when AI is disabled or has no units',async()=>{
  const {assistant,shell,supportRoute,migration}=await sources();
  const tenantItems=shell.slice(
    shell.indexOf('function tenantItems('),
    shell.indexOf('function platformItems(')
  );
  assert.match(tenantItems,
    /\{key:'support',label:'الدعم الفني',href:`\$\{base\}\/support`,always:true,[\s\S]+\}\s*\];/);
  assert.doesNotMatch(tenantItems,
    /ODEIRY|OPENAI|credit|balance|unit|odeiry_tenant_settings/i);
  assert.doesNotMatch(supportRoute,
    /ODEIRY|OPENAI|credit|balance|v2_addon_usage_reserve|odeiry_usage/i);
  assert.match(supportRoute,/v3_tenant_support_action/);
  assert.match(supportRoute,/create_ticket/);
  assert.match(assistant,/يمكنك استخدام الدعم الفني كالمعتاد/);
  assert.match(assistant,/\/tenant\/\$\{encodeURIComponent\(slug\)\}\/support/);

  const normalized=compactSql(migration);
  assert.doesNotMatch(normalized,
    /create or replace function public\.v3_(?:tenant|platform)_support_(?:snapshot|action)/);
  assert.doesNotMatch(normalized,/alter table core\.support_requests/);
  assert.doesNotMatch(normalized,
    /(?:update|delete from|truncate) core\.(?:support_requests|support_messages|support_events)/);
});
