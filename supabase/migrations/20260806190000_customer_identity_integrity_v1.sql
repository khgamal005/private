begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table
  academy.registration_handoffs,
  academy.students,
  marketing_hub.conversion_events,
  marketing_hub.touchpoints,
  sales_core.activities,
  sales_core.contacts,
  sales_core.lead_assignments,
  sales_core.lead_import_rows,
  sales_core.lead_status_history,
  sales_core.opportunities,
  work_core.tasks
in share row exclusive mode;

create or replace function private_app.normalize_lead_phone(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_digits text;
begin
  v_digits := pg_catalog.translate(
    coalesce(p_value, ''),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹',
    '01234567890123456789'
  );
  v_digits := pg_catalog.regexp_replace(v_digits, '[^0-9]', '', 'g');

  if v_digits like '00%' then
    v_digits := pg_catalog.substr(v_digits, 3);
  end if;

  if v_digits ~ '^(9660?|996)5[0-9]{8}$' then
    return '966' || pg_catalog.right(v_digits, 9);
  end if;
  if v_digits ~ '^05[0-9]{8}$' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if v_digits ~ '^5[0-9]{8}$' then
    return '966' || v_digits;
  end if;
  if pg_catalog.length(v_digits) = 10 and v_digits like '0%' then
    return '966' || pg_catalog.substr(v_digits, 2);
  end if;
  if pg_catalog.length(v_digits) between 8 and 15 then
    return v_digits;
  end if;
  return null;
end;
$$;

revoke all on function private_app.normalize_lead_phone(text)
from public, anon, authenticated;

create unique index if not exists sales_contacts_tenant_id_id_uidx
on sales_core.contacts (tenant_id, id);

create table if not exists sales_core.contact_merge_archive (
  original_contact_id uuid primary key,
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  merged_into_contact_id uuid not null,
  identity_snapshot jsonb not null default '[]'::jsonb,
  original_record jsonb not null,
  related_record_counts jsonb not null default '{}'::jsonb,
  merge_reason text not null,
  merge_version text not null default 'customer-identity-v1',
  merged_at timestamptz not null default now(),
  constraint contact_merge_archive_master_fkey
    foreign key (tenant_id, merged_into_contact_id)
    references sales_core.contacts(tenant_id, id)
    on delete restrict
);

create index if not exists contact_merge_archive_master_idx
on sales_core.contact_merge_archive (
  tenant_id,
  merged_into_contact_id,
  merged_at desc
);

alter table sales_core.contact_merge_archive enable row level security;
revoke all on table sales_core.contact_merge_archive
from public, anon, authenticated;

create table if not exists sales_core.contact_identities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  contact_id uuid not null,
  identity_type text not null
    check (identity_type in ('phone', 'email')),
  identity_value text not null
    check (length(trim(identity_value)) between 3 and 320),
  source_slot text not null
    check (source_slot in (
      'phone',
      'whatsapp',
      'email',
      'merged_alias',
      'historical_alias'
    )),
  is_alias boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contact_identities_contact_fkey
    foreign key (tenant_id, contact_id)
    references sales_core.contacts(tenant_id, id)
    on delete cascade
);

create index if not exists contact_identities_contact_idx
on sales_core.contact_identities (contact_id, tenant_id);

create index if not exists contact_identities_lookup_idx
on sales_core.contact_identities (
  tenant_id,
  identity_type,
  identity_value
);

alter table sales_core.contact_identities enable row level security;
revoke all on table sales_core.contact_identities
from public, anon, authenticated;

with candidates as (
  select
    contact.tenant_id,
    contact.id as contact_id,
    'phone'::text as identity_type,
    private_app.normalize_lead_phone(contact.phone) as identity_value,
    'phone'::text as source_slot,
    1 as source_order
  from sales_core.contacts contact
  union all
  select
    contact.tenant_id,
    contact.id,
    'phone',
    private_app.normalize_lead_phone(contact.whatsapp),
    'whatsapp',
    2
  from sales_core.contacts contact
  union all
  select
    contact.tenant_id,
    contact.id,
    'email',
    nullif(lower(trim(contact.email)), ''),
    'email',
    3
  from sales_core.contacts contact
), deduplicated as (
  select distinct on (
    tenant_id,
    contact_id,
    identity_type,
    identity_value
  )
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_slot
  from candidates
  where identity_value is not null
  order by
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_order
)
insert into sales_core.contact_identities (
  tenant_id,
  contact_id,
  identity_type,
  identity_value,
  source_slot
)
select
  tenant_id,
  contact_id,
  identity_type,
  identity_value,
  source_slot
from deduplicated;

create or replace function private_app.merge_contact_pair(
  p_master_contact_id uuid,
  p_duplicate_contact_id uuid,
  p_reason text default 'normalized_identity_collision'
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_master sales_core.contacts%rowtype;
  v_duplicate sales_core.contacts%rowtype;
  v_keep_task_id uuid;
  v_keep_assignment_id uuid;
  v_keep_opportunity_id uuid;
  v_owner_staff_id uuid;
  v_related_counts jsonb;
begin
  if p_master_contact_id = p_duplicate_contact_id then
    return;
  end if;

  perform contact.id
  from sales_core.contacts contact
  where contact.id in (p_master_contact_id, p_duplicate_contact_id)
  order by contact.id
  for update;

  select * into v_master
  from sales_core.contacts
  where id = p_master_contact_id;

  select * into v_duplicate
  from sales_core.contacts
  where id = p_duplicate_contact_id;

  if v_master.id is null or v_duplicate.id is null then
    return;
  end if;
  if v_master.tenant_id <> v_duplicate.tenant_id then
    raise exception 'cross_tenant_contact_merge_blocked';
  end if;
  if exists (
    select 1
    from academy.students master_student
    join academy.students duplicate_student
      on duplicate_student.tenant_id = master_student.tenant_id
    where master_student.contact_id = v_master.id
      and duplicate_student.contact_id = v_duplicate.id
  ) then
    raise exception 'duplicate_contacts_have_conflicting_students';
  end if;

  v_related_counts := jsonb_build_object(
    'activities', (
      select count(*) from sales_core.activities
      where contact_id = v_duplicate.id
    ),
    'tasks', (
      select count(*) from work_core.tasks
      where contact_id = v_duplicate.id
    ),
    'opportunities', (
      select count(*) from sales_core.opportunities
      where contact_id = v_duplicate.id
    ),
    'assignments', (
      select count(*) from sales_core.lead_assignments
      where contact_id = v_duplicate.id
    ),
    'statusHistory', (
      select count(*) from sales_core.lead_status_history
      where contact_id = v_duplicate.id
    ),
    'students', (
      select count(*) from academy.students
      where contact_id = v_duplicate.id
    ),
    'registrationHandoffs', (
      select count(*) from academy.registration_handoffs
      where contact_id = v_duplicate.id
    ),
    'touchpoints', (
      select count(*) from marketing_hub.touchpoints
      where contact_id = v_duplicate.id
    ),
    'conversionEvents', (
      select count(*) from marketing_hub.conversion_events
      where contact_id = v_duplicate.id
    )
  );

  insert into sales_core.contact_merge_archive (
    original_contact_id,
    tenant_id,
    merged_into_contact_id,
    identity_snapshot,
    original_record,
    related_record_counts,
    merge_reason
  )
  select
    v_duplicate.id,
    v_duplicate.tenant_id,
    v_master.id,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'type', identity.identity_type,
        'value', identity.identity_value,
        'source', identity.source_slot
      ) order by identity.identity_type, identity.identity_value)
      from sales_core.contact_identities identity
      where identity.contact_id = v_duplicate.id
    ), '[]'::jsonb),
    to_jsonb(v_duplicate),
    v_related_counts,
    p_reason
  on conflict (original_contact_id) do nothing;

  update sales_core.contact_merge_archive archive
  set merged_into_contact_id = v_master.id,
      merge_reason = archive.merge_reason || '+chain_repointed'
  where archive.merged_into_contact_id = v_duplicate.id;

  v_owner_staff_id := coalesce(
    v_master.owner_staff_id,
    v_duplicate.owner_staff_id
  );

  select opportunity.id
  into v_keep_opportunity_id
  from sales_core.opportunities opportunity
  where opportunity.contact_id in (v_master.id, v_duplicate.id)
    and opportunity.status in ('pending_verification', 'won', 'open')
  order by
    case opportunity.status
      when 'pending_verification' then 3
      when 'won' then 2
      else 1
    end desc,
    exists (
      select 1
      from academy.registration_handoffs handoff
      where handoff.opportunity_id = opportunity.id
    ) desc,
    (opportunity.contact_id = v_master.id) desc,
    opportunity.updated_at desc,
    opportunity.id
  limit 1;

  select assignment.id, assignment.assigned_staff_id
  into v_keep_assignment_id, v_owner_staff_id
  from sales_core.lead_assignments assignment
  where assignment.contact_id in (v_master.id, v_duplicate.id)
    and assignment.status = 'active'
  order by
    (assignment.assigned_staff_id = v_owner_staff_id) desc,
    (assignment.contact_id = v_master.id) desc,
    assignment.first_action_at desc nulls last,
    assignment.assigned_at desc,
    assignment.id
  limit 1;

  v_owner_staff_id := coalesce(
    v_owner_staff_id,
    v_master.owner_staff_id,
    v_duplicate.owner_staff_id
  );

  select task.id
  into v_keep_task_id
  from work_core.tasks task
  where task.contact_id in (v_master.id, v_duplicate.id)
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup',
      'lead_assignment'
    )
  order by
    (task.assigned_staff_id = v_owner_staff_id) desc,
    (task.status = 'in_progress') desc,
    task.due_at,
    task.created_at desc,
    task.id
  limit 1;

  update work_core.tasks task
  set status = 'cancelled',
      completed_at = coalesce(task.completed_at, now()),
      metadata = task.metadata || jsonb_build_object(
        'deduplicated', true,
        'mergedIntoContactId', v_master.id,
        'cancelReason', 'duplicate_customer_task'
      )
  where task.contact_id in (v_master.id, v_duplicate.id)
    and task.status in ('todo', 'in_progress')
    and coalesce(task.metadata ->> 'source', '') in (
      'opportunity_next_action',
      'activity_next_action',
      'lead_next_action',
      'sales_followup',
      'lead_assignment'
    )
    and task.id is distinct from v_keep_task_id;

  update sales_core.lead_assignments assignment
  set status = 'reassigned',
      completed_at = coalesce(assignment.completed_at, now()),
      metadata = assignment.metadata || jsonb_build_object(
        'deduplicated', true,
        'mergedIntoContactId', v_master.id,
        'replacementAssignmentId', v_keep_assignment_id
      )
  where assignment.contact_id in (v_master.id, v_duplicate.id)
    and assignment.status = 'active'
    and assignment.id is distinct from v_keep_assignment_id;

  update sales_core.opportunities opportunity
  set status = 'cancelled',
      metadata = opportunity.metadata || jsonb_build_object(
        'deduplicated', true,
        'mergedIntoContactId', v_master.id,
        'mergedIntoOpportunityId', v_keep_opportunity_id
      )
  where opportunity.contact_id in (v_master.id, v_duplicate.id)
    and opportunity.status = 'open'
    and opportunity.id is distinct from v_keep_opportunity_id;

  update sales_core.contacts master_contact
  set full_name = case
        when lower(trim(master_contact.full_name)) in (
          'no name', 'unknown', 'غير معروف', 'بدون اسم', 'عميل'
        ) and lower(trim(v_duplicate.full_name)) not in (
          'no name', 'unknown', 'غير معروف', 'بدون اسم', 'عميل'
        ) then v_duplicate.full_name
        else master_contact.full_name
      end,
      organization_name = coalesce(
        master_contact.organization_name,
        v_duplicate.organization_name
      ),
      phone = coalesce(
        private_app.normalize_lead_phone(master_contact.phone),
        private_app.normalize_lead_phone(master_contact.whatsapp),
        private_app.normalize_lead_phone(v_duplicate.phone),
        private_app.normalize_lead_phone(v_duplicate.whatsapp)
      ),
      whatsapp = coalesce(
        private_app.normalize_lead_phone(master_contact.whatsapp),
        private_app.normalize_lead_phone(master_contact.phone),
        private_app.normalize_lead_phone(v_duplicate.whatsapp),
        private_app.normalize_lead_phone(v_duplicate.phone)
      ),
      email = coalesce(
        nullif(lower(trim(master_contact.email)), ''),
        nullif(lower(trim(v_duplicate.email)), '')
      ),
      owner_staff_id = v_owner_staff_id,
      interest_course_id = coalesce(
        master_contact.interest_course_id,
        v_duplicate.interest_course_id
      ),
      notes = coalesce(master_contact.notes, v_duplicate.notes),
      next_action_type = case
        when master_contact.next_action_at is null
          then v_duplicate.next_action_type
        when v_duplicate.next_action_at is null
          then master_contact.next_action_type
        when v_duplicate.next_action_at < master_contact.next_action_at
          then v_duplicate.next_action_type
        else master_contact.next_action_type
      end,
      next_action_at = case
        when master_contact.next_action_at is null
          then v_duplicate.next_action_at
        when v_duplicate.next_action_at is null
          then master_contact.next_action_at
        else least(
          master_contact.next_action_at,
          v_duplicate.next_action_at
        )
      end,
      last_activity_at = greatest(
        master_contact.last_activity_at,
        v_duplicate.last_activity_at
      ),
      campaign_name = coalesce(
        master_contact.campaign_name,
        v_duplicate.campaign_name
      ),
      ad_name = coalesce(master_contact.ad_name, v_duplicate.ad_name),
      payment_submitted_at = greatest(
        master_contact.payment_submitted_at,
        v_duplicate.payment_submitted_at
      ),
      created_at = least(master_contact.created_at, v_duplicate.created_at),
      metadata = master_contact.metadata || jsonb_build_object(
        'deduplication', coalesce(
          master_contact.metadata -> 'deduplication',
          '{}'::jsonb
        ) || jsonb_build_object(
          'version', 'customer-identity-v1',
          'lastMergedAt', now(),
          'mergedContactIds', coalesce(
            master_contact.metadata #> '{deduplication,mergedContactIds}',
            '[]'::jsonb
          ) || jsonb_build_array(v_duplicate.id),
          'previousOwners', coalesce(
            master_contact.metadata #> '{deduplication,previousOwners}',
            '[]'::jsonb
          ) || jsonb_build_array(v_duplicate.owner_staff_id),
          'sources', coalesce(
            master_contact.metadata #> '{deduplication,sources}',
            '[]'::jsonb
          ) || jsonb_build_array(v_duplicate.source)
        )
      )
  where master_contact.id = v_master.id;

  update sales_core.activities
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update sales_core.lead_status_history
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update sales_core.lead_assignments
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update sales_core.lead_import_rows
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update sales_core.lead_import_rows
  set duplicate_contact_id = v_master.id
  where duplicate_contact_id = v_duplicate.id;

  update sales_core.opportunities
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update work_core.tasks
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update academy.registration_handoffs
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update academy.students
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update marketing_hub.touchpoints
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update marketing_hub.conversion_events
  set contact_id = v_master.id
  where contact_id = v_duplicate.id;

  update work_core.tasks task
  set assigned_staff_id = coalesce(v_owner_staff_id, task.assigned_staff_id),
      opportunity_id = coalesce(v_keep_opportunity_id, task.opportunity_id),
      metadata = task.metadata || jsonb_build_object(
        'deduplicated', true,
        'canonicalContactId', v_master.id
      )
  where task.id = v_keep_task_id
    and task.status in ('todo', 'in_progress');

  update sales_core.opportunities opportunity
  set owner_staff_id = coalesce(
        v_owner_staff_id,
        opportunity.owner_staff_id
      ),
      metadata = opportunity.metadata || jsonb_build_object(
        'deduplicated', true,
        'canonicalContactId', v_master.id
      )
  where opportunity.id = v_keep_opportunity_id;

  update sales_core.lead_assignments assignment
  set opportunity_id = coalesce(
        v_keep_opportunity_id,
        assignment.opportunity_id
      ),
      task_id = coalesce(v_keep_task_id, assignment.task_id),
      metadata = assignment.metadata || jsonb_build_object(
        'deduplicated', true,
        'canonicalContactId', v_master.id
      )
  where assignment.id = v_keep_assignment_id;

  delete from sales_core.contact_identities duplicate_identity
  using sales_core.contact_identities master_identity
  where duplicate_identity.contact_id = v_duplicate.id
    and master_identity.contact_id = v_master.id
    and master_identity.tenant_id = duplicate_identity.tenant_id
    and master_identity.identity_type = duplicate_identity.identity_type
    and master_identity.identity_value = duplicate_identity.identity_value;

  update sales_core.contact_identities
  set contact_id = v_master.id,
      source_slot = 'merged_alias',
      is_alias = true,
      updated_at = now()
  where contact_id = v_duplicate.id;

  delete from sales_core.contacts
  where id = v_duplicate.id;
end;
$$;

revoke all on function private_app.merge_contact_pair(uuid, uuid, text)
from public, anon, authenticated;

do $$
declare
  v_left_contact_id uuid;
  v_right_contact_id uuid;
  v_master_contact_id uuid;
  v_duplicate_contact_id uuid;
  v_iterations integer := 0;
begin
  loop
    v_iterations := v_iterations + 1;
    if v_iterations > 10000 then
      raise exception 'contact_deduplication_iteration_limit';
    end if;

    select left_identity.contact_id, right_identity.contact_id
    into v_left_contact_id, v_right_contact_id
    from sales_core.contact_identities left_identity
    join sales_core.contact_identities right_identity
      on right_identity.tenant_id = left_identity.tenant_id
     and right_identity.identity_type = left_identity.identity_type
     and right_identity.identity_value = left_identity.identity_value
     and right_identity.contact_id <> left_identity.contact_id
    order by
      left_identity.tenant_id,
      left_identity.identity_type,
      left_identity.identity_value,
      left_identity.contact_id,
      right_identity.contact_id
    limit 1;

    exit when v_left_contact_id is null;

    select contact.id
    into v_master_contact_id
    from sales_core.contacts contact
    where contact.id in (v_left_contact_id, v_right_contact_id)
    order by
      exists (
        select 1 from academy.students student
        where student.contact_id = contact.id
      ) desc,
      exists (
        select 1 from academy.registration_handoffs handoff
        where handoff.contact_id = contact.id
          and handoff.payment_status = 'verified'
      ) desc,
      coalesce(
        contact.last_activity_at,
        (
          select max(activity.occurred_at)
          from sales_core.activities activity
          where activity.contact_id = contact.id
        )
      ) desc nulls last,
      case contact.lead_status
        when 'paid' then 100
        when 'payment_submitted' then 95
        when 'awaiting_payment' then 90
        when 'very_interested' then 85
        when 'interested' then 80
        when 'not_interested' then 75
        when 'unqualified' then 74
        when 'wrong_number' then 73
        when 'cancelled' then 72
        when 'follow_up' then 65
        when 'postponed' then 60
        when 'busy' then 55
        when 'no_answer' then 50
        else 10
      end desc,
      case contact.lead_quality
        when 'excellent' then 6
        when 'good' then 5
        when 'qualified' then 4
        when 'weak' then 3
        when 'unqualified' then 2
        else 1
      end desc,
      contact.updated_at desc,
      contact.created_at,
      contact.id
    limit 1;

    v_duplicate_contact_id := case
      when v_master_contact_id = v_left_contact_id
        then v_right_contact_id
      else v_left_contact_id
    end;

    perform private_app.merge_contact_pair(
      v_master_contact_id,
      v_duplicate_contact_id,
      'normalized_identity_collision'
    );
  end loop;
end;
$$;

update sales_core.contacts contact
set phone = coalesce(
      private_app.normalize_lead_phone(contact.phone),
      contact.phone
    ),
    whatsapp = coalesce(
      private_app.normalize_lead_phone(contact.whatsapp),
      contact.whatsapp
    ),
    email = nullif(lower(trim(contact.email)), '')
where contact.phone is not null
   or contact.whatsapp is not null
   or contact.email is not null;

with candidates as (
  select
    contact.tenant_id,
    contact.id as contact_id,
    'phone'::text as identity_type,
    private_app.normalize_lead_phone(contact.phone) as identity_value,
    'phone'::text as source_slot,
    1 as source_order
  from sales_core.contacts contact
  union all
  select
    contact.tenant_id,
    contact.id,
    'phone',
    private_app.normalize_lead_phone(contact.whatsapp),
    'whatsapp',
    2
  from sales_core.contacts contact
  union all
  select
    contact.tenant_id,
    contact.id,
    'email',
    nullif(lower(trim(contact.email)), ''),
    'email',
    3
  from sales_core.contacts contact
), deduplicated as (
  select distinct on (
    tenant_id,
    contact_id,
    identity_type,
    identity_value
  )
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_slot
  from candidates
  where identity_value is not null
  order by
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_order
)
insert into sales_core.contact_identities (
  tenant_id,
  contact_id,
  identity_type,
  identity_value,
  source_slot
)
select
  candidate.tenant_id,
  candidate.contact_id,
  candidate.identity_type,
  candidate.identity_value,
  candidate.source_slot
from deduplicated candidate
where not exists (
  select 1
  from sales_core.contact_identities identity
  where identity.tenant_id = candidate.tenant_id
    and identity.contact_id = candidate.contact_id
    and identity.identity_type = candidate.identity_type
    and identity.identity_value = candidate.identity_value
);

do $$
begin
  if exists (
    select 1
    from sales_core.contact_identities identity
    group by
      identity.tenant_id,
      identity.identity_type,
      identity.identity_value
    having count(distinct identity.contact_id) > 1
  ) then
    raise exception 'contact_identity_backfill_still_has_duplicates';
  end if;
end;
$$;

drop index if exists sales_core.contact_identities_lookup_idx;

create unique index contact_identities_tenant_type_value_uidx
on sales_core.contact_identities (
  tenant_id,
  identity_type,
  identity_value
);

with ranked as (
  select
    assignment.id,
    row_number() over (
      partition by assignment.tenant_id, assignment.contact_id
      order by
        assignment.first_action_at desc nulls last,
        assignment.assigned_at desc,
        assignment.id
    ) as rank_number
  from sales_core.lead_assignments assignment
  where assignment.status = 'active'
)
update sales_core.lead_assignments assignment
set status = 'reassigned',
    completed_at = coalesce(assignment.completed_at, now()),
    metadata = assignment.metadata || jsonb_build_object(
      'deduplicated', true,
      'cancelReason', 'multiple_active_assignments_guard'
    )
from ranked
where ranked.id = assignment.id
  and ranked.rank_number > 1;

create unique index if not exists lead_assignments_one_active_contact_idx
on sales_core.lead_assignments (tenant_id, contact_id)
where status = 'active';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'sales_core.contacts'::regclass
      and conname = 'contacts_email_format_check'
  ) then
    alter table sales_core.contacts
    add constraint contacts_email_format_check
    check (
      email is null
      or email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    ) not valid;
  end if;
end;
$$;

alter table sales_core.contacts
validate constraint contacts_email_format_check;

create or replace function private_app.prepare_contact_identity_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_normalized text;
begin
  if nullif(trim(coalesce(new.phone, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.phone);
    if v_normalized is null then
      raise exception 'invalid_phone';
    end if;
    new.phone := v_normalized;
  else
    new.phone := null;
  end if;

  if nullif(trim(coalesce(new.whatsapp, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.whatsapp);
    if v_normalized is null then
      raise exception 'invalid_whatsapp';
    end if;
    new.whatsapp := v_normalized;
  else
    new.whatsapp := null;
  end if;

  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  if new.email is not null
     and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;
  if new.phone is null
     and new.whatsapp is null
     and new.email is null then
    raise exception 'contact_identity_required';
  end if;

  return new;
end;
$$;

create or replace function private_app.sync_contact_identities()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.tenant_id is distinct from new.tenant_id then
    delete from sales_core.contact_identities
    where contact_id = new.id;
  elsif tg_op = 'UPDATE' then
    update sales_core.contact_identities
    set source_slot = 'historical_alias',
        is_alias = true,
        updated_at = now()
    where contact_id = new.id
      and not is_alias;
  else
    delete from sales_core.contact_identities
    where contact_id = new.id
      and not is_alias;
  end if;

  delete from sales_core.contact_identities identity
  where identity.contact_id = new.id
    and identity.is_alias
    and (
      (
        identity.identity_type = 'phone'
        and identity.identity_value in (new.phone, new.whatsapp)
      )
      or (
        identity.identity_type = 'email'
        and identity.identity_value = new.email
      )
    );

  insert into sales_core.contact_identities (
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_slot,
    is_alias
  )
  select distinct on (candidate.identity_type, candidate.identity_value)
    new.tenant_id,
    new.id,
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_slot,
    false
  from (
    values
      ('phone'::text, new.phone, 'phone'::text, 1),
      ('phone'::text, new.whatsapp, 'whatsapp'::text, 2),
      ('email'::text, new.email, 'email'::text, 3)
  ) as candidate(identity_type, identity_value, source_slot, source_order)
  where candidate.identity_value is not null
  order by
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_order;

  return new;
end;
$$;

revoke all on function private_app.prepare_contact_identity_fields()
from public, anon, authenticated;
revoke all on function private_app.sync_contact_identities()
from public, anon, authenticated;

drop trigger if exists sales_contacts_prepare_identity_fields
on sales_core.contacts;
create trigger sales_contacts_prepare_identity_fields
before insert or update of phone, whatsapp, email
on sales_core.contacts
for each row execute function private_app.prepare_contact_identity_fields();

drop trigger if exists sales_contacts_sync_identities
on sales_core.contacts;
create trigger sales_contacts_sync_identities
after insert or update of tenant_id, phone, whatsapp, email
on sales_core.contacts
for each row execute function private_app.sync_contact_identities();

create or replace function private_app.find_contact_by_identity(
  p_tenant_id uuid,
  p_phone text,
  p_whatsapp text,
  p_email text
)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select identity.contact_id
  from sales_core.contact_identities identity
  join sales_core.contacts contact
    on contact.id = identity.contact_id
   and contact.tenant_id = identity.tenant_id
  where identity.tenant_id = p_tenant_id
    and (
      (
        identity.identity_type = 'phone'
        and identity.identity_value in (
          private_app.normalize_lead_phone(p_phone),
          private_app.normalize_lead_phone(p_whatsapp)
        )
      )
      or (
        identity.identity_type = 'email'
        and identity.identity_value = nullif(lower(trim(p_email)), '')
      )
    )
  order by contact.created_at, contact.id
  limit 1;
$$;

revoke all on function private_app.find_contact_by_identity(
  uuid,
  text,
  text,
  text
) from public, anon, authenticated;


commit;
