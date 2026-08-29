begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- ODEIR technical support v1 is an additive expansion of the existing
-- core.support_requests table.  Existing rows are intentionally not
-- backfilled or rewritten; every new ticket enters through the v3 RPCs.

create sequence if not exists core.support_ticket_number_seq;

alter table core.support_requests
  add column if not exists ticket_number bigint,
  add column if not exists workflow_version smallint not null default 1,
  add column if not exists version integer not null default 1,
  add column if not exists idempotency_key text,
  add column if not exists idempotency_hash text,
  add column if not exists requester_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  add column if not exists requester_name_snapshot text,
  add column if not exists requester_email_snapshot text,
  add column if not exists requester_role_key_snapshot text,
  add column if not exists requester_job_title_snapshot text,
  add column if not exists module_key text,
  add column if not exists impact text,
  add column if not exists diagnostics jsonb not null default '{}'::jsonb,
  add column if not exists assigned_to_platform_subject_id uuid
    references access_control.subjects(id) on delete set null,
  add column if not exists first_response_due_at timestamptz,
  add column if not exists resolution_due_at timestamptz,
  add column if not exists first_response_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists closed_at timestamptz,
  add column if not exists waiting_started_at timestamptz,
  add column if not exists waiting_total_seconds bigint not null default 0,
  add column if not exists reopened_at timestamptz,
  add column if not exists reopen_count integer not null default 0,
  add column if not exists resolution_summary text,
  add column if not exists last_message_at timestamptz;

alter table core.support_requests
  alter column ticket_number
  set default nextval('core.support_ticket_number_seq'::regclass);

alter sequence core.support_ticket_number_seq
  owned by core.support_requests.ticket_number;

alter table core.support_requests
  drop constraint if exists support_requests_tenant_id_fkey;
alter table core.support_requests
  add constraint support_requests_tenant_id_fkey
  foreign key (tenant_id) references core.tenants(id) on delete restrict;

alter table core.support_requests
  drop constraint if exists support_requests_status_check;

alter table core.support_requests
  add constraint support_requests_status_check check (
    status in (
      'new','reviewing','approved','in_progress','done','rejected',
      'triage','waiting_tenant','waiting_external','resolved','closed','reopened'
    )
  ),
  add constraint support_requests_workflow_version_check
    check (workflow_version between 1 and 100),
  add constraint support_requests_version_check check (version >= 1),
  add constraint support_requests_idempotency_key_check check (
    idempotency_key is null
    or char_length(idempotency_key) between 8 and 160
  ),
  add constraint support_requests_idempotency_hash_check check (
    idempotency_hash is null or idempotency_hash ~ '^[a-f0-9]{64}$'
  ),
  add constraint support_requests_requester_name_check check (
    requester_name_snapshot is null
    or char_length(btrim(requester_name_snapshot)) between 2 and 240
  ),
  add constraint support_requests_requester_email_check check (
    requester_email_snapshot is null
    or requester_email_snapshot=lower(btrim(requester_email_snapshot))
  ),
  add constraint support_requests_module_key_check check (
    module_key is null or module_key ~ '^[a-z][a-z0-9_.-]{1,79}$'
  ),
  add constraint support_requests_impact_check check (
    impact is null or impact in (
      'blocked','multiple_users','single_user','minor','question','security',
      'partial','major','blocking'
    )
  ),
  add constraint support_requests_diagnostics_object_check
    check (jsonb_typeof(diagnostics)='object'),
  add constraint support_requests_waiting_total_check
    check (waiting_total_seconds >= 0),
  add constraint support_requests_reopen_count_check check (reopen_count >= 0),
  add constraint support_requests_resolution_summary_check check (
    resolution_summary is null
    or char_length(btrim(resolution_summary)) between 3 and 4000
  ),
  add constraint support_requests_tenant_id_id_key unique (tenant_id,id);

create unique index if not exists core_support_requests_ticket_number_uidx
on core.support_requests(ticket_number)
where ticket_number is not null;

create unique index if not exists core_support_requests_tenant_idempotency_uidx
on core.support_requests(tenant_id,idempotency_key)
where tenant_id is not null and idempotency_key is not null;

create index if not exists core_support_requests_tenant_activity_idx
on core.support_requests(tenant_id,updated_at desc,id desc);

create index if not exists core_support_requests_requester_activity_idx
on core.support_requests(
  tenant_id,requested_by_subject_id,updated_at desc,id desc
)
where tenant_id is not null;

create index if not exists core_support_requests_requester_created_idx
on core.support_requests(
  tenant_id,requested_by_subject_id,created_at desc,id desc
)
where tenant_id is not null and requested_by_subject_id is not null;

create index if not exists core_support_requests_status_activity_idx
on core.support_requests(status,updated_at desc,id desc);

create index if not exists core_support_requests_priority_activity_idx
on core.support_requests(priority,updated_at desc,id desc);

create index if not exists core_support_requests_module_activity_idx
on core.support_requests(module_key,updated_at desc,id desc)
where module_key is not null;

create index if not exists core_support_requests_assignee_activity_idx
on core.support_requests(
  assigned_to_platform_subject_id,updated_at desc,id desc
)
where assigned_to_platform_subject_id is not null;

create index if not exists core_support_requests_response_sla_idx
on core.support_requests(first_response_due_at)
where first_response_at is null
  and status not in ('resolved','closed','done','rejected');

create index if not exists core_support_requests_resolution_sla_idx
on core.support_requests(resolution_due_at)
where resolved_at is null
  and status not in ('closed','done','rejected');

create index if not exists core_support_requests_search_idx
on core.support_requests using gin (
  to_tsvector(
    'simple',
    coalesce(title,'')||' '||coalesce(description,'')||' '
      ||coalesce(requester_name_snapshot,'')||' '
      ||coalesce(requester_email_snapshot,'')
  )
);

create table core.support_messages (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  ticket_id uuid not null,
  author_scope text not null
    check (author_scope in ('tenant','platform','system')),
  author_subject_id uuid
    references access_control.subjects(id) on delete set null,
  author_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  author_name_snapshot text,
  author_email_snapshot text,
  author_role_key_snapshot text,
  author_job_title_snapshot text,
  content text not null
    check (char_length(btrim(content)) between 1 and 12000),
  is_internal boolean not null default false,
  client_request_id text not null
    check (char_length(client_request_id) between 8 and 180),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint support_messages_ticket_fk
    foreign key (tenant_id,ticket_id)
    references core.support_requests(tenant_id,id) on delete cascade,
  constraint support_messages_internal_scope_check
    check (not is_internal or author_scope in ('platform','system')),
  constraint support_messages_tenant_ticket_id_key
    unique (tenant_id,ticket_id,id),
  constraint support_messages_client_request_key
    unique (tenant_id,ticket_id,client_request_id)
);

create index core_support_messages_ticket_time_idx
on core.support_messages(tenant_id,ticket_id,created_at,id);

create index core_support_messages_author_time_idx
on core.support_messages(author_subject_id,created_at desc)
where author_subject_id is not null;

create table core.support_events (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  ticket_id uuid not null,
  ticket_version integer not null check (ticket_version >= 1),
  event_type text not null
    check (event_type ~ '^[a-z][a-z0-9_.-]{2,100}$'),
  actor_scope text not null
    check (actor_scope in ('tenant','platform','system')),
  actor_subject_id uuid
    references access_control.subjects(id) on delete set null,
  from_status text,
  to_status text,
  visibility text not null default 'tenant'
    check (visibility in ('tenant','platform')),
  client_request_id text,
  request_hash text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now(),
  constraint support_events_ticket_fk
    foreign key (tenant_id,ticket_id)
    references core.support_requests(tenant_id,id) on delete cascade,
  constraint support_events_client_request_check check (
    client_request_id is null
    or char_length(client_request_id) between 8 and 180
  ),
  constraint support_events_request_hash_check check (
    request_hash is null or request_hash ~ '^[a-f0-9]{64}$'
  )
);

create unique index core_support_events_client_request_uidx
on core.support_events(tenant_id,ticket_id,client_request_id)
where client_request_id is not null;

create index core_support_events_ticket_time_idx
on core.support_events(tenant_id,ticket_id,created_at desc,id desc);

create table core.support_attachments (
  id uuid primary key default extensions.gen_random_uuid(),
  tenant_id uuid not null,
  ticket_id uuid not null,
  message_id uuid not null,
  bucket_id text not null default 'support-attachments'
    check (bucket_id='support-attachments'),
  object_path text not null unique,
  file_name text not null
    check (char_length(btrim(file_name)) between 1 and 240),
  mime_type text not null check (
    mime_type in (
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain'
    )
  ),
  declared_size_bytes bigint not null
    check (declared_size_bytes between 1 and 10485760),
  actual_size_bytes bigint
    check (actual_size_bytes is null or actual_size_bytes between 1 and 10485760),
  checksum_sha256 text
    check (checksum_sha256 is null or checksum_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending'
    check (state in ('pending','ready','rejected')),
  uploaded_by_scope text not null
    check (uploaded_by_scope in ('tenant','platform')),
  uploaded_by_subject_id uuid not null
    references access_control.subjects(id) on delete restrict,
  client_request_id text not null
    check (char_length(client_request_id) between 8 and 180),
  request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz not null default (now()+interval '2 hours'),
  cleanup_after timestamptz not null default (now()+interval '5 hours'),
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  constraint support_attachments_message_fk
    foreign key (tenant_id,ticket_id,message_id)
    references core.support_messages(tenant_id,ticket_id,id) on delete cascade,
  constraint support_attachments_client_request_key
    unique (tenant_id,ticket_id,message_id,client_request_id),
  constraint support_attachments_cleanup_after_check
    check (cleanup_after>=expires_at+interval '2 hours')
);

create index core_support_attachments_message_idx
on core.support_attachments(tenant_id,ticket_id,message_id,created_at,id);

create index core_support_attachments_pending_expiry_idx
on core.support_attachments(cleanup_after)
where state='pending';

create table if not exists platform.support_attachment_cleanup_worker_config (
  singleton boolean primary key default true check (singleton),
  function_url text not null check (
    function_url ~
      '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/support-attachment-cleanup$'
  ),
  cleanup_secret_hash text not null
    check (cleanup_secret_hash ~ '^[a-f0-9]{64}$'),
  cleanup_secret_vault_id uuid not null,
  publishable_key_vault_id uuid not null,
  cron_job_id bigint,
  configured_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  configured_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint support_attachment_cleanup_worker_vault_ids_check
    check (cleanup_secret_vault_id<>publishable_key_vault_id)
);

create table core.support_read_states (
  tenant_id uuid not null,
  ticket_id uuid not null,
  subject_id uuid not null
    references access_control.subjects(id) on delete cascade,
  reader_scope text not null
    check (reader_scope in ('tenant','platform')),
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id,ticket_id,subject_id),
  constraint support_read_states_ticket_fk
    foreign key (tenant_id,ticket_id)
    references core.support_requests(tenant_id,id) on delete cascade
);

create index core_support_read_states_subject_idx
on core.support_read_states(subject_id,updated_at desc);

alter table core.support_messages enable row level security;
alter table core.support_events enable row level security;
alter table core.support_attachments enable row level security;
alter table core.support_read_states enable row level security;
alter table platform.support_attachment_cleanup_worker_config
  enable row level security;

revoke all on table core.support_requests
from public,anon,authenticated,service_role;
revoke all on table core.support_messages
from public,anon,authenticated,service_role;
revoke all on table core.support_events
from public,anon,authenticated,service_role;
revoke all on table core.support_attachments
from public,anon,authenticated,service_role;
revoke all on table core.support_read_states
from public,anon,authenticated,service_role;
revoke all on table platform.support_attachment_cleanup_worker_config
from public,anon,authenticated,service_role;
revoke all on sequence core.support_ticket_number_seq
from public,anon,authenticated,service_role;

insert into access_control.permissions(
  permission_key,module_key,name_ar,description
) values
  (
    'tenant.support.read_all','support','عرض جميع تذاكر المنشأة',
    'عرض ومتابعة تذاكر دعم أودير التي أنشأها أي موظف داخل المنشأة'
  ),
  (
    'platform.support.read','support','عرض تذاكر دعم أودير',
    'عرض قائمة وتفاصيل تذاكر الدعم الفني عبر المنشآت'
  ),
  (
    'platform.support.reply','support','الرد على تذاكر دعم أودير',
    'الرد وتحديث مسار المعالجة الفني دون إدارة الفريق أو الإسناد'
  ),
  (
    'platform.support.manage','support','إدارة تذاكر وفريق دعم أودير',
    'الإسناد وإدارة الأولويات والحالات وإعدادات معالجة التذاكر'
  )
on conflict(permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.roles(
  tenant_id,role_key,name_ar,name_en,scope,is_system
) values
  (
    null,'platform_support_agent','مسؤول الدعم الفني',
    'Technical Support Agent','platform',true
  ),
  (
    null,'platform_support_manager','مدير الدعم الفني',
    'Technical Support Manager','platform',true
  )
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='tenant'
  and role.role_key in ('tenant_owner','tenant_admin','executive_manager')
  and permission.permission_key='tenant.support.read_all'
on conflict do nothing;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope='platform'
  and role.tenant_id is null
  and (
    (
      role.role_key='platform_support_agent'
      and permission.permission_key in (
        'platform.support.read','platform.support.reply'
      )
    )
    or (
      role.role_key in (
        'platform_support_manager','platform_owner',
        'platform_operations_manager'
      )
      and permission.permission_key in (
        'platform.support.read','platform.support.reply',
        'platform.support.manage'
      )
    )
  )
on conflict do nothing;

comment on table core.support_requests is
'Canonical ODEIR technical-support ticket record. Existing legacy rows remain valid; v3 workflows add versioned conversations, SLA and assignment.';
comment on table core.support_messages is
'Tenant-scoped support conversation. Internal platform notes are never exposed to tenant readers.';
comment on table core.support_events is
'Append-only, content-free technical-support lifecycle history.';
comment on table core.support_attachments is
'Private support attachment manifest. Objects are uploaded through DB-issued paths and Storage API only.';
comment on table platform.support_attachment_cleanup_worker_config is
'Private Vault references and pg_cron identity for orphan support-attachment cleanup; no plaintext credential is stored.';
comment on table core.support_read_states is
'Per-subject ticket read watermark used to calculate unread conversation counts.';

create or replace function private_app.support_is_active_tenant_member(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select auth.uid() is not null and exists(
    select 1
    from access_control.subjects subject
    join access_control.memberships membership
      on membership.subject_id=subject.id
     and membership.scope='tenant'
     and membership.status='active'
    join core.tenants tenant
      on tenant.id=membership.tenant_id
     and tenant.status in ('trial','active')
    where subject.auth_user_id=auth.uid()
      and subject.status='active'
      and not subject.must_change_password
      and membership.tenant_id=p_tenant_id
  )
$$;

create or replace function private_app.support_tenant_can_read_all(
  p_tenant_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.support_is_active_tenant_member(p_tenant_id)
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
       and role_permission.permission_key='tenant.support.read_all'
      where subject.auth_user_id=auth.uid()
        and subject.status='active'
        and not subject.must_change_password
    )
$$;

create or replace function private_app.support_platform_can_read()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.has_platform_permission('platform.support.read')
    or private_app.has_platform_permission('platform.support.reply')
    or private_app.has_platform_permission('platform.support.manage')
$$;

create or replace function private_app.support_platform_can_reply()
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.has_platform_permission('platform.support.reply')
    or private_app.has_platform_permission('platform.support.manage')
$$;

create or replace function private_app.support_tenant_can_read_ticket(
  p_tenant_id uuid,
  p_ticket_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.support_is_active_tenant_member(p_tenant_id)
    and exists(
      select 1
      from core.support_requests ticket
      where ticket.id=p_ticket_id
        and ticket.tenant_id=p_tenant_id
        and (
          ticket.requested_by_subject_id=private_app.current_subject_id()
          or private_app.support_tenant_can_read_all(p_tenant_id)
        )
    )
$$;

create or replace function private_app.support_can_read_ticket(
  p_tenant_id uuid,
  p_ticket_id uuid
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select private_app.support_tenant_can_read_ticket(
    p_tenant_id,p_ticket_id
  ) or private_app.support_platform_can_read()
$$;

create or replace function private_app.support_subject_has_platform_permission(
  p_subject_id uuid,
  p_permission text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from access_control.subjects subject
    join access_control.memberships membership
      on membership.subject_id=subject.id
     and membership.scope='platform'
     and membership.status='active'
    join access_control.membership_roles membership_role
      on membership_role.membership_id=membership.id
    join access_control.roles role
      on role.id=membership_role.role_id
     and role.scope='platform'
    join access_control.role_permissions role_permission
      on role_permission.role_id=role.id
    where subject.id=p_subject_id
      and subject.status='active'
      and not subject.must_change_password
      and role_permission.permission_key=p_permission
  )
$$;

create or replace function private_app.support_response_interval(
  p_priority text,
  p_impact text
)
returns interval
language sql
immutable
set search_path=''
as $$
  select case
    when p_priority='urgent'
      or p_impact in ('blocked','security','blocking') then interval '1 hour'
    when p_priority='high'
      or p_impact in ('multiple_users','major') then interval '4 hours'
    when p_priority='medium'
      or p_impact in ('single_user','partial') then interval '8 hours'
    else interval '24 hours'
  end
$$;

create or replace function private_app.support_resolution_interval(
  p_priority text,
  p_impact text
)
returns interval
language sql
immutable
set search_path=''
as $$
  select case
    when p_priority='urgent'
      or p_impact in ('blocked','security','blocking') then interval '8 hours'
    when p_priority='high'
      or p_impact in ('multiple_users','major') then interval '24 hours'
    when p_priority='medium'
      or p_impact in ('single_user','partial') then interval '72 hours'
    else interval '120 hours'
  end
$$;

create or replace function private_app.support_reference(
  p_ticket_number bigint,
  p_created_at timestamptz,
  p_ticket_id uuid
)
returns text
language sql
stable
set search_path=''
as $$
  select case
    when p_ticket_number is null then
      'ODEIR-L-'||upper(substr(p_ticket_id::text,1,8))
    else
      'ODEIR-'||to_char(p_created_at at time zone 'UTC','YYYY')||'-'||
      lpad(p_ticket_number::text,7,'0')
  end
$$;

create or replace function private_app.support_effective_resolution_due(
  p_resolution_due_at timestamptz,
  p_waiting_started_at timestamptz
)
returns timestamptz
language sql
stable
set search_path=''
as $$
  select case
    when p_resolution_due_at is null then null
    when p_waiting_started_at is null then p_resolution_due_at
    else p_resolution_due_at+greatest(
      interval '0 seconds',now()-p_waiting_started_at
    )
  end
$$;

create or replace function private_app.support_validate_client_request_id(
  p_value text
)
returns text
language plpgsql
immutable
set search_path=''
as $$
declare
  v_value text:=btrim(coalesce(p_value,''));
begin
  if char_length(v_value) not between 8 and 160
     or v_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$' then
    raise exception 'support_client_request_id_invalid';
  end if;
  return v_value;
end;
$$;

create or replace function private_app.support_sha256(p_payload jsonb)
returns text
language sql
immutable
set search_path=''
as $$
  select encode(
    extensions.digest(coalesce(p_payload,'{}'::jsonb)::text,'sha256'),
    'hex'
  )
$$;

revoke all on function private_app.support_is_active_tenant_member(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_tenant_can_read_all(uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_platform_can_read()
from public,anon,authenticated,service_role;
revoke all on function private_app.support_platform_can_reply()
from public,anon,authenticated,service_role;
revoke all on function private_app.support_tenant_can_read_ticket(uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_can_read_ticket(uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_subject_has_platform_permission(uuid,text)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_response_interval(text,text)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_resolution_interval(text,text)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_reference(bigint,timestamptz,uuid)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_effective_resolution_due(
  timestamptz,timestamptz
) from public,anon,authenticated,service_role;
revoke all on function private_app.support_validate_client_request_id(text)
from public,anon,authenticated,service_role;
revoke all on function private_app.support_sha256(jsonb)
from public,anon,authenticated,service_role;

create or replace function private_app.support_set_updated_at_clock()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  new.updated_at:=greatest(
    coalesce(old.updated_at,'epoch'::timestamptz),
    coalesce(new.updated_at,'epoch'::timestamptz),
    clock_timestamp()
  );
  return new;
end;
$$;

revoke all on function private_app.support_set_updated_at_clock()
from public,anon,authenticated,service_role;
drop trigger if exists support_requests_set_updated_at
on core.support_requests;
create trigger support_requests_set_updated_at
before update on core.support_requests
for each row execute function private_app.support_set_updated_at_clock();

drop policy if exists support_requests_isolated_read
on core.support_requests;
drop policy if exists support_requests_v3_read
on core.support_requests;
create policy support_requests_v3_read
on core.support_requests
for select
to authenticated
using (
  tenant_id is not null
  and private_app.support_can_read_ticket(tenant_id,id)
);

create policy support_messages_v3_read
on core.support_messages
for select
to authenticated
using (
  (
    private_app.support_tenant_can_read_ticket(tenant_id,ticket_id)
    and not is_internal
  )
  or private_app.support_platform_can_read()
);

create policy support_events_v3_read
on core.support_events
for select
to authenticated
using (
  (
    private_app.support_tenant_can_read_ticket(tenant_id,ticket_id)
    and visibility='tenant'
  )
  or private_app.support_platform_can_read()
);

create policy support_attachments_v3_read
on core.support_attachments
for select
to authenticated
using (
  state='ready'
  and exists(
    select 1
    from core.support_messages message
    where message.tenant_id=support_attachments.tenant_id
      and message.ticket_id=support_attachments.ticket_id
      and message.id=support_attachments.message_id
      and (
        (
          private_app.support_tenant_can_read_ticket(
            support_attachments.tenant_id,
            support_attachments.ticket_id
          )
          and not message.is_internal
        )
        or private_app.support_platform_can_read()
      )
  )
);

create policy support_read_states_v3_read
on core.support_read_states
for select
to authenticated
using (
  subject_id=private_app.current_subject_id()
  and private_app.support_can_read_ticket(tenant_id,ticket_id)
);

create or replace function private_app.support_ticket_document(
  p_ticket_id uuid,
  p_include_details boolean,
  p_include_internal boolean,
  p_reader_subject_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_ticket core.support_requests%rowtype;
  v_tenant core.tenants%rowtype;
  v_assignee access_control.subjects%rowtype;
  v_last_read_at timestamptz:='epoch'::timestamptz;
  v_read_watermark timestamptz;
  v_message_count bigint:=0;
  v_unread_count bigint:=0;
  v_messages jsonb;
  v_events jsonb;
  v_waiting_seconds bigint:=0;
begin
  select ticket.* into v_ticket
  from core.support_requests ticket
  where ticket.id=p_ticket_id;
  if v_ticket.id is null then return null; end if;

  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id=v_ticket.tenant_id;

  if v_ticket.assigned_to_platform_subject_id is not null then
    select subject.* into v_assignee
    from access_control.subjects subject
    where subject.id=v_ticket.assigned_to_platform_subject_id;
  end if;

  select read_state.last_read_at into v_last_read_at
  from core.support_read_states read_state
  where read_state.tenant_id=v_ticket.tenant_id
    and read_state.ticket_id=v_ticket.id
    and read_state.subject_id=p_reader_subject_id;
  v_last_read_at:=coalesce(v_last_read_at,'epoch'::timestamptz);

  select count(*),max(message.created_at)
  into v_message_count,v_read_watermark
  from core.support_messages message
  where message.tenant_id=v_ticket.tenant_id
    and message.ticket_id=v_ticket.id
    and (p_include_internal or not message.is_internal);

  select count(*) into v_unread_count
  from core.support_messages message
  where message.tenant_id=v_ticket.tenant_id
    and message.ticket_id=v_ticket.id
    and message.created_at>v_last_read_at
    and message.author_subject_id is distinct from p_reader_subject_id
    and (p_include_internal or not message.is_internal);

  if p_include_details then
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',message.id,
      'authorScope',message.author_scope,
      'author',jsonb_strip_nulls(jsonb_build_object(
        'subjectId',message.author_subject_id,
        'staffId',message.author_staff_id,
        'name',message.author_name_snapshot,
        'email',case
          when p_include_internal or message.author_scope='tenant'
            then message.author_email_snapshot
          else null
        end,
        'roleKey',message.author_role_key_snapshot,
        'jobTitle',message.author_job_title_snapshot
      )),
      'content',message.content,
      'isInternal',message.is_internal,
      'createdAt',message.created_at,
      'attachments',coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',attachment.id,
          'fileName',attachment.file_name,
          'mimeType',attachment.mime_type,
          'sizeBytes',attachment.actual_size_bytes,
          'state',attachment.state,
          'createdAt',attachment.created_at
        ) order by attachment.created_at,attachment.id)
        from core.support_attachments attachment
        where attachment.tenant_id=message.tenant_id
          and attachment.ticket_id=message.ticket_id
          and attachment.message_id=message.id
          and attachment.state='ready'
      ),'[]'::jsonb)
    ) order by message.created_at,message.id),'[]'::jsonb)
    into v_messages
    from (
      select message.*
      from core.support_messages message
      where message.tenant_id=v_ticket.tenant_id
        and message.ticket_id=v_ticket.id
        and (p_include_internal or not message.is_internal)
      order by message.created_at desc,message.id desc
      limit 250
    ) message;

    select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id',event.id,
      'type',event.event_type,
      'ticketVersion',event.ticket_version,
      'actorScope',event.actor_scope,
      'actorSubjectId',event.actor_subject_id,
      'fromStatus',event.from_status,
      'toStatus',event.to_status,
      'createdAt',event.created_at
    )) order by event.created_at desc,event.id desc),'[]'::jsonb)
    into v_events
    from (
      select event.*
      from core.support_events event
      where event.tenant_id=v_ticket.tenant_id
        and event.ticket_id=v_ticket.id
        and (p_include_internal or event.visibility='tenant')
      order by event.created_at desc,event.id desc
      limit 150
    ) event;
  end if;

  v_waiting_seconds:=v_ticket.waiting_total_seconds+
    case
      when v_ticket.waiting_started_at is null then 0
      else greatest(
        0,
        floor(extract(epoch from (now()-v_ticket.waiting_started_at)))::bigint
      )
    end;

  return jsonb_strip_nulls(jsonb_build_object(
    'id',v_ticket.id,
    'ticketNumber',v_ticket.ticket_number,
    'reference',private_app.support_reference(
      v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
    ),
    'version',v_ticket.version,
    'workflowVersion',v_ticket.workflow_version,
    'title',v_ticket.title,
    'description',v_ticket.description,
    'category',v_ticket.category,
    'priority',v_ticket.priority,
    'status',v_ticket.status,
    'moduleKey',v_ticket.module_key,
    'impact',v_ticket.impact,
    'tenant',case when v_tenant.id is null then null else
      jsonb_build_object(
        'id',v_tenant.id,'name',v_tenant.name,'slug',v_tenant.slug
      ) end,
    'requester',jsonb_strip_nulls(jsonb_build_object(
      'subjectId',v_ticket.requested_by_subject_id,
      'staffId',v_ticket.requester_staff_id,
      'name',v_ticket.requester_name_snapshot,
      'email',v_ticket.requester_email_snapshot,
      'roleKey',v_ticket.requester_role_key_snapshot,
      'jobTitle',v_ticket.requester_job_title_snapshot
    )),
    'assignee',case when v_assignee.id is null then null else
      jsonb_strip_nulls(jsonb_build_object(
        'subjectId',v_assignee.id,
        'name',v_assignee.full_name,
        'email',case when p_include_internal then v_assignee.email end
      )) end,
    'sla',jsonb_strip_nulls(jsonb_build_object(
      'firstResponseDueAt',v_ticket.first_response_due_at,
      'resolutionDueAt',private_app.support_effective_resolution_due(
        v_ticket.resolution_due_at,v_ticket.waiting_started_at
      ),
      'firstResponseAt',v_ticket.first_response_at,
      'resolvedAt',v_ticket.resolved_at,
      'closedAt',v_ticket.closed_at,
      'waitingStartedAt',v_ticket.waiting_started_at,
      'waitingTotalSeconds',v_waiting_seconds,
      'reopenedAt',v_ticket.reopened_at,
      'reopenCount',v_ticket.reopen_count,
      'responseBreached',(
        v_ticket.first_response_at is null
        and v_ticket.first_response_due_at is not null
        and now()>v_ticket.first_response_due_at
        and v_ticket.status not in ('resolved','closed','done','rejected')
      ),
      'resolutionBreached',(
        v_ticket.resolved_at is null
        and private_app.support_effective_resolution_due(
          v_ticket.resolution_due_at,v_ticket.waiting_started_at
        ) is not null
        and now()>private_app.support_effective_resolution_due(
          v_ticket.resolution_due_at,v_ticket.waiting_started_at
        )
        and v_ticket.status not in ('closed','done','rejected')
      )
    )),
    'resolutionSummary',v_ticket.resolution_summary,
    'canReopen',case
      when p_include_internal then
        (
          private_app.support_subject_has_platform_permission(
            p_reader_subject_id,'platform.support.reply'
          ) or private_app.support_subject_has_platform_permission(
            p_reader_subject_id,'platform.support.manage'
          )
        )
        and v_ticket.status in ('resolved','closed','done')
      else
        v_ticket.requested_by_subject_id=p_reader_subject_id
        and private_app.support_is_active_tenant_member(v_ticket.tenant_id)
        and v_ticket.status in ('resolved','closed','done')
        and coalesce(
          v_ticket.closed_at,v_ticket.resolved_at,v_ticket.updated_at
        )>=now()-interval '14 days'
    end,
    'canClose',case
      when p_include_internal then
        (
          private_app.support_subject_has_platform_permission(
            p_reader_subject_id,'platform.support.reply'
          ) or private_app.support_subject_has_platform_permission(
            p_reader_subject_id,'platform.support.manage'
          )
        ) and v_ticket.status in ('resolved','done')
      else
        v_ticket.requested_by_subject_id=p_reader_subject_id
        and private_app.support_is_active_tenant_member(v_ticket.tenant_id)
        and v_ticket.status in ('resolved','done')
    end,
    'canReply',case
      when p_include_internal then
        private_app.support_subject_has_platform_permission(
          p_reader_subject_id,'platform.support.reply'
        ) or private_app.support_subject_has_platform_permission(
          p_reader_subject_id,'platform.support.manage'
        )
      else
        v_ticket.requested_by_subject_id=p_reader_subject_id
        and private_app.support_is_active_tenant_member(v_ticket.tenant_id)
        and v_ticket.status not in ('resolved','closed','done','rejected')
    end,
    'createdAt',v_ticket.created_at,
    'updatedAt',v_ticket.updated_at,
    'lastMessageAt',v_ticket.last_message_at,
    'messageCount',v_message_count,
    'unreadCount',v_unread_count,
    'readWatermark',v_read_watermark,
    'diagnostics',case when p_include_details then v_ticket.diagnostics else null end,
    'messages',case when p_include_details then v_messages else null end,
    'events',case when p_include_details then v_events else null end
  ));
end;
$$;

revoke all on function private_app.support_ticket_document(
  uuid,boolean,boolean,uuid
) from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_support_snapshot(
  p_slug text,
  p_ticket_id uuid default null,
  p_filters jsonb default '{}'::jsonb,
  p_page_size integer default 25,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
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
  v_staff_id uuid;
  v_can_read_all boolean:=false;
  v_is_platform_reader boolean:=false;
  v_scope text:=coalesce(nullif(btrim(p_filters->>'scope'),''),'mine');
  v_status text:=nullif(btrim(p_filters->>'status'),'');
  v_priority text:=nullif(btrim(p_filters->>'priority'),'');
  v_module_key text:=nullif(btrim(p_filters->>'moduleKey'),'');
  v_search text:=nullif(left(btrim(p_filters->>'search'),120),'');
  v_page_size integer:=least(greatest(coalesce(p_page_size,25),1),100);
  v_ids uuid[]:='{}'::uuid[];
  v_has_more boolean:=false;
  v_last_id uuid;
  v_next_cursor jsonb;
  v_tickets jsonb:='[]'::jsonb;
  v_summary jsonb;
begin
  if coalesce(jsonb_typeof(p_filters),'object')<>'object' then
    raise exception 'support_filters_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if v_subject_id is null then raise exception 'authentication_required'; end if;
  v_is_platform_reader:=private_app.support_platform_can_read();
  if not private_app.support_is_active_tenant_member(v_tenant.id)
     and not v_is_platform_reader then
    raise exception 'forbidden';
  end if;

  v_staff_id:=private_app.current_staff_id(v_tenant.id);
  v_can_read_all:=v_is_platform_reader
    or private_app.support_tenant_can_read_all(v_tenant.id);
  if v_is_platform_reader then v_scope:='all'; end if;
  if v_scope not in ('mine','all') then raise exception 'support_scope_invalid'; end if;
  if v_scope='all' and not v_can_read_all then raise exception 'forbidden'; end if;
  if v_status is not null and v_status not in (
    'new','reviewing','approved','in_progress','done','rejected',
    'triage','waiting_tenant','waiting_external','resolved','closed','reopened'
  ) then raise exception 'support_status_invalid'; end if;
  if v_priority is not null and v_priority not in (
    'low','medium','high','urgent'
  ) then raise exception 'support_priority_invalid'; end if;
  if v_module_key is not null
     and v_module_key !~ '^[a-z][a-z0-9_.-]{1,79}$' then
    raise exception 'support_module_invalid';
  end if;
  if (p_cursor_updated_at is null)<>(p_cursor_id is null) then
    raise exception 'support_cursor_invalid';
  end if;

  if p_ticket_id is not null then
    if not (
      v_is_platform_reader
      or private_app.support_tenant_can_read_ticket(v_tenant.id,p_ticket_id)
    ) or not exists(
      select 1 from core.support_requests ticket
      where ticket.id=p_ticket_id and ticket.tenant_id=v_tenant.id
    ) then raise exception 'support_ticket_not_found'; end if;
    v_ids:=array[p_ticket_id];
  else
    select coalesce(array_agg(candidate.id order by candidate.updated_at desc,candidate.id desc),'{}'::uuid[])
    into v_ids
    from (
      select ticket.id,ticket.updated_at
      from core.support_requests ticket
      where ticket.tenant_id=v_tenant.id
        and (v_scope='all' or ticket.requested_by_subject_id=v_subject_id)
        and (v_status is null or ticket.status=v_status)
        and (v_priority is null or ticket.priority=v_priority)
        and (v_module_key is null or ticket.module_key=v_module_key)
        and (
          v_search is null
          or to_tsvector(
            'simple',coalesce(ticket.title,'')||' '
              ||coalesce(ticket.description,'')||' '
              ||coalesce(ticket.requester_name_snapshot,'')||' '
              ||coalesce(ticket.requester_email_snapshot,'')
          ) @@ plainto_tsquery('simple',v_search)
          or ticket.ticket_number::text like '%'||v_search||'%'
        )
        and (
          p_cursor_updated_at is null
          or (ticket.updated_at,ticket.id)<(
            p_cursor_updated_at,p_cursor_id
          )
        )
      order by ticket.updated_at desc,ticket.id desc
      limit v_page_size+1
    ) candidate;
    v_has_more:=coalesce(cardinality(v_ids),0)>v_page_size;
    if v_has_more then v_ids:=v_ids[1:v_page_size]; end if;
  end if;

  select coalesce(jsonb_agg(
    private_app.support_ticket_document(
      member.id,p_ticket_id is not null,false,v_subject_id
    ) order by member.position
  ),'[]'::jsonb)
  into v_tickets
  from unnest(v_ids) with ordinality member(id,position);

  if cardinality(v_ids)>0 and p_ticket_id is null then
    v_last_id:=v_ids[cardinality(v_ids)];
    select jsonb_build_object('updatedAt',ticket.updated_at,'id',ticket.id)
    into v_next_cursor
    from core.support_requests ticket
    where ticket.id=v_last_id;
    if not v_has_more then v_next_cursor:=null; end if;
  end if;

  select jsonb_build_object(
    'total',count(*),
    'open',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
    ),
    'waitingTenant',count(*) filter (where ticket.status='waiting_tenant'),
    'resolved',count(*) filter (
      where ticket.status in ('resolved','closed','done')
    ),
    'unread',count(*) filter (where exists(
      select 1
      from core.support_messages message
      left join core.support_read_states read_state
        on read_state.tenant_id=message.tenant_id
       and read_state.ticket_id=message.ticket_id
       and read_state.subject_id=v_subject_id
      where message.tenant_id=ticket.tenant_id
        and message.ticket_id=ticket.id
        and not message.is_internal
        and message.author_subject_id is distinct from v_subject_id
        and message.created_at>coalesce(
          read_state.last_read_at,'epoch'::timestamptz
        )
    ))
  ) into v_summary
  from core.support_requests ticket
  where ticket.tenant_id=v_tenant.id
    and (v_scope='all' or ticket.requested_by_subject_id=v_subject_id)
    and (v_status is null or ticket.status=v_status)
    and (v_priority is null or ticket.priority=v_priority)
    and (v_module_key is null or ticket.module_key=v_module_key)
    and (
      v_search is null
      or to_tsvector(
        'simple',coalesce(ticket.title,'')||' '
          ||coalesce(ticket.description,'')||' '
          ||coalesce(ticket.requester_name_snapshot,'')||' '
          ||coalesce(ticket.requester_email_snapshot,'')
      ) @@ plainto_tsquery('simple',v_search)
      or ticket.ticket_number::text like '%'||v_search||'%'
    );

  return jsonb_build_object(
    'schemaVersion',3,
    'generatedAt',now(),
    'viewer',jsonb_build_object(
      'scope','tenant','subjectId',v_subject_id,'staffId',v_staff_id,
      'canReadAll',v_can_read_all,'platformPreview',v_is_platform_reader,
      'canCreate',private_app.support_is_active_tenant_member(v_tenant.id),
      'canReply',not v_is_platform_reader
        and private_app.support_is_active_tenant_member(v_tenant.id)
    ),
    'filters',jsonb_strip_nulls(jsonb_build_object(
      'scope',v_scope,'status',v_status,'priority',v_priority,
      'moduleKey',v_module_key,'search',v_search
    )),
    'summary',v_summary,
    'page',jsonb_build_object(
      'pageSize',v_page_size,'hasMore',v_has_more,
      'nextCursor',v_next_cursor
    ),
    'tickets',v_tickets
  );
end;
$$;

revoke all on function public.v3_tenant_support_snapshot(
  text,uuid,jsonb,integer,timestamptz,uuid
) from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_support_snapshot(
  text,uuid,jsonb,integer,timestamptz,uuid
) to authenticated;

create or replace function public.v3_platform_support_snapshot(
  p_ticket_id uuid default null,
  p_filters jsonb default '{}'::jsonb,
  p_page_size integer default 50,
  p_cursor_updated_at timestamptz default null,
  p_cursor_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_subject_id uuid:=private_app.current_subject_id();
  v_can_read boolean:=private_app.support_platform_can_read();
  v_can_reply boolean:=private_app.support_platform_can_reply();
  v_can_manage boolean:=private_app.has_platform_permission(
    'platform.support.manage'
  );
  v_tenant_id uuid;
  v_status text:=nullif(btrim(p_filters->>'status'),'');
  v_priority text:=nullif(btrim(p_filters->>'priority'),'');
  v_module_key text:=nullif(btrim(p_filters->>'moduleKey'),'');
  v_assignee_id uuid;
  v_queue text:=coalesce(nullif(btrim(p_filters->>'queue'),''),'all');
  v_search text:=nullif(left(btrim(p_filters->>'search'),120),'');
  v_page_size integer:=least(greatest(coalesce(p_page_size,50),1),100);
  v_ids uuid[]:='{}'::uuid[];
  v_has_more boolean:=false;
  v_last_id uuid;
  v_next_cursor jsonb;
  v_tickets jsonb:='[]'::jsonb;
  v_summary jsonb;
  v_queues jsonb:='{}'::jsonb;
  v_agents jsonb:='[]'::jsonb;
  v_tenants jsonb:='[]'::jsonb;
begin
  if coalesce(jsonb_typeof(p_filters),'object')<>'object' then
    raise exception 'support_filters_invalid';
  end if;
  if not v_can_read or v_subject_id is null then raise exception 'forbidden'; end if;

  begin
    v_tenant_id:=nullif(btrim(p_filters->>'tenantId'),'')::uuid;
    v_assignee_id:=nullif(btrim(p_filters->>'assigneeSubjectId'),'')::uuid;
  exception when invalid_text_representation then
    raise exception 'support_filters_invalid';
  end;

  if v_status is not null and v_status not in (
    'new','reviewing','approved','in_progress','done','rejected',
    'triage','waiting_tenant','waiting_external','resolved','closed','reopened'
  ) then raise exception 'support_status_invalid'; end if;
  if v_priority is not null and v_priority not in (
    'low','medium','high','urgent'
  ) then raise exception 'support_priority_invalid'; end if;
  if v_module_key is not null
     and v_module_key !~ '^[a-z][a-z0-9_.-]{1,79}$' then
    raise exception 'support_module_invalid';
  end if;
  if v_queue not in (
    'all','new','unassigned','mine','urgent','at_risk','breached',
    'waiting_tenant'
  ) then raise exception 'support_queue_invalid'; end if;
  if (p_cursor_updated_at is null)<>(p_cursor_id is null) then
    raise exception 'support_cursor_invalid';
  end if;

  if p_ticket_id is not null then
    if not exists(
      select 1 from core.support_requests ticket
      where ticket.id=p_ticket_id and ticket.tenant_id is not null
    ) then raise exception 'support_ticket_not_found'; end if;
    v_ids:=array[p_ticket_id];
  else
    select coalesce(array_agg(candidate.id order by candidate.updated_at desc,candidate.id desc),'{}'::uuid[])
    into v_ids
    from (
      select ticket.id,ticket.updated_at
      from core.support_requests ticket
      where ticket.tenant_id is not null
        and (v_tenant_id is null or ticket.tenant_id=v_tenant_id)
        and (v_status is null or ticket.status=v_status)
        and (v_priority is null or ticket.priority=v_priority)
        and (v_module_key is null or ticket.module_key=v_module_key)
        and (
          v_assignee_id is null
          or ticket.assigned_to_platform_subject_id=v_assignee_id
        )
        and (
          v_search is null
          or to_tsvector(
            'simple',coalesce(ticket.title,'')||' '
              ||coalesce(ticket.description,'')||' '
              ||coalesce(ticket.requester_name_snapshot,'')||' '
              ||coalesce(ticket.requester_email_snapshot,'')
          ) @@ plainto_tsquery('simple',v_search)
          or ticket.ticket_number::text like '%'||v_search||'%'
        )
        and (
          v_queue='all'
          or (
            v_queue='new'
            and ticket.status in ('new','triage','reopened')
          )
          or (
            v_queue='unassigned'
            and ticket.assigned_to_platform_subject_id is null
            and ticket.status not in ('resolved','closed','done','rejected')
          )
          or (
            v_queue='mine'
            and ticket.assigned_to_platform_subject_id=v_subject_id
          )
          or (v_queue='urgent' and ticket.priority='urgent')
          or (v_queue='waiting_tenant' and ticket.status='waiting_tenant')
          or (
            v_queue='at_risk'
            and ticket.status not in ('resolved','closed','done','rejected')
            and (
              (
                ticket.first_response_at is null
                and ticket.first_response_due_at between now() and now()+interval '2 hours'
              )
              or (
                ticket.resolved_at is null
                and private_app.support_effective_resolution_due(
                  ticket.resolution_due_at,ticket.waiting_started_at
                ) between now() and now()+interval '2 hours'
              )
            )
          )
          or (
            v_queue='breached'
            and ticket.status not in ('resolved','closed','done','rejected')
            and (
              (
                ticket.first_response_at is null
                and ticket.first_response_due_at<now()
              )
              or (
                ticket.resolved_at is null
                and private_app.support_effective_resolution_due(
                  ticket.resolution_due_at,ticket.waiting_started_at
                )<now()
              )
            )
          )
        )
        and (
          p_cursor_updated_at is null
          or (ticket.updated_at,ticket.id)<(
            p_cursor_updated_at,p_cursor_id
          )
        )
      order by ticket.updated_at desc,ticket.id desc
      limit v_page_size+1
    ) candidate;
    v_has_more:=coalesce(cardinality(v_ids),0)>v_page_size;
    if v_has_more then v_ids:=v_ids[1:v_page_size]; end if;
  end if;

  select coalesce(jsonb_agg(
    private_app.support_ticket_document(
      member.id,p_ticket_id is not null,true,v_subject_id
    ) order by member.position
  ),'[]'::jsonb)
  into v_tickets
  from unnest(v_ids) with ordinality member(id,position);

  if cardinality(v_ids)>0 and p_ticket_id is null then
    v_last_id:=v_ids[cardinality(v_ids)];
    select jsonb_build_object('updatedAt',ticket.updated_at,'id',ticket.id)
    into v_next_cursor
    from core.support_requests ticket
    where ticket.id=v_last_id;
    if not v_has_more then v_next_cursor:=null; end if;
  end if;

  select jsonb_build_object(
    'total',count(*),
    'new',count(*) filter (
      where ticket.status in ('new','triage','reopened')
    ),
    'open',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
    ),
    'unassigned',count(*) filter (
      where ticket.assigned_to_platform_subject_id is null
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'mine',count(*) filter (
      where ticket.assigned_to_platform_subject_id=v_subject_id
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'urgent',count(*) filter (
      where ticket.priority='urgent'
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'dueSoon',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
        and (
          (
            ticket.first_response_at is null
            and ticket.first_response_due_at between now() and now()+interval '2 hours'
          )
          or (
            ticket.resolved_at is null
            and private_app.support_effective_resolution_due(
              ticket.resolution_due_at,ticket.waiting_started_at
            ) between now() and now()+interval '2 hours'
          )
        )
    ),
    'overdue',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
        and (
          (
            ticket.first_response_at is null
            and ticket.first_response_due_at<now()
          )
          or (
            ticket.resolved_at is null
            and private_app.support_effective_resolution_due(
              ticket.resolution_due_at,ticket.waiting_started_at
            )<now()
          )
        )
    ),
    'breached',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
        and (
          (
            ticket.first_response_at is null
            and ticket.first_response_due_at<now()
          )
          or (
            ticket.resolved_at is null
            and private_app.support_effective_resolution_due(
              ticket.resolution_due_at,ticket.waiting_started_at
            )<now()
          )
        )
    ),
    'waitingTenant',count(*) filter (where ticket.status='waiting_tenant'),
    'resolved',count(*) filter (
      where ticket.status in ('resolved','closed','done')
    ),
    'unread',count(*) filter (where exists(
      select 1
      from core.support_messages message
      left join core.support_read_states read_state
        on read_state.tenant_id=message.tenant_id
       and read_state.ticket_id=message.ticket_id
       and read_state.subject_id=v_subject_id
      where message.tenant_id=ticket.tenant_id
        and message.ticket_id=ticket.id
        and message.author_subject_id is distinct from v_subject_id
        and message.created_at>coalesce(
          read_state.last_read_at,'epoch'::timestamptz
        )
    ))
  ) into v_summary
  from core.support_requests ticket
  where ticket.tenant_id is not null;

  select jsonb_build_object(
    'all',count(*),
    'new',count(*) filter (
      where ticket.status in ('new','triage','reopened')
    ),
    'unassigned',count(*) filter (
      where ticket.assigned_to_platform_subject_id is null
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'mine',count(*) filter (
      where ticket.assigned_to_platform_subject_id=v_subject_id
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'urgent',count(*) filter (
      where ticket.priority='urgent'
        and ticket.status not in ('resolved','closed','done','rejected')
    ),
    'at_risk',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
        and (
          (
            ticket.first_response_at is null
            and ticket.first_response_due_at between now() and now()+interval '2 hours'
          )
          or (
            ticket.resolved_at is null
            and private_app.support_effective_resolution_due(
              ticket.resolution_due_at,ticket.waiting_started_at
            ) between now() and now()+interval '2 hours'
          )
        )
    ),
    'breached',count(*) filter (
      where ticket.status not in ('resolved','closed','done','rejected')
        and (
          (
            ticket.first_response_at is null
            and ticket.first_response_due_at<now()
          )
          or (
            ticket.resolved_at is null
            and private_app.support_effective_resolution_due(
              ticket.resolution_due_at,ticket.waiting_started_at
            )<now()
          )
        )
    ),
    'waiting_tenant',count(*) filter (
      where ticket.status='waiting_tenant'
    )
  ) into v_queues
  from core.support_requests ticket
  where ticket.tenant_id is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'subjectId',agent.id,
    'name',agent.full_name,
    'email',agent.email,
    'canManage',private_app.support_subject_has_platform_permission(
      agent.id,'platform.support.manage'
    )
  ) order by agent.full_name,agent.id),'[]'::jsonb)
  into v_agents
  from access_control.subjects agent
  where agent.status='active'
    and not agent.must_change_password
    and (
      private_app.support_subject_has_platform_permission(
        agent.id,'platform.support.reply'
      )
      or private_app.support_subject_has_platform_permission(
        agent.id,'platform.support.manage'
      )
    );

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',tenant.id,'name',tenant.name,'slug',tenant.slug,
    'status',tenant.status
  ) order by tenant.name,tenant.id),'[]'::jsonb)
  into v_tenants
  from core.tenants tenant
  where exists(
      select 1
      from core.support_requests ticket
      where ticket.tenant_id=tenant.id
    );

  return jsonb_build_object(
    'schemaVersion',3,
    'generatedAt',now(),
    'viewer',jsonb_build_object(
      'scope','platform','subjectId',v_subject_id,
      'canRead',v_can_read,'canReply',v_can_reply,'canManage',v_can_manage
    ),
    'filters',jsonb_strip_nulls(jsonb_build_object(
      'tenantId',v_tenant_id,'status',v_status,'priority',v_priority,
      'moduleKey',v_module_key,'assigneeSubjectId',v_assignee_id,
      'queue',v_queue,'search',v_search
    )),
    'summary',v_summary,
    'queues',v_queues,
    'agents',v_agents,
    'tenants',v_tenants,
    'page',jsonb_build_object(
      'pageSize',v_page_size,'hasMore',v_has_more,
      'nextCursor',v_next_cursor
    ),
    'tickets',v_tickets
  );
end;
$$;

revoke all on function public.v3_platform_support_snapshot(
  uuid,jsonb,integer,timestamptz,uuid
) from public,anon,authenticated,service_role;
grant execute on function public.v3_platform_support_snapshot(
  uuid,jsonb,integer,timestamptz,uuid
) to authenticated;

create or replace function private_app.support_mark_read(
  p_tenant_id uuid,
  p_ticket_id uuid,
  p_subject_id uuid,
  p_reader_scope text
)
returns void
language plpgsql
security definer
set search_path=''
as $$
begin
  insert into core.support_read_states(
    tenant_id,ticket_id,subject_id,reader_scope,last_read_at,updated_at
  ) values (
    p_tenant_id,p_ticket_id,p_subject_id,p_reader_scope,now(),now()
  )
  on conflict(tenant_id,ticket_id,subject_id) do update
  set last_read_at=greatest(
        core.support_read_states.last_read_at,excluded.last_read_at
      ),
      reader_scope=excluded.reader_scope,
      updated_at=now();
end;
$$;

revoke all on function private_app.support_mark_read(uuid,uuid,uuid,text)
from public,anon,authenticated,service_role;

create or replace function private_app.support_mark_read_at(
  p_tenant_id uuid,
  p_ticket_id uuid,
  p_subject_id uuid,
  p_reader_scope text,
  p_last_seen_at timestamptz
)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  v_watermark timestamptz:=least(
    coalesce(p_last_seen_at,now()),clock_timestamp()
  );
begin
  insert into core.support_read_states(
    tenant_id,ticket_id,subject_id,reader_scope,last_read_at,updated_at
  ) values (
    p_tenant_id,p_ticket_id,p_subject_id,p_reader_scope,v_watermark,now()
  )
  on conflict(tenant_id,ticket_id,subject_id) do update
  set last_read_at=greatest(
        core.support_read_states.last_read_at,excluded.last_read_at
      ),
      reader_scope=excluded.reader_scope,
      updated_at=now();
end;
$$;

revoke all on function private_app.support_mark_read_at(
  uuid,uuid,uuid,text,timestamptz
) from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_support_action(
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
  v_ticket core.support_requests%rowtype;
  v_subject access_control.subjects%rowtype;
  v_staff people.staff_profiles%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_role_key text;
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_client_request_id text;
  v_request_hash text;
  v_ticket_id uuid;
  v_message_id uuid;
  v_existing_message core.support_messages%rowtype;
  v_existing_event core.support_events%rowtype;
  v_expected_version integer;
  v_title text;
  v_description text;
  v_content text;
  v_note text;
  v_priority text;
  v_module_key text;
  v_impact text;
  v_diagnostics jsonb:='{}'::jsonb;
  v_previous_status text;
  v_now timestamptz:=clock_timestamp();
  v_last_seen_at timestamptz;
begin
  if coalesce(jsonb_typeof(p_payload),'object')<>'object' then
    raise exception 'support_payload_invalid';
  end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.support_is_active_tenant_member(v_tenant.id)
     or v_subject_id is null then
    raise exception 'forbidden';
  end if;

  select subject.* into v_subject
  from access_control.subjects subject
  where subject.id=v_subject_id;
  select staff.* into v_staff
  from people.staff_profiles staff
  where staff.id=private_app.current_staff_id(v_tenant.id);
  select role.role_key into v_role_key
  from access_control.memberships membership
  join access_control.membership_roles membership_role
    on membership_role.membership_id=membership.id
  join access_control.roles role
    on role.id=membership_role.role_id
   and role.scope='tenant'
  where membership.subject_id=v_subject_id
    and membership.tenant_id=v_tenant.id
    and membership.scope='tenant'
    and membership.status='active'
  order by private_app.tenant_role_rank(role.role_key) desc,role.role_key
  limit 1;

  if v_action='create_ticket' then
    v_client_request_id:=private_app.support_validate_client_request_id(
      p_payload->>'clientRequestId'
    );
    v_title:=btrim(coalesce(p_payload->>'title',''));
    v_description:=btrim(coalesce(p_payload->>'description',''));
    v_priority:=lower(btrim(coalesce(p_payload->>'priority','medium')));
    v_module_key:=lower(btrim(coalesce(p_payload->>'moduleKey','')));
    v_impact:=lower(btrim(coalesce(p_payload->>'impact','minor')));
    v_diagnostics:=coalesce(p_payload->'diagnostics','{}'::jsonb);
    if char_length(v_title) not between 3 and 240 then
      raise exception 'support_title_invalid';
    end if;
    if char_length(v_description) not between 3 and 12000 then
      raise exception 'support_description_invalid';
    end if;
    if v_priority not in ('low','medium','high','urgent') then
      raise exception 'support_priority_invalid';
    end if;
    if v_module_key !~ '^[a-z][a-z0-9_.-]{1,79}$' then
      raise exception 'support_module_invalid';
    end if;
    if v_impact not in (
      'blocked','multiple_users','single_user','minor','question','security',
      'partial','major','blocking'
    ) then raise exception 'support_impact_invalid'; end if;
    if jsonb_typeof(v_diagnostics)<>'object' then
      raise exception 'support_diagnostics_invalid';
    end if;
    v_diagnostics:=jsonb_strip_nulls(jsonb_build_object(
      'reproductionSteps',nullif(left(btrim(coalesce(
        v_diagnostics->>'reproductionSteps',''
      )),8000),''),
      'expectedResult',nullif(left(btrim(coalesce(
        v_diagnostics->>'expectedResult',''
      )),5000),''),
      'actualResult',nullif(left(btrim(coalesce(
        v_diagnostics->>'actualResult',''
      )),5000),''),
      'sourceUrl',nullif(left(regexp_replace(btrim(coalesce(
        v_diagnostics->>'sourceUrl',''
      )),'[?#].*$',''),1000),''),
      'browserContext',case
        when jsonb_typeof(v_diagnostics->'browserContext')='object' then
          jsonb_strip_nulls(jsonb_build_object(
            'appVersion',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,appVersion}',''
            )),120),''),
            'route',nullif(left(regexp_replace(btrim(coalesce(
              v_diagnostics#>>'{browserContext,route}',''
            )),'[?#].*$',''),500),''),
            'browser',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,browser}',''
            )),120),''),
            'operatingSystem',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,operatingSystem}',''
            )),120),''),
            'locale',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,locale}',''
            )),40),''),
            'timezone',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,timezone}',''
            )),80),''),
            'userAgent',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,userAgent}',''
            )),500),''),
            'platform',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,platform}',''
            )),100),''),
            'viewport',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,viewport}',''
            )),80),''),
            'screen',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,screen}',''
            )),80),''),
            'language',nullif(left(btrim(coalesce(
              v_diagnostics#>>'{browserContext,language}',''
            )),40),''),
            'online',case
              when jsonb_typeof(
                v_diagnostics#>'{browserContext,online}'
              )='boolean' then v_diagnostics#>'{browserContext,online}'
              else null
            end
          ))
        else null
      end
    ));
    if octet_length(v_diagnostics::text)>32768 then
      raise exception 'support_diagnostics_too_large';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'title',v_title,'description',v_description,'priority',v_priority,
      'moduleKey',v_module_key,'impact',v_impact,
      'diagnostics',v_diagnostics
    ));

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:support:create:'||v_tenant.id::text||':'||v_client_request_id,0
      )
    );
    v_now:=clock_timestamp();
    select ticket.* into v_ticket
    from core.support_requests ticket
    where ticket.tenant_id=v_tenant.id
      and ticket.idempotency_key=v_client_request_id;
    if v_ticket.id is not null then
      if v_ticket.requested_by_subject_id is distinct from v_subject_id then
        raise exception 'support_idempotency_conflict';
      end if;
      if v_ticket.idempotency_hash is distinct from v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      select message.id into v_message_id
      from core.support_messages message
      where message.tenant_id=v_ticket.tenant_id
        and message.ticket_id=v_ticket.id
        and message.client_request_id=v_client_request_id||':initial';
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,
        'reference',private_app.support_reference(
          v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
        ),
        'messageId',v_message_id,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:support:rate:create:'||v_tenant.id::text||':'
          ||v_subject_id::text,0
      )
    );
    if (
      select count(*)
      from core.support_requests recent
      where recent.tenant_id=v_tenant.id
        and recent.requested_by_subject_id=v_subject_id
        and recent.created_at>v_now-interval '1 hour'
    )>=10 then raise exception 'support_rate_limit_exceeded'; end if;

    v_ticket_id:=extensions.gen_random_uuid();
    v_message_id:=extensions.gen_random_uuid();
    insert into core.support_requests(
      id,tenant_id,requested_by_subject_id,category,title,description,
      priority,status,workflow_version,version,idempotency_key,
      idempotency_hash,requester_staff_id,requester_name_snapshot,
      requester_email_snapshot,requester_role_key_snapshot,
      requester_job_title_snapshot,module_key,impact,diagnostics,
      first_response_due_at,resolution_due_at,last_message_at,
      created_at,updated_at
    ) values (
      v_ticket_id,v_tenant.id,v_subject_id,'support',v_title,v_description,
      v_priority,'new',1,1,v_client_request_id,v_request_hash,v_staff.id,
      v_subject.full_name,lower(v_subject.email),v_role_key,v_staff.job_title,
      v_module_key,v_impact,v_diagnostics,
      v_now+private_app.support_response_interval(v_priority,v_impact),
      v_now+private_app.support_resolution_interval(v_priority,v_impact),
      v_now,v_now,v_now
    ) returning * into v_ticket;

    insert into core.support_messages(
      id,tenant_id,ticket_id,author_scope,author_subject_id,
      author_staff_id,author_name_snapshot,author_email_snapshot,
      author_role_key_snapshot,author_job_title_snapshot,content,is_internal,
      client_request_id,request_hash,created_at
    ) values (
      v_message_id,v_tenant.id,v_ticket.id,'tenant',v_subject_id,v_staff.id,
      v_subject.full_name,lower(v_subject.email),v_role_key,v_staff.job_title,
      v_description,false,v_client_request_id||':initial',v_request_hash,v_now
    );
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,to_status,visibility,client_request_id,request_hash,
      metadata,created_at
    ) values (
      v_tenant.id,v_ticket.id,1,'ticket.created','tenant',v_subject_id,
      'new','tenant',v_client_request_id,v_request_hash,
      jsonb_build_object(
        'priority',v_priority,'moduleKey',v_module_key,'impact',v_impact
      ),v_now
    );
    perform private_app.support_mark_read(
      v_tenant.id,v_ticket.id,v_subject_id,'tenant'
    );
    perform private_app.write_audit(
      'support.ticket.created','support_request',v_ticket.id::text,
      v_tenant.id,jsonb_build_object(
        'ticketNumber',v_ticket.ticket_number,'version',1,
        'status','new','moduleKey',v_module_key,'priority',v_priority
      )
    );
    return jsonb_build_object(
      'success',true,'idempotent',false,'ticketId',v_ticket.id,
      'ticketNumber',v_ticket.ticket_number,
      'reference',private_app.support_reference(
        v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
      ),
      'messageId',v_message_id,'version',v_ticket.version,
      'status',v_ticket.status
    );
  end if;

  begin
    v_ticket_id:=(p_payload->>'ticketId')::uuid;
  exception when invalid_text_representation then
    raise exception 'support_ticket_invalid';
  end;
  if v_ticket_id is null
     or not private_app.support_tenant_can_read_ticket(
       v_tenant.id,v_ticket_id
     ) then raise exception 'support_ticket_not_found'; end if;

  if v_action='mark_read' then
    begin
      v_last_seen_at:=nullif(
        btrim(coalesce(
          p_payload->>'readThrough',p_payload->>'lastSeenAt',''
        )),''
      )::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'support_read_watermark_invalid';
    end;
    perform private_app.support_mark_read_at(
      v_tenant.id,v_ticket_id,v_subject_id,'tenant',
      coalesce(v_last_seen_at,now())
    );
    select ticket.* into v_ticket
    from core.support_requests ticket
    where ticket.id=v_ticket_id and ticket.tenant_id=v_tenant.id;
    return jsonb_build_object(
      'success',true,'idempotent',true,'ticketId',v_ticket.id,
      'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
      'status',v_ticket.status
    );
  end if;

  if v_action not in ('add_message','reopen_ticket','close_ticket') then
    raise exception 'support_tenant_action_invalid';
  end if;
  v_client_request_id:=private_app.support_validate_client_request_id(
    p_payload->>'clientRequestId'
  );
  if coalesce(p_payload->>'expectedVersion','')!~'^[1-9][0-9]{0,9}$' then
    raise exception 'support_expected_version_invalid';
  end if;
  begin
    v_expected_version:=(p_payload->>'expectedVersion')::integer;
  exception when numeric_value_out_of_range then
    raise exception 'support_expected_version_invalid';
  end;

  select ticket.* into v_ticket
  from core.support_requests ticket
  where ticket.id=v_ticket_id and ticket.tenant_id=v_tenant.id
  for update;
  if v_ticket.id is null then raise exception 'support_ticket_not_found'; end if;
  if v_ticket.requested_by_subject_id is distinct from v_subject_id then
    raise exception 'forbidden';
  end if;
  v_now:=clock_timestamp();
  v_previous_status:=v_ticket.status;

  if v_action='add_message' then
    v_content:=btrim(coalesce(p_payload->>'content',''));
    if char_length(v_content) not between 1 and 12000 then
      raise exception 'support_message_invalid';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,'content',v_content
    ));
    select message.* into v_existing_message
    from core.support_messages message
    where message.tenant_id=v_tenant.id
      and message.ticket_id=v_ticket.id
      and message.client_request_id=v_client_request_id;
    if v_existing_message.id is not null then
      if v_existing_message.request_hash<>v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,
        'messageId',v_existing_message.id,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:support:rate:message:'||v_subject_id::text,0
      )
    );
    if (
      select count(*)
      from core.support_messages recent
      where recent.author_subject_id=v_subject_id
        and recent.created_at>v_now-interval '10 minutes'
    )>=30 then raise exception 'support_rate_limit_exceeded'; end if;
    if v_ticket.status in ('resolved','closed','done','rejected') then
      raise exception 'support_ticket_requires_reopen';
    end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;
    v_message_id:=extensions.gen_random_uuid();
    insert into core.support_messages(
      id,tenant_id,ticket_id,author_scope,author_subject_id,
      author_staff_id,author_name_snapshot,author_email_snapshot,
      author_role_key_snapshot,author_job_title_snapshot,content,is_internal,
      client_request_id,request_hash,created_at
    ) values (
      v_message_id,v_tenant.id,v_ticket.id,'tenant',v_subject_id,v_staff.id,
      v_subject.full_name,lower(v_subject.email),v_role_key,v_staff.job_title,
      v_content,false,v_client_request_id,v_request_hash,v_now
    );
    update core.support_requests ticket
    set version=ticket.version+1,
        status=case when ticket.status='waiting_tenant'
          then 'in_progress' else ticket.status end,
        waiting_total_seconds=ticket.waiting_total_seconds+case
          when ticket.status='waiting_tenant' and ticket.waiting_started_at is not null
            then greatest(0,floor(extract(epoch from (v_now-ticket.waiting_started_at)))::bigint)
          else 0 end,
        waiting_started_at=case when ticket.status='waiting_tenant'
          then null else ticket.waiting_started_at end,
        resolution_due_at=case
          when ticket.status='waiting_tenant'
           and ticket.waiting_started_at is not null
           and ticket.resolution_due_at is not null
            then ticket.resolution_due_at+(v_now-ticket.waiting_started_at)
          else ticket.resolution_due_at
        end,
        last_message_at=v_now,
        updated_at=v_now
    where ticket.id=v_ticket.id
      and ticket.tenant_id=v_tenant.id
      and ticket.version=v_expected_version
    returning * into v_ticket;
    if not found then raise exception 'support_ticket_conflict'; end if;
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,from_status,to_status,visibility,
      client_request_id,request_hash,metadata,created_at
    ) values (
      v_tenant.id,v_ticket.id,v_ticket.version,'message.created','tenant',
      v_subject_id,v_previous_status,v_ticket.status,'tenant',
      v_client_request_id,v_request_hash,'{}'::jsonb,v_now
    );
  elsif v_action='reopen_ticket' then
    v_content:=btrim(coalesce(p_payload->>'reason',''));
    if char_length(v_content) not between 3 and 4000 then
      raise exception 'support_reopen_reason_required';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,'reason',v_content
    ));
    select event.* into v_existing_event
    from core.support_events event
    where event.tenant_id=v_tenant.id
      and event.ticket_id=v_ticket.id
      and event.client_request_id=v_client_request_id;
    if v_existing_event.id is not null then
      if v_existing_event.request_hash<>v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    if v_ticket.status not in ('resolved','closed','done') then
      raise exception 'support_ticket_reopen_not_allowed';
    end if;
    if coalesce(
      v_ticket.closed_at,v_ticket.resolved_at,v_ticket.updated_at
    )<v_now-interval '14 days' then
      raise exception 'support_reopen_window_expired';
    end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;
    v_message_id:=extensions.gen_random_uuid();
    insert into core.support_messages(
      id,tenant_id,ticket_id,author_scope,author_subject_id,
      author_staff_id,author_name_snapshot,author_email_snapshot,
      author_role_key_snapshot,author_job_title_snapshot,content,is_internal,
      client_request_id,request_hash,created_at
    ) values (
      v_message_id,v_tenant.id,v_ticket.id,'tenant',v_subject_id,v_staff.id,
      v_subject.full_name,lower(v_subject.email),v_role_key,v_staff.job_title,
      v_content,false,v_client_request_id||':message',v_request_hash,v_now
    );
    update core.support_requests ticket
    set version=ticket.version+1,status='reopened',reopened_at=v_now,
        reopen_count=ticket.reopen_count+1,resolved_at=null,closed_at=null,
        resolution_summary=null,waiting_started_at=null,
        waiting_total_seconds=0,
        resolution_due_at=v_now+private_app.support_resolution_interval(
          ticket.priority,ticket.impact
        ),
        last_message_at=v_now,updated_at=v_now
    where ticket.id=v_ticket.id and ticket.tenant_id=v_tenant.id
      and ticket.version=v_expected_version
    returning * into v_ticket;
    if not found then raise exception 'support_ticket_conflict'; end if;
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,from_status,to_status,visibility,
      client_request_id,request_hash,metadata,created_at
    ) values (
      v_tenant.id,v_ticket.id,v_ticket.version,'ticket.reopened','tenant',
      v_subject_id,v_previous_status,'reopened','tenant',
      v_client_request_id,v_request_hash,'{}'::jsonb,v_now
    );
  else
    v_note:=nullif(btrim(coalesce(p_payload->>'note','')),'');
    if v_note is not null and char_length(v_note) not between 3 and 4000 then
      raise exception 'support_close_note_invalid';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,'note',v_note
    ));
    select event.* into v_existing_event
    from core.support_events event
    where event.tenant_id=v_tenant.id
      and event.ticket_id=v_ticket.id
      and event.client_request_id=v_client_request_id;
    if v_existing_event.id is not null then
      if v_existing_event.request_hash<>v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    if v_ticket.status not in ('resolved','done') then
      raise exception 'support_ticket_close_requires_resolution';
    end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;
    if v_note is not null then
      v_message_id:=extensions.gen_random_uuid();
      insert into core.support_messages(
        id,tenant_id,ticket_id,author_scope,author_subject_id,
        author_staff_id,author_name_snapshot,author_email_snapshot,
        author_role_key_snapshot,author_job_title_snapshot,content,is_internal,
        client_request_id,request_hash,created_at
      ) values (
        v_message_id,v_tenant.id,v_ticket.id,'tenant',v_subject_id,v_staff.id,
        v_subject.full_name,lower(v_subject.email),v_role_key,v_staff.job_title,
        v_note,false,v_client_request_id||':message',v_request_hash,v_now
      );
    end if;
    update core.support_requests ticket
    set version=ticket.version+1,status='closed',closed_at=v_now,
        waiting_total_seconds=ticket.waiting_total_seconds+case
          when ticket.waiting_started_at is not null
            then greatest(0,floor(extract(epoch from (v_now-ticket.waiting_started_at)))::bigint)
          else 0 end,
        waiting_started_at=null,
        last_message_at=case when v_note is null
          then ticket.last_message_at else v_now end,
        updated_at=v_now
    where ticket.id=v_ticket.id and ticket.tenant_id=v_tenant.id
      and ticket.version=v_expected_version
    returning * into v_ticket;
    if not found then raise exception 'support_ticket_conflict'; end if;
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,from_status,to_status,visibility,
      client_request_id,request_hash,metadata,created_at
    ) values (
      v_tenant.id,v_ticket.id,v_ticket.version,'ticket.closed','tenant',
      v_subject_id,v_previous_status,'closed','tenant',
      v_client_request_id,v_request_hash,'{}'::jsonb,v_now
    );
  end if;

  perform private_app.support_mark_read(
    v_tenant.id,v_ticket.id,v_subject_id,'tenant'
  );
  perform private_app.write_audit(
    'support.tenant.'||v_action,'support_request',v_ticket.id::text,
    v_tenant.id,jsonb_build_object(
      'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
      'fromStatus',v_previous_status,'toStatus',v_ticket.status
    )
  );
  return jsonb_strip_nulls(jsonb_build_object(
    'success',true,'idempotent',false,'ticketId',v_ticket.id,
    'ticketNumber',v_ticket.ticket_number,
    'reference',private_app.support_reference(
      v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
    ),
    'messageId',v_message_id,'version',v_ticket.version,
    'status',v_ticket.status
  ));
end;
$$;

revoke all on function public.v3_tenant_support_action(text,text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_support_action(text,text,jsonb)
to authenticated;

create or replace function public.v3_platform_support_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subject access_control.subjects%rowtype;
  v_ticket core.support_requests%rowtype;
  v_existing_event core.support_events%rowtype;
  v_existing_message core.support_messages%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_action text:=lower(btrim(coalesce(p_action,'')));
  v_ticket_id uuid;
  v_message_id uuid;
  v_assignee_id uuid;
  v_expected_version integer;
  v_client_request_id text;
  v_request_hash text;
  v_content text;
  v_new_status text;
  v_new_priority text;
  v_new_module_key text;
  v_new_impact text;
  v_resolution_summary text;
  v_previous_status text;
  v_now timestamptz:=clock_timestamp();
  v_is_internal boolean:=false;
  v_has_status boolean:=false;
  v_has_priority boolean:=false;
  v_has_module boolean:=false;
  v_has_impact boolean:=false;
  v_has_resolution boolean:=false;
  v_has_assignee boolean:=false;
  v_last_seen_at timestamptz;
begin
  if coalesce(jsonb_typeof(p_payload),'object')<>'object' then
    raise exception 'support_payload_invalid';
  end if;
  if v_subject_id is null
     or not private_app.support_platform_can_read() then
    raise exception 'forbidden';
  end if;
  select subject.* into v_subject
  from access_control.subjects subject
  where subject.id=v_subject_id
    and subject.status='active'
    and not subject.must_change_password;
  if v_subject.id is null then raise exception 'forbidden'; end if;

  begin
    v_ticket_id:=(p_payload->>'ticketId')::uuid;
  exception when invalid_text_representation then
    raise exception 'support_ticket_invalid';
  end;
  if v_ticket_id is null then raise exception 'support_ticket_invalid'; end if;

  if v_action='mark_read' then
    select ticket.* into v_ticket
    from core.support_requests ticket
    where ticket.id=v_ticket_id and ticket.tenant_id is not null;
    if v_ticket.id is null then raise exception 'support_ticket_not_found'; end if;
    begin
      v_last_seen_at:=nullif(
        btrim(coalesce(
          p_payload->>'readThrough',p_payload->>'lastSeenAt',''
        )),''
      )::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception 'support_read_watermark_invalid';
    end;
    perform private_app.support_mark_read_at(
      v_ticket.tenant_id,v_ticket.id,v_subject_id,'platform',
      coalesce(v_last_seen_at,now())
    );
    return jsonb_build_object(
      'success',true,'idempotent',true,'ticketId',v_ticket.id,
      'ticketNumber',v_ticket.ticket_number,
      'reference',private_app.support_reference(
        v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
      ),
      'version',v_ticket.version,'status',v_ticket.status
    );
  end if;

  if v_action not in (
    'add_message','add_internal_note','assign_ticket','update_ticket'
  ) then raise exception 'support_platform_action_invalid'; end if;
  if v_action='assign_ticket' then
    if not private_app.has_platform_permission('platform.support.manage') then
      raise exception 'forbidden';
    end if;
  elsif not private_app.support_platform_can_reply() then
    raise exception 'forbidden';
  end if;

  v_client_request_id:=private_app.support_validate_client_request_id(
    p_payload->>'clientRequestId'
  );
  if coalesce(p_payload->>'expectedVersion','')!~'^[1-9][0-9]{0,9}$' then
    raise exception 'support_expected_version_invalid';
  end if;
  begin
    v_expected_version:=(p_payload->>'expectedVersion')::integer;
  exception when numeric_value_out_of_range then
    raise exception 'support_expected_version_invalid';
  end;

  select ticket.* into v_ticket
  from core.support_requests ticket
  where ticket.id=v_ticket_id and ticket.tenant_id is not null
  for update;
  if v_ticket.id is null then raise exception 'support_ticket_not_found'; end if;
  v_now:=clock_timestamp();
  v_previous_status:=v_ticket.status;

  if v_action in ('add_message','add_internal_note') then
    v_is_internal:=v_action='add_internal_note';
    v_content:=btrim(coalesce(p_payload->>'content',''));
    if char_length(v_content) not between 1 and 12000 then
      raise exception 'support_message_invalid';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,'content',v_content
    ));
    select message.* into v_existing_message
    from core.support_messages message
    where message.tenant_id=v_ticket.tenant_id
      and message.ticket_id=v_ticket.id
      and message.client_request_id=v_client_request_id;
    if v_existing_message.id is not null then
      if v_existing_message.request_hash is distinct from v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,
        'reference',private_app.support_reference(
          v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
        ),
        'messageId',v_existing_message.id,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'odeir:support:rate:message:'||v_subject_id::text,0
      )
    );
    if (
      select count(*)
      from core.support_messages recent
      where recent.author_subject_id=v_subject_id
        and recent.created_at>v_now-interval '10 minutes'
    )>=120 then raise exception 'support_rate_limit_exceeded'; end if;
    if not v_is_internal
       and v_ticket.status in ('resolved','closed','done','rejected') then
      raise exception 'support_ticket_requires_reopen';
    end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;

    v_message_id:=extensions.gen_random_uuid();
    insert into core.support_messages(
      id,tenant_id,ticket_id,author_scope,author_subject_id,
      author_name_snapshot,author_email_snapshot,author_role_key_snapshot,
      content,is_internal,client_request_id,request_hash,created_at
    ) values (
      v_message_id,v_ticket.tenant_id,v_ticket.id,'platform',v_subject_id,
      v_subject.full_name,lower(v_subject.email),
      case when private_app.has_platform_permission('platform.support.manage')
        then 'platform_support_manager' else 'platform_support_agent' end,
      v_content,v_is_internal,v_client_request_id,v_request_hash,v_now
    );
    if v_is_internal then
      insert into core.support_events(
        tenant_id,ticket_id,ticket_version,event_type,actor_scope,
        actor_subject_id,from_status,to_status,visibility,
        client_request_id,request_hash,metadata,created_at
      ) values (
        v_ticket.tenant_id,v_ticket.id,v_ticket.version,'note.created',
        'platform',v_subject_id,v_previous_status,v_ticket.status,'platform',
        v_client_request_id,v_request_hash,'{}'::jsonb,v_now
      );
    else
      update core.support_requests ticket
      set version=ticket.version+1,
        status=case
          when ticket.status in ('new','triage','reopened','reviewing','approved')
            then 'in_progress'
          when ticket.status='waiting_external'
            then 'in_progress'
          else ticket.status
        end,
        first_response_at=coalesce(ticket.first_response_at,v_now),
        waiting_total_seconds=ticket.waiting_total_seconds+case
          when ticket.status='waiting_external'
           and ticket.waiting_started_at is not null
            then greatest(
              0,floor(extract(epoch from (v_now-ticket.waiting_started_at)))::bigint
            )
          else 0
        end,
        waiting_started_at=case
          when ticket.status='waiting_external' then null
          else ticket.waiting_started_at
        end,
        resolution_due_at=case
          when ticket.status='waiting_external'
           and ticket.waiting_started_at is not null
           and ticket.resolution_due_at is not null
            then ticket.resolution_due_at+(v_now-ticket.waiting_started_at)
          else ticket.resolution_due_at
        end,
        last_message_at=v_now,
        updated_at=v_now
      where ticket.id=v_ticket.id
        and ticket.tenant_id=v_ticket.tenant_id
        and ticket.version=v_expected_version
      returning * into v_ticket;
      if not found then raise exception 'support_ticket_conflict'; end if;
      insert into core.support_events(
        tenant_id,ticket_id,ticket_version,event_type,actor_scope,
        actor_subject_id,from_status,to_status,visibility,
        client_request_id,request_hash,metadata,created_at
      ) values (
        v_ticket.tenant_id,v_ticket.id,v_ticket.version,'message.created',
        'platform',v_subject_id,v_previous_status,v_ticket.status,'tenant',
        v_client_request_id,v_request_hash,'{}'::jsonb,v_now
      );
    end if;

  elsif v_action='assign_ticket' then
    begin
      v_assignee_id:=nullif(btrim(p_payload->>'assigneeSubjectId'),'')::uuid;
    exception when invalid_text_representation then
      raise exception 'support_assignee_invalid';
    end;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,
      'assigneeSubjectId',v_assignee_id
    ));
    select event.* into v_existing_event
    from core.support_events event
    where event.tenant_id=v_ticket.tenant_id
      and event.ticket_id=v_ticket.id
      and event.client_request_id=v_client_request_id;
    if v_existing_event.id is not null then
      if v_existing_event.request_hash is distinct from v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    if v_assignee_id is not null and not (
      private_app.support_subject_has_platform_permission(
        v_assignee_id,'platform.support.reply'
      )
      or private_app.support_subject_has_platform_permission(
        v_assignee_id,'platform.support.manage'
      )
    ) then raise exception 'support_assignee_invalid'; end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;
    update core.support_requests ticket
    set assigned_to_platform_subject_id=v_assignee_id,
        version=ticket.version+1,updated_at=v_now
    where ticket.id=v_ticket.id
      and ticket.tenant_id=v_ticket.tenant_id
      and ticket.version=v_expected_version
    returning * into v_ticket;
    if not found then raise exception 'support_ticket_conflict'; end if;
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,from_status,to_status,visibility,
      client_request_id,request_hash,metadata,created_at
    ) values (
      v_ticket.tenant_id,v_ticket.id,v_ticket.version,'ticket.assigned',
      'platform',v_subject_id,v_previous_status,v_ticket.status,'platform',
      v_client_request_id,v_request_hash,
      jsonb_build_object('assigneeSubjectId',v_assignee_id),v_now
    );

  else
    v_has_status:=p_payload ? 'status';
    v_has_priority:=p_payload ? 'priority';
    v_has_module:=p_payload ? 'moduleKey';
    v_has_impact:=p_payload ? 'impact';
    v_has_resolution:=p_payload ? 'resolutionSummary';
    v_has_assignee:=p_payload ? 'assigneeSubjectId';
    if not (
      v_has_status or v_has_priority or v_has_module
      or v_has_impact or v_has_resolution or v_has_assignee
    ) then raise exception 'support_update_empty'; end if;
    if (v_has_priority or v_has_module or v_has_impact or v_has_assignee)
       and not private_app.has_platform_permission(
         'platform.support.manage'
       ) then raise exception 'forbidden'; end if;

    v_new_status:=case when v_has_status
      then lower(btrim(coalesce(p_payload->>'status','')))
      else v_ticket.status end;
    v_new_priority:=case when v_has_priority
      then lower(btrim(coalesce(p_payload->>'priority','')))
      else v_ticket.priority end;
    v_new_module_key:=case when v_has_module
      then lower(btrim(coalesce(p_payload->>'moduleKey','')))
      else v_ticket.module_key end;
    v_new_impact:=case when v_has_impact
      then lower(btrim(coalesce(p_payload->>'impact','')))
      else v_ticket.impact end;
    v_resolution_summary:=case when v_has_resolution
      then nullif(btrim(coalesce(p_payload->>'resolutionSummary','')),'')
      else v_ticket.resolution_summary end;
    if v_has_assignee then
      begin
        v_assignee_id:=nullif(
          btrim(p_payload->>'assigneeSubjectId'),'')::uuid;
      exception when invalid_text_representation then
        raise exception 'support_assignee_invalid';
      end;
    else
      v_assignee_id:=v_ticket.assigned_to_platform_subject_id;
    end if;

    if v_has_status and v_new_status not in (
      'new','triage','in_progress','waiting_tenant','waiting_external',
      'resolved','closed','reopened'
    ) then raise exception 'support_status_invalid'; end if;
    if v_new_priority not in ('low','medium','high','urgent') then
      raise exception 'support_priority_invalid';
    end if;
    if v_has_module and (
      v_new_module_key is null
      or v_new_module_key !~ '^[a-z][a-z0-9_.-]{1,79}$'
    ) then
      raise exception 'support_module_invalid';
    end if;
    if v_has_impact and v_new_impact not in (
      'blocked','multiple_users','single_user','minor','question','security',
      'partial','major','blocking'
    ) then raise exception 'support_impact_invalid'; end if;
    if v_resolution_summary is not null
       and char_length(v_resolution_summary) not between 3 and 4000 then
      raise exception 'support_resolution_invalid';
    end if;
    if v_new_status='resolved' and v_resolution_summary is null then
      raise exception 'support_resolution_required';
    end if;
    v_request_hash:=private_app.support_sha256(jsonb_build_object(
      'action',v_action,'ticketId',v_ticket.id,
      'hasStatus',v_has_status,
      'status',case when v_has_status then v_new_status end,
      'hasPriority',v_has_priority,
      'priority',case when v_has_priority then v_new_priority end,
      'hasModuleKey',v_has_module,
      'moduleKey',case when v_has_module then v_new_module_key end,
      'hasImpact',v_has_impact,
      'impact',case when v_has_impact then v_new_impact end,
      'hasResolutionSummary',v_has_resolution,
      'resolutionSummary',case when v_has_resolution
        then v_resolution_summary end,
      'hasAssigneeSubjectId',v_has_assignee,
      'assigneeSubjectId',case when v_has_assignee then v_assignee_id end
    ));
    select event.* into v_existing_event
    from core.support_events event
    where event.tenant_id=v_ticket.tenant_id
      and event.ticket_id=v_ticket.id
      and event.client_request_id=v_client_request_id;
    if v_existing_event.id is not null then
      if v_existing_event.request_hash is distinct from v_request_hash then
        raise exception 'support_idempotency_conflict';
      end if;
      return jsonb_build_object(
        'success',true,'idempotent',true,'ticketId',v_ticket.id,
        'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
        'status',v_ticket.status
      );
    end if;
    if v_has_assignee and v_assignee_id is not null and not (
      private_app.support_subject_has_platform_permission(
        v_assignee_id,'platform.support.reply'
      )
      or private_app.support_subject_has_platform_permission(
        v_assignee_id,'platform.support.manage'
      )
    ) then raise exception 'support_assignee_invalid'; end if;
    if v_ticket.status in ('resolved','closed','done','rejected')
       and v_new_status<>v_ticket.status
       and v_new_status<>'reopened'
       and not (
         v_ticket.status in ('resolved','done') and v_new_status='closed'
       ) then
      raise exception 'support_ticket_requires_reopen';
    end if;
    if v_new_status='reopened'
       and v_ticket.status not in ('resolved','closed','done') then
      raise exception 'support_ticket_reopen_not_allowed';
    end if;
    if v_new_status='closed'
       and v_ticket.status not in ('resolved','closed','done') then
      raise exception 'support_ticket_close_requires_resolution';
    end if;
    if v_ticket.version<>v_expected_version then
      raise exception 'support_ticket_conflict';
    end if;

    update core.support_requests ticket
    set status=v_new_status,
        priority=v_new_priority,
        module_key=v_new_module_key,
        impact=v_new_impact,
        assigned_to_platform_subject_id=case
          when v_has_assignee then v_assignee_id
          else ticket.assigned_to_platform_subject_id
        end,
        resolution_summary=case
          when v_new_status='reopened' then null
          else v_resolution_summary
        end,
        first_response_due_at=case
          when v_has_priority or v_has_impact then
            ticket.created_at+private_app.support_response_interval(
              v_new_priority,v_new_impact
            )
          else ticket.first_response_due_at
        end,
        resolution_due_at=case
          when v_new_status='reopened' then
            v_now+private_app.support_resolution_interval(
              v_new_priority,v_new_impact
            )
          when v_has_priority or v_has_impact then
            ticket.created_at+private_app.support_resolution_interval(
              v_new_priority,v_new_impact
            )
            +(ticket.waiting_total_seconds::double precision
              *interval '1 second')
            +case
              when ticket.status in ('waiting_tenant','waiting_external')
               and v_new_status not in ('waiting_tenant','waiting_external')
               and ticket.waiting_started_at is not null
                then v_now-ticket.waiting_started_at
              else interval '0 seconds'
            end
          when ticket.status in ('waiting_tenant','waiting_external')
           and v_new_status not in ('waiting_tenant','waiting_external')
           and ticket.waiting_started_at is not null
           and ticket.resolution_due_at is not null then
            ticket.resolution_due_at+(v_now-ticket.waiting_started_at)
          else ticket.resolution_due_at
        end,
        waiting_total_seconds=case
          when v_new_status='reopened' then 0
          else ticket.waiting_total_seconds+case
            when ticket.status in ('waiting_tenant','waiting_external')
             and v_new_status not in ('waiting_tenant','waiting_external')
             and ticket.waiting_started_at is not null
              then greatest(
                0,floor(extract(epoch from (
                  v_now-ticket.waiting_started_at
                )))::bigint
              )
            else 0
          end
        end,
        waiting_started_at=case
          when v_new_status in ('waiting_tenant','waiting_external')
           and ticket.status not in ('waiting_tenant','waiting_external')
            then v_now
          when v_new_status not in ('waiting_tenant','waiting_external')
            then null
          else ticket.waiting_started_at
        end,
        resolved_at=case
          when v_new_status in ('resolved','closed')
            then coalesce(ticket.resolved_at,v_now)
          when v_new_status='reopened' then null
          else ticket.resolved_at
        end,
        closed_at=case
          when v_new_status='closed' then coalesce(ticket.closed_at,v_now)
          when v_new_status='reopened' then null
          else ticket.closed_at
        end,
        reopened_at=case
          when v_new_status='reopened' then v_now else ticket.reopened_at end,
        reopen_count=ticket.reopen_count+case
          when v_new_status='reopened' and ticket.status<>'reopened' then 1
          else 0 end,
        version=ticket.version+1,updated_at=v_now
    where ticket.id=v_ticket.id
      and ticket.tenant_id=v_ticket.tenant_id
      and ticket.version=v_expected_version
    returning * into v_ticket;
    if not found then raise exception 'support_ticket_conflict'; end if;
    insert into core.support_events(
      tenant_id,ticket_id,ticket_version,event_type,actor_scope,
      actor_subject_id,from_status,to_status,visibility,
      client_request_id,request_hash,metadata,created_at
    ) values (
      v_ticket.tenant_id,v_ticket.id,v_ticket.version,'ticket.updated',
      'platform',v_subject_id,v_previous_status,v_ticket.status,'tenant',
      v_client_request_id,v_request_hash,
      jsonb_strip_nulls(jsonb_build_object(
        'priority',case when v_has_priority then v_new_priority end,
        'moduleKey',case when v_has_module then v_new_module_key end,
        'impact',case when v_has_impact then v_new_impact end,
        'assigneeSubjectId',case when v_has_assignee then v_assignee_id end
      )),v_now
    );
  end if;

  perform private_app.support_mark_read(
    v_ticket.tenant_id,v_ticket.id,v_subject_id,'platform'
  );
  perform private_app.write_audit(
    'support.platform.'||v_action,'support_request',v_ticket.id::text,
    v_ticket.tenant_id,jsonb_strip_nulls(jsonb_build_object(
      'ticketNumber',v_ticket.ticket_number,'version',v_ticket.version,
      'fromStatus',v_previous_status,'toStatus',v_ticket.status,
      'assigneeSubjectId',case when v_action='assign_ticket' or v_has_assignee
        then v_assignee_id end
    ))
  );
  return jsonb_strip_nulls(jsonb_build_object(
    'success',true,'idempotent',false,'ticketId',v_ticket.id,
    'ticketNumber',v_ticket.ticket_number,
    'reference',private_app.support_reference(
      v_ticket.ticket_number,v_ticket.created_at,v_ticket.id
    ),
    'messageId',v_message_id,'version',v_ticket.version,
    'status',v_ticket.status
  ));
end;
$$;

revoke all on function public.v3_platform_support_action(text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.v3_platform_support_action(text,jsonb)
to authenticated;

-- Private attachment storage.  The database issues every object path; clients
-- receive INSERT permission only, so an upload can never overwrite an object.
insert into storage.buckets(
  id,name,public,file_size_limit,allowed_mime_types
)
select
  'support-attachments','support-attachments',false,10485760,
  array[
    'image/png','image/jpeg','image/webp','image/gif',
    'application/pdf','text/plain'
  ]::text[]
where not exists(
  select 1 from storage.buckets bucket
  where bucket.id='support-attachments'
);

update storage.buckets bucket
set public=false,
    file_size_limit=10485760,
    allowed_mime_types=array[
      'image/png','image/jpeg','image/webp','image/gif',
      'application/pdf','text/plain'
    ]::text[]
where bucket.id='support-attachments';

create or replace function public.v3_support_storage_can_upload(
  p_object_path text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from core.support_attachments attachment
    where attachment.bucket_id='support-attachments'
      and attachment.object_path=p_object_path
      and attachment.state='pending'
      and attachment.expires_at>now()
      and attachment.uploaded_by_subject_id=private_app.current_subject_id()
  )
$$;

create or replace function public.v3_support_storage_can_read(
  p_object_path text
)
returns boolean
language sql
stable
security definer
set search_path=''
as $$
  select exists(
    select 1
    from core.support_attachments attachment
    join core.support_messages message
      on message.tenant_id=attachment.tenant_id
     and message.ticket_id=attachment.ticket_id
     and message.id=attachment.message_id
    where attachment.bucket_id='support-attachments'
      and attachment.object_path=p_object_path
      and attachment.state='ready'
      and (
        private_app.support_platform_can_read()
        or (
          not message.is_internal
          and private_app.support_tenant_can_read_ticket(
            attachment.tenant_id,attachment.ticket_id
          )
        )
      )
  )
$$;

revoke all on function public.v3_support_storage_can_upload(text)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_storage_can_upload(text)
to authenticated;
revoke all on function public.v3_support_storage_can_read(text)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_storage_can_read(text)
to authenticated;

drop policy if exists support_attachments_insert on storage.objects;
create policy support_attachments_insert
on storage.objects for insert to authenticated
with check (
  bucket_id='support-attachments'
  and public.v3_support_storage_can_upload(name)
);

drop policy if exists support_attachments_select on storage.objects;
create policy support_attachments_select
on storage.objects for select to authenticated
using (
  bucket_id='support-attachments'
  and public.v3_support_storage_can_read(name)
);

drop policy if exists support_attachments_update on storage.objects;
drop policy if exists support_attachments_delete on storage.objects;

create or replace function public.v3_support_attachment_upload_ticket(
  p_ticket_id uuid,
  p_message_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_client_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subject_id uuid:=private_app.current_subject_id();
  v_ticket core.support_requests%rowtype;
  v_message core.support_messages%rowtype;
  v_attachment core.support_attachments%rowtype;
  v_scope text;
  v_file_name text;
  v_mime_type text:=lower(btrim(coalesce(p_mime_type,'')));
  v_client_request_id text;
  v_request_hash text;
  v_attachment_id uuid;
  v_extension text;
  v_object_path text;
  v_object_exists boolean:=false;
  v_active_count integer;
  v_total_bytes bigint;
begin
  if v_subject_id is null or p_ticket_id is null or p_message_id is null then
    raise exception 'support_attachment_invalid';
  end if;
  v_client_request_id:=private_app.support_validate_client_request_id(
    p_client_request_id
  );
  v_file_name:=btrim(regexp_replace(
    coalesce(p_file_name,''),'[[:cntrl:]]','','g'
  ));
  if char_length(v_file_name) not between 1 and 240 then
    raise exception 'support_attachment_name_invalid';
  end if;
  if v_file_name~'[/\\]' then
    raise exception 'support_attachment_name_invalid';
  end if;
  if v_mime_type not in (
    'image/png','image/jpeg','image/webp','image/gif',
    'application/pdf','text/plain'
  ) then raise exception 'support_attachment_type_invalid'; end if;
  if not (
    (v_mime_type='image/png' and lower(v_file_name)~'\.png$')
    or (
      v_mime_type='image/jpeg'
      and lower(v_file_name)~'\.(jpg|jpeg)$'
    )
    or (v_mime_type='image/webp' and lower(v_file_name)~'\.webp$')
    or (v_mime_type='image/gif' and lower(v_file_name)~'\.gif$')
    or (v_mime_type='application/pdf' and lower(v_file_name)~'\.pdf$')
    or (v_mime_type='text/plain' and lower(v_file_name)~'\.txt$')
  ) then raise exception 'support_attachment_extension_mismatch'; end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760 then
    raise exception 'support_attachment_size_invalid';
  end if;

  select ticket.* into v_ticket
  from core.support_requests ticket
  where ticket.id=p_ticket_id
    and ticket.tenant_id is not null;
  select message.* into v_message
  from core.support_messages message
  where message.tenant_id=v_ticket.tenant_id
    and message.ticket_id=v_ticket.id
    and message.id=p_message_id;
  if v_ticket.id is null or v_message.id is null then
    raise exception 'support_message_not_found';
  end if;
  if v_message.author_subject_id is distinct from v_subject_id then
    raise exception 'support_attachment_message_author_mismatch';
  end if;
  if v_message.author_scope='tenant' then
    if v_message.is_internal
       or not private_app.support_tenant_can_read_ticket(
         v_ticket.tenant_id,v_ticket.id
       ) then raise exception 'forbidden'; end if;
    v_scope:='tenant';
  elsif v_message.author_scope='platform' then
    if not private_app.support_platform_can_reply() then
      raise exception 'forbidden';
    end if;
    v_scope:='platform';
  else
    raise exception 'support_attachment_message_author_mismatch';
  end if;

  v_request_hash:=private_app.support_sha256(jsonb_build_object(
    'ticketId',v_ticket.id,'messageId',v_message.id,
    'fileName',v_file_name,'mimeType',v_mime_type,'sizeBytes',p_size_bytes
  ));
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:support:attachment:'||v_ticket.id::text,0
    )
  );
  select attachment.* into v_attachment
  from core.support_attachments attachment
  where attachment.tenant_id=v_ticket.tenant_id
    and attachment.ticket_id=v_ticket.id
    and attachment.message_id=v_message.id
    and attachment.client_request_id=v_client_request_id;
  if v_attachment.id is not null then
    if v_attachment.request_hash is distinct from v_request_hash then
      raise exception 'support_idempotency_conflict';
    end if;
    if v_attachment.state='ready' then
      return jsonb_build_object(
        'attachmentId',v_attachment.id,'bucket',v_attachment.bucket_id,
        'objectPath',v_attachment.object_path,'state','ready',
        'sizeBytes',v_attachment.actual_size_bytes
      );
    end if;
    if v_attachment.state='pending' and v_attachment.expires_at>now() then
      select exists(
        select 1
        from storage.objects object
        where object.bucket_id=v_attachment.bucket_id
          and object.name=v_attachment.object_path
      ) into v_object_exists;
      if v_object_exists then
        return jsonb_build_object(
          'attachmentId',v_attachment.id,'bucket',v_attachment.bucket_id,
          'objectPath',v_attachment.object_path,'state','uploaded',
          'sizeBytes',v_attachment.declared_size_bytes
        );
      end if;
      if v_ticket.status in ('resolved','closed','done','rejected') then
        raise exception 'support_attachment_ticket_closed';
      end if;
      if v_message.created_at<now()-interval '30 minutes' then
        raise exception 'support_attachment_upload_window_expired';
      end if;
      return jsonb_build_object(
        'attachmentId',v_attachment.id,'bucket',v_attachment.bucket_id,
        'objectPath',v_attachment.object_path,'state','pending'
      );
    end if;
    raise exception 'support_attachment_upload_expired';
  end if;
  if v_ticket.status in ('resolved','closed','done','rejected') then
    raise exception 'support_attachment_ticket_closed';
  end if;
  if v_message.created_at<now()-interval '30 minutes' then
    raise exception 'support_attachment_upload_window_expired';
  end if;

  select
    count(*) filter (
      where attachment.state='ready'
         or (attachment.state='pending' and attachment.expires_at>now())
    ),
    coalesce(sum(case
      when attachment.state='ready'
        or (attachment.state='pending' and attachment.expires_at>now())
      then coalesce(
        attachment.actual_size_bytes,attachment.declared_size_bytes
      ) else 0 end),0)
  into v_active_count,v_total_bytes
  from core.support_attachments attachment
  where attachment.tenant_id=v_ticket.tenant_id
    and attachment.ticket_id=v_ticket.id;
  if v_active_count>=20 then
    raise exception 'support_attachment_count_limit';
  end if;
  if v_total_bytes+p_size_bytes>52428800 then
    raise exception 'support_attachment_total_size_limit';
  end if;
  if (
    select count(*)
    from core.support_attachments attachment
    where attachment.tenant_id=v_ticket.tenant_id
      and attachment.ticket_id=v_ticket.id
      and attachment.message_id=v_message.id
      and (
        attachment.state='ready'
        or (attachment.state='pending' and attachment.expires_at>now())
      )
  )>=5 then raise exception 'support_attachment_message_limit'; end if;

  v_extension:=case v_mime_type
    when 'image/png' then '.png'
    when 'image/jpeg' then '.jpg'
    when 'image/webp' then '.webp'
    when 'image/gif' then '.gif'
    when 'application/pdf' then '.pdf'
    when 'text/plain' then '.txt'
  end;
  v_attachment_id:=extensions.gen_random_uuid();
  v_object_path:=v_ticket.tenant_id::text||'/'||v_ticket.id::text||'/'
    ||v_message.id::text||'/'||v_attachment_id::text||v_extension;
  insert into core.support_attachments(
    id,tenant_id,ticket_id,message_id,bucket_id,object_path,file_name,
    mime_type,declared_size_bytes,state,uploaded_by_scope,
    uploaded_by_subject_id,client_request_id,request_hash,expires_at,
    cleanup_after
  ) values (
    v_attachment_id,v_ticket.tenant_id,v_ticket.id,v_message.id,
    'support-attachments',v_object_path,v_file_name,v_mime_type,
    p_size_bytes,'pending',v_scope,v_subject_id,v_client_request_id,
    v_request_hash,now()+interval '2 hours',now()+interval '5 hours'
  );
  perform private_app.write_audit(
    'support.attachment.upload_ticket','support_attachment',
    v_attachment_id::text,v_ticket.tenant_id,jsonb_build_object(
      'ticketId',v_ticket.id,'messageId',v_message.id,
      'mimeType',v_mime_type,'sizeBytes',p_size_bytes
    )
  );
  return jsonb_build_object(
    'attachmentId',v_attachment_id,'bucket','support-attachments',
    'objectPath',v_object_path,'state','pending'
  );
end;
$$;

create or replace function public.v3_support_attachment_finalize(
  p_attachment_id uuid,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_subject_id uuid:=private_app.current_subject_id();
  v_attachment core.support_attachments%rowtype;
  v_metadata jsonb;
  v_actual_size bigint;
  v_actual_mime text;
  v_size_text text;
begin
  if v_subject_id is null or p_attachment_id is null then
    raise exception 'support_attachment_invalid';
  end if;
  select attachment.* into v_attachment
  from core.support_attachments attachment
  where attachment.id=p_attachment_id
  for update;
  if v_attachment.id is null then
    raise exception 'support_attachment_not_found';
  end if;
  if v_attachment.uploaded_by_subject_id<>v_subject_id then
    raise exception 'forbidden';
  end if;
  if v_attachment.state='ready' then
    if v_attachment.actual_size_bytes is distinct from p_size_bytes then
      raise exception 'support_attachment_size_mismatch';
    end if;
    return jsonb_build_object(
      'success',true,'attachmentId',v_attachment.id,
      'state','ready','sizeBytes',v_attachment.actual_size_bytes
    );
  end if;
  if v_attachment.state<>'pending' or v_attachment.expires_at<=now() then
    raise exception 'support_attachment_upload_expired';
  end if;
  select object.metadata into v_metadata
  from storage.objects object
  where object.bucket_id=v_attachment.bucket_id
    and object.name=v_attachment.object_path;
  if not found then raise exception 'support_attachment_not_uploaded'; end if;
  v_size_text:=coalesce(
    nullif(v_metadata->>'size',''),nullif(v_metadata->>'contentLength','')
  );
  if coalesce(v_size_text,'')!~'^[1-9][0-9]{0,10}$' then
    raise exception 'support_attachment_storage_metadata_invalid';
  end if;
  begin
    v_actual_size:=v_size_text::bigint;
  exception when numeric_value_out_of_range then
    raise exception 'support_attachment_storage_metadata_invalid';
  end;
  v_actual_mime:=lower(coalesce(
    nullif(v_metadata->>'mimetype',''),
    nullif(v_metadata->>'contentType',''),
    nullif(v_metadata->>'content-type','')
  ));
  if p_size_bytes is distinct from v_attachment.declared_size_bytes
     or v_actual_size is distinct from v_attachment.declared_size_bytes then
    raise exception 'support_attachment_size_mismatch';
  end if;
  if v_actual_mime is distinct from v_attachment.mime_type then
    raise exception 'support_attachment_type_mismatch';
  end if;
  update core.support_attachments attachment
  set state='ready',actual_size_bytes=v_actual_size,
      finalized_at=now(),expires_at=now()
  where attachment.id=v_attachment.id;
  insert into core.support_events(
    tenant_id,ticket_id,ticket_version,event_type,actor_scope,
    actor_subject_id,visibility,metadata,created_at
  )
  select
    v_attachment.tenant_id,v_attachment.ticket_id,ticket.version,
    'attachment.finalized',v_attachment.uploaded_by_scope,v_subject_id,
    case when message.is_internal then 'platform' else 'tenant' end,
    jsonb_build_object(
      'attachmentId',v_attachment.id,'mimeType',v_attachment.mime_type,
      'sizeBytes',v_actual_size
    ),now()
  from core.support_requests ticket
  join core.support_messages message
    on message.tenant_id=v_attachment.tenant_id
   and message.ticket_id=v_attachment.ticket_id
   and message.id=v_attachment.message_id
  where ticket.id=v_attachment.ticket_id
    and ticket.tenant_id=v_attachment.tenant_id;
  perform private_app.write_audit(
    'support.attachment.finalized','support_attachment',
    v_attachment.id::text,v_attachment.tenant_id,jsonb_build_object(
      'ticketId',v_attachment.ticket_id,'mimeType',v_attachment.mime_type,
      'sizeBytes',v_actual_size
    )
  );
  return jsonb_build_object(
    'success',true,'attachmentId',v_attachment.id,
    'state','ready','sizeBytes',v_actual_size
  );
end;
$$;

create or replace function public.v3_support_attachment_resolve(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_attachment core.support_attachments%rowtype;
  v_internal boolean;
begin
  if private_app.current_subject_id() is null or p_attachment_id is null then
    raise exception 'support_attachment_not_found';
  end if;
  select attachment.* into v_attachment
  from core.support_attachments attachment
  where attachment.id=p_attachment_id
    and attachment.state='ready';
  if v_attachment.id is null then
    raise exception 'support_attachment_not_found';
  end if;
  select message.is_internal into v_internal
  from core.support_messages message
  where message.tenant_id=v_attachment.tenant_id
    and message.ticket_id=v_attachment.ticket_id
    and message.id=v_attachment.message_id;
  if not (
    private_app.support_platform_can_read()
    or (
      not v_internal
      and private_app.support_tenant_can_read_ticket(
        v_attachment.tenant_id,v_attachment.ticket_id
      )
    )
  ) then raise exception 'support_attachment_not_found'; end if;
  return jsonb_build_object(
    'bucket',v_attachment.bucket_id,
    'objectPath',v_attachment.object_path,
    'fileName',v_attachment.file_name,
    'mimeType',v_attachment.mime_type,
    'sizeBytes',v_attachment.actual_size_bytes
  );
end;
$$;

revoke all on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) to authenticated;
revoke all on function public.v3_support_attachment_finalize(uuid,bigint)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_finalize(uuid,bigint)
to authenticated;
revoke all on function public.v3_support_attachment_resolve(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_resolve(uuid)
to authenticated;

create or replace function private_app.support_attachment_delete_guard()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if exists(
    select 1
    from storage.objects object
    where object.bucket_id=old.bucket_id
      and object.name=old.object_path
  ) then
    raise exception 'support_attachment_storage_cleanup_required';
  end if;
  return old;
end;
$$;

revoke all on function private_app.support_attachment_delete_guard()
from public,anon,authenticated,service_role;
drop trigger if exists support_attachment_delete_guard
on core.support_attachments;
create trigger support_attachment_delete_guard
before delete on core.support_attachments
for each row execute function private_app.support_attachment_delete_guard();

-- A scheduled Edge worker may fetch expired manifests, delete each object via
-- the Storage API, then finalize the manifest cleanup.  SQL never deletes
-- storage.objects directly because that would bypass Storage housekeeping.
create or replace function public.v3_support_attachment_cleanup_snapshot(
  p_limit integer default 100
)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  with expired as (
    select attachment.id,attachment.bucket_id,attachment.object_path,
           attachment.cleanup_after
    from core.support_attachments attachment
    where attachment.state='pending'
      and attachment.cleanup_after<=now()-interval '5 minutes'
    order by attachment.cleanup_after,attachment.id
    limit least(greatest(coalesce(p_limit,100),1),500)+1
  ), page as (
    select * from expired
    order by cleanup_after,id
    limit least(greatest(coalesce(p_limit,100),1),500)
  )
  select jsonb_build_object(
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'attachmentId',page.id,'bucket',page.bucket_id,
      'objectPath',page.object_path,'cleanupAfter',page.cleanup_after
    ) order by page.cleanup_after,page.id) from page),'[]'::jsonb),
    'hasMore',(select count(*) from expired)>
      least(greatest(coalesce(p_limit,100),1),500)
  )
$$;

create or replace function public.v3_support_attachment_cleanup_finalize(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_attachment core.support_attachments%rowtype;
begin
  select attachment.* into v_attachment
  from core.support_attachments attachment
  where attachment.id=p_attachment_id
  for update;
  if v_attachment.id is null then
    return jsonb_build_object(
      'success',true,'idempotent',true,'attachmentId',p_attachment_id
    );
  end if;
  if v_attachment.state<>'pending'
     or v_attachment.cleanup_after>now()-interval '5 minutes' then
    raise exception 'support_attachment_cleanup_not_allowed';
  end if;
  if exists(
    select 1 from storage.objects object
    where object.bucket_id=v_attachment.bucket_id
      and object.name=v_attachment.object_path
  ) then raise exception 'support_attachment_storage_cleanup_required'; end if;
  delete from core.support_attachments attachment
  where attachment.id=v_attachment.id;
  insert into audit_log.events(
    tenant_id,actor_subject_id,action,resource_type,resource_id,context
  ) values (
    v_attachment.tenant_id,null,'support.attachment.expired_cleaned',
    'support_attachment',v_attachment.id::text,
    jsonb_build_object('ticketId',v_attachment.ticket_id)
  );
  return jsonb_build_object(
    'success',true,'idempotent',false,'attachmentId',v_attachment.id
  );
end;
$$;

revoke all on function public.v3_support_attachment_cleanup_snapshot(integer)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_cleanup_snapshot(integer)
to service_role;
revoke all on function public.v3_support_attachment_cleanup_finalize(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_cleanup_finalize(uuid)
to service_role;

-- Deployment automation calls these service-role-only RPCs after the Edge
-- worker secret has been provisioned.  The cron credential is stored only in
-- Vault; the private config table retains a one-way fingerprint for rotation
-- verification and never exposes either credential through an authenticated
-- snapshot.
create or replace function public.v3_support_attachment_cleanup_enable_extensions()
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'forbidden';
  end if;
  execute 'create extension if not exists pg_cron';
  execute 'create extension if not exists pg_net';
  execute 'create extension if not exists supabase_vault cascade';
  return jsonb_build_object(
    'enabled',true,
    'pgCron',to_regnamespace('cron') is not null,
    'pgNet',to_regnamespace('net') is not null,
    'vault',to_regnamespace('vault') is not null
  );
end;
$$;

create or replace function public.v3_support_attachment_cleanup_configure(
  p_function_url text,
  p_publishable_key text,
  p_cleanup_secret text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_cleanup_secret_hash text;
  v_cleanup_secret_id uuid;
  v_publishable_secret_id uuid;
  v_job_id bigint;
  v_actor uuid;
  v_command text:=$cron$
    select net.http_post(
      url:=config.function_url,
      headers:=jsonb_build_object(
        'Content-Type','application/json',
        'apikey',(
          select secret.decrypted_secret
          from vault.decrypted_secrets secret
          where secret.id=config.publishable_key_vault_id
        ),
        'x-odeir-support-cleanup-secret',(
          select secret.decrypted_secret
          from vault.decrypted_secrets secret
          where secret.id=config.cleanup_secret_vault_id
        )
      ),
      body:=jsonb_build_object('action','cleanup'),
      timeout_milliseconds:=30000
    ) as request_id
    from platform.support_attachment_cleanup_worker_config config
    where config.singleton
  $cron$;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'forbidden';
  end if;
  if p_function_url is null or p_function_url !~
     '^https://[a-z0-9]{20}\.supabase\.co/functions/v1/support-attachment-cleanup$'
     or p_publishable_key is null
     or p_publishable_key!~'^[A-Za-z0-9._-]{32,1024}$'
     or p_cleanup_secret is null
     or p_cleanup_secret!~'^[a-f0-9]{64}$' then
    raise exception 'support_attachment_cleanup_configuration_invalid';
  end if;
  if to_regnamespace('cron') is null
     or to_regnamespace('net') is null
     or to_regnamespace('vault') is null
     or to_regprocedure(
       'vault.create_secret(text,text,text,uuid)'
     ) is null
     or to_regprocedure(
       'vault.update_secret(uuid,text,text,text,uuid)'
     ) is null then
    raise exception 'support_attachment_cleanup_extensions_unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'odeir-support-attachment-cleanup-config',0
  ));
  v_actor:=private_app.current_subject_id();
  v_cleanup_secret_hash:=encode(
    extensions.digest(p_cleanup_secret,'sha256'),'hex'
  );

  select secret.id into v_cleanup_secret_id
  from vault.secrets secret
  where secret.name='odeir_support_attachment_cleanup_secret';
  if v_cleanup_secret_id is null then
    v_cleanup_secret_id:=vault.create_secret(
      p_cleanup_secret,
      'odeir_support_attachment_cleanup_secret',
      'Rotating credential used only by the support attachment cleanup cron.'
    );
  else
    perform vault.update_secret(
      v_cleanup_secret_id,p_cleanup_secret,
      'odeir_support_attachment_cleanup_secret',
      'Rotating credential used only by the support attachment cleanup cron.'
    );
  end if;

  select secret.id into v_publishable_secret_id
  from vault.secrets secret
  where secret.name='odeir_support_attachment_cleanup_publishable_key';
  if v_publishable_secret_id is null then
    v_publishable_secret_id:=vault.create_secret(
      p_publishable_key,
      'odeir_support_attachment_cleanup_publishable_key',
      'Publishable project key used only to invoke support attachment cleanup.'
    );
  else
    perform vault.update_secret(
      v_publishable_secret_id,p_publishable_key,
      'odeir_support_attachment_cleanup_publishable_key',
      'Publishable project key used only to invoke support attachment cleanup.'
    );
  end if;

  select job.jobid into v_job_id
  from cron.job job
  where job.jobname='odeir-support-attachment-cleanup-v1';
  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  insert into platform.support_attachment_cleanup_worker_config(
    singleton,function_url,cleanup_secret_hash,cleanup_secret_vault_id,
    publishable_key_vault_id,cron_job_id,configured_by_subject_id,
    configured_at,updated_at
  ) values (
    true,p_function_url,v_cleanup_secret_hash,v_cleanup_secret_id,
    v_publishable_secret_id,null,v_actor,now(),now()
  ) on conflict(singleton) do update
    set function_url=excluded.function_url,
        cleanup_secret_hash=excluded.cleanup_secret_hash,
        cleanup_secret_vault_id=excluded.cleanup_secret_vault_id,
        publishable_key_vault_id=excluded.publishable_key_vault_id,
        cron_job_id=null,
        configured_by_subject_id=excluded.configured_by_subject_id,
        configured_at=excluded.configured_at,
        updated_at=excluded.updated_at;

  v_job_id:=cron.schedule(
    'odeir-support-attachment-cleanup-v1','*/15 * * * *',v_command
  );
  update platform.support_attachment_cleanup_worker_config config
  set cron_job_id=v_job_id,updated_at=now()
  where config.singleton;

  return jsonb_build_object(
    'configured',true,
    'functionUrl',p_function_url,
    'schedule','*/15 * * * *',
    'cronJobId',v_job_id,
    'configuredAt',now()
  );
end;
$function$;

revoke all on function
  public.v3_support_attachment_cleanup_enable_extensions()
from public,anon,authenticated,service_role;
grant execute on function
  public.v3_support_attachment_cleanup_enable_extensions()
to service_role;
revoke all on function public.v3_support_attachment_cleanup_configure(
  text,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_cleanup_configure(
  text,text,text
) to service_role;

-- Fail closed in the existing permanent-tenant purge.  Support history and
-- private support objects require an explicit retention/export decision first.
alter function private_app.v1_tenant_deletion_preview_document(uuid)
rename to v1_tenant_deletion_preview_document_legacy_internal;
revoke all on function
  private_app.v1_tenant_deletion_preview_document_legacy_internal(uuid)
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
  v_support_tickets bigint:=0;
  v_support_objects bigint:=0;
  v_digest text;
begin
  v_result:=private_app.v1_tenant_deletion_preview_document_legacy_internal(
    p_tenant_id
  );
  select count(*) into v_support_tickets
  from core.support_requests ticket
  where ticket.tenant_id=p_tenant_id;
  select count(*) into v_support_objects
  from storage.objects object
  where object.bucket_id='support-attachments'
    and (
      object.name=p_tenant_id::text
      or object.name like p_tenant_id::text||'/%'
    );
  v_counts:=coalesce(v_result->'counts','{}'::jsonb)
    ||jsonb_build_object(
      'supportTickets',v_support_tickets,
      'supportAttachmentObjects',v_support_objects
    );
  v_blockers:=coalesce(v_result->'blockers','[]'::jsonb);
  if v_support_tickets>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','support_history_exists','count',v_support_tickets,
      'message','توجد تذاكر دعم فني محفوظة تتطلب قرار احتفاظ صريحًا.'
    ));
  end if;
  if v_support_objects>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','support_attachments_exist','count',v_support_objects,
      'message','توجد مرفقات دعم خاصة يجب حذفها عبر Storage API أولًا.'
    ));
  end if;
  v_digest:=encode(extensions.digest(
    coalesce(v_result->>'previewDigest','')||'|'||v_counts::text||'|'
      ||v_blockers::text,
    'sha256'
  ),'hex');
  return jsonb_set(
    jsonb_set(
      jsonb_set(v_result,'{counts}',v_counts,true),
      '{blockers}',v_blockers,true
    ),
    '{canDelete}',to_jsonb(jsonb_array_length(v_blockers)=0),true
  )||jsonb_build_object(
    'dependencyFingerprint',encode(extensions.digest(
      coalesce(v_result->>'dependencyFingerprint','')||'|'
        ||v_support_tickets::text||'|'||v_support_objects::text,
      'sha256'
    ),'hex'),
    'previewDigest',v_digest
  );
end;
$$;

revoke all on function private_app.v1_tenant_deletion_preview_document(uuid)
from public,anon,authenticated,service_role;

-- Safe tenant workspace compatibility: detailed support records are available
-- only through v3 support snapshots.  The legacy workspace keeps a scoped count.
alter function public.v2_tenant_workspace_snapshot(text)
rename to v2_tenant_workspace_snapshot_legacy_internal;
revoke all on function public.v2_tenant_workspace_snapshot_legacy_internal(text)
from public,anon,authenticated,service_role;

create or replace function public.v3_tenant_workspace_snapshot(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_subject_id uuid:=private_app.current_subject_id();
  v_is_member boolean:=false;
  v_can_read_all boolean:=false;
  v_platform_reader boolean:=false;
  v_pending_support bigint:=0;
  v_result jsonb;
begin
  if v_subject_id is null then raise exception 'authentication_required'; end if;
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.slug=p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  v_is_member:=private_app.support_is_active_tenant_member(v_tenant.id);
  v_platform_reader:=private_app.support_platform_can_read();
  if not v_is_member and not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;
  v_can_read_all:=v_is_member
    and private_app.support_tenant_can_read_all(v_tenant.id);

  if v_is_member or v_platform_reader then
    select count(*) into v_pending_support
    from core.support_requests ticket
    where ticket.tenant_id=v_tenant.id
      and ticket.status not in ('resolved','closed','done','rejected')
      and (
        v_can_read_all or v_platform_reader
        or ticket.requested_by_subject_id=v_subject_id
      );
  end if;

  v_result:=public.v2_tenant_workspace_snapshot_legacy_internal(p_slug);
  v_result:=jsonb_set(v_result,'{supportRequests}','[]'::jsonb,true);
  v_result:=jsonb_set(
    v_result,'{summary,pendingSupport}',to_jsonb(v_pending_support),true
  );
  return v_result||jsonb_build_object('supportSchemaVersion',3);
end;
$$;

revoke all on function public.v3_tenant_workspace_snapshot(text)
from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_workspace_snapshot(text)
to authenticated;

create or replace function public.v2_tenant_workspace_snapshot(p_slug text)
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select public.v3_tenant_workspace_snapshot(p_slug)
$$;

revoke all on function public.v2_tenant_workspace_snapshot(text)
from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_workspace_snapshot(text)
to authenticated;

-- Preserve the legacy platform dashboard contract without exposing ticket
-- bodies.  Dedicated support staff use v3_platform_support_snapshot instead.
alter function public.v2_platform_control_snapshot()
rename to v2_platform_control_snapshot_legacy_internal;
revoke all on function public.v2_platform_control_snapshot_legacy_internal()
from public,anon,authenticated,service_role;

create or replace function public.v2_platform_control_snapshot_v2()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_result jsonb;
  v_can_tenants boolean:=private_app.has_platform_permission(
    'platform.tenants.manage'
  );
  v_can_billing boolean:=private_app.has_platform_permission(
    'platform.billing.manage'
  );
  v_can_content boolean:=private_app.has_platform_permission(
    'platform.content.manage'
  );
  v_can_website boolean:=private_app.has_platform_permission(
    'platform.website.manage'
  );
  v_can_access boolean:=private_app.has_platform_permission(
    'platform.access.manage'
  );
  v_can_settings boolean:=private_app.has_platform_permission(
    'platform.settings.manage'
  ) or private_app.has_platform_permission('platform.control.write');
  v_can_audit boolean:=private_app.has_platform_permission(
    'platform.audit.read'
  );
  v_can_support boolean:=private_app.support_platform_can_read();
  v_open_support bigint:=0;
begin
  if not private_app.has_platform_permission('platform.control.read') then
    raise exception 'forbidden';
  end if;
  v_result:=public.v2_platform_control_snapshot_legacy_internal();
  if not v_can_tenants then
    v_result:=jsonb_set(v_result,'{tenants}','[]'::jsonb,true);
    v_result:=jsonb_set(
      v_result,'{summary,organizations}',to_jsonb(0),true
    );
    v_result:=jsonb_set(
      v_result,'{summary,activeTenants}',to_jsonb(0),true
    );
  end if;
  if not (v_can_billing or v_can_tenants) then
    v_result:=jsonb_set(v_result,'{plans}','[]'::jsonb,true);
    v_result:=jsonb_set(v_result,'{features}','[]'::jsonb,true);
  end if;
  if not v_can_billing then
    v_result:=jsonb_set(v_result,'{subscriptions}','[]'::jsonb,true);
  end if;
  if not v_can_access then
    v_result:=jsonb_set(v_result,'{roles}','[]'::jsonb,true);
  end if;
  if not v_can_settings then
    v_result:=jsonb_set(v_result,'{integrations}','[]'::jsonb,true);
    v_result:=jsonb_set(
      v_result,'{summary,integrations}',to_jsonb(0),true
    );
  end if;
  if not v_can_audit then
    v_result:=jsonb_set(v_result,'{audit}','[]'::jsonb,true);
  end if;
  if v_can_support then
    select count(*) into v_open_support
    from core.support_requests ticket
    where ticket.tenant_id is not null
      and ticket.status not in ('resolved','closed','done','rejected');
  end if;
  v_result:=jsonb_set(v_result,'{supportRequests}','[]'::jsonb,true);
  v_result:=jsonb_set(
    v_result,'{summary,openSupport}',to_jsonb(v_open_support),true
  );
  return v_result||jsonb_build_object('capabilities',jsonb_build_object(
    'overview',true,'tenants',v_can_tenants,'billing',v_can_billing,
    'content',v_can_content,'website',v_can_website,'access',v_can_access,
    'settings',v_can_settings,'audit',v_can_audit,'support',v_can_support
  ));
end;
$$;

create or replace function public.v2_platform_control_snapshot()
returns jsonb
language sql
stable
security definer
set search_path=''
as $$
  select public.v2_platform_control_snapshot_v2()
$$;

revoke all on function public.v2_platform_control_snapshot()
from public,anon,authenticated,service_role;
grant execute on function public.v2_platform_control_snapshot()
to authenticated;

-- Remove direct legacy read/mutation channels.  Security-definer wrappers
-- owned by the database may still compose the sanitized snapshots above.
revoke all on function public.v2_platform_control_snapshot_v2()
from public,anon,authenticated,service_role;
-- v3_platform_control_snapshot is defined by the existing task-day migration;
-- it composes the sanitized v2_platform_control_snapshot_v2 defined above.
revoke all on function public.v3_platform_control_snapshot()
from public,anon,authenticated,service_role;
grant execute on function public.v3_platform_control_snapshot()
to authenticated;
revoke all on function public.v2_support_create_request(
  text,text,text,text,text
) from public,anon,authenticated,service_role;
revoke all on function public.v2_support_update_request(uuid,text,text)
from public,anon,authenticated,service_role;

-- Attachments are deliberately unavailable in this release. Keep the deny
-- boundary inside this migration's transaction so the base migration can
-- never commit a temporary upload/read window if a later migration is not
-- applied. Tickets and text conversations remain fully available.
update storage.buckets bucket
set public=false
where bucket.id='support-attachments';

drop policy if exists support_attachments_insert on storage.objects;
drop policy if exists support_attachments_select on storage.objects;
drop policy if exists support_attachments_update on storage.objects;
drop policy if exists support_attachments_delete on storage.objects;
drop policy if exists support_attachments_scanner_fail_closed
on storage.objects;
create policy support_attachments_scanner_fail_closed
on storage.objects
as restrictive
for all
to public
using (bucket_id<>'support-attachments')
with check (bucket_id<>'support-attachments');

comment on policy support_attachments_scanner_fail_closed
on storage.objects is
'Restrictive DB boundary denying every non-bypass role access to support attachments until a reviewed scanner pipeline replaces this policy.';

create or replace function public.v3_support_storage_can_upload(
  p_object_path text
)
returns boolean
language sql
immutable
security definer
set search_path=''
as $$
  select false
$$;

create or replace function public.v3_support_storage_can_read(
  p_object_path text
)
returns boolean
language sql
immutable
security definer
set search_path=''
as $$
  select false
$$;

create or replace function public.v3_support_attachment_upload_ticket(
  p_ticket_id uuid,
  p_message_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_client_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

create or replace function public.v3_support_attachment_finalize(
  p_attachment_id uuid,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

create or replace function public.v3_support_attachment_resolve(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

revoke all on function public.v3_support_storage_can_upload(text)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_storage_can_read(text)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_finalize(uuid,bigint)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_resolve(uuid)
from public,anon,authenticated,service_role;

comment on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) is
'Fail-closed attachment boundary. A later reviewed scanner migration must replace this guard and restore only the required grant.';
comment on function public.v3_support_storage_can_upload(text) is
'Fail-closed Storage helper returning false until support attachment scanning is implemented.';
comment on function public.v3_support_storage_can_read(text) is
'Fail-closed Storage helper returning false so unscanned support objects cannot be read.';
comment on function public.v3_support_attachment_finalize(uuid,bigint) is
'Fail-closed attachment boundary pending quarantine, magic-byte validation and malware scanning.';
comment on function public.v3_support_attachment_resolve(uuid) is
'Fail-closed attachment boundary: unscanned support objects cannot be resolved or downloaded.';

commit;