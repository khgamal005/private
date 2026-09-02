import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import test from 'node:test';

const ROOT=new URL('../',import.meta.url);
const RPC_NAME='public.v1_tenant_odeiry_manager_team_performance';

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
  const start=sql.search(new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(name)}\\s*\\(`,
    'i'
  ));
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

async function findTeamMigration(){
  const directory=new URL('supabase/migrations/',ROOT);
  const files=(await readdir(directory))
    .filter(name=>name.endsWith('.sql'))
    .sort();
  for(const file of files){
    const sql=await readFile(new URL(file,directory),'utf8');
    if(new RegExp(
      `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(RPC_NAME)}\\s*\\(`,
      'i'
    ).test(sql))return {file,sql};
  }
  assert.fail(`${RPC_NAME} migration must exist`);
}

test('team-performance RPC derives tenant from the authenticated manager run',async()=>{
  const {sql}=await findTeamMigration();
  const team=routine(sql,RPC_NAME);
  const normalized=compactSql(team);
  const signature=compactSql(team.slice(0,team.search(/\breturns\b/i)));

  assert.match(signature,
    /\(\s*p_run_id uuid\s*,\s*p_period text\s*,\s*p_dimension text\s*\)/);
  assert.doesNotMatch(signature,/p_(?:slug|tenant|subject|staff|query|sql|filter)/,
    'the model-facing RPC must not accept a tenant selector or free-form query');
  assert.match(normalized,/security definer set search_path\s*=\s*''/);
  assert.match(normalized,/private_app\.current_subject_id\(\)/);
  assert.match(normalized,/update core\.odeiry_runs run/);
  assert.match(normalized,/run\.id=p_run_id/);
  assert.match(normalized,/run\.requested_by_subject_id=v_subject_id/);
  assert.match(normalized,
    /run\.request_context->>'assistantmode'='manager_v1'/);
  assert.match(normalized,/run\.manager_analytics_count<2/);
  assert.match(normalized,
    /manager_analytics_count=run\.manager_analytics_count\+1/);
  assert.match(normalized,/returning run\.tenant_id/,
    'the tenant must come from the atomic, owner-bound run update');
  assert.match(normalized,/core\.odeiry_manager_threads marker/);
  assert.match(normalized,/marker\.tenant_id=run\.tenant_id/);
  assert.match(normalized,/marker\.owner_subject_id=v_subject_id/);
  assert.doesNotMatch(normalized,/service_role|supabase_(?:secret|service)/i);
});

test('team-performance authorization uses exact tenant domain permissions',async()=>{
  const {sql}=await findTeamMigration();
  const normalized=compactSql(sql);
  const helperName='private_app.odeiry_manager_has_tenant_permission';
  const permission=compactSql(routine(sql,helperName));
  const team=compactSql(routine(sql,RPC_NAME));

  assert.match(permission,/auth\.uid\(\) is not null/);
  assert.match(permission,/access_control\.memberships/);
  assert.match(permission,/access_control\.membership_roles/);
  assert.match(permission,/access_control\.roles/);
  assert.match(permission,/access_control\.role_permissions/);
  assert.match(permission,/membership\.tenant_id=p_tenant_id/);
  assert.match(permission,/membership\.subject_id=v_subject_id/);
  assert.match(permission,/role\.scope='tenant'/);
  assert.match(permission,/role_permission\.permission_key=p_permission_key/);
  assert.doesNotMatch(permission,
    /private_app\.has_tenant_permission|platform\.control|scope='platform'/,
    'platform privileges must never satisfy a tenant data permission');

  for(const key of ['tenant.people.read','tenant.reports.analytics']){
    assert.match(team,new RegExp(
      `odeiry_manager_has_tenant_permission\\( (?:run\\.tenant_id|v_tenant_id),'${escapeRegExp(key)}' \\)`
    ));
  }
  assert.match(team,
    /private_app\.odeiry_manager_is_available\((?:run\.tenant_id|v_tenant_id)\)/);
  assert.match(normalized,
    /revoke all on function public\.v1_tenant_odeiry_manager_team_performance\(uuid,text,text\) from public,anon,authenticated,service_role/);
  assert.match(normalized,
    /grant execute on function public\.v1_tenant_odeiry_manager_team_performance\(uuid,text,text\) to authenticated/);
  assert.doesNotMatch(normalized,
    /grant execute on function public\.v1_tenant_odeiry_manager_team_performance\(uuid,text,text\) to (?:public|anon|service_role)/);
});

test('missing either people or reports permission fails before any report read',async()=>{
  const {sql}=await findTeamMigration();
  const team=compactSql(routine(sql,RPC_NAME));
  const atomicUpdate=team.slice(
    team.indexOf('update core.odeiry_runs run'),
    team.indexOf('returning run.tenant_id')
  );
  const people=atomicUpdate.indexOf(
    "odeiry_manager_has_tenant_permission( run.tenant_id,'tenant.people.read' )"
  );
  const reports=atomicUpdate.indexOf(
    "odeiry_manager_has_tenant_permission( run.tenant_id,'tenant.reports.analytics' )"
  );
  const reportRead=team.indexOf('public.v5_tenant_reports_snapshot(');

  assert.ok(people>=0&&reports>=0,
    'both exact domain permissions must be conjunctive predicates of the atomic run reservation');
  assert.ok(reportRead>team.indexOf('returning run.tenant_id'),
    'report data must not be read before the permission-bound reservation succeeds');
  assert.match(team,
    /if not private_app\.odeiry_manager_is_available\(v_tenant_id\) or not private_app\.odeiry_manager_has_tenant_permission\(v_tenant_id,'tenant\.people\.read'\) or not private_app\.odeiry_manager_has_tenant_permission\(v_tenant_id,'tenant\.reports\.analytics'\) then raise exception 'odeiry_manager_insight_unavailable'/,
    'a post-reservation check must fail closed if either grant changes');
  assert.match(team,/raise exception 'odeiry_manager_insight_unavailable'/);
});

test('team-performance output is bounded, evidence-based, and contains no IDs or contact data',async()=>{
  const {sql}=await findTeamMigration();
  const team=routine(sql,RPC_NAME);
  const normalized=compactSql(team);
  const resultStart=normalized.lastIndexOf('v_result:=jsonb_build_object');
  assert.ok(resultStart>=0,'the final response must use an explicit allowlist');
  const result=normalized.slice(resultStart);

  assert.match(normalized,
    /v_period not in \('last_7_days','last_30_days'\)/);
  for(const dimension of [
    'overview','sales','follow_up','tasks','calls'
  ])assert.match(normalized,new RegExp(`'${dimension}'`));
  for(const key of [
    'leaders','displayname','metricvalue','metricunit','numerator','denominator',
    'samplesize','samplestatus','employeesconsidered','employeeseligible'
  ])assert.match(result,new RegExp(`'${key}'`));
  for(const forbidden of [
    'tenantid','tenant_id','staffid','staff_id','subjectid','subject_id','uuid',
    'email','phone','mobile','customername','customer_name','tasktitle','notes','url'
  ])assert.doesNotMatch(result,new RegExp(`'${forbidden}'`),
    `the returned JSON must not expose ${forbidden}`);
  assert.doesNotMatch(result,/overallscore|compositescore|bestoverall/,
    'overview must expose category leaders rather than an invented total score');
  assert.match(normalized,/octet_length\(v_result::text\)>32768/);
  assert.match(normalized,
    /(?:limit 5|category_rank<=case[^;]+else 5 end|row_number\(\)[^;]+5)/,
    'a metric-specific response must contain at most five employees');
});

test('sample-strength rules prevent tiny samples from becoming decisive winners',async()=>{
  const {sql}=await findTeamMigration();
  const normalized=compactSql(routine(sql,RPC_NAME));

  for(const status of ['insufficient','initial','strong']){
    assert.match(normalized,new RegExp(`'${status}'`));
  }
  assert.match(normalized,
    /when metric\.paid_contacts>=10 then 'strong' when metric\.paid_contacts>=5 then 'initial' else 'insufficient'/,
    'verified-sales ranking must classify the 5/10 sample thresholds');
  assert.match(normalized,
    /when metric\.assigned_customers>=50 then 'strong' when metric\.assigned_customers>=20 then 'initial' else 'insufficient'/,
    'follow-up ranking must classify the 20/50 assignment thresholds');
  assert.match(normalized,
    /when metric\.tasks_total>=30 then 'strong' when metric\.tasks_total>=10 then 'initial' else 'insufficient'/,
    'task ranking must classify the 10/30 due-task thresholds');
  assert.match(normalized,
    /when metric\.calls>=50 then 'strong' when metric\.calls>=20 then 'initial' else 'insufficient'/,
    'call ranking must classify the 20/50 call thresholds');
  assert.match(normalized,/'numerator'/);
  assert.match(normalized,/'denominator'/);
  assert.match(normalized,/'samplesize'/);
  assert.match(normalized,/'samplestatus'/);
});

test('agent tool is closed, sanitized, and shares the manager read budget',async()=>{
  const [agent,route]=await Promise.all([
    readFile(new URL('lib/odeiry-agent.js',ROOT),'utf8'),
    readFile(new URL('app/api/odeiry/chat/route.js',ROOT),'utf8')
  ]);

  assert.match(agent,/const ManagerTeamPerformanceParameters=z\.object\(\{[\s\S]+?period:z\.enum\(\['last_7_days','last_30_days'\]\)[\s\S]+?dimension:z\.enum\(\[[\s\S]+?'overview'[\s\S]+?'sales'[\s\S]+?'follow_up'[\s\S]+?'tasks'[\s\S]+?'calls'/);
  assert.match(agent,/name:'read_odeir_manager_team_performance'/);
  assert.match(agent,
    /readManagerTeamPerformance=tool\([\s\S]+?assistantMode===['"]manager_v1['"][\s\S]+?platformAccess!==true/);
  assert.match(agent,/state\.analyticsCalls>=MAX_MANAGER_ANALYTICS_CALLS/);
  assert.match(agent,/state\.analyticsCalls\+=1/);
  assert.match(agent,/consumeManagerRead\(state\)/);
  assert.match(agent,/Array\.isArray\(source\.leaders\)\?source\.leaders\.slice\(0,5\)/);
  const leaderStart=agent.indexOf('const leader={',
    agent.indexOf('function normalizeManagerTeamPerformance'));
  const leaderEnd=agent.indexOf('\n    };',leaderStart);
  const leader=agent.slice(leaderStart,leaderEnd);
  for(const field of [
    'category','displayName','metricValue','metricUnit','numerator',
    'denominator','sampleSize','sampleStatus','supporting'
  ])assert.match(leader,new RegExp(`\\b${field}(?:,|:)`));
  assert.doesNotMatch(agent,/const leader=\{\s*\.\.\.item/,
    'untrusted tool rows must be reconstructed from an allowlist');
  assert.match(agent,/safeTeamDisplayName\(item\.displayName\)/);
  assert.match(agent,
    /\['tenant\.people\.read','tenant\.reports\.analytics'\]\.every\([\s\S]+?viewerPermissions\.includes\(permission\)/,
    'the application must refuse the team tool unless both domain grants are present');
  assert.match(agent,/reason:'team_permissions_required'/);
  assert.match(agent,/byteLength<=8\*1024/);
  assert.match(agent,
    /إذا سأل المستخدم عن «أفضل موظف» دون معيار[\s\S]+?المتصدرين حسب كل معيار[\s\S]+?بدل اختراع فائز عام أو درجة مركبة/);
  assert.match(agent,
    /sampleStatus=insufficient أو initial/);

  const rpcAt=route.indexOf("'v1_tenant_odeiry_manager_team_performance'");
  assert.ok(rpcAt>=0,'the authenticated chat route must wire the team tool');
  const rpcCall=route.slice(rpcAt,rpcAt+460);
  assert.match(rpcCall,/p_run_id:started\.runId/);
  assert.match(rpcCall,/p_period:period/);
  assert.match(rpcCall,/p_dimension:dimension/);
  assert.doesNotMatch(rpcCall,/p_slug|tenantId|subjectId|staffId|query|sql|filter/i,
    'the route must not forward a tenant selector or free-form database input');
});

test('team facts and their source are rendered deterministically by the server',async()=>{
  const agent=await readFile(new URL('lib/odeiry-agent.js',ROOT),'utf8');
  const normalizerStart=agent.indexOf('function normalizeManagerTeamPerformance');
  const normalizerEnd=agent.indexOf('\nfunction teamSampleStatus',normalizerStart);
  const normalizer=agent.slice(normalizerStart,normalizerEnd);
  const rendererStart=agent.indexOf('function renderManagerTeamPerformance');
  assert.ok(rendererStart>=0,
    'a server-owned renderer must own the final team facts');
  const rendererEnd=agent.indexOf('\nfunction ',rendererStart+10);
  const renderer=agent.slice(
    rendererStart,rendererEnd>rendererStart?rendererEnd:agent.length
  );
  const secureStart=agent.indexOf('function secureOdeiryOutput');
  const secureEnd=agent.indexOf('\nconst MEMORY_CATEGORIES',secureStart);
  const secure=agent.slice(secureStart,secureEnd);

  assert.match(agent,/managerTeamPerformance:null/);
  assert.match(agent,/state\.managerTeamPerformance=result/);
  assert.match(agent,
    /secureOdeiryOutput\([\s\S]+?result\.runContext\.context\?\.managerTeamPerformance/);
  assert.match(agent,
    /secureOdeiryOutput[\s\S]+?renderManagerTeamPerformance\(/);
  for(const field of ['reply','steps','suggestions','confidence']){
    assert.match(renderer,new RegExp(`${field}:`),
      `the trusted renderer must own ${field}`);
  }
  assert.match(secure,/manager\.team_performance\.live/,
    'the trusted source must appear even when the model omitted it');
  assert.match(secure,/أداء الفريق من بيانات المنشأة الحية/);
  assert.match(secure,
    /reply:rendered\.reply,[\s\S]+?steps:rendered\.steps,[\s\S]+?suggestions:rendered\.suggestions,[\s\S]+?confidence:rendered\.confidence,[\s\S]+?sources:teamSources/,
    'server-owned facts and source must replace the model-authored presentation');

  assert.doesNotMatch(normalizer,/item\.metricValue|item\.sampleStatus/,
    'reported rates and sample strength must not be trusted from the payload');
  assert.match(normalizer,
    /category===['"]sales['"][\s\S]+?metricValue=numerator/,
    'sales count must be derived from the verified numerator');
  assert.match(normalizer,
    /metricValue=Math\.round\(\(numerator\/denominator\)\*1000\)\/10/,
    'rate dimensions must be recomputed from numerator and denominator');
  assert.match(normalizer,
    /teamSampleStatus\(category,sampleSize\)/,
    'sample strength must be recomputed from category thresholds');
  assert.match(agent,
    /TEAM_SAMPLE_THRESHOLDS=Object\.freeze\(\{[\s\S]+?sales:Object\.freeze\(\{initial:5,strong:10\}\)[\s\S]+?follow_up:Object\.freeze\(\{initial:20,strong:50\}\)[\s\S]+?tasks:Object\.freeze\(\{initial:10,strong:30\}\)[\s\S]+?calls:Object\.freeze\(\{initial:20,strong:50\}\)/,
    'application thresholds must exactly mirror the database contract');
});

test('manager evaluations cover category leaders, sample size, domain denial, and PII stripping',async()=>{
  const source=await readFile(
    new URL('evals/odeiry-manager-v1.jsonl',ROOT),'utf8'
  );
  const cases=source.trim().split('\n').map(line=>JSON.parse(line));
  const byId=new Map(cases.map(item=>[item.id,item]));

  assert.equal(byId.get('employee_ranking')?.expected?.mustReturnCategoryLeaders,true);
  assert.equal(byId.get('employee_ranking')?.expected?.mustNotDeclareCompositeWinner,true);
  assert.equal(byId.get('employee_sales_ranking')?.expected?.teamPerformanceDimension,'sales');
  assert.equal(byId.get('employee_sales_ranking')?.expected?.mustRenderFactsDeterministically,true);
  assert.equal(byId.get('employee_small_sample')?.expected?.mustMentionInsufficientSample,true);
  assert.equal(byId.get('employee_small_sample')?.expected?.mustIgnorePayloadMetricAndSampleStatus,true);
  assert.equal(byId.get('employee_domain_permission_denied')?.expected?.mustNotFallbackToPlatformPrivilege,true);
  assert.equal(byId.get('employee_tool_payload_pii')?.expected?.mustStripUuidAndPii,true);
  assert.equal(byId.get('employee_tool_payload_pii')?.expected?.recomputedMetricValue,90);
  assert.equal(byId.get('cross_tenant_analytics')?.expected?.mustNotCallOtherTenant,true);
});
