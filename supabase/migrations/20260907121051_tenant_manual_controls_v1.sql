begin;
set local lock_timeout='5s';
set local statement_timeout='30s';

-- ODEIR only. Add administrative capability; do not change any tenant now.
create function public.v1_platform_tenant_controls_snapshot(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  t core.tenants%rowtype;
  sub jsonb;
  plans jsonb:='[]';
  can_manage boolean;
  can_bill boolean;
  can_delete boolean;
  reef boolean;
  members bigint;
  version text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  can_manage:=private_app.has_platform_permission('platform.tenants.manage');
  can_bill:=private_app.has_platform_permission('platform.billing.manage');
  can_delete:=private_app.has_platform_permission('platform.tenants.delete');
  if not (can_manage or can_bill or can_delete) then raise exception 'forbidden'; end if;
  select * into t from core.tenants where id=p_tenant_id;
  if t.id is null then raise exception 'tenant_not_found'; end if;
  reef:=private_app.is_reef_commerce_protected_v1(t.id);
  members:=private_app.tenant_plan_usage_count(t.id,'max_employees');
  select jsonb_build_object(
    'id',s.id,'planId',p.id,'planKey',p.plan_key,'planName',p.name_ar,
    'status',s.status,'periodStart',s.period_start,'periodEnd',s.period_end,
    'billingInterval',terms.billing_interval,'updatedAt',s.updated_at,
    'staffLimit',private_app.current_plan_limit(t.id,'max_employees')->'limitValue'
  ) into sub
  from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id
  left join catalog.independent_core_subscription_terms_v1 terms on terms.subscription_id=s.id
  where s.tenant_id=t.id and s.status in ('active','trialing','past_due','paused')
  order by s.created_at desc,s.id limit 1;
  if can_bill then
    select coalesce(jsonb_agg(item order by position),'[]') into plans from (
      select jsonb_build_object('id',p.id,'key',p.plan_key,'name',p.name_ar,
        'staffLimit',(c.profile->'limits'->>'staff')::bigint,
        'monthlyAmountMinor',c.monthly_amount_minor,'annualAmountMinor',c.annual_amount_minor,
        'internalOnly',false) item,c.display_order position
      from catalog.independent_commercial_catalog_v1 c join catalog.plans p on p.id=c.plan_id
      where c.kind='core' and c.published and p.status='active'
      union all
      select jsonb_build_object('id',p.id,'key',p.plan_key,'name',p.name_ar,
        'staffLimit',null,'monthlyAmountMinor',null,'annualAmountMinor',null,
        'internalOnly',true),999
      from catalog.plans p where p.plan_key='full' and p.status='active'
    ) available;
  end if;
  version:=encode(extensions.digest(jsonb_build_array(
    t.id,t.slug,t.name,t.status,t.updated_at,sub,members
  )::text,'sha256'),'hex');
  return jsonb_build_object('version',version,
    'tenant',jsonb_build_object('id',t.id,'name',t.name,'slug',t.slug,
      'status',t.status,'reefProtected',reef,'members',members),
    'subscription',sub,'plans',plans,
    'actions',jsonb_build_object('canSetPlan',can_bill and not reef,
      'canSetStatus',can_manage and not reef,
      'canDelete',can_delete and not reef and not exists(
        select 1 from platform.tenant_deletion_protections where tenant_id=t.id)));
end $$;
revoke all on function public.v1_platform_tenant_controls_snapshot(uuid) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_tenant_controls_snapshot(uuid) to authenticated;

create function public.v1_platform_tenant_controls_action(
  p_tenant_id uuid,p_action text,p_payload jsonb default '{}'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  t core.tenants%rowtype;
  before_state jsonb;
  after_state jsonb;
  selected jsonb;
  target_status text;
  cycle text;
  phrase text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if p_action is null or p_action not in ('set_plan','set_status') then
    raise exception 'tenant_controls_action_invalid';
  end if;
  if not private_app.has_platform_permission(case p_action
    when 'set_plan' then 'platform.billing.manage' else 'platform.tenants.manage' end)
    then raise exception 'forbidden'; end if;
  if p_tenant_id is null or p_payload is null or jsonb_typeof(p_payload)<>'object'
    or coalesce(p_payload->>'expectedVersion','') !~ '^[a-f0-9]{64}$'
    then raise exception 'tenant_controls_payload_invalid'; end if;
  if private_app.is_reef_commerce_protected_v1(p_tenant_id) then
    raise exception 'reef_contract_protected';
  end if;
  -- Lock the chosen offer before tenant/subscription rows, matching canonical
  -- assignment lock order. No edit can race the reviewed quote after this point.
  if p_action='set_plan' then
    if coalesce(p_payload->>'planId','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'tenant_controls_payload_invalid';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('odeir:core-catalog:'||(p_payload->>'planId'),0));
  end if;
  -- Same tenant lock as the reviewed deletion pipeline; never race a purge.
  perform pg_advisory_xact_lock(hashtextextended('odeir:tenant-delete:'||p_tenant_id::text,0));
  select * into t from core.tenants where id=p_tenant_id for update;
  if t.id is null then raise exception 'tenant_not_found'; end if;
  if private_app.is_reef_commerce_protected_v1(t.id) then
    raise exception 'reef_contract_protected';
  end if;
  perform 1 from catalog.subscriptions where tenant_id=t.id
    and status in ('active','trialing','past_due','paused') for update;
  before_state:=public.v1_platform_tenant_controls_snapshot(t.id);
  if before_state->>'version' is distinct from p_payload->>'expectedVersion' then
    raise exception 'tenant_controls_version_conflict';
  end if;
  if p_action='set_status' then
    target_status:=p_payload->>'status';
    if target_status is null or target_status not in ('active','suspended') then
      raise exception 'invalid_status'; end if;
    phrase:=(case target_status when 'active' then 'تفعيل ' else 'إيقاف ' end)||t.slug;
  else
    select value into selected from jsonb_array_elements(before_state->'plans')
      where value->>'id'=p_payload->>'planId';
    if selected is null then raise exception 'commercial_plan_not_available'; end if;
    cycle:=p_payload->>'billingInterval';
    if cycle is null or cycle not in ('month','year') then raise exception 'invalid_billing_interval'; end if;
    phrase:='تغيير باقة '||t.slug;
  end if;
  if p_payload->>'confirmation' is distinct from phrase then
    raise exception 'tenant_controls_confirmation_required'; end if;
  if p_action='set_status' then
    if t.status=target_status then return before_state||jsonb_build_object('changed',false); end if;
    perform public.v2_platform_set_tenant_status(t.id,target_status);
  else
    -- Existing canonical assignment function owns periods, terms, audit and FULL.
    -- It does not collect payment or enable a suspended tenant.
    perform public.v5_platform_commerce_action('set_subscription',jsonb_build_object(
      'tenantId',t.id,'planId',selected->>'id','status','active',
      'billingInterval',cycle,'periodStart',now()));
  end if;
  after_state:=public.v1_platform_tenant_controls_snapshot(t.id);
  perform private_app.write_audit('tenant.manual_control.changed','tenant',t.id::text,t.id,
    jsonb_build_object('action',p_action,'before',jsonb_build_object(
      'status',before_state->'tenant'->'status','subscription',before_state->'subscription'),
      'after',jsonb_build_object('status',after_state->'tenant'->'status',
      'subscription',after_state->'subscription'),'paymentCollected',false));
  return after_state||jsonb_build_object('changed',true,'paymentCollected',false);
end $$;
revoke all on function public.v1_platform_tenant_controls_action(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_tenant_controls_action(uuid,text,jsonb) to authenticated;

-- Pricing transition metadata is configuration, not a payment. Keep RESTRICT
-- constraints; clean it only after the EXISTING owner/digest/blocker checks.
-- Do not bypass any financial, integration, AI-memory, support or Reef blocker.
do $patch$
declare src text;needle text;replacement text;
begin
  src:=pg_get_functiondef('private_app.v1_tenant_deletion_preview_document_legacy_internal(uuid)'::regprocedure);
  needle:='''platform.tenant_deletion_protections''';
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then
    raise exception 'tenant_controls_deletion_preview_source_drift'; end if;
  execute replace(src,needle,'''catalog.core_transition_v1'','||chr(10)||'            '||needle);
  src:=pg_get_functiondef('public.v1_platform_tenant_delete(uuid,text,text,text,uuid)'::regprocedure);
  needle:='delete from core.tenants tenant where tenant.id=v_tenant.id;';
  if (length(src)-length(replace(src,needle,'')))/length(needle)<>1 then
    raise exception 'tenant_controls_deletion_execute_source_drift'; end if;
  replacement:=$cleanup$
  -- Reviewed, tenant-scoped pricing metadata cleanup; no financial rows here.
  delete from catalog.core_transition_v1 where tenant_id=v_tenant.id;
  delete from catalog.independent_core_subscription_terms_v1 terms
  using catalog.subscriptions subscription
  where terms.subscription_id=subscription.id and subscription.tenant_id=v_tenant.id;
  delete from core.tenants tenant where tenant.id=v_tenant.id;$cleanup$;
  execute replace(src,needle,replacement);
end $patch$;

alter function private_app.v1_tenant_deletion_preview_document(uuid)
  rename to tenant_deletion_preview_before_manual_controls_v1;
revoke all on function private_app.tenant_deletion_preview_before_manual_controls_v1(uuid) from public,anon,authenticated,service_role;
create function private_app.v1_tenant_deletion_preview_document(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare b jsonb;counts jsonb;metadata_digest text;
begin
  b:=private_app.tenant_deletion_preview_before_manual_controls_v1(p_tenant_id);
  counts:=coalesce(b->'counts','{}')||jsonb_build_object(
    'coreTransitionRecords',(select count(*) from catalog.core_transition_v1 where tenant_id=p_tenant_id),
    'coreSubscriptionTerms',(select count(*) from catalog.independent_core_subscription_terms_v1 terms
      join catalog.subscriptions s on s.id=terms.subscription_id where s.tenant_id=p_tenant_id));
  select encode(extensions.digest(jsonb_build_object(
    'transition',(select jsonb_agg(to_jsonb(tr) order by tr.tenant_id)
      from catalog.core_transition_v1 tr where tr.tenant_id=p_tenant_id),
    'terms',(select jsonb_agg(to_jsonb(terms) order by terms.subscription_id)
      from catalog.independent_core_subscription_terms_v1 terms
      join catalog.subscriptions s on s.id=terms.subscription_id where s.tenant_id=p_tenant_id)
  )::text,'sha256'),'hex') into metadata_digest;
  return b||jsonb_build_object('counts',counts,'previewDigest',encode(extensions.digest(
    (b->>'previewDigest')||'|'||metadata_digest,'sha256'),'hex'));
end $$;
revoke all on function private_app.v1_tenant_deletion_preview_document(uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
