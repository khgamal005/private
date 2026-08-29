import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,root),'utf8');
}

function handler(sourceCode,name){
  const start=sourceCode.indexOf(`export async function ${name}`);
  assert.notEqual(start,-1,`${name} handler must exist`);
  return sourceCode.slice(start);
}

test('support attachment API fails closed before auth, RPC, or Storage work',async()=>{
  const [policy,registerSource,finalizeSource,downloadSource,shared]=await Promise.all([
    source('lib/support-attachment-policy.js'),
    source('app/api/support/attachments/route.js'),
    source('app/api/support/attachments/finalize/route.js'),
    source('app/api/support/attachments/[attachmentId]/route.js'),
    source('app/api/support/_shared.js')
  ]);
  assert.match(policy,/SUPPORT_ATTACHMENTS_ENABLED=false/);
  assert.match(policy,
    /SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE='support_attachments_scanner_unavailable'/);
  assert.match(policy,/المرفقات متوقفة مؤقتًا لحين اكتمال فحص الأمان/);

  for(const [name,routeSource] of [
    ['POST',registerSource],['POST',finalizeSource],['GET',downloadSource]
  ]){
    const routeHandler=handler(routeSource,name);
    const guard=routeHandler.indexOf('if(!SUPPORT_ATTACHMENTS_ENABLED)');
    const response=routeHandler.indexOf(
      'return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503)'
    );
    assert.ok(guard>=0&&response>guard,'503 attachment guard must be first');
    for(const operation of ['sessionToken(','supportRpc(']){
      const operationIndex=routeHandler.indexOf(operation);
      if(operationIndex>=0){
        assert.ok(response<operationIndex,
          `attachment guard must run before ${operation}`);
      }
    }
  }
  const registerHandler=handler(registerSource,'POST');
  const downloadHandler=handler(downloadSource,'GET');
  assert.ok(registerHandler.indexOf('return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503)')
    <registerHandler.indexOf('/storage/v1/object/upload/sign/'));
  assert.ok(downloadHandler.indexOf('return failure(SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE,503)')
    <downloadHandler.indexOf("storageUrl('sign'"));

  assert.match(shared,/code===SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE\)return 503/);
  assert.match(shared,
    /\[SUPPORT_ATTACHMENTS_UNAVAILABLE_CODE\]:SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE/);
});

test('support desk hides attachment controls while preserving text tickets and replies',async()=>{
  const desk=await source('components/odeir-support-desk.js');
  assert.match(desk,
    /SUPPORT_ATTACHMENTS_ENABLED[\s\S]+?SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE/);
  assert.equal((desk.match(/SUPPORT_ATTACHMENTS_ENABLED\s*\n?\s*\?<label/g)||[]).length,2,
    'both attachment file pickers must be behind the fail-closed policy');
  assert.match(desk,
    /<small className=\{styles\.attachmentUnavailable\} role="note">\{SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE\}<\/small>/);
  assert.match(desk,
    /<p className=\{cx\(styles\.attachmentUnavailable,styles\.wide\)\} role="note">\{SUPPORT_ATTACHMENTS_UNAVAILABLE_MESSAGE\}<\/p>/);
  assert.match(desk,/if\(!SUPPORT_ATTACHMENTS_ENABLED\)return 0/);
  assert.match(desk,
    /const uploadFailures=SUPPORT_ATTACHMENTS_ENABLED[\s\S]+?:0;/);
  assert.match(desk,
    /const hasReplyFiles=SUPPORT_ATTACHMENTS_ENABLED&&replyFiles\.length>0/);
  assert.match(desk,/action:'create_ticket'/);
  assert.match(desk,/\?'add_internal_note'[\s\S]+?:'add_message'/);
  assert.match(desk,/التنزيل غير متاح مؤقتًا/);
});