begin;

-- Normalize shared product copy only. Tenant business records and Reef data are untouched.
update catalog.plans
set description=replace(description,'مُدار','أودير'),
    updated_at=now()
where description like '%مُدار%';

update marketplace.service_products
set name_ar=replace(name_ar,'مُدار','أودير'),
    description_ar=replace(description_ar,'مُدار','أودير'),
    updated_at=now()
where concat_ws(' ',name_ar,description_ar) like '%مُدار%';

update catalog.addon_products
set name_ar=replace(name_ar,'مُدار','أودير'),
    name_en=replace(name_en,'Modaar','ODEIR'),
    description_ar=replace(description_ar,'مُدار','أودير'),
    badge_ar=replace(badge_ar,'مُدار','أودير'),
    updated_at=now()
where concat_ws(' ',name_ar,name_en,description_ar,badge_ar) ~* '(مُدار|modaar)';

-- Rename only the built-in demo display labels; stable keys and URLs stay unchanged.
update core.organizations
set legal_name='مركز أودير النموذجي للتدريب',
    display_name='مركز أودير النموذجي للتدريب',
    updated_at=now()
where organization_key='org-modaar-training-center'
  and (
    legal_name='مركز مُدار النموذجي للتدريب'
    or display_name='مركز مُدار النموذجي للتدريب'
  );

update core.tenants
set name='مركز أودير النموذجي للتدريب',
    legal_name='مركز أودير النموذجي للتدريب',
    updated_at=now()
where slug='modaar-training-center'
  and (
    name='مركز مُدار النموذجي للتدريب'
    or legal_name='مركز مُدار النموذجي للتدريب'
  );

-- Keep existing immutable order numbers and use the Odeir prefix for new orders.
alter table marketplace.orders
  alter column order_number set default (
    'ODR-' || to_char(current_date,'YYMM') || '-' ||
    lpad(nextval('marketplace.order_number_seq')::text,6,'0')
  );

create or replace function public.v2_platform_provision_tenant(
  p_display_name text,
  p_legal_name text,
  p_slug text,
  p_country_code text,
  p_timezone text,
  p_plan_key text,
  p_owner_name text,
  p_owner_email text,
  p_hostname text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_organization_id uuid;
  v_tenant_id uuid;
  v_plan_id uuid;
  v_hostname text;
  v_owner_email text;
  v_owner_link jsonb;
  v_invitation_token text;
  v_invitation_id uuid;
  v_domain_id uuid;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  if p_display_name is null or length(trim(p_display_name)) < 2 then
    raise exception 'display_name_required';
  end if;

  if p_slug is null or p_slug !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' then
    raise exception 'invalid_slug';
  end if;

  if exists (select 1 from core.tenants where slug = p_slug) then
    raise exception 'slug_exists';
  end if;

  if p_owner_name is null or length(trim(p_owner_name)) < 2 then
    raise exception 'owner_name_required';
  end if;

  v_owner_email := lower(trim(coalesce(p_owner_email, '')));
  if v_owner_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_owner_email';
  end if;

  select p.id
  into v_plan_id
  from catalog.plans p
  where p.plan_key = coalesce(nullif(trim(p_plan_key), ''), 'free')
    and p.status = 'active'
  limit 1;

  if v_plan_id is null then
    raise exception 'plan_not_found';
  end if;

  v_hostname := lower(trim(coalesce(p_hostname, '')));
  if v_hostname <> '' then
    v_hostname := regexp_replace(v_hostname, '\.$', '');
    if v_hostname !~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' then
      raise exception 'invalid_hostname';
    end if;
    if exists (select 1 from core.domains where hostname = v_hostname) then
      raise exception 'domain_exists';
    end if;
  end if;

  insert into core.organizations (
    organization_key,
    legal_name,
    display_name,
    country_code
  )
  values (
    'org-' || p_slug,
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    trim(p_display_name),
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA'))
  )
  returning id into v_organization_id;

  insert into core.tenants (
    organization_id,
    tenant_key,
    slug,
    name,
    legal_name,
    status,
    country_code,
    timezone
  )
  values (
    v_organization_id,
    'tenant-' || p_slug,
    p_slug,
    trim(p_display_name),
    coalesce(nullif(trim(p_legal_name), ''), trim(p_display_name)),
    'trial',
    upper(coalesce(nullif(trim(p_country_code), ''), 'SA')),
    coalesce(nullif(trim(p_timezone), ''), 'Asia/Riyadh')
  )
  returning id into v_tenant_id;

  insert into core.tenant_modules (tenant_id, module_id, enabled, enabled_at)
  select v_tenant_id, m.id, true, now()
  from core.modules m
  where m.enabled_by_default
  on conflict do nothing;

  insert into catalog.subscriptions (tenant_id, plan_id, status)
  values (v_tenant_id, v_plan_id, 'trialing');

  if v_hostname <> '' then
    insert into core.domains (
      tenant_id,
      hostname,
      domain_type,
      status,
      is_primary
    )
    values (
      v_tenant_id,
      v_hostname,
      case
        when v_hostname in (p_slug || '.odeir.com', p_slug || '.marktone.sa') then 'subdomain'
        else 'custom'
      end,
      'pending',
      true
    )
    returning id into v_domain_id;
  end if;

  v_owner_link := private_app.link_existing_tenant_user(
    v_tenant_id,
    trim(p_owner_name),
    v_owner_email,
    'tenant_owner'
  );

  if not coalesce((v_owner_link ->> 'linked')::boolean, false) then
    v_invitation_token := encode(extensions.gen_random_bytes(32), 'hex');

    insert into access_control.tenant_invitations (
      tenant_id,
      email,
      full_name,
      role_key,
      token_hash,
      invited_by_subject_id
    )
    values (
      v_tenant_id,
      v_owner_email,
      trim(p_owner_name),
      'tenant_owner',
      encode(extensions.digest(v_invitation_token, 'sha256'), 'hex'),
      private_app.current_subject_id()
    )
    returning id into v_invitation_id;
  end if;

  perform private_app.write_audit(
    'tenant.provisioned',
    'tenant',
    v_tenant_id::text,
    v_tenant_id,
    jsonb_build_object(
      'slug', p_slug,
      'name', trim(p_display_name),
      'planKey', coalesce(nullif(trim(p_plan_key), ''), 'free'),
      'ownerEmail', v_owner_email,
      'ownerLinked', coalesce((v_owner_link ->> 'linked')::boolean, false),
      'domain', nullif(v_hostname, '')
    )
  );

  return jsonb_build_object(
    'id', v_tenant_id,
    'slug', p_slug,
    'status', 'trial',
    'planKey', coalesce(nullif(trim(p_plan_key), ''), 'free'),
    'domain', case
      when v_domain_id is null then null
      else jsonb_build_object(
        'id', v_domain_id,
        'hostname', v_hostname,
        'status', 'pending'
      )
    end,
    'owner', jsonb_build_object(
      'name', trim(p_owner_name),
      'email', v_owner_email,
      'status', case
        when coalesce((v_owner_link ->> 'linked')::boolean, false) then 'linked'
        else 'invited'
      end,
      'invitationId', v_invitation_id,
      'invitationToken', v_invitation_token
    )
  );
end;
$$;

create or replace function public.v2_tenant_automation_studio_action(
  p_slug text,
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_actor_subject_id uuid;
  v_rule automation_engine.rules%rowtype;
  v_event_id uuid;
  v_run_id uuid;
  v_values jsonb;
  v_subject text;
  v_body text;
  v_processed jsonb;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  v_actor_subject_id := private_app.current_subject_id();
  perform private_app.ensure_automation_rules(v_tenant.id);

  if p_action in ('save_rule', 'toggle_rule', 'preview_rule') then
    begin
      select *
      into v_rule
      from automation_engine.rules rule
      where rule.id = (p_payload ->> 'ruleId')::uuid
        and rule.tenant_id = v_tenant.id
      for update;
    exception when invalid_text_representation then
      raise exception 'invalid_automation_rule';
    end;
    if v_rule.id is null then
      raise exception 'automation_rule_not_found';
    end if;
  end if;

  if p_action = 'toggle_rule' then
    update automation_engine.rules
    set status = case
          when coalesce((p_payload ->> 'enabled')::boolean, false)
            then 'active'
          else 'paused'
        end,
        updated_by_subject_id = v_actor_subject_id
    where id = v_rule.id
    returning * into v_rule;
    perform private_app.sync_legacy_automation_rule(v_rule);

  elsif p_action = 'save_rule' then
    if coalesce(p_payload ->> 'executionMode', '')
       not in ('live', 'preview') then
      raise exception 'invalid_automation_mode';
    end if;
    if coalesce(p_payload ->> 'primaryChannel', '')
       not in ('auto', 'whatsapp', 'email') then
      raise exception 'invalid_automation_channel';
    end if;
    if coalesce(p_payload ->> 'fallbackChannel', '')
       not in ('none', 'whatsapp', 'email') then
      raise exception 'invalid_automation_fallback';
    end if;

    update automation_engine.rules
    set execution_mode = p_payload ->> 'executionMode',
        primary_channel = p_payload ->> 'primaryChannel',
        fallback_channel = p_payload ->> 'fallbackChannel',
        delay_minutes = least(
          greatest(coalesce((p_payload ->> 'delayMinutes')::integer, 0), 0),
          43200
        ),
        updated_by_subject_id = v_actor_subject_id
    where id = v_rule.id
    returning * into v_rule;
    perform private_app.sync_legacy_automation_rule(v_rule);

  elsif p_action = 'preview_rule' then
    v_values := jsonb_build_object(
      'name', 'سارة أحمد',
      'course', 'إدارة المشاريع الاحترافية',
      'batch', 'دفعة أغسطس',
      'session', 'الجلسة الثانية',
      'date', '2026-08-15',
      'time', '18:00',
      'link', 'https://example.com/training',
      'amount', '699 ر.س',
      'certificate_number', 'ODEIR-DEMO-001',
      'certificate_link', '/certificates/demo',
      'delivery_mode', 'عن بُعد',
      'center', v_tenant.name
    );
    insert into automation_engine.events (
      tenant_id,
      event_key,
      source_type,
      source_id,
      idempotency_key,
      payload,
      status,
      processed_at
    )
    values (
      v_tenant.id,
      v_rule.trigger_key,
      'preview',
      v_rule.id::text,
      'preview:' || v_rule.id::text || ':' || gen_random_uuid()::text,
      jsonb_build_object(
        'templateValues', v_values,
        'recipientPhone', '966500000000',
        'recipientEmail', 'preview@example.com'
      ),
      'completed',
      now()
    )
    returning id into v_event_id;

    v_subject := private_app.message_template_field(
      v_tenant.id,
      v_rule.template_key,
      case
        when v_rule.primary_channel = 'email' then 'email'
        else 'whatsapp'
      end,
      'subject',
      v_values,
      v_rule.name_ar
    );
    v_body := private_app.message_template_field(
      v_tenant.id,
      v_rule.template_key,
      case
        when v_rule.primary_channel = 'email' then 'email'
        else 'whatsapp'
      end,
      'body',
      v_values,
      v_rule.description_ar
    );

    insert into automation_engine.runs (
      tenant_id,
      event_id,
      rule_id,
      status,
      result,
      completed_at
    )
    values (
      v_tenant.id,
      v_event_id,
      v_rule.id,
      'previewed',
      jsonb_build_object(
        'subject', v_subject,
        'body', v_body,
        'sent', false,
        'truthLabel', 'preview_not_queued'
      ),
      now()
    )
    returning id into v_run_id;

    return jsonb_build_object(
      'ruleId', v_rule.id,
      'runId', v_run_id,
      'subject', v_subject,
      'body', v_body,
      'sent', false
    );

  elsif p_action = 'process_now' then
    v_processed := private_app.process_automation_events(
      100,
      v_tenant.id
    );
    return jsonb_build_object(
      'action', p_action,
      'processed', v_processed
    );
  else
    raise exception 'invalid_automation_action';
  end if;

  insert into audit_log.events (
    tenant_id,
    actor_subject_id,
    action,
    resource_type,
    resource_id,
    context
  )
  values (
    v_tenant.id,
    v_actor_subject_id,
    'automation.rule.' || p_action,
    'automation_rule',
    v_rule.id::text,
    jsonb_build_object(
      'ruleKey', v_rule.rule_key,
      'status', v_rule.status,
      'executionMode', v_rule.execution_mode,
      'primaryChannel', v_rule.primary_channel,
      'fallbackChannel', v_rule.fallback_channel,
      'delayMinutes', v_rule.delay_minutes
    )
  );

  return jsonb_build_object(
    'ruleId', v_rule.id,
    'status', v_rule.status,
    'executionMode', v_rule.execution_mode,
    'primaryChannel', v_rule.primary_channel,
    'fallbackChannel', v_rule.fallback_channel,
    'delayMinutes', v_rule.delay_minutes
  );
end;
$$;

create or replace function private_app.yeastar_settings_snapshot_core(
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
  v_connection communication_hub.provider_connections%rowtype;
  v_last_run telephony.sync_runs%rowtype;
begin
  select * into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.settings.manage'
  ) then raise exception 'forbidden'; end if;

  select * into v_connection
  from communication_hub.provider_connections connection
  where connection.tenant_id = v_tenant.id
    and connection.provider_key = 'yeastar_p550'
  limit 1;

  if v_connection.id is not null then
    select * into v_last_run
    from telephony.sync_runs run
    where run.provider_connection_id = v_connection.id
    order by run.started_at desc
    limit 1;
  end if;

  return jsonb_build_object(
    'canManage', true,
    'configured', v_connection.id is not null,
    'connectionId', v_connection.id,
    'displayName', coalesce(v_connection.display_name, 'Yeastar P550'),
    'status', coalesce(v_connection.status, 'disabled'),
    'publicConfig', coalesce(
      v_connection.public_config,
      jsonb_build_object(
        'baseUrl', '',
        'extensions', '',
        'timezone', 'Asia/Riyadh',
        'syncIntervalMinutes', 60,
        'initialHistoryDays', 30,
        'apiMode', 'auto'
      )
    ),
    'configuredSecrets',
      case
        when v_connection.id is null then '[]'::jsonb
        else coalesce((
          select jsonb_agg(secret.key order by secret.key)
          from jsonb_each_text(v_connection.secret_refs) secret
        ), '[]'::jsonb)
      end,
    'lastCheckedAt', v_connection.last_checked_at,
    'lastError', v_connection.last_error,
    'lastSync',
      case
        when v_last_run.id is null then null
        else jsonb_build_object(
          'status', v_last_run.status,
          'startedAt', v_last_run.started_at,
          'finishedAt', v_last_run.finished_at,
          'fetchedCount', v_last_run.fetched_count,
          'insertedCount', v_last_run.inserted_count,
          'updatedCount', v_last_run.updated_count,
          'deviceModel', v_last_run.device_model,
          'firmwareVersion', v_last_run.firmware_version,
          'apiVersion', v_last_run.api_version,
          'errorDetail', v_last_run.error_detail
        )
      end
  );
end;
$$;

create or replace function public.v4_platform_commerce_action(
  p_action text,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_plan catalog.plans%rowtype;
  v_plan_id uuid;
  v_category_id uuid;
  v_product_id uuid;
  v_limit record;
  v_status text;
  v_interval text;
  v_amount bigint;
  v_tenant_id uuid;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_subscription_id uuid;
begin
  if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;

  if p_action='save_plan' then
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    v_status=coalesce(nullif(p_payload->>'status',''),'active');
    v_interval=coalesce(nullif(p_payload->>'interval',''),'month');
    v_amount=coalesce((p_payload->>'amountMinor')::bigint,0);
    if coalesce(trim(p_payload->>'nameAr'),'')='' then raise exception 'plan_name_required'; end if;
    if v_status not in ('draft','active','archived') then raise exception 'invalid_plan_status'; end if;
    if v_interval not in ('month','year','one_time') then raise exception 'invalid_plan_interval'; end if;
    if v_amount<0 then raise exception 'invalid_plan_price'; end if;
    if v_plan_id is null then
      if coalesce(p_payload->>'planKey','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_plan_key'; end if;
      insert into catalog.plans(
        plan_key,name_ar,name_en,description,amount_minor,currency,interval,status,is_public,display_order
      ) values(
        p_payload->>'planKey',trim(p_payload->>'nameAr'),nullif(trim(p_payload->>'nameEn'),''),
        nullif(trim(p_payload->>'description'),''),v_amount,upper(coalesce(nullif(p_payload->>'currency',''),'SAR')),
        v_interval,v_status,coalesce((p_payload->>'isPublic')::boolean,true),coalesce((p_payload->>'displayOrder')::integer,100)
      ) returning * into v_plan;
    else
      update catalog.plans set
        name_ar=trim(p_payload->>'nameAr'),name_en=nullif(trim(p_payload->>'nameEn'),''),
        description=nullif(trim(p_payload->>'description'),''),amount_minor=v_amount,
        currency=upper(coalesce(nullif(p_payload->>'currency',''),currency)),interval=v_interval,
        status=v_status,is_public=coalesce((p_payload->>'isPublic')::boolean,is_public),
        display_order=coalesce((p_payload->>'displayOrder')::integer,display_order),updated_at=now()
      where id=v_plan_id returning * into v_plan;
      if v_plan.id is null then raise exception 'plan_not_found'; end if;
    end if;
    perform private_app.write_audit('plan.saved','plan',v_plan.id::text,null,jsonb_build_object('planKey',v_plan.plan_key));
    return jsonb_build_object('id',v_plan.id,'key',v_plan.plan_key);

  elsif p_action='save_plan_limits' then
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    if not exists(select 1 from catalog.plans where id=v_plan_id) then raise exception 'plan_not_found'; end if;
    for v_limit in
      select definition.limit_key,
             p_payload->'limits'->definition.limit_key->>'value' limit_value,
             coalesce(nullif(p_payload->'limits'->definition.limit_key->>'enforcement',''),'hard') enforcement
      from catalog.plan_limit_definitions definition where definition.status='active'
    loop
      if v_limit.enforcement not in ('hard','soft') then raise exception 'invalid_plan_limit'; end if;
      if v_limit.limit_value is not null and v_limit.limit_value<>'' and v_limit.limit_value::bigint<0 then raise exception 'invalid_plan_limit'; end if;
      insert into catalog.plan_limits(plan_id,limit_key,limit_value,enforcement,updated_by_subject_id)
      values(v_plan_id,v_limit.limit_key,
        case when v_limit.limit_value is null or v_limit.limit_value='' then null else v_limit.limit_value::bigint end,
        v_limit.enforcement,private_app.current_subject_id())
      on conflict (plan_id,limit_key) do update set
        limit_value=excluded.limit_value,enforcement=excluded.enforcement,
        updated_by_subject_id=excluded.updated_by_subject_id,updated_at=now();
    end loop;
    perform private_app.write_audit('plan.limits.saved','plan',v_plan_id::text,null,'{}'::jsonb);
    return jsonb_build_object('planId',v_plan_id,'saved',true);

  elsif p_action='set_subscription' then
    v_tenant_id=nullif(p_payload->>'tenantId','')::uuid;
    v_plan_id=nullif(p_payload->>'planId','')::uuid;
    v_status=coalesce(nullif(p_payload->>'status',''),'active');
    if v_status not in ('trialing','active','past_due','paused') then raise exception 'invalid_subscription_status'; end if;
    if not exists(select 1 from core.tenants where id=v_tenant_id) then raise exception 'tenant_not_found'; end if;
    if not exists(select 1 from catalog.plans where id=v_plan_id and status='active') then raise exception 'plan_not_found'; end if;
    v_period_start=coalesce(nullif(p_payload->>'periodStart','')::timestamptz,now());
    v_period_end=nullif(p_payload->>'periodEnd','')::timestamptz;
    if v_period_end is not null and v_period_end<=v_period_start then raise exception 'invalid_subscription_period'; end if;
    update catalog.subscriptions set status='cancelled',period_end=coalesce(period_end,now()),updated_at=now()
    where tenant_id=v_tenant_id and status in ('trialing','active','past_due','paused');
    insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
    values(v_tenant_id,v_plan_id,v_status,v_period_start,v_period_end)
    returning id into v_subscription_id;
    perform private_app.write_audit('subscription.changed','subscription',v_subscription_id::text,v_tenant_id,jsonb_build_object('planId',v_plan_id,'status',v_status));
    return jsonb_build_object('id',v_subscription_id,'tenantId',v_tenant_id);

  elsif p_action='save_addon_category' then
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'category_name_required'; end if;
    if v_category_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_category_key'; end if;
      insert into catalog.addon_categories(category_key,name_ar,description_ar,icon_key,display_order,status)
      values(p_payload->>'key',trim(p_payload->>'name'),nullif(trim(p_payload->>'description'),''),
        coalesce(nullif(p_payload->>'iconKey',''),'addon'),coalesce((p_payload->>'displayOrder')::integer,100),'active')
      returning id into v_category_id;
    else
      update catalog.addon_categories set name_ar=trim(p_payload->>'name'),
        description_ar=nullif(trim(p_payload->>'description'),''),
        icon_key=coalesce(nullif(p_payload->>'iconKey',''),icon_key),updated_at=now()
      where id=v_category_id;
      if not found then raise exception 'category_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_category_id);

  elsif p_action='assign_addon_category' then
    v_product_id=nullif(p_payload->>'productId','')::uuid;
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if not exists(select 1 from catalog.addon_categories where id=v_category_id and status='active') then raise exception 'category_not_found'; end if;
    update catalog.addon_products set category_id=v_category_id,updated_at=now() where id=v_product_id;
    if not found then raise exception 'addon_product_not_found'; end if;
    return jsonb_build_object('id',v_product_id,'categoryId',v_category_id);

  elsif p_action='save_service_category' then
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'category_name_required'; end if;
    if v_category_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,60}$' then raise exception 'invalid_category_key'; end if;
      insert into marketplace.service_categories(category_key,name_ar,description_ar,icon_key,sort_order,status)
      values(p_payload->>'key',trim(p_payload->>'name'),nullif(trim(p_payload->>'description'),''),
        coalesce(nullif(p_payload->>'iconKey',''),'services'),coalesce((p_payload->>'displayOrder')::integer,100),'active')
      returning id into v_category_id;
    else
      update marketplace.service_categories set name_ar=trim(p_payload->>'name'),
        description_ar=nullif(trim(p_payload->>'description'),''),
        icon_key=coalesce(nullif(p_payload->>'iconKey',''),icon_key),updated_at=now()
      where id=v_category_id;
      if not found then raise exception 'category_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_category_id);

  elsif p_action='save_service_product' then
    v_product_id=nullif(p_payload->>'productId','')::uuid;
    v_category_id=nullif(p_payload->>'categoryId','')::uuid;
    v_amount=coalesce((p_payload->>'amountMinor')::bigint,0);
    if coalesce(trim(p_payload->>'name'),'')='' then raise exception 'service_name_required'; end if;
    if not exists(select 1 from marketplace.service_categories where id=v_category_id and status='active') then raise exception 'category_not_found'; end if;
    if v_product_id is null then
      if coalesce(p_payload->>'key','')!~'^[a-z][a-z0-9_]{2,80}$' then raise exception 'invalid_service_key'; end if;
      insert into marketplace.service_products(
        category_id,product_key,name_ar,description_ar,pricing_mode,amount_minor,currency,
        unit_label_ar,turnaround_days,badge_ar,status
      ) values(
        v_category_id,p_payload->>'key',trim(p_payload->>'name'),coalesce(nullif(trim(p_payload->>'description'),''),'خدمة من أودير'),
        coalesce(nullif(p_payload->>'pricingMode',''),'fixed'),v_amount,
        upper(coalesce(nullif(p_payload->>'currency',''),'SAR')),coalesce(nullif(trim(p_payload->>'unitLabel'),''),'خدمة'),
        nullif(p_payload->>'turnaroundDays','')::integer,nullif(trim(p_payload->>'badge'),''),
        coalesce(nullif(p_payload->>'status',''),'active')
      ) returning id into v_product_id;
    else
      update marketplace.service_products set category_id=v_category_id,name_ar=trim(p_payload->>'name'),
        description_ar=coalesce(nullif(trim(p_payload->>'description'),''),description_ar),
        pricing_mode=coalesce(nullif(p_payload->>'pricingMode',''),pricing_mode),amount_minor=v_amount,
        currency=upper(coalesce(nullif(p_payload->>'currency',''),currency)),
        unit_label_ar=coalesce(nullif(trim(p_payload->>'unitLabel'),''),unit_label_ar),
        turnaround_days=nullif(p_payload->>'turnaroundDays','')::integer,badge_ar=nullif(trim(p_payload->>'badge'),''),
        status=coalesce(nullif(p_payload->>'status',''),status),updated_at=now()
      where id=v_product_id;
      if not found then raise exception 'service_not_found'; end if;
    end if;
    return jsonb_build_object('id',v_product_id);
  else
    raise exception 'commerce_action_invalid';
  end if;
end;
$$;

commit;
