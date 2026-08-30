begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- ODEIRY Manager v1.
--
-- Safety properties:
--   * additive and disabled for every tenant by default;
--   * available only to real active tenant members with an independent
--     manager permission (platform-operator preview is deliberately denied);
--   * manager and operations conversations are separated server-side;
--   * memory is personal, proposed from literal current-user evidence, and
--     never injected before an explicit, versioned approval;
--   * analytics expose a fixed aggregate allowlist only and are capped at two
--     reads per run;
--   * there are no write/action tools and manager runs cannot link tickets.

do $preflight$
begin
  if to_regclass('core.tenants') is null
     or to_regclass('access_control.subjects') is null
     or to_regclass('core.odeiry_threads') is null
     or to_regclass('core.odeiry_runs') is null
     or to_regclass('core.odeiry_messages') is null
     or to_regclass('core.odeiry_tenant_settings') is null
     or to_regclass('platform.odeiry_runtime_settings') is null
     or to_regclass('access_control.permissions') is null
     or to_regclass('access_control.memberships') is null
     or to_regclass('access_control.membership_roles') is null
     or to_regclass('access_control.roles') is null
     or to_regclass('access_control.role_permissions') is null then
    raise exception 'odeiry_manager_missing_required_schema';
  end if;
  if to_regprocedure('private_app.current_subject_id()') is null
     or to_regprocedure(
       'private_app.support_is_active_tenant_member(uuid)'
     ) is null
     or to_regprocedure('private_app.odeiry_is_available(uuid)') is null
     or to_regprocedure(
       'private_app.odeiry_validate_client_request_id(text)'
     ) is null
     or to_regprocedure(
       'private_app.odeiry_sha256(jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.odeiry_set_updated_at_clock()'
     ) is null
     or to_regprocedure(
       'private_app.odeiry_is_platform_operator(uuid)'
     ) is null
     or to_regprocedure(
       'private_app.has_platform_permission(text)'
     ) is null
     or to_regprocedure(
       'private_app.write_audit(text,text,text,uuid,jsonb)'
     ) is null
     or to_regprocedure(
       'private_app.v1_tenant_deletion_preview_document(uuid)'
     ) is null
     or to_regprocedure(
       'public.v3_tenant_odeiry_action(text,text,jsonb)'
     ) is null
     or to_regprocedure(
       'public.v3_tenant_odeiry_snapshot(text)'
     ) is null
     or to_regprocedure(
       'public.v3_tenant_odeiry_finalize(text,uuid,text,jsonb)'
     ) is null
     or to_regprocedure(
       'public.v5_tenant_reports_snapshot(text,date,date,uuid,text,integer,integer)'
     ) is null then
    raise exception 'odeiry_manager_missing_required_function';
  end if;
end;
$preflight$;

-- Independent database-level kill switch. Adding the column with a false
-- default makes the feature unavailable on every existing environment until
-- an audited, version-checked platform action enables it deliberately.
alter table platform.odeiry_runtime_settings
add column manager_enabled boolean not null default false;

insert into access_control.permissions(
  permission_key,module_key,name_ar,description
) values (
  'tenant.odeiry_manager.use','ai_assistant','استخدام أوديري المدير',
  'استخدام ذاكرة أوديري الشخصية الخاضعة للمراجعة والتحليل الإداري المجمع للقراءة فقط'
)
on conflict(permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

-- This permission is intentionally not granted by a tenant.* wildcard.
-- Existing global and tenant-specific copies of only these three role keys
-- receive it; sales and support roles keep the operations assistant only.
insert into access_control.role_permissions(role_id,permission_key)
select role.id,'tenant.odeiry_manager.use'
from access_control.roles role
where role.scope='tenant'
  and role.role_key in (
    'tenant_owner','tenant_admin','executive_manager'
  )
on conflict do nothing;

alter table core.odeiry_runs
add column manager_analytics_count smallint not null default 0;

alter table core.odeiry_runs
add constraint odeiry_runs_manager_analytics_count_check
check (manager_analytics_count between 0 and 2);

alter table core.odeiry_runs
add column manager_memory_batch_hash text,
add column manager_memory_persisted_count smallint not null default 0;

alter table core.odeiry_runs
add constraint odeiry_runs_manager_memory_batch_hash_check
check (
  manager_memory_batch_hash is null
  or manager_memory_batch_hash ~ '^[a-f0-9]{64}$'
),
add constraint odeiry_runs_manager_memory_persisted_count_check
check (manager_memory_persisted_count between 0 and 2),
add constraint odeiry_runs_manager_memory_receipt_check
check (
  manager_memory_batch_hash is not null
  or manager_memory_persisted_count=0
);

create table core.odeiry_manager_settings (
  tenant_id uuid primary key
    references core.tenants(id) on delete restrict,
  enabled boolean not null default false,
  max_approved_memories_per_owner smallint not null default 50
    check (max_approved_memories_per_owner between 5 and 100),
  max_pending_memories_per_owner smallint not null default 20
    check (max_pending_memories_per_owner between 2 and 50),
  version integer not null default 1 check (version >= 1),
  enabled_at timestamptz,
  enabled_by_subject_id uuid
    references access_control.subjects(id) on delete restrict,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint odeiry_manager_settings_enabled_audit_check check (
    (not enabled and enabled_at is null and enabled_by_subject_id is null)
    or (enabled and enabled_at is not null and enabled_by_subject_id is not null)
  )
);

-- The marker is authoritative for capability separation. Existing threads are
-- operations threads because no backfill creates a manager marker.
create table core.odeiry_manager_threads (
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  thread_id uuid not null,
  owner_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (tenant_id,thread_id),
  constraint odeiry_manager_threads_owner_key
    unique (tenant_id,thread_id,owner_subject_id),
  constraint odeiry_manager_threads_owned_thread_fk
    foreign key (tenant_id,thread_id,owner_subject_id)
    references core.odeiry_threads(
      tenant_id,id,created_by_subject_id
    ) on delete restrict
);

create table core.odeiry_manager_memories (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  owner_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  memory_key text not null
    check (memory_key ~ '^[a-z][a-z0-9_.-]{2,79}$'),
  category text not null
    check (category in (
      'goal','preference','constraint','operating_principle',
      'decision_context'
    )),
  statement text not null
    check (
      char_length(btrim(statement)) between 3 and 240
      and octet_length(statement) <= 960
    ),
  evidence_basis text not null
    check (evidence_basis = 'current_user_explicit'),
  evidence_hash text not null check (evidence_hash ~ '^[a-f0-9]{64}$'),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'proposed'
    check (status in ('proposed','approved','rejected','archived')),
  source_thread_id uuid not null,
  source_run_id uuid not null,
  version integer not null default 1 check (version >= 1),
  reviewed_at timestamptz,
  reviewed_by_subject_id uuid
    references access_control.subjects(id) on delete restrict,
  archived_at timestamptz,
  valid_for_days smallint
    check (valid_for_days is null or valid_for_days in (30,90,180,365)),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint odeiry_manager_memories_tenant_id_id_key
    unique (tenant_id,id),
  constraint odeiry_manager_memories_owner_key
    unique (tenant_id,id,owner_subject_id),
  constraint odeiry_manager_memories_source_run_fk
    foreign key (tenant_id,source_run_id,source_thread_id)
    references core.odeiry_runs(tenant_id,id,thread_id)
    on delete restrict,
  constraint odeiry_manager_memories_source_owner_fk
    foreign key (tenant_id,source_thread_id,owner_subject_id)
    references core.odeiry_manager_threads(
      tenant_id,thread_id,owner_subject_id
    ) on delete restrict,
  constraint odeiry_manager_memories_review_state_check check (
    (
      status='proposed'
      and reviewed_at is null
      and reviewed_by_subject_id is null
      and archived_at is null
      and expires_at is null
    )
    or (
      status in ('approved','rejected')
      and reviewed_at is not null
      and reviewed_by_subject_id is not null
      and archived_at is null
      and (status<>'rejected' or expires_at is null)
      and (
        status<>'approved'
        or expires_at is null
        or expires_at>reviewed_at
      )
    )
    or (
      status='archived'
      and reviewed_at is not null
      and reviewed_by_subject_id is not null
      and archived_at is not null
    )
  )
);

create table core.odeiry_manager_memory_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete restrict,
  owner_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  memory_id uuid not null,
  action text not null check (action in ('approve','reject','archive')),
  client_request_id text not null
    check (
      char_length(client_request_id) between 8 and 160
      and client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$'
    ),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  result_data jsonb not null
    check (
      jsonb_typeof(result_data)='object'
      and octet_length(result_data::text) <= 2048
    ),
  created_at timestamptz not null default now(),
  constraint odeiry_manager_memory_requests_memory_fk
    foreign key (tenant_id,memory_id,owner_subject_id)
    references core.odeiry_manager_memories(
      tenant_id,id,owner_subject_id
    ) on delete restrict,
  constraint odeiry_manager_memory_requests_idempotency_key
    unique (tenant_id,owner_subject_id,client_request_id)
);

create index core_odeiry_manager_settings_enabled_idx
on core.odeiry_manager_settings(tenant_id) where enabled;

create index core_odeiry_manager_settings_enabled_by_idx
on core.odeiry_manager_settings(enabled_by_subject_id)
where enabled_by_subject_id is not null;

create index core_odeiry_manager_settings_updated_by_idx
on core.odeiry_manager_settings(updated_by_subject_id)
where updated_by_subject_id is not null;

create index core_odeiry_manager_threads_owner_activity_idx
on core.odeiry_manager_threads(
  tenant_id,owner_subject_id,created_at desc,thread_id
);

create index core_odeiry_manager_threads_owner_subject_idx
on core.odeiry_manager_threads(owner_subject_id);

create index core_odeiry_manager_memories_owner_status_idx
on core.odeiry_manager_memories(
  tenant_id,owner_subject_id,status,updated_at desc,id desc
);

create index core_odeiry_manager_memories_source_run_idx
on core.odeiry_manager_memories(
  tenant_id,source_run_id,source_thread_id
);

create index core_odeiry_manager_memories_source_owner_idx
on core.odeiry_manager_memories(
  tenant_id,source_thread_id,owner_subject_id
);

create index core_odeiry_manager_memories_owner_subject_idx
on core.odeiry_manager_memories(owner_subject_id);

create index core_odeiry_manager_memories_reviewer_idx
on core.odeiry_manager_memories(reviewed_by_subject_id)
where reviewed_by_subject_id is not null;

create unique index core_odeiry_manager_memories_one_proposed_key_uidx
on core.odeiry_manager_memories(
  tenant_id,owner_subject_id,memory_key
) where status='proposed';

create unique index core_odeiry_manager_memories_one_approved_key_uidx
on core.odeiry_manager_memories(
  tenant_id,owner_subject_id,memory_key
) where status='approved';

create unique index core_odeiry_manager_memories_source_content_uidx
on core.odeiry_manager_memories(
  tenant_id,source_run_id,content_hash
);

create index core_odeiry_manager_memory_requests_memory_idx
on core.odeiry_manager_memory_requests(
  tenant_id,memory_id,owner_subject_id
);

create index core_odeiry_manager_memory_requests_owner_subject_idx
on core.odeiry_manager_memory_requests(owner_subject_id);

alter table core.odeiry_manager_settings enable row level security;
alter table core.odeiry_manager_threads enable row level security;
alter table core.odeiry_manager_memories enable row level security;
alter table core.odeiry_manager_memory_requests enable row level security;

revoke all on table core.odeiry_manager_settings
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_manager_threads
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_manager_memories
from public,anon,authenticated,service_role;
revoke all on table core.odeiry_manager_memory_requests
from public,anon,authenticated,service_role;

create or replace function private_app.odeiry_manager_can_use(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null
    and private_app.support_is_active_tenant_member(p_tenant_id)
    and not private_app.odeiry_is_platform_operator(p_tenant_id)
    and not exists(
      select 1
      from access_control.subjects platform_subject
      join access_control.memberships platform_membership
        on platform_membership.subject_id=platform_subject.id
       and platform_membership.scope='platform'
       and platform_membership.status='active'
      where platform_subject.auth_user_id=auth.uid()
        and platform_subject.status='active'
        and not platform_subject.must_change_password
    )
    and exists(
      select 1
      from access_control.subjects subject
      join access_control.memberships membership
        on membership.subject_id=subject.id
       and membership.scope='tenant'
       and membership.status='active'
       and membership.tenant_id=p_tenant_id
      join access_control.membership_roles membership_role
        on membership_role.membership_id=membership.id
      join access_control.roles role
        on role.id=membership_role.role_id
       and role.scope='tenant'
       and (role.tenant_id is null or role.tenant_id=p_tenant_id)
      join access_control.role_permissions role_permission
        on role_permission.role_id=role.id
       and role_permission.permission_key='tenant.odeiry_manager.use'
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
    )
$$;

create or replace function private_app.odeiry_manager_runtime_enabled()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from platform.odeiry_runtime_settings runtime
    where runtime.singleton
      and runtime.manager_enabled
  )
$$;

create or replace function private_app.odeiry_manager_is_available(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.odeiry_manager_can_use(p_tenant_id)
    and private_app.odeiry_manager_runtime_enabled()
    and private_app.odeiry_is_available(p_tenant_id)
    and exists(
      select 1
      from core.odeiry_manager_settings setting
      where setting.tenant_id=p_tenant_id
        and setting.enabled
    )
$$;

create or replace function private_app.odeiry_manager_memory_text_safe(
  p_value text
)
returns boolean
language sql
immutable
set search_path=''
as $$
  select char_length(btrim(coalesce(p_value,''))) between 3 and 240
    and octet_length(coalesce(p_value,'')) <= 960
    and lower(coalesce(p_value,'')) !~
      '[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}'
    and pg_catalog.regexp_replace(
      coalesce(p_value,''),
      '[^0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹]','','g'
    ) !~ '[0-9٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹]{8,}'
    and lower(coalesce(p_value,'')) !~
      '(api[ _-]?key|access[ _-]?token|bearer[ ]+[a-z0-9]|password|secret|كلمة[ ]+المرور|مفتاح[ ]+(سري|ربط)|تجاهل.{0,40}(تعليمات|قواعد)|ignore.{0,40}instruction|system[ ]+prompt|أمر[ ]+نظام)'
    and lower(coalesce(p_value,'')) !~
      '((our|the|my)[ ]+([a-z]+[ ]+){0,3}(manager|employee|customer|client)[ ]+(is|named)|we have.{0,40}(manager|employee|customer|client)|(عندنا|لدينا).{0,40}(مدير|موظف|موظفة|عميل|عميلة)|(مدير|موظف|موظفة|عميل|عميلة|زميلي|زميلتي).{0,40}(عندنا|لدينا|اسمه|اسمها|يدعى|تدعى))'
    and coalesce(p_value,'') !~
      '(^|[^A-Za-z])[A-Z][a-z]{1,24}([ ][A-Z][a-z]{1,24}){0,2}[ ]+((is|leads?|manages?|heads?)([^A-Za-z]|$)|(is[ ]+)?(to[ ]+)?(lead|manage|head)([^A-Za-z]|$))'
    and coalesce(p_value,'') !~
      '(^|[^اأإآء-ي])[اأإآء-ي]{2,20}[ ]+(هو|هي)[ ]+(مدير|مديرة|موظف|موظفة|عميل|عميلة|مسؤول|مسؤولة)'
    and coalesce(p_value,'') !~
      '(يدير|تدير|يقود|تقود)[ ]+[اأإآء-ي]{2,20}[ ]+(المبيعات|التسويق|القبول|الفريق|العمليات)'
$$;

create or replace function
  private_app.odeiry_manager_memory_evidence_normalized(p_value text)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  v_value text:=lower(btrim(coalesce(p_value,'')));
begin
  v_value:=pg_catalog.regexp_replace(v_value,'[[:space:]]+',' ','g');
  v_value:=pg_catalog.regexp_replace(v_value,'[.!]+$','','g');
  v_value:=btrim(v_value);
  v_value:=pg_catalog.regexp_replace(
    v_value,'^يا أوديري[،,]?[ ]*','',''
  );
  v_value:=pg_catalog.regexp_replace(
    v_value,'^(من فضلك|لو سمحت)[،,]?[ ]*','',''
  );
  v_value:=pg_catalog.regexp_replace(
    v_value,'^please[,]?[ ]+','','i'
  );
  v_value:=pg_catalog.regexp_replace(
    v_value,
    '^(احفظ|تذكر|تذكّر|اعتمد)[ ]+أن(ي|ني|نا)?[ ]+',
    '',''
  );
  v_value:=pg_catalog.regexp_replace(
    v_value,
    '^(remember|save|store|adopt)[ ]+that[ ]+',
    '','i'
  );
  return btrim(v_value);
end;
$$;

create or replace function private_app.odeiry_manager_memory_catalog_safe(
  p_memory_key text,
  p_category text,
  p_statement text,
  p_evidence_quote text,
  p_source_message text
)
returns boolean
language plpgsql
immutable
set search_path=''
as $$
declare
  v_evidence_assertion text:=
    private_app.odeiry_manager_memory_evidence_normalized(p_evidence_quote);
  v_source_assertion text:=
    private_app.odeiry_manager_memory_evidence_normalized(p_source_message);
begin
  if v_evidence_assertion<>v_source_assertion then
    return false;
  end if;
  return case lower(btrim(coalesce(p_memory_key,'')))
    when 'goal_increase_registrations' then
      lower(btrim(coalesce(p_category,'')))='goal'
      and btrim(coalesce(p_statement,''))='هدفنا زيادة التسجيلات'
      and v_source_assertion in (
        'هدفنا زيادة التسجيلات','هدفي زيادة التسجيلات',
        'our goal is to increase registrations',
        'my goal is to increase registrations'
      )
    when 'goal_improve_conversion' then
      lower(btrim(coalesce(p_category,'')))='goal'
      and btrim(coalesce(p_statement,''))='هدفنا تحسين معدل التحويل'
      and v_source_assertion in (
        'هدفنا تحسين معدل التحويل','هدفي تحسين معدل التحويل',
        'our goal is to improve conversion rate',
        'my goal is to improve conversion rate'
      )
    when 'goal_reduce_response_time' then
      lower(btrim(coalesce(p_category,'')))='goal'
      and btrim(coalesce(p_statement,''))='هدفنا تقليل زمن الاستجابة'
      and v_source_assertion in (
        'هدفنا تقليل زمن الاستجابة','هدفي تقليل زمن الاستجابة',
        'our goal is to reduce response time',
        'my goal is to reduce response time'
      )
    when 'goal_improve_follow_up' then
      lower(btrim(coalesce(p_category,'')))='goal'
      and btrim(coalesce(p_statement,''))='هدفنا تحسين انتظام المتابعة'
      and v_source_assertion in (
        'هدفنا تحسين انتظام المتابعة','هدفي تحسين انتظام المتابعة',
        'our goal is to improve follow-up consistency',
        'my goal is to improve follow-up consistency'
      )
    when 'goal_improve_data_completeness' then
      lower(btrim(coalesce(p_category,'')))='goal'
      and btrim(coalesce(p_statement,''))='هدفنا رفع اكتمال البيانات'
      and v_source_assertion in (
        'هدفنا رفع اكتمال البيانات','هدفي رفع اكتمال البيانات',
        'our goal is to improve data completeness',
        'my goal is to improve data completeness'
      )
    when 'preference_concise_answers' then
      lower(btrim(coalesce(p_category,'')))='preference'
      and btrim(coalesce(p_statement,''))=
        'أفضّل إجابات مختصرة وواضحة'
      and v_source_assertion in (
        'أفضّل إجابات مختصرة وواضحة',
        'افضل إجابات مختصرة وواضحة',
        'i prefer concise and clear answers'
      )
    when 'preference_detailed_answers' then
      lower(btrim(coalesce(p_category,'')))='preference'
      and btrim(coalesce(p_statement,''))='أفضّل إجابات تفصيلية'
      and v_source_assertion in (
        'أفضّل إجابات تفصيلية','افضل إجابات تفصيلية',
        'i prefer detailed answers'
      )
    when 'preference_summary_first' then
      lower(btrim(coalesce(p_category,'')))='preference'
      and btrim(coalesce(p_statement,''))=
        'أفضّل أن يبدأ التقرير بالملخص التنفيذي'
      and v_source_assertion in (
        'أفضّل أن يبدأ التقرير بالملخص التنفيذي',
        'افضل أن يبدأ التقرير بالملخص التنفيذي',
        'i prefer the report to start with the executive summary'
      )
    when 'preference_weekly_review' then
      lower(btrim(coalesce(p_category,'')))='preference'
      and btrim(coalesce(p_statement,''))=
        'أفضّل مراجعة المؤشرات أسبوعيًا'
      and v_source_assertion in (
        'أفضّل مراجعة المؤشرات أسبوعيًا',
        'افضل مراجعة المؤشرات أسبوعيا',
        'i prefer a weekly metrics review'
      )
    when 'principle_data_first_decisions' then
      lower(btrim(coalesce(p_category,'')))='operating_principle'
      and btrim(coalesce(p_statement,''))=
        'مبدؤنا اتخاذ القرارات بناءً على البيانات'
      and v_source_assertion in (
        'مبدؤنا اتخاذ القرارات بناءً على البيانات',
        'مبدئي اتخاذ القرارات بناءً على البيانات',
        'our principle is to make decisions based on data',
        'my principle is to make decisions based on data'
      )
    when 'principle_review_before_adoption' then
      lower(btrim(coalesce(p_category,'')))='operating_principle'
      and btrim(coalesce(p_statement,''))=
        'مبدؤنا مراجعة التغيير قبل اعتماده'
      and v_source_assertion in (
        'مبدؤنا مراجعة التغيير قبل اعتماده',
        'مبدئي مراجعة التغيير قبل اعتماده',
        'our principle is to review changes before approval',
        'my principle is to review changes before approval'
      )
    when 'constraint_verified_numbers_only' then
      lower(btrim(coalesce(p_category,'')))='constraint'
      and btrim(coalesce(p_statement,''))=
        'قيدنا عدم اعتماد أرقام غير موثقة'
      and v_source_assertion in (
        'قيدنا عدم اعتماد أرقام غير موثقة',
        'قيدي عدم اعتماد أرقام غير موثقة',
        'our constraint is to reject unverified numbers',
        'my constraint is to reject unverified numbers'
      )
    when 'constraint_read_only_recommendations' then
      lower(btrim(coalesce(p_category,'')))='constraint'
      and btrim(coalesce(p_statement,''))=
        'قيدنا إبقاء توصيات أوديري للقراءة فقط'
      and v_source_assertion in (
        'قيدنا إبقاء توصيات أوديري للقراءة فقط',
        'قيدي إبقاء توصيات أوديري للقراءة فقط',
        'our constraint is to keep odeiry recommendations read-only',
        'my constraint is to keep odeiry recommendations read-only'
      )
    when 'priority_sales' then
      lower(btrim(coalesce(p_category,'')))='decision_context'
      and btrim(coalesce(p_statement,''))=
        'أولويتنا الحالية تحسين المبيعات'
      and v_source_assertion in (
        'أولويتنا الحالية تحسين المبيعات',
        'أولويتي الحالية تحسين المبيعات',
        'our current priority is improving sales',
        'my current priority is improving sales'
      )
    when 'priority_operations' then
      lower(btrim(coalesce(p_category,'')))='decision_context'
      and btrim(coalesce(p_statement,''))=
        'أولويتنا الحالية تحسين التشغيل'
      and v_source_assertion in (
        'أولويتنا الحالية تحسين التشغيل',
        'أولويتي الحالية تحسين التشغيل',
        'our current priority is improving operations',
        'my current priority is improving operations'
      )
    when 'priority_cash_collection' then
      lower(btrim(coalesce(p_category,'')))='decision_context'
      and btrim(coalesce(p_statement,''))=
        'أولويتنا الحالية تحسين التحصيل'
      and v_source_assertion in (
        'أولويتنا الحالية تحسين التحصيل',
        'أولويتي الحالية تحسين التحصيل',
        'our current priority is improving cash collection',
        'my current priority is improving cash collection'
      )
    else false
  end;
end;
$$;

create or replace function private_app.odeiry_manager_safe_number(
  p_value jsonb
)
returns jsonb
language sql
immutable
set search_path=''
as $$
  select case
    when pg_catalog.jsonb_typeof(p_value)='number' then p_value
    else 'null'::jsonb
  end
$$;

create or replace function
  private_app.odeiry_manager_memory_requests_append_only_guard()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  raise exception 'odeiry_manager_memory_requests_append_only';
end;
$$;

revoke all on function private_app.odeiry_manager_can_use(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_manager_runtime_enabled()
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_manager_is_available(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_manager_memory_text_safe(text)
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_memory_evidence_normalized(text)
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_memory_catalog_safe(text,text,text,text,text)
from public,anon,authenticated,service_role;
revoke all on function private_app.odeiry_manager_safe_number(jsonb)
from public,anon,authenticated,service_role;
revoke all on function
  private_app.odeiry_manager_memory_requests_append_only_guard()
from public,anon,authenticated,service_role;

create trigger odeiry_manager_settings_set_updated_at
before update on core.odeiry_manager_settings
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_manager_memories_set_updated_at
before update on core.odeiry_manager_memories
for each row execute function private_app.odeiry_set_updated_at_clock();

create trigger odeiry_manager_memory_requests_append_only
before update or delete on core.odeiry_manager_memory_requests
for each row execute function
  private_app.odeiry_manager_memory_requests_append_only_guard();

create policy odeiry_manager_settings_isolated_read
on core.odeiry_manager_settings
for select to authenticated
using (private_app.odeiry_manager_can_use(tenant_id));

create policy odeiry_manager_threads_owner_read
on core.odeiry_manager_threads
for select to authenticated
using (
  private_app.odeiry_manager_can_use(tenant_id)
  and owner_subject_id=private_app.current_subject_id()
);

create policy odeiry_manager_memories_owner_read
on core.odeiry_manager_memories
for select to authenticated
using (
  private_app.odeiry_manager_can_use(tenant_id)
  and owner_subject_id=private_app.current_subject_id()
);

create or replace function
  public.v1_platform_odeiry_manager_runtime_configure(
    p_payload jsonb default '{}'::jsonb
  )
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_actor_id uuid:=private_app.current_subject_id();
  v_enabled boolean;
  v_expected_version integer;
  v_now timestamptz:=clock_timestamp();
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload)<>'object'
     or octet_length(p_payload::text)>2048
     or exists(
       select 1 from jsonb_object_keys(p_payload) payload_key
       where payload_key not in ('enabled','expectedVersion')
     )
     or not p_payload ? 'enabled'
     or jsonb_typeof(p_payload->'enabled')<>'boolean'
     or not p_payload ? 'expectedVersion'
     or jsonb_typeof(p_payload->'expectedVersion')<>'number' then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  begin
    v_enabled:=(p_payload->>'enabled')::boolean;
    v_expected_version:=(p_payload->>'expectedVersion')::integer;
  exception when others then
    raise exception 'odeiry_manager_payload_invalid';
  end;
  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime
  where runtime.singleton
  for update;
  if v_runtime.singleton is null then
    raise exception 'odeiry_runtime_missing';
  end if;
  if v_expected_version is null
     or v_expected_version<>v_runtime.version then
    raise exception 'odeiry_manager_version_conflict';
  end if;
  update platform.odeiry_runtime_settings runtime
  set manager_enabled=v_enabled,
      version=runtime.version+1,
      updated_by_subject_id=v_actor_id,
      updated_at=v_now
  where runtime.singleton
  returning * into v_runtime;
  perform private_app.write_audit(
    'odeiry.manager.runtime.configured','odeiry_runtime','default',null,
    jsonb_build_object(
      'managerEnabled',v_runtime.manager_enabled,
      'version',v_runtime.version
    )
  );
  return jsonb_build_object(
    'globalEnabled',v_runtime.manager_enabled,
    'version',v_runtime.version
  );
end;
$$;

create or replace function public.v1_platform_odeiry_manager_configure(
  p_slug text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_setting core.odeiry_manager_settings%rowtype;
  v_actor_id uuid:=private_app.current_subject_id();
  v_enabled boolean;
  v_expected_version integer;
  v_max_approved smallint;
  v_max_pending smallint;
  v_now timestamptz:=clock_timestamp();
begin
  if not private_app.has_platform_permission('platform.settings.manage') then
    raise exception 'forbidden';
  end if;
  if p_payload is null
     or jsonb_typeof(p_payload)<>'object'
     or octet_length(p_payload::text)>4096
     or exists(
       select 1 from jsonb_object_keys(p_payload) payload_key
       where payload_key not in (
         'enabled','expectedVersion','maxApprovedMemoriesPerOwner',
         'maxPendingMemoriesPerOwner'
       )
     )
     or not p_payload ? 'enabled'
     or jsonb_typeof(p_payload->'enabled')<>'boolean' then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  begin
    v_enabled:=(p_payload->>'enabled')::boolean;
    v_expected_version:=(p_payload->>'expectedVersion')::integer;
  exception when others then
    raise exception 'odeiry_manager_payload_invalid';
  end;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:odeiry-manager:config:'||v_tenant.id::text,0
    )
  );
  select setting.* into v_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id
  for update;
  begin
    v_max_approved:=coalesce(
      case when p_payload ? 'maxApprovedMemoriesPerOwner'
        then (p_payload->>'maxApprovedMemoriesPerOwner')::smallint
        else v_setting.max_approved_memories_per_owner end,
      50
    );
    v_max_pending:=coalesce(
      case when p_payload ? 'maxPendingMemoriesPerOwner'
        then (p_payload->>'maxPendingMemoriesPerOwner')::smallint
        else v_setting.max_pending_memories_per_owner end,
      20
    );
  exception when others then
    raise exception 'odeiry_manager_payload_invalid';
  end;
  if v_max_approved not between 5 and 100
     or v_max_pending not between 2 and 50 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  if v_setting.tenant_id is null then
    if v_expected_version is distinct from 0 then
      raise exception 'odeiry_manager_version_conflict';
    end if;
    insert into core.odeiry_manager_settings(
      tenant_id,enabled,max_approved_memories_per_owner,
      max_pending_memories_per_owner,version,enabled_at,
      enabled_by_subject_id,updated_by_subject_id,created_at,updated_at
    ) values (
      v_tenant.id,v_enabled,v_max_approved,v_max_pending,1,
      case when v_enabled then v_now else null end,
      case when v_enabled then v_actor_id else null end,
      v_actor_id,v_now,v_now
    ) returning * into v_setting;
  else
    if v_expected_version is null
       or v_expected_version<>v_setting.version then
      raise exception 'odeiry_manager_version_conflict';
    end if;
    update core.odeiry_manager_settings setting
    set enabled=v_enabled,
        max_approved_memories_per_owner=v_max_approved,
        max_pending_memories_per_owner=v_max_pending,
        version=setting.version+1,
        enabled_at=case when v_enabled
          then coalesce(setting.enabled_at,v_now) else null end,
        enabled_by_subject_id=case when v_enabled
          then coalesce(setting.enabled_by_subject_id,v_actor_id) else null end,
        updated_by_subject_id=v_actor_id,
        updated_at=v_now
    where setting.tenant_id=v_tenant.id
    returning * into v_setting;
  end if;
  perform private_app.write_audit(
    'odeiry.manager.configured','tenant',v_tenant.id::text,v_tenant.id,
    jsonb_build_object(
      'enabled',v_setting.enabled,
      'maxApprovedMemoriesPerOwner',
        v_setting.max_approved_memories_per_owner,
      'maxPendingMemoriesPerOwner',
        v_setting.max_pending_memories_per_owner,
      'version',v_setting.version
    )
  );
  return jsonb_build_object(
    'tenantSlug',v_tenant.slug,
    'enabled',v_setting.enabled,
    'maxApprovedMemoriesPerOwner',
      v_setting.max_approved_memories_per_owner,
    'maxPendingMemoriesPerOwner',
      v_setting.max_pending_memories_per_owner,
    'version',v_setting.version
  );
end;
$$;

-- Preserve the reviewed operations implementation behind a private callable
-- boundary, then restore the public signature with capability separation.
alter function public.v3_tenant_odeiry_action(text,text,jsonb)
rename to v3_tenant_odeiry_action_operations_v2_internal;

revoke all on function
  public.v3_tenant_odeiry_action_operations_v2_internal(text,text,jsonb)
from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_odeiry_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_existing_run core.odeiry_runs%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_mode text;
  v_forward_payload jsonb;
  v_result jsonb;
  v_thread_id uuid;
  v_run_id uuid;
  v_client_request_id text;
  v_thread_exists boolean:=false;
  v_thread_is_manager boolean:=false;
  v_run_is_manager boolean:=false;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object'
     or octet_length(p_payload::text)>65536 then
    raise exception 'odeiry_payload_invalid';
  end if;
  v_mode:=lower(btrim(coalesce(
    p_payload->>'assistantMode','operations_v2'
  )));
  if v_mode not in ('operations_v2','manager_v1') then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  v_forward_payload:=p_payload-'assistantMode';
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  if v_mode='manager_v1' then
    if v_subject_id is null
       or not private_app.odeiry_manager_can_use(v_tenant.id) then
      raise exception 'odeiry_manager_permission_required';
    end if;
    if not private_app.odeiry_manager_is_available(v_tenant.id) then
      raise exception 'odeiry_manager_unavailable';
    end if;
  end if;

  if v_action='start_run' then
    if v_subject_id is null then
      raise exception 'forbidden';
    end if;
    v_client_request_id:=private_app.odeiry_validate_client_request_id(
      v_forward_payload->>'clientRequestId'
    );
    -- Acquire the same lock as the preserved implementation before checking
    -- the mode marker. This closes a concurrent same-id manager/operations
    -- race while remaining re-entrant when the internal function locks it.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:odeiry:start:'||v_tenant.id::text||':'
          ||v_subject_id::text||':'||v_client_request_id,
        0
      )
    );
    begin
      v_thread_id:=nullif(btrim(coalesce(
        v_forward_payload->>'threadId',''
      )),'')::uuid;
    exception when others then
      raise exception 'odeiry_thread_invalid';
    end;
    select run.* into v_existing_run
    from core.odeiry_runs run
    where run.tenant_id=v_tenant.id
      and run.requested_by_subject_id=v_subject_id
      and run.client_request_id=v_client_request_id
    limit 1;
    if v_existing_run.id is not null then
      select exists(
        select 1
        from core.odeiry_manager_threads marker
        where marker.tenant_id=v_tenant.id
          and marker.thread_id=v_existing_run.thread_id
          and marker.owner_subject_id=v_subject_id
      ) into v_run_is_manager;
      if (v_mode='manager_v1') is distinct from v_run_is_manager then
        raise exception 'odeiry_manager_cross_mode_forbidden';
      end if;
    end if;
    if v_thread_id is not null then
      select exists(
        select 1 from core.odeiry_threads thread
        where thread.tenant_id=v_tenant.id
          and thread.id=v_thread_id
          and thread.created_by_subject_id=v_subject_id
      ) into v_thread_exists;
      if v_thread_exists then
        select exists(
          select 1 from core.odeiry_manager_threads marker
          where marker.tenant_id=v_tenant.id
            and marker.thread_id=v_thread_id
            and marker.owner_subject_id=v_subject_id
        ) into v_thread_is_manager;
        if (v_mode='manager_v1') is distinct from v_thread_is_manager then
          raise exception 'odeiry_manager_cross_mode_forbidden';
        end if;
      end if;
    end if;
    v_result:=public.v3_tenant_odeiry_action_operations_v2_internal(
      p_slug,p_action,v_forward_payload
    );
    begin
      v_thread_id:=(v_result->>'threadId')::uuid;
      v_run_id:=(v_result->>'runId')::uuid;
    exception when others then
      raise exception 'odeiry_manager_internal_contract_invalid';
    end;
    if v_mode='manager_v1' then
      insert into core.odeiry_manager_threads(
        tenant_id,thread_id,owner_subject_id,created_at
      ) values (
        v_tenant.id,v_thread_id,v_subject_id,clock_timestamp()
      ) on conflict (tenant_id,thread_id) do nothing;
    end if;
    update core.odeiry_runs run
    set request_context=run.request_context||jsonb_build_object(
          'assistantMode',v_mode
        ),
        manager_analytics_count=case
          when v_mode='manager_v1'
            and coalesce(v_result->>'recovered','false')='true'
            then 0
          else run.manager_analytics_count
        end
    where run.tenant_id=v_tenant.id
      and run.id=v_run_id
      and run.requested_by_subject_id=v_subject_id;
    return v_result||jsonb_build_object('assistantMode',v_mode);
  end if;

  if v_action='archive_thread' then
    begin
      v_thread_id:=(v_forward_payload->>'threadId')::uuid;
    exception when others then
      raise exception 'odeiry_thread_invalid';
    end;
    select exists(
      select 1 from core.odeiry_threads thread
      where thread.tenant_id=v_tenant.id
        and thread.id=v_thread_id
        and thread.created_by_subject_id=v_subject_id
    ) into v_thread_exists;
    if v_thread_exists then
      select exists(
        select 1 from core.odeiry_manager_threads marker
        where marker.tenant_id=v_tenant.id
          and marker.thread_id=v_thread_id
          and marker.owner_subject_id=v_subject_id
      ) into v_thread_is_manager;
      if (v_mode='manager_v1') is distinct from v_thread_is_manager then
        raise exception 'odeiry_manager_cross_mode_forbidden';
      end if;
    end if;
    return public.v3_tenant_odeiry_action_operations_v2_internal(
      p_slug,p_action,v_forward_payload
    )||jsonb_build_object('assistantMode',v_mode);
  end if;

  if v_action='link_ticket' then
    if v_mode='manager_v1' then
      raise exception 'odeiry_manager_execution_forbidden';
    end if;
    begin
      v_run_id:=(v_forward_payload->>'runId')::uuid;
    exception when others then
      raise exception 'odeiry_ticket_link_invalid';
    end;
    if exists(
      select 1
      from core.odeiry_runs run
      join core.odeiry_manager_threads marker
        on marker.tenant_id=run.tenant_id
       and marker.thread_id=run.thread_id
       and marker.owner_subject_id=run.requested_by_subject_id
      where run.tenant_id=v_tenant.id
        and run.id=v_run_id
        and run.requested_by_subject_id=v_subject_id
    ) then
      raise exception 'odeiry_manager_execution_forbidden';
    end if;
  end if;

  return public.v3_tenant_odeiry_action_operations_v2_internal(
    p_slug,p_action,v_forward_payload
  );
end;
$$;

-- Keep one operations-only compatibility signature during the rolling
-- deployment/rollback window. The privileged implementation is renamed and
-- private; a later migration may remove this wrapper only after old app
-- revisions have drained completely.
alter function public.v3_tenant_odeiry_finalize(text,uuid,text,jsonb)
rename to v3_tenant_odeiry_finalize_operations_v3_internal;

revoke all on function
  public.v3_tenant_odeiry_finalize_operations_v3_internal(
    text,uuid,text,jsonb
  )
from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_odeiry_finalize(
  p_slug text,
  p_run_id uuid,
  p_status text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_mode text;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_run_id is null then
    raise exception 'odeiry_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  select run.* into v_run
  from core.odeiry_runs run
  where run.tenant_id=v_tenant.id
    and run.id=p_run_id;
  if v_run.id is null then
    raise exception 'odeiry_run_not_found';
  end if;
  v_mode:=coalesce(
    v_run.request_context->>'assistantMode','operations_v2'
  );
  if v_mode<>'operations_v2'
     or exists(
       select 1
       from core.odeiry_manager_threads marker
       where marker.tenant_id=v_run.tenant_id
         and marker.thread_id=v_run.thread_id
         and marker.owner_subject_id=v_run.requested_by_subject_id
     ) then
    raise exception 'odeiry_manager_finalize_requires_v4';
  end if;
  return public.v3_tenant_odeiry_finalize_operations_v3_internal(
    p_slug,p_run_id,p_status,p_payload
  );
end;
$$;

create or replace function public.v1_tenant_odeiry_manager_memory_context(
  p_slug text,
  p_run_id uuid,
  p_query text,
  p_limit integer default 8
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_limit integer:=least(greatest(coalesce(p_limit,8),1),8);
  v_memories jsonb;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_run_id is null
     or char_length(coalesce(p_query,''))>4000
     or octet_length(coalesce(p_query,''))>12000 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_manager_is_available(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  select run.* into v_run
  from core.odeiry_runs run
  join core.odeiry_manager_threads marker
    on marker.tenant_id=run.tenant_id
   and marker.thread_id=run.thread_id
   and marker.owner_subject_id=run.requested_by_subject_id
  where run.tenant_id=v_tenant.id
    and run.id=p_run_id
    and run.requested_by_subject_id=v_subject_id
    and run.status in ('reserved','running')
    and run.request_context->>'assistantMode'='manager_v1';
  if v_run.id is null then
    raise exception 'odeiry_manager_run_not_found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'memoryKey',memory.memory_key,
    'category',memory.category,
    'statement',memory.statement,
    'approvedAt',memory.reviewed_at,
    'validUntil',memory.expires_at
  ) order by memory.updated_at desc,memory.id desc),'[]'::jsonb)
  into v_memories
  from (
    select item.*
    from core.odeiry_manager_memories item
    where item.tenant_id=v_tenant.id
      and item.owner_subject_id=v_subject_id
      and item.status='approved'
      and (item.expires_at is null or item.expires_at>now())
    order by item.updated_at desc,item.id desc
    limit v_limit
  ) memory;
  return jsonb_build_object(
    'schemaVersion',1,
    'memories',v_memories
  );
end;
$$;

create or replace function public.v1_tenant_odeiry_manager_analytics(
  p_slug text,
  p_run_id uuid,
  p_period text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_period text:=lower(btrim(coalesce(p_period,'')));
  v_from date;
  v_to date;
  v_report jsonb;
  v_summary jsonb;
  v_daily jsonb;
  v_result jsonb;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_run_id is null
     or v_period not in ('last_7_days','last_30_days') then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  v_to:=(clock_timestamp() at time zone coalesce(
    nullif(v_tenant.timezone,''),'UTC'
  ))::date;
  if v_subject_id is null
     or not private_app.odeiry_manager_is_available(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  update core.odeiry_runs run
  set manager_analytics_count=run.manager_analytics_count+1
  where run.tenant_id=v_tenant.id
    and run.id=p_run_id
    and run.requested_by_subject_id=v_subject_id
    and run.status in ('reserved','running')
    and run.request_context->>'assistantMode'='manager_v1'
    and run.manager_analytics_count<2
    and exists(
      select 1 from core.odeiry_manager_threads marker
      where marker.tenant_id=run.tenant_id
        and marker.thread_id=run.thread_id
        and marker.owner_subject_id=run.requested_by_subject_id
    );
  if not found then
    if exists(
      select 1 from core.odeiry_runs run
      where run.tenant_id=v_tenant.id
        and run.id=p_run_id
        and run.requested_by_subject_id=v_subject_id
        and run.manager_analytics_count>=2
    ) then
      raise exception 'odeiry_manager_analytics_limit';
    end if;
    raise exception 'odeiry_manager_run_not_found';
  end if;
  v_from:=case when v_period='last_7_days'
    then v_to-6 else v_to-29 end;
  v_report:=public.v5_tenant_reports_snapshot(
    p_slug,v_from,v_to,null,'overview',50,0
  );
  v_summary:=coalesce(v_report->'summary','{}'::jsonb);
  select coalesce(jsonb_agg(jsonb_build_object(
    'date',daily_item->'date',
    'leadsAssigned',private_app.odeiry_manager_safe_number(
      daily_item->'leadsAssigned'
    ),
    'leadsCreated',private_app.odeiry_manager_safe_number(
      daily_item->'leadsCreated'
    ),
    'activities',private_app.odeiry_manager_safe_number(
      daily_item->'activities'
    ),
    'paid',private_app.odeiry_manager_safe_number(daily_item->'paid'),
    'tasksCompleted',private_app.odeiry_manager_safe_number(
      daily_item->'tasksCompleted'
    ),
    'calls',private_app.odeiry_manager_safe_number(daily_item->'calls')
  ) order by daily_item->>'date'),'[]'::jsonb)
  into v_daily
  from (
    select item as daily_item
    from jsonb_array_elements(
      case when jsonb_typeof(v_report->'daily')='array'
        then v_report->'daily' else '[]'::jsonb end
    ) item
    where jsonb_typeof(item)='object'
      and jsonb_typeof(item->'date')='string'
      and item->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and item->>'date' between v_from::text and v_to::text
    limit 31
  ) bounded_daily;
  v_result:=jsonb_build_object(
    'schemaVersion',1,
    'sourceId','tenant_reports_v5_aggregate',
    'title','ملخص المؤشرات الإدارية المجمعة',
    'period',jsonb_build_object(
      'key',v_period,'from',v_from,'to',v_to
    ),
    'asOf',clock_timestamp(),
    'scope','authorized_tenant_scope',
    'metrics',jsonb_build_object(
      'leadsCreated',private_app.odeiry_manager_safe_number(
        v_summary->'leadsCreated'
      ),
      'leadsAssigned',private_app.odeiry_manager_safe_number(
        v_summary->'leadsAssigned'
      ),
      'activities',private_app.odeiry_manager_safe_number(
        v_summary->'activities'
      ),
      'tasksTotal',private_app.odeiry_manager_safe_number(
        v_summary->'tasksTotal'
      ),
      'tasksCompleted',private_app.odeiry_manager_safe_number(
        v_summary->'tasksCompleted'
      ),
      'overdueTasks',private_app.odeiry_manager_safe_number(
        v_summary->'overdueTasks'
      ),
      'calls',private_app.odeiry_manager_safe_number(v_summary->'calls'),
      'answeredCalls',private_app.odeiry_manager_safe_number(
        v_summary->'answeredCalls'
      ),
      'talkSeconds',private_app.odeiry_manager_safe_number(
        v_summary->'talkSeconds'
      ),
      'paidContacts',private_app.odeiry_manager_safe_number(
        v_summary->'paidContacts'
      ),
      'realizedRevenueMinor',private_app.odeiry_manager_safe_number(
        v_summary->'realizedRevenueMinor'
      ),
      'wonRevenueMinor',private_app.odeiry_manager_safe_number(
        v_summary->'wonRevenueMinor'
      ),
      'pipelineValueMinor',private_app.odeiry_manager_safe_number(
        v_summary->'pipelineValueMinor'
      ),
      'campaignCount',private_app.odeiry_manager_safe_number(
        v_summary->'campaignCount'
      ),
      'conversionRate',private_app.odeiry_manager_safe_number(
        v_summary->'conversionRate'
      ),
      'averageSaleMinor',private_app.odeiry_manager_safe_number(
        v_summary->'averageSaleMinor'
      ),
      'taskCompletionRate',private_app.odeiry_manager_safe_number(
        v_summary->'taskCompletionRate'
      ),
      'callAnswerRate',private_app.odeiry_manager_safe_number(
        v_summary->'callAnswerRate'
      ),
      'dataCompletenessRate',private_app.odeiry_manager_safe_number(
        v_summary->'dataCompletenessRate'
      ),
      'firstResponseSlaRate',private_app.odeiry_manager_safe_number(
        v_summary->'firstResponseSlaRate'
      ),
      'assignmentOperations',private_app.odeiry_manager_safe_number(
        v_summary->'assignmentOperations'
      ),
      'validAssignedLeads',private_app.odeiry_manager_safe_number(
        v_summary->'validAssignedLeads'
      ),
      'contactedAssignedLeads',private_app.odeiry_manager_safe_number(
        v_summary->'contactedAssignedLeads'
      ),
      'averageFirstResponseMinutes',
        private_app.odeiry_manager_safe_number(
          v_summary->'averageFirstResponseMinutes'
        )
    ),
    'daily',v_daily
  );
  if octet_length(v_result::text)>32768 then
    raise exception 'odeiry_manager_analytics_payload_too_large';
  end if;
  return v_result;
end;
$$;

create or replace function public.v1_service_odeiry_manager_memory_propose(
  p_slug text,
  p_run_id uuid,
  p_proposals jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_setting core.odeiry_manager_settings%rowtype;
  v_user_message text;
  v_proposal jsonb;
  v_memory_key text;
  v_category text;
  v_statement text;
  v_evidence_basis text;
  v_evidence_quote text;
  v_valid_days integer;
  v_content_hash text;
  v_evidence_hash text;
  v_pending_count integer;
  v_accepted integer:=0;
  v_ignored integer:=0;
  v_inserted integer:=0;
  v_memory_ids jsonb:='[]'::jsonb;
  v_memory_id uuid;
  v_now timestamptz:=clock_timestamp();
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_run_id is null
     or p_proposals is null
     or jsonb_typeof(p_proposals)<>'array'
     or jsonb_array_length(p_proposals)>2
     or octet_length(p_proposals::text)>8192 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  select run.* into v_run
  from core.odeiry_runs run
  join core.odeiry_manager_threads marker
    on marker.tenant_id=run.tenant_id
   and marker.thread_id=run.thread_id
   and marker.owner_subject_id=run.requested_by_subject_id
  where run.tenant_id=v_tenant.id
    and run.id=p_run_id
    and run.status='completed'
    and run.request_context->>'assistantMode'='manager_v1';
  if v_run.id is null then
    raise exception 'odeiry_manager_run_not_found';
  end if;
  select setting.* into v_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id
    and setting.enabled;
  if v_setting.tenant_id is null then
    raise exception 'odeiry_manager_unavailable';
  end if;
  if not private_app.odeiry_manager_runtime_enabled()
     or not private_app.odeiry_is_available(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  select message.content into v_user_message
  from core.odeiry_messages message
  where message.tenant_id=v_tenant.id
    and message.run_id=v_run.id
    and message.message_role='user'
  limit 1;
  if v_user_message is null then
    raise exception 'odeiry_manager_source_message_missing';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:odeiry-manager:memory-owner:'||v_tenant.id::text||':'
        ||v_run.requested_by_subject_id::text,0
    )
  );
  select count(*) into v_pending_count
  from core.odeiry_manager_memories memory
  where memory.tenant_id=v_tenant.id
    and memory.owner_subject_id=v_run.requested_by_subject_id
    and memory.status='proposed';

  for v_proposal in select value from jsonb_array_elements(p_proposals)
  loop
    if jsonb_typeof(v_proposal)<>'object'
       or exists(
         select 1 from jsonb_object_keys(v_proposal) proposal_key
         where proposal_key not in (
           'memoryKey','category','statement','evidenceBasis',
           'evidenceQuote','validForDays'
         )
       ) then
      v_ignored:=v_ignored+1;
      continue;
    end if;
    v_memory_key:=lower(btrim(coalesce(v_proposal->>'memoryKey','')));
    v_category:=lower(btrim(coalesce(v_proposal->>'category','')));
    v_statement:=btrim(coalesce(v_proposal->>'statement',''));
    v_evidence_basis:=lower(btrim(coalesce(
      v_proposal->>'evidenceBasis',''
    )));
    v_evidence_quote:=btrim(coalesce(
      v_proposal->>'evidenceQuote',''
    ));
    begin
      v_valid_days:=case when v_proposal->'validForDays' is null
          or v_proposal->'validForDays'='null'::jsonb
        then null else (v_proposal->>'validForDays')::integer end;
    exception when others then
      v_valid_days:=null;
      v_ignored:=v_ignored+1;
      continue;
    end;
    if v_pending_count>=v_setting.max_pending_memories_per_owner
       or v_memory_key !~ '^[a-z][a-z0-9_.-]{2,79}$'
       or v_category not in (
         'goal','preference','constraint','operating_principle',
         'decision_context'
       )
       or v_evidence_basis<>'current_user_explicit'
       or char_length(v_evidence_quote) not between 3 and 160
       or octet_length(v_evidence_quote)>640
       or pg_catalog.strpos(
         lower(v_user_message),lower(v_evidence_quote)
       )=0
       or not private_app.odeiry_manager_memory_text_safe(v_statement)
       or not private_app.odeiry_manager_memory_text_safe(v_evidence_quote)
       or not private_app.odeiry_manager_memory_catalog_safe(
         v_memory_key,v_category,v_statement,v_evidence_quote,v_user_message
       )
       or (
         v_valid_days is not null
         and v_valid_days not in (30,90,180,365)
       ) then
      v_ignored:=v_ignored+1;
      continue;
    end if;
    v_content_hash:=private_app.odeiry_sha256(jsonb_build_object(
      'memoryKey',v_memory_key,
      'category',v_category,
      'statement',v_statement
    ));
    v_evidence_hash:=private_app.odeiry_sha256(
      to_jsonb(v_evidence_quote)
    );
    v_memory_id:=extensions.gen_random_uuid();
    insert into core.odeiry_manager_memories(
      id,tenant_id,owner_subject_id,memory_key,category,statement,
      evidence_basis,evidence_hash,content_hash,status,source_thread_id,
      source_run_id,version,valid_for_days,expires_at,created_at,updated_at
    ) values (
      v_memory_id,v_tenant.id,v_run.requested_by_subject_id,
      v_memory_key,v_category,v_statement,'current_user_explicit',
      v_evidence_hash,v_content_hash,'proposed',v_run.thread_id,v_run.id,1,
      v_valid_days,null,v_now,v_now
    ) on conflict do nothing;
    get diagnostics v_inserted=row_count;
    if v_inserted=1 then
      v_accepted:=v_accepted+1;
      v_pending_count:=v_pending_count+1;
      v_memory_ids:=v_memory_ids||jsonb_build_array(v_memory_id);
    else
      v_ignored:=v_ignored+1;
    end if;
  end loop;
  return jsonb_build_object(
    'schemaVersion',1,
    'runId',v_run.id,
    'acceptedCount',v_accepted,
    'ignoredCount',v_ignored,
    'memoryIds',v_memory_ids
  );
end;
$$;

-- The only service-role finalization entry point. It dispatches operations
-- unchanged, but closes manager completion and its reviewed-memory proposal
-- batch in one transaction with a durable idempotency receipt on the run.
create or replace function public.v4_service_odeiry_finalize(
  p_slug text,
  p_run_id uuid,
  p_status text,
  p_payload jsonb,
  p_manager_memory_proposals jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_run core.odeiry_runs%rowtype;
  v_status text:=lower(btrim(coalesce(p_status,'')));
  v_is_manager boolean:=false;
  v_context_mode text;
  v_batch_hash text;
  v_was_completed boolean:=false;
  v_finalized jsonb;
  v_persisted_count smallint:=0;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_run_id is null
     or v_status not in ('completed','failed','cancelled') then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  select run.* into v_run
  from core.odeiry_runs run
  where run.tenant_id=v_tenant.id
    and run.id=p_run_id
  for update;
  if v_run.id is null then
    raise exception 'odeiry_run_not_found';
  end if;
  select exists(
    select 1
    from core.odeiry_manager_threads marker
    where marker.tenant_id=v_run.tenant_id
      and marker.thread_id=v_run.thread_id
      and marker.owner_subject_id=v_run.requested_by_subject_id
  ) into v_is_manager;
  v_context_mode:=coalesce(
    v_run.request_context->>'assistantMode','operations_v2'
  );
  if (v_context_mode='manager_v1') is distinct from v_is_manager
     or v_context_mode not in ('operations_v2','manager_v1') then
    raise exception 'odeiry_manager_mode_invariant_failed';
  end if;

  if not v_is_manager then
    if p_manager_memory_proposals is not null then
      raise exception 'odeiry_manager_cross_mode_forbidden';
    end if;
    return public.v3_tenant_odeiry_finalize_operations_v3_internal(
      p_slug,p_run_id,v_status,p_payload
    );
  end if;

  if v_status<>'completed' then
    if p_manager_memory_proposals is not null then
      raise exception 'odeiry_manager_payload_invalid';
    end if;
    return public.v3_tenant_odeiry_finalize_operations_v3_internal(
      p_slug,p_run_id,v_status,p_payload
    );
  end if;

  if p_manager_memory_proposals is null
     or jsonb_typeof(p_manager_memory_proposals)<>'array'
     or jsonb_array_length(p_manager_memory_proposals)>2
     or octet_length(p_manager_memory_proposals::text)>8192 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  if not private_app.odeiry_manager_runtime_enabled() then
    raise exception 'odeiry_manager_unavailable';
  end if;
  v_batch_hash:=private_app.odeiry_sha256(
    p_manager_memory_proposals
  );
  v_was_completed:=v_run.status='completed';
  if v_was_completed then
    if v_run.manager_memory_batch_hash is null
       or v_run.manager_memory_batch_hash is distinct from v_batch_hash then
      raise exception 'odeiry_manager_idempotency_conflict';
    end if;
  elsif v_run.manager_memory_batch_hash is not null
        or v_run.manager_memory_persisted_count<>0 then
    raise exception 'odeiry_manager_mode_invariant_failed';
  end if;

  -- v3 validates the full finalization hash on retries. No exception is
  -- caught: proposal or receipt failure rolls the finalization back too.
  v_finalized:=public.v3_tenant_odeiry_finalize_operations_v3_internal(
    p_slug,p_run_id,v_status,p_payload
  );
  if not v_was_completed then
    perform public.v1_service_odeiry_manager_memory_propose(
      p_slug,p_run_id,p_manager_memory_proposals
    );
    select count(*)::smallint into v_persisted_count
    from core.odeiry_manager_memories memory
    where memory.tenant_id=v_tenant.id
      and memory.source_run_id=v_run.id;
    update core.odeiry_runs run
    set manager_memory_batch_hash=v_batch_hash,
        manager_memory_persisted_count=v_persisted_count
    where run.tenant_id=v_tenant.id
      and run.id=v_run.id;
  else
    v_persisted_count:=v_run.manager_memory_persisted_count;
  end if;
  return v_finalized||jsonb_build_object(
    'memoryProposalCount',v_persisted_count
  );
end;
$$;

create or replace function public.v1_tenant_odeiry_manager_workspace(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_threads jsonb;
  v_pending jsonb;
  v_approved jsonb;
  v_archived jsonb;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240 then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_manager_can_use(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  if private_app.odeiry_manager_is_available(v_tenant.id) then
    select coalesce(jsonb_agg(jsonb_build_object(
      'threadId',thread.id,'title',thread.title,'status',thread.status,
      'version',thread.version,'lastMessageAt',thread.last_message_at,
      'createdAt',thread.created_at
    ) order by thread.updated_at desc,thread.id desc),'[]'::jsonb)
    into v_threads
    from (
      select item.*
      from core.odeiry_threads item
      join core.odeiry_manager_threads marker
        on marker.tenant_id=item.tenant_id
       and marker.thread_id=item.id
       and marker.owner_subject_id=item.created_by_subject_id
      where item.tenant_id=v_tenant.id
        and item.created_by_subject_id=v_subject_id
      order by item.updated_at desc,item.id desc
      limit 20
    ) thread;
  else
    v_threads:='[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(memory.document
    order by memory.updated_at desc,memory.id desc),'[]'::jsonb)
  into v_pending
  from (
    select item.id,item.updated_at,jsonb_build_object(
      'memoryId',item.id,'memoryKey',item.memory_key,
      'category',item.category,'statement',item.statement,
      'reason','ذكرها المدير صراحة في رسالته الحالية',
      'status',item.status,'version',item.version,
      'createdAt',item.created_at,'reviewedAt',item.reviewed_at,
      'expiresAt',item.expires_at
    ) as document
    from core.odeiry_manager_memories item
    where item.tenant_id=v_tenant.id
      and item.owner_subject_id=v_subject_id
      and item.status='proposed'
    order by item.updated_at desc,item.id desc limit 50
  ) memory;
  select coalesce(jsonb_agg(memory.document
    order by memory.updated_at desc,memory.id desc),'[]'::jsonb)
  into v_approved
  from (
    select item.id,item.updated_at,jsonb_build_object(
      'memoryId',item.id,'memoryKey',item.memory_key,
      'category',item.category,'statement',item.statement,
      'reason','اعتمدها المدير للاستخدام في محادثاته الشخصية',
      'status',item.status,'version',item.version,
      'createdAt',item.created_at,'reviewedAt',item.reviewed_at,
      'expiresAt',item.expires_at
    ) as document
    from core.odeiry_manager_memories item
    where item.tenant_id=v_tenant.id
      and item.owner_subject_id=v_subject_id
      and item.status='approved'
      and (item.expires_at is null or item.expires_at>now())
    order by item.updated_at desc,item.id desc limit 100
  ) memory;
  select coalesce(jsonb_agg(memory.document
    order by memory.updated_at desc,memory.id desc),'[]'::jsonb)
  into v_archived
  from (
    select item.id,item.updated_at,jsonb_build_object(
      'memoryId',item.id,'memoryKey',item.memory_key,
      'category',item.category,'statement',item.statement,
      'reason','أرشفها المدير ولم تعد تدخل سياق أوديري',
      'status',item.status,'version',item.version,
      'createdAt',item.created_at,'reviewedAt',item.reviewed_at,
      'expiresAt',item.expires_at
    ) as document
    from core.odeiry_manager_memories item
    where item.tenant_id=v_tenant.id
      and item.owner_subject_id=v_subject_id
      and item.status='archived'
    order by item.updated_at desc,item.id desc limit 20
  ) memory;
  return jsonb_build_object(
    'schemaVersion',1,'generatedAt',statement_timestamp(),
    'threads',v_threads,
    'memory',jsonb_build_object(
      'pending',v_pending,'approved',v_approved,'archived',v_archived
    )
  );
end;
$$;

create or replace function public.v1_tenant_odeiry_manager_thread(
  p_slug text,
  p_thread_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_thread core.odeiry_threads%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_messages jsonb;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_thread_id is null then
    raise exception 'odeiry_manager_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_manager_is_available(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  select thread.* into v_thread
  from core.odeiry_threads thread
  join core.odeiry_manager_threads marker
    on marker.tenant_id=thread.tenant_id
   and marker.thread_id=thread.id
   and marker.owner_subject_id=thread.created_by_subject_id
  where thread.tenant_id=v_tenant.id
    and thread.id=p_thread_id
    and thread.created_by_subject_id=v_subject_id;
  if v_thread.id is null then
    raise exception 'odeiry_manager_thread_not_found';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'messageId',message.id,'role',message.message_role,
    'content',left(message.content,4000),'createdAt',message.created_at
  ) order by message.created_at,message.id),'[]'::jsonb)
  into v_messages
  from (
    select item.*
    from core.odeiry_messages item
    where item.tenant_id=v_tenant.id
      and item.thread_id=v_thread.id
      and item.message_role in ('user','assistant')
    order by item.created_at desc,item.id desc
    limit 40
  ) message;
  return jsonb_build_object(
    'schemaVersion',1,
    'thread',jsonb_build_object(
      'threadId',v_thread.id,'title',v_thread.title,
      'status',v_thread.status,'version',v_thread.version,
      'lastMessageAt',v_thread.last_message_at,
      'createdAt',v_thread.created_at
    ),
    'messages',v_messages
  );
end;
$$;

create or replace function public.v1_tenant_odeiry_manager_memory_action(
  p_slug text,
  p_action text,
  p_memory_id uuid,
  p_expected_version integer,
  p_client_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_setting core.odeiry_manager_settings%rowtype;
  v_memory core.odeiry_manager_memories%rowtype;
  v_request core.odeiry_manager_memory_requests%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_client_request_id text;
  v_request_hash text;
  v_result jsonb;
  v_now timestamptz:=clock_timestamp();
  v_expired_count integer:=0;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240
     or p_memory_id is null
     or p_expected_version is null or p_expected_version<1
     or v_action not in ('approve','reject','archive') then
    raise exception 'odeiry_manager_memory_action_invalid';
  end if;
  v_client_request_id:=private_app.odeiry_validate_client_request_id(
    p_client_request_id
  );
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_manager_can_use(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  if v_action='approve'
     and not private_app.odeiry_manager_is_available(v_tenant.id) then
    raise exception 'odeiry_manager_unavailable';
  end if;
  select setting.* into v_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id
    and setting.enabled;
  v_request_hash:=private_app.odeiry_sha256(jsonb_build_object(
    'action',v_action,'memoryId',p_memory_id,
    'expectedVersion',p_expected_version
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:odeiry-manager:memory-action:'||v_tenant.id::text||':'
        ||v_subject_id::text||':'||v_client_request_id,0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:odeiry-manager:memory-owner:'||v_tenant.id::text||':'
        ||v_subject_id::text,0
    )
  );
  select request.* into v_request
  from core.odeiry_manager_memory_requests request
  where request.tenant_id=v_tenant.id
    and request.owner_subject_id=v_subject_id
    and request.client_request_id=v_client_request_id;
  if v_request.id is not null then
    if v_request.request_hash is distinct from v_request_hash then
      raise exception 'odeiry_manager_idempotency_conflict';
    end if;
    return v_request.result_data||jsonb_build_object('idempotent',true);
  end if;
  update core.odeiry_manager_memories memory
  set status='archived',
      version=memory.version+1,
      archived_at=v_now,
      updated_at=v_now
  where memory.tenant_id=v_tenant.id
    and memory.owner_subject_id=v_subject_id
    and memory.id<>p_memory_id
    and memory.status='approved'
    and memory.expires_at is not null
    and memory.expires_at<=v_now;
  get diagnostics v_expired_count=row_count;
  if v_expired_count>0 then
    perform private_app.write_audit(
      'odeiry.manager.memory.expire','odeiry_manager_memory_owner',
      v_subject_id::text,v_tenant.id,jsonb_build_object(
        'expiredCount',v_expired_count
      )
    );
  end if;
  select memory.* into v_memory
  from core.odeiry_manager_memories memory
  where memory.tenant_id=v_tenant.id
    and memory.id=p_memory_id
    and memory.owner_subject_id=v_subject_id
  for update;
  if v_memory.id is null then
    raise exception 'odeiry_manager_memory_not_found';
  end if;
  if v_memory.version<>p_expected_version then
    raise exception 'odeiry_manager_version_conflict';
  end if;
  if v_action in ('approve','reject') and v_memory.status<>'proposed' then
    raise exception 'odeiry_manager_memory_action_invalid';
  end if;
  if v_action='archive' and v_memory.status<>'approved' then
    raise exception 'odeiry_manager_memory_action_invalid';
  end if;
  if v_action='approve' and (
    select count(*)
    from core.odeiry_manager_memories memory
    where memory.tenant_id=v_tenant.id
      and memory.owner_subject_id=v_subject_id
      and memory.status='approved'
  )>=v_setting.max_approved_memories_per_owner then
    raise exception 'odeiry_manager_memory_limit_reached';
  end if;
  begin
    update core.odeiry_manager_memories memory
    set status=case v_action
          when 'approve' then 'approved'
          when 'reject' then 'rejected'
          else 'archived' end,
        version=memory.version+1,
        reviewed_at=case when v_action in ('approve','reject')
          then v_now else memory.reviewed_at end,
        reviewed_by_subject_id=case when v_action in ('approve','reject')
          then v_subject_id else memory.reviewed_by_subject_id end,
        archived_at=case when v_action='archive' then v_now else null end,
        expires_at=case
          when v_action='approve' and memory.valid_for_days is not null
            then v_now+pg_catalog.make_interval(
              days=>memory.valid_for_days
            )
          when v_action='reject' then null
          else memory.expires_at end,
        updated_at=v_now
    where memory.tenant_id=v_tenant.id
      and memory.id=v_memory.id
    returning * into v_memory;
  exception when unique_violation then
    raise exception 'odeiry_manager_memory_key_conflict';
  end;
  v_result:=jsonb_build_object(
    'action',v_action,'memoryId',v_memory.id,
    'status',v_memory.status,'version',v_memory.version,
    'idempotent',false
  );
  insert into core.odeiry_manager_memory_requests(
    tenant_id,owner_subject_id,memory_id,action,client_request_id,
    request_hash,result_data,created_at
  ) values (
    v_tenant.id,v_subject_id,v_memory.id,v_action,
    v_client_request_id,v_request_hash,v_result,v_now
  );
  perform private_app.write_audit(
    'odeiry.manager.memory.'||v_action,'odeiry_manager_memory',
    v_memory.id::text,v_tenant.id,jsonb_build_object(
      'memoryId',v_memory.id,'contentHash',v_memory.content_hash,
      'status',v_memory.status,'version',v_memory.version
    )
  );
  return v_result;
end;
$$;

-- Extend the existing snapshot without changing or removing any prior field.
create or replace function public.v3_tenant_odeiry_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_runtime platform.odeiry_runtime_settings%rowtype;
  v_setting core.odeiry_tenant_settings%rowtype;
  v_manager_setting core.odeiry_manager_settings%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_available boolean:=false;
  v_access_mode text;
  v_manager_allowed boolean:=false;
  v_manager_available boolean:=false;
  v_manager_review_available boolean:=false;
begin
  if char_length(coalesce(p_slug,'')) not between 1 and 120
     or octet_length(coalesce(p_slug,''))>240 then
    raise exception 'odeiry_slug_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant where tenant.slug=p_slug limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null
     or not private_app.odeiry_is_active_tenant_member(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  v_access_mode:=case
    when private_app.support_is_active_tenant_member(v_tenant.id)
      then 'tenant_member'
    when private_app.odeiry_is_platform_operator(v_tenant.id)
      then 'platform_operator'
    else null end;
  if v_access_mode is null then raise exception 'forbidden'; end if;
  select runtime.* into v_runtime
  from platform.odeiry_runtime_settings runtime where runtime.singleton;
  select setting.* into v_setting
  from core.odeiry_tenant_settings setting
  where setting.tenant_id=v_tenant.id;
  select setting.* into v_manager_setting
  from core.odeiry_manager_settings setting
  where setting.tenant_id=v_tenant.id;
  v_available:=coalesce(v_runtime.enabled,false)
    and coalesce(v_setting.enabled,false)
    and coalesce(v_runtime.billing_mode,'shadow')='shadow'
    and coalesce(v_setting.billing_mode,'shadow')='shadow';
  v_manager_allowed:=v_access_mode='tenant_member'
    and not private_app.odeiry_is_platform_operator(v_tenant.id)
    and private_app.odeiry_manager_can_use(v_tenant.id);
  v_manager_available:=v_available
    and coalesce(v_runtime.manager_enabled,false)
    and v_manager_allowed
    and coalesce(v_manager_setting.enabled,false);
  v_manager_review_available:=v_manager_allowed and exists(
    select 1
    from core.odeiry_manager_memories memory
    where memory.tenant_id=v_tenant.id
      and memory.owner_subject_id=v_subject_id
  );
  return jsonb_build_object(
    'schemaVersion',1,'generatedAt',now(),
    'available',v_available,
    'enabled',coalesce(v_setting.enabled,false),
    'globalEnabled',coalesce(v_runtime.enabled,false),
    'mode',v_access_mode,
    'reason',case
      when not coalesce(v_runtime.enabled,false) then 'globally_disabled'
      when not coalesce(v_setting.enabled,false) then 'tenant_disabled'
      else null end,
    'billing',jsonb_build_object(
      'mode','shadow','billable',false,
      'softBudgetUnits',v_setting.shadow_soft_budget_units,
      'softBudgetEnforced',false
    ),
    'limits',jsonb_build_object(
      'maxInputChars',coalesce(v_runtime.max_input_chars,12000),
      'maxResponseChars',coalesce(v_runtime.max_response_chars,24000),
      'maxKnowledgeResults',coalesce(v_runtime.max_knowledge_results,6),
      'runsPerMinute',coalesce(v_setting.run_rate_limit_per_minute,12)
    ),
    'manager',jsonb_build_object(
      'allowed',v_manager_allowed,
      'globalEnabled',coalesce(v_runtime.manager_enabled,false),
      'enabled',coalesce(v_manager_setting.enabled,false),
      'available',v_manager_available,
      'reviewAvailable',v_manager_review_available,
      'reason',case
        when not v_manager_allowed then 'permission_required'
        when not v_available then 'odeiry_unavailable'
        when not coalesce(v_runtime.manager_enabled,false)
          then 'manager_globally_disabled'
        when not coalesce(v_manager_setting.enabled,false)
          then 'manager_disabled'
        else null end,
      'limits',jsonb_build_object(
        'analyticsReadsPerRun',2,
        'contextMemories',8,
        'maxApprovedMemoriesPerOwner',coalesce(
          v_manager_setting.max_approved_memories_per_owner,50
        ),
        'maxPendingMemoriesPerOwner',coalesce(
          v_manager_setting.max_pending_memories_per_owner,20
        )
      )
    )
  );
end;
$$;

-- Preserve fail-closed tenant deletion and expose manager dependency counts in
-- the existing reviewed preview document. No destructive cleanup is added.
alter function private_app.v1_tenant_deletion_preview_document(uuid)
rename to v1_tenant_deletion_preview_document_manager_v1_legacy_internal;

revoke all on function private_app
  .v1_tenant_deletion_preview_document_manager_v1_legacy_internal(uuid)
from public,anon,authenticated,service_role;

create or replace function private_app.v1_tenant_deletion_preview_document(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_counts jsonb;
  v_blockers jsonb;
  v_settings bigint:=0;
  v_threads bigint:=0;
  v_memories bigint:=0;
  v_requests bigint:=0;
  v_total bigint:=0;
begin
  v_result:=private_app
    .v1_tenant_deletion_preview_document_manager_v1_legacy_internal(
      p_tenant_id
    );
  select count(*) into v_settings
  from core.odeiry_manager_settings where tenant_id=p_tenant_id;
  select count(*) into v_threads
  from core.odeiry_manager_threads where tenant_id=p_tenant_id;
  select count(*) into v_memories
  from core.odeiry_manager_memories where tenant_id=p_tenant_id;
  select count(*) into v_requests
  from core.odeiry_manager_memory_requests where tenant_id=p_tenant_id;
  v_total:=v_settings+v_threads+v_memories+v_requests;
  v_counts:=coalesce(v_result->'counts','{}'::jsonb)||jsonb_build_object(
    'odeiryManagerSettings',v_settings,
    'odeiryManagerThreads',v_threads,
    'odeiryManagerMemories',v_memories,
    'odeiryManagerMemoryRequests',v_requests
  );
  v_blockers:=coalesce(v_result->'blockers','[]'::jsonb);
  if v_total>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','odeiry_manager_memory_exists','count',v_total,
      'message','توجد إعدادات أو ذاكرة أو محادثات لأوديري المدير تتطلب قرار احتفاظ صريحًا.'
    ));
  end if;
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_result,'{counts}',v_counts,true),
      '{blockers}',v_blockers,true
    ),
    '{canDelete}',to_jsonb(jsonb_array_length(v_blockers)=0),true
  )||jsonb_build_object(
    'dependencyFingerprint',encode(extensions.digest(
      coalesce(v_result->>'dependencyFingerprint','')||'|'
        ||v_settings::text||'|'||v_threads::text||'|'
        ||v_memories::text||'|'||v_requests::text,
      'sha256'
    ),'hex'),
    'previewDigest',encode(extensions.digest(
      coalesce(v_result->>'previewDigest','')||'|'||v_counts::text||'|'
        ||v_blockers::text,
      'sha256'
    ),'hex')
  );
end;
$$;

revoke all on function
  public.v1_platform_odeiry_manager_runtime_configure(jsonb)
from public,anon,authenticated,service_role;
revoke all on function public.v1_platform_odeiry_manager_configure(
  text,jsonb
) from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_action(text,text,jsonb)
from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_odeiry_manager_memory_context(
  text,uuid,text,integer
) from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_odeiry_manager_analytics(
  text,uuid,text
) from public,anon,authenticated,service_role;
revoke all on function public.v1_service_odeiry_manager_memory_propose(
  text,uuid,jsonb
) from public,anon,authenticated,service_role;
revoke all on function public.v4_service_odeiry_finalize(
  text,uuid,text,jsonb,jsonb
) from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_odeiry_manager_workspace(text)
from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_odeiry_manager_thread(text,uuid)
from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_odeiry_manager_memory_action(
  text,text,uuid,integer,text
) from public,anon,authenticated,service_role;
revoke all on function public.v3_tenant_odeiry_snapshot(text)
from public,anon,authenticated,service_role;
revoke all on function private_app.v1_tenant_deletion_preview_document(uuid)
from public,anon,authenticated,service_role;

grant execute on function
  public.v1_platform_odeiry_manager_runtime_configure(jsonb)
to authenticated;
grant execute on function public.v1_platform_odeiry_manager_configure(
  text,jsonb
) to authenticated;
grant execute on function public.v3_tenant_odeiry_action(text,text,jsonb)
to authenticated;
grant execute on function public.v1_tenant_odeiry_manager_memory_context(
  text,uuid,text,integer
) to authenticated;
grant execute on function public.v1_tenant_odeiry_manager_analytics(
  text,uuid,text
) to authenticated;
grant execute on function public.v4_service_odeiry_finalize(
  text,uuid,text,jsonb,jsonb
) to service_role;
grant execute on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) to service_role;
grant execute on function public.v1_tenant_odeiry_manager_workspace(text)
to authenticated;
grant execute on function public.v1_tenant_odeiry_manager_thread(text,uuid)
to authenticated;
grant execute on function public.v1_tenant_odeiry_manager_memory_action(
  text,text,uuid,integer,text
) to authenticated;
grant execute on function public.v3_tenant_odeiry_snapshot(text)
to authenticated;

comment on table core.odeiry_manager_settings is
'Per-tenant ODEIRY Manager gate; absent or enabled=false means unavailable.';
comment on table core.odeiry_manager_threads is
'Authoritative capability marker separating personal manager conversations from operations conversations.';
comment on table core.odeiry_manager_memories is
'Personal tenant-and-owner memory revisions. Only approved, unexpired rows can enter model context.';
comment on table core.odeiry_manager_memory_requests is
'Append-only, content-free idempotency ledger for manager memory review actions.';
comment on column core.odeiry_runs.manager_analytics_count is
'Bounded count of sanitized aggregate analytics reads; never more than two per manager run.';
comment on column platform.odeiry_runtime_settings.manager_enabled is
'Independent database-level ODEIRY Manager kill switch; false by default.';
comment on column core.odeiry_runs.manager_memory_batch_hash is
'Atomic manager-finalization receipt hash, including the empty proposal batch.';
comment on column core.odeiry_runs.manager_memory_persisted_count is
'Stable persisted proposal count returned by manager finalization retries.';
comment on function public.v3_tenant_odeiry_action(text,text,jsonb) is
'Capability-separating ODEIRY entry point. Manager threads require real tenant membership and cannot cross into operations or ticket execution.';
comment on function public.v1_tenant_odeiry_manager_memory_context(
  text,uuid,text,integer
) is
'Returns at most eight approved, active personal memories for the exact active manager run; proposed, rejected and archived rows are excluded.';
comment on function public.v1_tenant_odeiry_manager_analytics(
  text,uuid,text
) is
'Returns a fixed allowlist of aggregate report metrics and daily totals, with no staff/customer identities or raw rows.';
comment on function public.v1_service_odeiry_manager_memory_propose(
  text,uuid,jsonb
) is
'Internal-only pending-memory proposal writer. Evidence must be a literal safe quote from the current user message and is stored only as a hash.';
comment on function public.v4_service_odeiry_finalize(
  text,uuid,text,jsonb,jsonb
) is
'Canonical service finalizer: dispatches operations unchanged and atomically closes manager completion, proposal persistence, and its retry receipt.';
comment on function public.v3_tenant_odeiry_finalize(
  text,uuid,text,jsonb
) is
'Temporary operations-only rolling rollback wrapper. It rejects every manager-marked or manager-mode run; remove only in a later migration after old app revisions drain.';
comment on function
  public.v3_tenant_odeiry_finalize_operations_v3_internal(
    text,uuid,text,jsonb
  ) is
'Private preserved v3 implementation; callable only through the operations compatibility wrapper or v4 dispatcher.';
comment on function public.v1_tenant_odeiry_manager_memory_action(
  text,text,uuid,integer,text
) is
'Versioned and idempotent personal approve/reject/archive review flow with content-free audit metadata.';

commit;
