import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const MIGRATION=new URL(
  '../supabase/migrations/20260824172000_registration_fk_indexes_v1.sql',
  import.meta.url
);

test('every registration foreign key flagged by the advisor has a covering index',async()=>{
  const source=await readFile(MIGRATION,'utf8');
  assert.match(source,/^begin;[\s\S]*commit;\s*$/);

  const expected=[
    ['registration_activation_attestations','requested_by_subject_id'],
    ['registration_email_webhook_events','delivery_id'],
    ['registration_email_worker_config','configured_by_subject_id'],
    ['registration_external_account_claims','claimed_by_subject_id'],
    ['registration_identity_claims','request_id'],
    ['registration_request_events','actor_subject_id'],
    ['registration_requests','reviewed_by_subject_id'],
    ['registration_settings','updated_by_subject_id']
  ];

  for(const [table,column] of expected){
    assert.match(
      source,
      new RegExp(`create index if not exists [a-z0-9_]+\\n`+
        `on platform\\.${table}\\(${column}\\)`),
      `missing covering index for platform.${table}(${column})`
    );
  }
  assert.equal((source.match(/create index if not exists/g)||[]).length,8);
});
