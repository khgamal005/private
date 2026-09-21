import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {setup, call, login, seedPayment, id, T, OTHER, ADMIN, ADMIN_AUTH, INSTRUCTOR_AUTH, HANDOFF, COURSE, ACCOUNT, STAFF, INVOICE, PAYMENT} from './fixtures/training-journey-database.mjs';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const migration = '../supabase/migrations/20260921125642_diploma_contracts_governance_v1.sql';
let sequence = 700;
const action = (db, actionName, payload, commandId = id(sequence++)) => call(db, 'public.v1_tenant_diploma_action', {p_slug: 'marktone', p_action: actionName, p_command_id: commandId, p_payload: payload});
const snapshot = (db, contractId = null) => call(db, 'public.v1_tenant_diploma_snapshot', {p_slug: 'marktone', p_contract_id: contractId});
const eligibility = db => call(db, 'private_app.diploma_admission_eligibility_v1', {p_tenant_id: T, p_handoff_id: HANDOFF});
const states = (db, contractId, asOf) => call(db, 'private_app.diploma_installment_state_v1', {p_tenant_id: T, p_contract_id: contractId, p_as_of: asOf});
const reconcile = (db, contractId, asOf) => call(db, 'private_app.reconcile_diploma_collection_v1', {p_tenant_id: T, p_contract_id: contractId, p_as_of: asOf});

test('direct diploma contract, immutable schedules, accounting evidence and tenant-calendar collections', async t => {
  const db = await setup(); t.after(() => db.close());
  const finance = await read('../supabase/migrations/20260921125610_financial_governance_v1.sql');
  // Execute the real canonical finance calculator. Other finance mutations have their own database tests.
  for (const name of ['customer_credits', 'customer_credit_applications']) {
    const start = finance.indexOf(`create table accounting_core.${name} (`);
    await db.exec(finance.slice(start, finance.indexOf('\n);', start) + 3));
  }
  const helperStart = finance.indexOf('create function private_app.accounting_invoice_net_v1(');
  await db.exec(finance.slice(helperStart, finance.indexOf('\nend $$;', helperStart) + 9));
  await db.exec(await read(migration));
  for (const permission of ['tenant.accounting.invoices.write', 'tenant.accounting.invoices.issue', 'tenant.accounting.settings.manage']) {
    await db.query('insert into access_control.permissions(permission_key,module_key,name_ar) values($1,\'accounting\',$1) on conflict do nothing', [permission]);
    await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing', [id(21), permission]);
  }
  await db.query("update core.tenants set timezone='Asia/Riyadh' where id=$1", [T]);
  const plan = [{id: id(601), dueOn: '2026-01-01', amountMinor: 10000}, {id: id(602), dueOn: '2026-02-01', amountMinor: 10000}];
  const draft = {handoffId: HANDOFF, payerAccountId: ACCOUNT, collectionOwnerId: STAFF, startsOn: '2026-01-01', totalMinor: 20000, currency: 'SAR', installments: plan};
  let contractId;
  await t.test('default disabled, no implicit legacy classification, no add-on dependency', async () => {
    assert.deepEqual(await snapshot(db), {enabled: false});
    assert.equal((await db.query('select program_kind from academy.courses where id=$1', [COURSE])).rows[0].program_kind, null);
    await assert.rejects(action(db, 'create', draft), /diploma_disabled/);
    // Core program classification remains available before diploma rollout and
    // with an academy-only role that has no accounting capability.
    for (const permission of ['tenant.academy.read', 'tenant.academy.write']) await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing', [id(22), permission]);
    await login(db, INSTRUCTOR_AUTH);
    const classification = {p_slug: 'marktone', p_course_id: COURSE, p_kind: 'short_course', p_expected_kind: null, p_command_id: id(sequence++)};
    await call(db, 'public.v1_tenant_classify_program', classification);
    assert.deepEqual(await call(db, 'public.v1_tenant_classify_program', classification), {id: COURSE, programKind: 'short_course'});
    assert.deepEqual((await db.query('select public.v1_tenant_program_kinds($1,array[$2::uuid,$3::uuid]) result', ['marktone', COURSE, OTHER])).rows[0].result, [{id: COURSE, programKind: 'short_course'}]);
    await assert.rejects(call(db, 'public.v1_tenant_classify_program', {...classification, p_kind: 'diploma', p_command_id: id(sequence++)}), /diploma_changed/);
    await login(db, ADMIN_AUTH);
    await db.query('insert into academy.diploma_settings(tenant_id,enabled) values($1,true)', [T]);
    await db.query("select set_config('fixture.addon','no',false)");
    await assert.rejects(action(db, 'create', draft), /diploma_program_required/);
    await action(db, 'classify_program', {courseId: COURSE, kind: 'diploma', expectedKind: 'short_course'});
    assert.equal((await snapshot(db)).enabled, true);
  });
  await t.test('unauthorized and cross-tenant callers cannot read or mutate', async () => {
    await login(db, INSTRUCTOR_AUTH);
    await assert.rejects(snapshot(db), /forbidden/);
    await login(db, null); await assert.rejects(snapshot(db), /authentication_required/);
    await login(db, ADMIN_AUTH);
    await assert.rejects(call(db, 'public.v1_tenant_diploma_snapshot', {p_slug: 'foreign'}), /forbidden/);
    await assert.rejects(action(db, 'create', {...draft, payerAccountId: OTHER}), /diploma_owner_or_payer_invalid/);
    await db.exec('set role authenticated');
    await assert.rejects(db.query('select * from academy.diploma_contracts'), /permission denied/);
    await db.exec('reset role');
    assert.equal((await db.query("select has_function_privilege('anon','public.v1_tenant_diploma_action(text,text,uuid,jsonb)','EXECUTE') ok")).rows[0].ok, false);
  });
  await t.test('30-calendar-month bound, totals and unique installment IDs are validated atomically', async () => {
    for (const installments of [[plan[0], {...plan[1], dueOn: '2028-07-02'}], [plan[0]], [plan[0], {...plan[1], id: plan[0].id}]]) {
      await assert.rejects(action(db, 'create', {...draft, installments}), /diploma_schedule_invalid/);
    }
    assert.equal((await db.query('select count(*)::int n from academy.diploma_contracts')).rows[0].n, 0);
  });
  await t.test('create retry returns same draft and no duplicate history', async () => {
    const command = id(sequence++); const first = await action(db, 'create', draft, command); contractId = first.contractId;
    assert.deepEqual(await action(db, 'create', draft, command), first);
    await assert.rejects(action(db, 'create', {...draft, totalMinor: 21000}, command), /command_id_reused_with_different_payload/);
    assert.equal((await eligibility(db)).eligible, false);
    await action(db, 'approve', {contractId, expectedVersion: 1});
    assert.equal((await eligibility(db)).reason, 'first_installment_required');
    await assert.rejects(action(db, 'classify_program', {courseId: COURSE, kind: 'short_course', expectedKind: 'diploma'}), /diploma_program_in_use/);
  });
  await t.test('only issued matching canonical invoice and verified net allocation qualify', async () => {
    await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,customer_name_snapshot,subtotal_minor,total_minor,currency) values($1,$2,'invoice','USD-1','issued',$3,'Fixture payer',10000,10000,'USD')", [id(650), T, ACCOUNT]);
    await assert.rejects(action(db, 'link_invoice', {contractId, expectedVersion: 1, installmentId: plan[0].id, invoiceId: id(650)}), /diploma_invoice_invalid/);
    await action(db, 'link_invoice', {contractId, expectedVersion: 1, installmentId: plan[0].id, invoiceId: INVOICE});
    await assert.rejects(db.query("insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values($1,$2,$3,$4,'full',$5)", [T, HANDOFF, INVOICE, ACCOUNT, ADMIN]), /diploma_invoice_invalid/);
    assert.equal((await eligibility(db)).eligible, false);
    await seedPayment(db);
    assert.equal((await eligibility(db)).eligible, true);
    await db.query("insert into accounting_core.refunds(tenant_id,customer_account_id,payment_id,invoice_id,amount_minor,reason,status,requested_by_subject_id) values($1,$2,$3,$4,100,'Fixture refund','completed',$5)", [T, ACCOUNT, PAYMENT, INVOICE, ADMIN]);
    assert.equal((await eligibility(db)).verifiedAmountMinor, 9900);
    assert.equal((await eligibility(db)).eligible, false);
  });
  await t.test('canonical price reductions qualify net first payment while uncertain history requires review', async () => {
    await db.exec('begin');
    try {
      await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor) values($1,$2,'credit_note','CN-INITIAL-REDUCTION','issued',$3,$4,'Fixture payer',100,100)", [id(665), T, ACCOUNT, INVOICE]);
      const reduced = await eligibility(db);
      assert.equal(reduced.eligible, true); assert.equal(reduced.requiredAmountMinor, 9900); assert.equal(reduced.originalRequiredAmountMinor, 10000);
      await db.query("insert into accounting_core.refunds(tenant_id,customer_account_id,payment_id,amount_minor,reason,status,requested_by_subject_id) values($1,$2,$3,10,'Ambiguous legacy invoice','completed',$4)", [T, ACCOUNT, PAYMENT, ADMIN]);
      const uncertain = await eligibility(db); assert.equal(uncertain.eligible, false); assert.equal(uncertain.reason, 'financial_review_required'); assert.equal(uncertain.verifiedAmountMinor, null);
      const state = (await states(db, contractId, '2026-01-10T00:00Z'))[0]; assert.equal(state.state, 'financial_review'); assert.equal(state.outstandingMinor, null);
      const preview = (await snapshot(db, contractId)).selected.settlementPreview; assert.equal(preview.canClose, false); assert.equal(preview.issuedOutstandingMinor, null);
      const review = await reconcile(db, contractId, '2026-01-10T00:00Z'); assert.equal(review.requiresReview, true); assert.equal(review.overdue, false);
      const task = (await db.query("select metadata,title from work_core.tasks where task_key=$1", ['diploma-collection-' + contractId])).rows[0];
      assert.equal(task.metadata.financialReview, true); assert.equal(task.metadata.outstandingMinor, null); assert.match(task.title, /مراجعة/);
    } finally { await db.exec('rollback'); }
  });
  await t.test('grace ends after seventh calendar day in tenant timezone, due date unchanged', async () => {
    assert.equal((await states(db, contractId, '2026-01-08T20:59:59Z'))[0].state, 'grace');
    assert.equal((await states(db, contractId, '2026-01-08T21:00:00Z'))[0].state, 'overdue');
    await reconcile(db, contractId, '2026-01-08T21:00:00Z');
    await reconcile(db, contractId, '2026-01-08T21:00:01Z');
    const tasks = (await db.query("select * from work_core.tasks where metadata->>'source'='diploma_collection'")).rows;
    assert.equal(tasks.length, 1); assert.equal(tasks[0].assigned_staff_id, STAFF);
    assert.equal(new Date(tasks[0].due_at).toISOString(), '2026-01-08T21:00:00.000Z');
    assert.equal((await states(db, contractId, '2026-01-08T21:00:00Z'))[0].dueOn, '2026-01-01');
    assert.equal((await db.query('select count(*)::int n from academy.enrollments')).rows[0].n, 0);
    assert.equal((await db.query('select status from academy.registration_handoffs where id=$1', [HANDOFF])).rows[0].status, 'pending');
  });
  await t.test('reschedule appends a version; issued obligations survive and stale writes fail', async () => {
    const next = plan.map(item => ({...item, dueOn: item.id === plan[0].id ? '2026-01-10' : item.dueOn}));
    await action(db, 'reschedule', {contractId, expectedVersion: 1, installments: next, reason: 'Approved date adjustment'});
    assert.equal((await snapshot(db, contractId)).selected.currentVersion, 2);
    assert.equal((await db.query('select count(*)::int n from academy.diploma_installments')).rows[0].n, 4);
    assert.equal((await db.query('select due_on::text from academy.diploma_installments where version=1 and id=$1', [plan[0].id])).rows[0].due_on, '2026-01-01');
    await assert.rejects(action(db, 'reschedule', {contractId, expectedVersion: 1, installments: next, reason: 'Stale date adjustment'}), /diploma_changed/);
    await assert.rejects(action(db, 'reschedule', {contractId, expectedVersion: 2, installments: [{...next[0], amountMinor: 9000}, {...next[1], amountMinor: 11000}], reason: 'Change first amount'}), /diploma_first_installment_immutable/);
    await assert.rejects(db.query("update academy.diploma_installments set due_on='2026-01-11' where id=$1", [plan[0].id]), /diploma_history_immutable/);
    await reconcile(db, contractId, '2026-01-09T00:00Z');
    assert.equal((await db.query("select status from work_core.tasks where metadata->>'source'='diploma_collection'")).rows[0].status, 'completed');
  });
  await t.test('explicit waiver requires reason and creates no fake payment', async () => {
    await assert.rejects(action(db, 'waive_first_installment', {contractId, expectedVersion: 2, reason: ''}), /diploma_reason_required/);
    const before = (await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n;
    await action(db, 'waive_first_installment', {contractId, expectedVersion: 2, reason: 'Approved first deposit exemption'});
    assert.equal((await eligibility(db)).waiverApproved, true); assert.equal((await eligibility(db)).eligible, true);
    assert.equal((await db.query('select count(*)::int n from accounting_core.payments')).rows[0].n, before);
    await assert.rejects(call(db, 'public.v1_diploma_collections_tick'), /forbidden/);
  });
  await t.test('unavailable employee moves collection to explicit finance queue', async () => {
    await db.exec("create function private_app.staff_operationally_available_v1(uuid,uuid,timestamptz) returns boolean language sql as $$select false$$");
    await reconcile(db, contractId, '2026-02-10T00:00Z');
    const row = (await db.query("select assigned_staff_id,metadata from work_core.tasks where metadata->>'source'='diploma_collection'")).rows[0];
    assert.equal(row.assigned_staff_id, null); assert.equal(row.metadata.ownerMissing, true); assert.equal(row.metadata.queueDepartment, 'finance');
  });
  await t.test('cancellation pauses unbilled obligations and requires previewed settlement of issued debt', async () => {
    const refund = (await db.query('select id from accounting_core.refunds limit 1')).rows[0].id;
    const args = {p_tenant_id: T, p_handoff_id: HANDOFF, p_refund_id: refund};
    await call(db, 'private_app.mark_diploma_settlement_review_v1', args);
    assert.equal((await call(db, 'private_app.mark_diploma_settlement_review_v1', args)).replayed, true);
    let selected = (await snapshot(db, contractId)).selected;
    assert.equal(selected.status, 'settlement_review'); assert.equal(selected.eligibility.eligible, false);
    assert.equal(selected.installments[1].state, 'paused');
    assert.equal(selected.settlementPreview.issuedOutstandingMinor, 100);
    assert.equal(selected.settlementPreview.unbilledMinor, 10000);
    await assert.rejects(action(db, 'link_invoice', {contractId, expectedVersion: 2, installmentId: plan[1].id, invoiceId: id(650)}), /diploma_approval_required/);
    const request = {contractId, expectedVersion: 2, resolution: 'closed', reason: 'Reviewed cancellation settlement', confirmed: true, previewRevision: selected.settlementPreview.revision};
    await assert.rejects(action(db, 'resolve_settlement', {...request, previewRevision: 'stale'}), /diploma_changed/);
    await assert.rejects(action(db, 'resolve_settlement', request), /diploma_outstanding_balance/);
    await action(db, 'resolve_settlement', {...request, resolution: 'collections_only'});
    selected = (await snapshot(db, contractId)).selected; assert.equal(selected.status, 'collections_only');
    // Debt is reduced with an issued accounting credit note, never with a fabricated payment.
    await db.query("insert into accounting_core.sales_documents(id,tenant_id,document_type,document_number,status,customer_account_id,parent_document_id,customer_name_snapshot,subtotal_minor,total_minor) values($1,$2,'credit_note','CN-1','issued',$3,$4,'Fixture payer',100,100)", [id(660), T, ACCOUNT, INVOICE]);
    selected = (await snapshot(db, contractId)).selected; assert.equal(selected.settlementPreview.canClose, true);
    await action(db, 'resolve_settlement', {...request, previewRevision: selected.settlementPreview.revision});
    assert.equal((await snapshot(db, contractId)).selected.status, 'closed');
    assert.equal((await db.query("select status from work_core.tasks where metadata->>'source'='diploma_collection'")).rows[0].status, 'completed');
  });
  await t.test('new accounting debt after closure reopens financial review and preserves academic state', async () => {
    await db.query("insert into accounting_core.refunds(tenant_id,customer_account_id,payment_id,invoice_id,amount_minor,reason,status,requested_by_subject_id) values($1,$2,$3,$4,50,'Additional refund','completed',$5)", [T, ACCOUNT, PAYMENT, INVOICE, ADMIN]);
    await call(db, 'private_app.queue_diploma_collection_v1', {p_tenant_id: T, p_contract_id: contractId});
    await db.query('update academy.diploma_settings set collection_automation_enabled=true where tenant_id=$1', [T]);
    assert.equal((await call(db, 'private_app.diploma_collections_tick_v1')).processed, 1);
    assert.equal((await db.query('select count(*)::int n from academy.diploma_reconciliation_queue')).rows[0].n, 0);
    await db.query('update academy.diploma_settings set collection_automation_enabled=false where tenant_id=$1', [T]);
    assert.equal((await snapshot(db, contractId)).selected.status, 'settlement_review');
    assert.equal((await db.query("select count(*)::int n from academy.diploma_events where kind='financial_balance_reopened'")).rows[0].n, 1);
  });
  await t.test('automatic collections remain opt-in and require a confirmed activation preview', async () => {
    await db.query("select set_config('fixture.jwt_role','service_role',false)");
    assert.equal((await call(db, 'public.v1_diploma_collections_tick')).processed, 0);
    await assert.rejects(action(db, 'set_collection_automation', {enabled: true, confirmed: true, expectedContractCount: 1}), /diploma_scheduler_unavailable/);
    // The pg_cron scheduling seam is isolated: this test registers no real job.
    await db.exec('create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;');
    await assert.rejects(action(db, 'set_collection_automation', {enabled: true, confirmed: false, expectedContractCount: 1}), /diploma_changed/);
    await action(db, 'set_collection_automation', {enabled: true, confirmed: true, expectedContractCount: 1});
    assert.equal((await call(db, 'public.v1_diploma_collections_tick')).processed, 1);
    await action(db, 'set_collection_automation', {enabled: false, confirmed: true, expectedContractCount: 1});
    assert.equal((await call(db, 'public.v1_diploma_collections_tick')).processed, 0);
  });
  await t.test('draft mistakes are corrected through a new immutable revision before approval', async () => {
    await db.query("insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,payment_amount_minor) select $1,tenant_id,'DRAFT-REVISION',contact_id,course_id,10000 from academy.registration_handoffs where id=$2", [id(670), HANDOFF]);
    const original = {...draft, handoffId: id(670), totalMinor: 30000, installments: plan.map(item => ({...item, amountMinor: 15000}))};
    const created = await action(db, 'create', original);
    await action(db, 'revise_draft', {...draft, contractId: created.contractId, expectedVersion: 1, reason: 'Correction before approval'});
    const selected = (await snapshot(db, created.contractId)).selected;
    assert.equal(selected.status, 'draft'); assert.equal(selected.currentVersion, 2); assert.equal(selected.totalMinor, 20000);
    assert.equal((await db.query('select sum(amount_minor)::int total from academy.diploma_installments where contract_id=$1 and version=1', [created.contractId])).rows[0].total, 30000);
    await action(db, 'approve', {contractId: created.contractId, expectedVersion: 2});
    await assert.rejects(action(db, 'revise_draft', {...draft, contractId: created.contractId, expectedVersion: 2, reason: 'Cannot rewrite approved contract'}), /diploma_changed/);
  });
});
