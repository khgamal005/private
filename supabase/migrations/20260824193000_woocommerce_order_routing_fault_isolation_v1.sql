-- Isolate record-local WooCommerce routing failures without losing a page.
-- Raw entities remain durable; unknown or structural database failures still abort.
begin;

lock table commerce_sync.sync_runs in share row exclusive mode;

do $migration_gate$
begin
  if exists (
    select 1
    from commerce_sync.sync_runs run
    where run.status = 'running'
  ) then
    raise exception 'woocommerce_sync_migration_running_run';
  end if;
end;
$migration_gate$;

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
  v_attempted integer := 0;
  v_failed integer := 0;
  v_error_code text;
  v_error_codes jsonb := '[]'::jsonb;
  v_error_constraint text;
  v_error_message text;
  v_error_sqlstate text;
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
      raise exception 'woocommerce_order_external_entity_missing';
    end if;

    v_attempted := v_attempted + 1;
    begin
      select work_item.*
    into v_work_item
      from sales_core.commerce_order_work_items work_item
      where work_item.tenant_id = v_connection.tenant_id
        and work_item.connection_id = v_connection.id
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
    exception
      when others then
        get stacked diagnostics
          v_error_sqlstate = returned_sqlstate,
          v_error_constraint = constraint_name,
          v_error_message = message_text;

        if not (
          left(v_error_sqlstate, 2) = '22'
          or v_error_sqlstate in (
            '23502',
            '23503',
            '23505',
            '23514',
            '23P01'
          )
          or (
            v_error_sqlstate = 'P0001'
            and v_error_message in (
              'contact_identity_required',
              'invalid_email',
              'invalid_phone',
              'invalid_whatsapp'
            )
          )
        ) then
          raise;
        end if;

        v_error_code := case
          when v_error_sqlstate = 'P0001'
            then 'woocommerce_order_routing_' || v_error_message
          when v_error_sqlstate = '22001'
            then 'woocommerce_order_routing_value_too_long'
          when v_error_sqlstate = '22003'
            then 'woocommerce_order_routing_numeric_out_of_range'
          when v_error_sqlstate in ('22007', '22008')
            then 'woocommerce_order_routing_invalid_datetime'
          when left(v_error_sqlstate, 2) = '22'
            then 'woocommerce_order_routing_data_' || lower(v_error_sqlstate)
          else 'woocommerce_order_routing_constraint_'
            || lower(v_error_sqlstate)
        end;

        if coalesce(v_error_constraint, '') <> '' then
          v_error_code := left(
            v_error_code || '_' || left(
              pg_catalog.regexp_replace(
                lower(v_error_constraint),
                '[^a-z0-9_]+',
                '_',
                'g'
              ),
              60
            ),
            160
          );
        end if;

        update commerce_sync.external_entities entity
        set sync_state = 'error',
            last_error = left(v_error_code, 160),
            updated_at = clock_timestamp()
        where entity.id = v_entity.id
          and entity.tenant_id = v_connection.tenant_id
          and entity.connection_id = v_connection.id
          and entity.entity_type = 'orders'
          and entity.external_id = v_external_id
          and entity.last_seen_run_id = p_run_id;

        if not found then
          raise exception 'woocommerce_order_routing_error_record_missing';
        end if;

        update sales_core.commerce_order_work_items work_item
        set last_error = left(v_error_code, 160)
        where work_item.tenant_id = v_connection.tenant_id
          and work_item.connection_id = v_connection.id
          and work_item.external_order_id = v_external_id;

        v_failed := v_failed + 1;
        if jsonb_array_length(v_error_codes) < 10 then
          v_error_codes := v_error_codes || jsonb_build_array(v_error_code);
        end if;
    end;
  end loop;

  if v_failed > 0 then
    update commerce_sync.sync_runs run
    set failed_count = coalesce(run.failed_count, 0) + v_failed
    where run.id = p_run_id
      and run.connection_id = v_connection.id
      and run.tenant_id = v_connection.tenant_id
      and run.status = 'running';

    if not found then
      raise exception 'sync_run_not_running';
    end if;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'updated', v_updated,
    'skippedHistorical', v_skipped_historical,
    'attempted', v_attempted,
    'failed', v_failed,
    'errorCodes', v_error_codes
  );
end;
$$;

revoke all on function private_app.route_woocommerce_order_batch(
  uuid,
  uuid,
  jsonb
) from public, anon, authenticated;

comment on function private_app.route_woocommerce_order_batch(
  uuid,
  uuid,
  jsonb
) is
'Routes WooCommerce orders atomically per item; record-local data failures are tenant-fenced and reported without blocking the durable page.';

commit;
