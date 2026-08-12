-- Route every newly-seen WooCommerce order to one tenant-scoped work task.
-- Historical external orders stay untouched; enabled_at is the cutover fence.
begin;

do $deployment_gate$
begin
  if exists (
    select 1
    from commerce_sync.sync_runs run
    where run.status = 'running'
  ) then
    raise exception 'woocommerce_order_routing_deployment_running_run';
  end if;
end;
$deployment_gate$;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values (
  'tenant.commerce_orders.distribute',
  'crm',
  'توزيع طلبات المتجر',
  'عرض صف طلبات التجارة وإسناد مهامها وإدارة التوزيع التلقائي'
)
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, 'tenant.commerce_orders.distribute'
from access_control.roles role
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager',
    'sales_manager',
    'sales_supervisor',
    'data_officer'
  )
on conflict do nothing;

create table sales_core.commerce_order_routing_settings (
  tenant_id uuid primary key
    references core.tenants(id) on delete cascade,
  routing_mode text not null default 'queue'
    check (routing_mode in ('queue', 'auto_fair', 'auto_online')),
  queue_owner_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  default_due_minutes integer not null default 60
    check (default_due_minutes between 5 and 10080),
  enabled_at timestamptz not null default now(),
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table sales_core.commerce_order_work_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  connection_id uuid not null
    references commerce_sync.connections(id) on delete cascade,
  external_entity_id uuid not null
    references commerce_sync.external_entities(id) on delete cascade,
  external_order_id text not null
    check (length(trim(external_order_id)) between 1 and 255),
  task_id uuid references work_core.tasks(id) on delete set null,
  contact_id uuid references sales_core.contacts(id) on delete set null,
  assigned_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  routing_state text not null default 'awaiting_distribution'
    check (routing_state in (
      'awaiting_distribution',
      'assigned',
      'error'
    )),
  assignment_strategy text not null default 'queue'
    check (assignment_strategy in (
      'queue',
      'queue_fallback',
      'existing_owner',
      'fair',
      'online_only',
      'selected'
    )),
  order_number text not null,
  order_status text not null,
  payment_state text not null default 'unpaid'
    check (payment_state in ('unpaid', 'paid', 'refunded', 'unknown')),
  amount_minor bigint check (amount_minor is null or amount_minor >= 0),
  currency text not null default 'SAR'
    check (currency ~ '^[A-Z]{3}$'),
  minor_digits integer not null default 2
    check (minor_digits between 0 and 3),
  customer_name text,
  customer_phone text,
  customer_email text,
  order_created_at timestamptz,
  paid_at timestamptz,
  assigned_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_error text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, external_order_id),
  unique (external_entity_id)
);

create index commerce_order_settings_queue_owner_idx
on sales_core.commerce_order_routing_settings (queue_owner_staff_id)
where queue_owner_staff_id is not null;

create index commerce_order_settings_updater_idx
on sales_core.commerce_order_routing_settings (updated_by_subject_id)
where updated_by_subject_id is not null;

create index commerce_order_work_items_tenant_queue_idx
on sales_core.commerce_order_work_items (
  tenant_id,
  routing_state,
  first_seen_at,
  id
);

create index commerce_order_work_items_open_queue_idx
on sales_core.commerce_order_work_items (
  tenant_id,
  first_seen_at,
  id
)
where routing_state = 'awaiting_distribution';

create index commerce_order_work_items_staff_day_idx
on sales_core.commerce_order_work_items (
  tenant_id,
  assigned_staff_id,
  assigned_at
)
where assigned_staff_id is not null;

create index commerce_order_work_items_task_idx
on sales_core.commerce_order_work_items (task_id)
where task_id is not null;

create index commerce_order_work_items_contact_idx
on sales_core.commerce_order_work_items (contact_id)
where contact_id is not null;

create index commerce_order_work_items_connection_idx
on sales_core.commerce_order_work_items (
  connection_id,
  last_seen_at desc
);

create index commerce_order_work_items_assignee_idx
on sales_core.commerce_order_work_items (assigned_staff_id)
where assigned_staff_id is not null;

create trigger commerce_order_routing_settings_set_updated_at
before update on sales_core.commerce_order_routing_settings
for each row execute function private_app.set_updated_at();

create trigger commerce_order_work_items_set_updated_at
before update on sales_core.commerce_order_work_items
for each row execute function private_app.set_updated_at();

alter table sales_core.commerce_order_routing_settings
enable row level security;
alter table sales_core.commerce_order_work_items
enable row level security;

create policy commerce_order_routing_settings_isolated_read
on sales_core.commerce_order_routing_settings
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy commerce_order_work_items_isolated_read
on sales_core.commerce_order_work_items
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table sales_core.commerce_order_routing_settings
from public, anon, authenticated;
revoke all on table sales_core.commerce_order_work_items
from public, anon, authenticated;

create or replace function private_app.commerce_order_queue_owner(
  p_tenant_id uuid,
  p_preferred_staff_id uuid default null
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select staff.id
  from people.staff_profiles staff
  where staff.tenant_id = p_tenant_id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_manager',
      'sales_supervisor',
      'data_officer'
    )
  order by
    (staff.id = p_preferred_staff_id) desc,
    case staff.role_key
      when 'sales_manager' then 0
      when 'sales_supervisor' then 1
      else 2
    end,
    staff.id
  limit 1
$$;

create or replace function private_app.commerce_order_pick_assignee(
  p_tenant_id uuid,
  p_mode text
)
returns uuid
language sql
volatile
security invoker
set search_path = ''
as $$
  select staff.id
  from people.staff_profiles staff
  join sales_core.sales_assignment_profiles profile
    on profile.tenant_id = staff.tenant_id
   and profile.staff_id = staff.id
  where staff.tenant_id = p_tenant_id
    and staff.employment_status = 'active'
    and staff.role_key in (
      'sales_user',
      'sales_supervisor',
      'sales_manager'
    )
    and profile.eligible_for_leads
    and (
      p_mode <> 'auto_online'
      or profile.sales_channel in ('online', 'hybrid')
    )
    and (
      (
        select count(*)
        from sales_core.lead_assignments assignment
        join core.tenants tenant on tenant.id = assignment.tenant_id
        where assignment.tenant_id = p_tenant_id
          and assignment.assigned_staff_id = staff.id
          and (
            assignment.assigned_at at time zone tenant.timezone
          )::date = (
            clock_timestamp() at time zone tenant.timezone
          )::date
      ) + (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        join core.tenants tenant on tenant.id = work_item.tenant_id
        where work_item.tenant_id = p_tenant_id
          and work_item.assigned_staff_id = staff.id
          and work_item.assigned_at is not null
          and (
            work_item.assigned_at at time zone tenant.timezone
          )::date = (
            clock_timestamp() at time zone tenant.timezone
          )::date
      )
    ) < profile.daily_capacity
  order by
    (
      (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = p_tenant_id
          and assignment.assigned_staff_id = staff.id
          and assignment.status = 'active'
          and assignment.first_action_at is null
      ) + (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        join work_core.tasks task on task.id = work_item.task_id
        where work_item.tenant_id = p_tenant_id
          and work_item.assigned_staff_id = staff.id
          and task.status in ('todo', 'in_progress')
      )
    )::numeric / greatest(profile.weight, 1),
    profile.last_assigned_at nulls first,
    staff.id
  limit 1
$$;

revoke all on function private_app.commerce_order_queue_owner(uuid, uuid)
from public, anon, authenticated;
revoke all on function private_app.commerce_order_pick_assignee(uuid, text)
from public, anon, authenticated;

-- Establish the cutover before any post-deployment order page can be stored.
-- Existing external entities have an older created_at and are never backfilled.
insert into sales_core.commerce_order_routing_settings (
  tenant_id,
  routing_mode,
  queue_owner_staff_id,
  enabled_at
)
select
  connection.tenant_id,
  'queue',
  private_app.commerce_order_queue_owner(connection.tenant_id, null),
  clock_timestamp()
from commerce_sync.connections connection
on conflict (tenant_id) do nothing;

create or replace function private_app.route_woocommerce_order_batch(
  p_connection_id uuid,
  p_run_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_settings sales_core.commerce_order_routing_settings%rowtype;
  v_entity commerce_sync.external_entities%rowtype;
  v_work_item sales_core.commerce_order_work_items%rowtype;
  v_item jsonb;
  v_external_id text;
  v_order_number text;
  v_order_status text;
  v_payment_state text;
  v_amount_minor bigint;
  v_currency text;
  v_minor_digits integer;
  v_customer_name text;
  v_customer_phone text;
  v_customer_email text;
  v_contact_id uuid;
  v_contact_owner_id uuid;
  v_queue_owner_id uuid;
  v_assignee_id uuid;
  v_task_id uuid;
  v_task_key text;
  v_task_priority text;
  v_task_title text;
  v_task_description text;
  v_routing_state text;
  v_strategy text;
  v_order_created_at timestamptz;
  v_paid_at timestamptz;
  v_due_at timestamptz;
  v_created integer := 0;
  v_updated integer := 0;
  v_skipped_historical integer := 0;
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) > 1000
  then
    raise exception 'woocommerce_invalid_order_routing_batch';
  end if;

  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  if not exists (
    select 1
    from commerce_sync.sync_runs run
    where run.id = p_run_id
      and run.connection_id = v_connection.id
      and run.tenant_id = v_connection.tenant_id
      and run.status = 'running'
  ) then
    raise exception 'sync_run_not_running';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'woocommerce-order-routing:' || v_connection.tenant_id::text,
      2401
    )
  );

  insert into sales_core.commerce_order_routing_settings (
    tenant_id,
    routing_mode,
    queue_owner_staff_id,
    enabled_at
  )
  values (
    v_connection.tenant_id,
    'queue',
    private_app.commerce_order_queue_owner(
      v_connection.tenant_id,
      null
    ),
    transaction_timestamp()
  )
  on conflict (tenant_id) do nothing;

  select settings.*
  into v_settings
  from sales_core.commerce_order_routing_settings settings
  where settings.tenant_id = v_connection.tenant_id
  for update;

  v_queue_owner_id := private_app.commerce_order_queue_owner(
    v_connection.tenant_id,
    v_settings.queue_owner_staff_id
  );

  for v_item in
    select item.value
    from jsonb_array_elements(p_items) item(value)
  loop
    if jsonb_typeof(v_item) <> 'object' then
      continue;
    end if;

    v_external_id := nullif(trim(coalesce(
      v_item #>> '{_marktone,externalId}',
      v_item ->> 'id'
    )), '');
    if v_external_id is null or length(v_external_id) > 255 then
      continue;
    end if;

    select entity.*
    into v_entity
    from commerce_sync.external_entities entity
    where entity.connection_id = v_connection.id
      and entity.tenant_id = v_connection.tenant_id
      and entity.entity_type = 'orders'
      and entity.external_id = v_external_id
      and entity.last_seen_run_id = p_run_id
    limit 1;

    if v_entity.id is null then
      continue;
    end if;

    select work_item.*
    into v_work_item
    from sales_core.commerce_order_work_items work_item
    where work_item.connection_id = v_connection.id
      and work_item.external_order_id = v_external_id
    for update;

    v_order_number := left(coalesce(
      nullif(trim(v_item #>> '{_marktone,orderNumber}'), ''),
      nullif(trim(v_item ->> 'number'), ''),
      v_external_id
    ), 255);
    v_order_status := left(lower(coalesce(
      nullif(trim(v_item #>> '{_marktone,status}'), ''),
      nullif(trim(v_item ->> 'status'), ''),
      'unknown'
    )), 80);
    v_amount_minor := private_app.woocommerce_try_bigint(
      v_item #>> '{_marktone,orderTotalMinor}'
    );
    if v_amount_minor is null then
      v_amount_minor := private_app.woocommerce_try_bigint(
        v_item #>> '{_marktone,amountMinor}'
      );
    end if;
    v_amount_minor := case
      when v_amount_minor is null then null
      else greatest(v_amount_minor, 0)
    end;
    v_currency := upper(coalesce(
      nullif(trim(v_item #>> '{_marktone,currency}'), ''),
      nullif(trim(v_item ->> 'currency'), ''),
      'SAR'
    ));
    if v_currency !~ '^[A-Z]{3}$' then
      v_currency := 'SAR';
    end if;

    v_minor_digits := case
      when coalesce(v_item #>> '{_marktone,currencyMinorDigits}', '')
           ~ '^[0-3]$'
        then (v_item #>> '{_marktone,currencyMinorDigits}')::integer
      when coalesce(v_item #>> '{_marktone,minorDigits}', '') ~ '^[0-3]$'
        then (v_item #>> '{_marktone,minorDigits}')::integer
      when v_currency in ('BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY',
        'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV',
        'XAF', 'XOF', 'XPF') then 0
      when v_currency in ('BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR',
        'TND') then 3
      else 2
    end;

    v_order_created_at := private_app.woocommerce_try_timestamptz(
      coalesce(
        v_item #>> '{_marktone,createdAt}',
        v_item #>> '{_marktone,occurredAt}',
        v_item ->> 'date_created_gmt',
        v_item ->> 'date_created'
      )
    );

    if v_work_item.id is null
       and coalesce(v_order_created_at, v_entity.created_at)
         < v_settings.enabled_at
    then
      v_skipped_historical := v_skipped_historical + 1;
      continue;
    end if;

    v_paid_at := private_app.woocommerce_try_timestamptz(
      v_item #>> '{_marktone,paidAt}'
    );
    v_payment_state := case
      when v_order_status = 'refunded' then 'refunded'
      when v_paid_at is not null
        or lower(coalesce(
          v_item #>> '{_marktone,paidByDefaultWooStatus}',
          'false'
        )) in ('true', '1', 'yes') then 'paid'
      when v_order_status = 'unknown' then 'unknown'
      else 'unpaid'
    end;

    v_customer_name := nullif(trim(concat_ws(
      ' ',
      nullif(trim(v_item #>> '{billing,first_name}'), ''),
      nullif(trim(v_item #>> '{billing,last_name}'), '')
    )), '');
    if v_customer_name is null then
      v_customer_name := nullif(trim(concat_ws(
        ' ',
        nullif(trim(v_item #>> '{shipping,first_name}'), ''),
        nullif(trim(v_item #>> '{shipping,last_name}'), '')
      )), '');
    end if;
    if v_customer_name is null or length(v_customer_name) < 2 then
      v_customer_name := 'عميل طلب WooCommerce #' || v_order_number;
    end if;
    v_customer_name := left(v_customer_name, 300);

    v_customer_phone := private_app.normalize_lead_phone(coalesce(
      nullif(trim(v_item #>> '{_marktone,customerPhone}'), ''),
      nullif(trim(v_item #>> '{billing,phone}'), '')
    ));
    v_customer_email := nullif(lower(trim(coalesce(
      v_item #>> '{_marktone,customerEmail}',
      v_item #>> '{billing,email}',
      ''
    ))), '');
    if v_customer_email is not null
       and v_customer_email !~
         '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    then
      v_customer_email := null;
    end if;

    v_contact_id := v_work_item.contact_id;
    if v_contact_id is null
       and (v_customer_phone is not null or v_customer_email is not null)
    then
      v_contact_id := private_app.find_contact_by_identity(
        v_connection.tenant_id,
        v_customer_phone,
        null,
        v_customer_email
      );
    end if;

    if v_contact_id is null
       and (v_customer_phone is not null or v_customer_email is not null)
    then
      begin
        insert into sales_core.contacts (
          tenant_id,
          contact_key,
          full_name,
          phone,
          email,
          source,
          status,
          owner_staff_id,
          created_by_subject_id,
          metadata,
          lead_status,
          lead_quality
        )
        values (
          v_connection.tenant_id,
          'woocommerce-order-' || v_connection.id::text
            || '-' || v_external_id,
          v_customer_name,
          v_customer_phone,
          v_customer_email,
          'woocommerce',
          'new',
          null,
          null,
          jsonb_build_object(
            'source', 'woocommerce_order',
            'connectionId', v_connection.id,
            'firstExternalOrderId', v_external_id,
            'firstOrderNumber', v_order_number
          ),
          case
            when v_payment_state = 'paid' then 'paid'
            when v_order_status in ('cancelled', 'refunded')
              then 'cancelled'
            else 'awaiting_payment'
          end,
          'unrated'
        )
        returning id into v_contact_id;
      exception
        when unique_violation then
          v_contact_id := private_app.find_contact_by_identity(
            v_connection.tenant_id,
            v_customer_phone,
            null,
            v_customer_email
          );
      end;
    end if;

    v_contact_owner_id := null;
    if v_contact_id is not null then
      select staff.id
      into v_contact_owner_id
      from sales_core.contacts contact
      join people.staff_profiles staff
        on staff.id = contact.owner_staff_id
       and staff.tenant_id = contact.tenant_id
       and staff.employment_status = 'active'
       and staff.role_key in (
         'sales_user',
         'sales_supervisor',
         'sales_manager'
       )
      where contact.id = v_contact_id
        and contact.tenant_id = v_connection.tenant_id
      limit 1;
    end if;

    if v_work_item.id is not null then
      v_assignee_id := v_work_item.assigned_staff_id;
      v_routing_state := v_work_item.routing_state;
      v_strategy := v_work_item.assignment_strategy;
    elsif v_settings.routing_mode = 'queue' then
      v_assignee_id := v_queue_owner_id;
      v_routing_state := 'awaiting_distribution';
      v_strategy := 'queue';
    elsif v_contact_owner_id is not null then
      v_assignee_id := v_contact_owner_id;
      v_routing_state := 'assigned';
      v_strategy := 'existing_owner';
    else
      v_assignee_id := private_app.commerce_order_pick_assignee(
        v_connection.tenant_id,
        v_settings.routing_mode
      );
      if v_assignee_id is null then
        v_assignee_id := v_queue_owner_id;
        v_routing_state := 'awaiting_distribution';
        v_strategy := 'queue_fallback';
      else
        v_routing_state := 'assigned';
        v_strategy := case
          when v_settings.routing_mode = 'auto_online'
            then 'online_only'
          else 'fair'
        end;
      end if;
    end if;

    v_task_priority := case
      when v_order_status in ('pending', 'failed', 'on-hold')
        then 'urgent'
      else 'high'
    end;
    v_due_at := clock_timestamp()
      + make_interval(mins => v_settings.default_due_minutes);
    v_task_key := 'woocommerce-order-' || v_connection.id::text
      || '-' || v_external_id;
    v_task_title := left(
      'طلب WooCommerce #' || v_order_number || ' — ' || v_order_status,
      500
    );
    v_task_description := left(concat_ws(
      ' · ',
      'الحالة: ' || v_order_status,
      'الدفع: ' || v_payment_state,
      case
        when nullif(trim(v_item ->> 'total'), '') is not null
          then 'القيمة: ' || trim(v_item ->> 'total') || ' ' || v_currency
      end,
      case
        when v_customer_phone is null and v_customer_email is null
          then 'بيانات التواصل غير متاحة'
      end
    ), 4000);

    insert into work_core.tasks as task (
      tenant_id,
      task_key,
      title,
      description,
      status,
      priority,
      assigned_staff_id,
      created_by_subject_id,
      contact_id,
      starts_at,
      due_at,
      metadata
    )
    values (
      v_connection.tenant_id,
      v_task_key,
      v_task_title,
      v_task_description,
      'todo',
      v_task_priority,
      v_assignee_id,
      null,
      v_contact_id,
      clock_timestamp(),
      v_due_at,
      jsonb_strip_nulls(jsonb_build_object(
        'source', 'woocommerce_order',
        'connectionId', v_connection.id,
        'externalEntityId', v_entity.id,
        'externalOrderId', v_external_id,
        'orderNumber', v_order_number,
        'orderStatus', v_order_status,
        'paymentState', v_payment_state,
        'amountMinor', v_amount_minor,
        'currency', v_currency,
        'minorDigits', v_minor_digits,
        'paidAt', v_paid_at,
        'routingState', v_routing_state,
        'assignmentStrategy', v_strategy,
        'lastRunId', p_run_id
      ))
    )
    on conflict (tenant_id, task_key) do update
    set title = excluded.title,
        description = excluded.description,
        contact_id = coalesce(task.contact_id, excluded.contact_id),
        metadata = task.metadata || excluded.metadata,
        updated_at = clock_timestamp()
    returning id into v_task_id;

    if v_work_item.id is null then
      insert into sales_core.commerce_order_work_items (
        tenant_id,
        connection_id,
        external_entity_id,
        external_order_id,
        task_id,
        contact_id,
        assigned_staff_id,
        routing_state,
        assignment_strategy,
        order_number,
        order_status,
        payment_state,
        amount_minor,
        currency,
        minor_digits,
        customer_name,
        customer_phone,
        customer_email,
        order_created_at,
        paid_at,
        assigned_at,
        metadata
      )
      values (
        v_connection.tenant_id,
        v_connection.id,
        v_entity.id,
        v_external_id,
        v_task_id,
        v_contact_id,
        v_assignee_id,
        v_routing_state,
        v_strategy,
        v_order_number,
        v_order_status,
        v_payment_state,
        v_amount_minor,
        v_currency,
        v_minor_digits,
        v_customer_name,
        v_customer_phone,
        v_customer_email,
        v_order_created_at,
        v_paid_at,
        case when v_routing_state = 'assigned'
          then clock_timestamp() else null end,
        jsonb_build_object(
          'source', 'woocommerce_order',
          'firstRunId', p_run_id,
          'lastRunId', p_run_id
        )
      )
      returning * into v_work_item;

      insert into audit_log.events (
        tenant_id,
        actor_subject_id,
        action,
        resource_type,
        resource_id,
        context
      )
      values (
        v_connection.tenant_id,
        null,
        'tenant.woocommerce_order_task_created',
        'commerce_order_work_item',
        v_work_item.id::text,
        jsonb_build_object(
          'connectionId', v_connection.id,
          'externalOrderId', v_external_id,
          'taskId', v_task_id,
          'routingState', v_routing_state,
          'assignmentStrategy', v_strategy
        )
      );

      v_created := v_created + 1;
    else
      update sales_core.commerce_order_work_items work_item
      set external_entity_id = v_entity.id,
          task_id = v_task_id,
          contact_id = coalesce(work_item.contact_id, v_contact_id),
          order_number = v_order_number,
          order_status = v_order_status,
          payment_state = v_payment_state,
          amount_minor = v_amount_minor,
          currency = v_currency,
          minor_digits = v_minor_digits,
          customer_name = v_customer_name,
          customer_phone = v_customer_phone,
          customer_email = v_customer_email,
          order_created_at = coalesce(
            v_order_created_at,
            work_item.order_created_at
          ),
          paid_at = coalesce(v_paid_at, work_item.paid_at),
          last_seen_at = clock_timestamp(),
          last_error = null,
          metadata = work_item.metadata || jsonb_build_object(
            'lastRunId', p_run_id,
            'lastStatusAt', clock_timestamp()
          )
      where work_item.id = v_work_item.id;

      v_updated := v_updated + 1;
    end if;

    if v_contact_id is not null
       and v_routing_state = 'assigned'
       and v_assignee_id is not null
    then
      update sales_core.contacts contact
      set owner_staff_id = v_assignee_id
      where contact.id = v_contact_id
        and contact.tenant_id = v_connection.tenant_id
        and contact.owner_staff_id is null;
    end if;

    if v_routing_state = 'assigned'
       and v_strategy in ('fair', 'online_only')
       and v_assignee_id is not null
    then
      update sales_core.sales_assignment_profiles profile
      set last_assigned_at = clock_timestamp()
      where profile.tenant_id = v_connection.tenant_id
        and profile.staff_id = v_assignee_id;
    end if;
  end loop;

  return jsonb_build_object(
    'created', v_created,
    'updated', v_updated,
    'skippedHistorical', v_skipped_historical
  );
end;
$$;

revoke all on function private_app.route_woocommerce_order_batch(
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated;

create or replace function public.v3_tenant_commerce_order_queue_snapshot(
  p_slug text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_settings sales_core.commerce_order_routing_settings%rowtype;
  v_can_route boolean;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  v_can_route := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.commerce_orders.distribute'
  );
  if not v_can_route
     and not private_app.has_tenant_permission(
       v_tenant.id,
       'tenant.leads.read'
     )
  then
    raise exception 'forbidden';
  end if;

  select settings.*
  into v_settings
  from sales_core.commerce_order_routing_settings settings
  where settings.tenant_id = v_tenant.id;

  return jsonb_build_object(
    'generatedAt', clock_timestamp(),
    'configured', exists (
      select 1
      from commerce_sync.connections connection
      where connection.tenant_id = v_tenant.id
    ),
    'timezone', v_tenant.timezone,
    'viewer', jsonb_build_object(
      'staffId', private_app.current_staff_id(v_tenant.id),
      'canRoute', v_can_route,
      'canDistribute', v_can_route,
      'permission', 'tenant.commerce_orders.distribute'
    ),
    'settings', jsonb_build_object(
      'mode', coalesce(v_settings.routing_mode, 'queue'),
      'routingMode', coalesce(v_settings.routing_mode, 'queue'),
      'queueOwnerStaffId', v_settings.queue_owner_staff_id,
      'slaMinutes', coalesce(v_settings.default_due_minutes, 60),
      'defaultDueMinutes', coalesce(v_settings.default_due_minutes, 60),
      'enabledAt', v_settings.enabled_at,
      'historicalBackfillEnabled', false
    ),
    'summary', jsonb_build_object(
      'awaitingDistribution', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
          and work_item.routing_state = 'awaiting_distribution'
      ),
      'assigned', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
          and work_item.routing_state = 'assigned'
      ),
      'assignedToday', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
          and work_item.routing_state = 'assigned'
          and work_item.assigned_at is not null
          and (
            work_item.assigned_at at time zone v_tenant.timezone
          )::date = (
            clock_timestamp() at time zone v_tenant.timezone
          )::date
      ),
      'errors', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
          and work_item.routing_state = 'error'
      ),
      'total', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
      ),
      'openTasks', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        join work_core.tasks task on task.id = work_item.task_id
        where work_item.tenant_id = v_tenant.id
          and task.status in ('todo', 'in_progress')
      ),
      'routingErrors', (
        select count(*)
        from sales_core.commerce_order_work_items work_item
        where work_item.tenant_id = v_tenant.id
          and work_item.routing_state = 'error'
      )
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', work_item.id,
        'connectionId', work_item.connection_id,
        'externalOrderId', work_item.external_order_id,
        'orderNumber', work_item.order_number,
        'orderStatus', work_item.order_status,
        'paymentState', work_item.payment_state,
        'amountMinor', work_item.amount_minor,
        'currency', work_item.currency,
        'minorDigits', work_item.minor_digits,
        'customerName', work_item.customer_name,
        'customerPhone', work_item.customer_phone,
        'customerEmail', work_item.customer_email,
        'contactId', work_item.contact_id,
        'taskId', work_item.task_id,
        'taskStatus', task.status,
        'taskPriority', task.priority,
        'taskDueAt', task.due_at,
        'routingState', work_item.routing_state,
        'routingStrategy', work_item.assignment_strategy,
        'assignmentStrategy', work_item.assignment_strategy,
        'assignedStaffId', work_item.assigned_staff_id,
        'assigneeName', assignee.full_name,
        'assignedStaffName', assignee.full_name,
        'assignedAt', work_item.assigned_at,
        'orderCreatedAt', work_item.order_created_at,
        'paidAt', work_item.paid_at,
        'firstSeenAt', work_item.first_seen_at,
        'lastSeenAt', work_item.last_seen_at,
        'lastError', work_item.last_error
      ) order by
        case work_item.routing_state
          when 'awaiting_distribution' then 0
          when 'error' then 1
          else 2
        end,
        work_item.first_seen_at desc,
        work_item.id)
      from (
        select item.*
        from sales_core.commerce_order_work_items item
        where item.tenant_id = v_tenant.id
        order by
          case item.routing_state
            when 'awaiting_distribution' then 0
            when 'error' then 1
            else 2
          end,
          item.first_seen_at desc,
          item.id
        limit 500
      ) work_item
      left join work_core.tasks task on task.id = work_item.task_id
      left join people.staff_profiles assignee
        on assignee.id = work_item.assigned_staff_id
       and assignee.tenant_id = work_item.tenant_id
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', staff.id,
        'name', staff.full_name,
        'roleKey', staff.role_key,
        'roleLabel', case staff.role_key
          when 'sales_manager' then 'مدير المبيعات'
          when 'sales_supervisor' then 'مشرف المبيعات'
          when 'sales_user' then 'مسؤول مبيعات'
          when 'data_officer' then 'مسؤول البيانات'
          else staff.role_key
        end,
        'jobTitle', staff.job_title,
        'eligible', coalesce(profile.eligible_for_leads, false),
        'salesChannel', coalesce(profile.sales_channel, 'online'),
        'dailyCapacity', coalesce(profile.daily_capacity, 50),
        'weight', coalesce(profile.weight, 1),
        'canOwnQueue', staff.role_key in (
          'sales_manager',
          'sales_supervisor',
          'data_officer'
        ),
        'queueOwnerEligible', staff.role_key in (
          'sales_manager',
          'sales_supervisor',
          'data_officer'
        ),
        'canReceiveOrders', staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        ),
        'activeOrderTasks', (
          select count(*)
          from sales_core.commerce_order_work_items work_item
          join work_core.tasks task on task.id = work_item.task_id
          where work_item.tenant_id = v_tenant.id
            and work_item.assigned_staff_id = staff.id
            and task.status in ('todo', 'in_progress')
        )
      ) order by
        case staff.role_key
          when 'sales_manager' then 0
          when 'sales_supervisor' then 1
          when 'data_officer' then 2
          else 3
        end,
        staff.full_name)
      from people.staff_profiles staff
      left join sales_core.sales_assignment_profiles profile
        on profile.tenant_id = staff.tenant_id
       and profile.staff_id = staff.id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager',
          'data_officer'
        )
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.v3_tenant_commerce_order_action(
  p_tenant_slug text,
  p_action text,
  p_payload jsonb default '{}'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_settings sales_core.commerce_order_routing_settings%rowtype;
  v_work_item sales_core.commerce_order_work_items%rowtype;
  v_action text := lower(trim(coalesce(p_action, '')));
  v_mode text;
  v_strategy text;
  v_picker_mode text;
  v_queue_owner_id uuid;
  v_assignee_id uuid;
  v_ids_json jsonb;
  v_item_ids uuid[] := '{}'::uuid[];
  v_due_minutes integer;
  v_count integer := 0;
  v_skipped integer := 0;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'invalid_commerce_order_payload';
  end if;

  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.commerce_orders.distribute'
  ) then
    raise exception 'forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'woocommerce-order-routing:' || v_tenant.id::text,
      2401
    )
  );

  insert into sales_core.commerce_order_routing_settings (
    tenant_id,
    routing_mode,
    queue_owner_staff_id,
    enabled_at
  )
  values (
    v_tenant.id,
    'queue',
    private_app.commerce_order_queue_owner(v_tenant.id, null),
    transaction_timestamp()
  )
  on conflict (tenant_id) do nothing;

  select settings.*
  into v_settings
  from sales_core.commerce_order_routing_settings settings
  where settings.tenant_id = v_tenant.id
  for update;

  if v_action = 'set_routing' then
    v_mode := lower(trim(coalesce(
      p_payload ->> 'routingMode',
      p_payload ->> 'mode',
      ''
    )));
    if v_mode not in ('queue', 'auto_fair', 'auto_online') then
      raise exception 'invalid_commerce_order_routing_mode';
    end if;

    if nullif(trim(p_payload ->> 'queueOwnerStaffId'), '') is not null then
      if (p_payload ->> 'queueOwnerStaffId') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      then
        raise exception 'invalid_commerce_order_queue_owner';
      end if;
      v_queue_owner_id := (p_payload ->> 'queueOwnerStaffId')::uuid;
    else
      v_queue_owner_id := v_settings.queue_owner_staff_id;
    end if;

    v_queue_owner_id := private_app.commerce_order_queue_owner(
      v_tenant.id,
      v_queue_owner_id
    );
    if v_mode = 'queue' and v_queue_owner_id is null then
      raise exception 'commerce_order_queue_owner_required';
    end if;

    if coalesce(p_payload ->> 'defaultDueMinutes', '')
       ~ '^[0-9]{1,5}$'
    then
      v_due_minutes := (p_payload ->> 'defaultDueMinutes')::integer;
    elsif coalesce(p_payload ->> 'slaMinutes', '')
       ~ '^[0-9]{1,5}$'
    then
      v_due_minutes := (p_payload ->> 'slaMinutes')::integer;
    else
      v_due_minutes := v_settings.default_due_minutes;
    end if;
    if v_due_minutes not between 5 and 10080 then
      raise exception 'invalid_commerce_order_due_minutes';
    end if;

    update sales_core.commerce_order_routing_settings settings
    set routing_mode = v_mode,
        queue_owner_staff_id = v_queue_owner_id,
        default_due_minutes = v_due_minutes,
        updated_by_subject_id = private_app.current_subject_id()
    where settings.tenant_id = v_tenant.id;

    perform private_app.write_audit(
      'tenant.commerce_order_routing_updated',
      'commerce_order_routing_settings',
      v_tenant.id::text,
      v_tenant.id,
      jsonb_build_object(
        'routingMode', v_mode,
        'queueOwnerStaffId', v_queue_owner_id,
        'defaultDueMinutes', v_due_minutes
      )
    );

    return jsonb_build_object(
      'mode', v_mode,
      'routingMode', v_mode,
      'queueOwnerStaffId', v_queue_owner_id,
      'slaMinutes', v_due_minutes,
      'defaultDueMinutes', v_due_minutes,
      'enabledAt', v_settings.enabled_at,
      'saved', true
    );
  end if;

  if p_payload ? 'itemIds' then
    v_ids_json := p_payload -> 'itemIds';
  elsif p_payload ? 'workItemIds' then
    v_ids_json := p_payload -> 'workItemIds';
  elsif nullif(trim(p_payload ->> 'workItemId'), '') is not null then
    v_ids_json := jsonb_build_array(p_payload ->> 'workItemId');
  else
    v_ids_json := '[]'::jsonb;
  end if;

  if jsonb_typeof(v_ids_json) <> 'array'
     or jsonb_array_length(v_ids_json) > 250
  then
    raise exception 'invalid_commerce_order_work_items';
  end if;
  if exists (
    select 1
    from jsonb_array_elements_text(v_ids_json) item(value)
    where item.value !~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception 'invalid_commerce_order_work_items';
  end if;
  select coalesce(array_agg(item.value::uuid), '{}'::uuid[])
  into v_item_ids
  from jsonb_array_elements_text(v_ids_json) item(value);

  if v_action = 'assign' then
    if cardinality(v_item_ids) = 0 then
      raise exception 'commerce_order_work_items_required';
    end if;
    if nullif(trim(p_payload ->> 'staffId'), '') is null
       or (p_payload ->> 'staffId') !~*
         '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then
      raise exception 'invalid_sales_assignee';
    end if;
    v_assignee_id := (p_payload ->> 'staffId')::uuid;

    if not exists (
      select 1
      from people.staff_profiles staff
      where staff.id = v_assignee_id
        and staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
    ) then
      raise exception 'invalid_sales_assignee';
    end if;

    for v_work_item in
      select work_item.*
      from sales_core.commerce_order_work_items work_item
      join work_core.tasks task on task.id = work_item.task_id
      where work_item.tenant_id = v_tenant.id
        and work_item.id = any(v_item_ids)
        and task.status in ('todo', 'in_progress')
      order by work_item.id
      for update of work_item
    loop
      update work_core.tasks task
      set assigned_staff_id = v_assignee_id
      where task.id = v_work_item.task_id
        and task.tenant_id = v_tenant.id
        and task.status in ('todo', 'in_progress');

      update sales_core.commerce_order_work_items work_item
      set assigned_staff_id = v_assignee_id,
          routing_state = 'assigned',
          assignment_strategy = 'selected',
          assigned_at = clock_timestamp(),
          last_error = null,
          metadata = work_item.metadata || jsonb_build_object(
            'lastAssignedBySubjectId', private_app.current_subject_id(),
            'lastAssignedAt', clock_timestamp()
          )
      where work_item.id = v_work_item.id;

      if v_work_item.contact_id is not null then
        update sales_core.contacts contact
        set owner_staff_id = v_assignee_id
        where contact.id = v_work_item.contact_id
          and contact.tenant_id = v_tenant.id
          and contact.owner_staff_id is null;
      end if;

      v_count := v_count + 1;
    end loop;

    update sales_core.sales_assignment_profiles profile
    set last_assigned_at = clock_timestamp()
    where profile.tenant_id = v_tenant.id
      and profile.staff_id = v_assignee_id;

    perform private_app.write_audit(
      'tenant.commerce_order_tasks_assigned',
      'commerce_order_work_item',
      null,
      v_tenant.id,
      jsonb_build_object(
        'staffId', v_assignee_id,
        'assigned', v_count,
        'workItemIds', to_jsonb(v_item_ids)
      )
    );

    return jsonb_build_object(
      'assigned', v_count,
      'queued', 0,
      'staffId', v_assignee_id
    );
  end if;

  if v_action = 'auto_distribute' then
    if cardinality(v_item_ids) = 0 then
      raise exception 'commerce_order_work_items_required';
    end if;
    v_strategy := lower(trim(coalesce(
      p_payload ->> 'strategy',
      'fair'
    )));
    if v_strategy not in ('fair', 'online_only') then
      raise exception 'invalid_distribution_strategy';
    end if;
    v_picker_mode := case
      when v_strategy = 'online_only' then 'auto_online'
      else 'auto_fair'
    end;

    for v_work_item in
      select work_item.*
      from sales_core.commerce_order_work_items work_item
      join work_core.tasks task on task.id = work_item.task_id
      where work_item.tenant_id = v_tenant.id
        and work_item.routing_state = 'awaiting_distribution'
        and task.status in ('todo', 'in_progress')
        and work_item.id = any(v_item_ids)
      order by work_item.first_seen_at, work_item.id
      for update of work_item skip locked
      limit 250
    loop
      v_assignee_id := private_app.commerce_order_pick_assignee(
        v_tenant.id,
        v_picker_mode
      );
      if v_assignee_id is null then
        v_skipped := v_skipped + 1;
        continue;
      end if;

      update work_core.tasks task
      set assigned_staff_id = v_assignee_id
      where task.id = v_work_item.task_id
        and task.tenant_id = v_tenant.id
        and task.status in ('todo', 'in_progress');

      update sales_core.commerce_order_work_items work_item
      set assigned_staff_id = v_assignee_id,
          routing_state = 'assigned',
          assignment_strategy = v_strategy,
          assigned_at = clock_timestamp(),
          last_error = null,
          metadata = work_item.metadata || jsonb_build_object(
            'lastAssignedBySubjectId', private_app.current_subject_id(),
            'lastAssignedAt', clock_timestamp()
          )
      where work_item.id = v_work_item.id;

      if v_work_item.contact_id is not null then
        update sales_core.contacts contact
        set owner_staff_id = v_assignee_id
        where contact.id = v_work_item.contact_id
          and contact.tenant_id = v_tenant.id
          and contact.owner_staff_id is null;
      end if;

      update sales_core.sales_assignment_profiles profile
      set last_assigned_at = clock_timestamp()
      where profile.tenant_id = v_tenant.id
        and profile.staff_id = v_assignee_id;

      v_count := v_count + 1;
    end loop;

    perform private_app.write_audit(
      'tenant.commerce_order_tasks_auto_distributed',
      'commerce_order_work_item',
      null,
      v_tenant.id,
      jsonb_build_object(
        'strategy', v_strategy,
        'assigned', v_count,
        'skippedForCapacity', v_skipped,
        'workItemIds', to_jsonb(v_item_ids)
      )
    );

    return jsonb_build_object(
      'strategy', v_strategy,
      'assigned', v_count,
      'queued', v_skipped,
      'skippedForCapacity', v_skipped
    );
  end if;

  raise exception 'invalid_commerce_order_action';
end;
$$;

revoke all on function public.v3_tenant_commerce_order_queue_snapshot(text)
from public, anon;
revoke all on function public.v3_tenant_commerce_order_action(
  text,
  text,
  jsonb
) from public, anon;

grant execute on function public.v3_tenant_commerce_order_queue_snapshot(text)
to authenticated;
grant execute on function public.v3_tenant_commerce_order_action(
  text,
  text,
  jsonb
) to authenticated;

-- Harden the checkpoint worker while adding the atomic order-routing hook.
create or replace function public.v3_woocommerce_start_sync(
  p_connection_id uuid,
  p_trigger text,
  p_scope jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_result jsonb;
  v_run commerce_sync.sync_runs%rowtype;
  v_run_id uuid;
  v_duplicate boolean;
  v_clock timestamptz;
begin
  v_result := public.v2_woocommerce_start_sync(
    p_connection_id,
    p_trigger,
    p_scope,
    p_idempotency_key
  );
  v_run_id := (v_result ->> 'runId')::uuid;
  v_duplicate := coalesce((v_result ->> 'duplicate')::boolean, false);
  v_clock := clock_timestamp();

  -- v2_woocommerce_start_sync already holds the connection lock. Keep the
  -- global lock order as connection, then run.
  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = v_run_id
    and run.connection_id = p_connection_id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;

  if not v_duplicate then
    update commerce_sync.sync_runs run
    set current_cursor = jsonb_build_object(
          'v', 2,
          'step', 0,
          'mode', 'metadata',
          'page', 1,
          'totals', '{}'::jsonb,
          'pages', '{}'::jsonb,
          'remoteMetadata', '{}'::jsonb,
          'retryCount', 0,
          'startedAt', v_clock
        ),
        has_more = true,
        checkpoint_seq = 0,
        worker_id = null,
        lease_expires_at = null,
        next_attempt_at = v_clock,
        attempt_count = 0
    where run.id = v_run.id;

    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  elsif v_run.status = 'running'
        and v_run.has_more
        and v_run.current_cursor ->> 'v' = '2'
        and (
          v_run.lease_expires_at is null
          or v_run.lease_expires_at <= v_clock
        )
        and v_run.next_attempt_at <= v_clock
  then
    perform private_app.enqueue_woocommerce_continuation(v_run.id);
  end if;

  return v_result || jsonb_build_object(
    'accepted', (v_result ->> 'status') = 'running',
    'checkpointSeq', coalesce(v_run.checkpoint_seq, 0)
  );
end;
$$;

create or replace function public.v3_woocommerce_claim_run(
  p_run_id uuid,
  p_worker_id text,
  p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run commerce_sync.sync_runs%rowtype;
  v_connection_id uuid;
  v_worker text := nullif(trim(p_worker_id), '');
  v_lease_seconds integer := coalesce(p_lease_seconds, 60);
  v_clock timestamptz;
begin
  if v_worker is null or length(v_worker) < 8 or length(v_worker) > 200 then
    raise exception 'woocommerce_worker_id_invalid';
  end if;
  if v_lease_seconds < 15 or v_lease_seconds > 120 then
    raise exception 'woocommerce_worker_lease_invalid';
  end if;

  select run.connection_id
  into v_connection_id
  from commerce_sync.sync_runs run
  where run.id = p_run_id
  limit 1;

  if v_connection_id is null then return null; end if;

  perform connection.id
  from commerce_sync.connections connection
  where connection.id = v_connection_id
  for update;

  if not found then return null; end if;
  v_clock := clock_timestamp();

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection_id
    and run.status = 'running'
    and run.has_more = true
    and run.next_attempt_at <= v_clock
    and (
      run.lease_expires_at is null
      or run.lease_expires_at <= v_clock
    )
  for update skip locked;

  if v_run.id is null then return null; end if;
  if v_run.current_cursor ->> 'v' is distinct from '2' then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  update commerce_sync.sync_runs run
  set worker_id = v_worker,
      lease_expires_at = v_clock
        + make_interval(secs => v_lease_seconds),
      attempt_count = run.attempt_count + 1
  where run.id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'connectionId', v_run.connection_id,
    'scope', to_jsonb(v_run.scope),
    'cursor', v_run.current_cursor,
    'checkpointSeq', v_run.checkpoint_seq,
    'attemptCount', v_run.attempt_count + 1,
    'workerId', v_worker
  );
end;
$$;

create or replace function public.v3_woocommerce_store_batch_and_yield(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_entity_type text,
  p_items jsonb,
  p_next_cursor jsonb,
  p_has_more boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
  v_route_result jsonb := '{}'::jsonb;
  v_next_seq bigint;
  v_clock timestamptz;
begin
  if jsonb_typeof(p_next_cursor) <> 'object'
     or p_next_cursor ->> 'v' is distinct from '2'
  then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then raise exception 'sync_run_not_running'; end if;
  if not v_run.has_more then raise exception 'woocommerce_sync_not_resumable'; end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  v_clock := clock_timestamp();
  if v_run.lease_expires_at is null
     or v_run.lease_expires_at <= v_clock
  then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  -- has_more remains true through the explicit `complete` cursor step. Only
  -- complete/fail may make a durable run terminal, preventing stranded runs
  -- when a caller incorrectly submits false for an intermediate page.
  v_result := public.v2_woocommerce_store_batch(
    p_connection_id,
    p_run_id,
    p_entity_type,
    p_items,
    p_next_cursor,
    true
  );

  if p_entity_type = 'orders' then
    v_route_result := private_app.route_woocommerce_order_batch(
      p_connection_id,
      p_run_id,
      p_items
    );
  end if;

  v_next_seq := v_run.checkpoint_seq + 1;
  update commerce_sync.sync_runs run
  set has_more = true,
      checkpoint_seq = v_next_seq,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where run.id = v_run.id;

  perform private_app.enqueue_woocommerce_continuation(v_run.id);

  return v_result || jsonb_build_object(
    'checkpointSeq', v_next_seq,
    'hasMore', true,
    'orderRouting', v_route_result
  );
end;
$$;

create or replace function public.v3_woocommerce_checkpoint_and_yield(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_next_cursor jsonb,
  p_has_more boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_next_seq bigint;
  v_clock timestamptz;
begin
  if jsonb_typeof(p_next_cursor) <> 'object'
     or p_next_cursor ->> 'v' is distinct from '2'
  then
    raise exception 'woocommerce_sync_cursor_version_invalid';
  end if;

  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then raise exception 'sync_run_not_running'; end if;
  if not v_run.has_more then raise exception 'woocommerce_sync_not_resumable'; end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  v_clock := clock_timestamp();
  if v_run.lease_expires_at is null
     or v_run.lease_expires_at <= v_clock
  then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_next_seq := v_run.checkpoint_seq + 1;
  update commerce_sync.sync_runs run
  set current_cursor = p_next_cursor,
      has_more = true,
      checkpoint_seq = v_next_seq,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where run.id = v_run.id;

  perform private_app.enqueue_woocommerce_continuation(v_run.id);

  return jsonb_build_object(
    'runId', v_run.id,
    'checkpointSeq', v_next_seq,
    'cursor', p_next_cursor,
    'hasMore', true
  );
end;
$$;

create or replace function public.v3_woocommerce_complete_claimed_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_stats jsonb,
  p_remote_metadata jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
  v_clock timestamptz;
begin
  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  v_clock := clock_timestamp();
  if v_run.lease_expires_at is null
     or v_run.lease_expires_at <= v_clock
  then
    raise exception 'woocommerce_sync_lease_expired';
  end if;
  if v_run.current_cursor ->> 'v' is distinct from '2'
     or v_run.current_cursor ->> 'mode' is distinct from 'complete'
  then
    raise exception 'woocommerce_sync_not_complete';
  end if;

  v_result := public.v2_woocommerce_complete_sync(
    p_connection_id,
    p_run_id,
    p_stats,
    p_remote_metadata
  );

  update commerce_sync.sync_runs run
  set has_more = false,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where run.id = v_run.id;

  return v_result;
end;
$$;

create or replace function public.v3_woocommerce_fail_claimed_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_error text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_result jsonb;
  v_clock timestamptz;
begin
  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  v_clock := clock_timestamp();
  if v_run.lease_expires_at is null
     or v_run.lease_expires_at <= v_clock
  then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_result := public.v2_woocommerce_fail_sync(
    p_connection_id,
    p_run_id,
    left(
      coalesce(nullif(trim(p_error), ''), 'woocommerce_sync_failed'),
      200
    )
  );

  update commerce_sync.sync_runs run
  set has_more = false,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = clock_timestamp()
  where run.id = v_run.id;

  return v_result;
end;
$$;

create or replace function public.v3_woocommerce_release_run(
  p_connection_id uuid,
  p_run_id uuid,
  p_worker_id text,
  p_expected_seq bigint,
  p_error text,
  p_delay_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connection commerce_sync.connections%rowtype;
  v_run commerce_sync.sync_runs%rowtype;
  v_delay integer := greatest(15, least(coalesce(p_delay_seconds, 60), 900));
  v_retry_count integer;
  v_retry_text text;
  v_next_attempt_at timestamptz;
  v_clock timestamptz;
begin
  select connection.*
  into v_connection
  from commerce_sync.connections connection
  where connection.id = p_connection_id
  for update;

  if v_connection.id is null then
    raise exception 'integration_connection_not_found';
  end if;

  select run.*
  into v_run
  from commerce_sync.sync_runs run
  where run.id = p_run_id
    and run.connection_id = v_connection.id
  for update;

  if v_run.id is null then raise exception 'sync_run_not_found'; end if;
  if v_run.status <> 'running' then
    return jsonb_build_object(
      'runId', v_run.id,
      'status', v_run.status,
      'duplicate', true
    );
  end if;
  if not v_run.has_more then
    raise exception 'woocommerce_sync_not_resumable';
  end if;
  if v_run.worker_id is distinct from nullif(trim(p_worker_id), '') then
    raise exception 'woocommerce_sync_worker_mismatch';
  end if;
  if v_run.checkpoint_seq is distinct from p_expected_seq then
    raise exception 'woocommerce_sync_checkpoint_conflict';
  end if;
  v_clock := clock_timestamp();
  if v_run.lease_expires_at is null
     or v_run.lease_expires_at <= v_clock
  then
    raise exception 'woocommerce_sync_lease_expired';
  end if;

  v_retry_text := v_run.current_cursor ->> 'retryCount';
  v_retry_count := case
    when coalesce(v_retry_text, '') ~ '^[0-9]{1,6}$'
      then least(v_retry_text::integer + 1, 1000000)
    else 1
  end;
  v_next_attempt_at := v_clock + make_interval(secs => v_delay);

  update commerce_sync.sync_runs run
  set current_cursor = jsonb_set(
        jsonb_set(
          run.current_cursor,
          '{retryCount}',
          to_jsonb(v_retry_count),
          true
        ),
        '{lastRetryError}',
        to_jsonb(left(coalesce(nullif(trim(p_error), ''), 'retry'), 160)),
        true
      ),
      has_more = true,
      worker_id = null,
      lease_expires_at = null,
      next_attempt_at = v_next_attempt_at
  where run.id = v_run.id;

  return jsonb_build_object(
    'runId', v_run.id,
    'status', 'running',
    'retryCount', v_retry_count,
    'nextAttemptAt', v_next_attempt_at
  );
end;
$$;

create or replace function public.v3_woocommerce_requeue_recoverable(
  p_limit integer default 10
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 25));
  v_candidate record;
  v_run commerce_sync.sync_runs%rowtype;
  v_ids jsonb := '[]'::jsonb;
  v_clock timestamptz;
begin
  for v_candidate in
    select run.id, run.connection_id
    from commerce_sync.sync_runs run
    where run.status = 'running'
      and run.has_more = true
      and run.current_cursor ->> 'v' = '2'
      and run.next_attempt_at <= clock_timestamp()
      and (
        run.lease_expires_at is null
        or run.lease_expires_at <= clock_timestamp()
      )
    order by run.next_attempt_at, run.started_at, run.id
    limit v_limit
  loop
    -- Match every other worker transition: connection lock before run lock.
    perform connection.id
    from commerce_sync.connections connection
    where connection.id = v_candidate.connection_id
    for update;

    if not found then
      continue;
    end if;
    v_clock := clock_timestamp();

    select run.*
    into v_run
    from commerce_sync.sync_runs run
    where run.id = v_candidate.id
      and run.connection_id = v_candidate.connection_id
      and run.status = 'running'
      and run.has_more = true
      and run.current_cursor ->> 'v' = '2'
      and run.next_attempt_at <= v_clock
      and (
        run.lease_expires_at is null
        or run.lease_expires_at <= v_clock
      )
    for update skip locked;

    if v_run.id is null then
      continue;
    end if;

    perform private_app.enqueue_woocommerce_continuation(v_run.id);
    v_ids := v_ids || jsonb_build_array(v_run.id);
  end loop;

  return jsonb_build_object(
    'queued', jsonb_array_length(v_ids),
    'runIds', v_ids
  );
end;
$$;

revoke all on function public.v3_woocommerce_start_sync(
  uuid,text,jsonb,text
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_claim_run(
  uuid,text,integer
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_checkpoint_and_yield(
  uuid,uuid,text,bigint,jsonb,boolean
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_complete_claimed_run(
  uuid,uuid,text,bigint,jsonb,jsonb
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_fail_claimed_run(
  uuid,uuid,text,bigint,text
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_release_run(
  uuid,uuid,text,bigint,text,integer
) from public, anon, authenticated;
revoke all on function public.v3_woocommerce_requeue_recoverable(integer)
from public, anon, authenticated;

grant execute on function public.v3_woocommerce_start_sync(
  uuid,text,jsonb,text
) to service_role;
grant execute on function public.v3_woocommerce_claim_run(
  uuid,text,integer
) to service_role;
grant execute on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) to service_role;
grant execute on function public.v3_woocommerce_checkpoint_and_yield(
  uuid,uuid,text,bigint,jsonb,boolean
) to service_role;
grant execute on function public.v3_woocommerce_complete_claimed_run(
  uuid,uuid,text,bigint,jsonb,jsonb
) to service_role;
grant execute on function public.v3_woocommerce_fail_claimed_run(
  uuid,uuid,text,bigint,text
) to service_role;
grant execute on function public.v3_woocommerce_release_run(
  uuid,uuid,text,bigint,text,integer
) to service_role;
grant execute on function public.v3_woocommerce_requeue_recoverable(integer)
to service_role;

do $schedule$
declare
  v_job_id bigint;
begin
  select job.jobid
  into v_job_id
  from cron.job job
  where job.jobname = 'marktone-woocommerce-sync'
  limit 1;

  if v_job_id is not null then
    perform cron.unschedule(v_job_id);
  end if;

  perform cron.schedule(
    'marktone-woocommerce-sync',
    '* * * * *',
    $command$
      select private_app.enqueue_woocommerce_dispatch();
    $command$
  );
end;
$schedule$;

comment on table sales_core.commerce_order_routing_settings is
'Per-tenant WooCommerce order task routing mode and no-backfill cutover.';
comment on table sales_core.commerce_order_work_items is
'Idempotent one-order-to-one-task routing ledger for newly seen WooCommerce orders.';
comment on function public.v3_tenant_commerce_order_queue_snapshot(text) is
'Returns the tenant WooCommerce order allocation queue, routing settings, and eligible staff.';
comment on function public.v3_tenant_commerce_order_action(text,text,jsonb) is
'Configures WooCommerce order routing and manually or automatically assigns order tasks.';
comment on function public.v3_woocommerce_store_batch_and_yield(
  uuid,uuid,text,bigint,text,jsonb,jsonb,boolean
) is
'Atomically stores one WooCommerce page, routes new orders to tasks, advances its checkpoint, and queues completion or the next page.';

commit;
