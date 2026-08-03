import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';

const migrationsUrl=new URL('../supabase/migrations/',import.meta.url);
const expected=[
  '20260726210000_clean_platform_foundation_v2.sql',
  '20260726211500_add_v2_read_isolation_policies.sql',
  '20260726211556_tenant_provisioning_cycle_v2.sql',
  '20260726211801_index_tenant_invitation_subjects.sql',
  '20260727003000_add_people_academy_and_full_plan.sql',
  '20260727004000_seed_reef_skills_tenant.sql',
  '20260727004500_index_people_academy_references.sql',
  '20260727110338_add_staff_profile_activation_and_role_routes.sql',
  '20260727192319_add_operational_crm_and_work_v2.sql',
  '20260727193725_index_operational_foreign_keys.sql',
  '20260727211527_lead_centric_sales_pipeline.sql',
  '20260727223000_admissions_and_sales_guards_v2.sql',
  '20260727223500_admissions_reference_indexes_v2.sql',
  '20260727230548_course_runs_and_schedules_v2.sql',
  '20260728003500_learner_operations_v2.sql',
  '20260728005200_learner_operations_reference_indexes_v2.sql',
  '20260728014500_training_communications_zoom_automation_v2.sql',
  '20260728015000_training_automation_reference_indexes_v2.sql',
  '20260728030000_integration_hub_and_message_templates_v2.sql',
  '20260728030500_integration_hub_reference_indexes_v2.sql',
  '20260728043000_live_sandbox_delivery_gateway_v2.sql',
  '20260728050000_automation_rules_engine_v2.sql',
  '20260728051500_automation_sandbox_receipts_v2.sql',
  '20260728054500_delivery_proof_analytics_v2.sql',
  '20260728061500_modular_addons_usage_v2.sql',
  '20260728065000_reef_six_learner_cycle_qa_v2.sql',
  '20260728124500_lead_intake_distribution_analytics_v2.sql',
  '20260729170000_add_tenant_staff_password_reset.sql',
  '20260729180500_reconcile_staff_auth_activation.sql',
  '20260729191730_fix_incentive_course_title.sql',
  '20260729195526_harden_legacy_engagement_storage.sql',
  '20260729213000_goals_incentives_v2.sql',
  '20260729215925_yeastar_p550_telephony_v2.sql',
  '20260729220243_yeastar_sync_runs_tenant_index.sql',
  '20260730170651_role_based_employee_dashboards_v2.sql',
  '20260730172630_fix_role_dashboard_membership_resolution.sql',
  '20260730185254_fix_yeastar_v1_sync_window_context.sql',
  '20260730204215_tenant_reporting_center_v1.sql',
  '20260731023000_woocommerce_course_commerce_sync_v1.sql',
  '20260731040000_multi_store_commerce_hub_core_v1.sql',
  '20260731040100_multi_store_commerce_data_plane_v1.sql',
  '20260731040200_multi_store_commerce_snapshot_v1.sql',
  '20260731040210_multi_store_commerce_tenant_actions_v1.sql',
  '20260731040220_multi_store_commerce_service_api_v1.sql',
  '20260731040230_multi_store_commerce_runtime_v1.sql',
  '20260731123000_activate_multi_store_commerce_hub_v1.sql',
  '20260801005000_knowledge_content_foundation_v1.sql',
  '20260801010000_knowledge_intelligence_hub_v1.sql',
  '20260801011000_knowledge_intelligence_hardening_v1.sql',
  '20260801012000_knowledge_source_stability_v1.sql',
  '20260802003000_replace_static_workspace_and_platform_metrics.sql',
  '20260802004000_baseline_yeastar_sync_after_operational_reset.sql',
  '20260802005000_enforce_settings_and_commerce_permissions_at_rpc_boundary.sql',
  '20260802006000_harden_legacy_market_and_operations_helpers.sql',
  '20260802007000_align_commerce_snapshot_with_workspace_access.sql',
  '20260802232000_role_guide_v1.sql',
  '20260802233000_operational_role_visibility_and_personal_reports.sql',
  '20260802234000_sales_teams_and_achievement_board_v1.sql',
  '20260802235000_employee_yeastar_extensions_v1.sql',
  '20260802235500_gate_yeastar_employee_extension_by_addon_v1.sql',
  '20260802241100_tenant_role_management_snapshots_v1.sql',
  '20260802241200_tenant_role_management_actions_v1.sql',
  '20260803010000_tenant_customer_search_v1.sql',
  '20260803020000_marketing_hub_core_v1.sql',
  '20260803020100_marketing_hub_tenant_actions_v1.sql',
  '20260803020200_marketing_hub_service_api_v1.sql',
  '20260803020300_marketing_hub_attribution_snapshot_v1.sql',
  '20260803020400_marketing_hub_fk_indexes_v1.sql',
  '20260803141411_marktone_public_site_cms_v1.sql',
  '20260803143208_marktone_public_site_cms_hardening_v1.sql'
];

const sqlFiles=(await readdir(migrationsUrl))
  .filter(file=>file.endsWith('.sql'))
  .sort();
assert.deepEqual(
  sqlFiles,
  expected,
  'the v2 branch must contain only reviewed forward migrations'
);

const sqlByFile=new Map(
  await Promise.all(expected.map(async file=>[
    file,
    await readFile(new URL(file,migrationsUrl),'utf8')
  ]))
);
const allSql=[...sqlByFile.values()].join('\n');

for(const pattern of [
  /create schema if not exists core;/,
  /create schema if not exists access_control;/,
  /create schema if not exists people;/,
  /create schema if not exists academy;/,
  /create schema if not exists sales_core;/,
  /create schema if not exists work_core;/,
  /create schema if not exists telephony;/,
  /create schema if not exists incentives_core;/,
  /create schema if not exists communication_hub;/,
  /create schema if not exists automation_engine;/,
  /create schema if not exists commerce_sync;/,
  /create schema if not exists commerce_hub;/,
  /create schema if not exists marketing_hub;/,
  /create schema if not exists website;/,
  /v2_current_user_context/,
  /v2_platform_control_snapshot/,
  /v2_tenant_workspace_snapshot/,
  /v2_tenant_operations_snapshot/,
  /v2_tenant_sales_pipeline_snapshot/,
  /v2_tenant_admissions_snapshot/,
  /v2_tenant_training_operations_snapshot/,
  /v2_tenant_training_automation_snapshot/,
  /v2_tenant_integration_hub_snapshot/,
  /v2_tenant_incentives_snapshot/,
  /v2_tenant_role_dashboard_snapshot/,
  /v2_tenant_reports_snapshot_v1/,
  /v2_tenant_woocommerce_snapshot/,
  /v2_tenant_commerce_hub_snapshot/,
  /v2_tenant_role_guide_snapshot/,
  /v2_tenant_role_guide_action/,
  /v2_tenant_effective_roles_snapshot/,
  /v2_tenant_role_management_snapshot/,
  /v2_tenant_role_management_action/,
  /v2_tenant_customer_search/,
  /v2_tenant_marketing_hub_snapshot/,
  /v2_tenant_marketing_hub_action/,
  /v2_marketing_hub_refresh_attribution/,
  /v2_public_site_snapshot/,
  /v2_public_site_submit_contact/,
  /v2_platform_site_snapshot/,
  /v2_platform_site_action/,
  /platform\.website\.manage/,
  /tenant\.integrations\.manage/,
  /tenant\.marketing\.manage/,
  /tenant\.users\.reset_password/,
  /tenant\.leads\.import/,
  /enable row level security/,
  /vault\.create_secret/,
  /cron\.schedule/
])assert.match(allSql,pattern);

const foundation=sqlByFile.get(
  '20260801005000_knowledge_content_foundation_v1.sql'
);
for(const pattern of [
  /create table if not exists public\.knowledge_categories/,
  /create table if not exists public\.knowledge_sources/,
  /create table if not exists public\.knowledge_posts/,
  /public reads active knowledge categories/,
  /public reads published knowledge posts/,
  /platform admins manage knowledge sources/,
  /training-news/,
  /tenders-opportunities/,
  /alerts-regulations/
])assert.match(foundation,pattern);

const knowledge=sqlByFile.get(
  '20260801010000_knowledge_intelligence_hub_v1.sql'
);
for(const pattern of [
  /create table if not exists public\.knowledge_ingestion_runs/,
  /create table if not exists public\.knowledge_raw_items/,
  /create table if not exists public\.knowledge_bookmarks/,
  /v2_tenant_knowledge_snapshot/,
  /v2_tenant_knowledge_action/,
  /knowledge_ingestion_validate_secret/,
  /knowledge_ingestion_secret/,
  /marktone-knowledge-ingestion/,
  /knowledge-ingest/,
  /platform\.is_platform_content_admin/,
  /private_app\.has_tenant_permission/,
  /source_fingerprint/,
  /why_it_matters/,
  /recommended_action/
])assert.match(knowledge,pattern);

const hardening=sqlByFile.get(
  '20260801011000_knowledge_intelligence_hardening_v1.sql'
);
for(const pattern of [
  /anonymous reads active knowledge categories/,
  /authenticated reads visible knowledge posts/,
  /auth_user_id = \(select auth\.uid\(\)\)/,
  /knowledge_sources_default_category_idx/,
  /knowledge_raw_items_run_idx/,
  /knowledge_bookmarks_post_idx/,
  /knowledge_read_events_tenant_time_idx/,
  /https:\/\/www\.hrsd\.gov\.sa\/media-center\/news/,
  /https:\/\/nelc\.gov\.sa\/ar\/media-center\/news/,
  /https:\/\/www\.monshaat\.gov\.sa\/ar/
])assert.match(hardening,pattern);

const stability=sqlByFile.get(
  '20260801012000_knowledge_source_stability_v1.sql'
);
for(const pattern of [
  /https:\/\/nelc\.gov\.sa\//,
  /\^\/(?:\(\?:ar\/\)\?)?media-center\/news/,
  /where source_key = 'tvtc-official-news'/,
  /where source_key = 'monshaat-official-news'/,
  /is_active = false/,
  /requires_review = true/,
  /auto_publish = false/
])assert.match(stability,pattern);

const roleGuide=sqlByFile.get('20260802232000_role_guide_v1.sql');
const operationalRoleVisibility=sqlByFile.get(
  '20260802233000_operational_role_visibility_and_personal_reports.sql'
);
const salesTeams=sqlByFile.get(
  '20260802234000_sales_teams_and_achievement_board_v1.sql'
);
const staffExtensions=sqlByFile.get(
  '20260802235000_employee_yeastar_extensions_v1.sql'
);
const yeastarAddonGate=sqlByFile.get(
  '20260802235500_gate_yeastar_employee_extension_by_addon_v1.sql'
);
const websiteCms=sqlByFile.get(
  '20260803141411_marktone_public_site_cms_v1.sql'
);
const websiteCmsHardening=sqlByFile.get(
  '20260803143208_marktone_public_site_cms_hardening_v1.sql'
);

for(const pattern of [
  /create table if not exists people\.role_guide_progress/,
  /unique \(tenant_id, subject_id, guide_version\)/,
  /status in \('not_started','in_progress','completed','skipped','dismissed'\)/,
  /v2_tenant_role_guide_snapshot/,
  /v2_tenant_role_guide_action/,
  /private_app\.can_access_tenant/,
  /revoke all on table people\.role_guide_progress/,
  /grant execute on function public\.v2_tenant_role_guide_snapshot/
])assert.match(roleGuide,pattern);

for(const pattern of [
  /v2_tenant_reports_snapshot_v2/,
  /v2_tenant_yeastar_reports_snapshot_v2/,
  /v_personal_only/,
  /p_report = 'campaigns' and not v_campaign_allowed/,
  /record\.involved_extensions && v_staff_extensions/,
  /revoke all on function public\.v2_tenant_reports_snapshot_v1[\s\S]*from authenticated/,
  /grant execute on function public\.v2_tenant_reports_snapshot_v2[\s\S]*to authenticated, service_role/
])assert.match(operationalRoleVisibility,pattern);

for(const pattern of [
  /supervisor_staff_id/,
  /v2_tenant_sales_team_snapshot/,
  /v2_tenant_assign_sales_team_member/,
  /v2_tenant_employee_achievement_snapshot/,
  /dense_rank\(\)/,
  /peer\.supervisor_staff_id = v_supervisor_id/,
  /tenant\.people\.manage/
])assert.match(salesTeams,pattern);

for(const pattern of [
  /v2_tenant_staff_extension_snapshot/,
  /v2_tenant_assign_staff_extension/,
  /extensionAssignments/,
  /tenant\.people\.read/,
  /tenant\.people\.manage/,
  /yeastar_extension_already_assigned/,
  /array_to_string\(v_extensions, ', '\)/,
  /revoke all on function public\.v2_tenant_assign_staff_extension[\s\S]*from public, anon/,
  /grant execute on function public\.v2_tenant_assign_staff_extension[\s\S]*to authenticated/
])assert.match(staffExtensions,pattern);

for(const pattern of [
  /addon\.integration\.yeastar/,
  /product_key[\s\S]*'yeastar'/,
  /private_app\.tenant_addon_installed/,
  /subscription\.status in \('trialing', 'active'\)/,
  /'enabled', v_enabled/,
  /addon_not_installed/,
  /yeastar_addon_not_enabled/,
  /legacy_yeastar_connection/
])assert.match(yeastarAddonGate,pattern);

for(const pattern of [
  /create table if not exists website\.sites/,
  /create table if not exists website\.menu_items/,
  /create table if not exists website\.sections/,
  /create table if not exists website\.pages/,
  /create table if not exists website\.articles/,
  /create table if not exists website\.contact_submissions/,
  /revoke all on schema website from public, anon, authenticated/,
  /grant execute on function public\.v2_public_site_snapshot[\s\S]*to anon, authenticated/,
  /grant execute on function public\.v2_platform_site_action[\s\S]*to authenticated/
])assert.match(websiteCms,pattern);

for(const pattern of [
  /website_sync_page_menu/,
  /old\.slug is distinct from new\.slug/,
  /new\.show_in_menu/,
  /status='archived',is_visible=false/
])assert.match(websiteCmsHardening,pattern);

assert.doesNotMatch(
  knowledge,
  /delete from public\.knowledge_posts|drop table public\.knowledge_posts/i
);
assert.doesNotMatch(
  `${foundation}\n${knowledge}\n${hardening}\n${stability}\n${roleGuide}\n${staffExtensions}\n${yeastarAddonGate}\n${websiteCms}\n${websiteCmsHardening}`,
  /grant\s+all[\s\S]+to\s+anon/i
);

console.log(
  `Verified ${expected.length} forward migrations, including the secured Marktone website CMS, add-on-gated Yeastar employee extensions, secure sales teams, the interactive My Role guide, and the review-first Knowledge Intelligence Hub.`
);
