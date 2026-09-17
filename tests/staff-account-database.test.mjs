import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const migration='../supabase/migrations/20260917194438_staff_account_activation_v1.sql';
async function fixture(t){
  const db=new PGlite({extensions:{pgcrypto}});t.after(()=>db.close());
  await db.exec(await read('./fixtures/staff-access-schema.sql'));
  await db.exec(await read('./fixtures/staff-access-live-functions.sql'));
  await db.exec(await read(migration));
  await db.exec(`create trigger memberships_plan_limit_v4 before insert or update of tenant_id,scope,status on access_control.memberships for each row execute function private_app.enforce_membership_plan_limit_v4();
  create trigger membership_roles_sync_staff after insert on access_control.membership_roles for each row execute function private_app.sync_staff_membership();
  insert into core.tenants(id,slug,name) values('${uid(1)}','existing','Existing'),('${uid(2)}','new-tenant','New');
  insert into auth.users(id,email,email_confirmed_at,encrypted_password) values('${uid(10)}','owner@example.test',now(),'owner-hash');
  insert into access_control.subjects(id,auth_user_id,email,full_name) values('${uid(11)}','${uid(10)}','owner@example.test','Owner');
  insert into access_control.roles(id,scope,role_key,name_ar) values('${uid(12)}','tenant','tenant_owner','Owner'),('${uid(13)}','tenant','sales_user','Sales');
  insert into access_control.role_permissions select '${uid(12)}',x from unnest(array['tenant.people.manage','tenant.users.manage','tenant.users.reset_password']) x;
  insert into access_control.memberships(id,subject_id,tenant_id,scope) values('${uid(14)}','${uid(11)}','${uid(1)}','tenant');
  insert into access_control.membership_roles values('${uid(14)}','${uid(12)}');
  insert into people.staff_profiles(id,tenant_id,full_name,email,role_key) values('${uid(20)}','${uid(1)}','Staff','staff@example.test','sales_user'),('${uid(21)}','${uid(2)}','Other','other@example.test','sales_user');`);
  await login(db,10,'owner@example.test');
  return db;
}
async function login(db,id,email){await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:uid(id),email,role:'authenticated'})]);}
async function rpc(db,name,args){return (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;}
async function prepare(db,slug='existing',staff=20){return rpc(db,'v1_tenant_prepare_staff_account',[slug,uid(staff)]);}
async function createAuth(db,op){await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password,raw_app_meta_data) values($1,$2,now(),$3,$4)',[uid(30),op.email,'temporary-hash',JSON.stringify({staff_activation_id:op.operationId})]);}
async function complete(db,op){return rpc(db,'v1_tenant_complete_staff_account',['existing',uid(20),op.operationId]);}

test('new account links one membership, forces password change, and retries are idempotent',async t=>{
  const db=await fixture(t),op=await prepare(db);
  await createAuth(db,op);
  const resumed=await prepare(db);assert.equal(resumed.operationId,op.operationId);assert.equal(resumed.authUserExists,true);
  assert.equal((await complete(db,op)).mustChangePassword,true);
  assert.equal((await complete(db,op)).completed,true);
  assert.equal((await prepare(db)).completed,true);
  assert.equal((await db.query("select count(*)::int n from access_control.memberships where tenant_id=$1",[uid(1)])).rows[0].n,2);
  await login(db,30,op.email);
  assert.equal((await db.query('select private_app.has_tenant_permission($1,$2) allowed',[uid(1),'tenant.people.manage'])).rows[0].allowed,false);
  await assert.rejects(rpc(db,'v2_mark_password_changed',[]),/password_change_required/);
  await db.query('update auth.users set encrypted_password=$1 where id=$2',['personal-hash',uid(30)]);
  assert.equal(await rpc(db,'v2_mark_password_changed',[]),true);
  assert.equal((await db.query('select must_change_password from access_control.subjects where auth_user_id=$1',[uid(30)])).rows[0].must_change_password,false);
});

test('unauthorized and cross-tenant staff activation fail before creating operations',async t=>{
 const db=await fixture(t);
 await assert.rejects(prepare(db,'existing',21),/staff_not_found/);
 await assert.rejects(prepare(db,'new-tenant',21),/forbidden/);
 await db.query("select set_config('request.jwt.claims','{}',false)");
 await assert.rejects(prepare(db),/authentication_required/);
 assert.equal((await db.query('select count(*)::int n from access_control.staff_account_activations')).rows[0].n,0);
});

test('same privilege, suspended staff and existing global accounts cannot be provisioned',async t=>{
 const db=await fixture(t);
 await db.query("update people.staff_profiles set role_key='tenant_owner' where id=$1",[uid(20)]);
 await assert.rejects(prepare(db),/protected_staff_account/);
 await db.query("update people.staff_profiles set role_key='sales_user',account_status='suspended' where id=$1",[uid(20)]);
 await assert.rejects(prepare(db),/staff_account_suspended/);
 await db.query("update people.staff_profiles set account_status='invited' where id=$1",[uid(20)]);
 await db.query("insert into auth.users(email) values('staff@example.test')");
 await assert.rejects(prepare(db),/account_already_exists/);
});

test('capacity is checked before Auth and again if the last seat is consumed during creation',async t=>{
 const db=await fixture(t);
 await db.query('update core.tenants set staff_limit=1 where id=$1',[uid(1)]);
 await assert.rejects(prepare(db),/plan_limit_reached/);
 await db.query('update core.tenants set staff_limit=2 where id=$1',[uid(1)]);
 const op=await prepare(db);await createAuth(db,op);
 await db.query('update core.tenants set staff_limit=1 where id=$1',[uid(1)]);
 await assert.rejects(complete(db,op),/plan_limit_reached/);
 assert.equal((await db.query("select count(*)::int n from access_control.subjects where auth_user_id=$1",[uid(30)])).rows[0].n,0);
 await db.query('update core.tenants set staff_limit=2 where id=$1',[uid(1)]);
 assert.equal((await complete(db,op)).completed,true);
});

test('completion rechecks permission and immutable identity instead of trusting earlier approval',async t=>{
 const db=await fixture(t),op=await prepare(db);await createAuth(db,op);
 await db.query("update people.staff_profiles set role_key='tenant_owner' where id=$1",[uid(20)]);
 await assert.rejects(complete(db,op),/protected_staff_account/);
 await db.query("update people.staff_profiles set role_key='sales_supervisor' where id=$1",[uid(20)]);
 await assert.rejects(complete(db,op),/activation_staff_changed/);
 await db.query("update people.staff_profiles set role_key='sales_user' where id=$1",[uid(20)]);
 await db.query("delete from access_control.role_permissions where permission_key='tenant.users.manage'");
 await assert.rejects(complete(db,op),/forbidden/);
});

test('new tenants automatically use the same account flow without per-tenant configuration',async t=>{
 const db=await fixture(t);
 await db.query("insert into access_control.memberships(id,subject_id,tenant_id,scope) values($1,$2,$3,'tenant')",[uid(40),uid(11),uid(2)]);
 await db.query('insert into access_control.membership_roles values($1,$2)',[uid(40),uid(12)]);
 const op=await prepare(db,'new-tenant',21);await createAuth(db,op);
 assert.equal((await rpc(db,'v1_tenant_complete_staff_account',['new-tenant',uid(21),op.operationId])).completed,true);
 const membership=(await db.query('select tenant_id from access_control.memberships where subject_id=(select id from access_control.subjects where auth_user_id=$1)',[uid(30)])).rows;
 assert.deepEqual(membership,[{tenant_id:uid(2)}]);
});

test('invitation preflight explains a full plan and valid invitation resumes after capacity is available',async t=>{
 const db=await fixture(t),token='valid-invitation-token-32-chars-long';
 await db.query("insert into access_control.tenant_invitations(tenant_id,full_name,email,role_key,token_hash) values($1,'Staff','staff@example.test','sales_user',encode(extensions.digest($2,'sha256'),'hex'))",[uid(1),token]);
 await db.query('update core.tenants set staff_limit=1 where id=$1',[uid(1)]);
 assert.equal((await rpc(db,'v2_invitation_preview',[token])).email,'staff@example.test');
 await assert.rejects(rpc(db,'v1_invitation_activation_preflight',[token]),/plan_limit_reached/);
 await assert.rejects(rpc(db,'v1_invitation_activation_preflight',['invalid-token-00000000000000000000']),/invalid_invitation/);
 await db.query('update core.tenants set staff_limit=2 where id=$1',[uid(1)]);
 assert.equal((await rpc(db,'v1_invitation_activation_preflight',[token])).email,'staff@example.test');
 await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'staff@example.test',now())",[uid(30)]);
 await login(db,30,'staff@example.test');
 assert.equal((await rpc(db,'v2_accept_tenant_invitation',[token])).status,'accepted');
 await assert.rejects(rpc(db,'v2_accept_tenant_invitation',[token]),/invalid_invitation/);
});

test('shared identity password reset is blocked even for the platform path',async t=>{
 const db=await fixture(t),op=await prepare(db);await createAuth(db,op);await complete(db,op);
 const subject=(await db.query('select id from access_control.subjects where auth_user_id=$1',[uid(30)])).rows[0].id;
 await db.query("insert into access_control.memberships(subject_id,tenant_id,scope) values($1,$2,'tenant')",[subject,uid(2)]);
 await assert.rejects(rpc(db,'v2_tenant_prepare_staff_password_reset',['existing',uid(20)]),/shared_staff_account/);
});

test('activation operations have RLS and cannot be read or written directly by API users',async t=>{
 const db=await fixture(t);
 await db.exec('grant usage on schema access_control to authenticated; set role authenticated;');
 await assert.rejects(db.query('select * from access_control.staff_account_activations'),/permission denied/);
 await assert.rejects(db.query('insert into access_control.staff_account_activations default values'),/permission denied/);
 await db.exec('reset role');
});

test('forged Auth metadata cannot complete an operation and another tenant is unchanged',async t=>{
 const db=await fixture(t),op=await prepare(db);
 await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data) values($1,$2,now(),'{}')",[uid(30),op.email]);
 await assert.rejects(complete(db,op),/activation_incomplete/);
 assert.equal((await db.query("select count(*)::int n from access_control.memberships where tenant_id=$1",[uid(2)])).rows[0].n,0);
 await db.query('update auth.users set raw_app_meta_data=$1 where id=$2',[JSON.stringify({staff_activation_id:op.operationId}),uid(30)]);
 assert.equal((await complete(db,op)).completed,true);
});

test('two prepared operations competing for one seat cannot exceed the capacity',async t=>{
 const db=await fixture(t);
 await db.query('update core.tenants set staff_limit=2 where id=$1',[uid(1)]);
 await db.query("insert into people.staff_profiles(id,tenant_id,full_name,email,role_key) values($1,$2,'Second','second@example.test','sales_user')",[uid(22),uid(1)]);
 const first=await prepare(db),second=await prepare(db,'existing',22);
 await createAuth(db,first);
 await db.query('insert into auth.users(id,email,email_confirmed_at,encrypted_password,raw_app_meta_data) values($1,$2,now(),$3,$4)',[uid(31),second.email,'hash-second',JSON.stringify({staff_activation_id:second.operationId})]);
 await complete(db,first);
 await assert.rejects(rpc(db,'v1_tenant_complete_staff_account',['existing',uid(22),second.operationId]),/plan_limit_reached/);
 assert.equal((await db.query('select private_app.tenant_plan_usage_count($1,$2)::int n',[uid(1),'max_employees'])).rows[0].n,2);
});
