import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260824171000_registration_email_delivery_ledger_v1.sql';

function section(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=end?source.indexOf(end,from+start.length):source.length;
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to);
}

test('delivery ledger stores transport evidence but no recipient, content, URL, or raw token',async()=>{
  const migration=await read(MIGRATION);
  const table=section(
    migration,
    'create table if not exists platform.registration_email_deliveries',
    ');'
  );
  assert.match(table,/request_id uuid not null/);
  assert.match(table,/message_kind text not null/);
  assert.match(table,/confirmation_token_hash text not null/);
  assert.match(table,/generation integer not null/);
  assert.match(table,/idempotency_key text not null unique/);
  assert.match(table,/provider_message_id text/);
  assert.match(table,/status text not null[\s\S]*?'sending'[\s\S]*?'accepted'[\s\S]*?'failed'/);
  assert.match(table,/attempt_count integer not null/);
  assert.match(table,/last_http_status integer/);
  assert.match(table,/last_error_code text/);
  assert.doesNotMatch(table,/recipient|contact_email|email_address|subject|html|body|confirmation_url|raw_token/i);
  assert.match(migration,/alter table platform\.registration_email_deliveries enable row level security/);
  assert.match(migration,/revoke all on table platform\.registration_email_deliveries[\s\S]*?from public,anon,authenticated,service_role/);
});

test('begin delivery locks the request, validates eligibility, and reuses a stable idempotency key',async()=>{
  const migration=await read(MIGRATION);
  const begin=section(
    migration,
    'create or replace function public.v1_registration_email_delivery_begin',
    '$$;'
  );
  assert.match(begin,/security definer\s+set search_path=''/);
  assert.match(begin,/from platform\.registration_requests request[\s\S]*?for update/);
  assert.match(begin,/institution_state<>'new'|institution_state='new'/);
  assert.match(begin,/external_account_id is not null|external_account_id is null/);
  assert.match(begin,/activation_mode<>'email_verified_trial'|activation_mode='email_verified_trial'/);
  assert.match(begin,/email_confirmation_token_hash/);
  assert.match(begin,/email_confirmation_expires_at/);
  assert.match(begin,/delivery\.status='accepted'[\s\S]*?sendRequired',false/);
  assert.match(begin,/delivery\.status='sending'[\s\S]*?interval '30 seconds'/);
  assert.match(begin,/odeir-registration-confirmation\//);
  assert.match(begin,/attempt_count=delivery\.attempt_count\+1|attempt_count\+1/);
});

test('finish is monotonic: accepted provider evidence cannot be downgraded by a stale failure',async()=>{
  const migration=await read(MIGRATION);
  const finish=section(
    migration,
    'create or replace function public.v1_registration_email_delivery_finish',
    '$$;'
  );
  assert.match(finish,/security definer\s+set search_path=''/);
  assert.match(finish,/for update/);
  assert.match(finish,/v_delivery\.attempt_count<>p_attempt/);
  assert.match(finish,/v_delivery\.status='accepted'/);
  assert.match(finish,/p_outcome='accepted'/);
  assert.match(finish,/p_http_status not between 200 and 299/);
  assert.match(finish,/provider_message_id/);
  assert.match(finish,/status='failed'/);
  assert.match(finish,/last_error_code/);
  assert.match(finish,/v1_registration_mark_confirmation_sent/);
});

test('an in-flight delivery protects its raw-link hash from premature rotation',async()=>{
  const migration=await read(MIGRATION);
  const guard=section(
    migration,
    'create or replace function private_app.registration_email_rotation_guard',
    '$$;'
  );
  assert.match(guard,/old\.email_confirmation_token_hash/);
  assert.match(guard,/new\.email_confirmation_token_hash is distinct from/);
  assert.match(guard,/delivery\.status='sending'/);
  assert.match(guard,/interval '30 seconds'/);
  assert.match(guard,/confirmation_email_in_progress/);
  assert.match(migration,/before update of email_confirmation_token_hash[\s\S]*?registration_email_rotation_guard/);
});

test('only service role can execute email-delivery state transitions',async()=>{
  const migration=await read(MIGRATION);
  const compact=migration.replace(/\s+/g,'');
  for(const signature of [
    'public.v1_registration_email_delivery_begin(uuid,text)',
    'public.v1_registration_email_delivery_finish(uuid,integer,text,text,integer,text)'
  ]){
    assert.ok(compact.includes(`revokeallonfunction${signature}frompublic,anon,authenticated;`));
    assert.ok(compact.includes(`grantexecuteonfunction${signature}toservice_role;`));
  }
});

test('Edge transport records every attempt and requires a valid Resend acceptance id',async()=>{
  const edge=await read('supabase/functions/odeir-registration-intake/index.ts');
  assert.match(edge,/v1_registration_email_delivery_begin/);
  assert.match(edge,/v1_registration_email_delivery_finish/);
  assert.match(edge,/Idempotency-Key/);
  assert.match(edge,/idempotencyKey/);
  assert.match(edge,/providerMessageId|provider_message_id/);
  assert.match(edge,/response\.text\(\)/);
  assert.match(edge,/JSON\.parse/);
  assert.match(edge,/mark_confirmation_sent/);
  assert.match(edge,/marked[^\n]*!==true|markResult[^\n]*!==true|markData[^\n]*!==true/);
  assert.match(edge,/confirmation_email_in_progress/);
  assert.match(edge,/confirmation_email_state_unavailable/);
  assert.doesNotMatch(edge,/console\.(?:log|error)[^\n]*(?:contactEmail|recipient|confirmationUrl|apiKey)/i);
});

test('manual existing registrations do not promise an email that is intentionally not sent',async()=>{
  const ui=await read('components/free-trial-landing.js');
  assert.match(ui,/manualExisting/);
  assert.match(ui,/لن نرسل رابط تفعيل تلقائيًا/);
  assert.match(ui,/مطابقة المنشأة/);
  assert.match(ui,/ربط الحساب القائم بأمان/);
  assert.doesNotMatch(
    section(ui,'manualExisting','طلب آخر'),
    /رسالة التأكيد[^\n]*على بريد مسؤول الطلب/
  );
});
