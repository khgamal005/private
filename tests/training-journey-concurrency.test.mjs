import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { setup, call, login, id, T, ADMIN, ADMIN_AUTH, HANDOFF, ACCOUNT,
  INVOICE, PAYMENT, CONTACT, COURSE, RUN } from './fixtures/training-journey-database.mjs';

const databaseUrl = process.env.TRAINING_TEST_DATABASE_URL;

// Never infer a database URL from app configuration. An explicitly named,
// disposable loopback database is the only accepted concurrency environment.
function localTestUrl(value) {
  const parsed = new URL(value);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol), 'PostgreSQL URL required');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'Only loopback test databases are permitted');
  assert.equal(parsed.pathname, '/training_concurrency', 'Dedicated training_concurrency database required');
  assert.equal(parsed.search, '', 'Connection URL overrides are not permitted');
  assert.equal(parsed.hash, '', 'Connection URL fragments are not permitted');
  return parsed.toString();
}

// Poll actual lock state instead of sleeping or assuming the calls overlapped.
// Both backends must be blocked through this controller before it releases them.
async function blockedBarrier(controller, workerPids, controllerPid) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    await controller.query('select pg_stat_clear_snapshot()');
    const { rows } = await controller.query(`select pid, wait_event_type,
      pg_blocking_pids(pid) blockers from pg_stat_activity where pid=any($1::int[])`, [workerPids]);
    const byPid = new Map(rows.map(row => [row.pid, row]));
    const reachesController = (pid, seen = new Set()) => {
      if (pid === controllerPid) return true;
      if (seen.has(pid)) return false;
      seen.add(pid);
      return (byPid.get(pid)?.blockers ?? []).some(blocker => reachesController(blocker, seen));
    };
    if (workerPids.every(pid => byPid.get(pid)?.wait_event_type === 'Lock' && reachesController(pid))) return;
    await yieldTurn();
  }
  throw new Error('Both concurrent transactions did not reach the controlled lock barrier');
}

async function transaction(client, operation) {
  try {
    await client.query('begin');
    const value = await operation(client);
    await client.query('commit');
    return { ok: true, value };
  } catch (error) {
    await client.query('rollback');
    return { ok: false, error: { code: error.code, message: error.message } };
  }
}

async function race(controller, workers, lock, operations) {
  await controller.query('begin');
  let pending;
  try {
    await lock(controller);
    const controllerPid = (await controller.query('select pg_backend_pid() pid')).rows[0].pid;
    const pids = await Promise.all(workers.map(async client => (await client.query('select pg_backend_pid() pid')).rows[0].pid));
    pending = workers.map((client, index) => transaction(client, operations[index]));
    await blockedBarrier(controller, pids, controllerPid);
    await controller.query('commit');
    return await Promise.all(pending);
  } finally {
    // Releases a barrier even if the overlap assertion failed. Workers have
    // independent statement/lock timeouts and always roll back on failure.
    await controller.query('rollback');
    if (pending) await Promise.all(pending);
  }
}

const financialAction = (db, action, payload) => call(db, 'public.v1_tenant_training_journey_action', {
  p_slug: 'marktone', p_action: action, p_payload: payload,
});

async function secondPaidHandoff(db) {
  const contact = id(20200), handoff = id(20201), account = id(20202), invoice = id(20203), payment = id(20204);
  await db.query("insert into sales_core.contacts(id,tenant_id,full_name,phone,email) values($1,$2,'Second race learner','0501112244','second@example.test')", [contact, T]);
  await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor) values($1,$2,'RACE-HANDOFF-2',$3,$4,10000)", [handoff, T, contact, COURSE]);
  await db.query("insert into accounting_core.customer_accounts(id,tenant_id,contact_id,account_number,display_name) values($1,$2,$3,'RACE-ACC-2','Second race learner')", [account, T, contact]);
  await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,contact_id,customer_name_snapshot,subtotal_minor,total_minor,issue_date) values($1,$2,'invoice','RACE-INV-2','issued',$3,$4,'Second race learner',10000,10000,current_date)", [invoice, T, account, contact]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)", [T, handoff, invoice, account, ADMIN]);
  await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,payment_number,amount_minor,status,verified_at,verified_by_subject_id) values($1,$2,$3,'RACE-PAY-2',10000,'verified',now(),$4)", [payment, T, account, ADMIN]);
  await db.query('insert into accounting_core.payment_allocations(tenant_id,payment_id,invoice_id,amount_minor) values($1,$2,$3,10000)', [T, payment, invoice]);
  await db.query("update academy.registration_handoffs set payment_status='verified',payment_verified_at=now(),payment_verified_by_subject_id=$1 where id=$2", [ADMIN, handoff]);
  return handoff;
}

test('real PostgreSQL serializes training money, the final seat and invitation claims', {
  skip: !databaseUrl && 'Requires explicit disposable local TRAINING_TEST_DATABASE_URL',
  timeout: 60_000,
}, async t => {
  const connectionString = localTestUrl(databaseUrl);
  const { Client } = await import('pg'); // CI-only, pinned by the dedicated workflow.
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(client => client.end())); });
  for (const label of ['controller', 'worker-a', 'worker-b']) {
    const client = new Client({ connectionString, application_name: `training-concurrency-${label}`,
      connectionTimeoutMillis: 5_000, statement_timeout: 10_000, lock_timeout: 7_000 });
    clients.push(client);
    await client.connect();
  }
  const [controller, ...workers] = clients;
  assert.equal((await controller.query('select current_database() name')).rows[0].name, 'training_concurrency');
  assert.equal((await controller.query("select count(*)::int n from pg_namespace where nspname in ('academy','access_control','accounting_core','core')")).rows[0].n, 0,
    'Refusing to overwrite an existing fixture database; start a fresh disposable service');
  const db = { query: (sql, params) => controller.query(sql, params), exec: sql => controller.query(sql), close: async () => {} };
  await setup({ learning: true, database: db });
  for (const worker of workers) await login(worker, ADMIN_AUTH);
  await db.query('insert into academy.training_journey_settings(tenant_id,enabled) values($1,true)', [T]);
  await db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)", [T, HANDOFF, INVOICE, ACCOUNT, ADMIN]);

  await t.test('same payment command concurrently commits one allocation and one command result', async () => {
    await db.query("insert into accounting_core.payments(id,tenant_id,customer_account_id,payment_number,amount_minor,status) values($1,$2,$3,'RACE-PAY-1',10000,'pending_verification')", [PAYMENT, T, ACCOUNT]);
    const commandId = id(20100), payload = { commandId, handoffId: HANDOFF, paymentId: PAYMENT };
    const results = await race(controller, workers,
      client => client.query("select pg_advisory_xact_lock(hashtextextended($1,91216))", [`${T}:${commandId}`]),
      workers.map(() => client => financialAction(client, 'verify_payment', payload)));
    assert.equal(results.filter(result => result.ok).length, 2, JSON.stringify(results));
    assert.deepEqual(results[0].value, results[1].value);
    assert.deepEqual((await db.query('select count(*)::int n,sum(amount_minor)::int amount from accounting_core.payment_allocations where tenant_id=$1 and payment_id=$2 and invoice_id=$3', [T, PAYMENT, INVOICE])).rows[0], { n: 1, amount: 10000 });
    assert.equal((await db.query('select count(*)::int n from accounting_core.payments where tenant_id=$1 and id=$2', [T, PAYMENT])).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from academy.training_journey_commands where tenant_id=$1 and command_id=$2 and response is not null', [T, commandId])).rows[0].n, 1);
    assert.equal((await db.query("select count(*)::int n from academy.training_journey_events where tenant_id=$1 and event_type='verify_payment'", [T])).rows[0].n, 1);
    // A retry that arrives with a new command ID must still not allocate the
    // same verified payment twice. This race reaches the actual payment lock.
    const independentRetries = await race(controller, workers,
      client => client.query('select id from accounting_core.payments where tenant_id=$1 and id=$2 for update', [T, PAYMENT]),
      [id(20101), id(20102)].map(retryId => client => financialAction(client, 'verify_payment', { ...payload, commandId: retryId })));
    assert.equal(independentRetries.filter(result => result.ok).length, 2, JSON.stringify(independentRetries));
    assert.deepEqual((await db.query('select count(*)::int n,sum(amount_minor)::int amount from accounting_core.payment_allocations where tenant_id=$1 and payment_id=$2 and invoice_id=$3', [T, PAYMENT, INVOICE])).rows[0], { n: 1, amount: 10000 });
  });

  await t.test('two paid learners competing for the last seat produce one enrollment', async () => {
    const otherHandoff = await secondPaidHandoff(db);
    await db.query('update academy.course_runs set capacity=1 where id=$1', [RUN]);
    const results = await race(controller, workers,
      client => client.query('select id from academy.course_runs where tenant_id=$1 and id=$2 for update', [T, RUN]),
      [HANDOFF, otherHandoff].map((handoffId, index) => client => financialAction(client, 'confirm_admission', {
        commandId: id(20300 + index), handoffId, courseRunId: RUN,
      })));
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter(result => !result.ok && result.error.message === 'course_run_full').length, 1, JSON.stringify(results));
    assert.equal((await db.query('select count(*)::int n from academy.enrollments where tenant_id=$1 and course_run_id=$2', [T, RUN])).rows[0].n, 1);
    assert.equal((await db.query('select enrolled_count from academy.course_runs where tenant_id=$1 and id=$2', [T, RUN])).rows[0].enrolled_count, 1);
    assert.equal((await db.query("select count(*)::int n from academy.registration_handoffs where tenant_id=$1 and id=any($2::uuid[]) and status='completed'", [T, [HANDOFF, otherHandoff]])).rows[0].n, 1);
    assert.equal((await db.query('select count(*)::int n from sales_core.contacts where tenant_id=$1 and id=$2', [T, CONTACT])).rows[0].n, 1);
  });

  await t.test('the same invitation grants exactly one simultaneous activation claim', async () => {
    const student = (await db.query('select st.id,st.email from academy.enrollments e join academy.students st on st.tenant_id=e.tenant_id and st.id=e.student_id where e.tenant_id=$1 and e.course_run_id=$2', [T, RUN])).rows[0];
    const tokenHash = createHash('sha256').update('isolated-concurrency-invitation-fixture').digest('hex');
    await call(db, 'public.v1_training_learning_action', { p_tenant_slug: 'marktone', p_action: 'issue_invitation',
      p_command_id: id(20400), p_payload: { studentId: student.id, email: student.email, tokenHash } });
    for (const worker of workers) {
      await login(worker, null);
      await worker.query("select set_config('fixture.jwt_role','service_role',false)");
    }
    const claims = [id(20401), id(20402)];
    const results = await race(controller, workers,
      client => client.query('select id from academy.training_invitations where token_hash=$1 for update', [tokenHash]),
      claims.map(claimId => client => call(client, 'public.v1_training_invitation_activation', {
        p_token_hash: tokenHash, p_claim_id: claimId, p_action: 'claim',
      })));
    assert.equal(results.filter(result => result.ok).length, 1, JSON.stringify(results));
    assert.equal(results.filter(result => !result.ok && result.error.message === 'training_activation_in_progress').length, 1, JSON.stringify(results));
    const invitation = (await db.query('select status,activation_claim_id,accepted_at from academy.training_invitations where token_hash=$1', [tokenHash])).rows[0];
    assert.ok(claims.includes(invitation.activation_claim_id));
    assert.equal(invitation.status, 'pending');
    assert.equal(invitation.accepted_at, null);
    assert.equal((await db.query('select count(*)::int n from academy.training_learner_accounts where tenant_id=$1', [T])).rows[0].n, 0);
  });
});
