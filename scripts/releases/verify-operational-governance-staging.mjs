import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

// Release-only test: fixed platform-Staging project, genuine password sessions,
// synthetic tenant records only. Never apply migrations or call a global worker.
const REF = 'pzflscqwfkixclmjyran';
const SUPABASE = `https://${REF}.supabase.co`;
const ORIGIN = 'http://127.0.0.1:4731';
const token = process.env.ODEIR_STAGING_MANAGEMENT_TOKEN;
const evidence = {success: false, stagingProject: REF, revision: process.env.GITHUB_SHA || null, checks: [], fixturesQuarantined: false, globalWorkersInvoked: 0, migrationsApplied: 0};
const keysToMask = [], users = [];
const ids = Object.fromEntries(['organization', 'tenant', 'foreignTenant', 'contact', 'shortCourse', 'diplomaCourse', 'foreignCourse', 'shortRun', 'diplomaRun', 'shortHandoff', 'diplomaHandoff', 'department', 'document'].map(key => [key, randomUUID()]));
const slug = `qa-governance-${randomUUID().replaceAll('-', '')}`;
const foreignSlug = `${slug}-other`;
const q = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${q(JSON.stringify(value))}::jsonb`;
let secret, publishable, server, seeded = false, phase = 'authorization', failure;

function mask(value) {if (value) {keysToMask.push(value); console.log(`::add-mask::${value}`);}}
function safeMessage(value) {
  let message = String(value);
  for (const sensitive of keysToMask) message = message.replaceAll(sensitive, '[redacted]');
  return message.slice(0, 700);
}
function assertDestination(url) {
  const target = new URL(url);
  assert.ok((target.origin === 'https://api.supabase.com' && (target.pathname === `/v1/projects/${REF}` || target.pathname.startsWith(`/v1/projects/${REF}/`))) || target.origin === SUPABASE || target.origin === ORIGIN, 'Request outside fixed staging/local allowlist refused');
}
async function http(url, options = {}) {
  assertDestination(url);
  const response = await fetch(url, {...options, redirect: 'error', signal: AbortSignal.timeout(30000)});
  let data; try {data = await response.json();} catch {throw new Error(`${phase}: non-JSON HTTP ${response.status}`);}
  return {response, data};
}
async function request(url, options = {}) {
  const {response, data} = await http(url, options);
  if (!response.ok) throw new Error(`${phase}: HTTP ${response.status}: ${safeMessage(data?.message || data?.error || 'request failed')}`);
  return data;
}
const management = (path, body) => request(`https://api.supabase.com/v1/projects/${REF}${path}`, {
  method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})
});
const sql = query => management('/database/query', {query});
const auth = (path, body, method = 'POST') => request(`${SUPABASE}/auth/v1/${path}`, {
  method, headers: {apikey: secret, Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)
});
async function app(path, body, session, expected = 200) {
  const {response, data} = await http(`${ORIGIN}${path}`, {
    method: body == null ? 'GET' : 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...(session ? {Cookie: session.cookie} : {})},
    ...(body == null ? {} : {body: JSON.stringify(body)})
  });
  assert.equal(response.status, expected, `${phase}: ${path}: ${safeMessage(data?.detail?.message || data?.error || '')}`);
  return data.data ?? data;
}
async function deniedApp(path, body, session, code = 'forbidden') {
  const {response, data} = await http(`${ORIGIN}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN, Cookie: session.cookie}, body: JSON.stringify(body)});
  assert.ok([400, 401, 403, 409].includes(response.status), `${phase}: forbidden request returned ${response.status}`);
  const raw = data?.detail?.message;
  if (raw) assert.ok(String(raw).includes(code), `${phase}: wrong rejection ${safeMessage(raw)}`);
  else assert.ok(typeof data.error === 'string' && data.error.length > 0, `${phase}: missing explicit rejection`);
  return data;
}
async function rpc(name, args, session, expected = 200) {
  const {response, data} = await http(`${SUPABASE}/rest/v1/rpc/${name}`, {method: 'POST', headers: {apikey: publishable, Authorization: `Bearer ${session.access}`, 'Content-Type': 'application/json'}, body: JSON.stringify(args)});
  assert.equal(response.status, expected, `${phase}: RPC ${name}: ${safeMessage(data?.message || '')}`);
  return data;
}
async function login(user) {
  const {response} = await http(`${ORIGIN}/api/auth/login`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: ORIGIN}, body: JSON.stringify({email: user.email, password: user.password})});
  assert.equal(response.status, 200, `${phase}: genuine login`);
  const cookies = response.headers.getSetCookie();
  for (const value of cookies) mask(value.split(';')[0].split('=').slice(1).join('='));
  const cookie = cookies.map(value => value.split(';')[0]).join('; ');
  const access = cookie.match(/(?:^|; )mt_access=([^;]+)/)?.[1];
  assert.ok(access, `${phase}: access session cookie missing`); mask(access);
  return {cookie, access};
}
const permissionSets = {
  owner: ['tenant.workspace.read', 'tenant.settings.manage', 'tenant.people.manage', 'tenant.academy.read', 'tenant.academy.write', 'tenant.crm.read', 'tenant.crm.write', 'tenant.work.read', 'tenant.work.write', 'tenant.admissions.read', 'tenant.admissions.write', 'tenant.admissions.governance.manage', 'tenant.admissions.exceptions.approve', 'tenant.accounting.read', 'tenant.accounting.customers.write', 'tenant.accounting.invoices.write', 'tenant.accounting.invoices.issue', 'tenant.accounting.payments.record', 'tenant.accounting.payments.approve', 'tenant.accounting.refunds.request', 'tenant.accounting.refunds.approve', 'tenant.accounting.settings.manage'],
  registrar: ['tenant.workspace.read', 'tenant.admissions.read', 'tenant.admissions.write', 'tenant.academy.read', 'tenant.work.read', 'tenant.work.write'],
  approver: ['tenant.workspace.read', 'tenant.accounting.read', 'tenant.accounting.refunds.approve'],
  outsider: ['tenant.workspace.read', 'tenant.settings.manage', 'tenant.academy.read', 'tenant.academy.write', 'tenant.admissions.read', 'tenant.admissions.write', 'tenant.accounting.read']
};
const admission = (action, payload, session) => app('/api/tenant/admission-governance', {p_tenant_slug: slug, p_action: action, p_payload: payload}, session);
const finance = (action, payload, session) => app(`/api/accounting/${action.replaceAll('_', '-')}`, {tenantSlug: slug, payload: {commandId: randomUUID(), ...payload}}, session);
const diploma = (action, payload, session, commandId = randomUUID()) => app('/api/diplomas', {tenantSlug: slug, action, payload, commandId}, session);
const admissionsSnapshot = session => rpc('v3_tenant_admissions_snapshot', {p_slug: slug}, session);
async function awaitEnrollment(handoffId, status, session) {
  // An already-enabled staging scheduler may own this synthetic queue row.
  // Retry only this tenant's reconciliation; never drain a global worker.
  for (let attempt = 0; attempt < 12; attempt++) {
    await admission('process_queue', {}, session);
    const result = (await sql(`select count(*)::int count from academy.enrollments where tenant_id=${q(ids.tenant)} and handoff_id=${q(handoffId)} and status=${q(status)}`))[0];
    if (result.count === 1) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Synthetic admission did not reach ${status}`);
}

try {
  assert.ok(token, 'Staging management credential unavailable; no data changed.'); mask(token);
  const project = await management(''); assert.equal(project.id ?? project.ref, REF); assert.match(project.name, /staging/i);
  const ready = (await sql(`select
    to_regprocedure('public.v1_tenant_operating_action(text,text,jsonb)') is not null
    and to_regprocedure('public.v1_tenant_classify_program(text,uuid,text,text,uuid)') is not null
    and to_regprocedure('public.v1_tenant_diploma_action(text,text,uuid,jsonb)') is not null
    and to_regprocedure('public.v1_tenant_admission_governance_action(text,text,jsonb)') is not null
    and to_regprocedure('private_app.accounting_reconcile_invoice_v1(uuid,uuid)') is not null as ready`))[0];
  assert.equal(ready.ready, true, 'Install reviewed governance migrations on staging before this workflow.');
  const keys = await management('/api-keys?reveal=true');
  secret = keys.find(key => key.type === 'secret')?.api_key || keys.find(key => key.name === 'service_role')?.api_key;
  publishable = keys.find(key => key.type === 'publishable')?.api_key || keys.find(key => key.name === 'anon')?.api_key;
  assert.ok(secret && publishable, 'Staging Auth credentials unavailable.'); mask(secret); mask(publishable);
  phase = 'synthetic Auth accounts';
  for (const role of Object.keys(permissionSets)) {
    const password = randomBytes(32).toString('base64url'); mask(password);
    const email = `${role}-${slug}@example.com`;
    const user = await auth('admin/users', {email, password, email_confirm: true, user_metadata: {full_name: `QA governance ${role}`, qaRun: slug}});
    assert.match(user.id, /^[0-9a-f-]{36}$/i);
    users.push({id: user.id, email, password, role, roleKey: {owner: 'tenant_owner', registrar: 'customer_service', approver: 'finance_manager', outsider: 'sales_user'}[role], subject: randomUUID(), membership: randomUUID(), staff: randomUUID(), roleId: randomUUID(), tenant: role === 'outsider' ? ids.foreignTenant : ids.tenant});
  }
  const [ownerUser, registrarUser] = users;
  phase = 'isolated tenant fixture';
  await sql(`begin;
    insert into core.organizations(id,organization_key,legal_name,display_name,metadata) values(${q(ids.organization)},${q(slug)},'QA governance organization','QA governance organization',${json({qaRun: slug})});
    insert into core.tenants(id,organization_id,tenant_key,slug,name,status,timezone,settings) values
      (${q(ids.tenant)},${q(ids.organization)},${q(slug)},${q(slug)},'QA governance','active','Asia/Riyadh',${json({qaRun: slug})}),
      (${q(ids.foreignTenant)},${q(ids.organization)},${q(foreignSlug)},${q(foreignSlug)},'QA foreign governance','active','Asia/Riyadh',${json({qaRun: slug})});
    insert into people.departments(id,tenant_id,department_key,name_ar) values(${q(ids.department)},${q(ids.tenant)},'admissions','QA admissions');
    ${users.map(user => `insert into access_control.subjects(id,auth_user_id,email,full_name,status,must_change_password) values(${q(user.subject)},${q(user.id)},${q(user.email)},${q(`QA ${user.role}`)},'active',false);
      insert into access_control.roles(id,tenant_id,role_key,name_ar,scope) values(${q(user.roleId)},${q(user.tenant)},${q(user.roleKey)},${q(`QA ${user.role}`)},'tenant');
      insert into access_control.role_permissions(role_id,permission_key) select ${q(user.roleId)}::uuid,permission_key from access_control.permissions where permission_key in (${permissionSets[user.role].map(q).join(',')});
      insert into access_control.memberships(id,subject_id,tenant_id,scope,status) values(${q(user.membership)},${q(user.subject)},${q(user.tenant)},'tenant','active');
      insert into access_control.membership_roles(membership_id,role_id) values(${q(user.membership)},${q(user.roleId)});
      insert into people.staff_profiles(id,tenant_id,membership_id,full_name,job_title,role_key,department_id,account_status) values(${q(user.staff)},${q(user.tenant)},${q(user.membership)},${q(`QA ${user.role}`)},'QA',${q(user.roleKey)},${user.role === 'registrar' ? q(ids.department) : 'null'},'active');`).join('\n')}
    insert into sales_core.contacts(id,tenant_id,full_name,phone,owner_staff_id) values(${q(ids.contact)},${q(ids.tenant)},'QA one canonical learner','0500000191',${q(ownerUser.staff)});
    insert into academy.courses(id,tenant_id,course_code,title_ar,category) values
      (${q(ids.shortCourse)},${q(ids.tenant)},'QA-SHORT','QA short course','QA'),
      (${q(ids.diplomaCourse)},${q(ids.tenant)},'QA-DIPLOMA','QA diploma','QA'),
      (${q(ids.foreignCourse)},${q(ids.foreignTenant)},'QA-FOREIGN','QA foreign course','QA');
    insert into academy.course_runs(id,tenant_id,course_id,run_code,title,delivery_mode,status,capacity,starts_at) values
      (${q(ids.shortRun)},${q(ids.tenant)},${q(ids.shortCourse)},'QA-SHORT','QA short cohort','onsite','open',3,now()+interval '30 days'),
      (${q(ids.diplomaRun)},${q(ids.tenant)},${q(ids.diplomaCourse)},'QA-DIPLOMA','QA diploma cohort','onsite','open',3,now()+interval '30 days');
    insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,course_run_id,assigned_staff_id,payment_amount_minor,payment_reference,metadata) values
      (${q(ids.shortHandoff)},${q(ids.tenant)},'qa-short',${q(ids.contact)},${q(ids.shortCourse)},${q(ids.shortRun)},${q(registrarUser.staff)},10000,'QA-SHORT-EVIDENCE','{"currency":"SAR"}'),
      (${q(ids.diplomaHandoff)},${q(ids.tenant)},'qa-diploma',${q(ids.contact)},${q(ids.diplomaCourse)},${q(ids.diplomaRun)},${q(registrarUser.staff)},10000,'QA-DIPLOMA-EVIDENCE','{"currency":"SAR"}');
    commit;`);
  seeded = true;
  const requiredPermissions = (await sql(`select permission_key from access_control.role_permissions where role_id=${q(ownerUser.roleId)}`)).map(row => row.permission_key);
  for (const permission of permissionSets.owner) assert.ok(requiredPermissions.includes(permission), `Required existing permission unavailable: ${permission}`);
  phase = 'Next server with staging-only configuration';
  const childEnv = {PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', SUPABASE_URL: SUPABASE, NEXT_PUBLIC_SUPABASE_URL: SUPABASE, SUPABASE_PUBLISHABLE_KEY: publishable, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publishable};
  server = spawn('node', ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '4731'], {env: childEnv, stdio: 'ignore'});
  let listening = false;
  for (let n = 0; n < 90; n++) {
    assert.equal(server.exitCode, null, 'Next exited before readiness');
    try {const response = await fetch(`${ORIGIN}/login`, {redirect: 'error', signal: AbortSignal.timeout(1500)}); if (response.ok) {listening = true; break;}} catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.ok(listening, 'Next did not become ready');
  const sessions = []; for (const user of users) sessions.push(await login(user));
  const [owner, registrar, approver, outsider] = sessions;
  evidence.checks.push('genuine-password-login-four-independent-roles');
  phase = 'no-session and cross-tenant boundaries';
  await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}`, null, null, 401);
  await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}`, null, outsider, 403);
  await deniedApp('/api/tenant/operating-snapshot', {p_tenant_slug: slug}, outsider);
  await deniedApp('/api/tenant/admission-governance-snapshot', {p_tenant_slug: slug}, outsider);
  const foreignKinds = await rpc('v1_tenant_program_kinds', {p_slug: slug, p_course_ids: [ids.shortCourse, ids.foreignCourse]}, owner);
  assert.deepEqual(foreignKinds.map(item => item.id), [ids.shortCourse]);
  evidence.checks.push('no-session-denied', 'real-jwt-tenant-isolation', 'foreign-course-id-not-returned');
  phase = 'free readiness and academy classification';
  assert.deepEqual(await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}`, null, owner), {enabled: false});
  await finance('save_settings', {legalNameAr: 'QA governance legal', baseCurrency: 'SAR', timezone: 'Asia/Riyadh', taxRegistered: false, defaultTaxRateBps: 0}, owner);
  const setup = await app('/api/tenant/operating-snapshot', {p_tenant_slug: slug}, owner);
  await app('/api/tenant/operating-foundation', {p_tenant_slug: slug, p_action: 'save_setup', p_payload: {expectedVersion: setup.setup.version, name: 'QA governance', legalName: 'QA governance legal', timezone: 'Asia/Riyadh', intakeSource: 'manual', firstBranchName: 'QA main branch'}}, owner);
  const readySetup = await app('/api/tenant/operating-snapshot', {p_tenant_slug: slug}, owner);
  assert.equal(readySetup.ready, true); assert.equal(readySetup.setup.intakeSource, 'manual'); assert.equal(readySetup.branches.length, 1);
  for (const [courseId, kind] of [[ids.shortCourse, 'short_course'], [ids.diplomaCourse, 'diploma']]) {
    const command = {tenantSlug: slug, courseId, kind, expectedKind: null, commandId: randomUUID()};
    const classified = await app('/api/program-kind', command, owner); assert.equal(classified.programKind, kind);
    assert.deepEqual(await app('/api/program-kind', command, owner), classified);
  }
  evidence.checks.push('free-manual-readiness-no-sync-no-addon', 'program-classification-and-idempotent-replay');
  phase = 'admission financial redaction and verification authority';
  const limited = await admissionsSnapshot(registrar), financial = await admissionsSnapshot(owner);
  assert.equal(limited.viewer.canViewFinancialDetails, false); assert.equal(limited.viewer.canVerifyPayment, false);
  for (const handoffId of [ids.shortHandoff, ids.diplomaHandoff]) {
    const hidden = limited.cases.find(item => item.id === handoffId), visible = financial.cases.find(item => item.id === handoffId);
    assert.ok(hidden && visible); assert.equal(Object.hasOwn(hidden, 'paymentAmountMinor'), false); assert.equal(Object.hasOwn(hidden, 'paymentReference'), false);
    assert.equal(Number(visible.paymentAmountMinor), 10000); assert.ok(visible.paymentReference);
  }
  await deniedApp('/api/tenant/update-admission', {p_tenant_slug: slug, p_handoff_id: ids.shortHandoff, p_action: 'verify_payment'}, registrar);
  evidence.checks.push('admissions-only-amount-reference-redaction', 'admissions-write-cannot-verify-cash');
  phase = 'isolated governed policy and canonical invoices';
  const policy = {enabled: true, financeOwnerStaffId: ownerUser.staff, placementOwnerStaffId: registrarUser.staff, financeBusinessDays: 1, placementBusinessDays: 1, weekendIsoDays: [5, 6]};
  const preview = await admission('preview_policy', policy, owner); assert.ok(preview.previewToken);
  // Seed ONLY this fixture's policy. Deliberately avoid save_policy here because
  // it registers the global cron worker and could process unrelated staging data.
  await sql(`begin;
    insert into academy.admission_governance_settings(tenant_id,enabled,finance_sla_business_days,placement_sla_business_days,weekend_iso_days,finance_owner_staff_id,placement_owner_staff_id,approved_by_subject_id,activated_at)
      values(${q(ids.tenant)},true,1,1,array[5,6],${q(ownerUser.staff)},${q(registrarUser.staff)},${q(ownerUser.subject)},now());
    insert into academy.diploma_settings(tenant_id,enabled) values(${q(ids.tenant)},true);
    insert into academy.registration_documents(id,tenant_id,handoff_id,document_type,is_required,status) values(${q(ids.document)},${q(ids.tenant)},${q(ids.shortHandoff)},'national_id',true,'pending');
    commit;`);
  const account = await finance('create_customer_account', {contactId: ids.contact, displayName: 'QA canonical payer'}, owner); assert.ok(account.accountId);
  const document = async (documentType, parentDocumentId = null) => {
    const result = await finance('create_document', {documentType, customerAccountId: account.accountId, parentDocumentId, currency: 'SAR', lines: [{description: `QA ${documentType}`, quantity: 1, unitAmountMinor: 10000, discountMinor: 0, taxCategory: 'out_of_scope', taxRateBps: 0}]}, owner);
    assert.ok(result.documentId); await finance('issue_document', {documentId: result.documentId, status: 'issued'}, owner); return result.documentId;
  };
  const shortInvoice = await document('invoice'), diplomaInvoice = await document('invoice');
  await sql(`insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,created_by_subject_id) values(${q(ids.tenant)},${q(ids.shortHandoff)},${q(shortInvoice)},${q(account.accountId)},'full',${q(ownerUser.subject)})`);
  const payment = async (invoiceId, label) => {
    const paid = await finance('record_payment', {customerAccountId: account.accountId, amountMinor: 10000, currency: 'SAR', method: 'cash', verifyNow: true, externalReference: label}, owner);
    assert.ok(paid.paymentId); await finance('allocate_payment', {paymentId: paid.paymentId, invoiceId, amountMinor: 10000}, owner); return paid.paymentId;
  };
  phase = 'short course full-payment and required-document transition';
  await payment(shortInvoice, 'QA-SHORT-CASH');
  await admission('reevaluate', {handoffId: ids.shortHandoff}, registrar);
  let actual = (await sql(`select count(*)::int count from academy.enrollments where tenant_id=${q(ids.tenant)} and handoff_id=${q(ids.shortHandoff)}`))[0]; assert.equal(actual.count, 0);
  await app('/api/tenant/update-admission-document', {p_tenant_slug: slug, p_handoff_id: ids.shortHandoff, p_document_type: 'national_id', p_status: 'approved', p_notes: 'QA document accepted', p_is_required: true}, registrar);
  await awaitEnrollment(ids.shortHandoff, 'confirmed', owner);
  evidence.checks.push('canonical-short-cash-allocation', 'required-document-blocks-enrollment', 'tenant-scoped-admission-reconciliation');
  phase = 'diploma first installment and command replay';
  const today = (await sql(`select (now() at time zone 'Asia/Riyadh')::date::text as day`))[0].day;
  const later = (await sql(`select (${q(today)}::date+interval '1 month')::date::text as day`))[0].day;
  const installments = [{id: randomUUID(), dueOn: today, amountMinor: 10000}, {id: randomUUID(), dueOn: later, amountMinor: 10000}];
  const createPayload = {handoffId: ids.diplomaHandoff, payerAccountId: account.accountId, collectionOwnerId: ownerUser.staff, startsOn: today, totalMinor: 20000, currency: 'SAR', installments};
  const createCommand = randomUUID();
  const created = await diploma('create', createPayload, owner, createCommand); assert.ok(created.contractId);
  assert.deepEqual(await diploma('create', createPayload, owner, createCommand), created);
  await diploma('approve', {contractId: created.contractId, expectedVersion: 1}, owner);
  await diploma('link_invoice', {contractId: created.contractId, expectedVersion: 1, installmentId: installments[0].id, invoiceId: diplomaInvoice}, owner);
  let contract = (await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}&contractId=${created.contractId}`, null, owner)).selected;
  assert.equal(contract.eligibility.eligible, false);
  const diplomaPayment = await payment(diplomaInvoice, 'QA-DIPLOMA-FIRST-CASH');
  const queued = (await sql(`select exists(select 1 from academy.admission_governance_queue where tenant_id=${q(ids.tenant)} and handoff_id=${q(ids.diplomaHandoff)}) as admission,exists(select 1 from academy.diploma_reconciliation_queue where tenant_id=${q(ids.tenant)} and contract_id=${q(created.contractId)}) as collection,exists(select 1 from academy.enrollments where tenant_id=${q(ids.tenant)} and handoff_id=${q(ids.diplomaHandoff)} and status='confirmed') as already_processed`))[0];
  assert.equal(queued.admission || queued.already_processed, true); assert.equal(queued.collection, true);
  await awaitEnrollment(ids.diplomaHandoff, 'confirmed', owner);
  await diploma('refresh_collection', {contractId: created.contractId, expectedVersion: 1}, owner);
  contract = (await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}&contractId=${created.contractId}`, null, owner)).selected;
  assert.equal(contract.eligibility.eligible, true); assert.equal(contract.installments[0].state, 'settled'); assert.equal(Number(contract.installments[1].outstandingMinor), 10000);
  let counts = (await sql(`select count(*)::int enrollments,(select count(*)::int from sales_core.contacts where tenant_id=${q(ids.tenant)}) contacts from academy.enrollments where tenant_id=${q(ids.tenant)} and status='confirmed'`))[0];
  assert.equal(counts.enrollments, 2); assert.equal(counts.contacts, 1);
  await admission('process_queue', {}, owner);
  assert.equal((await sql(`select count(*)::int count from academy.enrollments where tenant_id=${q(ids.tenant)}`))[0].count, 2);
  evidence.checks.push('diploma-first-installment-not-full-contract-payment', 'real-finance-hooks-queue-admission-and-collection', 'two-programs-one-canonical-contact', 'idempotent-enrollment');
  phase = 'two-person refund and diploma settlement';
  const creditNote = await document('credit_note', diplomaInvoice);
  const refund = await finance('request_refund', {paymentId: diplomaPayment, invoiceId: diplomaInvoice, creditNoteId: creditNote, handoffId: ids.diplomaHandoff, amountMinor: 10000, effect: 'cancel_registration', reason: 'QA reviewed diploma cancellation'}, owner);
  assert.ok(refund.refundId);
  await deniedApp('/api/accounting/approve-refund', {tenantSlug: slug, payload: {commandId: randomUUID(), refundId: refund.refundId}}, owner, 'refund_self_approval_forbidden');
  const selfApproval = await rpc('v1_tenant_accounting_action', {p_slug: slug, p_action: 'approve_refund', p_payload: {commandId: randomUUID(), refundId: refund.refundId}}, owner, 400);
  assert.match(selfApproval.message, /refund_self_approval_forbidden/);
  await finance('approve_refund', {refundId: refund.refundId}, approver);
  await finance('complete_refund', {refundId: refund.refundId, externalReference: 'QA-DIPLOMA-REFUND'}, approver);
  await awaitEnrollment(ids.diplomaHandoff, 'cancelled', owner);
  contract = (await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}&contractId=${created.contractId}`, null, owner)).selected;
  assert.equal(contract.status, 'settlement_review'); assert.equal(contract.installments[1].state, 'paused'); assert.equal(Number(contract.settlementPreview.issuedOutstandingMinor), 0);
  const final = (await sql(`select
    (select status from academy.enrollments where tenant_id=${q(ids.tenant)} and handoff_id=${q(ids.shortHandoff)}) short_status,
    (select status from academy.enrollments where tenant_id=${q(ids.tenant)} and handoff_id=${q(ids.diplomaHandoff)}) diploma_status,
    (select enrolled_count from academy.course_runs where tenant_id=${q(ids.tenant)} and id=${q(ids.diplomaRun)}) diploma_seats,
    (select count(*)::int from accounting_core.payments where tenant_id=${q(ids.tenant)}) payment_count,
    (select count(*)::int from academy.diploma_schedule_versions where tenant_id=${q(ids.tenant)}) schedule_history`))[0];
  assert.equal(final.short_status, 'confirmed'); assert.equal(final.diploma_status, 'cancelled'); assert.equal(final.diploma_seats, 0); assert.equal(final.payment_count, 2); assert.equal(final.schedule_history, 1);
  const close = {contractId: created.contractId, expectedVersion: 1, resolution: 'closed', reason: 'QA issued balance settled and unbilled obligations cancelled', confirmed: true, previewRevision: contract.settlementPreview.revision};
  await diploma('resolve_settlement', close, owner);
  assert.equal((await app(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}&contractId=${created.contractId}`, null, owner)).selected.status, 'closed');
  evidence.checks.push('refund-requester-cannot-self-approve', 'independent-approver-completes-refund', 'diploma-cancellation-preserves-other-enrollment', 'capacity-released-once', 'issued-debt-preserved-unbilled-paused', 'preview-confirmed-final-settlement', 'immutable-schedule-history-retained');
  evidence.success = true;
} catch (error) {
  failure = new Error(`${phase}: ${safeMessage(error.message)}`); evidence.failedPhase = phase; evidence.failure = safeMessage(error.message); evidence.success = false;
} finally {
  phase = 'quarantine synthetic fixtures'; let cleanup = true;
  if (seeded) {
    try {
      await sql(`begin;
        update academy.admission_governance_settings set enabled=false where tenant_id=${q(ids.tenant)};
        update academy.diploma_settings set enabled=false,collection_automation_enabled=false where tenant_id=${q(ids.tenant)};
        delete from academy.admission_governance_queue where tenant_id=${q(ids.tenant)};
        delete from academy.diploma_reconciliation_queue where tenant_id=${q(ids.tenant)};
        update access_control.memberships set status='revoked' where tenant_id in (${q(ids.tenant)},${q(ids.foreignTenant)});
        update access_control.subjects set status='disabled' where id in (${users.map(user => q(user.subject)).join(',')});
        update core.tenants set status='closed' where id in (${q(ids.tenant)},${q(ids.foreignTenant)}) and settings->>'qaRun'=${q(slug)};
        commit;`);
      const closed = (await sql(`select count(*)::int count from core.tenants where id in (${q(ids.tenant)},${q(ids.foreignTenant)}) and status='closed' and settings->>'qaRun'=${q(slug)}`))[0];
      assert.equal(closed.count, 2);
    } catch {cleanup = false;}
  }
  for (const user of users) {try {await auth(`admin/users/${user.id}`, {ban_duration: '876000h'}, 'PUT');} catch {cleanup = false;}}
  server?.kill('SIGTERM');
  evidence.fixturesQuarantined = cleanup; evidence.success = evidence.success && cleanup;
  await writeFile('/tmp/operational-governance-staging-evidence.json', JSON.stringify(evidence, null, 2));
  if (!cleanup && !failure) failure = new Error('Synthetic fixture quarantine failed; release remains blocked.');
}
if (failure) throw failure;
console.log('Authenticated operational-governance staging checks passed. Synthetic tenants closed and test users disabled; no migrations or global workers executed.');
