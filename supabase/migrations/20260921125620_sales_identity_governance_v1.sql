-- Approved operational governance: canonical customer identity and repeat sales.
-- No data backfill, customer merge, tenant rewrite, or automatic reassignment.
-- Legacy opportunity classification remains explicit until reviewed.

begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

alter table sales_core.opportunities add column if not exists opportunity_kind text
  not null default 'legacy_unclassified';
alter table sales_core.opportunities add constraint opportunities_kind_governance_check
  check (opportunity_kind in ('training','general','legacy_unclassified')
    and (opportunity_kind <> 'training' or course_id is not null)) not valid;
create unique index if not exists opportunities_creation_command_uidx
  on sales_core.opportunities(tenant_id,(metadata->>'creationCommandId'))
  where metadata->>'creationCommandId' is not null;

create or replace function private_app.require_primary_customer_phone_v1()
returns trigger language plpgsql set search_path='' as $function$
begin
  if private_app.normalize_lead_phone(new.phone) is null
     and (tg_op='INSERT' or new.phone is distinct from old.phone) then
    raise exception 'primary_phone_required';
  end if;
  -- Existing missing-phone records can still be serviced; identity correction is
  -- explicit, never a guessed primary phone or a bulk rewrite.
  if tg_op='UPDATE' and new.tenant_id is distinct from old.tenant_id then
    raise exception 'contact_tenant_immutable';
  end if;
  return new;
end;
$function$;
revoke all on function private_app.require_primary_customer_phone_v1() from public,anon,authenticated;
create trigger sales_contacts_primary_phone_governance
  before insert or update of phone,tenant_id on sales_core.contacts
  for each row execute function private_app.require_primary_customer_phone_v1();

create or replace function private_app.validate_customer_phone_capacity_v1(
  p_primary text,p_whatsapp text,p_additional jsonb
) returns void language plpgsql immutable set search_path='' as $function$
declare v_phone text; v_item jsonb; v_seen text[]; v_primary text;
begin
  v_primary := private_app.normalize_lead_phone(p_primary);
  if v_primary is null then raise exception 'primary_phone_required'; end if;
  if jsonb_typeof(p_additional) is distinct from 'array' then raise exception 'invalid_followup_details'; end if;
  v_seen := array[v_primary];
  v_phone := private_app.normalize_lead_phone(p_whatsapp);
  if v_phone is not null and v_phone<>v_primary then v_seen:=array_append(v_seen,v_phone); end if;
  for v_item in select value from jsonb_array_elements(p_additional) loop
    if jsonb_typeof(v_item)<>'string' or length(v_item #>> '{}')>40 then raise exception 'invalid_phone'; end if;
    v_phone:=private_app.normalize_lead_phone(v_item #>> '{}');
    if v_phone is null then raise exception 'invalid_phone'; end if;
    if v_phone=any(v_seen) then raise exception 'duplicate_additional_phone'; end if;
    v_seen:=array_append(v_seen,v_phone);
  end loop;
  if cardinality(v_seen)>5 then raise exception 'additional_phone_limit'; end if;
end;
$function$;
revoke all on function private_app.validate_customer_phone_capacity_v1(text,text,jsonb) from public,anon,authenticated;

-- The existing unique tenant/type/value index remains authoritative, including
-- historical aliases: changing a number never makes another customer's identity reusable.
create or replace function private_app.guard_customer_identity_capacity_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_contact sales_core.contacts%rowtype; v_count integer;
begin
  if new.identity_type<>'phone' or new.source_slot='historical_alias' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.tenant_id::text,1729));
  select * into v_contact from sales_core.contacts where tenant_id=new.tenant_id and id=new.contact_id;
  if not found then raise exception 'invalid_contact'; end if;
  select count(distinct number) into v_count from (
    select private_app.normalize_lead_phone(v_contact.phone) number
    union all select private_app.normalize_lead_phone(v_contact.whatsapp)
    union all select identity_value from sales_core.contact_identities
      where tenant_id=new.tenant_id and contact_id=new.contact_id and identity_type='phone'
        and source_slot='additional_phone' and id is distinct from new.id
    union all select new.identity_value
  ) numbers where number is not null;
  if v_count>5 then raise exception 'additional_phone_limit'; end if;
  return new;
end;
$function$;
revoke all on function private_app.guard_customer_identity_capacity_v1() from public,anon,authenticated;
create trigger customer_identity_capacity_before_write
  before insert or update of identity_value,source_slot,contact_id on sales_core.contact_identities
  for each row execute function private_app.guard_customer_identity_capacity_v1();

create or replace function private_app.guard_opportunity_governance_v1()
returns trigger language plpgsql security definer set search_path='' as $function$
declare v_contact sales_core.contacts%rowtype;
begin
  select * into v_contact from sales_core.contacts where tenant_id=new.tenant_id and id=new.contact_id;
  if not found then raise exception 'invalid_contact'; end if;
  if tg_op='INSERT' then
    if new.opportunity_kind='legacy_unclassified' then
      new.opportunity_kind:=case when new.course_id is null then 'general' else 'training' end;
    end if;
    if new.owner_staff_id is not null and v_contact.owner_staff_id is not null
       and new.owner_staff_id<>v_contact.owner_staff_id then raise exception 'contact_owner_required'; end if;
    new.owner_staff_id:=coalesce(v_contact.owner_staff_id,new.owner_staff_id);
    if v_contact.owner_staff_id is null and new.owner_staff_id is not null then
      update sales_core.contacts set owner_staff_id=new.owner_staff_id where tenant_id=new.tenant_id and id=new.contact_id;
      perform private_app.write_audit('tenant.customer_owner_initialized','sales_contact',new.contact_id::text,new.tenant_id,
        jsonb_build_object('ownerStaffId',new.owner_staff_id,'source','opportunity_creation'));
    end if;
    -- Acquisition source and each new sale's documented attribution are separate.
    new.metadata:=new.metadata || jsonb_build_object('attribution',jsonb_strip_nulls(jsonb_build_object(
      'version',1,'source',nullif(new.metadata#>>'{attribution,source}',''),
      'campaignName',nullif(new.metadata#>>'{attribution,campaignName}',''),
      'adName',nullif(new.metadata#>>'{attribution,adName}',''),'capturedAt',now(),
      'origin',case when nullif(new.metadata#>>'{attribution,source}','') is null
        then 'unattributed' else 'documented_sale_source' end
    )));
  elsif new.tenant_id is distinct from old.tenant_id or new.contact_id is distinct from old.contact_id then
    raise exception 'opportunity_identity_immutable';
  elsif new.owner_staff_id is distinct from old.owner_staff_id
      and new.owner_staff_id is distinct from v_contact.owner_staff_id then
    raise exception 'contact_owner_required';
  end if;
  if new.course_id is not null and not exists(select 1 from academy.courses
    where tenant_id=new.tenant_id and id=new.course_id) then raise exception 'invalid_course'; end if;
  if new.opportunity_kind='training' and new.course_id is null then raise exception 'training_course_required'; end if;
  return new;
end;
$function$;
revoke all on function private_app.guard_opportunity_governance_v1() from public,anon,authenticated;
create trigger opportunity_governance_before_write before insert or update of
  tenant_id,contact_id,course_id,owner_staff_id,opportunity_kind on sales_core.opportunities
  for each row execute function private_app.guard_opportunity_governance_v1();

-- One customer calendar task represents the earliest outstanding opportunity.
-- Contact row + existing lifecycle advisory lock serialize all creation/reuse.
create or replace function private_app.sync_customer_sales_task_v1(p_tenant_id uuid,p_contact_id uuid)
returns uuid language plpgsql security definer set search_path='' as $function$
declare v_contact sales_core.contacts%rowtype; v_opportunity sales_core.opportunities%rowtype;
  v_task work_core.tasks%rowtype; v_task_id uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_tenant_id::text||':'||p_contact_id::text,31603));
  select * into v_contact from sales_core.contacts where tenant_id=p_tenant_id and id=p_contact_id for update;
  if not found then raise exception 'invalid_contact'; end if;
  select * into v_opportunity from sales_core.opportunities where tenant_id=p_tenant_id and contact_id=p_contact_id
    and status='open' and next_action_at is not null and next_action_type is not null
    order by next_action_at,created_at,id limit 1;
  select * into v_task from work_core.tasks where tenant_id=p_tenant_id and contact_id=p_contact_id
    and metadata->>'source' in ('lead_assignment','opportunity_next_action','activity_next_action','lead_next_action','sales_followup')
    order by (status in ('todo','in_progress')) desc,updated_at desc,id limit 1 for update;
  if exists(select 1 from sales_core.opportunities where tenant_id=p_tenant_id and contact_id=p_contact_id and status='open') then
    -- lead_status is a legacy summary of current sales work; payment/admission
    -- history remains on its own opportunity and handoff.
    update sales_core.contacts set status='active',
      lead_status=case when lead_status in ('paid','payment_submitted','not_interested','unqualified','wrong_number','duplicate','cancelled')
        then 'follow_up' else lead_status end,
      lead_status_changed_at=case when lead_status in ('paid','payment_submitted','not_interested','unqualified','wrong_number','duplicate','cancelled')
        then now() else lead_status_changed_at end,
      metadata=metadata||jsonb_build_object('salesLifecycleSource','open_opportunities')
      where tenant_id=p_tenant_id and id=p_contact_id;
    if v_contact.lead_status in ('paid','payment_submitted','not_interested','unqualified','wrong_number','duplicate','cancelled') then
      insert into sales_core.lead_status_history(tenant_id,contact_id,from_status,to_status,reason,changed_by_subject_id,metadata)
      values(p_tenant_id,p_contact_id,v_contact.lead_status,'follow_up','توجد فرصة بيع مفتوحة للعميل',
        private_app.current_subject_id(),jsonb_build_object('source','opportunity_sales_summary'));
    end if;
  end if;
  if v_opportunity.id is null then
    if v_task.status in ('todo','in_progress') and v_task.opportunity_id is not null and not exists(
        select 1 from sales_core.opportunities where tenant_id=p_tenant_id and id=v_task.opportunity_id
          and status='open' and next_action_at is not null) then
      update work_core.tasks set status='completed',completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end,
        metadata=metadata||jsonb_build_object('salesLifecycleResolution',jsonb_build_object('kind','opportunity_resolved','resolvedAt',now()))
        where tenant_id=p_tenant_id and id=v_task.id;
      update sales_core.contacts set next_action_type=null,next_action_at=null where tenant_id=p_tenant_id and id=p_contact_id;
    end if;
    return null;
  end if;
  if v_task.id is null then
    insert into work_core.tasks(tenant_id,title,description,assigned_staff_id,created_by_subject_id,
      contact_id,opportunity_id,due_at,metadata)
    values(p_tenant_id,'متابعة: '||v_contact.full_name,'الإجراء التالي: '||v_opportunity.next_action_type,
      v_contact.owner_staff_id,private_app.current_subject_id(),p_contact_id,v_opportunity.id,v_opportunity.next_action_at,
      jsonb_build_object('source','opportunity_next_action','actionType',v_opportunity.next_action_type,'aggregateCustomerFollowup',true))
    returning id into v_task_id;
  else
    update work_core.tasks set title='متابعة: '||v_contact.full_name,
      description='الإجراء التالي: '||v_opportunity.next_action_type,
      assigned_staff_id=v_contact.owner_staff_id,opportunity_id=v_opportunity.id,
      due_at=v_opportunity.next_action_at,status='todo',completed_at=null,completion_timing=null,
      metadata=(metadata-'resolvedByActivityId'-'completedBySubjectId'-'cancelReason'-'terminalLeadStatus'-'salesLifecycleResolution')
        || jsonb_build_object('source','opportunity_next_action','actionType',v_opportunity.next_action_type,'aggregateCustomerFollowup',true)
    where tenant_id=p_tenant_id and id=v_task.id returning id into v_task_id;
  end if;
  update sales_core.contacts set next_action_type=v_opportunity.next_action_type,next_action_at=v_opportunity.next_action_at
    where tenant_id=p_tenant_id and id=p_contact_id;
  return v_task_id;
end;
$function$;
revoke all on function private_app.sync_customer_sales_task_v1(uuid,uuid) from public,anon,authenticated;

create or replace function public.v3_tenant_create_opportunity(
  p_tenant_slug text,p_contact_id uuid,p_title text,p_stage_id uuid default null,
  p_value_minor bigint default 0,p_course_id uuid default null,p_owner_staff_id uuid default null,
  p_expected_close_date date default null,p_next_action_type text default null,p_next_action_at timestamptz default null,
  p_opportunity_kind text default 'training',p_command_id uuid default null,
  p_source text default null,p_campaign_name text default null,p_ad_name text default null
) returns jsonb language plpgsql security definer set search_path='' as $function$
declare v_tenant_id uuid; v_contact sales_core.contacts%rowtype; v_staff_id uuid; v_owner uuid;
  v_stage uuid; v_opportunity_id uuid; v_task_id uuid; v_request_hash text; v_previous sales_core.opportunities%rowtype;
begin
  select id into v_tenant_id from core.tenants where slug=p_tenant_slug;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(v_tenant_id,'tenant.crm.write') then raise exception 'forbidden'; end if;
  if p_title is null or length(trim(p_title))<2 or length(trim(p_title))>250 then raise exception 'title_required'; end if;
  if coalesce(p_value_minor,0)<0 then raise exception 'invalid_value'; end if;
  if length(coalesce(p_source,''))>100 or length(coalesce(p_campaign_name,''))>250 or length(coalesce(p_ad_name,''))>250
    then raise exception 'invalid_attribution'; end if;
  if p_opportunity_kind not in ('training','general') or p_opportunity_kind is null then raise exception 'invalid_opportunity_kind'; end if;
  if p_opportunity_kind='training' and p_course_id is null then raise exception 'training_course_required'; end if;
  if (p_next_action_type is null)<>(p_next_action_at is null) then raise exception 'next_action_pair_required'; end if;
  if p_next_action_type is not null and p_next_action_type not in ('call','whatsapp','send_details','meeting','payment_followup','follow_up') then raise exception 'invalid_next_action'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tenant_id::text||':'||p_contact_id::text,31603));
  select * into v_contact from sales_core.contacts where tenant_id=v_tenant_id and id=p_contact_id for update;
  if not found then raise exception 'invalid_contact'; end if;
  v_staff_id:=private_app.current_staff_id(v_tenant_id);
  if not private_app.can_view_tenant_team(v_tenant_id) and (v_staff_id is null or v_contact.owner_staff_id is distinct from v_staff_id)
    then raise exception 'forbidden'; end if;
  if p_owner_staff_id is not null and v_contact.owner_staff_id is not null and p_owner_staff_id<>v_contact.owner_staff_id
    then raise exception 'contact_owner_required'; end if;
  v_owner:=coalesce(v_contact.owner_staff_id,p_owner_staff_id,v_staff_id);
  if v_owner is not null and not exists(select 1 from people.staff_profiles where tenant_id=v_tenant_id and id=v_owner and employment_status='active')
    then raise exception 'invalid_owner'; end if;
  select id into v_stage from sales_core.pipeline_stages where tenant_id=v_tenant_id and not is_closed
    and (p_stage_id is null or id=p_stage_id) order by (stage_key='new_lead') desc,id limit 1;
  if v_stage is null then raise exception 'invalid_stage'; end if;
  if p_course_id is not null and not exists(select 1 from academy.courses where tenant_id=v_tenant_id and id=p_course_id and status<>'archived')
    then raise exception 'invalid_course'; end if;
  v_request_hash:=md5(jsonb_build_array(p_contact_id,trim(p_title),p_stage_id,p_value_minor,p_course_id,p_owner_staff_id,
    p_expected_close_date,p_next_action_type,p_next_action_at,p_opportunity_kind,p_source,p_campaign_name,p_ad_name)::text);
  if p_command_id is not null then
    select * into v_previous from sales_core.opportunities where tenant_id=v_tenant_id and metadata->>'creationCommandId'=p_command_id::text;
    if found then
      if v_previous.contact_id<>p_contact_id or v_previous.metadata->>'creationRequestHash' is distinct from v_request_hash
        or v_previous.created_by_subject_id is distinct from private_app.current_subject_id() then raise exception 'opportunity_command_conflict'; end if;
      return jsonb_build_object('id',v_previous.id,'title',v_previous.title,'replayed',true);
    end if;
  end if;
  if exists(select 1 from sales_core.opportunities where tenant_id=v_tenant_id and contact_id=p_contact_id
      and status='open' and course_id is not distinct from p_course_id) then raise exception 'open_opportunity_exists'; end if;
  update sales_core.contacts set owner_staff_id=coalesce(owner_staff_id,v_owner),status='active'
    where tenant_id=v_tenant_id and id=p_contact_id;
  insert into sales_core.opportunities(tenant_id,contact_id,course_id,stage_id,owner_staff_id,title,value_minor,
    expected_close_date,next_action_type,next_action_at,created_by_subject_id,opportunity_kind,metadata)
  values(v_tenant_id,p_contact_id,p_course_id,v_stage,v_owner,trim(p_title),coalesce(p_value_minor,0),p_expected_close_date,
    p_next_action_type,p_next_action_at,private_app.current_subject_id(),p_opportunity_kind,
    jsonb_strip_nulls(jsonb_build_object('creationCommandId',p_command_id,'creationRequestHash',v_request_hash,
      'attribution',jsonb_strip_nulls(jsonb_build_object('source',nullif(trim(p_source),''),
        'campaignName',nullif(trim(p_campaign_name),''),'adName',nullif(trim(p_ad_name),''))))))
  returning id into v_opportunity_id;
  v_task_id:=private_app.sync_customer_sales_task_v1(v_tenant_id,p_contact_id);
  perform private_app.write_audit('tenant.crm_opportunity_created','sales_opportunity',v_opportunity_id::text,v_tenant_id,
    jsonb_build_object('title',trim(p_title),'taskId',v_task_id,'opportunityKind',p_opportunity_kind,'ownerStaffId',v_owner));
  return jsonb_build_object('id',v_opportunity_id,'title',trim(p_title),'taskId',v_task_id);
end;
$function$;
revoke all on function public.v3_tenant_create_opportunity(text,uuid,text,uuid,bigint,uuid,uuid,date,text,timestamptz,text,uuid,text,text,text) from public,anon;
grant execute on function public.v3_tenant_create_opportunity(text,uuid,text,uuid,bigint,uuid,uuid,date,text,timestamptz,text,uuid,text,text,text) to authenticated;

-- Keep old callers compatible while enforcing the same task and owner invariants.
create or replace function public.v2_tenant_create_opportunity(
  p_tenant_slug text,p_contact_id uuid,p_title text,p_stage_id uuid,p_value_minor bigint default 0,
  p_course_id uuid default null,p_owner_staff_id uuid default null,p_expected_close_date date default null,
  p_next_action_type text default null,p_next_action_at timestamptz default null
) returns jsonb language sql security definer set search_path='' as $function$
  select public.v3_tenant_create_opportunity(p_tenant_slug,p_contact_id,p_title,p_stage_id,p_value_minor,
    p_course_id,p_owner_staff_id,p_expected_close_date,p_next_action_type,p_next_action_at,
    case when p_course_id is null then 'general' else 'training' end,null);
$function$;
revoke all on function public.v2_tenant_create_opportunity(text,uuid,text,uuid,bigint,uuid,uuid,date,text,timestamptz) from public,anon;
grant execute on function public.v2_tenant_create_opportunity(text,uuid,text,uuid,bigint,uuid,uuid,date,text,timestamptz) to authenticated;


-- Legacy pipeline movement uses the same contact-first lock order and task projection.
CREATE OR REPLACE FUNCTION public.v2_tenant_move_opportunity(p_tenant_slug text, p_opportunity_id uuid, p_stage_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_opportunity sales_core.opportunities%rowtype;
  v_stage sales_core.pipeline_stages%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_status text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  select * into v_opportunity
  from sales_core.opportunities o
  where o.id = p_opportunity_id
    and o.tenant_id = v_tenant_id;
  if v_opportunity.id is null then raise exception 'opportunity_not_found'; end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_tenant_id::text||':'||v_opportunity.contact_id::text,31603));
  perform id from sales_core.contacts where tenant_id=v_tenant_id and id=v_opportunity.contact_id for update;
  select * into v_opportunity from sales_core.opportunities where tenant_id=v_tenant_id and id=p_opportunity_id for update;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and (v_current_staff_id is null or v_opportunity.owner_staff_id is distinct from v_current_staff_id) then
    raise exception 'forbidden';
  end if;

  select * into v_stage
  from sales_core.pipeline_stages stage
  where stage.id = p_stage_id
    and stage.tenant_id = v_tenant_id;
  if v_stage.id is null then raise exception 'invalid_stage'; end if;

  v_status := case
    when not v_stage.is_closed then 'open'
    when v_stage.is_won then 'won'
    else 'lost'
  end;

  if v_opportunity.status in ('won','pending_verification') and v_status<>v_opportunity.status then
    raise exception 'opportunity_under_admissions';
  end if;
  if v_status='won' and not exists(select 1 from academy.registration_handoffs
    where tenant_id=v_tenant_id and opportunity_id=p_opportunity_id and payment_status='verified')
    then raise exception 'payment_confirmation_required'; end if;

  update sales_core.opportunities
  set stage_id = p_stage_id,
      status = v_status,
      next_action_type = case when v_stage.is_closed then null else next_action_type end,
      next_action_at = case when v_stage.is_closed then null else next_action_at end
  where id = p_opportunity_id;

  if v_stage.is_closed then
    update work_core.tasks
    set status = 'cancelled'
    where opportunity_id = p_opportunity_id
      and status in ('todo', 'in_progress');
  end if;

  perform private_app.sync_customer_sales_task_v1(v_tenant_id,v_opportunity.contact_id);

  perform private_app.write_audit(
    'tenant.crm_opportunity_moved',
    'sales_opportunity',
    p_opportunity_id::text,
    v_tenant_id,
    jsonb_build_object('stageKey', v_stage.stage_key, 'status', v_status)
  );

  return jsonb_build_object(
    'id', p_opportunity_id,
    'stageId', p_stage_id,
    'status', v_status
  );
end;
$function$
;

create index if not exists opportunities_customer_open_next_action_idx
  on sales_core.opportunities(tenant_id,contact_id,next_action_at,created_at,id) where status='open';



-- Existing routines retained with bounded identity and opportunity scoping changes.
CREATE OR REPLACE FUNCTION private_app.guard_terminal_contact_sales_task_insert_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_contact sales_core.contacts%rowtype;
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  if new.status not in ('todo', 'in_progress')
     or new.contact_id is null
     or coalesce(new.metadata ->> 'source', '') not in (
       'lead_assignment',
       'opportunity_next_action',
       'activity_next_action',
       'lead_next_action',
       'sales_followup'
     )
  then
    return new;
  end if;

  -- A prior sale never closes another open opportunity's follow-up.
  if new.opportunity_id is not null and exists(
    select 1 from sales_core.opportunities where tenant_id=new.tenant_id
      and contact_id=new.contact_id and id=new.opportunity_id and status='open'
  ) then return new; end if;

  select contact.*
  into v_contact
  from sales_core.contacts contact
  where contact.tenant_id = new.tenant_id
    and contact.id = new.contact_id
  for share;

  if v_contact.id is null
     or v_contact.lead_status not in (
       'payment_submitted',
       'paid',
       'not_interested',
       'unqualified',
       'wrong_number',
       'duplicate',
       'cancelled'
     )
  then
    return new;
  end if;

  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.contact_id
    and activity.result_status = v_contact.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := greatest(
    coalesce(
      v_terminal_at,
      case when v_contact.lead_status = 'payment_submitted'
        then v_contact.payment_submitted_at end,
      case when v_contact.lead_status in (
        'not_interested', 'unqualified', 'wrong_number',
        'duplicate', 'cancelled'
      ) then v_contact.closed_at end,
      v_contact.lead_status_changed_at,
      v_contact.last_activity_at,
      clock_timestamp()
    ),
    coalesce(new.created_at, clock_timestamp())
  );

  new.status := 'completed';
  new.activity_id := coalesce(v_activity_id, new.activity_id);
  new.completed_at := v_terminal_at;
  new.completion_timing := case
    when v_terminal_at <= new.due_at then 'on_time'
    else 'late'
  end;
  new.metadata := (
    new.metadata - 'cancelReason'
  ) || jsonb_strip_nulls(jsonb_build_object(
    'resolvedByActivityId', v_activity_id,
    'completedBySubjectId', v_actor_subject_id,
    'terminalLeadStatus', v_contact.lead_status,
    'salesLifecycleResolution', jsonb_build_object(
      'version', 'sales_contact_task_lifecycle_v1',
      'kind', 'terminal_contact_insert_guard',
      'leadStatus', v_contact.lead_status,
      'resolvedAt', v_terminal_at
    )
  ));

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION private_app.complete_terminal_contact_sales_tasks_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_activity_id uuid;
  v_actor_subject_id uuid;
  v_terminal_at timestamptz;
begin
  select
    activity.id,
    activity.created_by_subject_id,
    activity.occurred_at
  into
    v_activity_id,
    v_actor_subject_id,
    v_terminal_at
  from sales_core.activities activity
  where activity.tenant_id = new.tenant_id
    and activity.contact_id = new.id
    and activity.result_status = new.lead_status
  order by activity.occurred_at desc, activity.id desc
  limit 1;

  v_terminal_at := coalesce(
    v_terminal_at,
    case when new.lead_status = 'payment_submitted'
      then new.payment_submitted_at end,
    case when new.lead_status in (
      'not_interested', 'unqualified', 'wrong_number',
      'duplicate', 'cancelled'
    ) then new.closed_at end,
    new.lead_status_changed_at,
    new.last_activity_at,
    clock_timestamp()
  );

  update work_core.tasks task
  set status = 'completed',
      activity_id = coalesce(v_activity_id, task.activity_id),
      completed_at = greatest(v_terminal_at, task.created_at),
      completion_timing = case
        when greatest(v_terminal_at, task.created_at) <= task.due_at
          then 'on_time'
        else 'late'
      end,
      metadata = (
        task.metadata - 'cancelReason'
      ) || jsonb_strip_nulls(jsonb_build_object(
        'resolvedByActivityId', v_activity_id,
        'completedBySubjectId', v_actor_subject_id,
        'terminalLeadStatus', new.lead_status,
        'salesLifecycleResolution', jsonb_build_object(
          'version', 'sales_contact_task_lifecycle_v1',
          'kind', 'terminal_contact_fallback',
          'leadStatus', new.lead_status,
          'resolvedAt', greatest(v_terminal_at, task.created_at)
        ),
        'lastTransition', jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', task.status,
          'toStatus', 'completed',
          'fromDueAt', task.due_at,
          'toDueAt', task.due_at,
          'actorSubjectId', v_actor_subject_id,
          'at', greatest(v_terminal_at, task.created_at),
          'mode', 'terminal_contact_fallback_v1',
          'note', 'إغلاق مهمة المبيعات بعد وصول العميل إلى حالة نهائية'
        ))
      ))
  where task.tenant_id = new.tenant_id
    and task.contact_id = new.id
    and task.status in ('todo', 'in_progress')
    and not exists(select 1 from sales_core.opportunities opportunity
      where opportunity.tenant_id=task.tenant_id and opportunity.contact_id=task.contact_id
        and opportunity.id=task.opportunity_id and opportunity.status='open')
    and coalesce(task.metadata ->> 'source', '') in (
      'lead_assignment',
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    );

  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v2(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_contact sales_core.contacts%rowtype;
  v_opportunity sales_core.opportunities%rowtype;
  v_stage sales_core.pipeline_stages%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_is_open boolean;
  v_is_closed boolean;
  v_stage_key text;
  v_case_status text;
  v_contact_status text;
  v_course_id uuid;
  v_course_run academy.course_runs%rowtype;
  v_followup_task work_core.tasks%rowtype;
  v_activity_id uuid;
  v_task_id uuid;
  v_handoff_id uuid;
  v_admissions_department_id uuid;
  v_admissions_staff_id uuid;
  v_reopened boolean;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;
  if p_activity_type not in (
    'call', 'meeting', 'whatsapp', 'email', 'note'
  ) then raise exception 'invalid_activity_type'; end if;
  if p_summary is null or length(trim(p_summary)) < 2 then
    raise exception 'summary_required';
  end if;
  if p_lead_status not in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'payment_submitted',
    'postponed',
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) then raise exception 'invalid_lead_status'; end if;
  if p_lead_quality not in (
    'unrated', 'unqualified', 'weak', 'qualified', 'good', 'excellent'
  ) then raise exception 'invalid_lead_quality'; end if;
  if p_payment_amount_minor is not null and p_payment_amount_minor < 0 then
    raise exception 'invalid_value';
  end if;

  v_is_open := p_lead_status in (
    'new',
    'no_answer',
    'busy',
    'phone_off',
    'follow_up',
    'interested',
    'very_interested',
    'awaiting_payment',
    'postponed'
  );
  v_is_closed := p_lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  );

  if v_is_open and (
    p_next_action_type is null
    or p_next_action_at is null
  ) then raise exception 'next_action_required'; end if;
  if v_is_open and p_next_action_type not in (
    'call',
    'whatsapp',
    'send_details',
    'meeting',
    'payment_followup',
    'follow_up'
  ) then raise exception 'invalid_next_action'; end if;
  if v_is_closed and (
    p_closure_reason is null
    or length(trim(p_closure_reason)) < 3
  ) then raise exception 'closure_reason_required'; end if;

  select *
  into v_contact
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if v_contact.id is null then raise exception 'invalid_contact'; end if;
  if v_contact.lead_status in ('payment_submitted', 'paid') and not exists(
    select 1 from sales_core.opportunities opportunity
    where opportunity.tenant_id=v_tenant_id and opportunity.contact_id=p_contact_id
      and opportunity.status='open'
      and (opportunity.course_id is not distinct from p_course_id
        or (p_course_id is null and opportunity.course_id=v_contact.interest_course_id))
  ) then
    raise exception 'lead_under_admissions';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_contact.owner_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  v_course_id := case when p_course_id is null and exists(select 1 from sales_core.opportunities
    where tenant_id=v_tenant_id and contact_id=p_contact_id and status='open' and course_id is null)
    then null else coalesce(p_course_id, v_contact.interest_course_id) end;
  if v_course_id is not null and not exists (
    select 1
    from academy.courses course
    where course.id = v_course_id
      and course.tenant_id = v_tenant_id
      and course.status <> 'archived'
  ) then raise exception 'invalid_course'; end if;
  if p_lead_status = 'payment_submitted' and v_course_id is null then
    raise exception 'course_required_for_payment';
  end if;

  if p_course_run_id is not null then
    select *
    into v_course_run
    from academy.course_runs run
    where run.id = p_course_run_id
      and run.tenant_id = v_tenant_id
      and run.course_id = v_course_id
      and run.status in ('planning', 'open', 'in_progress');
    if v_course_run.id is null then raise exception 'invalid_course_run'; end if;
  end if;

  v_stage_key := case
    when p_lead_status = 'payment_submitted' then 'proposal'
    when v_is_closed then 'lost'
    when p_lead_status in ('very_interested', 'awaiting_payment') then 'proposal'
    when p_lead_status = 'interested' then 'qualified'
    when p_lead_status in ('no_answer', 'busy', 'phone_off', 'follow_up', 'postponed')
      then 'contacted'
    else 'new_lead'
  end;

  select *
  into v_stage
  from sales_core.pipeline_stages stage
  where stage.tenant_id = v_tenant_id
    and stage.stage_key = v_stage_key
  limit 1;

  if v_stage.id is null then raise exception 'invalid_stage'; end if;

  select *
  into v_opportunity
  from sales_core.opportunities opportunity
  where opportunity.tenant_id = v_tenant_id
    and opportunity.contact_id = p_contact_id
    and opportunity.status='open'
    and opportunity.course_id is not distinct from v_course_id
  order by
    opportunity.created_at desc
  limit 1
  for update;

  if (select count(*) from sales_core.opportunities where tenant_id=v_tenant_id
      and contact_id=p_contact_id and status='open' and course_id is not distinct from v_course_id)>1
    then raise exception 'ambiguous_open_opportunity'; end if;

  v_case_status := case
    when p_lead_status = 'payment_submitted' then 'pending_verification'
    when v_is_open then 'open'
    else 'lost'
  end;
  v_contact_status := case
    when p_lead_status = 'payment_submitted' then 'active'
    when v_is_open then 'active'
    when p_lead_status = 'unqualified' then 'unqualified'
    else 'archived'
  end;
  v_reopened := v_contact.lead_status in (
    'not_interested',
    'unqualified',
    'wrong_number',
    'duplicate',
    'cancelled'
  ) and v_is_open;

  if v_opportunity.id is null then
    insert into sales_core.opportunities (
      tenant_id,
      contact_id,
      course_id,
      stage_id,
      owner_staff_id,
      title,
      value_minor,
      next_action_type,
      next_action_at,
      status,
      lost_reason,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      p_contact_id,
      v_course_id,
      v_stage.id,
      coalesce(v_contact.owner_staff_id, v_current_staff_id),
      'متابعة ' || v_contact.full_name,
      coalesce(p_payment_amount_minor, 0),
      case when v_is_open then p_next_action_type else null end,
      case when v_is_open then p_next_action_at else null end,
      v_case_status,
      case when v_is_closed then trim(p_closure_reason) else null end,
      private_app.current_subject_id(),
      jsonb_build_object('model', 'lead_centric')
    )
    returning * into v_opportunity;
  else
    update sales_core.opportunities
    set course_id = coalesce(v_course_id, course_id),
        stage_id = v_stage.id,
        next_action_type = case
          when v_is_open then p_next_action_type
          else null
        end,
        next_action_at = case
          when v_is_open then p_next_action_at
          else null
        end,
        status = v_case_status,
        lost_reason = case
          when v_is_closed then trim(p_closure_reason)
          else null
        end
    where id = v_opportunity.id
    returning * into v_opportunity;
  end if;

  select task.*
  into v_followup_task
  from work_core.tasks task
  where task.tenant_id = v_tenant_id
    and task.contact_id = p_contact_id
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup'
    )
  order by task.due_at desc, task.created_at desc, task.id
  limit 1
  for update;

  insert into sales_core.activities (
    tenant_id,
    opportunity_id,
    contact_id,
    actor_staff_id,
    activity_type,
    outcome,
    summary,
    occurred_at,
    next_action_type,
    next_action_at,
    result_status,
    result_quality,
    closure_reason,
    created_by_subject_id,
    metadata
  )
  values (
    v_tenant_id,
    v_opportunity.id,
    p_contact_id,
    coalesce(v_current_staff_id, v_contact.owner_staff_id),
    p_activity_type,
    p_lead_status,
    trim(p_summary),
    now(),
    case when v_is_open then p_next_action_type else null end,
    case when v_is_open then p_next_action_at else null end,
    p_lead_status,
    p_lead_quality,
    case when v_is_closed then trim(p_closure_reason) else null end,
    private_app.current_subject_id(),
    jsonb_strip_nulls(jsonb_build_object(
      'model',
      'lead_centric',
      'reopened',
      v_reopened,
      'scheduledTaskId',
      v_followup_task.id,
      'scheduledAt',
      v_followup_task.due_at,
      'taskUpdateMode',
      case
        when v_followup_task.id is null then 'created'
        else 'updated'
      end
    ))
  )
  returning id into v_activity_id;

  update sales_core.contacts
  set status = v_contact_status,
      lead_status = p_lead_status,
      lead_quality = p_lead_quality,
      interest_course_id = coalesce(v_course_id, interest_course_id),
      next_action_type = case when v_is_open then p_next_action_type else null end,
      next_action_at = case when v_is_open then p_next_action_at else null end,
      last_activity_at = now(),
      lead_status_changed_at = case
        when lead_status is distinct from p_lead_status then now()
        else lead_status_changed_at
      end,
      closure_reason = case
        when v_is_closed then trim(p_closure_reason)
        else null
      end,
      closed_at = case
        when v_is_closed then now()
        else null
      end,
      reopened_at = case
        when v_reopened then now()
        else reopened_at
      end,
      payment_submitted_at = case
        when p_lead_status = 'payment_submitted' then now()
        else payment_submitted_at
      end
  where id = p_contact_id;

  if v_contact.lead_status is distinct from p_lead_status then
    insert into sales_core.lead_status_history (
      tenant_id,
      contact_id,
      activity_id,
      from_status,
      to_status,
      reason,
      changed_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      p_contact_id,
      v_activity_id,
      v_contact.lead_status,
      p_lead_status,
      case
        when v_is_closed then trim(p_closure_reason)
        else trim(p_summary)
      end,
      private_app.current_subject_id(),
      jsonb_build_object('reopened', v_reopened)
    );
  end if;

  if v_is_open then
    if v_followup_task.id is not null then
      update work_core.tasks
      set title = 'متابعة: ' || v_contact.full_name,
          description = 'الحالة: ' || p_lead_status
            || ' · الإجراء التالي: ' || p_next_action_type,
          priority = case
            when p_lead_status in ('very_interested', 'awaiting_payment')
              then 'high'
            else 'normal'
          end,
          status = 'todo',
          assigned_staff_id = coalesce(
            v_contact.owner_staff_id,
            v_current_staff_id
          ),
          opportunity_id = v_opportunity.id,
          activity_id = v_activity_id,
          due_at = p_next_action_at,
          completed_at = null,
          completion_timing = null,
          metadata = (
            metadata
            - 'resolvedByActivityId'
            - 'completedBySubjectId'
            - 'cancelReason'
          ) || jsonb_build_object(
            'source', 'sales_followup',
            'actionType', p_next_action_type,
            'leadStatus', p_lead_status,
            'leadQuality', p_lead_quality,
            'taskUpdateMode', 'single_record',
            'lastMovedAt', now()
          )
      where id = v_followup_task.id
        and tenant_id = v_tenant_id
      returning id into v_task_id;
    else
      insert into work_core.tasks (
        tenant_id,
        title,
        description,
        priority,
        assigned_staff_id,
        created_by_subject_id,
        contact_id,
        opportunity_id,
        activity_id,
        due_at,
        metadata
      )
      values (
        v_tenant_id,
        'متابعة: ' || v_contact.full_name,
        'الحالة: ' || p_lead_status
          || ' · الإجراء التالي: ' || p_next_action_type,
        case
          when p_lead_status in ('very_interested', 'awaiting_payment')
            then 'high'
          else 'normal'
        end,
        coalesce(v_contact.owner_staff_id, v_current_staff_id),
        private_app.current_subject_id(),
        p_contact_id,
        v_opportunity.id,
        v_activity_id,
        p_next_action_at,
        jsonb_build_object(
          'source', 'sales_followup',
          'actionType', p_next_action_type,
          'leadStatus', p_lead_status,
          'leadQuality', p_lead_quality,
          'taskUpdateMode', 'single_record'
        )
      )
      returning id into v_task_id;
    end if;
  elsif p_lead_status = 'payment_submitted' then
    select department.id
    into v_admissions_department_id
    from people.departments department
    where department.tenant_id = v_tenant_id
      and department.department_key = 'admissions'
    limit 1;

    select staff.id
    into v_admissions_staff_id
    from people.staff_profiles staff
    left join people.departments department
      on department.id = staff.department_id
    where staff.tenant_id = v_tenant_id
      and staff.employment_status = 'active'
      and (
        department.department_key = 'admissions'
        or staff.role_key = 'customer_service'
      )
    order by
      (department.department_key = 'admissions') desc,
      staff.created_at
    limit 1;

    insert into academy.registration_handoffs (
      tenant_id,
      handoff_key,
      contact_id,
      opportunity_id,
      course_id,
      course_run_id,
      assigned_department_id,
      assigned_staff_id,
      status,
      paid_at,
      payment_status,
      payment_reported_at,
      payment_amount_minor,
      payment_reference,
      preferred_start_date,
      notes,
      created_by_subject_id,
      metadata
    )
    values (
      v_tenant_id,
      'payment-' || v_opportunity.id::text,
      p_contact_id,
      v_opportunity.id,
      v_course_id,
      p_course_run_id,
      v_admissions_department_id,
      v_admissions_staff_id,
      'pending',
      now(),
      'pending_verification',
      now(),
      p_payment_amount_minor,
      nullif(trim(coalesce(p_payment_reference, '')), ''),
      p_preferred_start_date,
      trim(p_summary),
      private_app.current_subject_id(),
      jsonb_build_object(
        'source',
        'sales_payment_report',
        'notification',
        true
      )
    )
    on conflict (tenant_id, handoff_key) do update
    set course_id = excluded.course_id,
        course_run_id = excluded.course_run_id,
        assigned_department_id = excluded.assigned_department_id,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'pending',
        paid_at = excluded.paid_at,
        payment_status = 'pending_verification',
        payment_reported_at = excluded.payment_reported_at,
        payment_verified_at = null,
        payment_verified_by_subject_id = null,
        payment_rejection_reason = null,
        payment_amount_minor = excluded.payment_amount_minor,
        payment_reference = excluded.payment_reference,
        preferred_start_date = excluded.preferred_start_date,
        notes = excluded.notes,
        metadata = excluded.metadata
    returning id into v_handoff_id;

    insert into academy.registration_documents (
      tenant_id,
      handoff_id,
      document_type,
      is_required,
      status
    )
    select
      v_tenant_id,
      v_handoff_id,
      document.document_type,
      document.is_required,
      case
        when document.document_type = 'payment_receipt'
          and nullif(trim(coalesce(p_payment_reference, '')), '') is not null
          then 'received'
        else 'pending'
      end
    from (
      values
        ('payment_receipt'::text, true),
        ('national_id'::text, true),
        ('qualification'::text, true),
        ('personal_photo'::text, false)
    ) document(document_type, is_required)
    on conflict (handoff_id, document_type) do update
    set status = case
          when excluded.document_type = 'payment_receipt'
            and excluded.status = 'received' then 'received'
          else academy.registration_documents.status
        end,
        is_required = excluded.is_required;

    insert into work_core.tasks (
      tenant_id,
      task_key,
      title,
      description,
      priority,
      assigned_staff_id,
      created_by_subject_id,
      contact_id,
      opportunity_id,
      activity_id,
      due_at,
      metadata
    )
    values (
      v_tenant_id,
      'registration-' || v_handoff_id::text,
      'تحقق من الدفع: ' || v_contact.full_name,
      case
        when p_course_run_id is null
          then 'أبلغ العميل بالدفع · يلزم التحقق وتحديد الدفعة'
        else 'أبلغ العميل بالدفع · يلزم التحقق قبل تأكيد التسجيل'
      end,
      'urgent',
      v_admissions_staff_id,
      private_app.current_subject_id(),
      p_contact_id,
      v_opportunity.id,
      v_activity_id,
      now(),
      jsonb_build_object(
        'source',
        'registration_handoff',
        'handoffId',
        v_handoff_id,
        'department',
        'admissions',
        'notification',
        true,
        'paymentStatus',
        'pending_verification'
      )
    )
    on conflict (tenant_id, task_key) do update
    set title = excluded.title,
        description = excluded.description,
        priority = excluded.priority,
        assigned_staff_id = excluded.assigned_staff_id,
        status = 'todo',
        completed_at = null,
        completion_timing = null,
        due_at = excluded.due_at,
        metadata = excluded.metadata
    returning id into v_task_id;
  end if;

  perform private_app.write_audit(
    'tenant.sales_followup_recorded',
    'sales_contact',
    p_contact_id::text,
    v_tenant_id,
    jsonb_build_object(
      'activityId',
      v_activity_id,
      'status',
      p_lead_status,
      'quality',
      p_lead_quality,
      'taskId',
      v_task_id,
      'taskUpdated',
      v_is_open and v_followup_task.id is not null,
      'previousDueAt',
      v_followup_task.due_at,
      'nextDueAt',
      case when v_is_open then p_next_action_at else null end,
      'handoffId',
      v_handoff_id,
      'closureReason',
      case when v_is_closed then trim(p_closure_reason) else null end
    )
  );

  return jsonb_build_object(
    'id',
    v_activity_id,
    'contactId',
    p_contact_id,
    'status',
    p_lead_status,
    'quality',
    p_lead_quality,
    'taskId',
    v_task_id,
    'taskUpdated',
    v_is_open and v_followup_task.id is not null,
    'previousDueAt',
    v_followup_task.due_at,
    'nextDueAt',
    case when v_is_open then p_next_action_at else null end,
    'handoffId',
    v_handoff_id,
    'paymentReviewNotified',
    v_handoff_id is not null
  );
end;
$function$

;

CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v5(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_course_id uuid DEFAULT NULL::uuid, p_course_run_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_preferred_start_date date DEFAULT NULL::date, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_selected_task work_core.tasks%rowtype;
  v_result jsonb;
  v_result_task_id uuid;
  v_lead_status text := p_lead_status;
  v_lead_quality text := coalesce(p_lead_quality, 'unrated');
  v_closure_reason text := p_closure_reason;
  v_normalized boolean := false;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  if v_lead_quality = 'unqualified'
     and v_lead_status in (
       'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
       'interested', 'very_interested', 'awaiting_payment', 'postponed'
     )
  then
    v_lead_status := 'unqualified';
    v_closure_reason := coalesce(
      nullif(trim(v_closure_reason), ''),
      'جودة العميل غير مؤهل'
    );
    v_normalized := true;
  elsif v_lead_status = 'unqualified'
        and v_lead_quality <> 'unqualified'
  then
    v_lead_quality := 'unqualified';
    v_normalized := true;
  elsif v_lead_quality = 'unqualified'
        and v_lead_status in ('payment_submitted', 'paid')
  then
    raise exception 'unqualified_quality_requires_closed_status';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_tenant_id::text || ':' || p_contact_id::text,
      31603
    )
  );

  perform contact.id
  from sales_core.contacts contact
  where contact.id = p_contact_id
    and contact.tenant_id = v_tenant_id
  for update;

  if not found then raise exception 'invalid_contact'; end if;

  if p_task_id is not null then
    select task.*
    into v_selected_task
    from work_core.tasks task
    where task.id = p_task_id
      and task.tenant_id = v_tenant_id
      and task.contact_id = p_contact_id
      and task.status in ('todo', 'in_progress')
      and coalesce(task.metadata ->> 'source', '') in (
        'lead_assignment',
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'sales_followup'
      )
    for update;

    if v_selected_task.id is null then
      raise exception 'task_not_followup';
    end if;
  end if;

  v_result := public.v2_tenant_record_sales_followup_v4(
    p_tenant_slug => p_tenant_slug,
    p_contact_id => p_contact_id,
    p_activity_type => p_activity_type,
    p_summary => p_summary,
    p_lead_status => v_lead_status,
    p_lead_quality => v_lead_quality,
    p_next_action_type => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_type
      else null
    end,
    p_next_action_at => case
      when v_lead_status in (
        'new', 'no_answer', 'busy', 'phone_off', 'follow_up',
        'interested', 'very_interested', 'awaiting_payment', 'postponed'
      ) then p_next_action_at
      else null
    end,
    p_course_id => p_course_id,
    p_course_run_id => p_course_run_id,
    p_payment_amount_minor => p_payment_amount_minor,
    p_payment_reference => p_payment_reference,
    p_preferred_start_date => p_preferred_start_date,
    p_closure_reason => v_closure_reason,
    p_contact_name => p_contact_name
  );

  if p_task_id is not null then
    v_result_task_id := nullif(coalesce(
      v_result ->> 'followupTaskId',
      v_result ->> 'taskId'
    ), '')::uuid;
    if v_result_task_id is distinct from p_task_id then
      raise exception 'task_transition_conflict';
    end if;
  end if;

  -- V4 resolves the selected interaction first; then restore the earliest other
  -- open opportunity without creating another calendar entry.
  perform private_app.sync_customer_sales_task_v1(v_tenant_id,p_contact_id);

  return v_result || jsonb_strip_nulls(jsonb_build_object(
    'selectedTaskId', p_task_id,
    'taskUpdateMode', 'bound_task_id_v5',
    'lifecycleNormalized', v_normalized,
    'normalizedLeadStatus', case when v_normalized then v_lead_status end,
    'normalizedLeadQuality', case when v_normalized then v_lead_quality end
  ));
end;
$function$

;

CREATE OR REPLACE FUNCTION private_app.record_sales_followup_scoped_v1(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_course_interests jsonb, p_additional_phones jsonb, p_expected_revision text, p_command_id uuid, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_payment_course_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid, p_opportunity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_scoped_opportunity sales_core.opportunities%rowtype;
  v_contact sales_core.contacts%rowtype; v_context jsonb; v_previous jsonb; v_result jsonb;
  v_request_hash text; v_command sales_core.followup_commands%rowtype;
  v_item jsonb; v_course_id uuid; v_run_id uuid; v_session_id uuid; v_position integer := 0;
  v_courses uuid[] := '{}'::uuid[]; v_phones text[] := '{}'::text[]; v_phone text;
  v_selected jsonb; v_primary_course uuid; v_attendance_at timestamptz; v_start_date date;
begin
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id,true);
  if p_command_id is null or p_expected_revision is null then raise exception 'followup_reload_required'; end if;
  if jsonb_typeof(p_course_interests) is distinct from 'array' or jsonb_array_length(p_course_interests)>20
     or jsonb_typeof(p_additional_phones) is distinct from 'array'
    then raise exception 'invalid_followup_details'; end if;
  v_request_hash := md5(jsonb_build_array(p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,
    p_additional_phones,p_expected_revision,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,
    p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id)::text
    || coalesce(':'||p_opportunity_id::text,''));
  -- Match the existing identity editor lock order, then the existing task lifecycle lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_contact.tenant_id::text,1729));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_contact.tenant_id::text || ':' || p_contact_id::text,31603));
  perform id from sales_core.contacts where tenant_id=v_contact.tenant_id and id=p_contact_id for update;
  v_contact := private_app.sales_followup_contact(p_tenant_slug,p_contact_id,true);
  select * into v_command from sales_core.followup_commands where tenant_id=v_contact.tenant_id and command_id=p_command_id;
  if found then
    if v_command.contact_id<>p_contact_id or v_command.actor_id<>private_app.current_subject_id()
       or v_command.request_hash<>v_request_hash then raise exception 'followup_command_conflict'; end if;
    return v_command.result || jsonb_build_object('replayed',true);
  end if;
  perform private_app.validate_customer_phone_capacity_v1(v_contact.phone,v_contact.whatsapp,p_additional_phones);
  v_context := public.v1_tenant_sales_followup_context(p_tenant_slug,p_contact_id);
  if v_context->>'revision' is distinct from p_expected_revision then raise exception 'followup_changed_reload'; end if;
    v_previous := v_context - 'revision' - 'timezone';
  if p_opportunity_id is null and (select count(*) from sales_core.opportunities
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and status='open')>1
    then raise exception 'followup_opportunity_required'; end if;
  select * into v_scoped_opportunity from sales_core.opportunities
    where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and status='open'
      and (p_opportunity_id is null or id=p_opportunity_id)
    order by created_at,id limit 1 for update;
  if p_opportunity_id is not null and v_scoped_opportunity.id is null then raise exception 'invalid_followup_opportunity'; end if;
  if p_lead_status='payment_submitted' and v_scoped_opportunity.id is not null
      and v_scoped_opportunity.course_id is distinct from p_payment_course_id
    then raise exception 'payment_opportunity_mismatch'; end if;

  for v_item in select value from jsonb_array_elements(p_course_interests) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'invalid_followup_details'; end if;
    v_course_id := nullif(v_item->>'courseId','')::uuid;
    v_run_id := nullif(v_item->>'courseRunId','')::uuid;
    v_session_id := nullif(v_item->>'attendanceSessionId','')::uuid;
    if v_course_id is null or v_course_id=any(v_courses) then raise exception 'duplicate_or_missing_course'; end if;
    if not exists(select 1 from academy.courses where tenant_id=v_contact.tenant_id and id=v_course_id and status<>'archived')
      then raise exception 'invalid_course'; end if;
    if v_run_id is not null and not exists(select 1 from academy.course_runs
      where tenant_id=v_contact.tenant_id and course_id=v_course_id and id=v_run_id and status in ('planning','open','in_progress'))
      then raise exception 'invalid_course_run'; end if;
    if v_session_id is not null and (v_run_id is null or not exists(select 1 from academy.course_run_sessions
      where tenant_id=v_contact.tenant_id and course_run_id=v_run_id and id=v_session_id and status='scheduled'))
      then raise exception 'invalid_attendance_session'; end if;
    v_courses := array_append(v_courses,v_course_id);
  end loop;
  v_primary_course := v_courses[1];
  if p_lead_status='payment_submitted' then
    if p_payment_course_id is null or not (p_payment_course_id=any(v_courses)) then raise exception 'payment_course_required'; end if;
    select item into v_selected from jsonb_array_elements(p_course_interests) item where item->>'courseId'=p_payment_course_id::text;
    v_run_id := nullif(v_selected->>'courseRunId','')::uuid;
    v_session_id := nullif(v_selected->>'attendanceSessionId','')::uuid;
    select coalesce(s.starts_at,r.starts_at) into v_attendance_at from academy.course_runs r
      left join academy.course_run_sessions s on s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.id=v_session_id
      where r.tenant_id=v_contact.tenant_id and r.id=v_run_id;
    v_start_date := (v_attendance_at at time zone coalesce(nullif(v_context->>'timezone',''),'UTC'))::date;
  else v_run_id := null; v_session_id := null; end if;

  for v_item in select value from jsonb_array_elements(p_additional_phones) loop
    if jsonb_typeof(v_item)<>'string' or length(v_item #>> '{}')>40 then raise exception 'invalid_phone'; end if;
    v_phone := private_app.normalize_lead_phone(v_item #>> '{}');
    if v_phone is null then raise exception 'invalid_phone'; end if;
    if v_phone=any(v_phones) or v_phone in (private_app.normalize_lead_phone(v_contact.phone),private_app.normalize_lead_phone(v_contact.whatsapp))
      then raise exception 'duplicate_additional_phone'; end if;
    if exists(select 1 from sales_core.contact_identities where tenant_id=v_contact.tenant_id and identity_type='phone'
      and identity_value=v_phone and contact_id<>p_contact_id) then raise exception 'duplicate_contact_identity'; end if;
    v_phones := array_append(v_phones,v_phone);
  end loop;

  -- Explicit clear is supported; the legacy scalar remains the first interest for old readers.
  update sales_core.contacts set interest_course_id=v_primary_course where tenant_id=v_contact.tenant_id and id=p_contact_id;
  v_result := public.v2_tenant_record_sales_followup_v5(
    p_tenant_slug=>p_tenant_slug,p_contact_id=>p_contact_id,p_activity_type=>p_activity_type,p_summary=>p_summary,
    p_lead_status=>p_lead_status,p_lead_quality=>p_lead_quality,p_next_action_type=>p_next_action_type,p_next_action_at=>p_next_action_at,
    p_course_id=>case when v_scoped_opportunity.id is not null then v_scoped_opportunity.course_id
      when p_lead_status='payment_submitted' then p_payment_course_id else v_primary_course end,
    p_course_run_id=>v_run_id,p_payment_amount_minor=>p_payment_amount_minor,p_payment_reference=>p_payment_reference,
    p_preferred_start_date=>v_start_date,p_closure_reason=>p_closure_reason,p_contact_name=>p_contact_name,p_task_id=>p_task_id
  );
  update sales_core.contacts set interest_course_id=v_primary_course where tenant_id=v_contact.tenant_id and id=p_contact_id;
  delete from sales_core.contact_course_interests where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and not(course_id=any(v_courses));
  for v_item in select value from jsonb_array_elements(p_course_interests) loop
    insert into sales_core.contact_course_interests(tenant_id,contact_id,course_id,course_run_id,attendance_session_id,position)
    values(v_contact.tenant_id,p_contact_id,(v_item->>'courseId')::uuid,nullif(v_item->>'courseRunId','')::uuid,
      nullif(v_item->>'attendanceSessionId','')::uuid,v_position)
    on conflict(tenant_id,contact_id,course_id) do update set course_run_id=excluded.course_run_id,
      attendance_session_id=excluded.attendance_session_id,position=excluded.position,updated_at=now();
    v_position := v_position+1;
  end loop;
  update sales_core.contact_identities set source_slot='historical_alias',updated_at=now()
    where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and source_slot='additional_phone' and not(identity_value=any(v_phones));
  foreach v_phone in array v_phones loop
    insert into sales_core.contact_identities(tenant_id,contact_id,identity_type,identity_value,source_slot,is_alias)
    values(v_contact.tenant_id,p_contact_id,'phone',v_phone,'additional_phone',true)
    on conflict(tenant_id,identity_type,identity_value) do update set source_slot='additional_phone',is_alias=true,updated_at=now()
      where sales_core.contact_identities.contact_id=excluded.contact_id;
    if not found then raise exception 'duplicate_contact_identity'; end if;
  end loop;
  v_context := public.v1_tenant_sales_followup_context(p_tenant_slug,p_contact_id);
  update sales_core.activities set metadata=metadata || jsonb_build_object('courseInterests',v_context->'courseInterests',
    'additionalPhones',v_context->'additionalPhones','followupCommandId',p_command_id)
    where tenant_id=v_contact.tenant_id and id=(v_result->>'id')::uuid;
  if v_result->>'handoffId' is not null then
    update academy.registration_handoffs set metadata=metadata || jsonb_build_object(
      'attendanceSessionId',v_session_id,'attendanceAt',v_attendance_at,'courseInterests',v_context->'courseInterests')
      where tenant_id=v_contact.tenant_id and contact_id=p_contact_id and id=(v_result->>'handoffId')::uuid;
  end if;
  perform private_app.write_audit('tenant.sales_followup_details_updated','sales_contact',p_contact_id::text,v_contact.tenant_id,
    jsonb_build_object('old',v_previous,'new',v_context-'revision'-'timezone','commandId',p_command_id));
  v_result := v_result || jsonb_build_object('followupDetails',v_context);
  insert into sales_core.followup_commands(tenant_id,command_id,contact_id,actor_id,request_hash,result)
    values(v_contact.tenant_id,p_command_id,p_contact_id,private_app.current_subject_id(),v_request_hash,v_result);
  return v_result;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v6(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_course_interests jsonb, p_additional_phones jsonb, p_expected_revision text, p_command_id uuid, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_payment_course_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $function$
  select private_app.record_sales_followup_scoped_v1(p_tenant_slug,p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,p_additional_phones,p_expected_revision,p_command_id,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id,null);
$function$;

CREATE OR REPLACE FUNCTION public.v2_tenant_record_sales_followup_v7(p_tenant_slug text, p_contact_id uuid, p_activity_type text, p_summary text, p_lead_status text, p_course_interests jsonb, p_additional_phones jsonb, p_expected_revision text, p_command_id uuid, p_lead_quality text DEFAULT 'unrated'::text, p_next_action_type text DEFAULT NULL::text, p_next_action_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_payment_course_id uuid DEFAULT NULL::uuid, p_payment_amount_minor bigint DEFAULT NULL::bigint, p_payment_reference text DEFAULT NULL::text, p_closure_reason text DEFAULT NULL::text, p_contact_name text DEFAULT NULL::text, p_task_id uuid DEFAULT NULL::uuid, p_opportunity_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $function$
  select private_app.record_sales_followup_scoped_v1(p_tenant_slug,p_contact_id,p_activity_type,p_summary,p_lead_status,p_course_interests,p_additional_phones,p_expected_revision,p_command_id,p_lead_quality,p_next_action_type,p_next_action_at,p_payment_course_id,p_payment_amount_minor,p_payment_reference,p_closure_reason,p_contact_name,p_task_id,p_opportunity_id);
$function$;
revoke all on function private_app.record_sales_followup_scoped_v1(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.v2_tenant_record_sales_followup_v7(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid) from public,anon;
grant execute on function public.v2_tenant_record_sales_followup_v7(text,uuid,text,text,text,jsonb,jsonb,text,uuid,text,text,timestamptz,uuid,bigint,text,text,text,uuid,uuid) to authenticated;

CREATE OR REPLACE FUNCTION private_app.sales_followup_details(p_tenant_id uuid, p_contact_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'courseInterests',coalesce((
      select jsonb_agg(jsonb_build_object(
        'courseId',i.course_id,'courseName',c.title_ar,'courseStatus',c.status,
        'courseRunId',i.course_run_id,'runTitle',r.title,'runStatus',r.status,
        'attendanceSessionId',i.attendance_session_id,'sessionTitle',s.title,'sessionStatus',s.status,
        'attendanceAt',coalesce(s.starts_at,r.starts_at)
      ) order by i.position,i.course_id)
      from (
        select course_id,course_run_id,attendance_session_id,
          case when course_id=(select interest_course_id from sales_core.contacts where tenant_id=p_tenant_id and id=p_contact_id) then -1 else position end as position
        from sales_core.contact_course_interests where tenant_id=p_tenant_id and contact_id=p_contact_id
        union all
        select contact.interest_course_id,null::uuid,null::uuid,-1
        from sales_core.contacts contact where contact.tenant_id=p_tenant_id and contact.id=p_contact_id
          and contact.interest_course_id is not null and not exists (
            select 1 from sales_core.contact_course_interests existing
            where existing.tenant_id=p_tenant_id and existing.contact_id=p_contact_id
              and existing.course_id=contact.interest_course_id
          )
      ) i
      join academy.courses c on c.tenant_id=p_tenant_id and c.id=i.course_id
      left join academy.course_runs r on r.tenant_id=p_tenant_id and r.id=i.course_run_id
      left join academy.course_run_sessions s on s.tenant_id=p_tenant_id and s.id=i.attendance_session_id
    ),'[]'::jsonb),
    'openOpportunities',coalesce((
      select jsonb_agg(jsonb_build_object('id',id,'courseId',course_id,'title',title,'kind',opportunity_kind,
        'nextActionAt',next_action_at) order by next_action_at nulls last,created_at,id)
      from sales_core.opportunities where tenant_id=p_tenant_id and contact_id=p_contact_id and status='open'
    ),'[]'::jsonb),
    'additionalPhones',coalesce((
      select jsonb_agg(identity.identity_value order by identity.created_at,identity.id)
      from sales_core.contact_identities identity
      where identity.tenant_id=p_tenant_id and identity.contact_id=p_contact_id
        and identity.identity_type='phone' and identity.source_slot='additional_phone'
    ),'[]'::jsonb)
  );
$function$

;

revoke all on function private_app.guard_terminal_contact_sales_task_insert_v1() from public,anon,authenticated;
revoke all on function private_app.complete_terminal_contact_sales_tasks_v1() from public,anon,authenticated;
revoke all on function public.v2_tenant_record_sales_followup_v2(text,uuid,text,text,text,text,text,timestamptz,uuid,uuid,bigint,text,date,text) from public,anon,authenticated;



-- Work-only RPCs cannot edit the sales task projection. Record a scoped CRM followup.
CREATE OR REPLACE FUNCTION public.v2_tenant_update_task_status(p_tenant_slug text, p_task_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_task work_core.tasks%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_completed_at timestamptz;
  v_completion_timing text;
begin
  select t.id into v_tenant_id
  from core.tenants t
  where t.slug = p_tenant_slug
  limit 1;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_status not in ('todo', 'in_progress', 'completed', 'cancelled') then
    raise exception 'invalid_task_status';
  end if;

  select * into v_task
  from work_core.tasks task
  where task.id = p_task_id
    and task.tenant_id = v_tenant_id
  for update;
  if v_task.id is null then raise exception 'task_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_task.assigned_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  if v_task.contact_id is not null and (
    v_task.metadata->>'source' in ('lead_assignment','opportunity_next_action','activity_next_action','lead_next_action','sales_followup')
    or v_task.metadata->>'aggregateCustomerFollowup'='true'
  ) then raise exception 'sales_task_requires_followup'; end if;

  if p_status = 'completed' then
    v_completed_at := now();
    v_completion_timing := case
      when now() <= v_task.due_at then 'on_time'
      else 'late'
    end;
  else
    v_completed_at := null;
    v_completion_timing := null;
  end if;

  update work_core.tasks
  set status = p_status,
      completed_at = v_completed_at,
      completion_timing = v_completion_timing
  where id = p_task_id;

  perform private_app.write_audit(
    'tenant.work_task_status_updated',
    'work_task',
    p_task_id::text,
    v_tenant_id,
    jsonb_build_object(
      'status', p_status,
      'completionTiming', v_completion_timing
    )
  );

  return jsonb_build_object(
    'id', p_task_id,
    'status', p_status,
    'completionTiming', v_completion_timing
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.v3_tenant_transition_task(p_tenant_slug text, p_task_id uuid, p_status text DEFAULT NULL::text, p_due_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_tenant_id uuid;
  v_task work_core.tasks%rowtype;
  v_current_staff_id uuid;
  v_view_team boolean;
  v_next_status text;
  v_next_due_at timestamptz;
  v_completed_at timestamptz;
  v_completion_timing text;
  v_clean_note text;
begin
  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.work.write'
  ) then raise exception 'forbidden'; end if;
  if p_status is not null
     and p_status not in ('todo', 'in_progress', 'completed', 'cancelled') then
    raise exception 'invalid_task_status';
  end if;

  select task.*
  into v_task
  from work_core.tasks task
  where task.id = p_task_id
    and task.tenant_id = v_tenant_id
  for update;

  if v_task.id is null then raise exception 'task_not_found'; end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant_id);
  v_view_team := private_app.can_view_tenant_team(v_tenant_id);
  if not v_view_team
     and v_task.assigned_staff_id is distinct from v_current_staff_id then
    raise exception 'forbidden';
  end if;

  if v_task.contact_id is not null and (
    v_task.metadata->>'source' in ('lead_assignment','opportunity_next_action','activity_next_action','lead_next_action','sales_followup')
    or v_task.metadata->>'aggregateCustomerFollowup'='true'
  ) then raise exception 'sales_task_requires_followup'; end if;

  v_next_status := coalesce(p_status, v_task.status);
  v_next_due_at := coalesce(p_due_at, v_task.due_at);
  v_clean_note := nullif(btrim(coalesce(p_note, '')), '');

  if length(coalesce(v_clean_note, '')) > 2000 then
    raise exception 'task_note_too_long';
  end if;
  if v_task.status in ('completed', 'cancelled')
     and v_next_status = v_task.status
     and v_next_due_at is distinct from v_task.due_at then
    raise exception 'task_closed';
  end if;
  if v_next_status = v_task.status
     and v_next_due_at is not distinct from v_task.due_at
     and v_clean_note is null then
    raise exception 'task_transition_required';
  end if;

  if v_next_status = 'completed' then
    v_completed_at := case
      when v_task.status = 'completed' then v_task.completed_at
      else now()
    end;
    v_completion_timing := case
      when v_completed_at <= v_next_due_at then 'on_time'
      else 'late'
    end;
  else
    v_completed_at := null;
    v_completion_timing := null;
  end if;

  update work_core.tasks
  set status = v_next_status,
      due_at = v_next_due_at,
      completed_at = v_completed_at,
      completion_timing = v_completion_timing,
      metadata = metadata || jsonb_build_object(
        'lastTransition',
        jsonb_strip_nulls(jsonb_build_object(
          'fromStatus', v_task.status,
          'toStatus', v_next_status,
          'fromDueAt', v_task.due_at,
          'toDueAt', v_next_due_at,
          'note', v_clean_note,
          'actorSubjectId', private_app.current_subject_id(),
          'at', now(),
          'mode', 'same_task_row_v3'
        ))
      ),
      updated_at = now()
  where id = v_task.id
    and tenant_id = v_tenant_id;

  perform private_app.write_audit(
    'tenant.work_task_transitioned',
    'work_task',
    v_task.id::text,
    v_tenant_id,
    jsonb_strip_nulls(jsonb_build_object(
      'previousStatus', v_task.status,
      'status', v_next_status,
      'previousDueAt', v_task.due_at,
      'nextDueAt', v_next_due_at,
      'note', v_clean_note,
      'taskUpdateMode', 'same_task_row_v3'
    ))
  );

  return jsonb_build_object(
    'id', v_task.id,
    'status', v_next_status,
    'dueAt', v_next_due_at,
    'previousDueAt', v_task.due_at,
    'completionTiming', v_completion_timing,
    'moved', v_next_due_at is distinct from v_task.due_at,
    'taskUpdateMode', 'same_task_row_v3'
  );
end;
$function$
;

commit;
