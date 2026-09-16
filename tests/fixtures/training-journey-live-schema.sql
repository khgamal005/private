-- Test-only baseline from production metadata captured read-only on 2026-09-16.
-- Auth UID is the only authentication shim. Subjects, roles and permissions use
-- the actual production functions; no production data is copied.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE SCHEMA private_app;
CREATE SCHEMA extensions;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb DEFAULT '{}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT nullif(current_setting('fixture.auth_user_id',true),'')::uuid
$$;
-- Live production metadata, read-only capture 2026-09-16; no business records.
-- Test baseline DDL: FK constraints intentionally supplied separately in constraints.json.
CREATE SCHEMA IF NOT EXISTS academy;
CREATE SCHEMA IF NOT EXISTS access_control;
CREATE SCHEMA IF NOT EXISTS accounting_core;
CREATE SCHEMA IF NOT EXISTS audit_log;
CREATE SCHEMA IF NOT EXISTS core;
CREATE SCHEMA IF NOT EXISTS people;
CREATE SCHEMA IF NOT EXISTS sales_core;
CREATE SCHEMA IF NOT EXISTS work_core;

CREATE TABLE academy.assessment_results (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  assessment_key text NOT NULL DEFAULT 'final'::text,
  title text NOT NULL DEFAULT 'التقييم النهائي'::text,
  score numeric(10,2) NOT NULL,
  max_score numeric(10,2) NOT NULL DEFAULT 100,
  notes text,
  assessed_at timestamp with time zone NOT NULL DEFAULT now(),
  assessed_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.attendance_records (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  session_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  status text NOT NULL,
  minutes_late integer NOT NULL DEFAULT 0,
  notes text,
  marked_at timestamp with time zone NOT NULL DEFAULT now(),
  marked_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.certificates (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  certificate_number text NOT NULL,
  verification_code text NOT NULL,
  status text NOT NULL DEFAULT 'issued'::text,
  issued_at timestamp with time zone NOT NULL DEFAULT now(),
  issued_by_subject_id uuid,
  revoked_at timestamp with time zone,
  revoked_by_subject_id uuid,
  revocation_reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.course_run_rules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  min_attendance_percent numeric(5,2) NOT NULL DEFAULT 75,
  min_assessment_percent numeric(5,2) NOT NULL DEFAULT 70,
  require_completed_run boolean NOT NULL DEFAULT true,
  certificate_enabled boolean NOT NULL DEFAULT true,
  joining_message_template text NOT NULL DEFAULT 'مرحبًا {student_name}،
تم تسجيلك في {course_name} ضمن {run_name}.
بداية البرنامج: {start_date}
طريقة التقديم: {delivery_mode}
مكان/رابط الحضور: {venue_or_link}
نتمنى لك تجربة تدريبية موفقة.'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.course_run_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  session_number integer NOT NULL,
  title text NOT NULL,
  starts_at timestamp with time zone NOT NULL,
  ends_at timestamp with time zone NOT NULL,
  delivery_mode text NOT NULL,
  instructor_name text,
  venue_or_link text,
  status text NOT NULL DEFAULT 'scheduled'::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  meeting_provider text,
  external_meeting_id text,
  meeting_join_url text,
  meeting_status text NOT NULL DEFAULT 'not_created'::text,
  meeting_created_at timestamp with time zone,
  meeting_last_error text
);

CREATE TABLE academy.course_runs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_id uuid NOT NULL,
  run_code text NOT NULL,
  title text,
  delivery_mode text NOT NULL,
  starts_at timestamp with time zone,
  ends_at timestamp with time zone,
  capacity integer,
  enrolled_count integer NOT NULL DEFAULT 0,
  instructor_name text,
  venue_or_link text,
  price_minor bigint,
  currency text NOT NULL DEFAULT 'SAR'::text,
  status text NOT NULL DEFAULT 'planning'::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  registration_opens_at timestamp with time zone,
  registration_closes_at timestamp with time zone
);

CREATE TABLE academy.courses (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_code text NOT NULL,
  title_ar text NOT NULL,
  title_en text,
  category text NOT NULL,
  description text,
  delivery_mode text NOT NULL DEFAULT 'hybrid'::text,
  duration_hours numeric(7,2),
  duration_days integer,
  price_minor bigint,
  currency text NOT NULL DEFAULT 'SAR'::text,
  certification_code text,
  status text NOT NULL DEFAULT 'active'::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  regular_price_minor bigint,
  sale_price_minor bigint,
  sale_starts_at timestamp with time zone,
  sale_ends_at timestamp with time zone,
  currency_minor_digits smallint NOT NULL DEFAULT 2,
  external_source text,
  external_id text,
  external_url text,
  external_updated_at timestamp with time zone,
  primary_image_url text,
  gallery_urls text[] NOT NULL DEFAULT '{}'::text[],
  stock_status text,
  stock_quantity numeric(14,3),
  product_type text,
  virtual boolean NOT NULL DEFAULT false,
  downloadable boolean NOT NULL DEFAULT false
);

CREATE TABLE academy.enrollments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  enrollment_key text NOT NULL,
  handoff_id uuid NOT NULL,
  student_id uuid NOT NULL,
  course_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'confirmed'::text,
  enrolled_at timestamp with time zone NOT NULL DEFAULT now(),
  confirmed_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.registration_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  handoff_id uuid NOT NULL,
  document_type text NOT NULL,
  is_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'::text,
  file_name text,
  storage_path text,
  notes text,
  reviewed_at timestamp with time zone,
  reviewed_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.registration_handoffs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  handoff_key text NOT NULL,
  contact_id uuid NOT NULL,
  opportunity_id uuid,
  course_id uuid NOT NULL,
  course_run_id uuid,
  assigned_department_id uuid,
  assigned_staff_id uuid,
  status text NOT NULL DEFAULT 'pending'::text,
  paid_at timestamp with time zone NOT NULL DEFAULT now(),
  payment_amount_minor bigint,
  payment_reference text,
  preferred_start_date date,
  notes text,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  payment_status text NOT NULL DEFAULT 'pending_verification'::text,
  payment_reported_at timestamp with time zone NOT NULL DEFAULT now(),
  payment_verified_at timestamp with time zone,
  payment_verified_by_subject_id uuid,
  payment_rejection_reason text,
  accepted_at timestamp with time zone,
  accepted_by_subject_id uuid,
  completed_at timestamp with time zone,
  completed_by_subject_id uuid
);

CREATE TABLE academy.student_communications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  message_type text NOT NULL,
  channel text NOT NULL,
  status text NOT NULL,
  message_text text NOT NULL,
  sent_at timestamp with time zone,
  sent_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.students (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  student_key text NOT NULL,
  student_number text NOT NULL,
  contact_id uuid NOT NULL,
  full_name text NOT NULL,
  phone text,
  email text,
  status text NOT NULL DEFAULT 'active'::text,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE academy.training_automation_jobs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  course_run_id uuid NOT NULL,
  session_id uuid,
  enrollment_id uuid,
  dedupe_key text NOT NULL,
  job_type text NOT NULL,
  channel text NOT NULL,
  recipient text,
  subject text,
  message_text text,
  due_at timestamp with time zone NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending'::text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  external_id text,
  external_url text,
  last_error text,
  locked_at timestamp with time zone,
  processed_at timestamp with time zone,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  delivery_state text NOT NULL DEFAULT 'queued'::text,
  delivery_updated_at timestamp with time zone,
  delivered_at timestamp with time zone,
  read_at timestamp with time zone
);

CREATE TABLE academy.training_automation_settings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  joining_enabled boolean NOT NULL DEFAULT true,
  reminder_24h_enabled boolean NOT NULL DEFAULT true,
  reminder_1h_enabled boolean NOT NULL DEFAULT true,
  zoom_auto_create boolean NOT NULL DEFAULT false,
  primary_channel text NOT NULL DEFAULT 'whatsapp'::text,
  email_fallback_enabled boolean NOT NULL DEFAULT true,
  whatsapp_country_code text NOT NULL DEFAULT '966'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.membership_roles (
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.memberships (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  subject_id uuid NOT NULL,
  tenant_id uuid,
  scope text NOT NULL,
  status text NOT NULL DEFAULT 'active'::text,
  joined_at timestamp with time zone NOT NULL DEFAULT now(),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.permissions (
  permission_key text NOT NULL,
  module_key text NOT NULL,
  name_ar text NOT NULL,
  description text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.platform_invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL,
  full_name text NOT NULL,
  role_key text NOT NULL,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '7 days'::interval),
  invited_by_subject_id uuid,
  accepted_by_subject_id uuid,
  accepted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.role_permissions (
  role_id uuid NOT NULL,
  permission_key text NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.roles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid,
  role_key text NOT NULL,
  name_ar text NOT NULL,
  name_en text,
  scope text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.subjects (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  auth_user_id uuid NOT NULL,
  email text NOT NULL,
  full_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'::text,
  must_change_password boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE access_control.tenant_invitations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  email text NOT NULL,
  full_name text NOT NULL,
  role_key text NOT NULL DEFAULT 'tenant_owner'::text,
  token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending'::text,
  expires_at timestamp with time zone NOT NULL DEFAULT (now() + '7 days'::interval),
  invited_by_subject_id uuid,
  accepted_by_subject_id uuid,
  accepted_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.collection_actions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  customer_account_id uuid NOT NULL,
  invoice_id uuid,
  action_type text NOT NULL,
  summary text NOT NULL,
  promised_date date,
  promised_amount_minor bigint,
  next_action_at timestamp with time zone,
  created_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.commands (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  action text NOT NULL,
  request_hash text NOT NULL,
  response jsonb NOT NULL,
  actor_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.customer_accounts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contact_id uuid,
  account_number text NOT NULL,
  display_name text NOT NULL,
  organization_name text,
  billing_email text,
  billing_phone text,
  tax_number text,
  billing_address text,
  payment_terms_days integer NOT NULL DEFAULT 0,
  credit_limit_minor bigint,
  status text NOT NULL DEFAULT 'active'::text,
  notes text,
  created_by_subject_id uuid,
  updated_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.document_events (
  id bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  event_type text NOT NULL,
  from_status text,
  to_status text,
  actor_subject_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.document_sequences (
  tenant_id uuid NOT NULL,
  sequence_key text NOT NULL,
  calendar_year integer NOT NULL,
  next_value bigint NOT NULL DEFAULT 1
);

CREATE TABLE accounting_core.payment_allocations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  created_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.payment_schedules (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  installment_number integer NOT NULL,
  due_date date NOT NULL,
  amount_minor bigint NOT NULL,
  label text,
  created_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.payments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  customer_account_id uuid NOT NULL,
  payment_number text NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL DEFAULT 'SAR'::text,
  method text NOT NULL DEFAULT 'bank_transfer'::text,
  status text NOT NULL DEFAULT 'pending_verification'::text,
  external_reference text,
  source_type text,
  source_id text,
  received_at timestamp with time zone NOT NULL DEFAULT now(),
  verified_at timestamp with time zone,
  verified_by_subject_id uuid,
  rejection_reason text,
  notes text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.receipts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  receipt_number text NOT NULL,
  issued_at timestamp with time zone NOT NULL DEFAULT now(),
  issued_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.refunds (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  customer_account_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid,
  credit_note_id uuid,
  amount_minor bigint NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'requested'::text,
  requested_by_subject_id uuid,
  approved_by_subject_id uuid,
  approved_at timestamp with time zone,
  completed_by_subject_id uuid,
  completed_at timestamp with time zone,
  external_reference text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.sales_document_lines (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_id uuid NOT NULL,
  "position" integer NOT NULL,
  item_type text NOT NULL DEFAULT 'service'::text,
  source_id text,
  description text NOT NULL,
  quantity numeric(12,3) NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  subtotal_minor bigint NOT NULL,
  discount_minor bigint NOT NULL DEFAULT 0,
  tax_category text NOT NULL DEFAULT 'standard'::text,
  tax_rate_bps integer NOT NULL DEFAULT 1500,
  tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.sales_documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_type text NOT NULL,
  document_number text NOT NULL,
  revision_number integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'draft'::text,
  customer_account_id uuid NOT NULL,
  contact_id uuid,
  parent_document_id uuid,
  source_type text,
  source_id text,
  issue_date date NOT NULL DEFAULT CURRENT_DATE,
  valid_until date,
  due_date date,
  currency text NOT NULL DEFAULT 'SAR'::text,
  customer_name_snapshot text NOT NULL,
  customer_tax_number_snapshot text,
  customer_email_snapshot text,
  customer_phone_snapshot text,
  customer_address_snapshot text,
  subtotal_minor bigint NOT NULL DEFAULT 0,
  discount_minor bigint NOT NULL DEFAULT 0,
  tax_minor bigint NOT NULL DEFAULT 0,
  total_minor bigint NOT NULL DEFAULT 0,
  notes text,
  terms text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_subject_id uuid,
  updated_by_subject_id uuid,
  issued_by_subject_id uuid,
  issued_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE accounting_core.tenant_profiles (
  tenant_id uuid NOT NULL,
  legal_name_ar text,
  commercial_registration_number text,
  vat_number text,
  tax_registered boolean NOT NULL DEFAULT false,
  base_currency text NOT NULL DEFAULT 'SAR'::text,
  timezone text NOT NULL DEFAULT 'Asia/Riyadh'::text,
  default_payment_terms_days integer NOT NULL DEFAULT 0,
  default_tax_rate_bps integer NOT NULL DEFAULT 1500,
  quote_prefix text NOT NULL DEFAULT 'Q'::text,
  invoice_prefix text NOT NULL DEFAULT 'INV'::text,
  credit_note_prefix text NOT NULL DEFAULT 'CN'::text,
  debit_note_prefix text NOT NULL DEFAULT 'DN'::text,
  receipt_prefix text NOT NULL DEFAULT 'REC'::text,
  auto_import_verified_admissions boolean NOT NULL DEFAULT false,
  created_by_subject_id uuid,
  updated_by_subject_id uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE audit_log.events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_subject_id uuid,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE core.organizations (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_key text NOT NULL,
  legal_name text NOT NULL,
  display_name text NOT NULL,
  country_code text NOT NULL DEFAULT 'SA'::text,
  status text NOT NULL DEFAULT 'active'::text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE core.tenants (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  tenant_key text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  legal_name text,
  status text NOT NULL DEFAULT 'trial'::text,
  country_code text NOT NULL DEFAULT 'SA'::text,
  timezone text NOT NULL DEFAULT 'Asia/Riyadh'::text,
  default_locale text NOT NULL DEFAULT 'ar-SA'::text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE people.departments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  department_key text NOT NULL,
  name_ar text NOT NULL,
  name_en text,
  status text NOT NULL DEFAULT 'active'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE people.role_guide_progress (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  guide_version text NOT NULL,
  status text NOT NULL DEFAULT 'not_started'::text,
  current_step integer NOT NULL DEFAULT 0,
  last_mode text NOT NULL DEFAULT 'workspace'::text,
  auto_open boolean NOT NULL DEFAULT true,
  checklist_date date,
  checklist jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_opened_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE people.staff_profiles (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  membership_id uuid,
  employee_code text,
  full_name text NOT NULL,
  email text,
  phone text,
  job_title text NOT NULL,
  department_id uuid,
  role_key text NOT NULL,
  employment_status text NOT NULL DEFAULT 'active'::text,
  account_status text NOT NULL DEFAULT 'profile_only'::text,
  capacity_minutes_weekly integer NOT NULL DEFAULT 2400,
  hired_at date,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  supervisor_staff_id uuid
);

CREATE TABLE sales_core.activities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  activity_key text NOT NULL DEFAULT ('manual-'::text || (gen_random_uuid())::text),
  opportunity_id uuid,
  contact_id uuid NOT NULL,
  actor_staff_id uuid,
  activity_type text NOT NULL,
  outcome text,
  summary text NOT NULL,
  occurred_at timestamp with time zone NOT NULL DEFAULT now(),
  next_action_type text,
  next_action_at timestamp with time zone,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  result_status text,
  result_quality text,
  closure_reason text
);

CREATE TABLE sales_core.contact_identities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  identity_type text NOT NULL,
  identity_value text NOT NULL,
  source_slot text NOT NULL,
  is_alias boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE sales_core.contacts (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  contact_key text NOT NULL DEFAULT ('manual-'::text || (gen_random_uuid())::text),
  full_name text NOT NULL,
  organization_name text,
  phone text,
  whatsapp text,
  email text,
  source text NOT NULL DEFAULT 'manual'::text,
  status text NOT NULL DEFAULT 'active'::text,
  owner_staff_id uuid,
  interest_course_id uuid,
  notes text,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  lead_status text NOT NULL DEFAULT 'new'::text,
  lead_quality text NOT NULL DEFAULT 'unrated'::text,
  next_action_type text,
  next_action_at timestamp with time zone,
  last_activity_at timestamp with time zone,
  campaign_name text,
  ad_name text,
  lead_status_changed_at timestamp with time zone NOT NULL DEFAULT now(),
  closure_reason text,
  closed_at timestamp with time zone,
  reopened_at timestamp with time zone,
  payment_submitted_at timestamp with time zone
);

CREATE TABLE sales_core.opportunities (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  opportunity_key text NOT NULL DEFAULT ('manual-'::text || (gen_random_uuid())::text),
  contact_id uuid NOT NULL,
  course_id uuid,
  stage_id uuid NOT NULL,
  owner_staff_id uuid,
  title text NOT NULL,
  value_minor bigint NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'SAR'::text,
  expected_close_date date,
  next_action_type text,
  next_action_at timestamp with time zone,
  status text NOT NULL DEFAULT 'open'::text,
  lost_reason text,
  created_by_subject_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE sales_core.pipeline_stages (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  stage_key text NOT NULL,
  name_ar text NOT NULL,
  name_en text,
  "position" integer NOT NULL DEFAULT 0,
  probability_percent integer NOT NULL DEFAULT 0,
  is_closed boolean NOT NULL DEFAULT false,
  is_won boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE work_core.notifications (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  notification_key text NOT NULL,
  recipient_staff_id uuid NOT NULL,
  notification_type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  severity text NOT NULL DEFAULT 'info'::text,
  action_path text NOT NULL DEFAULT 'sales'::text,
  contact_id uuid,
  handoff_id uuid,
  read_at timestamp with time zone,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE work_core.task_history (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_id uuid NOT NULL,
  task_key text NOT NULL,
  contact_id uuid,
  opportunity_id uuid,
  actor_subject_id uuid,
  event_type text NOT NULL,
  task_title text NOT NULL,
  task_description text,
  previous_status text,
  next_status text,
  previous_due_at timestamp with time zone,
  next_due_at timestamp with time zone,
  previous_assigned_staff_id uuid,
  next_assigned_staff_id uuid,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE work_core.tasks (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  task_key text NOT NULL DEFAULT ('manual-'::text || (gen_random_uuid())::text),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'todo'::text,
  priority text NOT NULL DEFAULT 'normal'::text,
  assigned_staff_id uuid,
  created_by_subject_id uuid,
  contact_id uuid,
  opportunity_id uuid,
  activity_id uuid,
  starts_at timestamp with time zone,
  due_at timestamp with time zone NOT NULL,
  completed_at timestamp with time zone,
  completion_timing text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);


ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_pkey PRIMARY KEY (id);
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_pkey PRIMARY KEY (id);
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_pkey PRIMARY KEY (id);
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_pkey PRIMARY KEY (id);
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_pkey PRIMARY KEY (id);
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_pkey PRIMARY KEY (id);
ALTER TABLE academy.courses ADD CONSTRAINT courses_pkey PRIMARY KEY (id);
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_pkey PRIMARY KEY (id);
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_pkey PRIMARY KEY (id);
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_pkey PRIMARY KEY (id);
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_pkey PRIMARY KEY (id);
ALTER TABLE academy.students ADD CONSTRAINT students_pkey PRIMARY KEY (id);
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_pkey PRIMARY KEY (id);
ALTER TABLE academy.training_automation_settings ADD CONSTRAINT training_automation_settings_pkey PRIMARY KEY (id);
ALTER TABLE access_control.membership_roles ADD CONSTRAINT membership_roles_pkey PRIMARY KEY (membership_id, role_id);
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_pkey PRIMARY KEY (id);
ALTER TABLE access_control.permissions ADD CONSTRAINT permissions_pkey PRIMARY KEY (permission_key);
ALTER TABLE access_control.platform_invitations ADD CONSTRAINT platform_invitations_pkey PRIMARY KEY (id);
ALTER TABLE access_control.role_permissions ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);
ALTER TABLE access_control.roles ADD CONSTRAINT roles_pkey PRIMARY KEY (id);
ALTER TABLE access_control.subjects ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.commands ADD CONSTRAINT commands_pkey PRIMARY KEY (tenant_id, command_id);
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.document_events ADD CONSTRAINT document_events_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.document_sequences ADD CONSTRAINT document_sequences_pkey PRIMARY KEY (tenant_id, sequence_key, calendar_year);
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_pkey PRIMARY KEY (id);
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_pkey PRIMARY KEY (tenant_id);
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_pkey PRIMARY KEY (id);
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_pkey PRIMARY KEY (id);
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);
ALTER TABLE audit_log.events ADD CONSTRAINT events_pkey PRIMARY KEY (id);
ALTER TABLE core.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE core.tenants ADD CONSTRAINT tenants_pkey PRIMARY KEY (id);
ALTER TABLE people.departments ADD CONSTRAINT departments_pkey PRIMARY KEY (id);
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_pkey PRIMARY KEY (id);
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_pkey PRIMARY KEY (id);
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_pkey PRIMARY KEY (id);
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_pkey PRIMARY KEY (id);
ALTER TABLE sales_core.pipeline_stages ADD CONSTRAINT pipeline_stages_pkey PRIMARY KEY (id);
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_enrollment_id_assessment_key_key UNIQUE (enrollment_id, assessment_key);
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_enrollment_id_session_id_key UNIQUE (enrollment_id, session_id);
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_enrollment_id_key UNIQUE (enrollment_id);
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_tenant_id_certificate_number_key UNIQUE (tenant_id, certificate_number);
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_verification_code_key UNIQUE (verification_code);
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_course_run_id_key UNIQUE (course_run_id);
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_course_run_id_session_number_key UNIQUE (course_run_id, session_number);
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_tenant_id_run_code_key UNIQUE (tenant_id, run_code);
ALTER TABLE academy.courses ADD CONSTRAINT courses_tenant_id_course_code_key UNIQUE (tenant_id, course_code);
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_handoff_id_key UNIQUE (handoff_id);
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_student_id_course_run_id_key UNIQUE (student_id, course_run_id);
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_tenant_id_enrollment_key_key UNIQUE (tenant_id, enrollment_key);
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_handoff_id_document_type_key UNIQUE (handoff_id, document_type);
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_tenant_id_handoff_key_key UNIQUE (tenant_id, handoff_key);
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_enrollment_id_message_type_key UNIQUE (enrollment_id, message_type);
ALTER TABLE academy.students ADD CONSTRAINT students_tenant_id_contact_id_key UNIQUE (tenant_id, contact_id);
ALTER TABLE academy.students ADD CONSTRAINT students_tenant_id_student_key_key UNIQUE (tenant_id, student_key);
ALTER TABLE academy.students ADD CONSTRAINT students_tenant_id_student_number_key UNIQUE (tenant_id, student_number);
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_tenant_id_dedupe_key_key UNIQUE (tenant_id, dedupe_key);
ALTER TABLE academy.training_automation_settings ADD CONSTRAINT training_automation_settings_tenant_id_key UNIQUE (tenant_id);
ALTER TABLE access_control.platform_invitations ADD CONSTRAINT platform_invitations_token_hash_key UNIQUE (token_hash);
ALTER TABLE access_control.subjects ADD CONSTRAINT subjects_auth_user_id_key UNIQUE (auth_user_id);
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_token_hash_key UNIQUE (token_hash);
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_tenant_id_account_number_key UNIQUE (tenant_id, account_number);
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_tenant_id_contact_id_key UNIQUE (tenant_id, contact_id);
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_tenant_id_payment_id_invoice_id_key UNIQUE (tenant_id, payment_id, invoice_id);
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_tenant_id_invoice_id_installment_number_key UNIQUE (tenant_id, invoice_id, installment_number);
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_tenant_id_payment_number_key UNIQUE (tenant_id, payment_number);
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_tenant_id_payment_id_key UNIQUE (tenant_id, payment_id);
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_tenant_id_receipt_number_key UNIQUE (tenant_id, receipt_number);
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tenant_id_document_id_position_key UNIQUE (tenant_id, document_id, "position");
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_document_type_document_number_key UNIQUE (tenant_id, document_type, document_number);
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_id_key UNIQUE (tenant_id, id);
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_tenant_id_contact_key_key UNIQUE (tenant_id, contact_key);
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_tenant_id_opportunity_key_key UNIQUE (tenant_id, opportunity_key);
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_tenant_id_notification_key_recipient_staff_id_key UNIQUE (tenant_id, notification_key, recipient_staff_id);
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_tenant_id_task_key_key UNIQUE (tenant_id, task_key);
ALTER TABLE core.organizations ADD CONSTRAINT organizations_organization_key_key UNIQUE (organization_key);
ALTER TABLE core.tenants ADD CONSTRAINT tenants_slug_key UNIQUE (slug);
ALTER TABLE core.tenants ADD CONSTRAINT tenants_tenant_key_key UNIQUE (tenant_key);
ALTER TABLE people.departments ADD CONSTRAINT departments_tenant_id_department_key_key UNIQUE (tenant_id, department_key);
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_tenant_id_subject_id_guide_version_key UNIQUE (tenant_id, subject_id, guide_version);
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_membership_id_key UNIQUE (membership_id);
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_tenant_id_activity_key_key UNIQUE (tenant_id, activity_key);
ALTER TABLE sales_core.pipeline_stages ADD CONSTRAINT pipeline_stages_tenant_id_stage_key_key UNIQUE (tenant_id, stage_key);
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_check CHECK ((score <= max_score));
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_max_score_check CHECK ((max_score > (0)::numeric));
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_score_check CHECK ((score >= (0)::numeric));
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_check CHECK ((((status = 'late'::text) AND (minutes_late > 0)) OR ((status <> 'late'::text) AND (minutes_late = 0))));
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_minutes_late_check CHECK (((minutes_late >= 0) AND (minutes_late <= 1440)));
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_status_check CHECK ((status = ANY (ARRAY['present'::text, 'late'::text, 'absent'::text, 'excused'::text])));
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_check CHECK ((((status = 'issued'::text) AND (revoked_at IS NULL)) OR ((status = 'revoked'::text) AND (revoked_at IS NOT NULL) AND (revocation_reason IS NOT NULL) AND (length(TRIM(BOTH FROM revocation_reason)) >= 3))));
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_status_check CHECK ((status = ANY (ARRAY['issued'::text, 'revoked'::text])));
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_min_assessment_percent_check CHECK (((min_assessment_percent >= (0)::numeric) AND (min_assessment_percent <= (100)::numeric)));
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_min_attendance_percent_check CHECK (((min_attendance_percent >= (0)::numeric) AND (min_attendance_percent <= (100)::numeric)));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_check CHECK ((ends_at > starts_at));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_delivery_mode_check CHECK ((delivery_mode = ANY (ARRAY['online'::text, 'onsite'::text, 'hybrid'::text])));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_meeting_provider_check CHECK (((meeting_provider IS NULL) OR (meeting_provider = 'zoom'::text)));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_meeting_ready_check CHECK (((meeting_status <> 'ready'::text) OR ((meeting_provider = 'zoom'::text) AND (external_meeting_id IS NOT NULL) AND (meeting_join_url IS NOT NULL) AND (meeting_created_at IS NOT NULL))));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_meeting_status_check CHECK ((meeting_status = ANY (ARRAY['not_created'::text, 'queued'::text, 'ready'::text, 'failed'::text])));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_session_number_check CHECK ((session_number > 0));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_status_check CHECK ((status = ANY (ARRAY['scheduled'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_title_check CHECK ((length(TRIM(BOTH FROM title)) >= 2));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_capacity_check CHECK (((capacity IS NULL) OR (capacity > 0)));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_capacity_not_below_enrolled_check CHECK (((capacity IS NULL) OR (capacity >= enrolled_count)));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_check CHECK (((ends_at IS NULL) OR (starts_at IS NULL) OR (ends_at > starts_at)));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_delivery_mode_check CHECK ((delivery_mode = ANY (ARRAY['online'::text, 'onsite'::text, 'hybrid'::text])));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_enrolled_count_check CHECK ((enrolled_count >= 0));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_price_minor_check CHECK (((price_minor IS NULL) OR (price_minor >= 0)));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_registration_before_start_check CHECK (((registration_closes_at IS NULL) OR (starts_at IS NULL) OR (registration_closes_at <= starts_at)));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_registration_window_check CHECK ((((registration_opens_at IS NULL) OR (registration_closes_at IS NULL) OR (registration_opens_at <= registration_closes_at)) AND ((registration_closes_at IS NULL) OR (starts_at IS NULL) OR (registration_closes_at <= starts_at))));
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_status_check CHECK ((status = ANY (ARRAY['planning'::text, 'open'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE academy.courses ADD CONSTRAINT academy_courses_external_identity_check CHECK ((((external_source IS NULL) AND (external_id IS NULL)) OR ((external_source IS NOT NULL) AND (NULLIF(TRIM(BOTH FROM external_id), ''::text) IS NOT NULL))));
ALTER TABLE academy.courses ADD CONSTRAINT academy_courses_sale_period_check CHECK (((sale_ends_at IS NULL) OR (sale_starts_at IS NULL) OR (sale_ends_at > sale_starts_at)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_currency_minor_digits_check CHECK (((currency_minor_digits >= 0) AND (currency_minor_digits <= 4)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_delivery_mode_check CHECK ((delivery_mode = ANY (ARRAY['online'::text, 'onsite'::text, 'hybrid'::text])));
ALTER TABLE academy.courses ADD CONSTRAINT courses_duration_days_check CHECK (((duration_days IS NULL) OR (duration_days > 0)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_duration_hours_check CHECK (((duration_hours IS NULL) OR (duration_hours > (0)::numeric)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_external_source_check CHECK (((external_source IS NULL) OR (external_source ~ '^[a-z][a-z0-9_-]{1,40}$'::text)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_price_minor_check CHECK (((price_minor IS NULL) OR (price_minor >= 0)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_regular_price_minor_check CHECK (((regular_price_minor IS NULL) OR (regular_price_minor >= 0)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_sale_price_minor_check CHECK (((sale_price_minor IS NULL) OR (sale_price_minor >= 0)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])));
ALTER TABLE academy.courses ADD CONSTRAINT courses_stock_quantity_check CHECK (((stock_quantity IS NULL) OR (stock_quantity >= (0)::numeric)));
ALTER TABLE academy.courses ADD CONSTRAINT courses_stock_status_check CHECK (((stock_status IS NULL) OR (stock_status = ANY (ARRAY['instock'::text, 'outofstock'::text, 'onbackorder'::text]))));
ALTER TABLE academy.courses ADD CONSTRAINT courses_title_ar_check CHECK ((length(TRIM(BOTH FROM title_ar)) >= 2));
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_status_check CHECK ((status = ANY (ARRAY['confirmed'::text, 'active'::text, 'completed'::text, 'withdrawn'::text, 'cancelled'::text])));
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_optional_only_check CHECK ((is_required = false));
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'received'::text, 'approved'::text, 'rejected'::text, 'not_required'::text])));
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_payment_amount_minor_check CHECK (((payment_amount_minor IS NULL) OR (payment_amount_minor >= 0)));
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_payment_status_check CHECK ((payment_status = ANY (ARRAY['pending_verification'::text, 'verified'::text, 'rejected'::text, 'refunded'::text])));
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_payment_verification_check CHECK (((payment_status <> 'verified'::text) OR (payment_verified_at IS NOT NULL)));
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'in_review'::text, 'accepted'::text, 'rejected'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_channel_check CHECK ((channel = ANY (ARRAY['manual'::text, 'whatsapp'::text, 'email'::text, 'sms'::text])));
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_check CHECK ((((status = 'sent'::text) AND (sent_at IS NOT NULL)) OR (status <> 'sent'::text)));
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_message_text_check CHECK ((length(TRIM(BOTH FROM message_text)) >= 10));
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_message_type_check CHECK ((message_type = 'joining_instructions'::text));
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'sent'::text, 'failed'::text])));
ALTER TABLE academy.students ADD CONSTRAINT students_full_name_check CHECK ((length(TRIM(BOTH FROM full_name)) >= 2));
ALTER TABLE academy.students ADD CONSTRAINT students_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text, 'graduated'::text, 'blocked'::text])));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_attempts_check CHECK ((attempts >= 0));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'email'::text, 'zoom'::text])));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_check CHECK ((((job_type = 'zoom_meeting_create'::text) AND (channel = 'zoom'::text) AND (session_id IS NOT NULL) AND (enrollment_id IS NULL)) OR ((job_type = 'joining_instructions'::text) AND (channel = ANY (ARRAY['whatsapp'::text, 'email'::text])) AND (enrollment_id IS NOT NULL) AND (session_id IS NULL) AND (recipient IS NOT NULL) AND (message_text IS NOT NULL)) OR ((job_type = ANY (ARRAY['session_reminder_24h'::text, 'session_reminder_1h'::text])) AND (channel = ANY (ARRAY['whatsapp'::text, 'email'::text])) AND (enrollment_id IS NOT NULL) AND (session_id IS NOT NULL) AND (recipient IS NOT NULL) AND (message_text IS NOT NULL))));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_dedupe_key_check CHECK ((length(TRIM(BOTH FROM dedupe_key)) >= 8));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_delivery_state_check CHECK ((delivery_state = ANY (ARRAY['queued'::text, 'accepted'::text, 'delivered'::text, 'read'::text, 'simulated'::text, 'failed'::text, 'bounced'::text, 'complained'::text, 'cancelled'::text])));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_job_type_check CHECK ((job_type = ANY (ARRAY['joining_instructions'::text, 'session_reminder_24h'::text, 'session_reminder_1h'::text, 'zoom_meeting_create'::text])));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_max_attempts_check CHECK (((max_attempts >= 1) AND (max_attempts <= 10)));
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'sent'::text, 'simulated'::text, 'failed'::text, 'waiting_configuration'::text, 'cancelled'::text])));
ALTER TABLE academy.training_automation_settings ADD CONSTRAINT training_automation_settings_primary_channel_check CHECK ((primary_channel = ANY (ARRAY['whatsapp'::text, 'email'::text])));
ALTER TABLE academy.training_automation_settings ADD CONSTRAINT training_automation_settings_whatsapp_country_code_check CHECK ((whatsapp_country_code ~ '^[1-9][0-9]{0,3}$'::text));
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_check CHECK ((((scope = 'platform'::text) AND (tenant_id IS NULL)) OR ((scope = 'tenant'::text) AND (tenant_id IS NOT NULL))));
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_scope_check CHECK ((scope = ANY (ARRAY['platform'::text, 'tenant'::text])));
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text, 'revoked'::text])));
ALTER TABLE access_control.platform_invitations ADD CONSTRAINT platform_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'expired'::text, 'revoked'::text])));
ALTER TABLE access_control.roles ADD CONSTRAINT roles_check CHECK ((((scope = 'platform'::text) AND (tenant_id IS NULL)) OR (scope = 'tenant'::text)));
ALTER TABLE access_control.roles ADD CONSTRAINT roles_scope_check CHECK ((scope = ANY (ARRAY['platform'::text, 'tenant'::text])));
ALTER TABLE access_control.subjects ADD CONSTRAINT subjects_status_check CHECK ((status = ANY (ARRAY['invited'::text, 'active'::text, 'suspended'::text, 'disabled'::text])));
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_email_check CHECK ((email = lower(TRIM(BOTH FROM email))));
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_full_name_check CHECK ((length(TRIM(BOTH FROM full_name)) >= 2));
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text, 'expired'::text])));
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_action_type_check CHECK ((action_type = ANY (ARRAY['note'::text, 'call'::text, 'whatsapp'::text, 'email'::text, 'payment_promise'::text])));
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_check CHECK ((((action_type = 'payment_promise'::text) AND (promised_date IS NOT NULL)) OR (action_type <> 'payment_promise'::text)));
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_promised_amount_minor_check CHECK (((promised_amount_minor IS NULL) OR (promised_amount_minor > 0)));
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_summary_check CHECK (((length(btrim(summary)) >= 2) AND (length(btrim(summary)) <= 2000)));
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_credit_limit_minor_check CHECK (((credit_limit_minor IS NULL) OR (credit_limit_minor >= 0)));
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_display_name_check CHECK (((length(btrim(display_name)) >= 2) AND (length(btrim(display_name)) <= 200)));
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_payment_terms_days_check CHECK (((payment_terms_days >= 0) AND (payment_terms_days <= 3650)));
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_status_check CHECK ((status = ANY (ARRAY['active'::text, 'on_hold'::text, 'closed'::text])));
ALTER TABLE accounting_core.document_events ADD CONSTRAINT document_events_details_check CHECK ((jsonb_typeof(details) = 'object'::text));
ALTER TABLE accounting_core.document_sequences ADD CONSTRAINT document_sequences_calendar_year_check CHECK (((calendar_year >= 2000) AND (calendar_year <= 2200)));
ALTER TABLE accounting_core.document_sequences ADD CONSTRAINT document_sequences_next_value_check CHECK ((next_value > 0));
ALTER TABLE accounting_core.document_sequences ADD CONSTRAINT document_sequences_sequence_key_check CHECK ((sequence_key ~ '^[a-z][a-z0-9_]{2,40}$'::text));
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_amount_minor_check CHECK ((amount_minor > 0));
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_amount_minor_check CHECK ((amount_minor > 0));
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_installment_number_check CHECK ((installment_number > 0));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_amount_minor_check CHECK ((amount_minor > 0));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_check CHECK ((((status = 'verified'::text) AND (verified_at IS NOT NULL) AND (verified_by_subject_id IS NOT NULL)) OR (status <> 'verified'::text)));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_method_check CHECK ((method = ANY (ARRAY['bank_transfer'::text, 'cash'::text, 'mada'::text, 'tamara'::text, 'paymob'::text, 'paypal'::text, 'store'::text, 'other'::text])));
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['pending_verification'::text, 'verified'::text, 'rejected'::text, 'refunded'::text])));
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_amount_minor_check CHECK ((amount_minor > 0));
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_reason_check CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 1000)));
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_status_check CHECK ((status = ANY (ARRAY['requested'::text, 'approved'::text, 'rejected'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_check CHECK (((discount_minor >= 0) AND (discount_minor <= subtotal_minor)));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_check1 CHECK ((total_minor = ((subtotal_minor - discount_minor) + tax_minor)));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_check2 CHECK (((tax_category = 'standard'::text) OR (tax_minor = 0)));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_description_check CHECK (((length(btrim(description)) >= 1) AND (length(btrim(description)) <= 500)));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_item_type_check CHECK ((item_type = ANY (ARRAY['course'::text, 'service'::text, 'product'::text, 'discount'::text, 'custom'::text])));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_position_check CHECK (("position" > 0));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_quantity_check CHECK ((quantity > (0)::numeric));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_subtotal_minor_check CHECK ((subtotal_minor >= 0));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tax_category_check CHECK ((tax_category = ANY (ARRAY['standard'::text, 'zero'::text, 'exempt'::text, 'out_of_scope'::text])));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tax_minor_check CHECK ((tax_minor >= 0));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tax_rate_bps_check CHECK (((tax_rate_bps >= 0) AND (tax_rate_bps <= 10000)));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_total_minor_check CHECK ((total_minor >= 0));
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_unit_amount_minor_check CHECK ((unit_amount_minor >= 0));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_check CHECK (((valid_until IS NULL) OR (valid_until >= issue_date)));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_check1 CHECK (((due_date IS NULL) OR (due_date >= issue_date)));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_check2 CHECK ((discount_minor <= subtotal_minor));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_check3 CHECK ((total_minor = ((subtotal_minor - discount_minor) + tax_minor)));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_currency_check CHECK ((currency ~ '^[A-Z]{3}$'::text));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_discount_minor_check CHECK ((discount_minor >= 0));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_document_type_check CHECK ((document_type = ANY (ARRAY['quote'::text, 'invoice'::text, 'credit_note'::text, 'debit_note'::text])));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_metadata_check CHECK ((jsonb_typeof(metadata) = 'object'::text));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_revision_number_check CHECK ((revision_number > 0));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'rejected'::text, 'expired'::text, 'converted'::text, 'issued'::text, 'cancelled'::text])));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_subtotal_minor_check CHECK ((subtotal_minor >= 0));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tax_minor_check CHECK ((tax_minor >= 0));
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_total_minor_check CHECK ((total_minor >= 0));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_base_currency_check CHECK ((base_currency ~ '^[A-Z]{3}$'::text));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_credit_note_prefix_check CHECK ((credit_note_prefix ~ '^[A-Z0-9-]{1,10}$'::text));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_debit_note_prefix_check CHECK ((debit_note_prefix ~ '^[A-Z0-9-]{1,10}$'::text));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_default_payment_terms_days_check CHECK (((default_payment_terms_days >= 0) AND (default_payment_terms_days <= 3650)));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_default_tax_rate_bps_check CHECK (((default_tax_rate_bps >= 0) AND (default_tax_rate_bps <= 10000)));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_invoice_prefix_check CHECK ((invoice_prefix ~ '^[A-Z0-9-]{1,10}$'::text));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_quote_prefix_check CHECK ((quote_prefix ~ '^[A-Z0-9-]{1,10}$'::text));
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_receipt_prefix_check CHECK ((receipt_prefix ~ '^[A-Z0-9-]{1,10}$'::text));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_closure_reason_check CHECK (((lead_status <> ALL (ARRAY['not_interested'::text, 'unqualified'::text, 'wrong_number'::text, 'duplicate'::text, 'cancelled'::text])) OR ((closure_reason IS NOT NULL) AND (length(TRIM(BOTH FROM closure_reason)) >= 3) AND (closed_at IS NOT NULL))));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_email_check CHECK (((email IS NULL) OR (email = lower(TRIM(BOTH FROM email)))));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_email_format_check CHECK (((email IS NULL) OR (email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text)));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_full_name_check CHECK ((length(TRIM(BOTH FROM full_name)) >= 2));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_lead_quality_check CHECK ((lead_quality = ANY (ARRAY['unrated'::text, 'unqualified'::text, 'weak'::text, 'qualified'::text, 'good'::text, 'excellent'::text])));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_lead_status_check CHECK ((lead_status = ANY (ARRAY['new'::text, 'no_answer'::text, 'busy'::text, 'phone_off'::text, 'follow_up'::text, 'interested'::text, 'very_interested'::text, 'awaiting_payment'::text, 'payment_submitted'::text, 'paid'::text, 'postponed'::text, 'not_interested'::text, 'unqualified'::text, 'wrong_number'::text, 'duplicate'::text, 'cancelled'::text])));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_next_action_pair_check CHECK ((num_nonnulls(next_action_type, next_action_at) = ANY (ARRAY[0, 2])));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_status_check CHECK ((status = ANY (ARRAY['new'::text, 'active'::text, 'unqualified'::text, 'converted'::text, 'archived'::text])));
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_unqualified_quality_closed_check CHECK (((lead_quality <> 'unqualified'::text) OR (lead_status <> ALL (ARRAY['new'::text, 'no_answer'::text, 'busy'::text, 'phone_off'::text, 'follow_up'::text, 'interested'::text, 'very_interested'::text, 'awaiting_payment'::text, 'postponed'::text]))));
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_check CHECK (((status <> 'open'::text) OR ((next_action_type IS NOT NULL) AND (next_action_at IS NOT NULL))));
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_status_check CHECK ((status = ANY (ARRAY['open'::text, 'pending_verification'::text, 'won'::text, 'lost'::text, 'cancelled'::text])));
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_title_check CHECK ((length(TRIM(BOTH FROM title)) >= 2));
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_value_minor_check CHECK ((value_minor >= 0));
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_message_check CHECK ((length(TRIM(BOTH FROM message)) >= 2));
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'danger'::text])));
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_title_check CHECK ((length(TRIM(BOTH FROM title)) >= 2));
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_event_type_check CHECK ((event_type = ANY (ARRAY['rescheduled'::text, 'status_changed'::text, 'reassigned'::text, 'updated'::text])));
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_completion_timing_check CHECK (((completion_timing IS NULL) OR (completion_timing = ANY (ARRAY['on_time'::text, 'late'::text]))));
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text])));
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['todo'::text, 'in_progress'::text, 'completed'::text, 'cancelled'::text])));
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_title_check CHECK ((length(TRIM(BOTH FROM title)) >= 2));
ALTER TABLE core.organizations ADD CONSTRAINT organizations_country_code_check CHECK ((country_code ~ '^[A-Z]{2}$'::text));
ALTER TABLE core.organizations ADD CONSTRAINT organizations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text])));
ALTER TABLE core.tenants ADD CONSTRAINT tenants_country_code_check CHECK ((country_code ~ '^[A-Z]{2}$'::text));
ALTER TABLE core.tenants ADD CONSTRAINT tenants_slug_check CHECK ((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text));
ALTER TABLE core.tenants ADD CONSTRAINT tenants_status_check CHECK ((status = ANY (ARRAY['trial'::text, 'active'::text, 'suspended'::text, 'migrating'::text, 'closed'::text])));
ALTER TABLE people.departments ADD CONSTRAINT departments_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])));
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_current_step_check CHECK (((current_step >= 0) AND (current_step <= 50)));
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_last_mode_check CHECK ((last_mode = ANY (ARRAY['workspace'::text, 'page'::text])));
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_status_check CHECK ((status = ANY (ARRAY['not_started'::text, 'in_progress'::text, 'completed'::text, 'skipped'::text, 'dismissed'::text])));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_account_status_check CHECK ((account_status = ANY (ARRAY['profile_only'::text, 'invited'::text, 'active'::text, 'suspended'::text])));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_capacity_minutes_weekly_check CHECK (((capacity_minutes_weekly >= 0) AND (capacity_minutes_weekly <= 10080)));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_email_check CHECK (((email IS NULL) OR (email = lower(TRIM(BOTH FROM email)))));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_employment_status_check CHECK ((employment_status = ANY (ARRAY['active'::text, 'leave'::text, 'inactive'::text])));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_full_name_check CHECK ((length(TRIM(BOTH FROM full_name)) >= 2));
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_supervisor_not_self_chk CHECK (((supervisor_staff_id IS NULL) OR (supervisor_staff_id <> id)));
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_activity_type_check CHECK ((activity_type = ANY (ARRAY['call'::text, 'meeting'::text, 'whatsapp'::text, 'email'::text, 'offer'::text, 'note'::text])));
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_next_action_pair_check CHECK ((num_nonnulls(next_action_type, next_action_at) = ANY (ARRAY[0, 2])));
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_result_quality_check CHECK (((result_quality IS NULL) OR (result_quality = ANY (ARRAY['unrated'::text, 'unqualified'::text, 'weak'::text, 'qualified'::text, 'good'::text, 'excellent'::text]))));
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_result_status_check CHECK (((result_status IS NULL) OR (result_status = ANY (ARRAY['new'::text, 'no_answer'::text, 'busy'::text, 'phone_off'::text, 'follow_up'::text, 'interested'::text, 'very_interested'::text, 'awaiting_payment'::text, 'payment_submitted'::text, 'paid'::text, 'postponed'::text, 'not_interested'::text, 'unqualified'::text, 'wrong_number'::text, 'duplicate'::text, 'cancelled'::text]))));
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_summary_check CHECK ((length(TRIM(BOTH FROM summary)) >= 2));
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_identity_type_check CHECK ((identity_type = ANY (ARRAY['phone'::text, 'email'::text])));
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_identity_value_check CHECK (((length(TRIM(BOTH FROM identity_value)) >= 3) AND (length(TRIM(BOTH FROM identity_value)) <= 320)));
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_source_slot_check CHECK ((source_slot = ANY (ARRAY['phone'::text, 'whatsapp'::text, 'email'::text, 'merged_alias'::text, 'historical_alias'::text, 'additional_phone'::text])));
ALTER TABLE sales_core.pipeline_stages ADD CONSTRAINT pipeline_stages_check CHECK (((NOT is_won) OR is_closed));
ALTER TABLE sales_core.pipeline_stages ADD CONSTRAINT pipeline_stages_probability_percent_check CHECK (((probability_percent >= 0) AND (probability_percent <= 100)));
CREATE INDEX assessment_results_assessor_reference_idx ON academy.assessment_results USING btree (assessed_by_subject_id) WHERE (assessed_by_subject_id IS NOT NULL);
CREATE INDEX assessment_results_run_idx ON academy.assessment_results USING btree (course_run_id, assessment_key);
CREATE INDEX assessment_results_tenant_reference_idx ON academy.assessment_results USING btree (tenant_id);
CREATE INDEX attendance_records_marker_reference_idx ON academy.attendance_records USING btree (marked_by_subject_id) WHERE (marked_by_subject_id IS NOT NULL);
CREATE INDEX attendance_records_run_session_idx ON academy.attendance_records USING btree (course_run_id, session_id, status);
CREATE INDEX attendance_records_session_reference_idx ON academy.attendance_records USING btree (session_id);
CREATE INDEX attendance_records_tenant_time_idx ON academy.attendance_records USING btree (tenant_id, marked_at DESC);
CREATE INDEX certificates_course_run_reference_idx ON academy.certificates USING btree (course_run_id);
CREATE INDEX certificates_issuer_reference_idx ON academy.certificates USING btree (issued_by_subject_id) WHERE (issued_by_subject_id IS NOT NULL);
CREATE INDEX certificates_revoker_reference_idx ON academy.certificates USING btree (revoked_by_subject_id) WHERE (revoked_by_subject_id IS NOT NULL);
CREATE INDEX certificates_tenant_status_time_idx ON academy.certificates USING btree (tenant_id, status, issued_at DESC);
CREATE INDEX course_run_rules_tenant_idx ON academy.course_run_rules USING btree (tenant_id, course_run_id);
CREATE INDEX course_run_sessions_run_time_idx ON academy.course_run_sessions USING btree (course_run_id, starts_at);
CREATE INDEX course_run_sessions_tenant_time_idx ON academy.course_run_sessions USING btree (tenant_id, starts_at, status);
CREATE UNIQUE INDEX course_run_sessions_zoom_meeting_idx ON academy.course_run_sessions USING btree (tenant_id, external_meeting_id) WHERE (external_meeting_id IS NOT NULL);
CREATE UNIQUE INDEX course_sessions_tenant_run_id_uidx ON academy.course_run_sessions USING btree (tenant_id, course_run_id, id);
CREATE INDEX academy_course_runs_course_reference_idx ON academy.course_runs USING btree (course_id);
CREATE INDEX academy_course_runs_tenant_time_idx ON academy.course_runs USING btree (tenant_id, starts_at, status);
CREATE UNIQUE INDEX course_runs_tenant_course_id_uidx ON academy.course_runs USING btree (tenant_id, course_id, id);
CREATE UNIQUE INDEX academy_courses_external_identity_idx ON academy.courses USING btree (tenant_id, external_source, external_id) WHERE ((external_source IS NOT NULL) AND (external_id IS NOT NULL));
CREATE INDEX academy_courses_tenant_status_idx ON academy.courses USING btree (tenant_id, status, title_ar);
CREATE INDEX academy_courses_woocommerce_status_idx ON academy.courses USING btree (tenant_id, status, external_updated_at DESC) WHERE (external_source = 'woocommerce'::text);
CREATE UNIQUE INDEX courses_tenant_id_id_uidx ON academy.courses USING btree (tenant_id, id);
CREATE INDEX academy_enrollments_confirmer_reference_idx ON academy.enrollments USING btree (confirmed_by_subject_id);
CREATE INDEX academy_enrollments_course_idx ON academy.enrollments USING btree (course_id, course_run_id, status);
CREATE INDEX academy_enrollments_course_run_reference_idx ON academy.enrollments USING btree (course_run_id);
CREATE INDEX academy_enrollments_student_idx ON academy.enrollments USING btree (student_id, enrolled_at DESC);
CREATE INDEX academy_enrollments_tenant_enrolled_dashboard_idx ON academy.enrollments USING btree (tenant_id, enrolled_at) INCLUDE (status);
CREATE INDEX academy_enrollments_tenant_status_idx ON academy.enrollments USING btree (tenant_id, status, enrolled_at DESC);
CREATE INDEX registration_documents_handoff_idx ON academy.registration_documents USING btree (handoff_id, is_required, status);
CREATE INDEX registration_documents_reviewer_reference_idx ON academy.registration_documents USING btree (reviewed_by_subject_id);
CREATE INDEX registration_documents_tenant_status_idx ON academy.registration_documents USING btree (tenant_id, status, created_at);
CREATE INDEX campaign_handoff_contact_verified_idx ON academy.registration_handoffs USING btree (tenant_id, contact_id, payment_verified_at) WHERE (payment_status = 'verified'::text);
CREATE INDEX registration_handoffs_acceptor_reference_idx ON academy.registration_handoffs USING btree (accepted_by_subject_id);
CREATE INDEX registration_handoffs_completer_reference_idx ON academy.registration_handoffs USING btree (completed_by_subject_id);
CREATE INDEX registration_handoffs_contact_reference_idx ON academy.registration_handoffs USING btree (contact_id);
CREATE INDEX registration_handoffs_course_reference_idx ON academy.registration_handoffs USING btree (course_id);
CREATE INDEX registration_handoffs_course_run_reference_idx ON academy.registration_handoffs USING btree (course_run_id);
CREATE INDEX registration_handoffs_creator_reference_idx ON academy.registration_handoffs USING btree (created_by_subject_id);
CREATE INDEX registration_handoffs_department_reference_idx ON academy.registration_handoffs USING btree (assigned_department_id);
CREATE INDEX registration_handoffs_opportunity_reference_idx ON academy.registration_handoffs USING btree (opportunity_id);
CREATE INDEX registration_handoffs_payment_queue_idx ON academy.registration_handoffs USING btree (tenant_id, payment_status, status, payment_reported_at);
CREATE INDEX registration_handoffs_payment_reviewer_reference_idx ON academy.registration_handoffs USING btree (payment_verified_by_subject_id);
CREATE INDEX registration_handoffs_staff_reference_idx ON academy.registration_handoffs USING btree (assigned_staff_id);
CREATE INDEX registration_handoffs_tenant_contact_created_idx ON academy.registration_handoffs USING btree (tenant_id, contact_id, created_at DESC);
CREATE INDEX registration_handoffs_tenant_status_idx ON academy.registration_handoffs USING btree (tenant_id, status, created_at DESC);
CREATE INDEX registration_handoffs_verified_contact_idx ON academy.registration_handoffs USING btree (tenant_id, contact_id) WHERE (payment_status = 'verified'::text);
CREATE INDEX registration_handoffs_verified_paid_idx ON academy.registration_handoffs USING btree (tenant_id, paid_at, contact_id) INCLUDE (payment_amount_minor, course_id) WHERE (payment_status = 'verified'::text);
CREATE INDEX registration_handoffs_workspace_order_idx ON academy.registration_handoffs USING btree (tenant_id, created_at DESC, id DESC);
CREATE INDEX student_communications_run_status_idx ON academy.student_communications USING btree (course_run_id, message_type, status);
CREATE INDEX student_communications_sender_reference_idx ON academy.student_communications USING btree (sent_by_subject_id) WHERE (sent_by_subject_id IS NOT NULL);
CREATE INDEX student_communications_tenant_reference_idx ON academy.student_communications USING btree (tenant_id);
CREATE INDEX academy_students_contact_idx ON academy.students USING btree (contact_id);
CREATE INDEX academy_students_creator_reference_idx ON academy.students USING btree (created_by_subject_id);
CREATE INDEX academy_students_tenant_status_idx ON academy.students USING btree (tenant_id, status, full_name);
CREATE INDEX training_automation_jobs_actor_idx ON academy.training_automation_jobs USING btree (created_by_subject_id) WHERE (created_by_subject_id IS NOT NULL);
CREATE INDEX training_automation_jobs_course_run_reference_idx ON academy.training_automation_jobs USING btree (course_run_id);
CREATE INDEX training_automation_jobs_due_idx ON academy.training_automation_jobs USING btree (status, due_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text, 'waiting_configuration'::text, 'processing'::text]));
CREATE INDEX training_automation_jobs_enrollment_idx ON academy.training_automation_jobs USING btree (enrollment_id) WHERE (enrollment_id IS NOT NULL);
CREATE INDEX training_automation_jobs_run_idx ON academy.training_automation_jobs USING btree (tenant_id, course_run_id, created_at DESC);
CREATE INDEX training_automation_jobs_session_idx ON academy.training_automation_jobs USING btree (session_id) WHERE (session_id IS NOT NULL);
CREATE INDEX training_jobs_delivery_analytics_idx ON academy.training_automation_jobs USING btree (tenant_id, delivery_state, created_at DESC);
CREATE INDEX accounting_collections_created_by_idx ON accounting_core.collection_actions USING btree (created_by_subject_id);
CREATE INDEX accounting_collections_customer_fk_idx ON accounting_core.collection_actions USING btree (tenant_id, customer_account_id);
CREATE INDEX accounting_collections_invoice_fk_idx ON accounting_core.collection_actions USING btree (tenant_id, invoice_id);
CREATE INDEX accounting_commands_actor_idx ON accounting_core.commands USING btree (actor_subject_id);
CREATE INDEX accounting_customers_created_by_idx ON accounting_core.customer_accounts USING btree (created_by_subject_id);
CREATE INDEX accounting_customers_updated_by_idx ON accounting_core.customer_accounts USING btree (updated_by_subject_id);
CREATE INDEX accounting_document_events_actor_idx ON accounting_core.document_events USING btree (actor_subject_id);
CREATE INDEX accounting_document_events_idx ON accounting_core.document_events USING btree (tenant_id, document_id, created_at DESC);
CREATE INDEX accounting_allocations_created_by_idx ON accounting_core.payment_allocations USING btree (created_by_subject_id);
CREATE INDEX accounting_allocations_invoice_fk_idx ON accounting_core.payment_allocations USING btree (tenant_id, invoice_id);
CREATE INDEX accounting_schedules_created_by_idx ON accounting_core.payment_schedules USING btree (created_by_subject_id);
CREATE INDEX accounting_payments_created_by_idx ON accounting_core.payments USING btree (created_by_subject_id);
CREATE INDEX accounting_payments_customer_time_idx ON accounting_core.payments USING btree (tenant_id, customer_account_id, received_at DESC);
CREATE UNIQUE INDEX accounting_payments_source_idx ON accounting_core.payments USING btree (tenant_id, source_type, source_id) WHERE (source_id IS NOT NULL);
CREATE INDEX accounting_payments_verified_by_idx ON accounting_core.payments USING btree (verified_by_subject_id);
CREATE INDEX accounting_receipts_issued_by_idx ON accounting_core.receipts USING btree (issued_by_subject_id);
CREATE INDEX accounting_refunds_approved_by_idx ON accounting_core.refunds USING btree (approved_by_subject_id);
CREATE INDEX accounting_refunds_completed_by_idx ON accounting_core.refunds USING btree (completed_by_subject_id);
CREATE INDEX accounting_refunds_credit_note_fk_idx ON accounting_core.refunds USING btree (tenant_id, credit_note_id);
CREATE INDEX accounting_refunds_customer_fk_idx ON accounting_core.refunds USING btree (tenant_id, customer_account_id);
CREATE INDEX accounting_refunds_invoice_fk_idx ON accounting_core.refunds USING btree (tenant_id, invoice_id);
CREATE INDEX accounting_refunds_payment_fk_idx ON accounting_core.refunds USING btree (tenant_id, payment_id);
CREATE INDEX accounting_refunds_requested_by_idx ON accounting_core.refunds USING btree (requested_by_subject_id);
CREATE INDEX accounting_refunds_tenant_status_idx ON accounting_core.refunds USING btree (tenant_id, status, created_at DESC);
CREATE INDEX accounting_documents_contact_fk_idx ON accounting_core.sales_documents USING btree (tenant_id, contact_id);
CREATE INDEX accounting_documents_created_by_idx ON accounting_core.sales_documents USING btree (created_by_subject_id);
CREATE INDEX accounting_documents_customer_date_idx ON accounting_core.sales_documents USING btree (tenant_id, customer_account_id, issue_date DESC);
CREATE INDEX accounting_documents_issued_by_idx ON accounting_core.sales_documents USING btree (issued_by_subject_id);
CREATE INDEX accounting_documents_parent_fk_idx ON accounting_core.sales_documents USING btree (tenant_id, parent_document_id);
CREATE UNIQUE INDEX accounting_documents_source_idx ON accounting_core.sales_documents USING btree (tenant_id, source_type, source_id) WHERE (source_id IS NOT NULL);
CREATE INDEX accounting_documents_status_due_idx ON accounting_core.sales_documents USING btree (tenant_id, status, due_date) WHERE (document_type = ANY (ARRAY['invoice'::text, 'debit_note'::text]));
CREATE INDEX accounting_documents_updated_by_idx ON accounting_core.sales_documents USING btree (updated_by_subject_id);
CREATE INDEX accounting_tenant_profiles_created_by_idx ON accounting_core.tenant_profiles USING btree (created_by_subject_id);
CREATE INDEX accounting_tenant_profiles_updated_by_idx ON accounting_core.tenant_profiles USING btree (updated_by_subject_id);
CREATE INDEX work_notifications_contact_reference_idx ON work_core.notifications USING btree (contact_id) WHERE (contact_id IS NOT NULL);
CREATE INDEX work_notifications_handoff_reference_idx ON work_core.notifications USING btree (handoff_id) WHERE (handoff_id IS NOT NULL);
CREATE INDEX work_notifications_recipient_reference_idx ON work_core.notifications USING btree (recipient_staff_id);
CREATE INDEX work_notifications_recipient_time_idx ON work_core.notifications USING btree (tenant_id, recipient_staff_id, created_at DESC);
CREATE INDEX work_notifications_recipient_unread_idx ON work_core.notifications USING btree (tenant_id, recipient_staff_id, created_at DESC) WHERE (read_at IS NULL);
CREATE INDEX work_task_history_actor_reference_idx ON work_core.task_history USING btree (actor_subject_id) WHERE (actor_subject_id IS NOT NULL);
CREATE INDEX work_task_history_contact_reference_idx ON work_core.task_history USING btree (contact_id) WHERE (contact_id IS NOT NULL);
CREATE INDEX work_task_history_next_assignee_reference_idx ON work_core.task_history USING btree (next_assigned_staff_id) WHERE (next_assigned_staff_id IS NOT NULL);
CREATE INDEX work_task_history_opportunity_reference_idx ON work_core.task_history USING btree (opportunity_id) WHERE (opportunity_id IS NOT NULL);
CREATE INDEX work_task_history_previous_assignee_reference_idx ON work_core.task_history USING btree (previous_assigned_staff_id) WHERE (previous_assigned_staff_id IS NOT NULL);
CREATE INDEX work_task_history_tenant_contact_changed_idx ON work_core.task_history USING btree (tenant_id, contact_id, changed_at DESC) WHERE (contact_id IS NOT NULL);
CREATE INDEX work_task_history_tenant_task_changed_idx ON work_core.task_history USING btree (tenant_id, task_id, changed_at DESC);
CREATE INDEX work_tasks_activity_idx ON work_core.tasks USING btree (activity_id);
CREATE INDEX work_tasks_assignee_due_idx ON work_core.tasks USING btree (assigned_staff_id, due_at, status);
CREATE INDEX work_tasks_contact_idx ON work_core.tasks USING btree (contact_id, due_at);
CREATE INDEX work_tasks_creator_reference_idx ON work_core.tasks USING btree (created_by_subject_id);
CREATE UNIQUE INDEX work_tasks_one_open_sales_followup_idx ON work_core.tasks USING btree (tenant_id, contact_id) WHERE ((contact_id IS NOT NULL) AND (status = ANY (ARRAY['todo'::text, 'in_progress'::text])) AND (COALESCE((metadata ->> 'source'::text), ''::text) = ANY (ARRAY['lead_assignment'::text, 'opportunity_next_action'::text, 'activity_next_action'::text, 'lead_next_action'::text, 'sales_followup'::text])));
CREATE INDEX work_tasks_opportunity_idx ON work_core.tasks USING btree (opportunity_id, due_at);
CREATE INDEX work_tasks_tenant_contact_due_idx ON work_core.tasks USING btree (tenant_id, contact_id, due_at DESC) WHERE (contact_id IS NOT NULL);
CREATE INDEX work_tasks_tenant_due_status_idx ON work_core.tasks USING btree (tenant_id, due_at, status);
CREATE INDEX access_membership_roles_role_idx ON access_control.membership_roles USING btree (role_id);
CREATE UNIQUE INDEX access_memberships_platform_unique_idx ON access_control.memberships USING btree (subject_id) WHERE (scope = 'platform'::text);
CREATE INDEX access_memberships_tenant_idx ON access_control.memberships USING btree (tenant_id);
CREATE UNIQUE INDEX access_memberships_tenant_unique_idx ON access_control.memberships USING btree (subject_id, tenant_id) WHERE (scope = 'tenant'::text);
CREATE UNIQUE INDEX access_roles_platform_key_idx ON access_control.roles USING btree (role_key) WHERE (tenant_id IS NULL);
CREATE UNIQUE INDEX access_roles_tenant_key_idx ON access_control.roles USING btree (tenant_id, role_key) WHERE (tenant_id IS NOT NULL);
CREATE UNIQUE INDEX access_subjects_email_lower_idx ON access_control.subjects USING btree (lower(email));
CREATE INDEX audit_events_actor_time_idx ON audit_log.events USING btree (actor_subject_id, occurred_at DESC);
CREATE INDEX audit_events_tenant_resource_history_idx ON audit_log.events USING btree (tenant_id, resource_type, resource_id, occurred_at DESC);
CREATE INDEX audit_events_tenant_time_idx ON audit_log.events USING btree (tenant_id, occurred_at DESC);
CREATE INDEX core_tenants_organization_idx ON core.tenants USING btree (organization_id);
CREATE INDEX core_tenants_status_idx ON core.tenants USING btree (status);
CREATE INDEX role_guide_progress_subject_idx ON people.role_guide_progress USING btree (subject_id, tenant_id);
CREATE INDEX role_guide_progress_tenant_status_idx ON people.role_guide_progress USING btree (tenant_id, status);
CREATE UNIQUE INDEX commerce_staff_tenant_id_idx ON people.staff_profiles USING btree (tenant_id, id);
CREATE INDEX people_staff_department_reference_idx ON people.staff_profiles USING btree (department_id) WHERE (department_id IS NOT NULL);
CREATE UNIQUE INDEX people_staff_tenant_code_idx ON people.staff_profiles USING btree (tenant_id, employee_code) WHERE (employee_code IS NOT NULL);
CREATE INDEX people_staff_tenant_department_idx ON people.staff_profiles USING btree (tenant_id, department_id);
CREATE UNIQUE INDEX people_staff_tenant_email_idx ON people.staff_profiles USING btree (tenant_id, email) WHERE (email IS NOT NULL);
CREATE UNIQUE INDEX people_staff_tenant_name_role_idx ON people.staff_profiles USING btree (tenant_id, lower(full_name), role_key);
CREATE INDEX people_staff_tenant_role_idx ON people.staff_profiles USING btree (tenant_id, role_key);
CREATE INDEX staff_profiles_supervisor_staff_idx ON people.staff_profiles USING btree (tenant_id, supervisor_staff_id) WHERE (supervisor_staff_id IS NOT NULL);
CREATE INDEX sales_activities_actor_idx ON sales_core.activities USING btree (actor_staff_id, occurred_at DESC);
CREATE INDEX sales_activities_contact_idx ON sales_core.activities USING btree (contact_id, occurred_at DESC);
CREATE INDEX sales_activities_creator_reference_idx ON sales_core.activities USING btree (created_by_subject_id);
CREATE INDEX sales_activities_opportunity_idx ON sales_core.activities USING btree (opportunity_id, occurred_at DESC);
CREATE INDEX sales_activities_tenant_contact_occurred_idx ON sales_core.activities USING btree (tenant_id, contact_id, occurred_at DESC);
CREATE INDEX sales_activities_tenant_occurred_idx ON sales_core.activities USING btree (tenant_id, occurred_at DESC);
CREATE INDEX contact_identities_contact_idx ON sales_core.contact_identities USING btree (contact_id, tenant_id);
CREATE INDEX contact_identities_tenant_contact_idx ON sales_core.contact_identities USING btree (tenant_id, contact_id);
CREATE UNIQUE INDEX contact_identities_tenant_type_value_uidx ON sales_core.contact_identities USING btree (tenant_id, identity_type, identity_value);
CREATE INDEX sales_contacts_course_reference_idx ON sales_core.contacts USING btree (interest_course_id);
CREATE INDEX sales_contacts_creator_reference_idx ON sales_core.contacts USING btree (created_by_subject_id);
CREATE INDEX sales_contacts_owner_reference_idx ON sales_core.contacts USING btree (owner_staff_id);
CREATE INDEX sales_contacts_owner_workspace_order_idx ON sales_core.contacts USING btree (tenant_id, owner_staff_id, next_action_at, created_at DESC, id DESC);
CREATE INDEX sales_contacts_tenant_course_idx ON sales_core.contacts USING btree (tenant_id, interest_course_id);
CREATE INDEX sales_contacts_tenant_created_dashboard_idx ON sales_core.contacts USING btree (tenant_id, created_at) INCLUDE (status, lead_status, source);
CREATE UNIQUE INDEX sales_contacts_tenant_id_id_uidx ON sales_core.contacts USING btree (tenant_id, id);
CREATE INDEX sales_contacts_tenant_lead_quality_idx ON sales_core.contacts USING btree (tenant_id, lead_quality, source);
CREATE INDEX sales_contacts_tenant_lead_status_idx ON sales_core.contacts USING btree (tenant_id, lead_status, owner_staff_id);
CREATE INDEX sales_contacts_tenant_next_action_idx ON sales_core.contacts USING btree (tenant_id, next_action_at) WHERE (next_action_at IS NOT NULL);
CREATE INDEX sales_contacts_tenant_owner_created_idx ON sales_core.contacts USING btree (tenant_id, owner_staff_id, created_at DESC);
CREATE INDEX sales_contacts_tenant_owner_status_idx ON sales_core.contacts USING btree (tenant_id, owner_staff_id, status);
CREATE INDEX sales_contacts_tenant_phone_digits_idx ON sales_core.contacts USING btree (tenant_id, "right"(regexp_replace(COALESCE(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 9)) WHERE (phone IS NOT NULL);
CREATE INDEX sales_contacts_tenant_whatsapp_digits_idx ON sales_core.contacts USING btree (tenant_id, "right"(regexp_replace(COALESCE(whatsapp, ''::text), '[^0-9]'::text, ''::text, 'g'::text), 9)) WHERE (whatsapp IS NOT NULL);
CREATE INDEX sales_contacts_workspace_order_idx ON sales_core.contacts USING btree (tenant_id, next_action_at, created_at DESC, id DESC);
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_assessed_by_subject_id_fkey FOREIGN KEY (assessed_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES academy.enrollments(id) ON DELETE CASCADE;
ALTER TABLE academy.assessment_results ADD CONSTRAINT assessment_results_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES academy.enrollments(id) ON DELETE CASCADE;
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_marked_by_subject_id_fkey FOREIGN KEY (marked_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_session_id_fkey FOREIGN KEY (session_id) REFERENCES academy.course_run_sessions(id) ON DELETE CASCADE;
ALTER TABLE academy.attendance_records ADD CONSTRAINT attendance_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE RESTRICT;
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES academy.enrollments(id) ON DELETE RESTRICT;
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_issued_by_subject_id_fkey FOREIGN KEY (issued_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_revoked_by_subject_id_fkey FOREIGN KEY (revoked_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.certificates ADD CONSTRAINT certificates_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.course_run_rules ADD CONSTRAINT course_run_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.course_run_sessions ADD CONSTRAINT course_run_sessions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_course_id_fkey FOREIGN KEY (course_id) REFERENCES academy.courses(id) ON DELETE CASCADE;
ALTER TABLE academy.course_runs ADD CONSTRAINT course_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.courses ADD CONSTRAINT courses_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_confirmed_by_subject_id_fkey FOREIGN KEY (confirmed_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_course_id_fkey FOREIGN KEY (course_id) REFERENCES academy.courses(id) ON DELETE RESTRICT;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE RESTRICT;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_handoff_id_fkey FOREIGN KEY (handoff_id) REFERENCES academy.registration_handoffs(id) ON DELETE RESTRICT;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_student_id_fkey FOREIGN KEY (student_id) REFERENCES academy.students(id) ON DELETE RESTRICT;
ALTER TABLE academy.enrollments ADD CONSTRAINT enrollments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_handoff_id_fkey FOREIGN KEY (handoff_id) REFERENCES academy.registration_handoffs(id) ON DELETE CASCADE;
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_reviewed_by_subject_id_fkey FOREIGN KEY (reviewed_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_documents ADD CONSTRAINT registration_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_accepted_by_subject_id_fkey FOREIGN KEY (accepted_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_assigned_department_id_fkey FOREIGN KEY (assigned_department_id) REFERENCES people.departments(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_assigned_staff_id_fkey FOREIGN KEY (assigned_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_completed_by_subject_id_fkey FOREIGN KEY (completed_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE CASCADE;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_course_id_fkey FOREIGN KEY (course_id) REFERENCES academy.courses(id) ON DELETE RESTRICT;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES sales_core.opportunities(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_payment_verified_by_subject_id_fkey FOREIGN KEY (payment_verified_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.registration_handoffs ADD CONSTRAINT registration_handoffs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES academy.enrollments(id) ON DELETE CASCADE;
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_sent_by_subject_id_fkey FOREIGN KEY (sent_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.student_communications ADD CONSTRAINT student_communications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.students ADD CONSTRAINT students_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE RESTRICT;
ALTER TABLE academy.students ADD CONSTRAINT students_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.students ADD CONSTRAINT students_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_course_run_id_fkey FOREIGN KEY (course_run_id) REFERENCES academy.course_runs(id) ON DELETE CASCADE;
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_enrollment_id_fkey FOREIGN KEY (enrollment_id) REFERENCES academy.enrollments(id) ON DELETE CASCADE;
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_session_id_fkey FOREIGN KEY (session_id) REFERENCES academy.course_run_sessions(id) ON DELETE CASCADE;
ALTER TABLE academy.training_automation_jobs ADD CONSTRAINT training_automation_jobs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE academy.training_automation_settings ADD CONSTRAINT training_automation_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE access_control.membership_roles ADD CONSTRAINT membership_roles_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES access_control.memberships(id) ON DELETE CASCADE;
ALTER TABLE access_control.membership_roles ADD CONSTRAINT membership_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES access_control.roles(id) ON DELETE CASCADE;
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES access_control.subjects(id) ON DELETE CASCADE;
ALTER TABLE access_control.memberships ADD CONSTRAINT memberships_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE access_control.platform_invitations ADD CONSTRAINT platform_invitations_accepted_by_subject_id_fkey FOREIGN KEY (accepted_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE access_control.platform_invitations ADD CONSTRAINT platform_invitations_invited_by_subject_id_fkey FOREIGN KEY (invited_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE access_control.role_permissions ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES access_control.permissions(permission_key) ON DELETE CASCADE;
ALTER TABLE access_control.role_permissions ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES access_control.roles(id) ON DELETE CASCADE;
ALTER TABLE access_control.roles ADD CONSTRAINT roles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE access_control.subjects ADD CONSTRAINT subjects_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_accepted_by_subject_id_fkey FOREIGN KEY (accepted_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_invited_by_subject_id_fkey FOREIGN KEY (invited_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE access_control.tenant_invitations ADD CONSTRAINT tenant_invitations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_tenant_id_customer_account_id_fkey FOREIGN KEY (tenant_id, customer_account_id) REFERENCES accounting_core.customer_accounts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.collection_actions ADD CONSTRAINT collection_actions_tenant_id_invoice_id_fkey FOREIGN KEY (tenant_id, invoice_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.commands ADD CONSTRAINT commands_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.commands ADD CONSTRAINT commands_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES sales_core.contacts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.customer_accounts ADD CONSTRAINT customer_accounts_updated_by_subject_id_fkey FOREIGN KEY (updated_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.document_events ADD CONSTRAINT document_events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.document_events ADD CONSTRAINT document_events_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.document_events ADD CONSTRAINT document_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.document_sequences ADD CONSTRAINT document_sequences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_tenant_id_invoice_id_fkey FOREIGN KEY (tenant_id, invoice_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.payment_allocations ADD CONSTRAINT payment_allocations_tenant_id_payment_id_fkey FOREIGN KEY (tenant_id, payment_id) REFERENCES accounting_core.payments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.payment_schedules ADD CONSTRAINT payment_schedules_tenant_id_invoice_id_fkey FOREIGN KEY (tenant_id, invoice_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_tenant_id_customer_account_id_fkey FOREIGN KEY (tenant_id, customer_account_id) REFERENCES accounting_core.customer_accounts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.payments ADD CONSTRAINT payments_verified_by_subject_id_fkey FOREIGN KEY (verified_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_issued_by_subject_id_fkey FOREIGN KEY (issued_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.receipts ADD CONSTRAINT receipts_tenant_id_payment_id_fkey FOREIGN KEY (tenant_id, payment_id) REFERENCES accounting_core.payments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_approved_by_subject_id_fkey FOREIGN KEY (approved_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_completed_by_subject_id_fkey FOREIGN KEY (completed_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_requested_by_subject_id_fkey FOREIGN KEY (requested_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_credit_note_id_fkey FOREIGN KEY (tenant_id, credit_note_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_customer_account_id_fkey FOREIGN KEY (tenant_id, customer_account_id) REFERENCES accounting_core.customer_accounts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_invoice_id_fkey FOREIGN KEY (tenant_id, invoice_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.refunds ADD CONSTRAINT refunds_tenant_id_payment_id_fkey FOREIGN KEY (tenant_id, payment_id) REFERENCES accounting_core.payments(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tenant_id_document_id_fkey FOREIGN KEY (tenant_id, document_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE accounting_core.sales_document_lines ADD CONSTRAINT sales_document_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_issued_by_subject_id_fkey FOREIGN KEY (issued_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_contact_id_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES sales_core.contacts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_customer_account_id_fkey FOREIGN KEY (tenant_id, customer_account_id) REFERENCES accounting_core.customer_accounts(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_tenant_id_parent_document_id_fkey FOREIGN KEY (tenant_id, parent_document_id) REFERENCES accounting_core.sales_documents(tenant_id, id) ON DELETE RESTRICT;
ALTER TABLE accounting_core.sales_documents ADD CONSTRAINT sales_documents_updated_by_subject_id_fkey FOREIGN KEY (updated_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE accounting_core.tenant_profiles ADD CONSTRAINT tenant_profiles_updated_by_subject_id_fkey FOREIGN KEY (updated_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_interest_course_id_fkey FOREIGN KEY (interest_course_id) REFERENCES academy.courses(id) ON DELETE SET NULL;
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_owner_staff_id_fkey FOREIGN KEY (owner_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE sales_core.contacts ADD CONSTRAINT contacts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE CASCADE;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_course_id_fkey FOREIGN KEY (course_id) REFERENCES academy.courses(id) ON DELETE SET NULL;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_owner_staff_id_fkey FOREIGN KEY (owner_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_stage_id_fkey FOREIGN KEY (stage_id) REFERENCES sales_core.pipeline_stages(id) ON DELETE RESTRICT;
ALTER TABLE sales_core.opportunities ADD CONSTRAINT opportunities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE CASCADE;
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_handoff_id_fkey FOREIGN KEY (handoff_id) REFERENCES academy.registration_handoffs(id) ON DELETE CASCADE;
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_recipient_staff_id_fkey FOREIGN KEY (recipient_staff_id) REFERENCES people.staff_profiles(id) ON DELETE CASCADE;
ALTER TABLE work_core.notifications ADD CONSTRAINT notifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE SET NULL;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_next_assigned_staff_id_fkey FOREIGN KEY (next_assigned_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES sales_core.opportunities(id) ON DELETE SET NULL;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_previous_assigned_staff_id_fkey FOREIGN KEY (previous_assigned_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE work_core.task_history ADD CONSTRAINT task_history_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES sales_core.activities(id) ON DELETE SET NULL;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_assigned_staff_id_fkey FOREIGN KEY (assigned_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE CASCADE;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES sales_core.opportunities(id) ON DELETE CASCADE;
ALTER TABLE work_core.tasks ADD CONSTRAINT tasks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE audit_log.events ADD CONSTRAINT events_actor_subject_id_fkey FOREIGN KEY (actor_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE audit_log.events ADD CONSTRAINT events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE SET NULL;
ALTER TABLE core.tenants ADD CONSTRAINT tenants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations(id) ON DELETE RESTRICT;
ALTER TABLE people.departments ADD CONSTRAINT departments_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES access_control.subjects(id) ON DELETE CASCADE;
ALTER TABLE people.role_guide_progress ADD CONSTRAINT role_guide_progress_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_department_id_fkey FOREIGN KEY (department_id) REFERENCES people.departments(id) ON DELETE SET NULL;
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_membership_id_fkey FOREIGN KEY (membership_id) REFERENCES access_control.memberships(id) ON DELETE SET NULL;
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_supervisor_staff_fk FOREIGN KEY (supervisor_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE people.staff_profiles ADD CONSTRAINT staff_profiles_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_actor_staff_id_fkey FOREIGN KEY (actor_staff_id) REFERENCES people.staff_profiles(id) ON DELETE SET NULL;
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES sales_core.contacts(id) ON DELETE CASCADE;
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_created_by_subject_id_fkey FOREIGN KEY (created_by_subject_id) REFERENCES access_control.subjects(id) ON DELETE SET NULL;
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_opportunity_id_fkey FOREIGN KEY (opportunity_id) REFERENCES sales_core.opportunities(id) ON DELETE CASCADE;
ALTER TABLE sales_core.activities ADD CONSTRAINT activities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_contact_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES sales_core.contacts(tenant_id, id) ON DELETE CASCADE;
ALTER TABLE sales_core.contact_identities ADD CONSTRAINT contact_identities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;
ALTER TABLE sales_core.pipeline_stages ADD CONSTRAINT pipeline_stages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES core.tenants(id) ON DELETE CASCADE;

-- Canonical historical lead-status table used by admission payment verification.
create table sales_core.lead_status_history (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_id uuid not null
    references sales_core.contacts(id) on delete cascade,
  activity_id uuid
    references sales_core.activities(id) on delete set null,
  from_status text,
  to_status text not null,
  reason text,
  changed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  changed_at timestamptz not null default now()
);
