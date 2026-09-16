import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

export const id = n => `61000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const T = '3d185482-b916-49cc-b868-b6dfdb93eba8';
export const OTHER = id(2), ADMIN = id(3), ADMIN_AUTH = id(4), STAFF = id(5),
  INSTRUCTOR = id(6), INSTRUCTOR_AUTH = id(7), LEARNER = id(8), LEARNER_AUTH = id(9),
  CONTACT = id(10), COURSE = id(11), RUN = id(12), HANDOFF = id(13), STUDENT = id(14),
  ENROLLMENT = id(15), ACCOUNT = id(16), INVOICE = id(17), PAYMENT = id(18), FOREIGN_COURSE = id(19);
export const read = path => readFile(new URL(path, import.meta.url), 'utf8');
export const call = async (db, name, args = {}) => {
  const entries = Object.entries(args);
  return (await db.query(`select ${name}(${entries.map(([key], i) => `${key}=>$${i + 1}`).join(',')}) result`,
    entries.map(([, value]) => value && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result;
};
export const login = (db, authId = ADMIN_AUTH) => db.query("select set_config('fixture.auth_user_id',$1,false)", [authId || '']);
export const count = async (db, table) => (await db.query(`select count(*)::int n from ${table}`)).rows[0].n;

export async function setup({ learning = false, database = null } = {}) {
  const db = database ?? new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(await read('./training-journey-live-schema.sql'));
    await db.exec(`create function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('role',coalesce(nullif(current_setting('fixture.jwt_role',true),''),'authenticated')) $$;`);
    await db.exec('create extension pgcrypto with schema extensions;');
    await db.exec(await read('./training-journey-live-functions.sql'));
    // External entitlement and WooCommerce seams: no subscription or connector
    // side effects are modeled. Every permission check uses the real ACL above.
    await db.exec(`create function private_app.tenant_addon_enabled(t uuid, p text) returns boolean language sql stable as $$
      select p='addon.training.lms' and t='${T}'::uuid and coalesce(current_setting('fixture.addon',true),'yes')='yes' $$;
      create schema commerce_sync;
      create table commerce_sync.connections(id uuid primary key,tenant_id uuid);
      create table sales_core.commerce_order_work_items(id uuid primary key,tenant_id uuid,connection_id uuid);
      create table sales_core.commerce_admission_lines(id uuid primary key,tenant_id uuid,work_item_id uuid,handoff_id uuid);
    `);
    await db.exec(await read('../../supabase/migrations/20260916165552_training_journey_financial_operations.sql'));
    if (learning) await db.exec(await read('../../supabase/migrations/20260916165601_training_learning_v1.sql'));
    await db.query("insert into core.organizations(id,organization_key,legal_name,display_name) values($1,'fixture-org','Fixture organization','Fixture organization')", [id(20)]);
    await db.query("insert into core.tenants(id,organization_id,tenant_key,slug,name,status) values($1,$3,'marktone','marktone','Marktone fixture','active'),($2,$3,'foreign','foreign','Foreign fixture','active')", [T, OTHER, id(20)]);
    await db.query("insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'instructor@example.test',now()),($3,'learner@example.test',now())", [ADMIN_AUTH, INSTRUCTOR_AUTH, LEARNER_AUTH]);
    await db.query("insert into access_control.subjects(id,auth_user_id,email,full_name) values($1,$2,'admin@example.test','Fixture manager'),($3,$4,'instructor@example.test','Fixture instructor')", [ADMIN, ADMIN_AUTH, INSTRUCTOR, INSTRUCTOR_AUTH]);
    await db.query("insert into access_control.roles(id,tenant_id,role_key,name_ar,scope) values($1,$3,'tenant_owner','Owner','tenant'),($2,$3,'instructor','Instructor','tenant')", [id(21), id(22), T]);
    await db.query("insert into access_control.memberships(id,subject_id,tenant_id,scope) values($1,$3,$5,'tenant'),($2,$4,$5,'tenant')", [id(23), id(24), ADMIN, INSTRUCTOR, T]);
    await db.query('insert into access_control.membership_roles(membership_id,role_id) values($1,$3),($2,$4)', [id(23), id(24), id(21), id(22)]);
    const permissions = ['tenant.academy.read','tenant.academy.write','tenant.training.read','tenant.training.write','tenant.admissions.read','tenant.admissions.write','tenant.admissions.payment.verify','tenant.accounting.read','tenant.accounting.write','tenant.accounting.payments.approve','tenant.accounting.payments.write','tenant.accounting.credit.approve','tenant.accounting.refunds.approve','tenant.team.write','tenant.settings.manage','tenant.work.read','tenant.work.write'];
    for (const p of permissions) {
      await db.query('insert into access_control.permissions(permission_key,module_key,name_ar) values($1,$2,$1) on conflict(permission_key) do nothing', [p, p.split('.')[1]]);
      await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing', [id(21), p]);
    }
    for (const p of ['tenant.training.read','tenant.training.write']) await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2)', [id(22), p]);
    await db.query("insert into people.staff_profiles(id,tenant_id,membership_id,full_name,job_title,role_key) values($1,$2,$3,'Fixture manager','Manager','tenant_owner')", [STAFF, T, id(23)]);
    await login(db);
    await db.query("insert into academy.courses(id,tenant_id,course_code,title_ar,category) values($1,$3,'COURSE-1','Fixture course','Training'),($2,$4,'COURSE-2','Foreign course','Training')", [COURSE, FOREIGN_COURSE, T, OTHER]);
    await db.query("insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity) values($1,$2,$3,'RUN-1','Fixture cohort','hybrid','open',2)", [RUN, T, COURSE]);
    await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,email) values($1,$2,'Fixture learner','0501112233','learner@example.test')", [CONTACT, T]);
    await db.query("insert into sales_core.pipeline_stages(tenant_id,stage_key,name_ar,is_won,is_closed) values($1,'won','Won',true,true)",[T]);
    await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor) values($1,$2,'HANDOFF-1',$3,$4,10000)", [HANDOFF, T, CONTACT, COURSE]);
    await db.query("insert into academy.students(id,tenant_id,student_key,student_number,contact_id,full_name,email) values($1,$2,'STUDENT-1','S-1',$3,'Fixture learner','learner@example.test')", [STUDENT, T, CONTACT]);
    await db.query("insert into accounting_core.customer_accounts(id,tenant_id,contact_id,account_number,display_name) values($1,$2,$3,'ACC-1','Fixture learner')", [ACCOUNT, T, CONTACT]);
    await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,contact_id,customer_name_snapshot,subtotal_minor,total_minor,issue_date) values($1,$2,'invoice','INV-1','issued',$3,$4,'Fixture learner',10000,10000,'2026-01-01')", [INVOICE, T, ACCOUNT, CONTACT]);
    return db;
  } catch (error) {
    await db.close();
    // The SQL source is already in version control; do not dump full migrations
    // into test logs when Postgres reports an error.
    delete error.query;
    throw error;
  }
}

export async function seedEnrollment(db) {
  await db.query("update academy.registration_handoffs set payment_status='verified',payment_verified_at=now(),payment_verified_by_subject_id=$1 where id=$2", [ADMIN,HANDOFF]);
  await db.query("insert into academy.enrollments(id,tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id) values($1,$2,'ENROLLMENT-1',$3,$4,$5,$6)", [ENROLLMENT,T,HANDOFF,STUDENT,COURSE,RUN]);
  await db.query("update academy.registration_handoffs set status='completed',completed_at=now(),completed_by_subject_id=$1 where id=$2",[ADMIN,HANDOFF]);
}

export async function seedPayment(db, amount = 10000, status = 'verified') {
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,payment_number,amount_minor,status,verified_at,verified_by_subject_id) values($1,$2,$3,'PAY-1',$4,$5,now(),$6)", [PAYMENT,T,ACCOUNT,amount,status,ADMIN]);
  await db.query('insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor) values($1,$2,$3,$4)', [T,PAYMENT,INVOICE,amount]);
}
