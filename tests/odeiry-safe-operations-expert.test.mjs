import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

import {buildOdeiryOperationalGuide} from '../lib/odeiry-operational-guide.js';
import {
  publicOdeiryViewerContext,
  resolveOdeiryViewerContext
} from '../lib/odeiry-viewer-context.mjs';

const root=new URL('../',import.meta.url);

test('viewer context selects one exact tenant membership and strips identity',()=>{
  const currentUserContext={
    subject:{id:'subject-secret',fullName:'اسم سري',email:'secret@example.test'},
    memberships:[
      {
        tenantSlug:'masar-training',tenantId:'tenant-masar',tenantName:'مسار',
        roles:['sales_user'],
        permissions:['tenant.work.read','tenant.leads.import','platform.control.read']
      },
      {
        tenantSlug:'reef-skills',tenantId:'tenant-reef',tenantName:'ريف',
        roles:['tenant_owner'],
        permissions:['tenant.users.manage','tenant.leads.distribute']
      }
    ]
  };
  const viewer=resolveOdeiryViewerContext({
    currentUserContext,tenantSlug:'masar-training',accessMode:'tenant_member'
  });
  assert.deepEqual({...viewer,permissions:[...viewer.permissions]}, {
    roleKey:'sales_user',
    permissions:['tenant.work.read','tenant.leads.import'],
    accessMode:'tenant_member',
    platformAccess:false
  });
  assert.equal(viewer.permissions.includes('tenant.users.manage'),false);
  assert.equal(viewer.permissions.includes('tenant.leads.distribute'),false);
  assert.deepEqual(publicOdeiryViewerContext(viewer),{
    roleKey:'sales_user',accessMode:'tenant_member',platformAccess:false
  });
  assert.doesNotMatch(
    JSON.stringify({viewer:publicOdeiryViewerContext(viewer)}),
    /masar|reef|secret|email|subject|tenantId|tenantName/i
  );
  assert.equal(resolveOdeiryViewerContext({
    currentUserContext,tenantSlug:'not-a-membership',accessMode:'tenant_member'
  }),null);
});

test('platform operator context is fixed, observe-only, and membership-free',()=>{
  const viewer=resolveOdeiryViewerContext({
    currentUserContext:{
      memberships:[{tenantSlug:'reef-skills',permissions:['tenant.users.manage']}]
    },
    tenantSlug:'masar-training',
    accessMode:'platform_operator'
  });
  assert.deepEqual({...viewer,permissions:[...viewer.permissions]}, {
    roleKey:'platform_owner',permissions:[],accessMode:'platform_operator',
    platformAccess:true
  });
  const guide=buildOdeiryOperationalGuide({
    topic:'lead_intake',viewer,uiContext:{module:'sales_crm'}
  });
  assert.equal(guide.viewer.executionPolicy,'observe_and_explain_only');
  assert.ok(guide.workflows.length>=3);
  assert.ok(guide.workflows.every(item=>item.viewerAccess==='observe_only'));
  assert.deepEqual(guide.safety,{
    containsLiveTenantData:false,
    canReadCustomerOrEmployeeRecords:false,
    canModifyData:false,
    canCreateTickets:false
  });
});

test('lead intake guide answers the reported Excel and CSV gap from code facts',async()=>{
  const guide=buildOdeiryOperationalGuide({
    topic:'lead_intake',
    viewer:{
      roleKey:'data_officer',permissions:['tenant.leads.import'],
      accessMode:'tenant_member',platformAccess:false
    },
    uiContext:{module:'sales_crm'}
  });
  const rendered=JSON.stringify(guide);
  for(const fact of [
    '.xlsx','.xls','.csv','marktone-lead-intake-template.xlsx','5000',
    'فحص وإضافة إلى Queue','توزيع عادل','فريق الأونلاين','موظفون محددون'
  ])assert.match(rendered,new RegExp(escapeRegExp(fact)));
  const importWorkflow=guide.workflows.find(item=>item.id==='import_batch');
  const distributeWorkflow=guide.workflows.find(item=>item.id==='distribute_leads');
  assert.equal(importWorkflow.viewerAccess,'confirmed');
  assert.equal(distributeWorkflow.viewerAccess,'not_confirmed');
  assert.ok(guide.sources.every(source=>
    /^[a-z][a-z0-9_.-]{2,119}$/.test(source.sourceId)
  ));

  const component=await readFile(
    new URL('components/lead-intake-workspace.js',root),'utf8'
  );
  assert.match(component,/accept="\.xlsx,\.xls,\.csv"/);
  assert.match(component,/records\.length>5000/);
  assert.match(component,/marktone-lead-intake-template\.xlsx/);
  assert.match(component,/فحص وإضافة إلى Queue/);
  assert.match(component,
    /fair:'توزيع عادل[\s\S]+?online_only:'مسؤولو المبيعات الأونلاين فقط'[\s\S]+?selected:'موظفون محددون'/);
});

test('agent remains one bounded workflow while operations keeps its reviewed read-only tools',async()=>{
  const [agent,route,operations,serviceRpc]=await Promise.all([
    readFile(new URL('lib/odeiry-agent.js',root),'utf8'),
    readFile(new URL('app/api/odeiry/chat/route.js',root),'utf8'),
    readFile(new URL('lib/odeiry-operational-guide.js',root),'utf8'),
    readFile(new URL('lib/odeiry-service-rpc.js',root),'utf8')
  ]);
  assert.equal((agent.match(/new Agent\(/g)||[]).length,1);
  assert.match(agent,
    /instructions:runContext=>runContext\.context\?\.assistantMode===['"]manager_v1['"][\s\S]+?MANAGER_INSTRUCTIONS\):OPERATIONS_INSTRUCTIONS/,
    'one agent must choose explicit mode instructions from trusted run state');
  assert.match(agent,/tools:\[inspectOperations,searchKnowledge\]/);
  assert.match(agent,
    /tools:\[\.\.\.operationsToolset\.tools,readManagerAnalytics\]/,
    'manager analytics extends rather than replaces the operations toolset');
  assert.match(agent,/MAX_KNOWLEDGE_CALLS=2/);
  assert.match(agent,/MAX_OPERATION_CALLS=2/);
  assert.match(agent,/MAX_MANAGER_ANALYTICS_CALLS=2/);
  const analyticsTool=agent.slice(
    agent.indexOf('const readManagerAnalytics=tool({'),
    agent.indexOf('const OPERATIONS_INSTRUCTIONS=')
  );
  assert.match(analyticsTool,/name:['"]read_odeir_manager_analytics['"]/);
  assert.match(analyticsTool,
    /isEnabled:[\s\S]+?assistantMode===['"]manager_v1['"][\s\S]+?platformAccess!==true/);
  assert.match(analyticsTool,/state\.analyticsCalls>=MAX_MANAGER_ANALYTICS_CALLS/);
  assert.match(agent,/parallelToolCalls:false/);
  assert.match(agent,/toolExecution:\{maxFunctionToolConcurrency:1\}/);
  assert.match(agent,/store:false/);
  assert.match(agent,/setSensitiveDataLoggingEnabled\(false\)/);
  assert.match(agent,/viewer\?\.platformAccess===true[\s\S]+?ticketDraft:null/);
  assert.match(agent,
    /assistantMode===['"]manager_v1['"][\s\S]+?needsEscalation:false[\s\S]+?ticketDraft:null/,
    'manager mode must be unable to produce a ticket or execution escalation');
  assert.match(agent,
    /const digitCount=\(normalizedDigits\.match[\s\S]+?\|\|digitCount>=8/,
    'eight Arabic or Latin digits are rejected regardless of separators');
  assert.match(agent,/\[٠-٩۰-۹\]/,
    'both Arabic digit ranges are normalized before counting');
  assert.match(serviceRpc,
    /const digitCount=\(digits\.match[\s\S]+?\|\|digitCount>=8/,
    'the service boundary independently enforces the normalized digit cap');
  assert.match(serviceRpc,/\[٠-٩۰-۹\]/,
    'the service boundary normalizes both Arabic digit ranges');
  assert.match(agent,/trusted\.kind===['"]knowledge['"][\s\S]+?citationKeys\.push/);
  assert.match(route,/citationKeys:result\.citationKeys/);
  assert.match(route,
    /responseData:persistableOutput\(result\.output\)[\s\S]+?finalizeWithRetry\([\s\S]+?result\.output\.memoryProposals/,
    'manager answer and proposals must use one closed atomic persistence path');
  assert.doesNotMatch(route,/persistManagerProposalsSafely|proposeOdeiryManagerMemories/);
  assert.doesNotMatch(route,
    /citationKeys:result\.output\.sources\.map/);
  assert.doesNotMatch(operations,
    /fetch\(|supportRpc|authRpc|SUPABASE|OPENAI|create_ticket|insert\s+into|update\s+|delete\s+from/i);
  assert.match(operations,/canReadCustomerOrEmployeeRecords:false/);
  assert.match(operations,/canModifyData:false/);
});

test('safe operations eval set covers capability, isolation, and injection cases',async()=>{
  const raw=await readFile(
    new URL('evals/odeiry-safe-operations-v2.jsonl',root),'utf8'
  );
  const cases=raw.trim().split('\n').map(line=>JSON.parse(line));
  assert.ok(cases.length>=8);
  assert.equal(new Set(cases.map(item=>item.id)).size,cases.length);
  for(const id of [
    'lead_import_formats','lead_import_permission_confirmed',
    'lead_distribution_permission_unknown','cross_tenant_request',
    'platform_operator_write','sales_follow_up','prompt_injection',
    'unsupported_operation'
  ])assert.ok(cases.some(item=>item.id===id),`missing eval ${id}`);
});

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}
