import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const MIGRATION='supabase/migrations/20260824171000_registration_email_delivery_ledger_v1.sql';
const MANUAL_ACTIVATION_MIGRATION=
  'supabase/migrations/20260824170000_registration_manual_activation_integrity_v1.sql';
const NON_ASCII_DIGITS='٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const ASCII_DIGITS='01234567890123456789';

function normalizedDigits(value){
  return [...value.trim()].map(character=>{
    const index=NON_ASCII_DIGITS.indexOf(character);
    return index===-1?character:ASCII_DIGITS[index];
  }).join('');
}

function validIdentifier(kind,value){
  if(value.trim()==='')return true;
  if(kind==='tvtc')return false;
  const normalized=normalizedDigits(value);
  const length=10;
  const pattern=kind==='national'?/^7[0-9]{9}$/:/^[0-9]{10}$/;
  return pattern.test(normalized)
    &&normalized!==normalized[0].repeat(length);
}

function between(source,start,end){
  const from=source.indexOf(start);
  assert.notEqual(from,-1,`missing section start: ${start}`);
  const to=source.indexOf(end,from+start.length);
  assert.notEqual(to,-1,`missing section end: ${end}`);
  return source.slice(from,to+end.length);
}

function tableSql(source,name){
  return between(source,`create table if not exists ${name} (`,'\n);');
}

function functionSql(source,name){
  const marker=`create or replace function ${name}(`;
  const from=source.indexOf(marker);
  assert.notEqual(from,-1,`missing function: ${name}`);
  const plain=source.indexOf('\n$$;',from);
  const named=source.indexOf('\n$function$;',from);
  const candidates=[plain,named].filter(value=>value!==-1);
  assert.ok(candidates.length>0,`missing function terminator: ${name}`);
  const to=Math.min(...candidates);
  return source.slice(from,to+(to===plain?4:12));
}

const compact=value=>value.replace(/\s+/g,'').toLowerCase();

function assertServiceOnly(source,signature){
  const normalized=compact(source);
  assert.ok(normalized.includes(
    `revokeallonfunction${signature}frompublic,anon,authenticated,service_role;`
  ),`missing full revoke: ${signature}`);
  assert.ok(normalized.includes(
    `grantexecuteonfunction${signature}toservice_role;`
  ),`missing service_role grant: ${signature}`);
}

function assertSqlEnvelopeIsBalanced(source){
  let index=0;
  let depth=0;
  while(index<source.length){
    if(source.startsWith('--',index)){
      const newline=source.indexOf('\n',index+2);
      index=newline===-1?source.length:newline+1;
      continue;
    }
    if(source.startsWith('/*',index)){
      const close=source.indexOf('*/',index+2);
      assert.notEqual(close,-1,'unterminated block comment');
      index=close+2;
      continue;
    }
    if(source[index]==="'"){
      index++;
      while(index<source.length){
        if(source[index]!=="'"){index++;continue;}
        if(source[index+1]==="'"){index+=2;continue;}
        index++;
        break;
      }
      continue;
    }
    if(source[index]==='"'){
      index++;
      while(index<source.length){
        if(source[index]!=='"'){index++;continue;}
        if(source[index+1]==='"'){index+=2;continue;}
        index++;
        break;
      }
      continue;
    }
    if(source[index]==='$'){
      const match=source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
      if(match){
        const tag=match[0];
        const close=source.indexOf(tag,index+tag.length);
        assert.notEqual(close,-1,`unterminated dollar quote ${tag}`);
        index=close+tag.length;
        continue;
      }
    }
    if(source[index]==='(')depth++;
    if(source[index]===')'){
      depth--;
      assert.ok(depth>=0,`unexpected ) at byte ${index}`);
    }
    index++;
  }
  assert.equal(depth,0,'unbalanced SQL envelope parentheses');
}

test('migration has one atomic envelope and structurally balanced SQL',async()=>{
  const migration=await read(MIGRATION);
  assert.equal((migration.match(/^begin;$/gm)??[]).length,1);
  assert.equal((migration.match(/^commit;$/gm)??[]).length,1);
  assert.match(migration,/^begin;[\s\S]*commit;\s*$/);
  assert.doesNotMatch(migration,/\bdeclare\s+declare\b/i);
  assertSqlEnvelopeIsBalanced(migration);
});

test('outbox persists deterministic evidence, leases, and no bearer/message material',async()=>{
  const migration=await read(MIGRATION);
  const delivery=tableSql(migration,'platform.registration_email_deliveries');
  for(const pattern of [
    /request_id uuid not null/,/generation integer not null/,
    /key_version smallint not null/,/token_nonce text not null/,
    /confirmation_token_hash text/,/token_expires_at timestamptz not null/,
    /template_version text not null/,/content_fingerprint text/,
    /idempotency_key text not null unique/,/attempt_count integer not null/,
    /lease_id uuid/,/lease_expires_at timestamptz/,/provider_message_id text/,
    /'queued','leased','retryable','accepted','terminal_failed','cancelled'/
  ])assert.match(delivery,pattern);
  assert.doesNotMatch(delivery,
    /\brecipient\b|contact_email|email_address|\bsubject\b|\bhtml\b|\bbody\b|confirmation_url|raw_token|plaintext|ciphertext/i
  );
  assert.match(delivery,/state<>'accepted'[\s\S]*confirmation_token_hash is not null[\s\S]*content_fingerprint is not null[\s\S]*provider_message_id is not null/);

  const config=tableSql(migration,'platform.registration_email_worker_config');
  assert.match(config,/worker_token_hash text not null/);
  assert.match(config,/worker_token_vault_id uuid not null/);
  assert.match(config,/publishable_key_vault_id uuid not null/);
  assert.doesNotMatch(config,/worker_token text|publishable_key text|decrypted_secret|raw_secret/i);
});

test('all private ledger tables have RLS and direct grants revoked',async()=>{
  const migration=await read(MIGRATION);
  const normalized=compact(migration);
  for(const name of [
    'registration_request_identity_reservations','registration_email_deliveries',
    'registration_confirmation_token_aliases','registration_email_delivery_attempts',
    'registration_email_webhook_events','registration_email_worker_heartbeat',
    'registration_email_worker_config'
  ]){
    assert.ok(normalized.includes(`altertableplatform.${name}enablerowlevelsecurity;`));
    assert.ok(normalized.includes(
      `revokeallontableplatform.${name}frompublic,anon,authenticated,service_role;`
    ));
  }
});

test('v2 identifiers are lossless-normalized, strict, and DB-authoritative',async()=>{
  const migration=await read(MIGRATION);
  const submit=functionSql(migration,'public.v2_public_submit_registration_request');
  assert.match(submit,/translate\([\s\S]*'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'[\s\S]*'01234567890123456789'/);
  assert.match(submit,/v_commercial !~ '\^\[0-9\]\{10\}\$'/);
  assert.match(submit,/v_national !~ '\^7\[0-9\]\{9\}\$'/);
  assert.match(submit,/v_commercial=repeat\(substr\(v_commercial,1,1\),10\)/);
  assert.match(submit,/v_national=repeat\(substr\(v_national,1,1\),10\)/);
  assert.match(submit,/raise exception 'registration_identifier_invalid'/);
  assert.match(submit,/'tvtc_identifier_not_auto_eligible'/);
  assert.match(submit,/array_length\(v_identity_hashes,1\),0\)=0 then[\s\S]*v_mode:='manual_review'/);
  assert.doesNotMatch(submit,/array_append\(v_identity_types,'tvtc'\)/);
  assert.doesNotMatch(submit,/extensions\.digest\('tvtc:'/);
  assert.doesNotMatch(submit,/regexp_replace\(\s*coalesce\(p_payload->>'(?:commercialRegistration|nationalRegistration)'/);
  assert.match(submit,/setting\.email_token_key_version/);
  assert.doesNotMatch(submit,/p_confirmation_key_version/);
  const confirm=functionSql(migration,'public.v1_registration_confirm_email_and_provision');
  assert.doesNotMatch(confirm,/claim\.identifier_type='tvtc'|extensions\.digest\(\s*'tvtc:'/);
  assert.match(confirm,/v_commercial !~ '\^\[0-9\]\{10\}\$'/);
  assert.match(confirm,/v_national !~ '\^7\[0-9\]\{9\}\$'/);
  assert.doesNotMatch(confirm,/regexp_replace\([\s\S]*v_request\.(?:commercial_registration|national_registration)/);
  assert.match(confirm,/pg_advisory_xact_lock\(hashtextextended\([\s\S]*'registration-identity:'/);
  assert.match(confirm,
    /update core\.tenants tenant[\s\S]*set status='active'[\s\S]*get diagnostics v_tenant_updated=row_count;[\s\S]*if v_tenant_updated<>1 then[\s\S]*raise exception 'registration_created_tenant_activation_failed';[\s\S]*update platform\.registration_requests request/
  );
  const claimSync=functionSql(migration,'private_app.registration_identity_claim_sync');
  assert.match(claimSync,/v_commercial[\s\S]*'\^\[0-9\]\{10\}\$'/);
  assert.match(claimSync,/v_national[\s\S]*'\^7\[0-9\]\{9\}\$'/);
  assert.match(claimSync,/pg_advisory_xact_lock\(hashtextextended/);
  assert.match(claimSync,/new\.institution_state is distinct from 'new'/);
  assert.doesNotMatch(claimSync,/translate\(|regexp_replace\(|trim\(/);
  assert.doesNotMatch(claimSync,/'tvtc'|tvtc_license_number/);
});

test('the later ledger migration preserves the manual directory-claim isolation guard',async()=>{
  assert.ok(
    MANUAL_ACTIVATION_MIGRATION<MIGRATION,
    'manual activation hardening must run before the ledger override'
  );
  const [manual,ledger]=await Promise.all([
    read(MANUAL_ACTIVATION_MIGRATION),
    read(MIGRATION)
  ]);
  const manualClaimSync=functionSql(
    manual,'private_app.registration_identity_claim_sync'
  );
  const ledgerClaimSync=functionSql(
    ledger,'private_app.registration_identity_claim_sync'
  );
  for(const claimSync of [manualClaimSync,ledgerClaimSync]){
    assert.match(claimSync,/new\.institution_state is distinct from 'new'/);
    assert.doesNotMatch(
      claimSync,
      /regexp_replace\(|translate\(|trim\(|'tvtc'|tvtc_license_number/
    );
  }
  const trigger=between(
    ledger,
    'drop trigger if exists platform_registration_identity_claim_sync',
    'execute function private_app.registration_identity_claim_sync();'
  );
  assert.match(trigger,/new\.provisioned_tenant_id is not null/);
  assert.match(trigger,/new\.institution_state='new'/);
});

test('formal identifier examples cover short, placeholders, masks, Arabic digits, valid and duplicate forms',()=>{
  assert.equal(validIdentifier('commercial','1'),false);
  assert.equal(validIdentifier('commercial','0000000000'),false);
  assert.equal(validIdentifier('commercial','1111111111'),false);
  assert.equal(validIdentifier('commercial','10123*****'),false);
  assert.equal(validIdentifier('commercial','1012345678-suffix'),false);
  assert.equal(validIdentifier('national','6123456789'),false);
  assert.equal(validIdentifier('national','٧١٢٣٤٥٦٧٨٩'),true);
  assert.equal(validIdentifier('commercial','۱۰۱۲۳۴۵۶۷۸'),true);
  assert.equal(validIdentifier('tvtc','x'),false);
  assert.equal(validIdentifier('tvtc','١٢٣٤٥٦٧٨'),false);
  assert.equal(validIdentifier('commercial','1012345678'),true);
  assert.equal(validIdentifier('national','7123456789'),true);
  assert.equal(validIdentifier('tvtc','12345678'),false);
  assert.equal(
    normalizedDigits('١٠١٢٣٤٥٦٧٨'),
    normalizedDigits('1012345678'),
    'Arabic/ASCII duplicates must reserve the same normalized identity'
  );
});

test('v2 deduplicates by locked institution identity, never contact email alone',async()=>{
  const migration=await read(MIGRATION);
  const submit=functionSql(migration,'public.v2_public_submit_registration_request');
  const reservations=tableSql(migration,'platform.registration_request_identity_reservations');
  assert.match(reservations,/identity_type text not null/);
  assert.match(reservations,/identity_hash text not null/);
  assert.doesNotMatch(reservations,/'tvtc'/);
  assert.match(migration,/unique index if not exists[\s\S]*identity_type,identity_hash[\s\S]*where released_at is null/);
  assert.match(submit,/pg_advisory_xact_lock\(hashtextextended/);
  assert.match(submit,/'registration-identity:'\|\|v_identity\.identity_type/);
  assert.match(submit,/for update nowait/);
  assert.match(submit,/exception when lock_not_available then/);
  const identityLock=submit.indexOf("'registration-identity:'||v_identity.identity_type");
  const claimRecheck=submit.indexOf(
    'from platform.registration_identity_claims claim',identityLock
  );
  assert.ok(identityLock!==-1&&claimRecheck>identityLock,
    'authoritative identity claims must be rechecked after serialization');
  assert.match(submit,/count\(distinct reservation\.request_id\)/);
  assert.match(submit,/lower\(v_duplicate\.contact_email\)<>v_contact_email/);
  assert.doesNotMatch(submit,/where\s+lower\(request\.contact_email\)\s*=/i);
  assert.match(submit,/v_identity_conflict:=true/);
  assert.match(submit,/if v_state='new' and v_commercial is not null then/);
  assert.match(submit,/if v_state='new' and v_national is not null then/);
  assert.match(submit,/private_app\.registration_email_enqueue/);
  assert.match(submit,/'confirmationQueued'/);
  assert.match(submit,/'deliveryId'/);
  assert.doesNotMatch(submit,/'_confirmationToken'|'contactEmail'\s*,v_contact_email/);
  const backfill=between(
    migration,
    'insert into platform.registration_request_identity_reservations(',
    'on conflict (identity_type,identity_hash) where released_at is null do nothing;'
  );
  assert.doesNotMatch(backfill,/'tvtc'|regexp_replace\([\s\S]*commercial_registration/);
  assert.match(backfill,/normalized\.commercial ~ '\^\[0-9\]\{10\}\$'/);
  assert.match(backfill,/normalized\.national ~ '\^7\[0-9\]\{9\}\$'/);
  assert.match(backfill,
    /'commercial'::text,case\s+when request\.institution_state='new'/
  );
  assert.match(backfill,
    /'national'::text,case\s+when request\.institution_state='new'/
  );
  assertServiceOnly(migration,'public.v2_public_submit_registration_request(jsonb,text,text)');
});

test('unattested existing-directory input cannot reserve an institution identity',async()=>{
  const migration=await read(MIGRATION);
  const submit=functionSql(migration,'public.v2_public_submit_registration_request');
  const backfill=between(
    migration,
    'insert into platform.registration_request_identity_reservations(',
    'on conflict (identity_type,identity_hash) where released_at is null do nothing;'
  );
  assert.doesNotMatch(submit,
    /array_append\(v_identity_types,'external_account'\)/
  );
  assert.doesNotMatch(submit,/digest\('external_account:'/);
  assert.match(submit,
    /if v_state='new'\s+and coalesce\(array_length\(v_identity_hashes,1\),0\)=0 then/
  );
  assert.doesNotMatch(backfill,/'external_account'::text|digest\(\s*'external_account:'/);
  assert.match(backfill,
    /'commercial'::text,case\s+when request\.institution_state='new'/
  );
  assert.match(backfill,
    /'national'::text,case\s+when request\.institution_state='new'/
  );
});

test('claim contract is exact, DB-sourced, and lease-aware',async()=>{
  const migration=await read(MIGRATION);
  const contract=functionSql(migration,'private_app.registration_email_delivery_contract');
  const keys=[...contract.matchAll(/^    '([A-Za-z][A-Za-z0-9]*)',/gm)]
    .map(match=>match[1]);
  assert.deepEqual(keys,[
    'deliveryId','requestId','generation','keyVersion','tokenNonce',
    'tokenExpiresEpoch','templateVersion','idempotencyKey','attempt','leaseId',
    'state','sendRequired','inFlight','accepted','retryAt','tokenHash',
    'contentFingerprint','recipient','contactName','institutionName','reference'
  ]);
  assert.match(contract,/join platform\.registration_requests request/);
  assert.match(contract,/'recipient',request\.contact_email/);
  assert.match(contract,/'contactName',request\.contact_name/);
  assert.match(contract,/'institutionName',request\.institution_name/);

  const claim=functionSql(migration,'public.v1_registration_email_delivery_claim');
  const requestLock=claim.indexOf('from platform.registration_requests request');
  const deliveryLock=claim.indexOf('from platform.registration_email_deliveries delivery',requestLock);
  assert.ok(requestLock!==-1&&deliveryLock>requestLock,'lock order must be request then delivery');
  assert.match(claim,/for update/);
  assert.match(claim,/lease_expires_at=now\(\)\+interval '60 seconds'/);
  assert.match(claim,/attempt_count=delivery\.attempt_count\+1/);
  assert.match(claim,/registration_email_delivery_attempts/);
  assert.match(claim,/token_expires_at<=now\(\)[\s\S]*state='cancelled'/);
  assertServiceOnly(migration,'public.v1_registration_email_delivery_claim(uuid)');
});

test('kill switch atomically moves due email work into the manual queue',async()=>{
  const migration=await read(MIGRATION);
  const helper=functionSql(
    migration,'private_app.registration_email_fallback_to_manual'
  );
  const claim=functionSql(
    migration,'public.v1_registration_email_delivery_claim'
  );
  assert.match(migration,/'manual_trust_repair','email_fallback_manual'/);
  assert.match(helper,/for update/);
  assert.match(helper,/activation_mode='manual_review'/);
  assert.match(helper,/email_confirmation_token_hash=null/);
  assert.match(helper,/email_confirmation_expires_at=null/);
  assert.match(helper,/version=request\.version\+1/);
  assert.doesNotMatch(helper,/email_confirmed_at\s*=/);
  assert.match(helper,/private_app\.registration_email_cancel_siblings/);
  assert.match(helper,/delivery\.state='accepted'/);
  assert.match(helper,/'email_fallback_manual'/);
  assert.match(helper,/insert into audit_log\.events/);
  assert.match(helper,/p_actor_subject_id is null[\s\S]*registration_email_worker/);
  assert.doesNotMatch(helper,/provision_tenant_core|insert into core\.tenants/);
  assert.match(migration,
    /revoke all on function private_app\.registration_email_fallback_to_manual\([\s\S]*uuid,text,uuid,text[\s\S]*from public,anon,authenticated,service_role/
  );

  const policy=claim.indexOf("coalesce(v_current_mode,'manual_review')<>'email_verified_trial'");
  const fallback=claim.indexOf(
    'private_app.registration_email_fallback_to_manual',policy
  );
  const lease=claim.indexOf("set state='leased'");
  assert.ok(policy!==-1&&fallback>policy&&lease>fallback,
    'kill-switch fallback must commit before a worker can lease/send');
  assert.match(claim,/'automatic_activation_disabled',null/);
  assert.match(claim,/return private_app\.registration_email_delivery_contract/);
});

test('terminal delivery fallback is permissioned, versioned, auditable, and cannot provision',async()=>{
  const migration=await read(MIGRATION);
  const action=functionSql(
    migration,'public.v1_platform_registration_email_move_to_manual'
  );
  assert.match(action,/has_platform_permission\('platform\.tenants\.manage'\)/);
  assert.match(action,/private_app\.current_subject_id\(\)/);
  assert.match(action,/p_expected_version<>v_request\.version/);
  assert.match(action,/order by delivery\.generation desc[\s\S]*for update/);
  assert.match(action,/v_delivery\.state<>'terminal_failed'/);
  assert.match(action,/registration_email_fallback_reason_required/);
  assert.match(action,
    /private_app\.registration_email_fallback_to_manual\([\s\S]*'delivery_terminal_failed',v_actor,v_notes/
  );
  assert.match(action,/'queueStatus','pending_review'/);
  assert.match(action,/'automaticProvisioning',false/);
  assert.doesNotMatch(action,/provision_tenant_core|insert into core\.tenants/);
  const normalized=compact(migration);
  assert.ok(normalized.includes(
    'revokeallonfunctionpublic.v1_platform_registration_email_move_to_manual(uuid,integer,text)frompublic,anon,authenticated,service_role;'
  ));
  assert.ok(normalized.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_email_move_to_manual(uuid,integer,text)toauthenticated;'
  ));
  assert.ok(!normalized.includes(
    'grantexecuteonfunctionpublic.v1_platform_registration_email_move_to_manual(uuid,integer,text)toservice_role;'
  ));
});

test('duplicate submission never re-enqueues after policy switches to manual',async()=>{
  const migration=await read(MIGRATION);
  const submit=functionSql(
    migration,'public.v2_public_submit_registration_request'
  );
  assert.match(submit,/v_policy_mode text/);
  assert.match(submit,
    /into v_policy_mode,v_ttl,v_key_version[\s\S]*v_mode:=case when v_state='new' then coalesce\(v_policy_mode,'manual_review'\)/
  );
  const duplicate=submit.indexOf('if v_duplicate.id is not null then');
  const policy=submit.indexOf(
    "coalesce(v_policy_mode,'manual_review')<>'email_verified_trial'",duplicate
  );
  const fallback=submit.indexOf(
    'private_app.registration_email_fallback_to_manual',policy
  );
  const enqueue=submit.indexOf(
    'private_app.registration_email_enqueue',fallback
  );
  assert.ok(duplicate!==-1&&policy>duplicate&&fallback>policy&&enqueue>fallback,
    'duplicate policy fallback must precede every duplicate enqueue');
  const branch=submit.slice(policy,enqueue);
  assert.match(branch,/'activationMode',v_duplicate\.activation_mode/);
  assert.match(branch,/'confirmationRequired',false/);
  assert.match(branch,/'confirmationQueued',false/);
  assert.match(branch,/'deliveryId',null/);
  assert.match(branch,/'expectedResponse','one_business_day'/);
});

test('due scan returns the deployed top-level array and excludes legacy key zero',async()=>{
  const migration=await read(MIGRATION);
  const due=functionSql(migration,'public.v1_registration_email_delivery_due_ids');
  assert.match(due,/delivery\.state='queued'/);
  assert.match(due,/delivery\.state='retryable' and delivery\.retry_at<=now\(\)/);
  assert.match(due,/delivery\.state='leased' and delivery\.lease_expires_at<=now\(\)/);
  assert.match(due,/delivery\.key_version>=1/);
  assert.match(due,/limit v_limit/);
  assert.match(due,/return v_ids;/);
  assert.doesNotMatch(due,/jsonb_build_object\('deliveryIds'/);
});

test('bind is immutable per generation and preserves every unexpired link alias',async()=>{
  const migration=await read(MIGRATION);
  const bind=functionSql(migration,'public.v1_registration_email_delivery_bind');
  assert.match(bind,/v_delivery\.state<>'leased'/);
  assert.match(bind,/v_delivery\.lease_id is distinct from p_lease_id/);
  assert.match(bind,/v_delivery\.lease_expires_at<=now\(\)/);
  assert.match(bind,/registration_confirmation_token_binding_mismatch/);
  assert.match(bind,/registration_confirmation_content_mismatch/);
  assert.match(bind,/confirmation_token_hash=coalesce/);
  assert.match(bind,/content_fingerprint=coalesce/);
  assert.match(bind,/registration_confirmation_token_aliases/);
  assert.match(bind,/email_confirmation_expires_at>now\(\)/);
  assertServiceOnly(migration,
    'public.v1_registration_email_delivery_bind(uuid,uuid,text,text)'
  );

  const confirm=functionSql(migration,'public.v1_registration_confirm_email_and_provision');
  assert.match(confirm,/registration_confirmation_token_aliases alias/);
  assert.match(confirm,/alias\.consumed_at is null/);
  assert.match(confirm,/alias\.expires_at>now\(\)/);
  assert.match(confirm,/email_confirmation_token_hash=v_hash/);
  assert.match(confirm,/private_app\.registration_email_cancel_siblings/);
  assert.match(migration,/set consumed_at=coalesce\(alias\.consumed_at,now\(\)\)/);
  assert.match(migration,/drop function if exists private_app\.registration_email_rotation_guard\(\)/);
  assert.doesNotMatch(migration,/create or replace function private_app\.registration_email_rotation_guard/);
});

test('confirmation ambiguous-success replay is exact and tenant-bound',async()=>{
  const migration=await read(MIGRATION);
  const confirm=functionSql(
    migration,'public.v1_registration_confirm_email_and_provision'
  );
  assert.match(confirm,
    /where alias\.token_hash=v_hash\s+and alias\.expires_at>now\(\)/
  );
  assert.match(confirm,
    /if v_alias_id is not null then[\s\S]*alias\.id=v_alias_id[\s\S]*alias\.request_id=v_request\.id[\s\S]*alias\.token_hash=v_hash[\s\S]*alias\.expires_at>now\(\)[\s\S]*for update/
  );
  assert.match(confirm,/if v_alias_consumed_at is not null then/);
  assert.match(confirm,
    /metadata->>'confirmedDeliveryId' is distinct from\s+v_confirmed_delivery_id::text/
  );
  assert.match(confirm,
    /tenant\.id=v_request\.provisioned_tenant_id[\s\S]*tenant\.status='active'[\s\S]*settings->>'registrationRequestId'[\s\S]*settings->>'registrationActivationMode'/
  );
  assert.match(confirm,
    /invitation\.id=\(v_request\.metadata->>'ownerInvitationId'\)::uuid/
  );
  assert.match(confirm,/v_owner_status is distinct from 'invited'/);
  assert.match(confirm,/invitation\.tenant_id=v_tenant\.id/);
  assert.match(confirm,/invitation\.role_key='tenant_owner'/);
  assert.match(confirm,/invitation\.email=lower\(v_request\.contact_email\)/);
  assert.match(confirm,
    /v_invitation\.status='pending'[\s\S]*set token_hash=encode\([\s\S]*expires_at=now\(\)\+interval '7 days'/
  );
  assert.match(confirm,/confirmation_response_replay/);
  assert.match(confirm,
    /v_invitation\.status='accepted'[\s\S]*v_owner_status:='linked'/
  );
  assert.match(confirm,/'replayed',true/);
  assert.match(confirm,
    /'ownerProvisioningStatus',v_provisioning#>>'\{owner,status\}'/
  );
  assert.match(confirm,
    /'ownerInvitationId',v_provisioning#>>'\{owner,invitationId\}'/
  );
});

test('finish is crash-safe and accepted evidence wins stale failures',async()=>{
  const migration=await read(MIGRATION);
  const delivery=tableSql(migration,'platform.registration_email_deliveries');
  const attempts=tableSql(migration,'platform.registration_email_delivery_attempts');
  const finish=functionSql(migration,'public.v1_registration_email_delivery_finish');
  assert.match(delivery,/idempotency_key text not null unique/);
  assert.match(attempts,/lease_id uuid not null unique/);
  assert.match(finish,/v_delivery\.state='leased'[\s\S]*v_delivery\.lease_id=p_lease_id/);
  assert.match(finish,/if v_attempt\.outcome is null or p_outcome='accepted'/);
  assert.match(finish,/if v_delivery\.state='accepted' then[\s\S]*'accepted',true/);
  const accept=finish.indexOf("if p_outcome='accepted' then",finish.indexOf("if v_delivery.state='accepted'"));
  const stale=finish.indexOf('elsif not v_is_current_lease then');
  assert.ok(accept!==-1&&stale>accept,'accepted must precede stale-failure rejection');
  assert.match(finish,/registration_confirmation_delivery_unbound/);
  assert.match(finish,/state='accepted'/);
  assert.match(finish,/least\(3600,15\*\(2\^least/);
  assert.match(finish,/state='retryable'/);
  assert.match(finish,/state='terminal_failed'/);
  assert.match(finish,/exception when others then[\s\S]*v_marked:=false/);
  assertServiceOnly(migration,
    'public.v1_registration_email_delivery_finish(uuid,uuid,text,text,integer,text,integer)'
  );
});

test('webhooks are idempotent, out-of-order monotonic, and Edge-compatible',async()=>{
  const migration=await read(MIGRATION);
  const events=tableSql(migration,'platform.registration_email_webhook_events');
  assert.match(events,/unique \(provider,provider_event_id\)/);
  assert.match(events,/payload_hash text not null/);
  assert.doesNotMatch(events,/raw_payload|payload json|recipient|contact_email|headers json/i);

  const event=functionSql(migration,'public.v1_registration_email_webhook_event');
  assert.match(event,/on conflict \(provider,provider_event_id\) do nothing/);
  assert.match(event,/registration_email_webhook_replay_mismatch/);
  assert.match(event,/private_app\.registration_email_apply_webhooks/);
  const alias=functionSql(migration,'public.v1_registration_email_delivery_record_event');
  for(const type of [
    'email.sent','email.delivery_delayed','email.delivered','email.bounced',
    'email.suppressed','email.failed','email.complained'
  ])assert.ok(alias.includes(`when '${type}'`),`missing Resend mapping: ${type}`);
  assert.match(alias,/extensions\.digest/);
  assert.doesNotMatch(alias,/rawBody|raw_payload|recipient/);

  const apply=functionSql(migration,'private_app.registration_email_apply_webhooks');
  const precedence=['complained','suppressed','bounced','delivered','failed','delayed','sent'];
  let previous=-1;
  for(const state of precedence){
    const position=apply.indexOf(`v_state='${state}'`);
    assert.ok(position>previous,`provider state precedence broken at ${state}`);
    previous=position;
  }
  assert.match(apply,/from platform\.registration_email_webhook_events event/);
  assert.match(apply,/least\(delivery\.delivered_at,v_delivered_at\)/);
  assertServiceOnly(migration,
    'public.v1_registration_email_delivery_record_event(text,text,text,timestamptz)'
  );
});

test('Supabase Cron uses Vault credentials without embedding or returning them',async()=>{
  const migration=await read(MIGRATION);
  const configure=functionSql(migration,'public.v1_registration_email_worker_configure');
  assert.ok(configure.includes(
    "'^https://[a-z0-9]{20}\\.supabase\\.co/functions/v1/odeir-registration-intake$'"
  ));
  assert.match(configure,/vault\.create_secret/);
  assert.match(configure,/vault\.update_secret/);
  assert.match(configure,
    /to_regprocedure\(\s*'vault\.create_secret\(text,text,text,uuid\)'\s*\)/
  );
  assert.match(configure,
    /to_regprocedure\(\s*'vault\.update_secret\(uuid,text,text,text,uuid\)'\s*\)/
  );
  assert.doesNotMatch(configure,
    /to_regprocedure\(\s*'vault\.create_secret\(text,text,text\)'\s*\)/
  );
  assert.match(configure,/vault\.decrypted_secrets/);
  assert.match(configure,/cron\.schedule\([\s\S]*'\* \* \* \* \*'/);
  assert.match(configure,/net\.http_post/);
  assert.match(configure,/'x-odeir-worker-token'/);
  assert.match(configure,/jsonb_build_object\('action','drain'\)/);
  const returned=configure.slice(configure.lastIndexOf('return jsonb_build_object'));
  assert.doesNotMatch(returned,/workerToken|publishableKey|decrypted_secret/i);

  const authorize=functionSql(migration,'public.v1_registration_email_worker_authorize');
  assert.match(authorize,/p_token_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(authorize,/worker_token_hash=p_token_hash/);
  assertServiceOnly(migration,'public.v1_registration_email_worker_authorize(text)');
  assertServiceOnly(migration,'public.v1_registration_email_worker_enable_extensions()');
});

test('health, heartbeat, and admin diagnostics expose actionable safe state',async()=>{
  const migration=await read(MIGRATION);
  const health=functionSql(migration,'public.v1_registration_email_delivery_health');
  for(const field of [
    'outboxReady','queued','retryable','leasedStale','legacyUnrecoverable',
    'terminalFailed',
    'acceptedLast24h','deliveredLast24h','activeKeyVersion',
    'pendingKeyVersions','configured','configuredAt','workerHeartbeatAt',
    'workerHealthy'
  ])assert.ok(health.includes(`'${field}'`),`missing health field: ${field}`);
  assert.match(health,/jsonb_agg\(distinct delivery\.key_version order by delivery\.key_version\)/);
  assert.match(health,/delivery\.state in \('queued','leased','retryable'\)/);
  assert.match(health,/delivery\.token_expires_at>now\(\)/);
  assert.match(health,
    /delivery\.key_version=0[\s\S]*delivery\.state in \('queued','leased','retryable'\)/
  );
  assert.match(health,
    /'outboxReady',[\s\S]*coalesce\(v_legacy_unrecoverable,0\)=0/
  );
  assertServiceOnly(migration,'public.v1_registration_email_delivery_health()');
  assertServiceOnly(migration,
    'public.v1_registration_email_delivery_worker_heartbeat(integer,integer)'
  );

  const diagnostic=functionSql(migration,'public.v1_platform_registration_email_delivery_status');
  assert.match(diagnostic,/private_app\.has_platform_permission\('platform\.tenants\.manage'\)/);
  for(const field of [
    'state','deliveryState','attemptCount','nextAttemptAt','lastErrorCode',
    'acceptedAt','deliveredAt','bouncedAt','complainedAt'
  ])assert.ok(diagnostic.includes(`'${field}'`),`missing diagnostic field: ${field}`);
  assert.doesNotMatch(diagnostic,
    /recipient|contact_email|confirmation_token|token_hash|token_nonce|\bbody\b|\burl\b/i
  );
});

test('key rotation reports every secret still required by pending generations',async()=>{
  const migration=await read(MIGRATION);
  const health=functionSql(migration,'public.v1_registration_email_delivery_health');
  const enqueue=functionSql(migration,'private_app.registration_email_enqueue');
  const claim=functionSql(migration,'private_app.registration_email_delivery_contract');
  assert.match(enqueue,/p_key_version/);
  assert.match(enqueue,/p_request_id,'confirmation',v_generation,p_key_version/);
  assert.match(claim,/'keyVersion',delivery\.key_version/);
  assert.match(health,/'activeKeyVersion',v_active_key_version/);
  assert.match(health,/'pendingKeyVersions',v_pending_key_versions/);
  const activeKeyVersion=2;
  const pendingKeyVersions=[1,2];
  const configuredSecrets=new Set([2]);
  const required=new Set([activeKeyVersion,...pendingKeyVersions]);
  assert.equal(
    [...required].every(version=>configuredSecrets.has(version)),false,
    'queued V1 plus current V2 must remain not-ready until both V1 and V2 secrets exist'
  );
  configuredSecrets.add(1);
  assert.equal([...required].every(version=>configuredSecrets.has(version)),true);
});

test('rollout compatibility is explicit and v2 transition RPCs stay service-only',async()=>{
  const migration=await read(MIGRATION);
  const marker=functionSql(migration,'public.v1_registration_mark_confirmation_sent');
  assert.match(marker,/v_accepted_alias/);
  assert.match(marker,/v_legacy_current/);
  assert.match(marker,/delivery\.state='accepted'/);
  assert.match(migration,/After that rollout, remove the `v_legacy_current` branch/);
  for(const signature of [
    'public.v1_registration_email_delivery_due_ids(integer)',
    'public.v1_registration_email_delivery_claim(uuid)',
    'public.v1_registration_email_webhook_event(text,text,text,timestamptz,text)'
  ])assertServiceOnly(migration,signature);
});
