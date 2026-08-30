import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {OdeiryContractError} from '../lib/odeiry-contract.mjs';
import {
  parseOdeiryManagerCapability,
  parseOdeiryManagerMemoryActionResult,
  parseOdeiryManagerRequest,
  parseOdeiryManagerThreadResult,
  parseOdeiryManagerWorkspaceResult
} from '../lib/odeiry-manager-contract.mjs';

const root=new URL('../',import.meta.url);
const ids={
  thread:'550e8400-e29b-41d4-a716-446655440000',
  memory:'7d444840-9dc0-41d1-a245-5ffdce74fad2',
  request:'8a444840-9dc0-41d1-a245-5ffdce74fad2',
  message:'9b444840-9dc0-41d1-a245-5ffdce74fad2'
};

test('manager request contract accepts only three closed action shapes',()=>{
  assert.deepEqual(parseOdeiryManagerRequest({
    action:'workspace',slug:'Masar-Training'
  }),{action:'workspace',slug:'masar-training'});
  assert.deepEqual(parseOdeiryManagerRequest({
    action:'thread',slug:'masar-training',threadId:ids.thread
  }),{
    action:'thread',slug:'masar-training',threadId:ids.thread
  });
  assert.deepEqual(parseOdeiryManagerRequest({
    action:'review_memory',slug:'masar-training',memoryId:ids.memory,
    decision:'approve',expectedVersion:2,clientRequestId:ids.request
  }),{
    action:'review_memory',slug:'masar-training',memoryId:ids.memory,
    decision:'approve',expectedVersion:2,clientRequestId:ids.request
  });

  for(const payload of [
    {action:'execute',slug:'masar-training'},
    {action:'workspace',slug:'masar-training',tenantId:ids.thread},
    {action:'thread',slug:'masar-training',threadId:'not-a-uuid'},
    {
      action:'review_memory',slug:'masar-training',memoryId:ids.memory,
      decision:'edit',expectedVersion:1,clientRequestId:ids.request
    },
    {
      action:'review_memory',slug:'masar-training',memoryId:ids.memory,
      decision:'approve',expectedVersion:0,clientRequestId:ids.request
    },
    {
      action:'review_memory',slug:'masar-training',memoryId:ids.memory,
      decision:'approve',expectedVersion:'1',clientRequestId:ids.request
    },
    {
      action:'review_memory',slug:'masar-training',memoryId:ids.memory,
      decision:'approve',expectedVersion:1,clientRequestId:ids.request,
      statement:'replace approved memory without review'
    }
  ])assert.throws(
    ()=>parseOdeiryManagerRequest(payload),
    error=>error instanceof OdeiryContractError
  );
});

test('manager capability is backward-compatible and fails closed',()=>{
  assert.deepEqual(parseOdeiryManagerCapability(null),{
    mode:null,allowed:false,globalEnabled:false,enabled:false,
    reviewAvailable:false,available:false
  });
  assert.deepEqual(parseOdeiryManagerCapability({
    available:true,enabled:true,mode:'tenant_member'
  }),{
    mode:'tenant_member',allowed:false,globalEnabled:false,
    enabled:false,reviewAvailable:false,available:false
  });
  assert.deepEqual(parseOdeiryManagerCapability({
    available:true,enabled:true,mode:'platform_operator',
    manager:{allowed:true,globalEnabled:true,enabled:true,available:true}
  }),{
    mode:'platform_operator',allowed:false,globalEnabled:true,
    enabled:true,reviewAvailable:false,available:false
  });
  assert.deepEqual(parseOdeiryManagerCapability({
    available:true,enabled:true,mode:'tenant_member',
    manager:{allowed:true,enabled:true,available:true}
  }),{
    mode:'tenant_member',allowed:true,globalEnabled:false,
    enabled:true,reviewAvailable:false,available:false
  });
  assert.deepEqual(parseOdeiryManagerCapability({
    available:true,enabled:true,mode:'tenant_member',
    manager:{allowed:true,globalEnabled:true,enabled:true,available:true}
  }),{
    mode:'tenant_member',allowed:true,globalEnabled:true,
    enabled:true,reviewAvailable:false,available:true
  });
  assert.deepEqual(parseOdeiryManagerCapability({
    available:true,enabled:true,mode:'tenant_member',
    manager:{
      allowed:true,globalEnabled:false,enabled:false,
      reviewAvailable:true,available:false
    }
  }),{
    mode:'tenant_member',allowed:true,globalEnabled:false,
    enabled:false,reviewAvailable:true,available:false
  });
});

test('manager result parsers bound and allowlist personal workspace data',()=>{
  const workspace=parseOdeiryManagerWorkspaceResult({
    schemaVersion:1,
    generatedAt:'2026-08-30T12:00:00+00:00',
    tenantId:'must-not-leak',
    threads:[{
      threadId:ids.thread,title:'خطة الربع القادم',status:'active',version:1,
      lastMessageAt:'2026-08-30T11:59:00Z',createdAt:'2026-08-30T11:00:00Z',
      subjectId:'must-not-leak'
    }],
    memory:{
      pending:[{
        memoryId:ids.memory,memoryKey:'goal.quarterly_growth',category:'goal',
        statement:'أعطِ الأولوية لنمو التسجيل المستدام.',reason:'صرّح المدير بذلك.',
        version:1,createdAt:'2026-08-30T11:30:00Z',expiresAt:null,
        rawPrompt:'must-not-leak'
      }],
      approved:[],archived:[]
    }
  });
  assert.equal(workspace.pendingCount,1);
  assert.equal(workspace.memories.pending[0].status,'proposed');
  assert.equal(workspace.generatedAt,'2026-08-30T12:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(workspace),/tenantId|subjectId|rawPrompt/);

  const thread=parseOdeiryManagerThreadResult({
    schemaVersion:1,
    thread:{
      threadId:ids.thread,title:'خطة الربع القادم',status:'active',version:1,
      lastMessageAt:'2026-08-30T12:00:00Z',createdAt:'2026-08-30T11:00:00Z'
    },
    messages:[{
      messageId:ids.message,role:'user',content:'حلّل الأداء الإجمالي فقط.',
      createdAt:'2026-08-30T12:00:00Z',tenantId:'must-not-leak'
    }]
  });
  assert.equal(thread.messages.length,1);
  assert.doesNotMatch(JSON.stringify(thread),/tenantId/);

  assert.deepEqual(parseOdeiryManagerMemoryActionResult({
    action:'approve',memoryId:ids.memory,status:'approved',version:2,
    idempotent:false,content:'must-not-leak'
  },{action:'approve',memoryId:ids.memory}),{
    action:'approve',memoryId:ids.memory,status:'approved',version:2,
    idempotent:false
  });
  assert.throws(()=>parseOdeiryManagerMemoryActionResult({
    action:'reject',memoryId:ids.memory,status:'rejected',version:2,
    idempotent:false
  },{action:'approve',memoryId:ids.memory}),OdeiryContractError);
});

test('workspace memory bounds match the database configuration ceilings',()=>{
  const memory={
    memoryId:ids.memory,memoryKey:'goal.quarterly_growth',category:'goal',
    statement:'أعطِ الأولوية لنمو التسجيل المستدام.',reason:null,
    version:1,createdAt:'2026-08-30T11:30:00Z',reviewedAt:null,
    expiresAt:null
  };
  const workspace=counts=>({
    schemaVersion:1,generatedAt:'2026-08-30T12:00:00Z',threads:[],
    memory:{
      pending:Array.from({length:counts.pending},()=>memory),
      approved:Array.from({length:counts.approved},()=>memory),
      archived:Array.from({length:counts.archived},()=>memory)
    }
  });
  const accepted=parseOdeiryManagerWorkspaceResult(workspace({
    pending:50,approved:100,archived:20
  }));
  assert.equal(accepted.memories.pending.length,50);
  assert.equal(accepted.memories.approved.length,100);
  assert.equal(accepted.memories.archived.length,20);
  for(const counts of [
    {pending:51,approved:0,archived:0},
    {pending:0,approved:101,archived:0},
    {pending:0,approved:0,archived:21}
  ])assert.throws(
    ()=>parseOdeiryManagerWorkspaceResult(workspace(counts)),
    error=>error instanceof OdeiryContractError
      &&error.code==='odeiry_manager_response_invalid'
  );
});

test('manager API gates before RPCs and exposes no execution or broad database channel',async()=>{
  const [route,api]=await Promise.all([
    readFile(new URL('app/api/odeiry/manager/route.js',root),'utf8'),
    readFile(new URL('lib/odeiry-api.js',root),'utf8')
  ]);
  assert.match(route,/import ['"]server-only['"]/);
  const handler=route.slice(route.indexOf('export async function POST'));
  const baseFlag=handler.indexOf("process.env.ODEIRY_AI_ENABLED!=='true'");
  const managerFlag=handler.indexOf(
    "process.env.ODEIRY_MANAGER_ENABLED==='true'"
  );
  const originGate=handler.indexOf('sameOrigin(request)');
  const sessionGate=handler.indexOf('sessionToken()');
  const snapshotGate=handler.indexOf("'v3_tenant_odeiry_snapshot'");
  const actionCall=handler.indexOf(
    'managerAction(token,input,{lifecycleOnly:!fullAccess})'
  );
  assert.ok(baseFlag>=0&&managerFlag>baseFlag&&originGate>managerFlag
    &&sessionGate>originGate);
  assert.ok(snapshotGate>sessionGate&&actionCall>snapshotGate);
  assert.match(handler,
    /capability\.mode===['"]platform_operator['"]\|\|!capability\.allowed/);
  assert.match(handler,
    /const lifecycleAction=capability\.reviewAvailable&&\([\s\S]+?input\.action===['"]workspace['"][\s\S]+?\['reject','archive'\]\.includes\(input\.decision\)/);
  assert.match(handler,
    /const fullAccess=managerRuntimeEnabled&&capability\.available/);
  assert.match(handler,/if\(!fullAccess&&!lifecycleAction\)/);
  assert.match(handler,
    /managerAction\(token,input,\{lifecycleOnly:!fullAccess\}\)/);
  assert.doesNotMatch(handler,
    /lifecycleAction[\s\S]{0,200}(?:approve|thread)/,
    'review-only lifecycle access must never approve memory or open threads');
  assert.match(route,
    /return lifecycleOnly\?\{\.\.\.workspace,threads:\[\]\}:workspace/,
    'application-only rollback must not expose conversation metadata');
  for(const rpc of [
    'v1_tenant_odeiry_manager_workspace',
    'v1_tenant_odeiry_manager_thread',
    'v1_tenant_odeiry_manager_memory_action'
  ])assert.match(route,new RegExp(`['"]${rpc}['"]`));
  assert.doesNotMatch(route,
    /SUPABASE_(?:SECRET|SERVICE)|service[_-]?role|tenantId|subjectId|p_tenant_id/i);
  assert.doesNotMatch(route,
    /create_ticket|link_ticket|insert\s+into|update\s+|delete\s+from|\bexecute_task\b/i);
  assert.match(route,/['"]cache-control['"]:['"]no-store['"]/);
  assert.match(route,/console\.error\([^)]*errorName/s);
  assert.doesNotMatch(route,/console\.(?:error|warn)\([^)]*(?:input|request|body|content)/s);

  assert.match(api,/parseOdeiryManagerCapability/);
  assert.match(api,/manager:\{[\s\S]+?allowed:manager\.allowed[\s\S]+?globalEnabled:manager\.globalEnabled[\s\S]+?reviewAvailable:manager\.reviewAvailable[\s\S]+?available:manager\.available/);
  assert.doesNotMatch(api,/tenantId|tenant_id|subjectId|subject_id/);
});
