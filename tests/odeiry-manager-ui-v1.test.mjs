import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const ROOT=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,ROOT),'utf8');
}

test('manager UI follows tenant access mode, not a global platform label',async()=>{
  const [env,layout,shell,assistant,manager]=await Promise.all([
    source('.env.example'),
    source('app/tenant/[slug]/layout.js'),
    source('components/workspace-shell.js'),
    source('components/odeiry-assistant.js'),
    source('components/odeiry-manager-panel.js')
  ]);
  assert.match(env,/^ODEIRY_MANAGER_ENABLED=false$/m);
  assert.doesNotMatch(env,/^NEXT_PUBLIC_ODEIRY_MANAGER/m);
  assert.match(layout,/process\.env\.ODEIRY_MANAGER_ENABLED==='true'/);
  assert.match(layout,/odeiryAccessMode==='tenant_member'/);
  assert.doesNotMatch(layout,/&&!context\.platformAccess/);
  assert.match(layout,/odeirySnapshot\?\.manager\?\.allowed===true/);
  assert.match(layout,/odeirySnapshot\?\.manager\?\.enabled===true/);
  assert.match(layout,/odeirySnapshot\?\.manager\?\.available===true/);
  assert.match(layout,/const odeiryManagerReviewEnabled=Boolean\(/);
  assert.match(layout,/odeirySnapshot\?\.manager\?\.reviewAvailable===true/);
  assert.match(shell,/managerEnabled=\{odeiryManagerEnabled\}/);
  assert.match(shell,
    /managerReviewEnabled=\{odeiryManagerReviewEnabled\}/);
  assert.match(assistant,
    /const canUseManager=\(managerEnabled===true\|\|managerReviewEnabled===true\)[\s\S]+?&&!platformOperator/);
  assert.match(assistant,
    /const managerChatEnabled=managerEnabled===true&&!platformOperator/);
  assert.match(assistant,/\{canUseManager&&<OdeiryManagerPanel/);
  assert.match(assistant,/chatEnabled=\{managerChatEnabled\}/);
  assert.match(manager,/if\(active&&!chatEnabled\)setTab\('memory'\)/);
  assert.match(manager,
    /decision===['"]approve['"]&&!chatEnabled/,
    'review-only mode must never approve a new memory');
  assert.match(manager,
    /\{approvalEnabled&&<button[^>]+onClick=\{\(\)=>onAction\(memory,'approve'\)\}/);
  assert.match(manager,
    /onClick=\{\(\)=>onAction\(memory,'reject'\)\}/);
  assert.match(manager,
    /onClick=\{\(\)=>onAction\(memory,'archive'\)\}/);
});

test('manager chat is an explicit isolated read-only mode',async()=>{
  const manager=await source('components/odeiry-manager-panel.js');
  const chatStart=manager.indexOf('async function askManager');
  const chatEnd=manager.indexOf('async function reviewMemory',chatStart);
  const chatBlock=manager.slice(chatStart,chatEnd);
  assert.match(chatBlock,/fetch\('\/api\/odeiry\/chat'/);
  assert.match(chatBlock,/assistantMode:'manager_v1'/);
  assert.doesNotMatch(manager,/\/api\/support\/tenant\/create_ticket|link-ticket/);
  assert.match(manager,/قراءة وتحليل فقط/);
  assert.match(manager,/لا ينفّذ أي إجراء/);
  assert.match(manager,/role="tablist"/);
  assert.match(manager,/المحادثة/);
  assert.match(manager,/السجل/);
  assert.match(manager,/الذاكرة/);
  assert.match(manager,/\{chatEnabled&&<button[^>]+odeiry-manager-chat-tab/);
  assert.match(manager,/hidden=\{!chatEnabled\|\|tab!==['"]chat['"]\}/);
  assert.match(manager,/التحليل متوقف — الذاكرة تحت سيطرتك/);
});

test('reviewed memory sends only identifiers, version, and explicit decision',async()=>{
  const manager=await source('components/odeiry-manager-panel.js');
  const reviewStart=manager.indexOf('async function reviewMemory');
  const reviewEnd=manager.indexOf('\n  return <div',reviewStart);
  const reviewBlock=manager.slice(reviewStart,reviewEnd);
  assert.match(reviewBlock,/action:'review_memory'/);
  assert.match(reviewBlock,/memoryId,/);
  assert.match(reviewBlock,/decision,/);
  assert.match(reviewBlock,/expectedVersion,/);
  assert.match(reviewBlock,/clientRequestId:requestId/);
  assert.doesNotMatch(reviewBlock,/\b(?:statement|content|tenantId|subjectId):/);
  assert.match(manager,/onAction\(memory,'approve'\)/);
  assert.match(manager,/onAction\(memory,'reject'\)/);
  assert.match(manager,/onAction\(memory,'archive'\)/);
});

test('terminal manager runs retry with a fresh client request id',async()=>{
  const manager=await source('components/odeiry-manager-panel.js');
  assert.match(manager,
    /this\.retryWithNewRequestId=result\?\.retryWithNewRequestId===true/);
  assert.match(manager,
    /retryWithNewRequestId=requestError instanceof ManagerRequestError[\s\S]+?setRetryAttempt\(retryWithNewRequestId\?\{[\s\S]+?requestId:clientRequestId\(\),[\s\S]+?startsNewRun:true/);
  assert.match(manager,
    /retryAttempt\.startsNewRun\?'بدء محاولة جديدة':'إعادة المحاولة بأمان'/);
});

test('manager memory normalization preserves the database workspace limits',async()=>{
  const manager=await source('components/odeiry-manager-panel.js');
  assert.match(manager,
    /MANAGER_MEMORY_LIMITS=\{pending:50,approved:100,archived:20\}/);
  assert.match(manager,/slice\(0,MANAGER_MEMORY_LIMITS\.pending\)/);
  assert.match(manager,/slice\(0,MANAGER_MEMORY_LIMITS\.approved\)/);
  assert.match(manager,/slice\(0,MANAGER_MEMORY_LIMITS\.archived\)/);
  assert.doesNotMatch(manager,/memories=\{[\s\S]+?slice\(0,30\)/);
});

test('a stale memory review refreshes state before the user retries',async()=>{
  const manager=await source('components/odeiry-manager-panel.js');
  const reviewStart=manager.indexOf('async function reviewMemory');
  const reviewEnd=manager.indexOf('\n  return <div',reviewStart);
  const reviewBlock=manager.slice(reviewStart,reviewEnd);
  assert.match(reviewBlock,
    /staleReview=requestError instanceof ManagerRequestError/);
  assert.match(reviewBlock,
    /requestError\.status===409\|\|requestError\.code\.includes\('VERSION'\)/);
  assert.match(reviewBlock,/reviewAttemptIds\.current\.delete\(attemptKey\)/);
  assert.match(reviewBlock,/await loadWorkspace\(\{quiet:true\}\)/);
});
