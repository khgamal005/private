import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { setup, call, id, seedPayment, T, COURSE, RUN, HANDOFF, INVOICE } from './fixtures/training-journey-database.mjs';

const migrationPrefix = '-- Marktone training journey: additive, disabled by default, no data backfill.';
const helper = 'private_app.update_admission_before_commerce_v1(text,uuid,text,uuid,uuid,text,text)';
const definition = async db => (await db.query('select pg_get_functiondef($1::regprocedure) definition', [helper])).rows[0].definition;
const action = (db, name, payload, command) => call(db, 'public.v1_tenant_training_journey_action', {
  p_slug: 'marktone', p_action: name, p_payload: { ...payload, commandId: id(command) },
});

async function completeAdmission(db) {
  await action(db, 'set_enabled', { enabled: true }, 25000);
  await action(db, 'configure_finance', { handoffId: HANDOFF, invoiceId: INVOICE, policy: 'full' }, 25001);
  await seedPayment(db);
  await action(db, 'verify_payment', { handoffId: HANDOFF }, 25002);
  const result = await action(db, 'confirm_admission', { handoffId: HANDOFF, courseRunId: RUN }, 25003);
  assert.ok(result.enrollmentId);
  assert.equal((await db.query('select status from academy.registration_handoffs where id=$1', [HANDOFF])).rows[0].status, 'completed');
  assert.equal((await db.query('select count(*)::int n from academy.enrollments where handoff_id=$1', [HANDOFF])).rows[0].n, 1);
  return result.enrollmentId;
}

test('release keeps the production enrollment conflict contract and completes canonical admission', async t => {
  const db = await setup();
  t.after(() => db.close());
  assert.match(await definition(db), /on conflict \(handoff_id\) do update/);
  assert.equal((await db.query("select count(*)::int n from pg_attribute where attrelid='academy.enrollments'::regclass and attname='commerce_seat_id' and not attisdropped")).rows[0].n, 0);
  await completeAdmission(db);
});

test('the canonical LMS feature entitlement gates operations; its product key is not an entitlement', async t => {
  const db = await setup();
  t.after(() => db.close());
  const entitled = async key => (await db.query('select private_app.tenant_addon_enabled($1,$2) enabled', [T, key])).rows[0].enabled;
  const snapshot = () => call(db, 'public.v1_tenant_training_journey_snapshot', { p_slug: 'marktone' });
  const navigation = () => call(db, 'public.v1_training_journey_navigation', { p_slug: 'marktone' });
  assert.equal(await entitled('lms'), false);
  assert.equal(await entitled('addon.training.lms'), true);
  await action(db, 'set_enabled', { enabled: true }, 25400);
  assert.equal((await snapshot()).enabled, true);
  assert.deepEqual(await navigation(), { enabled: true });

  await db.query("select set_config('fixture.addon','no',false)");
  assert.equal(await entitled('addon.training.lms'), false);
  await assert.rejects(snapshot(), /training_addon_required/);
  await assert.rejects(action(db, 'configure_finance', { handoffId: HANDOFF, invoiceId: INVOICE, policy: 'full' }, 25401), /training_addon_required/);
  assert.deepEqual(await navigation(), { enabled: false });
});

test('release preserves beneficiary partial uniqueness and executes ordinary admission on staging schema', async t => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const execute = db.exec.bind(db);
  let insertedVariant = false;
  db.exec = async (sql, ...args) => {
    if (sql.startsWith(migrationPrefix)) {
      // This is the existing staging schema difference, installed before the
      // unmodified full migration, rather than a rewritten migration fixture.
      await execute(`alter table academy.enrollments add column commerce_seat_id uuid;
        alter table academy.enrollments drop constraint enrollments_handoff_id_key;
        create unique index enrollments_ordinary_handoff_uidx on academy.enrollments(handoff_id) where commerce_seat_id is null;
        create unique index enrollments_commerce_seat_uidx on academy.enrollments(commerce_seat_id) where commerce_seat_id is not null;`);
      insertedVariant = true;
    }
    return execute(sql, ...args);
  };
  await setup({ database: db });
  t.after(() => db.close());
  assert.equal(insertedVariant, true);
  assert.match(await definition(db), /on conflict \(handoff_id\) where commerce_seat_id is null do update/);
  await completeAdmission(db);

  // Ordinary admission must not restore global uniqueness and break multiple
  // company beneficiaries sharing the same original paid handoff.
  await db.query('update academy.course_runs set capacity=10 where id=$1', [RUN]);
  for (let seat = 1; seat <= 2; seat += 1) {
    const contact = id(25100 + seat), student = id(25200 + seat);
    await db.query('insert into sales_core.contacts(id,tenant_id,full_name) values($1,$2,$3)', [contact, T, `Staging beneficiary ${seat}`]);
    await db.query('insert into academy.students(id,tenant_id,student_key,student_number,contact_id,full_name) values($1,$2,$3,$3,$4,$5)', [student, T, `BENEFICIARY-${seat}`, contact, `Staging beneficiary ${seat}`]);
    await db.query('insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,commerce_seat_id) values($1,$2,$3,$4,$5,$6,$7)', [T, `BENEFICIARY-${seat}`, HANDOFF, student, COURSE, RUN, id(25300 + seat)]);
  }
  assert.deepEqual((await db.query('select count(*) filter(where commerce_seat_id is null)::int ordinary,count(*) filter(where commerce_seat_id is not null)::int beneficiaries from academy.enrollments where handoff_id=$1', [HANDOFF])).rows[0], { ordinary: 1, beneficiaries: 2 });
  const indexNames = (await db.query("select indexrelid::regclass::text name from pg_index where indrelid='academy.enrollments'::regclass and indisunique")).rows.map(row => row.name);
  assert.ok(indexNames.includes('academy.enrollments_ordinary_handoff_uidx'));
  assert.ok(indexNames.includes('academy.enrollments_commerce_seat_uidx'));
  assert.ok(!indexNames.includes('academy.enrollments_handoff_id_key'));
});
