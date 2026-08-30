begin;

-- Odeir notification hub v2.  Every capture, email and independent health
-- monitor is fail-closed.  Applying this migration alone cannot enqueue mail,
-- schedule a monitor or change any tenant entitlement.
create table platform.lifecycle_notification_settings (
  policy_key text primary key
    check (policy_key = 'notification_hub_v2'),
  capture_enabled boolean not null default false,
  tenant_email_enabled boolean not null default false,
  platform_email_enabled boolean not null default false,
  operational_monitor_enabled boolean not null default false,
  platform_default_locale text not null default 'ar'
    check (platform_default_locale in ('ar','en')),
  monitor_cron_job_id bigint,
  last_worker_heartbeat_at timestamptz,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  updated_at timestamptz not null default now()
);

insert into platform.lifecycle_notification_settings (
  policy_key,
  capture_enabled,
  tenant_email_enabled,
  platform_email_enabled,
  operational_monitor_enabled,
  platform_default_locale
)
values ('notification_hub_v2', false, false, false, false, 'ar')
on conflict (policy_key) do nothing;

-- Registration language becomes immutable per delivery so a retry can never
-- change bytes behind an existing Resend idempotency key.
alter table platform.registration_email_deliveries
  add column notification_locale text not null default 'ar'
    check (notification_locale in ('ar','en'));

create table platform.lifecycle_notification_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid
    references core.tenants(id) on delete set null,
  event_key text not null unique,
  event_type text not null
    check (event_type ~ '^[a-z][a-z0-9_]{2,80}$'),
  source_type text not null
    check (source_type in (
      'addon_subscription','marketplace_order','bank_transfer',
      'registration_request','registration_email','lifecycle_sweep',
      'operational_probe'
    )),
  source_id text not null,
  severity text not null default 'info'
    check (severity in ('info','success','warning','danger')),
  tenant_title text not null,
  tenant_message text not null,
  platform_title text not null,
  platform_message text not null,
  tenant_action_path text,
  platform_action_path text not null,
  platform_permission_key text not null default 'platform.billing.manage'
    check (platform_permission_key in (
      'platform.billing.manage','platform.tenants.manage',
      'platform.settings.manage','platform.control.write'
    )),
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  action_required boolean not null default false,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  check (length(trim(event_key)) between 8 and 240),
  check (length(trim(source_id)) between 1 and 160),
  check (length(trim(tenant_title)) between 2 and 240),
  check (length(trim(tenant_message)) between 2 and 1200),
  check (length(trim(platform_title)) between 2 and 240),
  check (length(trim(platform_message)) between 2 and 1200),
  check (
    tenant_action_path is null
    or tenant_action_path ~ '^[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9-]+)*$'
  ),
  check (platform_action_path ~ '^/control(?:/[a-z0-9-]+)*$')
);

create index lifecycle_notification_events_tenant_time_idx
on platform.lifecycle_notification_events (tenant_id, occurred_at desc)
where tenant_id is not null;

create index lifecycle_notification_events_type_time_idx
on platform.lifecycle_notification_events (event_type, occurred_at desc);

create index lifecycle_notification_events_requester_idx
on platform.lifecycle_notification_events (requested_by_subject_id)
where requested_by_subject_id is not null;

create table platform.lifecycle_notification_inbox (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references platform.lifecycle_notification_events(id) on delete cascade,
  recipient_subject_id uuid not null
    references access_control.subjects(id) on delete cascade,
  title text not null,
  message text not null,
  severity text not null
    check (severity in ('info','success','warning','danger')),
  action_url text not null
    check (action_url ~ '^/control(?:/[a-z0-9-]+)*$'),
  read_at timestamptz,
  created_at timestamptz not null default now(),
  unique (event_id, recipient_subject_id)
);

create index lifecycle_notification_inbox_recipient_time_idx
on platform.lifecycle_notification_inbox (
  recipient_subject_id,
  created_at desc
);

create index lifecycle_notification_inbox_unread_idx
on platform.lifecycle_notification_inbox (
  recipient_subject_id,
  created_at desc
)
where read_at is null;

create table platform.lifecycle_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null
    references platform.lifecycle_notification_events(id) on delete cascade,
  tenant_id uuid
    references core.tenants(id) on delete set null,
  recipient_subject_id uuid not null
    references access_control.subjects(id) on delete cascade,
  audience text not null
    check (audience in ('tenant','platform')),
  locale text not null default 'ar'
    check (locale in ('ar','en')),
  template_key text not null
    check (template_key ~ '^odeir-[a-z0-9-]+-v2$'),
  state text not null default 'queued'
    check (state in ('queued','leased','retryable','accepted','terminal_failed','cancelled')),
  attempt_count integer not null default 0
    check (attempt_count between 0 and 20),
  retry_at timestamptz not null default now(),
  lease_id uuid,
  lease_expires_at timestamptz,
  idempotency_key text not null unique,
  provider text not null default 'resend'
    check (provider = 'resend'),
  provider_message_id text,
  provider_state text,
  accepted_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, recipient_subject_id, audience),
  check (
    (state = 'leased' and lease_id is not null and lease_expires_at is not null)
    or
    (state <> 'leased')
  ),
  check (audience = 'platform' or tenant_id is not null)
);

create unique index lifecycle_email_provider_message_idx
on platform.lifecycle_email_deliveries (provider, provider_message_id)
where provider_message_id is not null;

create index lifecycle_email_ready_idx
on platform.lifecycle_email_deliveries (retry_at, created_at, id)
where state in ('queued','retryable');

create index lifecycle_email_stale_lease_idx
on platform.lifecycle_email_deliveries (lease_expires_at, created_at, id)
where state = 'leased';

create index lifecycle_email_tenant_reference_idx
on platform.lifecycle_email_deliveries (tenant_id);

create index lifecycle_email_recipient_reference_idx
on platform.lifecycle_email_deliveries (recipient_subject_id);

create table platform.lifecycle_email_delivery_attempts (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null
    references platform.lifecycle_email_deliveries(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  outcome text not null
    check (outcome in ('accepted','retryable','terminal_failed')),
  provider_message_id text,
  http_status integer check (http_status is null or http_status between 100 and 599),
  error_code text,
  created_at timestamptz not null default now(),
  unique (delivery_id, attempt_number)
);

create table platform.lifecycle_email_webhook_events (
  event_id text primary key,
  delivery_id uuid not null
    references platform.lifecycle_email_deliveries(id) on delete cascade,
  provider_message_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (provider_message_id, event_type, occurred_at)
);

create index lifecycle_email_webhook_delivery_idx
on platform.lifecycle_email_webhook_events (delivery_id);

alter table platform.lifecycle_notification_settings enable row level security;
alter table platform.lifecycle_notification_settings force row level security;
alter table platform.lifecycle_notification_events enable row level security;
alter table platform.lifecycle_notification_events force row level security;
alter table platform.lifecycle_notification_inbox enable row level security;
alter table platform.lifecycle_notification_inbox force row level security;
alter table platform.lifecycle_email_deliveries enable row level security;
alter table platform.lifecycle_email_deliveries force row level security;
alter table platform.lifecycle_email_delivery_attempts enable row level security;
alter table platform.lifecycle_email_delivery_attempts force row level security;
alter table platform.lifecycle_email_webhook_events enable row level security;
alter table platform.lifecycle_email_webhook_events force row level security;

revoke all on table platform.lifecycle_notification_settings
from public, anon, authenticated, service_role;
revoke all on table platform.lifecycle_notification_events
from public, anon, authenticated, service_role;
revoke all on table platform.lifecycle_notification_inbox
from public, anon, authenticated, service_role;
revoke all on table platform.lifecycle_email_deliveries
from public, anon, authenticated, service_role;
revoke all on table platform.lifecycle_email_delivery_attempts
from public, anon, authenticated, service_role;
revoke all on table platform.lifecycle_email_webhook_events
from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_notification_capture(
  p_tenant_id uuid,
  p_event_key text,
  p_event_type text,
  p_source_type text,
  p_source_id text,
  p_severity text,
  p_tenant_title text,
  p_tenant_message text,
  p_platform_title text,
  p_platform_message text,
  p_tenant_action_path text,
  p_platform_action_path text,
  p_requested_by_subject_id uuid default null,
  p_action_required boolean default false,
  p_tenant_notify boolean default true,
  p_platform_notify boolean default true,
  p_tenant_email boolean default true,
  p_platform_email boolean default false,
  p_metadata jsonb default '{}'::jsonb,
  p_occurred_at timestamptz default now(),
  p_platform_permission_key text default 'platform.billing.manage'
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings platform.lifecycle_notification_settings%rowtype;
  v_event_id uuid;
begin
  select settings.*
  into v_settings
  from platform.lifecycle_notification_settings settings
  where settings.policy_key = 'notification_hub_v2';

  if v_settings.capture_enabled is not true then return null; end if;
  if p_tenant_id is not null and not exists (
    select 1 from core.tenants tenant where tenant.id = p_tenant_id
  ) then raise exception 'lifecycle_tenant_not_found'; end if;
  if p_tenant_id is null and (p_tenant_notify or p_tenant_email) then
    raise exception 'lifecycle_tenant_required';
  end if;
  if p_platform_permission_key not in (
    'platform.billing.manage','platform.tenants.manage',
    'platform.settings.manage','platform.control.write'
  ) then raise exception 'lifecycle_platform_permission_invalid'; end if;
  if jsonb_typeof(coalesce(p_metadata, '{}'::jsonb)) <> 'object' then
    raise exception 'lifecycle_metadata_invalid';
  end if;

  insert into platform.lifecycle_notification_events (
    tenant_id,
    event_key,
    event_type,
    source_type,
    source_id,
    severity,
    tenant_title,
    tenant_message,
    platform_title,
    platform_message,
    tenant_action_path,
    platform_action_path,
    platform_permission_key,
    requested_by_subject_id,
    action_required,
    metadata,
    occurred_at
  )
  values (
    p_tenant_id,
    left(trim(p_event_key), 240),
    p_event_type,
    p_source_type,
    left(trim(p_source_id), 160),
    p_severity,
    left(trim(p_tenant_title), 240),
    left(trim(p_tenant_message), 1200),
    left(trim(p_platform_title), 240),
    left(trim(p_platform_message), 1200),
    p_tenant_action_path,
    p_platform_action_path,
    p_platform_permission_key,
    p_requested_by_subject_id,
    p_action_required,
    coalesce(p_metadata, '{}'::jsonb),
    coalesce(p_occurred_at, now())
  )
  on conflict (event_key) do nothing
  returning id into v_event_id;

  -- A duplicate source event has already completed its atomic fan-out.
  if v_event_id is null then
    select event.id into v_event_id
    from platform.lifecycle_notification_events event
    where event.event_key = left(trim(p_event_key), 240);
    return v_event_id;
  end if;

  if p_platform_notify then
    insert into platform.lifecycle_notification_inbox (
      event_id,
      recipient_subject_id,
      title,
      message,
      severity,
      action_url
    )
    select distinct
      v_event_id,
      membership.subject_id,
      left(trim(p_platform_title), 240),
      left(trim(p_platform_message), 1200),
      p_severity,
      p_platform_action_path
    from access_control.memberships membership
    join access_control.subjects subject
      on subject.id = membership.subject_id
     and subject.status = 'active'
    join access_control.membership_roles membership_role
      on membership_role.membership_id = membership.id
    join access_control.role_permissions role_permission
      on role_permission.role_id = membership_role.role_id
     and role_permission.permission_key = p_platform_permission_key
    where membership.scope = 'platform'
      and membership.status = 'active'
    on conflict (event_id, recipient_subject_id) do nothing;

    if v_settings.platform_email_enabled
       and p_platform_email
       and (p_action_required or p_severity = 'danger') then
      insert into platform.lifecycle_email_deliveries (
        event_id,
        tenant_id,
        recipient_subject_id,
        audience,
        locale,
        template_key,
        idempotency_key
      )
      select distinct
        v_event_id,
        p_tenant_id,
        membership.subject_id,
        'platform',
        v_settings.platform_default_locale,
        'odeir-platform-action-v2',
        'odeir-commerce/' || v_event_id::text || '/platform/'
          || membership.subject_id::text
      from access_control.memberships membership
      join access_control.subjects subject
        on subject.id = membership.subject_id
       and subject.status = 'active'
       and subject.email = lower(trim(subject.email))
      join access_control.membership_roles membership_role
        on membership_role.membership_id = membership.id
      join access_control.role_permissions role_permission
        on role_permission.role_id = membership_role.role_id
       and role_permission.permission_key = p_platform_permission_key
      where membership.scope = 'platform'
        and membership.status = 'active'
      on conflict (event_id, recipient_subject_id, audience) do nothing;
    end if;
  end if;

  if p_tenant_notify then
    with tenant_recipient as (
      select distinct
        membership.subject_id,
        staff.id as staff_id
      from access_control.memberships membership
      join access_control.subjects subject
        on subject.id = membership.subject_id
       and subject.status = 'active'
      left join people.staff_profiles staff
        on staff.membership_id = membership.id
       and staff.tenant_id = p_tenant_id
       and staff.employment_status = 'active'
      where membership.scope = 'tenant'
        and membership.tenant_id = p_tenant_id
        and membership.status = 'active'
        and (
          membership.subject_id = p_requested_by_subject_id
          or exists (
            select 1
            from access_control.membership_roles owner_membership_role
            join access_control.roles owner_role
              on owner_role.id = owner_membership_role.role_id
             and owner_role.scope = 'tenant'
             and owner_role.role_key = 'tenant_owner'
            where owner_membership_role.membership_id = membership.id
          )
        )
    )
    insert into work_core.notifications (
      tenant_id,
      notification_key,
      recipient_staff_id,
      notification_type,
      title,
      message,
      severity,
      action_path,
      metadata
    )
    select
      p_tenant_id,
      'commerce:' || v_event_id::text,
      recipient.staff_id,
      p_event_type,
      left(trim(p_tenant_title), 240),
      left(trim(p_tenant_message), 1200),
      p_severity,
      p_tenant_action_path,
      jsonb_build_object(
        'lifecycleEventId', v_event_id,
        'sourceType', p_source_type,
        'sourceId', p_source_id
      )
    from tenant_recipient recipient
    where recipient.staff_id is not null
    on conflict (tenant_id, notification_key, recipient_staff_id) do nothing;

    if v_settings.tenant_email_enabled and p_tenant_email then
      with tenant_recipient as (
        select distinct membership.subject_id
        from access_control.memberships membership
        join access_control.subjects subject
          on subject.id = membership.subject_id
         and subject.status = 'active'
         and subject.email = lower(trim(subject.email))
        where membership.scope = 'tenant'
          and membership.tenant_id = p_tenant_id
          and membership.status = 'active'
          and (
            membership.subject_id = p_requested_by_subject_id
            or exists (
              select 1
              from access_control.membership_roles owner_membership_role
              join access_control.roles owner_role
                on owner_role.id = owner_membership_role.role_id
               and owner_role.scope = 'tenant'
               and owner_role.role_key = 'tenant_owner'
              where owner_membership_role.membership_id = membership.id
            )
          )
      )
      insert into platform.lifecycle_email_deliveries (
        event_id,
        tenant_id,
        recipient_subject_id,
        audience,
        locale,
        template_key,
        idempotency_key
      )
      select
        v_event_id,
        p_tenant_id,
        recipient.subject_id,
        'tenant',
        case when lower(coalesce(tenant.default_locale, 'ar')) like 'en%'
          then 'en' else 'ar' end,
        'odeir-tenant-lifecycle-v2',
        'odeir-commerce/' || v_event_id::text || '/tenant/'
          || recipient.subject_id::text
      from tenant_recipient recipient
      join core.tenants tenant on tenant.id = p_tenant_id
      on conflict (event_id, recipient_subject_id, audience) do nothing;
    end if;
  end if;

  return v_event_id;
end;
$$;

revoke all on function private_app.lifecycle_notification_capture(
  uuid, text, text, text, text, text, text, text, text, text, text, text,
  uuid, boolean, boolean, boolean, boolean, boolean, jsonb, timestamptz, text
) from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_subscription_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_name text;
  v_product_name_en text;
  v_tenant_name text;
  v_event_type text;
  v_event_key text;
  v_severity text := 'info';
  v_tenant_title text;
  v_tenant_message text;
  v_platform_title text;
  v_platform_message text;
  v_action_required boolean := false;
  v_platform_email boolean := false;
begin
  if new.source = 'migration' then return new; end if;

  select product.name_ar, product.name_en
  into v_product_name, v_product_name_en
  from catalog.addon_products product
  where product.id = new.product_id;
  select tenant.name into v_tenant_name
  from core.tenants tenant
  where tenant.id = new.tenant_id;
  v_product_name := coalesce(nullif(trim(v_product_name), ''), 'الإضافة');
  v_tenant_name := coalesce(nullif(trim(v_tenant_name), ''), 'المنشأة');

  if tg_op = 'INSERT' then
    v_event_key := 'subscription:' || new.id::text || ':created:' || new.status;
    if new.status = 'pending' then
      v_event_type := 'addon_activation_requested';
      v_severity := 'warning';
      v_tenant_title := 'استلمنا طلب تفعيل ' || v_product_name;
      v_tenant_message := 'طلب التفعيل قيد المراجعة، وسنبلغك فور اتخاذ القرار.';
      v_platform_title := 'طلب تفعيل إضافة جديد';
      v_platform_message := v_tenant_name || ' طلبت تفعيل ' || v_product_name || '.';
      v_action_required := true;
      v_platform_email := true;
    elsif new.status = 'trialing' then
      v_event_type := 'addon_trial_started';
      v_severity := 'success';
      v_tenant_title := 'بدأت تجربة ' || v_product_name;
      v_tenant_message := 'تم تفعيل الفترة التجريبية ويمكنك استخدام الإضافة الآن.';
      v_platform_title := 'بدأت تجربة إضافة';
      v_platform_message := v_tenant_name || ' بدأت تجربة ' || v_product_name || '.';
    elsif new.status = 'active' then
      v_event_type := 'addon_activated';
      v_severity := 'success';
      v_tenant_title := 'تم تفعيل ' || v_product_name;
      v_tenant_message := 'الإضافة جاهزة للاستخدام داخل مساحة منشأتك.';
      v_platform_title := 'تم تفعيل إضافة';
      v_platform_message := 'تم تفعيل ' || v_product_name || ' لصالح ' || v_tenant_name || '.';
    else
      return new;
    end if;
  elsif new.status is distinct from old.status then
    v_event_key := 'subscription:' || new.id::text || ':status:'
      || old.status || ':' || new.status || ':'
      || new.updated_at::text;
    if new.status = 'trialing' then
      v_event_type := 'addon_trial_started';
      v_severity := 'success';
      v_tenant_title := 'تمت الموافقة على تجربة ' || v_product_name;
      v_tenant_message := 'بدأت الفترة التجريبية وأصبحت الإضافة متاحة الآن.';
      v_platform_title := 'تمت الموافقة على تجربة إضافة';
      v_platform_message := v_tenant_name || ' بدأت تجربة ' || v_product_name || '.';
    elsif new.status = 'active' and old.status = 'paused' then
      v_event_type := 'addon_resumed';
      v_severity := 'success';
      v_tenant_title := 'تم استئناف ' || v_product_name;
      v_tenant_message := 'عادت الإضافة للعمل ويمكن لفريقك استخدامها الآن.';
      v_platform_title := 'تم استئناف إضافة';
      v_platform_message := 'استؤنفت ' || v_product_name || ' لدى ' || v_tenant_name || '.';
    elsif new.status = 'active' then
      v_event_type := 'addon_activated';
      v_severity := 'success';
      v_tenant_title := 'تم تفعيل ' || v_product_name;
      v_tenant_message := 'اكتمل التفعيل وأصبحت الإضافة جاهزة للاستخدام.';
      v_platform_title := 'تم تفعيل إضافة';
      v_platform_message := 'تم تفعيل ' || v_product_name || ' لصالح ' || v_tenant_name || '.';
    elsif new.status = 'paused' then
      v_event_type := 'addon_paused';
      v_severity := 'warning';
      v_tenant_title := 'تم إيقاف ' || v_product_name || ' مؤقتًا';
      v_tenant_message := 'الإضافة متوقفة مؤقتًا. راجع مركز الإضافات لمعرفة حالتها.';
      v_platform_title := 'تم إيقاف إضافة مؤقتًا';
      v_platform_message := v_product_name || ' متوقفة مؤقتًا لدى ' || v_tenant_name || '.';
    elsif new.status = 'cancelled' and old.status = 'pending' then
      v_event_type := 'addon_activation_rejected';
      v_severity := 'danger';
      v_tenant_title := 'تعذر قبول طلب ' || v_product_name;
      v_tenant_message := 'لم تتم الموافقة على طلب التفعيل. راجع سبب القرار بأمان من داخل مركز الإضافات.';
      v_platform_title := 'تم رفض طلب تفعيل إضافة';
      v_platform_message := 'أُغلق طلب ' || v_product_name || ' الخاص بـ' || v_tenant_name || '.';
    elsif new.status = 'cancelled' then
      v_event_type := 'addon_cancelled';
      v_severity := 'warning';
      v_tenant_title := 'تم إلغاء ' || v_product_name;
      v_tenant_message := 'انتهى اشتراك الإضافة ولم تعد متاحة للاستخدام.';
      v_platform_title := 'تم إلغاء إضافة';
      v_platform_message := 'أُلغي اشتراك ' || v_product_name || ' لدى ' || v_tenant_name || '.';
    elsif new.status = 'expired' then
      v_event_type := 'addon_expired';
      v_severity := 'danger';
      v_tenant_title := 'انتهت صلاحية ' || v_product_name;
      v_tenant_message := 'انتهت مدة الإضافة. يمكنك تجديدها من مركز الإضافات.';
      v_platform_title := 'انتهت صلاحية إضافة';
      v_platform_message := 'انتهت ' || v_product_name || ' لدى ' || v_tenant_name || '.';
    else
      return new;
    end if;
  elsif new.cancel_at_period_end and not old.cancel_at_period_end then
    v_event_type := 'addon_cancellation_scheduled';
    v_event_key := 'subscription:' || new.id::text || ':cancel-scheduled:'
      || coalesce(new.period_end::text, new.updated_at::text);
    v_severity := 'warning';
    v_tenant_title := 'تم جدولة إلغاء ' || v_product_name;
    v_tenant_message := 'ستظل الإضافة متاحة حتى نهاية الفترة الحالية ما لم تُستأنف.';
    v_platform_title := 'إلغاء إضافة مجدول';
    v_platform_message := v_tenant_name || ' جدولت إلغاء ' || v_product_name || '.';
  elsif new.period_end is distinct from old.period_end
        and new.period_end is not null
        and (old.period_end is null or new.period_end > old.period_end)
        and new.status = 'active' then
    v_event_type := 'addon_renewed';
    v_event_key := 'subscription:' || new.id::text || ':renewed:' || new.period_end::text;
    v_severity := 'success';
    v_tenant_title := 'تم تجديد ' || v_product_name;
    v_tenant_message := 'تم تحديث مدة الاشتراك بنجاح ويمكنك متابعة الاستخدام.';
    v_platform_title := 'تم تجديد إضافة';
    v_platform_message := 'تجددت ' || v_product_name || ' لدى ' || v_tenant_name || '.';
  else
    return new;
  end if;

  perform private_app.lifecycle_notification_capture(
    new.tenant_id,
    v_event_key,
    v_event_type,
    'addon_subscription',
    new.id::text,
    v_severity,
    v_tenant_title,
    v_tenant_message,
    v_platform_title,
    v_platform_message,
    'addons',
    '/control/addons',
    new.requested_by_subject_id,
    v_action_required,
    true,
    true,
    true,
    v_platform_email,
    jsonb_strip_nulls(jsonb_build_object(
      'subscriptionId', new.id,
      'productId', new.product_id,
      'productName', v_product_name,
      'productNameEn', v_product_name_en,
      'status', new.status,
      'trialEnd', new.trial_end,
      'periodEnd', new.period_end,
      'marketplaceOrderId', new.marketplace_order_id
    )),
    now()
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_subscription_notification()
from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_order_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_product_name text;
  v_tenant_name text;
  v_event_type text;
  v_event_key text;
  v_severity text := 'info';
  v_tenant_title text;
  v_tenant_message text;
  v_platform_title text;
  v_platform_message text;
  v_action_required boolean := false;
  v_tenant_email boolean := true;
  v_platform_email boolean := false;
  v_action_path text;
begin
  select item.product_name_ar into v_product_name
  from marketplace.order_items item
  where item.order_id = new.id
  order by item.created_at, item.id
  limit 1;
  select tenant.name into v_tenant_name
  from core.tenants tenant
  where tenant.id = new.tenant_id;
  v_product_name := coalesce(nullif(trim(v_product_name), ''), 'طلب المتجر');
  v_tenant_name := coalesce(nullif(trim(v_tenant_name), ''), 'المنشأة');
  v_action_path := case when new.order_kind = 'addon'
    then 'addons-store' else 'services-store' end;

  if tg_op = 'INSERT' then
    v_event_type := 'purchase_created';
    v_event_key := 'order:' || new.id::text || ':created';
    v_tenant_title := 'تم إنشاء طلب الشراء ' || new.order_number;
    v_tenant_message := 'استلمنا طلبك، وبانتظار استكمال الدفع أو مراجعته.';
    v_platform_title := 'طلب شراء جديد';
    v_platform_message := v_tenant_name || ' أنشأت الطلب ' || new.order_number || '.';
  elsif new.payment_status is distinct from old.payment_status
        and new.payment_status = 'paid' then
    v_event_type := 'purchase_paid';
    v_event_key := 'order:' || new.id::text || ':payment:paid';
    v_severity := 'success';
    v_tenant_title := 'تم تأكيد دفع الطلب ' || new.order_number;
    v_tenant_message := case when new.order_kind = 'addon'
      then 'تم تأكيد الدفع، وسيصلك إشعار التفعيل فور اكتماله.'
      else 'تم تأكيد الدفع وسيبدأ تنفيذ الخدمة وفق حالة الطلب.' end;
    v_platform_title := 'تم تأكيد عملية شراء';
    v_platform_message := 'تم دفع طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
    -- Paid add-ons receive one combined activation email from the subscription
    -- transition; the paid event remains visible in both inboxes.
    v_tenant_email := new.order_kind <> 'addon';
  elsif new.payment_status is distinct from old.payment_status
        and new.payment_status = 'failed' then
    v_event_type := 'purchase_payment_failed';
    v_event_key := 'order:' || new.id::text || ':payment:failed:'
      || new.updated_at::text;
    v_severity := 'danger';
    v_tenant_title := 'تعذر دفع الطلب ' || new.order_number;
    v_tenant_message := 'لم تكتمل عملية الدفع. راجع وسيلة الدفع أو حاول مرة أخرى.';
    v_platform_title := 'فشل دفع طلب شراء';
    v_platform_message := 'فشل دفع طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
    v_action_required := true;
    v_platform_email := true;
  elsif new.payment_status is distinct from old.payment_status
        and new.payment_status = 'refunded' then
    v_event_type := 'purchase_refunded';
    v_event_key := 'order:' || new.id::text || ':payment:refunded';
    v_severity := 'danger';
    v_tenant_title := 'تم استرداد قيمة الطلب ' || new.order_number;
    v_tenant_message := 'سُجل استرداد المبلغ. راجع تفاصيل الطلب أو تواصل مع الدعم عند الحاجة.';
    v_platform_title := 'تم استرداد عملية شراء';
    v_platform_message := 'تم استرداد طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
    v_platform_email := true;
  elsif new.activation_state is distinct from old.activation_state
        and new.activation_state = 'failed' then
    v_event_type := 'purchase_activation_failed';
    v_event_key := 'order:' || new.id::text || ':activation:failed:'
      || extract(epoch from new.updated_at)::bigint::text;
    v_severity := 'danger';
    v_tenant_title := 'تعذر تفعيل الطلب ' || new.order_number;
    v_tenant_message := 'تم تسجيل مشكلة في التفعيل ويجري التعامل معها. لا تُعد عملية الشراء.';
    v_platform_title := 'فشل تفعيل طلب مدفوع';
    v_platform_message := 'يتطلب طلب ' || v_tenant_name || ' رقم ' || new.order_number || ' تدخلاً.';
    v_action_required := true;
    v_platform_email := true;
  elsif new.status is distinct from old.status and new.status = 'in_progress' then
    v_event_type := 'service_in_progress';
    v_event_key := 'order:' || new.id::text || ':status:in_progress';
    v_severity := 'success';
    v_tenant_title := 'بدأ تنفيذ الطلب ' || new.order_number;
    v_tenant_message := 'انتقل طلب الخدمة إلى مرحلة التنفيذ.';
    v_platform_title := 'بدأ تنفيذ طلب خدمة';
    v_platform_message := 'بدأ تنفيذ طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
  elsif new.status is distinct from old.status and new.status = 'completed' then
    v_event_type := 'service_completed';
    v_event_key := 'order:' || new.id::text || ':status:completed';
    v_severity := 'success';
    v_tenant_title := 'اكتمل الطلب ' || new.order_number;
    v_tenant_message := 'تم تسجيل اكتمال طلب الخدمة بنجاح.';
    v_platform_title := 'اكتمل طلب خدمة';
    v_platform_message := 'اكتمل طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
  elsif new.status is distinct from old.status and new.status = 'cancelled' then
    v_event_type := 'purchase_cancelled';
    v_event_key := 'order:' || new.id::text || ':status:cancelled';
    v_severity := 'warning';
    v_tenant_title := 'تم إلغاء الطلب ' || new.order_number;
    v_tenant_message := 'أُغلق طلب الشراء ولن تتم معالجته.';
    v_platform_title := 'تم إلغاء طلب شراء';
    v_platform_message := 'أُلغي طلب ' || v_tenant_name || ' رقم ' || new.order_number || '.';
  else
    return new;
  end if;

  perform private_app.lifecycle_notification_capture(
    new.tenant_id,
    v_event_key,
    v_event_type,
    'marketplace_order',
    new.id::text,
    v_severity,
    v_tenant_title,
    v_tenant_message,
    v_platform_title,
    v_platform_message,
    v_action_path,
    '/control/marketplace',
    new.requested_by_subject_id,
    v_action_required,
    true,
    true,
    v_tenant_email,
    v_platform_email,
    jsonb_strip_nulls(jsonb_build_object(
      'orderId', new.id,
      'orderNumber', new.order_number,
      'orderKind', new.order_kind,
      'productName', (
        select item.product_name_ar
        from marketplace.order_items item
        where item.order_id = new.id
        order by item.created_at, item.id
        limit 1
      ),
      'productNameEn', (
        select coalesce(product.name_en, item.metadata ->> 'productNameEn')
        from marketplace.order_items item
        left join catalog.addon_products product
          on product.id = item.addon_product_id
        where item.order_id = new.id
        order by item.created_at, item.id
        limit 1
      ),
      'status', new.status,
      'paymentStatus', new.payment_status,
      'activationState', new.activation_state,
      'totalMinor', new.total_minor,
      'currency', new.currency
    )),
    now()
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_order_notification()
from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_bank_transfer_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order_number text;
  v_order_kind text;
  v_tenant_name text;
  v_requester uuid;
  v_event_type text;
  v_event_key text;
  v_severity text := 'info';
  v_tenant_title text;
  v_tenant_message text;
  v_platform_title text;
  v_platform_message text;
  v_action_required boolean := false;
  v_tenant_email boolean := true;
  v_platform_email boolean := false;
begin
  select orders.order_number, orders.order_kind,
    orders.requested_by_subject_id
  into v_order_number, v_order_kind, v_requester
  from marketplace.orders orders
  where orders.id = new.order_id;
  select tenant.name into v_tenant_name
  from core.tenants tenant
  where tenant.id = new.tenant_id;
  v_order_number := coalesce(v_order_number, new.order_id::text);
  v_tenant_name := coalesce(nullif(trim(v_tenant_name), ''), 'المنشأة');

  if tg_op = 'INSERT' then
    v_event_type := 'bank_transfer_submitted';
    v_event_key := 'bank-transfer:' || new.id::text || ':submitted';
    v_severity := 'warning';
    v_tenant_title := 'استلمنا بيانات التحويل للطلب ' || v_order_number;
    v_tenant_message := 'التحويل قيد المراجعة، ولن يلزمك إعادة الإرسال.';
    v_platform_title := 'تحويل بنكي ينتظر المراجعة';
    v_platform_message := v_tenant_name || ' أرسلت تحويلًا للطلب ' || v_order_number || '.';
    v_action_required := true;
    v_platform_email := true;
  elsif new.status = 'pending' and (
    new.status is distinct from old.status
    or new.transfer_reference is distinct from old.transfer_reference
    or new.sender_name is distinct from old.sender_name
    or new.transfer_date is distinct from old.transfer_date
  ) then
    v_event_type := 'bank_transfer_submitted';
    v_event_key := 'bank-transfer:' || new.id::text || ':resubmitted:'
      || new.updated_at::text;
    v_severity := 'warning';
    v_tenant_title := 'استلمنا بيانات التحويل المحدثة للطلب ' || v_order_number;
    v_tenant_message := 'تم تحديث التحويل وهو الآن قيد المراجعة.';
    v_platform_title := 'تحويل بنكي محدث ينتظر المراجعة';
    v_platform_message := v_tenant_name || ' حدّثت تحويل الطلب ' || v_order_number || '.';
    v_action_required := true;
    v_platform_email := true;
  elsif new.status is not distinct from old.status then
    return new;
  elsif new.status = 'reviewing' then
    v_event_type := 'bank_transfer_reviewing';
    v_event_key := 'bank-transfer:' || new.id::text || ':reviewing';
    v_tenant_title := 'بدأت مراجعة التحويل ' || v_order_number;
    v_tenant_message := 'فريق المنصة يراجع التحويل وسيصلك القرار فور اكتماله.';
    v_platform_title := 'بدأت مراجعة تحويل بنكي';
    v_platform_message := 'تحويل ' || v_tenant_name || ' قيد المراجعة.';
  elsif new.status = 'approved' then
    v_event_type := 'bank_transfer_approved';
    v_event_key := 'bank-transfer:' || new.id::text || ':approved';
    v_severity := 'success';
    v_tenant_title := 'تم اعتماد التحويل ' || v_order_number;
    v_tenant_message := 'اكتملت مراجعة التحويل بنجاح.';
    v_platform_title := 'تم اعتماد تحويل بنكي';
    v_platform_message := 'اعتمد تحويل ' || v_tenant_name || ' للطلب ' || v_order_number || '.';
    -- The paid/service or activated/add-on transition sends the customer mail.
    v_tenant_email := false;
  elsif new.status = 'rejected' then
    v_event_type := 'bank_transfer_rejected';
    v_event_key := 'bank-transfer:' || new.id::text || ':rejected:'
      || new.updated_at::text;
    v_severity := 'danger';
    v_tenant_title := 'تعذر اعتماد التحويل ' || v_order_number;
    v_tenant_message := 'لم يتم اعتماد التحويل. راجع سبب القرار من داخل أودير ثم حدّث البيانات.';
    v_platform_title := 'تم رفض تحويل بنكي';
    v_platform_message := 'رُفض تحويل ' || v_tenant_name || ' للطلب ' || v_order_number || '.';
  elsif new.status = 'cancelled' then
    v_event_type := 'bank_transfer_cancelled';
    v_event_key := 'bank-transfer:' || new.id::text || ':cancelled';
    v_severity := 'warning';
    v_tenant_title := 'تم إلغاء التحويل ' || v_order_number;
    v_tenant_message := 'أُغلق سجل التحويل المرتبط بالطلب.';
    v_platform_title := 'تم إلغاء تحويل بنكي';
    v_platform_message := 'أُلغي تحويل ' || v_tenant_name || ' للطلب ' || v_order_number || '.';
  else
    return new;
  end if;

  perform private_app.lifecycle_notification_capture(
    new.tenant_id,
    v_event_key,
    v_event_type,
    'bank_transfer',
    new.id::text,
    v_severity,
    v_tenant_title,
    v_tenant_message,
    v_platform_title,
    v_platform_message,
    case when v_order_kind = 'service'
      then 'services-store' else 'addons-store' end,
    '/control/payments',
    coalesce(new.submitted_by_subject_id, v_requester),
    v_action_required,
    true,
    true,
    v_tenant_email,
    v_platform_email,
    jsonb_build_object(
      'bankTransferId', new.id,
      'orderId', new.order_id,
      'orderNumber', v_order_number,
      'status', new.status,
      'amountMinor', new.amount_minor,
      'currency', new.currency,
      'productName', (
        select item.product_name_ar
        from marketplace.order_items item
        where item.order_id = new.order_id
        order by item.created_at, item.id
        limit 1
      ),
      'productNameEn', (
        select coalesce(product.name_en, item.metadata ->> 'productNameEn')
        from marketplace.order_items item
        left join catalog.addon_products product
          on product.id = item.addon_product_id
        where item.order_id = new.order_id
        order by item.created_at, item.id
        limit 1
      )
    ),
    now()
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_bank_transfer_notification()
from public, anon, authenticated, service_role;

create or replace function private_app.registration_email_set_locale()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locale text;
begin
  select coalesce(
    tenant.default_locale,
    request.metadata ->> 'locale',
    'ar'
  ) into v_locale
  from platform.registration_requests request
  left join access_control.tenant_invitations invitation
    on invitation.id = new.invitation_id
  left join core.tenants tenant on tenant.id = invitation.tenant_id
  where request.id = new.request_id;
  new.notification_locale := case when lower(coalesce(v_locale, 'ar')) like 'en%'
    then 'en' else 'ar' end;
  return new;
end;
$$;

revoke all on function private_app.registration_email_set_locale()
from public, anon, authenticated, service_role;

drop trigger if exists registration_email_set_locale
on platform.registration_email_deliveries;
create trigger registration_email_set_locale
before insert on platform.registration_email_deliveries
for each row execute function private_app.registration_email_set_locale();

create or replace function private_app.lifecycle_registration_request_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private_app.lifecycle_notification_capture(
    p_tenant_id => null,
    p_event_key => 'registration-request:' || new.id::text || ':submitted',
    p_event_type => 'registration_request_received',
    p_source_type => 'registration_request',
    p_source_id => new.id::text,
    p_severity => 'warning',
    p_tenant_title => 'طلب تسجيل منشأة',
    p_tenant_message => 'تم استلام الطلب.',
    p_platform_title => 'طلب تسجيل منشأة جديد',
    p_platform_message => 'الطلب ' || new.request_reference
      || ' من ' || new.institution_name || ' بانتظار المراجعة.',
    p_tenant_action_path => null,
    p_platform_action_path => '/control/registration-requests',
    p_requested_by_subject_id => null,
    p_action_required => true,
    p_tenant_notify => false,
    p_platform_notify => true,
    p_tenant_email => false,
    p_platform_email => false,
    p_metadata => jsonb_build_object(
      'requestId', new.id,
      'requestReference', new.request_reference,
      'institutionState', new.institution_state,
      'activationMode', new.activation_mode
    ),
    p_occurred_at => new.created_at,
    p_platform_permission_key => 'platform.tenants.manage'
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_registration_request_notification()
from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_registration_email_failure_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_failure_state text;
begin
  if not (
    (new.state = 'terminal_failed' and old.state is distinct from new.state)
    or (
      new.provider_delivery_state in (
        'bounced','suppressed','failed','complained'
      )
      and old.provider_delivery_state is distinct from new.provider_delivery_state
    )
  ) then return new; end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id = new.request_id;
  if v_request.id is null then return new; end if;
  v_failure_state := case when new.state = 'terminal_failed'
    then 'terminal_failed' else new.provider_delivery_state end;

  perform private_app.lifecycle_notification_capture(
    p_tenant_id => null,
    p_event_key => 'registration-email:' || new.id::text || ':' || v_failure_state,
    p_event_type => 'registration_email_failed',
    p_source_type => 'registration_email',
    p_source_id => new.id::text,
    p_severity => 'danger',
    p_tenant_title => 'تعذر تسليم بريد التسجيل',
    p_tenant_message => 'يراجع فريق المنصة حالة التسليم.',
    p_platform_title => 'تعذر تسليم بريد تسجيل',
    p_platform_message => 'فشل بريد ' || new.message_kind || ' للطلب '
      || v_request.request_reference || ' وحالته ' || v_failure_state || '.',
    p_tenant_action_path => null,
    p_platform_action_path => '/control/registration-requests',
    p_requested_by_subject_id => null,
    p_action_required => true,
    p_tenant_notify => false,
    p_platform_notify => true,
    p_tenant_email => false,
    p_platform_email => true,
    p_metadata => jsonb_strip_nulls(jsonb_build_object(
      'deliveryId', new.id,
      'requestId', new.request_id,
      'requestReference', v_request.request_reference,
      'messageKind', new.message_kind,
      'deliveryState', new.state,
      'providerDeliveryState', new.provider_delivery_state,
      'errorCode', new.last_error_code
    )),
    p_occurred_at => now(),
    p_platform_permission_key => 'platform.settings.manage'
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_registration_email_failure_notification()
from public, anon, authenticated, service_role;

create or replace function private_app.lifecycle_email_failure_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event platform.lifecycle_notification_events%rowtype;
  v_failure_state text;
begin
  if not (
    (new.state = 'terminal_failed' and old.state is distinct from new.state)
    or (
      new.provider_state in ('bounced','suppressed','failed','complained')
      and old.provider_state is distinct from new.provider_state
    )
  ) then return new; end if;

  select event.* into v_event
  from platform.lifecycle_notification_events event
  where event.id = new.event_id;
  if v_event.id is null or v_event.event_type = 'lifecycle_email_failed' then
    return new;
  end if;
  v_failure_state := case when new.state = 'terminal_failed'
    then 'terminal_failed' else new.provider_state end;

  perform private_app.lifecycle_notification_capture(
    p_tenant_id => new.tenant_id,
    p_event_key => 'lifecycle-email:' || new.id::text || ':' || v_failure_state,
    p_event_type => 'lifecycle_email_failed',
    p_source_type => 'operational_probe',
    p_source_id => new.id::text,
    p_severity => 'danger',
    p_tenant_title => 'تعذر تسليم إشعار',
    p_tenant_message => 'لا يلزمك إجراء جديد؛ فريق المنصة يتابع التسليم.',
    p_platform_title => 'تعذر تسليم إشعار تشغيلي',
    p_platform_message => 'فشل تسليم ' || v_event.event_type
      || ' وحالته ' || v_failure_state || '.',
    p_tenant_action_path => null,
    p_platform_action_path => '/control/notifications',
    p_requested_by_subject_id => null,
    p_action_required => true,
    p_tenant_notify => false,
    p_platform_notify => true,
    p_tenant_email => false,
    p_platform_email => false,
    p_metadata => jsonb_strip_nulls(jsonb_build_object(
      'deliveryId', new.id,
      'eventId', new.event_id,
      'sourceEventType', v_event.event_type,
      'deliveryState', new.state,
      'providerState', new.provider_state,
      'errorCode', new.last_error_code
    )),
    p_occurred_at => now(),
    p_platform_permission_key => 'platform.settings.manage'
  );
  return new;
end;
$$;

revoke all on function private_app.lifecycle_email_failure_notification()
from public, anon, authenticated, service_role;

drop trigger if exists lifecycle_subscription_notification
on catalog.tenant_addon_subscriptions;
create trigger lifecycle_subscription_notification
after insert or update of status, cancel_at_period_end, period_end
on catalog.tenant_addon_subscriptions
for each row execute function private_app.lifecycle_subscription_notification();

drop trigger if exists lifecycle_order_notification on marketplace.orders;
create trigger lifecycle_order_notification
after insert or update of status, payment_status, activation_state
on marketplace.orders
for each row execute function private_app.lifecycle_order_notification();

drop trigger if exists lifecycle_bank_transfer_notification
on marketplace.bank_transfer_submissions;
create trigger lifecycle_bank_transfer_notification
after insert or update of status, transfer_reference, sender_name, transfer_date
on marketplace.bank_transfer_submissions
for each row execute function private_app.lifecycle_bank_transfer_notification();

drop trigger if exists lifecycle_registration_request_notification
on platform.registration_requests;
create trigger lifecycle_registration_request_notification
after insert on platform.registration_requests
for each row execute function private_app.lifecycle_registration_request_notification();

drop trigger if exists lifecycle_registration_email_failure_notification
on platform.registration_email_deliveries;
create trigger lifecycle_registration_email_failure_notification
after update of state, provider_delivery_state
on platform.registration_email_deliveries
for each row execute function private_app.lifecycle_registration_email_failure_notification();

drop trigger if exists lifecycle_email_failure_notification
on platform.lifecycle_email_deliveries;
create trigger lifecycle_email_failure_notification
after update of state, provider_state
on platform.lifecycle_email_deliveries
for each row execute function private_app.lifecycle_email_failure_notification();

create or replace function public.v1_platform_lifecycle_notification_center(
  p_action text default 'list',
  p_notification_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid;
  v_updated integer;
  v_can_manage_settings boolean;
begin
  if auth.uid() is null
     or not (
       private_app.has_platform_permission('platform.billing.manage')
       or private_app.has_platform_permission('platform.tenants.manage')
       or private_app.has_platform_permission('platform.settings.manage')
       or private_app.has_platform_permission('platform.control.write')
     ) then
    raise exception 'forbidden';
  end if;
  v_subject_id := private_app.current_subject_id();
  if v_subject_id is null then raise exception 'forbidden'; end if;
  v_can_manage_settings :=
    private_app.has_platform_permission('platform.settings.manage')
    or private_app.has_platform_permission('platform.control.write');
  if p_action not in ('list','mark_read','mark_all_read') then
    raise exception 'invalid_notification_action';
  end if;

  if p_action = 'mark_read' then
    if p_notification_id is null then raise exception 'notification_id_required'; end if;
    update platform.lifecycle_notification_inbox notification
    set read_at = coalesce(notification.read_at, now())
    where notification.id = p_notification_id
      and notification.recipient_subject_id = v_subject_id;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then raise exception 'notification_not_found'; end if;
  elsif p_action = 'mark_all_read' then
    update platform.lifecycle_notification_inbox notification
    set read_at = now()
    where notification.recipient_subject_id = v_subject_id
      and notification.read_at is null;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'unreadCount', (
      select count(*)
      from platform.lifecycle_notification_inbox notification
      where notification.recipient_subject_id = v_subject_id
        and notification.read_at is null
    ),
    'actionRequiredCount', (
      select count(*)
      from platform.lifecycle_notification_inbox notification
      join platform.lifecycle_notification_events event
        on event.id = notification.event_id
      where notification.recipient_subject_id = v_subject_id
        and notification.read_at is null
        and event.action_required
    ),
    'canManageSettings', v_can_manage_settings,
    'settings', case when v_can_manage_settings then (
      select jsonb_build_object(
        'captureEnabled', settings.capture_enabled,
        'tenantEmailEnabled', settings.tenant_email_enabled,
        'platformEmailEnabled', settings.platform_email_enabled,
        'operationalMonitorEnabled', settings.operational_monitor_enabled,
        'platformDefaultLocale', settings.platform_default_locale,
        'operationalMonitorScheduled', settings.monitor_cron_job_id is not null,
        'lastWorkerHeartbeatAt', settings.last_worker_heartbeat_at,
        'updatedAt', settings.updated_at
      )
      from platform.lifecycle_notification_settings settings
      where settings.policy_key = 'notification_hub_v2'
    ) else null end,
    'health', case when v_can_manage_settings then jsonb_build_object(
      'registrationWorkerHealthy', coalesce((
        select heartbeat.last_heartbeat_at > now() - interval '5 minutes'
        from platform.registration_email_worker_heartbeat heartbeat
        where heartbeat.singleton
      ), false),
      'registrationWorkerHeartbeatAt', (
        select heartbeat.last_heartbeat_at
        from platform.registration_email_worker_heartbeat heartbeat
        where heartbeat.singleton
      ),
      'lifecycleWorkerHealthy', coalesce((
        select settings.last_worker_heartbeat_at > now() - interval '5 minutes'
        from platform.lifecycle_notification_settings settings
        where settings.policy_key = 'notification_hub_v2'
      ), false),
      'failedEmailCount', (
        select count(*)
        from platform.lifecycle_email_deliveries delivery
        where delivery.state = 'terminal_failed'
          or delivery.provider_state in (
            'bounced','suppressed','failed','complained'
          )
      )
    ) else null end,
    'notifications', coalesce((
      select jsonb_agg(item.payload order by item.created_at desc)
      from (
        select notification.created_at,
          jsonb_build_object(
            'id', notification.id,
            'type', event.event_type,
            'sourceType', event.source_type,
            'sourceId', event.source_id,
            'title', notification.title,
            'message', notification.message,
            'severity', notification.severity,
            'actionUrl', notification.action_url,
            'actionRequired', event.action_required,
            'metadata', event.metadata,
            'readAt', notification.read_at,
            'createdAt', notification.created_at
          ) as payload
        from platform.lifecycle_notification_inbox notification
        join platform.lifecycle_notification_events event
          on event.id = notification.event_id
        where notification.recipient_subject_id = v_subject_id
          and (
            notification.read_at is null
            or notification.created_at >= now() - interval '30 days'
          )
        order by notification.created_at desc
        limit 40
      ) item
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.v1_platform_lifecycle_notification_center(text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_lifecycle_notification_center(text, uuid)
to authenticated;

create or replace function private_app.lifecycle_operational_probe()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings platform.lifecycle_notification_settings%rowtype;
  v_registration_heartbeat timestamptz;
  v_before bigint;
  v_after bigint;
  v_row record;
begin
  select settings.* into v_settings
  from platform.lifecycle_notification_settings settings
  where settings.policy_key = 'notification_hub_v2';
  if v_settings.capture_enabled is not true
     or v_settings.operational_monitor_enabled is not true then
    return jsonb_build_object('enabled', false, 'captured', 0);
  end if;

  select count(*) into v_before
  from platform.lifecycle_notification_events;
  select heartbeat.last_heartbeat_at into v_registration_heartbeat
  from platform.registration_email_worker_heartbeat heartbeat
  where heartbeat.singleton;

  if v_registration_heartbeat is null
     or v_registration_heartbeat <= now() - interval '5 minutes' then
    perform private_app.lifecycle_notification_capture(
      p_tenant_id => null,
      p_event_key => 'probe:registration-worker-stale:'
        || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
      p_event_type => 'registration_email_worker_stale',
      p_source_type => 'operational_probe',
      p_source_id => 'registration_email_worker',
      p_severity => 'danger',
      p_tenant_title => 'عامل بريد التسجيل متوقف',
      p_tenant_message => 'يتابع فريق المنصة حالة البريد.',
      p_platform_title => 'عامل بريد التسجيل لا يرسل نبضًا',
      p_platform_message => 'لم يصل نبض عامل بريد التسجيل خلال خمس دقائق.',
      p_tenant_action_path => null,
      p_platform_action_path => '/control/notifications',
      p_action_required => true,
      p_tenant_notify => false,
      p_platform_notify => true,
      p_tenant_email => false,
      p_platform_email => true,
      p_metadata => jsonb_strip_nulls(jsonb_build_object(
        'lastHeartbeatAt', v_registration_heartbeat,
        'thresholdMinutes', 5
      )),
      p_platform_permission_key => 'platform.settings.manage'
    );
  end if;

  if v_settings.last_worker_heartbeat_at is null
     or v_settings.last_worker_heartbeat_at <= now() - interval '5 minutes' then
    perform private_app.lifecycle_notification_capture(
      p_tenant_id => null,
      p_event_key => 'probe:lifecycle-worker-stale:'
        || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
      p_event_type => 'lifecycle_email_worker_stale',
      p_source_type => 'operational_probe',
      p_source_id => 'lifecycle_email_worker',
      p_severity => 'danger',
      p_tenant_title => 'عامل إشعارات دورة الحياة متوقف',
      p_tenant_message => 'يتابع فريق المنصة حالة الإشعارات.',
      p_platform_title => 'عامل إشعارات دورة الحياة لا يرسل نبضًا',
      p_platform_message => 'لم يصل نبض عامل الإضافات والمشتريات خلال خمس دقائق.',
      p_tenant_action_path => null,
      p_platform_action_path => '/control/notifications',
      p_action_required => true,
      p_tenant_notify => false,
      p_platform_notify => true,
      p_tenant_email => false,
      p_platform_email => true,
      p_metadata => jsonb_strip_nulls(jsonb_build_object(
        'lastHeartbeatAt', v_settings.last_worker_heartbeat_at,
        'thresholdMinutes', 5
      )),
      p_platform_permission_key => 'platform.settings.manage'
    );
  end if;

  for v_row in
    select orders.id, orders.tenant_id, orders.order_number,
      orders.requested_by_subject_id, orders.updated_at,
      tenant.name as tenant_name
    from marketplace.orders orders
    join core.tenants tenant on tenant.id = orders.tenant_id
    where orders.payment_status = 'paid'
      and orders.activation_state = 'pending'
      and orders.updated_at <= now() - interval '15 minutes'
    order by orders.updated_at
    limit 200
  loop
    perform private_app.lifecycle_notification_capture(
      p_tenant_id => v_row.tenant_id,
      p_event_key => 'probe:activation-stalled:' || v_row.id::text,
      p_event_type => 'purchase_activation_stalled',
      p_source_type => 'operational_probe',
      p_source_id => v_row.id::text,
      p_severity => 'danger',
      p_tenant_title => 'تأخر تفعيل الطلب ' || v_row.order_number,
      p_tenant_message => 'تم تسجيل التأخير ويجري التعامل معه؛ لا تُعد عملية الشراء.',
      p_platform_title => 'تفعيل طلب مدفوع متعثر',
      p_platform_message => 'طلب ' || v_row.tenant_name || ' رقم '
        || v_row.order_number || ' لم يتفعّل خلال 15 دقيقة.',
      p_tenant_action_path => 'addons-store',
      p_platform_action_path => '/control/marketplace',
      p_requested_by_subject_id => v_row.requested_by_subject_id,
      p_action_required => true,
      p_tenant_notify => true,
      p_platform_notify => true,
      p_tenant_email => false,
      p_platform_email => true,
      p_metadata => jsonb_build_object(
        'orderId', v_row.id,
        'orderNumber', v_row.order_number,
        'activationThresholdMinutes', 15
      ),
      p_platform_permission_key => 'platform.billing.manage'
    );
  end loop;

  select count(*) into v_after
  from platform.lifecycle_notification_events;
  return jsonb_build_object(
    'enabled', true,
    'captured', greatest(v_after - v_before, 0),
    'probedAt', now()
  );
end;
$$;

revoke all on function private_app.lifecycle_operational_probe()
from public, anon, authenticated, service_role;

create or replace function public.v1_lifecycle_operational_probe()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'forbidden';
  end if;
  return private_app.lifecycle_operational_probe();
end;
$$;

revoke all on function public.v1_lifecycle_operational_probe()
from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_operational_probe()
to service_role;

create or replace function public.v1_platform_lifecycle_notification_settings(
  p_capture_enabled boolean,
  p_tenant_email_enabled boolean,
  p_platform_email_enabled boolean,
  p_operational_monitor_enabled boolean,
  p_platform_default_locale text default 'ar'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_subject_id uuid;
  v_settings platform.lifecycle_notification_settings%rowtype;
  v_job_id bigint;
  v_has_cron boolean;
begin
  if auth.uid() is null or not (
    private_app.has_platform_permission('platform.settings.manage')
    or private_app.has_platform_permission('platform.control.write')
  ) then raise exception 'forbidden'; end if;
  if p_platform_default_locale not in ('ar','en') then
    raise exception 'notification_locale_invalid';
  end if;
  if not coalesce(p_capture_enabled, false) and (
    coalesce(p_tenant_email_enabled, false)
    or coalesce(p_platform_email_enabled, false)
    or coalesce(p_operational_monitor_enabled, false)
  ) then raise exception 'notification_capture_required'; end if;

  v_subject_id := private_app.current_subject_id();
  if v_subject_id is null then raise exception 'forbidden'; end if;
  select settings.* into v_settings
  from platform.lifecycle_notification_settings settings
  where settings.policy_key = 'notification_hub_v2'
  for update;

  select exists (
    select 1 from pg_catalog.pg_extension extension
    where extension.extname = 'pg_cron'
  ) into v_has_cron;
  v_job_id := v_settings.monitor_cron_job_id;

  if not coalesce(p_operational_monitor_enabled, false)
     and v_job_id is not null and v_has_cron then
    execute 'select cron.unschedule($1)' using v_job_id;
    v_job_id := null;
  elsif coalesce(p_operational_monitor_enabled, false)
        and v_job_id is null and v_has_cron then
    execute $schedule$
      select cron.schedule(
        'odeir-notification-operational-probe',
        '*/5 * * * *',
        'select private_app.lifecycle_operational_probe();'
      )
    $schedule$ into v_job_id;
  end if;

  update platform.lifecycle_notification_settings settings
  set capture_enabled = coalesce(p_capture_enabled, false),
      tenant_email_enabled = coalesce(p_tenant_email_enabled, false),
      platform_email_enabled = coalesce(p_platform_email_enabled, false),
      operational_monitor_enabled = coalesce(
        p_operational_monitor_enabled, false
      ),
      platform_default_locale = p_platform_default_locale,
      monitor_cron_job_id = v_job_id,
      updated_by_subject_id = v_subject_id,
      updated_at = now()
  where settings.policy_key = 'notification_hub_v2'
  returning * into v_settings;

  return jsonb_build_object(
    'captureEnabled', v_settings.capture_enabled,
    'tenantEmailEnabled', v_settings.tenant_email_enabled,
    'platformEmailEnabled', v_settings.platform_email_enabled,
    'operationalMonitorEnabled', v_settings.operational_monitor_enabled,
    'platformDefaultLocale', v_settings.platform_default_locale,
    'operationalMonitorScheduled', v_settings.monitor_cron_job_id is not null,
    'updatedAt', v_settings.updated_at
  );
end;
$$;

revoke all on function public.v1_platform_lifecycle_notification_settings(
  boolean, boolean, boolean, boolean, text
) from public, anon, authenticated, service_role;
grant execute on function public.v1_platform_lifecycle_notification_settings(
  boolean, boolean, boolean, boolean, text
) to authenticated;

create or replace function public.v1_lifecycle_notification_sweep()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_before bigint;
  v_after bigint;
  v_row record;
  v_capture_enabled boolean;
begin
  update platform.lifecycle_notification_settings settings
  set last_worker_heartbeat_at = now(), updated_at = now()
  where settings.policy_key = 'notification_hub_v2'
  returning settings.capture_enabled into v_capture_enabled;
  if v_capture_enabled is not true then
    return jsonb_build_object(
      'captured', 0,
      'enabled', false,
      'heartbeatAt', now()
    );
  end if;

  select count(*) into v_before
  from platform.lifecycle_notification_events;

  for v_row in
    select orders.*, tenant.name as tenant_name
    from marketplace.orders orders
    join core.tenants tenant on tenant.id = orders.tenant_id
    where orders.status = 'pending_payment'
      and orders.payment_status = 'pending'
      and orders.created_at <= now() - interval '24 hours'
    order by orders.created_at
    limit 200
  loop
    perform private_app.lifecycle_notification_capture(
      v_row.tenant_id,
      'sweep:payment-reminder-24h:' || v_row.id::text,
      'purchase_payment_reminder',
      'lifecycle_sweep',
      v_row.id::text,
      'warning',
      'تذكير بإكمال الطلب ' || v_row.order_number,
      'طلب الشراء ما زال بانتظار الدفع. يمكنك إكماله من المتجر.',
      'طلب شراء ما زال بانتظار الدفع',
      v_row.tenant_name || ' لم تكمل دفع الطلب ' || v_row.order_number || '.',
      case when v_row.order_kind = 'addon' then 'addons-store' else 'services-store' end,
      '/control/marketplace',
      v_row.requested_by_subject_id,
      false, true, true, true, false,
      jsonb_build_object(
        'orderId', v_row.id,
        'orderNumber', v_row.order_number,
        'totalMinor', v_row.total_minor,
        'currency', v_row.currency,
        'reminderThresholdHours', 24
      ),
      now()
    );
  end loop;

  for v_row in
    select subscription.*, product.name_ar as product_name,
      tenant.name as tenant_name
    from catalog.tenant_addon_subscriptions subscription
    join catalog.addon_products product on product.id = subscription.product_id
    join core.tenants tenant on tenant.id = subscription.tenant_id
    where subscription.status = 'trialing'
      and subscription.trial_end > now()
      and subscription.trial_end <= now() + interval '3 days'
    order by subscription.trial_end
    limit 200
  loop
    perform private_app.lifecycle_notification_capture(
      v_row.tenant_id,
      'sweep:trial-expiring-3d:' || v_row.id::text,
      'addon_trial_expiring',
      'lifecycle_sweep',
      v_row.id::text,
      'warning',
      'تجربة ' || v_row.product_name || ' تقترب من الانتهاء',
      'تنتهي الفترة التجريبية خلال ثلاثة أيام. راجع خيارات الاستمرار.',
      'تجربة إضافة تقترب من الانتهاء',
      'تجربة ' || v_row.product_name || ' لدى ' || v_row.tenant_name || ' تنتهي خلال ثلاثة أيام.',
      'addons', '/control/addons', v_row.requested_by_subject_id,
      false, true, true, true, false,
      jsonb_build_object(
        'subscriptionId', v_row.id,
        'productName', v_row.product_name,
        'trialEnd', v_row.trial_end,
        'reminderThresholdDays', 3
      ),
      now()
    );
  end loop;

  for v_row in
    select subscription.*, product.name_ar as product_name,
      tenant.name as tenant_name
    from catalog.tenant_addon_subscriptions subscription
    join catalog.addon_products product on product.id = subscription.product_id
    join core.tenants tenant on tenant.id = subscription.tenant_id
    where subscription.status in ('active','paused')
      and subscription.period_end > now()
      and subscription.period_end <= now() + interval '7 days'
      and subscription.auto_renew is not true
    order by subscription.period_end
    limit 200
  loop
    perform private_app.lifecycle_notification_capture(
      v_row.tenant_id,
      'sweep:subscription-expiring-7d:' || v_row.id::text,
      'addon_subscription_expiring',
      'lifecycle_sweep',
      v_row.id::text,
      'warning',
      'اشتراك ' || v_row.product_name || ' يقترب من الانتهاء',
      'تنتهي مدة الإضافة خلال سبعة أيام. راجع التجديد لتجنب توقفها.',
      'اشتراك إضافة يقترب من الانتهاء',
      'اشتراك ' || v_row.product_name || ' لدى ' || v_row.tenant_name || ' ينتهي خلال سبعة أيام.',
      'addons', '/control/addons', v_row.requested_by_subject_id,
      false, true, true, true, false,
      jsonb_build_object(
        'subscriptionId', v_row.id,
        'productName', v_row.product_name,
        'periodEnd', v_row.period_end,
        'reminderThresholdDays', 7
      ),
      now()
    );
  end loop;

  for v_row in
    select transfer.*, orders.order_number, orders.requested_by_subject_id,
      tenant.name as tenant_name
    from marketplace.bank_transfer_submissions transfer
    join marketplace.orders orders on orders.id = transfer.order_id
    join core.tenants tenant on tenant.id = transfer.tenant_id
    where transfer.status in ('pending','reviewing')
      and transfer.created_at <= now() - interval '24 hours'
    order by transfer.created_at
    limit 200
  loop
    perform private_app.lifecycle_notification_capture(
      v_row.tenant_id,
      'sweep:bank-transfer-overdue-24h:' || v_row.id::text,
      'bank_transfer_review_overdue',
      'lifecycle_sweep',
      v_row.id::text,
      'danger',
      'التحويل البنكي قيد المراجعة',
      'لا يلزمك إجراء جديد؛ فريق المنصة يتابع التحويل.',
      'تحويل بنكي متأخر عن المراجعة',
      'تحويل ' || v_row.tenant_name || ' للطلب ' || v_row.order_number || ' تجاوز 24 ساعة.',
      'addons-store', '/control/payments', v_row.requested_by_subject_id,
      true, false, true, false, true,
      jsonb_build_object(
        'bankTransferId', v_row.id,
        'orderId', v_row.order_id,
        'orderNumber', v_row.order_number,
        'reviewThresholdHours', 24
      ),
      now()
    );
  end loop;

  perform private_app.lifecycle_operational_probe();

  select count(*) into v_after
  from platform.lifecycle_notification_events;
  return jsonb_build_object(
    'captured', greatest(v_after - v_before, 0),
    'enabled', true,
    'heartbeatAt', now()
  );
end;
$$;

revoke all on function public.v1_lifecycle_notification_sweep()
from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_notification_sweep()
to service_role;

create or replace function public.v1_lifecycle_email_delivery_due_ids(
  p_limit integer default 10
)
returns table (delivery_id uuid)
language sql
security definer
set search_path = ''
as $$
  select delivery.id
  from platform.lifecycle_email_deliveries delivery
  where (
    delivery.state in ('queued','retryable')
    and delivery.retry_at <= now()
  ) or (
    delivery.state = 'leased'
    and delivery.lease_expires_at < now()
  )
  order by delivery.retry_at, delivery.created_at, delivery.id
  limit greatest(1, least(coalesce(p_limit, 10), 20))
$$;

revoke all on function public.v1_lifecycle_email_delivery_due_ids(integer)
from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_email_delivery_due_ids(integer)
to service_role;

create or replace function public.v1_lifecycle_email_delivery_claim(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery platform.lifecycle_email_deliveries%rowtype;
  v_event platform.lifecycle_notification_events%rowtype;
  v_subject access_control.subjects%rowtype;
  v_tenant core.tenants%rowtype;
  v_settings platform.lifecycle_notification_settings%rowtype;
  v_lease_id uuid;
  v_allowed boolean := false;
  v_metadata jsonb;
  v_product_name text;
begin
  select delivery.* into v_delivery
  from platform.lifecycle_email_deliveries delivery
  where delivery.id = p_delivery_id
  for update skip locked;
  if v_delivery.id is null then
    return jsonb_build_object('sendRequired', false, 'state', 'unavailable');
  end if;
  if v_delivery.state in ('accepted','terminal_failed','cancelled') then
    return jsonb_build_object('sendRequired', false, 'state', v_delivery.state);
  end if;
  if v_delivery.state in ('queued','retryable') and v_delivery.retry_at > now() then
    return jsonb_build_object('sendRequired', false, 'state', v_delivery.state);
  end if;
  if v_delivery.state = 'leased' and v_delivery.lease_expires_at >= now() then
    return jsonb_build_object('sendRequired', false, 'state', 'leased');
  end if;

  select settings.* into v_settings
  from platform.lifecycle_notification_settings settings
  where settings.policy_key = 'notification_hub_v2';
  if v_settings.capture_enabled is not true
     or (v_delivery.audience = 'tenant' and v_settings.tenant_email_enabled is not true)
     or (v_delivery.audience = 'platform' and v_settings.platform_email_enabled is not true) then
    update platform.lifecycle_email_deliveries delivery
    set state = 'cancelled', lease_id = null, lease_expires_at = null,
      last_error_code = 'lifecycle_email_policy_disabled', updated_at = now()
    where delivery.id = v_delivery.id;
    return jsonb_build_object('sendRequired', false, 'state', 'cancelled');
  end if;

  select event.* into v_event
  from platform.lifecycle_notification_events event
  where event.id = v_delivery.event_id;
  select subject.* into v_subject
  from access_control.subjects subject
  where subject.id = v_delivery.recipient_subject_id
    and subject.status = 'active';
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id = v_delivery.tenant_id;

  if v_event.id is null or v_subject.id is null
     or (v_delivery.audience = 'tenant' and v_tenant.id is null)
     or v_subject.email <> lower(trim(v_subject.email))
     or v_subject.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    update platform.lifecycle_email_deliveries delivery
    set state = 'terminal_failed', failed_at = now(),
      lease_id = null, lease_expires_at = null,
      last_error_code = 'lifecycle_recipient_unavailable', updated_at = now()
    where delivery.id = v_delivery.id;
    return jsonb_build_object('sendRequired', false, 'state', 'terminal_failed');
  end if;

  if v_delivery.audience = 'tenant' then
    select exists (
      select 1
      from access_control.memberships membership
      where membership.subject_id = v_subject.id
        and membership.scope = 'tenant'
        and membership.tenant_id = v_delivery.tenant_id
        and membership.status = 'active'
        and (
          membership.subject_id = v_event.requested_by_subject_id
          or exists (
            select 1
            from access_control.membership_roles owner_membership_role
            join access_control.roles owner_role
              on owner_role.id = owner_membership_role.role_id
             and owner_role.scope = 'tenant'
             and owner_role.role_key = 'tenant_owner'
            where owner_membership_role.membership_id = membership.id
          )
        )
    ) into v_allowed;
  else
    select exists (
      select 1
      from access_control.memberships membership
      join access_control.membership_roles membership_role
        on membership_role.membership_id = membership.id
      join access_control.role_permissions role_permission
        on role_permission.role_id = membership_role.role_id
       and role_permission.permission_key = v_event.platform_permission_key
      where membership.subject_id = v_subject.id
        and membership.scope = 'platform'
        and membership.status = 'active'
    ) into v_allowed;
  end if;
  if not v_allowed then
    update platform.lifecycle_email_deliveries delivery
    set state = 'cancelled', lease_id = null, lease_expires_at = null,
      last_error_code = 'lifecycle_recipient_access_revoked', updated_at = now()
    where delivery.id = v_delivery.id;
    return jsonb_build_object('sendRequired', false, 'state', 'cancelled');
  end if;

  v_metadata := v_event.metadata;
  if nullif(trim(v_metadata ->> 'productName'), '') is null then
    select item.product_name_ar into v_product_name
    from marketplace.order_items item
    where item.order_id::text = v_metadata ->> 'orderId'
    order by item.created_at, item.id
    limit 1;
    if nullif(trim(v_product_name), '') is not null then
      v_metadata := v_metadata || jsonb_build_object(
        'productName', v_product_name
      );
    end if;
  end if;

  v_lease_id := gen_random_uuid();
  update platform.lifecycle_email_deliveries delivery
  set state = 'leased', attempt_count = delivery.attempt_count + 1,
    lease_id = v_lease_id, lease_expires_at = now() + interval '2 minutes',
    last_error_code = null, updated_at = now()
  where delivery.id = v_delivery.id
  returning * into v_delivery;

  return jsonb_build_object(
    'sendRequired', true,
    'deliveryId', v_delivery.id,
    'leaseId', v_lease_id,
    'attemptNumber', v_delivery.attempt_count,
    'idempotencyKey', v_delivery.idempotency_key,
    'templateKey', v_delivery.template_key,
    'locale', v_delivery.locale,
    'audience', v_delivery.audience,
    'recipient', v_subject.email,
    'recipientName', v_subject.full_name,
    'eventType', v_event.event_type,
    'severity', v_event.severity,
    'title', case when v_delivery.audience = 'platform'
      then v_event.platform_title else v_event.tenant_title end,
    'message', case when v_delivery.audience = 'platform'
      then v_event.platform_message else v_event.tenant_message end,
    'actionUrl', case when v_delivery.audience = 'platform'
      then v_event.platform_action_path
      else '/tenant/' || v_tenant.slug || '/' || v_event.tenant_action_path end,
    'tenantName', coalesce(v_tenant.name, 'Odeir Platform'),
    'tenantSlug', v_tenant.slug,
    'metadata', v_metadata
  );
end;
$$;

revoke all on function public.v1_lifecycle_email_delivery_claim(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_email_delivery_claim(uuid)
to service_role;

create or replace function public.v1_lifecycle_email_delivery_finish(
  p_delivery_id uuid,
  p_lease_id uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_http_status integer default null,
  p_error_code text default null,
  p_retry_after_seconds integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery platform.lifecycle_email_deliveries%rowtype;
  v_retry_seconds integer;
begin
  if p_outcome not in ('accepted','retryable','terminal_failed') then
    raise exception 'lifecycle_delivery_outcome_invalid';
  end if;
  select delivery.* into v_delivery
  from platform.lifecycle_email_deliveries delivery
  where delivery.id = p_delivery_id
  for update;
  if v_delivery.id is null then raise exception 'lifecycle_delivery_not_found'; end if;
  if v_delivery.state = 'accepted' then
    return jsonb_build_object('state', 'accepted', 'duplicate', true);
  end if;
  if v_delivery.state <> 'leased' or v_delivery.lease_id is distinct from p_lease_id then
    raise exception 'lifecycle_delivery_lease_invalid';
  end if;

  insert into platform.lifecycle_email_delivery_attempts (
    delivery_id, attempt_number, outcome, provider_message_id,
    http_status, error_code
  ) values (
    v_delivery.id, v_delivery.attempt_count, p_outcome,
    nullif(trim(p_provider_message_id), ''), p_http_status,
    left(nullif(trim(p_error_code), ''), 120)
  )
  on conflict (delivery_id, attempt_number) do nothing;

  if p_outcome = 'accepted' then
    if nullif(trim(p_provider_message_id), '') is null
       or trim(p_provider_message_id) !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$' then
      raise exception 'lifecycle_provider_message_required';
    end if;
    update platform.lifecycle_email_deliveries delivery
    set state = 'accepted', provider_message_id = trim(p_provider_message_id),
      provider_state = 'sent', accepted_at = now(),
      lease_id = null, lease_expires_at = null, last_error_code = null,
      updated_at = now()
    where delivery.id = v_delivery.id;
  elsif p_outcome = 'retryable' and v_delivery.attempt_count < 8 then
    v_retry_seconds := greatest(30, least(
      coalesce(p_retry_after_seconds, 30 * (2 ^ least(v_delivery.attempt_count, 6))::integer),
      3600
    ));
    update platform.lifecycle_email_deliveries delivery
    set state = 'retryable', retry_at = now() + make_interval(secs => v_retry_seconds),
      lease_id = null, lease_expires_at = null,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'lifecycle_delivery_retryable'), 120),
      updated_at = now()
    where delivery.id = v_delivery.id;
  else
    update platform.lifecycle_email_deliveries delivery
    set state = 'terminal_failed', failed_at = now(),
      lease_id = null, lease_expires_at = null,
      last_error_code = left(coalesce(nullif(trim(p_error_code), ''), 'lifecycle_delivery_failed'), 120),
      updated_at = now()
    where delivery.id = v_delivery.id;
  end if;

  select delivery.* into v_delivery
  from platform.lifecycle_email_deliveries delivery
  where delivery.id = p_delivery_id;
  return jsonb_build_object(
    'deliveryId', v_delivery.id,
    'state', v_delivery.state,
    'attemptCount', v_delivery.attempt_count,
    'retryAt', v_delivery.retry_at
  );
end;
$$;

revoke all on function public.v1_lifecycle_email_delivery_finish(
  uuid, uuid, text, text, integer, text, integer
) from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_email_delivery_finish(
  uuid, uuid, text, text, integer, text, integer
) to service_role;

create or replace function public.v1_lifecycle_email_delivery_record_event(
  p_provider_message_id text,
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery platform.lifecycle_email_deliveries%rowtype;
  v_inserted uuid;
  v_existing platform.lifecycle_email_webhook_events%rowtype;
begin
  if p_provider_message_id is null
     or p_provider_message_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,239}$'
     or p_event_id is null
     or p_event_id !~ '^[A-Za-z0-9_-]{8,160}$'
     or p_event_type not in (
       'email.sent','email.delivered','email.delivery_delayed',
       'email.bounced','email.complained','email.failed','email.suppressed'
     )
     or p_occurred_at is null
     or p_occurred_at < '2000-01-01'::timestamptz
     or p_occurred_at > now() + interval '5 minutes' then
    raise exception 'lifecycle_email_webhook_invalid';
  end if;
  select delivery.* into v_delivery
  from platform.lifecycle_email_deliveries delivery
  where delivery.provider = 'resend'
    and delivery.provider_message_id = p_provider_message_id
  for update;
  if v_delivery.id is null then
    return jsonb_build_object('matched', false, 'duplicate', false);
  end if;

  insert into platform.lifecycle_email_webhook_events (
    event_id, delivery_id, provider_message_id, event_type, occurred_at
  ) values (
    left(trim(p_event_id), 160), v_delivery.id, p_provider_message_id,
    p_event_type, p_occurred_at
  )
  on conflict (event_id) do nothing
  returning delivery_id into v_inserted;
  if v_inserted is null then
    select webhook.* into v_existing
    from platform.lifecycle_email_webhook_events webhook
    where webhook.event_id = left(trim(p_event_id), 160);
    if v_existing.provider_message_id <> p_provider_message_id
       or v_existing.event_type <> p_event_type
       or v_existing.occurred_at <> p_occurred_at then
      raise exception 'lifecycle_email_webhook_replay_mismatch';
    end if;
    return jsonb_build_object('matched', true, 'duplicate', true);
  end if;

  update platform.lifecycle_email_deliveries delivery
  set provider_state = case p_event_type
      when 'email.delivered' then 'delivered'
      when 'email.bounced' then 'bounced'
      when 'email.complained' then 'complained'
      when 'email.failed' then 'failed'
      when 'email.suppressed' then 'suppressed'
      when 'email.delivery_delayed' then 'delayed'
      else 'sent'
    end,
    delivered_at = case when p_event_type = 'email.delivered'
      then coalesce(delivery.delivered_at, p_occurred_at) else delivery.delivered_at end,
    failed_at = case when p_event_type in (
      'email.bounced','email.complained','email.failed','email.suppressed'
    ) then coalesce(delivery.failed_at, p_occurred_at) else delivery.failed_at end,
    updated_at = now()
  where delivery.id = v_delivery.id;
  return jsonb_build_object('matched', true, 'duplicate', false);
end;
$$;

revoke all on function public.v1_lifecycle_email_delivery_record_event(
  text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function public.v1_lifecycle_email_delivery_record_event(
  text, text, text, timestamptz
) to service_role;

-- Locale is appended outside the proven v2 registration delivery state
-- machine.  No token, lease or idempotency behavior is changed.
create or replace function public.v3_registration_email_delivery_claim(
  p_delivery_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claim jsonb;
  v_locale text;
begin
  v_claim := public.v2_registration_email_delivery_claim(p_delivery_id);
  select delivery.notification_locale into v_locale
  from platform.registration_email_deliveries delivery
  where delivery.id = p_delivery_id;
  return coalesce(v_claim, '{}'::jsonb)
    || jsonb_build_object('locale', coalesce(v_locale, 'ar'));
end;
$$;

revoke all on function public.v3_registration_email_delivery_claim(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.v3_registration_email_delivery_claim(uuid)
to service_role;

comment on table platform.lifecycle_notification_events is
'PII-minimized, idempotent registration, commerce and operational event ledger. Capture is disabled by default and performs no network I/O.';
comment on table platform.lifecycle_email_deliveries is
'Durable recipient-subject outbox. Email addresses and rendered bodies are resolved only while a service-role worker holds a lease.';
comment on function public.v1_platform_lifecycle_notification_center(text, uuid) is
'Authenticated platform inbox. Every read and acknowledgement is restricted to the current subject.';
comment on function public.v1_platform_lifecycle_notification_settings(
  boolean, boolean, boolean, boolean, text
) is
'Explicit, authorized rollout switch. Capture, tenant mail, platform mail and the independent health monitor all default off.';

commit;
