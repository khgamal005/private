import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test,{before,after,beforeEach} from 'node:test';
import {createHash} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';

const db=new PGlite();
const tenant='10000000-0000-0000-0000-000000000001';
const user='30000000-0000-0000-0000-000000000001';
const otherUser='30000000-0000-0000-0000-000000000002';
const hash=value=>createHash('sha256').update(value).digest('hex');
const userHash=hash('external-user|test-app');
let sequence=0;
let legacyBaseline;
const scalar=async(sql,params=[])=>Object.values((await db.query(sql,params)).rows[0])[0];
async function identity(value=user,role='authenticated'){
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)",[
    value,JSON.stringify(value?{sub:value,role}:{role})
  ]);
}
async function start(slug='demo'){
  const state=hash(`test-state-${++sequence}`);
  const result=await scalar('select public.v1_tenant_meta_connect_v2_begin_oauth($1,$2,$3)',[
    slug,state,`/tenant/${slug}/addons/social-connect`
  ]);
  return {...result,state};
}
async function claim(transaction){
  return scalar('select public.v1_tenant_meta_connect_v2_claim_oauth($1)',[transaction.state]);
}
async function finalize(transaction,scopes=['ads_read'],options={}){
  await identity('','service_role');
  return scalar('select public.v1_service_meta_connect_v2_finalize_oauth($1,$2,$3,$4,$5,$6,$7)',[
    transaction.transactionId,'external-user',userHash,'fake-token-for-isolated-postgres-tests-only',scopes,
    options.expiresAt||new Date(Date.now()+3600_000).toISOString(),null
  ]);
}
async function callback(type='data_deletion',issuedAt=new Date().toISOString(),payload='event'){
  await identity('','service_role');
  return scalar('select public.v1_service_meta_connect_v2_process_callback($1,$2,$3,$4,$5,$6)',[
    type,'external-user',userHash,hash(payload),issuedAt,type==='data_deletion'?hash(`${payload}-confirmation`):null
  ]);
}
async function connected(){const transaction=await start();await claim(transaction);await finalize(transaction);return transaction;}

before(async()=>{
  await db.exec(await readFile(new URL('./fixtures/meta-connect-v2-database.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20260825190000_meta_connect_v2_oauth_control_plane.sql',import.meta.url),'utf8'));
  legacyBaseline=(await db.query('select * from marketing_hub.connections order by id')).rows;
});
after(async()=>{
  assert.deepEqual((await db.query('select * from marketing_hub.connections order by id')).rows,legacyBaseline);
  await db.close();
});
beforeEach(async()=>{
  await db.exec(`
    truncate meta_connect_v2.deletion_requests,meta_connect_v2.callback_events,
      meta_connect_v2.credential_refs,meta_connect_v2.connections,
      meta_connect_v2.oauth_transactions,meta_connect_v2.rollout_targets,vault.secrets,audit_log.events;
    update core.tenants set status='active';
    update access_control.subjects set status='active',must_change_password=false;
    update access_control.tenant_memberships set status='active';
    update private_app.test_entitlements set enabled=true;
    update meta_connect_v2.kill_switches set enabled=true;
    insert into meta_connect_v2.rollout_targets(tenant_id,status,capabilities,approved_at)
      select id,'pilot',array['oauth'],now() from core.tenants;
  `);
  await identity();
});

test('SQL grants expose claim to authenticated actors and keep finalization/table data private',async()=>{
  assert.equal(await scalar("select has_function_privilege('anon','public.v1_tenant_meta_connect_v2_claim_oauth(text)','execute')"),false);
  assert.equal(await scalar("select has_function_privilege('authenticated','public.v1_tenant_meta_connect_v2_claim_oauth(text)','execute')"),true);
  assert.equal(await scalar("select has_function_privilege('authenticated','public.v1_service_meta_connect_v2_finalize_oauth(uuid,text,text,text,text[],timestamptz,timestamptz)','execute')"),false);
  assert.equal(await scalar("select has_table_privilege('authenticated','meta_connect_v2.credential_refs','select')"),false);
});

test('SQL rejects another actor without consuming the victim state and rejects cross-tenant start',async()=>{
  const transaction=await start();await identity(otherUser);
  await assert.rejects(claim(transaction),/forbidden/);
  await assert.rejects(start(),/forbidden/);
  await identity();await claim(transaction);
  await assert.rejects(claim(transaction),/oauth_state_invalid_or_used/);
});

test('SQL expires state before claim and closes finalized state against replay',async()=>{
  const expired=await start();
  await db.query("update meta_connect_v2.oauth_transactions set created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' where id=$1",[expired.transactionId]);
  await assert.rejects(claim(expired),/oauth_state_invalid_or_used/);
  const transaction=await start();await claim(transaction);await finalize(transaction);
  assert.equal(await scalar('select status from meta_connect_v2.oauth_transactions where id=$1',[transaction.transactionId]),'finalized');
  await assert.rejects(finalize(transaction),/oauth_transaction_invalid/);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),1);
});

test('SQL enforces read-only scopes and rejects expired provider tokens',async()=>{
  const transaction=await start();await claim(transaction);
  for(const scopes of [['ads_read','ads_management'],['ads_read','business_management'],['ads_read','unknown'],['public_profile'],['ads_read',null]]){
    await assert.rejects(finalize(transaction,scopes),/invalid_meta_token_contract/);
  }
  await assert.rejects(finalize(transaction,['ads_read'],{expiresAt:new Date(Date.now()-1000).toISOString()}),/invalid_meta_token_contract/);
  await finalize(transaction,['ads_read','public_profile']);
});

for(const [name,sql,error] of [
  ['kill switch',"update meta_connect_v2.kill_switches set enabled=false where capability='oauth'",/meta_connect_v2_oauth_disabled/],
  ['entitlement','update private_app.test_entitlements set enabled=false',/addon_not_enabled/],
  ['membership',"update access_control.tenant_memberships set status='disabled'",/forbidden/],
  ['actor',"update access_control.subjects set status='disabled'",/forbidden/],
  ['tenant',"update core.tenants set status='disabled'",/tenant_not_found/],
  ['rollout',"update meta_connect_v2.rollout_targets set status='disabled'",/meta_connect_v2_not_in_rollout/]
])test(`SQL rechecks ${name} after authenticated claim before storing credentials`,async()=>{
  const transaction=await start();await claim(transaction);await db.exec(sql);
  await assert.rejects(finalize(transaction),error);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),0);
});

test('SQL rotates one credential and restores service claims after authorization checks',async()=>{
  await connected();await identity();
  const previous=await scalar('select id from vault.secrets');
  const transaction=await start();await claim(transaction);await finalize(transaction);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),1);
  assert.notEqual(await scalar('select id from vault.secrets'),previous);
  assert.equal(await scalar("select current_setting('request.jwt.claim.sub')"),'');
  assert.deepEqual(JSON.parse(await scalar("select current_setting('request.jwt.claims')")),{role:'service_role'});
});

test('SQL disconnect invalidates a first pending/claimed authorization before any connection exists',async()=>{
  const transaction=await start();await claim(transaction);
  assert.equal((await scalar('select public.v1_tenant_meta_connect_v2_disconnect($1)',['demo'])).status,'not_connected');
  await assert.rejects(finalize(transaction),/oauth_transaction_invalid/);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),0);
});

test('SQL a newer start supersedes earlier in-flight authorization for the same tenant',async()=>{
  const first=await start();await claim(first);
  const second=await start();await claim(second);
  await assert.rejects(finalize(first),/oauth_transaction_invalid/);
  await finalize(second);
  assert.equal(await scalar('select count(*)::integer from meta_connect_v2.connections'),1);
});

test('SQL deletion removes the current credential, invalidates pending reauth, and retries idempotently',async()=>{
  await connected();await identity();const pending=await start();await claim(pending);
  const when=new Date().toISOString();
  const first=await callback('data_deletion',when,'delete-once');
  const second=await callback('data_deletion',when,'delete-once');
  assert.equal(first.status,'completed');assert.equal(second.status,'completed');
  assert.equal(second.affectedConnections,0);
  await assert.rejects(finalize(pending),/oauth_transaction_invalid/);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),0);
  assert.equal(await scalar('select count(*)::integer from meta_connect_v2.credential_refs'),0);
  assert.equal(await scalar('select external_user_id from meta_connect_v2.connections'),null);
  assert.equal((await scalar('select public.v1_service_meta_connect_v2_deletion_status($1)',[hash('delete-once-confirmation')])).status,'completed');
});

test('SQL deletion before the first callback finish blocks unknown pending external identity',async()=>{
  const transaction=await start();await claim(transaction);
  assert.equal((await callback()).status,'no_data');
  await assert.rejects(finalize(transaction),/oauth_authorization_revoked/);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),0);
});

test('SQL delayed revocation does not erase a newer grant or its current secret',async()=>{
  await connected();
  await db.exec("update meta_connect_v2.connections set last_authorized_at=now()+interval '2 seconds'");
  const before=await scalar('select id from vault.secrets');
  assert.equal((await callback('deauthorization')).affectedConnections,0);
  assert.equal(await scalar('select id from vault.secrets'),before);
  assert.equal(await scalar('select status from meta_connect_v2.connections'),'connected');
});

test('SQL delayed callback issued during code exchange still removes that in-flight grant',async()=>{
  const transaction=await start();await claim(transaction);
  await db.query("update meta_connect_v2.oauth_transactions set created_at=now()-interval '10 seconds' where id=$1",[transaction.transactionId]);
  await finalize(transaction);
  const duringExchange=new Date(Date.now()-5000).toISOString();
  assert.equal((await callback('deauthorization',duringExchange)).affectedConnections,1);
  assert.equal(await scalar('select count(*)::integer from vault.secrets'),0);
});

test('SQL snapshot reflects expired authorization without mutating connection history',async()=>{
  await connected();await identity();
  await db.exec("update meta_connect_v2.connections set token_expires_at=now()-interval '1 second'");
  assert.equal((await scalar('select public.v1_tenant_meta_connect_v2_snapshot($1)',['demo'])).status,'reauth_required');
  assert.equal(await scalar('select status from meta_connect_v2.connections'),'connected');
});

test('SQL legacy Meta connection is rejected without changing its stored row',async()=>{
  await assert.rejects(start('legacy-fixture'),/legacy_meta_connection_present/);
  assert.deepEqual((await db.query('select * from marketing_hub.connections order by id')).rows,legacyBaseline);
  assert.equal(await scalar('select count(*)::integer from meta_connect_v2.oauth_transactions'),0);
});
