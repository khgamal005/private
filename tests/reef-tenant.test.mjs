import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('Reef is provisioned as the first active full-plan tenant',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  assert.match(seed,/'tenant-reef-skills'/);
  assert.match(seed,/'reef-skills'/);
  assert.match(seed,/'active'/);
  assert.match(seed,/p\.plan_key = 'full'/);
  assert.match(seed,/'entitlement', 'full'/);
});

test('the initial Reef team contains the requested eleven named profiles',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  for(const name of ['نور','مي','ليلى','روان','عبدالجليل','عمر','رزان','ياسمين','داليا','وعد','ياسر']){
    assert.match(seed,new RegExp(`'${name}'`));
  }
  assert.match(seed,/'sales_supervisor'/);
  assert.match(seed,/'customer_service'/);
  assert.match(seed,/'data_officer'/);
  assert.match(seed,/'data_analyst'/);
});

test('the Reef catalog contains the initial six courses without invented pricing',async()=>{
  const seed=await read('../supabase/migrations/20260727004000_seed_reef_skills_tenant.sql');
  for(const code of ['PMP','AI-SKILLS','POWER-BI','KPI','EXCEL-ADV','APHRI']){
    assert.match(seed,new RegExp(`'${code}'`));
  }
  assert.doesNotMatch(seed,/price_minor,\s*[1-9]/);
  assert.match(seed,/'pricingStatus', 'pending'/);
});

test('team and courses are first-class tenant routes backed by v2 RPCs',async()=>{
  const shell=await read('../components/workspace-shell.js');
  const api=await read('../app/api/tenant/[action]/route.js');
  const team=await read('../components/team-directory.js');
  const auth=await read('../lib/server-auth.js');
  const data=await read('../lib/api.js');
  assert.match(shell,/\/team/);
  assert.match(shell,/\/courses/);
  assert.match(shell,/tenant\.people\.read/);
  assert.match(shell,/tenant\.users\.manage/);
  assert.match(api,/v2_tenant_create_staff/);
  assert.match(api,/v2_tenant_update_staff/);
  assert.match(api,/v2_tenant_invite_staff/);
  assert.match(api,/v2_tenant_create_course/);
  assert.match(team,/تعديل البيانات/);
  assert.match(team,/دعوة للدخول/);
  assert.match(team,/@reefskills\.sa/);
  assert.match(auth,/requireTenantPermission/);
  assert.match(data,/users:access\.employees/);
  assert.match(data,/employees:workspace\.employees/);
});

test('role-protected tenant routes enforce their permissions on the server',async()=>{
  const routes=[
    ['../app/tenant/[slug]/page.js','tenant.workspace.read'],
    ['../app/tenant/[slug]/tasks/page.js','tenant.work.read'],
    ['../app/tenant/[slug]/sales/page.js','tenant.crm.read'],
    ['../app/tenant/[slug]/admissions/page.js','tenant.admissions.read'],
    ['../app/tenant/[slug]/incentives/page.js','tenant.incentives.read'],
    ['../app/tenant/[slug]/team/page.js','tenant.people.read'],
    ['../app/tenant/[slug]/courses/page.js','tenant.academy.read'],
    ['../app/tenant/[slug]/settings/page.js','tenant.users.manage'],
    ['../app/tenant/[slug]/news/page.js','tenant.content.read']
  ];
  for(const [path,permission] of routes){
    const source=await read(path);
    assert.match(source,/requireTenantPermission/);
    assert.match(source,new RegExp(permission.replaceAll('.','\\.')));
  }
});

test('temporary-password redirects finish before protected tenant data loads',async()=>{
  const routes=[
    ['../app/tenant/[slug]/layout.js','requireTenant','getTenant'],
    [
      '../app/tenant/[slug]/team/page.js',
      'requireTenantPermission',
      'getTenant'
    ],
    [
      '../app/tenant/[slug]/courses/page.js',
      'requireTenantPermission',
      'getTenant'
    ]
  ];

  for(const [path,gate,dataCall] of routes){
    const source=await read(path);
    const gateAwait=source.indexOf(`await ${gate}(`);
    const protectedFetch=source.indexOf(`${dataCall}(`,gateAwait+1);
    assert.notEqual(gateAwait,-1,`${path} must await its auth gate`);
    assert.notEqual(protectedFetch,-1,`${path} must load tenant data`);
    assert.ok(
      gateAwait<protectedFetch,
      `${path} must finish its auth gate before protected tenant RPCs`
    );
  }
});

test('employee tenant routes do not eagerly load administrator-only settings',async()=>{
  const data=await read('../lib/api.js');
  const overview=await read('../app/tenant/[slug]/page.js');
  const tasks=await read('../app/tenant/[slug]/tasks/page.js');
  const settings=await read('../app/tenant/[slug]/settings/page.js');
  const getTenantBody=data.match(
    /export async function getTenant\(slug(?:,\{[\s\S]*?\}=\{\})?\)\{([\s\S]*?)\n\}\n\nexport async function getTenantWooCommerce/
  )?.[1]||'';
  const getSettingsBody=data.match(
    /export async function getTenantSettings\(slug\)\{([\s\S]*?)\n\}\n\nexport async function getTenantOperations/
  )?.[1]||'';

  assert.match(getTenantBody,/v2_tenant_workspace_snapshot/);
  assert.match(getTenantBody,/v2_tenant_access_snapshot/);
  assert.doesNotMatch(getTenantBody,/integration_hub|automation_studio|delivery_analytics|addon_center/);
  assert.match(getSettingsBody,/v2_tenant_integration_hub_snapshot/);
  assert.match(getSettingsBody,/v2_tenant_automation_studio_snapshot_v2/);
  assert.match(getSettingsBody,/v2_tenant_delivery_analytics_snapshot_v2/);
  assert.match(getSettingsBody,/v2_tenant_addon_center_snapshot/);
  assert.match(settings,/getTenantSettings/);
  assert.match(data,/includeSales=true/);
  assert.match(data,/includeSales\s*\?authRpc\('v3_tenant_sales_pipeline_snapshot'/);
  assert.match(overview,/includeSales:canReadCrm/);
  assert.match(tasks,/getTenantOperations\(slug,\{includeSales\}\)/);
});

test('Reef daily operations are backed by isolated v2 CRM and work RPCs',async()=>{
  const migration=await read('../supabase/migrations/20260727192319_add_operational_crm_and_work_v2.sql');
  const leadPipeline=await read('../supabase/migrations/20260727211527_lead_centric_sales_pipeline.sql');
  const admissionsMigration=await read('../supabase/migrations/20260727223000_admissions_and_sales_guards_v2.sql');
  const courseRunsMigration=await read('../supabase/migrations/20260727230548_course_runs_and_schedules_v2.sql');
  const learnerOperationsMigration=await read('../supabase/migrations/20260728003500_learner_operations_v2.sql');
  const trainingAutomationMigration=await read('../supabase/migrations/20260728014500_training_communications_zoom_automation_v2.sql');
  const trainingAutomationIndexes=await read('../supabase/migrations/20260728015000_training_automation_reference_indexes_v2.sql');
  const trainingAutomationEdge=await read('../supabase/functions/training-automation-dispatch/index.ts');
  const supabaseConfig=await read('../supabase/config.toml');
  const api=await read('../app/api/tenant/[action]/route.js');
  const data=await read('../lib/api.js');
  const sales=await read('../components/sales-workspace.js');
  const admissions=await read('../components/admissions-workspace.js');
  const shell=await read('../components/workspace-shell.js');
  const tasks=await read('../components/task-calendar-page.js');
  const followupModal=await read('../components/sales-followup-modal.js');
  const learnerOperations=await read('../components/learner-operations-workspace.js');
  const certificatePage=await read('../app/tenant/[slug]/certificates/[certificateId]/page.js');
  const styles=await read('../app/rebuild.css');

  assert.match(migration,/create schema if not exists sales_core/);
  assert.match(migration,/create schema if not exists work_core/);
  assert.match(migration,/v2_tenant_operations_snapshot/);
  assert.match(migration,/v2_tenant_create_contact/);
  assert.match(migration,/v2_tenant_create_opportunity/);
  assert.match(migration,/v2_tenant_log_activity/);
  assert.match(migration,/v2_tenant_create_task/);
  assert.match(migration,/v2_tenant_update_task_status/);
  assert.match(migration,/next_action_required/);
  assert.match(migration,/sales_contacts_isolated_read/);
  assert.match(migration,/work_tasks_isolated_read/);
  assert.doesNotMatch(migration,/service_role|SUPABASE_SECRET/i);

  assert.match(api,/v2_tenant_create_contact/);
  assert.match(api,/v2_tenant_create_opportunity/);
  assert.match(api,/v2_tenant_log_activity/);
  assert.match(api,/v2_tenant_create_task/);
  assert.match(api,/v2_tenant_update_task_status/);
  assert.match(data,/v2_tenant_operations_snapshot/);
  assert.match(data,/v3_tenant_sales_pipeline_snapshot/);
  assert.match(api,/v2_tenant_create_sales_lead/);
  assert.match(api,/v2_tenant_record_sales_followup_v4/);
  assert.match(leadPipeline,/academy\.registration_handoffs/);
  assert.match(leadPipeline,/v2_tenant_record_sales_followup/);
  assert.match(admissionsMigration,/paymentReviewNotified/);
  assert.match(admissionsMigration,/closure_reason_required/);
  assert.match(admissionsMigration,/work_tasks_one_open_sales_followup_idx/);
  assert.match(admissionsMigration,/v2_tenant_admissions_snapshot/);
  assert.match(admissionsMigration,/create table academy\.students/);
  assert.match(admissionsMigration,/create table academy\.enrollments/);
  assert.match(courseRunsMigration,/create table academy\.course_run_sessions/);
  assert.match(courseRunsMigration,/v2_tenant_course_runs_snapshot/);
  assert.match(courseRunsMigration,/v2_tenant_save_course_run/);
  assert.match(courseRunsMigration,/course_run_not_open/);
  assert.match(courseRunsMigration,/course_run_sessions_overlap/);
  assert.match(courseRunsMigration,/'demo',\s*true/);
  assert.match(learnerOperationsMigration,/create table academy\.attendance_records/);
  assert.match(learnerOperationsMigration,/create table academy\.assessment_results/);
  assert.match(learnerOperationsMigration,/create table academy\.student_communications/);
  assert.match(learnerOperationsMigration,/create table academy\.certificates/);
  assert.match(learnerOperationsMigration,/v2_tenant_training_operations_snapshot/);
  assert.match(learnerOperationsMigration,/v2_tenant_update_training_operation/);
  assert.match(learnerOperationsMigration,/v2_tenant_certificate_snapshot/);
  assert.match(learnerOperationsMigration,/training_manager/);
  assert.match(learnerOperationsMigration,/certificate_not_eligible/);
  assert.match(learnerOperationsMigration,/'learner-operations-v2'/);
  assert.match(trainingAutomationMigration,/create table academy\.training_automation_jobs/);
  assert.match(trainingAutomationMigration,/v2_tenant_training_automation_snapshot/);
  assert.match(trainingAutomationMigration,/v2_tenant_training_automation_action/);
  assert.match(trainingAutomationMigration,/v2_training_automation_claim_jobs/);
  assert.match(trainingAutomationMigration,/v2_training_automation_complete_job/);
  assert.match(trainingAutomationMigration,/training_automation_secret/);
  assert.match(trainingAutomationMigration,/cron\.schedule/);
  assert.match(trainingAutomationMigration,/meeting_join_url/);
  assert.match(trainingAutomationIndexes,/training_automation_jobs_course_run_reference_idx/);
  assert.match(trainingAutomationEdge,/graph\.facebook\.com/);
  assert.match(trainingAutomationEdge,/api\.resend\.com\/emails/);
  assert.match(trainingAutomationEdge,/api\.zoom\.us\/v2\/users/);
  assert.match(trainingAutomationEdge,/ZOOM_ACCOUNT_ID/);
  assert.match(trainingAutomationEdge,/META_WHATSAPP_JOINING_TEMPLATE/);
  assert.doesNotMatch(trainingAutomationEdge,/start_url/);
  assert.match(supabaseConfig,/training-automation-dispatch/);
  assert.match(supabaseConfig,/verify_jwt = false/);
  assert.match(api,/v2_tenant_update_admission/);
  assert.match(api,/v2_tenant_save_course_run/);
  assert.match(api,/v2_tenant_update_training_operation/);
  assert.match(api,/v2_tenant_training_automation_action/);
  assert.match(data,/v2_tenant_admissions_snapshot/);
  assert.match(data,/v2_tenant_course_runs_snapshot/);
  assert.match(data,/v2_tenant_training_operations_snapshot/);
  assert.match(data,/v2_tenant_training_automation_snapshot/);
  assert.match(data,/v2_tenant_certificate_snapshot/);
  assert.match(shell,/tenant\.admissions\.read/);
  assert.match(admissions,/تأكيد الدفع/);
  assert.match(admissions,/إنشاء المتدرب وإتمام التسجيل/);
  assert.match(admissions,/الدفعات والجداول/);
  assert.match(admissions,/تشغيل المتدربين/);
  assert.match(learnerOperations,/رسالة الانضمام/);
  assert.match(learnerOperations,/الحضور حسب الجلسة/);
  assert.match(learnerOperations,/التقييم النهائي/);
  assert.match(learnerOperations,/إصدار الشهادة/);
  assert.match(learnerOperations,/الرسائل والاجتماعات التلقائية/);
  assert.match(learnerOperations,/إرسال آلي واتساب/);
  assert.match(learnerOperations,/فتح واتساب يدويًا/);
  assert.match(learnerOperations,/إنشاء الاجتماع/);
  assert.match(learnerOperations,/سجل الرسائل والاجتماعات/);
  assert.match(certificatePage,/شهادة إتمام برنامج تدريبي/);
  assert.match(sales,/تسجيل نتيجة المتابعة/);
  assert.match(sales,/mt-followup-button/);
  assert.match(sales,/بانتظار الدفع/);
  assert.match(sales,/جودة الليد/);
  assert.doesNotMatch(sales,/فرصة جديدة/);
  assert.match(sales,/الإجراء التالي/);
  assert.match(sales,/فترة المتابعة القادمة/);
  assert.match(sales,/7 أيام/);
  assert.match(sales,/label:'جديد',statuses:\['new','no_answer','busy','follow_up','postponed'\]/);
  assert.match(tasks,/SalesFollowupModal/);
  assert.match(tasks,/المتابعة فقط/);
  assert.match(tasks,/اضغط متابعة العميل/);
  assert.match(followupModal,/نتيجة المتابعة/);
  assert.match(followupModal,/الدورة المهتم بها/);
  assert.match(followupModal,/p_course_id:values\.course_id\|\|null/);
  assert.doesNotMatch(followupModal,/p_course_id:paymentSubmitted/);
  assert.match(followupModal,/موعد الإجراء التالي/);
  assert.match(followupModal,/بلاغ دفع بانتظار التحقق/);
  assert.match(followupModal,/سبب الإغلاق/);
  assert.match(styles,/grid-template-columns:repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(styles,/mt-learner-grid/);
  assert.match(styles,/mt-certificate-sheet/);
  assert.match(styles,/mt-automation-panel/);
  assert.match(styles,/mt-provider-grid/);
  assert.match(styles,/mt-session-meeting/);
});

test('Reef operational sample data is clearly marked and uses placeholder contacts',async()=>{
  const migration=await read('../supabase/migrations/20260727192319_add_operational_crm_and_work_v2.sql');
  assert.match(migration,/'reef-operations-v1'/);
  assert.match(migration,/'demo', true/);
  assert.match(migration,/'0500000101'/);
  assert.match(migration,/'reef-demo-012'/);
  assert.match(migration,/'REEF-SALES-007'/);
});

test('the integration hub keeps providers modular, secrets encrypted, and templates reusable',async()=>{
  const migration=await read('../supabase/migrations/20260728030000_integration_hub_and_message_templates_v2.sql');
  const indexes=await read('../supabase/migrations/20260728030500_integration_hub_reference_indexes_v2.sql');
  const dispatcher=await read('../supabase/functions/training-automation-dispatch/index.ts');
  const hub=await read('../components/integration-hub.js');
  const settings=await read('../components/tenant-settings.js');
  const api=await read('../app/api/tenant/[action]/route.js');
  const data=await read('../lib/api.js');
  const styles=await read('../app/rebuild.css');

  assert.match(migration,/create schema if not exists communication_hub/);
  assert.match(migration,/create table communication_hub\.provider_catalog/);
  assert.match(migration,/create table communication_hub\.provider_connections/);
  assert.match(migration,/create table communication_hub\.message_templates/);
  assert.match(migration,/'meta_whatsapp'/);
  assert.match(migration,/'resend'/);
  assert.match(migration,/'amazon_ses'/);
  assert.match(migration,/'custom_webhook'/);
  assert.match(migration,/'addon\.integration\.whatsapp'/);
  assert.match(migration,/'addon\.integration\.email'/);
  assert.match(migration,/'addon\.integration\.api'/);
  assert.match(migration,/'addon\.communication\.templates'/);
  assert.match(migration,/vault\.create_secret/);
  assert.match(migration,/vault\.update_secret/);
  assert.match(migration,/configuredSecrets/);
  assert.match(migration,/revoke all on all tables in schema communication_hub/);
  assert.match(migration,/v2_tenant_integration_hub_snapshot/);
  assert.match(migration,/v2_tenant_integration_hub_action/);
  assert.match(migration,/v2_tenant_integration_test_authorize/);
  assert.match(migration,/v2_integration_provider_configuration/);
  assert.match(migration,/joining_instructions/);
  assert.match(migration,/session_reminder_24h/);
  assert.match(migration,/certificate_ready/);
  assert.match(indexes,/provider_connections_provider_reference_idx/);
  assert.match(indexes,/provider_connections_creator_reference_idx/);
  assert.match(indexes,/provider_connections_updater_reference_idx/);
  assert.match(indexes,/message_templates_creator_reference_idx/);
  assert.match(indexes,/message_templates_updater_reference_idx/);
  for(const variable of ['name','course','date','time','link','certificate_link']){
    assert.match(migration,new RegExp(`'${variable}'`));
  }

  assert.match(dispatcher,/AWS4-HMAC-SHA256/);
  assert.match(dispatcher,/email\.\$\{region\}\.amazonaws\.com/);
  assert.match(dispatcher,/api\.resend\.com\/emails/);
  assert.match(dispatcher,/graph\.facebook\.com/);
  assert.match(dispatcher,/x-marktone-signature/);
  assert.match(dispatcher,/safeWebhookUrl/);
  assert.match(dispatcher,/v2_integration_provider_configuration/);
  assert.match(dispatcher,/v2_tenant_integration_test_authorize/);

  assert.match(settings,/الربط وواجهات API/);
  assert.match(settings,/قوالب الرسائل/);
  assert.match(settings,/IntegrationHub/);
  assert.match(hub,/Amazon SES أو Resend/);
  assert.match(hub,/اختبار الاتصال/);
  assert.match(hub,/نماذج جاهزة بمتغيرات تخصيص ذكية/);
  assert.match(hub,/لن يعرضها النظام/);
  assert.match(api,/v2_tenant_integration_hub_action/);
  assert.match(api,/training-automation-dispatch/);
  assert.match(api,/test_connection/);
  assert.match(data,/v2_tenant_integration_hub_snapshot/);
  assert.match(styles,/mt-integration-provider-grid/);
  assert.match(styles,/mt-template-editor/);
  assert.match(styles,/mt-preview-device/);
});

test('automation rules execute real domain events with preview, fallback, and deduplication',async()=>{
  const sandbox=await read('../supabase/migrations/20260728043000_live_sandbox_delivery_gateway_v2.sql');
  const migration=await read('../supabase/migrations/20260728050000_automation_rules_engine_v2.sql');
  const receiptBridge=await read('../supabase/migrations/20260728051500_automation_sandbox_receipts_v2.sql');
  const dispatcher=await read('../supabase/functions/training-automation-dispatch/index.ts');
  const studio=await read('../components/automation-studio.js');
  const settings=await read('../components/tenant-settings.js');
  const api=await read('../app/api/tenant/[action]/route.js');
  const data=await read('../lib/api.js');
  const styles=await read('../app/rebuild.css');

  assert.match(sandbox,/marktone_sandbox_whatsapp/);
  assert.match(sandbox,/simulated_not_sent_to_recipient/);
  assert.match(migration,/create schema if not exists automation_engine/);
  assert.match(migration,/create table automation_engine\.rules/);
  assert.match(migration,/create table automation_engine\.events/);
  assert.match(migration,/create table communication_hub\.message_outbox/);
  assert.match(migration,/payment_automation_event/);
  assert.match(migration,/enrollment_automation_event/);
  assert.match(migration,/absence_automation_event/);
  assert.match(migration,/certificate_automation_event/);
  assert.match(migration,/session_change_automation_event/);
  assert.match(migration,/unique \(tenant_id, idempotency_key\)/);
  assert.match(migration,/unique \(tenant_id, dedupe_key\)/);
  assert.match(migration,/fallback_queued/);
  assert.match(migration,/preview_not_queued/);
  assert.match(receiptBridge,/message_outbox_id/);
  assert.match(receiptBridge,/sandbox_receipts_outbox_reference_idx/);
  assert.match(migration,/revoke all on all tables in schema automation_engine/);
  assert.match(dispatcher,/v2_automation_claim_messages/);
  assert.match(dispatcher,/v2_automation_complete_message/);
  assert.match(dispatcher,/queue === 'automation'/);
  assert.match(dispatcher,/queue: job\.queue \|\| 'training'/);
  assert.match(studio,/عند حدوث/);
  assert.match(studio,/معالجة الطابور الآن/);
  assert.match(studio,/معاينة الرسالة/);
  assert.match(settings,/AutomationStudio/);
  assert.match(api,/v2_tenant_automation_studio_action/);
  assert.match(data,/v2_tenant_automation_studio_snapshot/);
  assert.match(styles,/mt-automation-rule-grid/);
});

test('delivery evidence is signed, idempotent, privacy-safe, and connected to analytics',async()=>{
  const migration=await read('../supabase/migrations/20260728054500_delivery_proof_analytics_v2.sql');
  const dispatcher=await read('../supabase/functions/training-automation-dispatch/index.ts');
  const analytics=await read('../components/delivery-analytics.js');
  const settings=await read('../components/tenant-settings.js');
  const api=await read('../app/api/tenant/[action]/route.js');
  const data=await read('../lib/api.js');
  const styles=await read('../app/rebuild.css');

  assert.match(migration,/create table communication_hub\.delivery_webhooks/);
  assert.match(migration,/create table communication_hub\.delivery_events/);
  assert.match(migration,/extensions\.hmac/);
  assert.match(migration,/abs\(extract\(epoch/);
  assert.match(migration,/unique \(provider_connection_id, provider_event_id\)/);
  assert.match(migration,/delivery_state_rank/);
  assert.match(migration,/v2_delivery_webhook_receive/);
  assert.match(migration,/v2_tenant_delivery_analytics_snapshot/);
  assert.match(migration,/cost_minor/);
  assert.match(migration,/billable/);
  assert.match(migration,/revoke all on table communication_hub\.delivery_events/);
  assert.doesNotMatch(migration,/message_text.*payload_summary/);
  assert.match(dispatcher,/handleDeliveryWebhook/);
  assert.match(dispatcher,/x-marktone-timestamp/);
  assert.match(dispatcher,/v2_delivery_webhook_receive/);
  assert.match(analytics,/إثبات التسليم/);
  assert.match(analytics,/توقيع HMAC/);
  assert.match(analytics,/لن يعرضه النظام مرة أخرى/);
  assert.match(settings,/DeliveryAnalytics/);
  assert.match(api,/v2_tenant_delivery_analytics_action/);
  assert.match(data,/v2_tenant_delivery_analytics_snapshot/);
  assert.match(styles,/mt-delivery-webhook-grid/);
});

test('add-ons have approval, entitlement, quota reservation, and finalized usage',async()=>{
  const migration=await read('../supabase/migrations/20260728061500_modular_addons_usage_v2.sql');
  const dispatcher=await read('../supabase/functions/training-automation-dispatch/index.ts');
  const center=await read('../components/addon-center.js');
  const settings=await read('../components/tenant-settings.js');
  const control=await read('../components/control-workspace.js');
  const tenantApi=await read('../app/api/tenant/[action]/route.js');
  const platformApi=await read('../app/api/platform/[action]/route.js');
  const data=await read('../lib/api.js');
  const styles=await read('../app/rebuild.css');

  assert.match(migration,/create table catalog\.addon_products/);
  assert.match(migration,/create table catalog\.tenant_addon_subscriptions/);
  assert.match(migration,/create table catalog\.addon_usage_counters/);
  assert.match(migration,/create table catalog\.addon_usage_reservations/);
  assert.match(migration,/create table catalog\.addon_usage_events/);
  assert.match(migration,/tenant_addons_one_current_idx/);
  assert.match(migration,/pg_advisory_xact_lock/);
  assert.match(migration,/addon_usage_limit_reached/);
  assert.match(migration,/finalize_addon_reservation/);
  assert.match(migration,/status in \('reserved', 'consumed', 'released'\)/);
  assert.match(migration,/p_result_state in \('sent', 'ready'\)/);
  assert.match(migration,/v2_platform_addon_center_action/);
  assert.match(migration,/v2_tenant_addon_center_snapshot/);
  assert.match(migration,/addon\.integration\.zoom/);
  assert.match(migration,/addon\.communication\.delivery_analytics/);
  assert.match(dispatcher,/reserveUsage/);
  assert.match(dispatcher,/v2_addon_usage_reserve/);
  assert.match(dispatcher,/p_usage_reservation_id/);
  assert.match(center,/المحاكاة والفشل لا يُفوتران/);
  assert.match(center,/طلب تجربة/);
  assert.match(settings,/AddonCenter/);
  assert.match(control,/decideAddon/);
  assert.match(control,/طلبات التجربة والتفعيل/);
  assert.match(tenantApi,/v2_tenant_addon_center_action/);
  assert.match(platformApi,/v2_platform_addon_center_action/);
  assert.match(data,/v2_platform_addon_center_snapshot/);
  assert.match(data,/v2_tenant_addon_center_snapshot/);
  assert.match(styles,/mt-addon-grid/);
});

test('the six-learner QA cycle covers payment through certificate with negative paths',async()=>{
  const migration=await read('../supabase/migrations/20260728065000_reef_six_learner_cycle_qa_v2.sql');

  assert.match(migration,/for v_index in 5\.\.6 loop/);
  assert.match(migration,/payment_status = 'verified'/);
  assert.match(migration,/status = 'completed'/);
  assert.match(migration,/insert into academy\.attendance_records/);
  assert.match(migration,/insert into academy\.assessment_results/);
  assert.match(migration,/private_app\.training_eligibility/);
  assert.match(migration,/assessment_below_threshold/);
  assert.match(migration,/insert into academy\.certificates/);
  assert.match(migration,/private_app\.queue_automation_event/);
  assert.match(migration,/private_app\.process_automation_events/);
  assert.match(migration,/v_enrollments <> 6/);
  assert.match(migration,/v_verified_payments <> 6/);
  assert.match(migration,/v_attendance <> 24/);
  assert.match(migration,/v_assessments <> 5/);
  assert.match(migration,/v_certificates <> 3/);
  assert.match(migration,/v_eligible <> 3/);
  assert.match(migration,/v_ineligible <> 3/);
  assert.match(migration,/v_joining_events <> 6/);
  assert.match(migration,/quality\.learner_cycle\.passed/);
  assert.match(migration,/'containsRealContacts', false/);
});
