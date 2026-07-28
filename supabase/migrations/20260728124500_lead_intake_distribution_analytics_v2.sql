begin;

insert into access_control.permissions (
  permission_key,
  module_key,
  name_ar,
  description
)
values
  (
    'tenant.leads.read',
    'crm',
    'عرض استقبال وتوزيع العملاء',
    'عرض دفعات رفع العملاء وصف الانتظار وسجل التوزيع'
  ),
  (
    'tenant.leads.import',
    'crm',
    'رفع وتنظيف العملاء',
    'رفع ملفات العملاء وفحص البيانات والتكرار قبل التوزيع'
  ),
  (
    'tenant.leads.distribute',
    'crm',
    'توزيع العملاء',
    'توزيع العملاء على فريق المبيعات وإدارة مهلة المتابعة'
  ),
  (
    'tenant.leads.analytics',
    'analytics',
    'تحليلات مصادر العملاء',
    'عرض جودة المصادر والحملات وسرعة الاستجابة والتحويل'
  )
on conflict (permission_key) do update
set module_key = excluded.module_key,
    name_ar = excluded.name_ar,
    description = excluded.description;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in (
    'tenant_owner',
    'tenant_admin',
    'executive_manager'
  )
  and permission.permission_key in (
    'tenant.leads.read',
    'tenant.leads.import',
    'tenant.leads.distribute',
    'tenant.leads.analytics'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key in ('sales_manager', 'sales_supervisor')
  and permission.permission_key in (
    'tenant.leads.read',
    'tenant.leads.distribute',
    'tenant.leads.analytics'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key = 'data_officer'
  and permission.permission_key in (
    'tenant.leads.read',
    'tenant.leads.import',
    'tenant.leads.analytics'
  )
on conflict do nothing;

insert into access_control.role_permissions (role_id, permission_key)
select role.id, permission.permission_key
from access_control.roles role
cross join access_control.permissions permission
where role.scope = 'tenant'
  and role.role_key = 'data_analyst'
  and permission.permission_key in (
    'tenant.leads.read',
    'tenant.leads.analytics'
  )
on conflict do nothing;

create table sales_core.lead_import_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  batch_key text not null,
  file_name text not null,
  source text not null default 'sheet_import',
  campaign_name text,
  ad_set_name text,
  ad_name text,
  status text not null default 'ready'
    check (status in (
      'ready',
      'partially_distributed',
      'distributed',
      'cancelled',
      'failed'
    )),
  total_rows integer not null default 0 check (total_rows >= 0),
  valid_rows integer not null default 0 check (valid_rows >= 0),
  duplicate_rows integer not null default 0 check (duplicate_rows >= 0),
  invalid_rows integer not null default 0 check (invalid_rows >= 0),
  distributed_rows integer not null default 0 check (distributed_rows >= 0),
  imported_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  imported_by_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  last_distributed_by_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  last_distribution_strategy text
    check (
      last_distribution_strategy is null
      or last_distribution_strategy in ('fair', 'online_only', 'selected')
    ),
  last_deadline_at timestamptz,
  distributed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, batch_key),
  check (valid_rows + duplicate_rows + invalid_rows = total_rows)
);

create table sales_core.lead_import_rows (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  batch_id uuid not null
    references sales_core.lead_import_batches(id) on delete cascade,
  row_number integer not null check (row_number > 0),
  full_name text,
  organization_name text,
  phone text,
  normalized_phone text,
  whatsapp text,
  normalized_whatsapp text,
  email text,
  source text not null default 'sheet_import',
  campaign_name text,
  ad_set_name text,
  ad_name text,
  program_name text,
  notes text,
  validation_status text not null
    check (validation_status in ('valid', 'duplicate', 'invalid')),
  validation_errors text[] not null default '{}'::text[],
  duplicate_kind text
    check (
      duplicate_kind is null
      or duplicate_kind in ('same_file', 'existing_contact')
    ),
  duplicate_contact_id uuid
    references sales_core.contacts(id) on delete set null,
  queue_status text not null default 'awaiting_distribution'
    check (queue_status in (
      'awaiting_distribution',
      'assigned',
      'skipped',
      'cancelled'
    )),
  contact_id uuid references sales_core.contacts(id) on delete set null,
  raw_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, row_number),
  check (
    (validation_status = 'valid' and queue_status in (
      'awaiting_distribution',
      'assigned',
      'cancelled'
    ))
    or (
      validation_status in ('duplicate', 'invalid')
      and queue_status = 'skipped'
    )
  )
);

create table sales_core.sales_assignment_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  staff_id uuid not null
    references people.staff_profiles(id) on delete cascade,
  sales_channel text not null default 'online'
    check (sales_channel in ('online', 'field', 'hybrid')),
  eligible_for_leads boolean not null default true,
  daily_capacity integer not null default 50
    check (daily_capacity between 1 and 1000),
  weight integer not null default 1 check (weight between 1 and 10),
  last_assigned_at timestamptz,
  updated_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, staff_id)
);

create table sales_core.lead_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references core.tenants(id) on delete cascade,
  batch_id uuid not null
    references sales_core.lead_import_batches(id) on delete cascade,
  import_row_id uuid not null
    references sales_core.lead_import_rows(id) on delete cascade,
  contact_id uuid not null
    references sales_core.contacts(id) on delete cascade,
  opportunity_id uuid
    references sales_core.opportunities(id) on delete set null,
  task_id uuid references work_core.tasks(id) on delete set null,
  assigned_staff_id uuid not null
    references people.staff_profiles(id) on delete restrict,
  assigned_by_staff_id uuid
    references people.staff_profiles(id) on delete set null,
  assigned_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  assignment_strategy text not null
    check (assignment_strategy in ('fair', 'online_only', 'selected')),
  status text not null default 'active'
    check (status in ('active', 'completed', 'reassigned', 'cancelled')),
  assigned_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  first_action_at timestamptz,
  completed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (deadline_at > assigned_at),
  check (
    completed_at is null
    or completed_at >= assigned_at
  )
);

create unique index lead_assignments_one_active_row_idx
on sales_core.lead_assignments (import_row_id)
where status = 'active';

create index lead_import_batches_tenant_status_idx
on sales_core.lead_import_batches (tenant_id, status, created_at desc);

create index lead_import_batches_importer_reference_idx
on sales_core.lead_import_batches (imported_by_subject_id);

create index lead_import_batches_staff_reference_idx
on sales_core.lead_import_batches (imported_by_staff_id);

create index lead_import_batches_distributor_reference_idx
on sales_core.lead_import_batches (last_distributed_by_staff_id);

create index lead_import_rows_tenant_queue_idx
on sales_core.lead_import_rows (
  tenant_id,
  queue_status,
  validation_status,
  created_at
);

create index lead_import_rows_batch_queue_idx
on sales_core.lead_import_rows (batch_id, queue_status, row_number);

create index lead_import_rows_phone_idx
on sales_core.lead_import_rows (tenant_id, normalized_phone)
where normalized_phone is not null;

create index lead_import_rows_whatsapp_idx
on sales_core.lead_import_rows (tenant_id, normalized_whatsapp)
where normalized_whatsapp is not null;

create index lead_import_rows_email_idx
on sales_core.lead_import_rows (tenant_id, lower(email))
where email is not null;

create index lead_import_rows_duplicate_reference_idx
on sales_core.lead_import_rows (duplicate_contact_id);

create index lead_import_rows_contact_reference_idx
on sales_core.lead_import_rows (contact_id);

create index sales_assignment_profiles_tenant_eligible_idx
on sales_core.sales_assignment_profiles (
  tenant_id,
  eligible_for_leads,
  sales_channel,
  last_assigned_at
);

create index sales_assignment_profiles_subject_reference_idx
on sales_core.sales_assignment_profiles (updated_by_subject_id);

create index lead_assignments_tenant_deadline_idx
on sales_core.lead_assignments (
  tenant_id,
  status,
  deadline_at
);

create index lead_assignments_staff_deadline_idx
on sales_core.lead_assignments (
  assigned_staff_id,
  status,
  deadline_at
);

create index lead_assignments_batch_reference_idx
on sales_core.lead_assignments (batch_id);

create index lead_assignments_contact_reference_idx
on sales_core.lead_assignments (contact_id);

create index lead_assignments_opportunity_reference_idx
on sales_core.lead_assignments (opportunity_id);

create index lead_assignments_task_reference_idx
on sales_core.lead_assignments (task_id);

create index lead_assignments_assigner_staff_reference_idx
on sales_core.lead_assignments (assigned_by_staff_id);

create index lead_assignments_assigner_subject_reference_idx
on sales_core.lead_assignments (assigned_by_subject_id);

create trigger lead_import_batches_set_updated_at
before update on sales_core.lead_import_batches
for each row execute function private_app.set_updated_at();

create trigger lead_import_rows_set_updated_at
before update on sales_core.lead_import_rows
for each row execute function private_app.set_updated_at();

create trigger sales_assignment_profiles_set_updated_at
before update on sales_core.sales_assignment_profiles
for each row execute function private_app.set_updated_at();

create trigger lead_assignments_set_updated_at
before update on sales_core.lead_assignments
for each row execute function private_app.set_updated_at();

alter table sales_core.lead_import_batches enable row level security;
alter table sales_core.lead_import_rows enable row level security;
alter table sales_core.sales_assignment_profiles enable row level security;
alter table sales_core.lead_assignments enable row level security;

create policy lead_import_batches_isolated_read
on sales_core.lead_import_batches
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy lead_import_rows_isolated_read
on sales_core.lead_import_rows
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy sales_assignment_profiles_isolated_read
on sales_core.sales_assignment_profiles
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

create policy lead_assignments_isolated_read
on sales_core.lead_assignments
for select
to authenticated
using (private_app.can_access_tenant(tenant_id));

revoke all on table sales_core.lead_import_batches
from public, anon, authenticated;
revoke all on table sales_core.lead_import_rows
from public, anon, authenticated;
revoke all on table sales_core.sales_assignment_profiles
from public, anon, authenticated;
revoke all on table sales_core.lead_assignments
from public, anon, authenticated;

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
  v_digits := regexp_replace(coalesce(p_value, ''), '[^0-9]', '', 'g');

  if v_digits like '00%' then
    v_digits := substr(v_digits, 3);
  end if;
  if length(v_digits) = 10 and v_digits like '05%' then
    v_digits := '966' || substr(v_digits, 2);
  elsif length(v_digits) = 9 and v_digits like '5%' then
    v_digits := '966' || v_digits;
  end if;

  if length(v_digits) between 8 and 15 then
    return v_digits;
  end if;
  return null;
end;
$$;

revoke all on function private_app.normalize_lead_phone(text)
from public, anon, authenticated;

create or replace function private_app.capture_lead_first_action()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.activity_type <> 'note' then
    update sales_core.lead_assignments assignment
    set first_action_at = coalesce(
          assignment.first_action_at,
          new.occurred_at,
          now()
        )
    where assignment.contact_id = new.contact_id
      and assignment.status = 'active'
      and assignment.first_action_at is null;
  end if;
  return new;
end;
$$;

revoke all on function private_app.capture_lead_first_action()
from public, anon, authenticated;

create trigger activities_capture_lead_first_action
after insert on sales_core.activities
for each row execute function private_app.capture_lead_first_action();

insert into sales_core.sales_assignment_profiles (
  tenant_id,
  staff_id,
  sales_channel,
  eligible_for_leads,
  daily_capacity
)
select
  staff.tenant_id,
  staff.id,
  'online',
  true,
  50
from people.staff_profiles staff
where staff.role_key = 'sales_user'
  and staff.employment_status = 'active'
on conflict (tenant_id, staff_id) do nothing;

create or replace function public.v2_tenant_lead_intake_snapshot(
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
  v_staff_id uuid;
  v_can_import boolean;
  v_can_distribute boolean;
  v_can_analytics boolean;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.read'
  ) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_can_import := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.import'
  );
  v_can_distribute := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.distribute'
  );
  v_can_analytics := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.leads.analytics'
  );

  return jsonb_build_object(
    'generatedAt', now(),
    'timezone', v_tenant.timezone,
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'canImport', v_can_import,
      'canDistribute', v_can_distribute,
      'canAnalytics', v_can_analytics
    ),
    'summary', jsonb_build_object(
      'awaitingDistribution', (
        select count(*)
        from sales_core.lead_import_rows row_data
        where row_data.tenant_id = v_tenant.id
          and row_data.validation_status = 'valid'
          and row_data.queue_status = 'awaiting_distribution'
      ),
      'distributedToday', (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = v_tenant.id
          and (
            assignment.assigned_at at time zone v_tenant.timezone
          )::date = (now() at time zone v_tenant.timezone)::date
      ),
      'invalidRows', (
        select count(*)
        from sales_core.lead_import_rows row_data
        where row_data.tenant_id = v_tenant.id
          and row_data.validation_status = 'invalid'
      ),
      'duplicateRows', (
        select count(*)
        from sales_core.lead_import_rows row_data
        where row_data.tenant_id = v_tenant.id
          and row_data.validation_status = 'duplicate'
      ),
      'overdueFirstActions', (
        select count(*)
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = v_tenant.id
          and assignment.status = 'active'
          and assignment.first_action_at is null
          and assignment.deadline_at < now()
      ),
      'averageFirstResponseMinutes', (
        select coalesce(
          round(avg(
            extract(
              epoch from (
                assignment.first_action_at - assignment.assigned_at
              )
            ) / 60
          )::numeric, 1),
          0
        )
        from sales_core.lead_assignments assignment
        where assignment.tenant_id = v_tenant.id
          and assignment.first_action_at is not null
      )
    ),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', batch.id,
        'key', batch.batch_key,
        'fileName', batch.file_name,
        'source', batch.source,
        'campaignName', batch.campaign_name,
        'adSetName', batch.ad_set_name,
        'adName', batch.ad_name,
        'status', batch.status,
        'totalRows', batch.total_rows,
        'validRows', batch.valid_rows,
        'duplicateRows', batch.duplicate_rows,
        'invalidRows', batch.invalid_rows,
        'distributedRows', batch.distributed_rows,
        'awaitingRows', greatest(
          batch.valid_rows - batch.distributed_rows,
          0
        ),
        'importerName', importer.full_name,
        'lastDistributorName', distributor.full_name,
        'lastStrategy', batch.last_distribution_strategy,
        'lastDeadlineAt', batch.last_deadline_at,
        'distributedAt', batch.distributed_at,
        'createdAt', batch.created_at
      ) order by batch.created_at desc)
      from (
        select *
        from sales_core.lead_import_batches batch_data
        where batch_data.tenant_id = v_tenant.id
        order by batch_data.created_at desc
        limit 50
      ) batch
      left join people.staff_profiles importer
        on importer.id = batch.imported_by_staff_id
      left join people.staff_profiles distributor
        on distributor.id = batch.last_distributed_by_staff_id
    ), '[]'::jsonb),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', row_data.id,
        'batchId', row_data.batch_id,
        'batchFileName', batch.file_name,
        'rowNumber', row_data.row_number,
        'name', row_data.full_name,
        'organizationName', row_data.organization_name,
        'phone', row_data.phone,
        'whatsapp', row_data.whatsapp,
        'email', row_data.email,
        'source', row_data.source,
        'campaignName', row_data.campaign_name,
        'adSetName', row_data.ad_set_name,
        'adName', row_data.ad_name,
        'programName', row_data.program_name,
        'validationStatus', row_data.validation_status,
        'validationErrors', to_jsonb(row_data.validation_errors),
        'duplicateKind', row_data.duplicate_kind,
        'duplicateContactId', row_data.duplicate_contact_id,
        'queueStatus', row_data.queue_status,
        'contactId', row_data.contact_id,
        'createdAt', row_data.created_at
      ) order by row_data.created_at desc, row_data.row_number)
      from (
        select *
        from sales_core.lead_import_rows row_record
        where row_record.tenant_id = v_tenant.id
        order by row_record.created_at desc, row_record.row_number
        limit 750
      ) row_data
      join sales_core.lead_import_batches batch
        on batch.id = row_data.batch_id
    ), '[]'::jsonb),
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', assignment.id,
        'batchId', assignment.batch_id,
        'rowId', assignment.import_row_id,
        'contactId', assignment.contact_id,
        'contactName', contact.full_name,
        'phone', contact.phone,
        'source', contact.source,
        'campaignName', contact.campaign_name,
        'adName', contact.ad_name,
        'leadStatus', contact.lead_status,
        'leadQuality', contact.lead_quality,
        'assignedStaffId', assignment.assigned_staff_id,
        'assignedStaffName', assignee.full_name,
        'assignedByName', assigner.full_name,
        'strategy', assignment.assignment_strategy,
        'status', assignment.status,
        'assignedAt', assignment.assigned_at,
        'deadlineAt', assignment.deadline_at,
        'firstActionAt', assignment.first_action_at,
        'overdue', (
          assignment.status = 'active'
          and assignment.first_action_at is null
          and assignment.deadline_at < now()
        ),
        'responseMinutes', case
          when assignment.first_action_at is null then null
          else round((
            extract(
              epoch from (
                assignment.first_action_at - assignment.assigned_at
              )
            ) / 60
          )::numeric, 1)
        end
      ) order by assignment.assigned_at desc)
      from (
        select *
        from sales_core.lead_assignments assignment_data
        where assignment_data.tenant_id = v_tenant.id
        order by assignment_data.assigned_at desc
        limit 500
      ) assignment
      join sales_core.contacts contact
        on contact.id = assignment.contact_id
      join people.staff_profiles assignee
        on assignee.id = assignment.assigned_staff_id
      left join people.staff_profiles assigner
        on assigner.id = assignment.assigned_by_staff_id
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', staff.id,
        'name', staff.full_name,
        'jobTitle', staff.job_title,
        'roleKey', staff.role_key,
        'salesChannel', coalesce(profile.sales_channel, 'online'),
        'eligible', coalesce(profile.eligible_for_leads, false),
        'dailyCapacity', coalesce(profile.daily_capacity, 50),
        'weight', coalesce(profile.weight, 1),
        'lastAssignedAt', profile.last_assigned_at,
        'activeAssignments', (
          select count(*)
          from sales_core.lead_assignments active_assignment
          where active_assignment.assigned_staff_id = staff.id
            and active_assignment.status = 'active'
            and active_assignment.first_action_at is null
        ),
        'overdueAssignments', (
          select count(*)
          from sales_core.lead_assignments overdue_assignment
          where overdue_assignment.assigned_staff_id = staff.id
            and overdue_assignment.status = 'active'
            and overdue_assignment.first_action_at is null
            and overdue_assignment.deadline_at < now()
        )
      ) order by staff.full_name)
      from people.staff_profiles staff
      left join sales_core.sales_assignment_profiles profile
        on profile.staff_id = staff.id
       and profile.tenant_id = staff.tenant_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
    ), '[]'::jsonb),
    'campaigns', case
      when v_can_analytics then coalesce((
        select jsonb_agg(jsonb_build_object(
          'source', campaign.source,
          'campaignName', campaign.campaign_name,
          'adSetName', campaign.ad_set_name,
          'adName', campaign.ad_name,
          'totalRows', campaign.total_rows,
          'validRows', campaign.valid_rows,
          'duplicateRows', campaign.duplicate_rows,
          'invalidRows', campaign.invalid_rows,
          'distributedRows', campaign.distributed_rows,
          'contactedRows', campaign.contacted_rows,
          'qualifiedRows', campaign.qualified_rows,
          'paidRows', campaign.paid_rows,
          'wrongNumberRows', campaign.wrong_number_rows,
          'badDataRate', campaign.bad_data_rate,
          'qualificationRate', campaign.qualification_rate,
          'conversionRate', campaign.conversion_rate,
          'averageFirstResponseMinutes',
            campaign.average_first_response_minutes
        ) order by campaign.total_rows desc, campaign.source)
        from (
          select
            coalesce(nullif(trim(row_data.source), ''), 'غير محدد')
              as source,
            coalesce(
              nullif(trim(row_data.campaign_name), ''),
              'بدون حملة'
            ) as campaign_name,
            coalesce(
              nullif(trim(row_data.ad_set_name), ''),
              'بدون مجموعة'
            ) as ad_set_name,
            coalesce(
              nullif(trim(row_data.ad_name), ''),
              'بدون إعلان'
            ) as ad_name,
            count(*) as total_rows,
            count(*) filter (
              where row_data.validation_status = 'valid'
            ) as valid_rows,
            count(*) filter (
              where row_data.validation_status = 'duplicate'
            ) as duplicate_rows,
            count(*) filter (
              where row_data.validation_status = 'invalid'
            ) as invalid_rows,
            count(assignment.id) as distributed_rows,
            count(assignment.id) filter (
              where assignment.first_action_at is not null
            ) as contacted_rows,
            count(contact.id) filter (
              where contact.lead_status in (
                'interested',
                'very_interested',
                'awaiting_payment',
                'payment_submitted',
                'paid'
              )
            ) as qualified_rows,
            count(contact.id) filter (
              where contact.lead_status = 'paid'
            ) as paid_rows,
            count(contact.id) filter (
              where contact.lead_status = 'wrong_number'
            ) as wrong_number_rows,
            round(
              (
                (
                  count(*) filter (
                    where row_data.validation_status in (
                      'duplicate',
                      'invalid'
                    )
                  )
                  + count(contact.id) filter (
                    where contact.lead_status = 'wrong_number'
                  )
                )::numeric
                / nullif(count(*), 0)
              ) * 100,
              1
            ) as bad_data_rate,
            round(
              (
                count(contact.id) filter (
                  where contact.lead_status in (
                    'interested',
                    'very_interested',
                    'awaiting_payment',
                    'payment_submitted',
                    'paid'
                  )
                )::numeric
                / nullif(count(assignment.id), 0)
              ) * 100,
              1
            ) as qualification_rate,
            round(
              (
                count(contact.id) filter (
                  where contact.lead_status = 'paid'
                )::numeric
                / nullif(count(assignment.id), 0)
              ) * 100,
              1
            ) as conversion_rate,
            round((
              avg(
                extract(
                  epoch from (
                    assignment.first_action_at - assignment.assigned_at
                  )
                ) / 60
              ) filter (
                where assignment.first_action_at is not null
              )
            )::numeric, 1) as average_first_response_minutes
          from sales_core.lead_import_rows row_data
          left join sales_core.lead_assignments assignment
            on assignment.import_row_id = row_data.id
           and assignment.status in ('active', 'completed')
          left join sales_core.contacts contact
            on contact.id = assignment.contact_id
          where row_data.tenant_id = v_tenant.id
          group by
            coalesce(nullif(trim(row_data.source), ''), 'غير محدد'),
            coalesce(
              nullif(trim(row_data.campaign_name), ''),
              'بدون حملة'
            ),
            coalesce(
              nullif(trim(row_data.ad_set_name), ''),
              'بدون مجموعة'
            ),
            coalesce(
              nullif(trim(row_data.ad_name), ''),
              'بدون إعلان'
            )
        ) campaign
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
end;
$$;

create or replace function public.v2_tenant_lead_intake_action(
  p_tenant_slug text,
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
  v_current_staff_id uuid;
  v_batch sales_core.lead_import_batches%rowtype;
  v_row jsonb;
  v_import_row sales_core.lead_import_rows%rowtype;
  v_row_number integer := 0;
  v_total integer := 0;
  v_valid integer := 0;
  v_duplicate integer := 0;
  v_invalid integer := 0;
  v_distributed integer := 0;
  v_name text;
  v_phone text;
  v_whatsapp text;
  v_normalized_phone text;
  v_normalized_whatsapp text;
  v_email text;
  v_source text;
  v_campaign_name text;
  v_ad_set_name text;
  v_ad_name text;
  v_program_name text;
  v_validation_status text;
  v_validation_errors text[];
  v_duplicate_kind text;
  v_duplicate_contact_id uuid;
  v_batch_id uuid;
  v_deadline_at timestamptz;
  v_strategy text;
  v_staff_ids uuid[];
  v_row_ids uuid[];
  v_assignee_id uuid;
  v_contact_id uuid;
  v_opportunity_id uuid;
  v_task_id uuid;
  v_assignment_id uuid;
  v_stage_id uuid;
  v_course_id uuid;
  v_candidate_count integer;
  v_sales_channel text;
  v_daily_capacity integer;
  v_weight integer;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;

  v_current_staff_id := private_app.current_staff_id(v_tenant.id);

  if p_action = 'import' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.import'
    ) then
      raise exception 'forbidden';
    end if;
    if jsonb_typeof(p_payload -> 'rows') <> 'array'
       or jsonb_array_length(p_payload -> 'rows') = 0 then
      raise exception 'empty_lead_import';
    end if;
    if jsonb_array_length(p_payload -> 'rows') > 5000 then
      raise exception 'lead_import_too_large';
    end if;

    v_source := coalesce(
      nullif(trim(p_payload ->> 'source'), ''),
      'sheet_import'
    );
    v_campaign_name := nullif(
      trim(p_payload ->> 'campaignName'),
      ''
    );
    v_ad_set_name := nullif(trim(p_payload ->> 'adSetName'), '');
    v_ad_name := nullif(trim(p_payload ->> 'adName'), '');

    insert into sales_core.lead_import_batches (
      tenant_id,
      batch_key,
      file_name,
      source,
      campaign_name,
      ad_set_name,
      ad_name,
      imported_by_subject_id,
      imported_by_staff_id,
      status
    )
    values (
      v_tenant.id,
      'lead-batch-' || gen_random_uuid()::text,
      coalesce(
        nullif(trim(p_payload ->> 'fileName'), ''),
        'leads.xlsx'
      ),
      v_source,
      v_campaign_name,
      v_ad_set_name,
      v_ad_name,
      private_app.current_subject_id(),
      v_current_staff_id,
      'ready'
    )
    returning * into v_batch;

    for v_row in
      select value
      from jsonb_array_elements(p_payload -> 'rows')
    loop
      v_row_number := v_row_number + 1;
      v_total := v_total + 1;
      v_name := nullif(trim(coalesce(v_row ->> 'name', '')), '');
      v_phone := nullif(trim(coalesce(v_row ->> 'phone', '')), '');
      v_whatsapp := nullif(
        trim(coalesce(v_row ->> 'whatsapp', '')),
        ''
      );
      v_normalized_phone := private_app.normalize_lead_phone(v_phone);
      v_normalized_whatsapp := private_app.normalize_lead_phone(
        v_whatsapp
      );
      v_email := nullif(
        lower(trim(coalesce(v_row ->> 'email', ''))),
        ''
      );
      v_source := coalesce(
        nullif(trim(v_row ->> 'source'), ''),
        v_batch.source
      );
      v_campaign_name := coalesce(
        nullif(trim(v_row ->> 'campaignName'), ''),
        v_batch.campaign_name
      );
      v_ad_set_name := coalesce(
        nullif(trim(v_row ->> 'adSetName'), ''),
        v_batch.ad_set_name
      );
      v_ad_name := coalesce(
        nullif(trim(v_row ->> 'adName'), ''),
        v_batch.ad_name
      );
      v_program_name := nullif(trim(v_row ->> 'program'), '');
      v_validation_status := 'valid';
      v_validation_errors := '{}'::text[];
      v_duplicate_kind := null;
      v_duplicate_contact_id := null;

      if v_name is null or length(v_name) < 2 then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'الاسم مطلوب'
        );
      end if;
      if v_normalized_phone is null
         and v_normalized_whatsapp is null then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'رقم الجوال أو واتساب غير صالح'
        );
      end if;
      if v_email is not null
         and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        v_validation_status := 'invalid';
        v_validation_errors := array_append(
          v_validation_errors,
          'البريد الإلكتروني غير صالح'
        );
      end if;

      if v_validation_status = 'valid'
         and exists (
           select 1
           from sales_core.lead_import_rows previous_row
           where previous_row.batch_id = v_batch.id
             and (
               (
                 v_normalized_phone is not null
                 and previous_row.normalized_phone = v_normalized_phone
               )
               or (
                 v_normalized_whatsapp is not null
                 and previous_row.normalized_whatsapp =
                   v_normalized_whatsapp
               )
               or (
                 v_email is not null
                 and lower(previous_row.email) = v_email
               )
             )
         ) then
        v_validation_status := 'duplicate';
        v_duplicate_kind := 'same_file';
        v_validation_errors := array_append(
          v_validation_errors,
          'مكرر داخل نفس الملف'
        );
      end if;

      if v_validation_status = 'valid' then
        select contact.id
        into v_duplicate_contact_id
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and (
            (
              v_normalized_phone is not null
              and (
                private_app.normalize_lead_phone(contact.phone) =
                  v_normalized_phone
                or private_app.normalize_lead_phone(contact.whatsapp) =
                  v_normalized_phone
              )
            )
            or (
              v_normalized_whatsapp is not null
              and (
                private_app.normalize_lead_phone(contact.phone) =
                  v_normalized_whatsapp
                or private_app.normalize_lead_phone(contact.whatsapp) =
                  v_normalized_whatsapp
              )
            )
            or (
              v_email is not null
              and lower(contact.email) = v_email
            )
          )
        order by contact.created_at
        limit 1;

        if v_duplicate_contact_id is not null then
          v_validation_status := 'duplicate';
          v_duplicate_kind := 'existing_contact';
          v_validation_errors := array_append(
            v_validation_errors,
            'العميل موجود مسبقًا في CRM'
          );
        end if;
      end if;

      insert into sales_core.lead_import_rows (
        tenant_id,
        batch_id,
        row_number,
        full_name,
        organization_name,
        phone,
        normalized_phone,
        whatsapp,
        normalized_whatsapp,
        email,
        source,
        campaign_name,
        ad_set_name,
        ad_name,
        program_name,
        notes,
        validation_status,
        validation_errors,
        duplicate_kind,
        duplicate_contact_id,
        queue_status,
        raw_data
      )
      values (
        v_tenant.id,
        v_batch.id,
        v_row_number,
        v_name,
        nullif(trim(v_row ->> 'organization'), ''),
        v_phone,
        v_normalized_phone,
        v_whatsapp,
        v_normalized_whatsapp,
        v_email,
        v_source,
        v_campaign_name,
        v_ad_set_name,
        v_ad_name,
        v_program_name,
        nullif(trim(v_row ->> 'notes'), ''),
        v_validation_status,
        v_validation_errors,
        v_duplicate_kind,
        v_duplicate_contact_id,
        case
          when v_validation_status = 'valid'
            then 'awaiting_distribution'
          else 'skipped'
        end,
        v_row
      );

      if v_validation_status = 'valid' then
        v_valid := v_valid + 1;
      elsif v_validation_status = 'duplicate' then
        v_duplicate := v_duplicate + 1;
      else
        v_invalid := v_invalid + 1;
      end if;
    end loop;

    update sales_core.lead_import_batches
    set total_rows = v_total,
        valid_rows = v_valid,
        duplicate_rows = v_duplicate,
        invalid_rows = v_invalid
    where id = v_batch.id;

    perform private_app.write_audit(
      'tenant.lead_batch_imported',
      'lead_import_batch',
      v_batch.id::text,
      v_tenant.id,
      jsonb_build_object(
        'fileName', v_batch.file_name,
        'totalRows', v_total,
        'validRows', v_valid,
        'duplicateRows', v_duplicate,
        'invalidRows', v_invalid,
        'source', v_batch.source,
        'campaignName', v_batch.campaign_name
      )
    );

    return jsonb_build_object(
      'batchId', v_batch.id,
      'totalRows', v_total,
      'validRows', v_valid,
      'duplicateRows', v_duplicate,
      'invalidRows', v_invalid
    );
  end if;

  if p_action = 'save_profile' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.distribute'
    ) then
      raise exception 'forbidden';
    end if;

    v_assignee_id := (p_payload ->> 'staffId')::uuid;
    v_sales_channel := coalesce(
      nullif(trim(p_payload ->> 'salesChannel'), ''),
      'online'
    );
    v_daily_capacity := coalesce(
      (p_payload ->> 'dailyCapacity')::integer,
      50
    );
    v_weight := coalesce((p_payload ->> 'weight')::integer, 1);

    if v_sales_channel not in ('online', 'field', 'hybrid') then
      raise exception 'invalid_sales_channel';
    end if;
    if v_daily_capacity not between 1 and 1000 then
      raise exception 'invalid_daily_capacity';
    end if;
    if v_weight not between 1 and 10 then
      raise exception 'invalid_distribution_weight';
    end if;
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

    insert into sales_core.sales_assignment_profiles (
      tenant_id,
      staff_id,
      sales_channel,
      eligible_for_leads,
      daily_capacity,
      weight,
      updated_by_subject_id
    )
    values (
      v_tenant.id,
      v_assignee_id,
      v_sales_channel,
      coalesce((p_payload ->> 'eligible')::boolean, true),
      v_daily_capacity,
      v_weight,
      private_app.current_subject_id()
    )
    on conflict (tenant_id, staff_id) do update
    set sales_channel = excluded.sales_channel,
        eligible_for_leads = excluded.eligible_for_leads,
        daily_capacity = excluded.daily_capacity,
        weight = excluded.weight,
        updated_by_subject_id = excluded.updated_by_subject_id;

    return jsonb_build_object(
      'staffId', v_assignee_id,
      'saved', true
    );
  end if;

  if p_action = 'cancel_batch' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.import'
    ) then
      raise exception 'forbidden';
    end if;
    v_batch_id := (p_payload ->> 'batchId')::uuid;

    select batch.*
    into v_batch
    from sales_core.lead_import_batches batch
    where batch.id = v_batch_id
      and batch.tenant_id = v_tenant.id
    for update;

    if v_batch.id is null then
      raise exception 'lead_batch_not_found';
    end if;
    if v_batch.distributed_rows > 0 then
      raise exception 'lead_batch_already_distributed';
    end if;

    update sales_core.lead_import_rows
    set queue_status = 'cancelled'
    where batch_id = v_batch.id
      and validation_status = 'valid'
      and queue_status = 'awaiting_distribution';

    update sales_core.lead_import_batches
    set status = 'cancelled'
    where id = v_batch.id;

    return jsonb_build_object('batchId', v_batch.id, 'cancelled', true);
  end if;

  if p_action = 'distribute' then
    if not private_app.has_tenant_permission(
      v_tenant.id,
      'tenant.leads.distribute'
    ) then
      raise exception 'forbidden';
    end if;

    v_batch_id := (p_payload ->> 'batchId')::uuid;
    v_strategy := coalesce(
      nullif(trim(p_payload ->> 'strategy'), ''),
      'fair'
    );
    v_deadline_at := (p_payload ->> 'deadlineAt')::timestamptz;

    if v_strategy not in ('fair', 'online_only', 'selected') then
      raise exception 'invalid_distribution_strategy';
    end if;
    if v_deadline_at is null or v_deadline_at <= now() then
      raise exception 'invalid_distribution_deadline';
    end if;
    if v_deadline_at > now() + interval '90 days' then
      raise exception 'distribution_deadline_too_far';
    end if;

    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into v_staff_ids
    from jsonb_array_elements_text(
      coalesce(p_payload -> 'staffIds', '[]'::jsonb)
    );

    select coalesce(array_agg(value::uuid), '{}'::uuid[])
    into v_row_ids
    from jsonb_array_elements_text(
      coalesce(p_payload -> 'rowIds', '[]'::jsonb)
    );

    if v_strategy = 'selected'
       and cardinality(v_staff_ids) = 0 then
      raise exception 'distribution_staff_required';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_tenant.id::text, 1729)
    );

    select batch.*
    into v_batch
    from sales_core.lead_import_batches batch
    where batch.id = v_batch_id
      and batch.tenant_id = v_tenant.id
      and batch.status in ('ready', 'partially_distributed')
    for update;

    if v_batch.id is null then
      raise exception 'lead_batch_not_ready';
    end if;

    select count(*)
    into v_candidate_count
    from people.staff_profiles staff
    left join sales_core.sales_assignment_profiles profile
      on profile.staff_id = staff.id
     and profile.tenant_id = staff.tenant_id
    where staff.tenant_id = v_tenant.id
      and staff.employment_status = 'active'
      and staff.role_key in (
        'sales_user',
        'sales_supervisor',
        'sales_manager'
      )
      and (
        (
          v_strategy = 'selected'
          and staff.id = any(v_staff_ids)
        )
        or (
          v_strategy = 'fair'
          and coalesce(profile.eligible_for_leads, false)
        )
        or (
          v_strategy = 'online_only'
          and coalesce(profile.eligible_for_leads, false)
          and coalesce(profile.sales_channel, 'online') in (
            'online',
            'hybrid'
          )
        )
      );

    if v_candidate_count = 0 then
      if v_strategy = 'online_only' then
        raise exception 'no_online_sales_team';
      end if;
      raise exception 'no_sales_team';
    end if;

    select stage.id
    into v_stage_id
    from sales_core.pipeline_stages stage
    where stage.tenant_id = v_tenant.id
      and stage.stage_key = 'new_lead'
    limit 1;

    if v_stage_id is null then
      raise exception 'invalid_stage';
    end if;

    for v_import_row in
      select row_data.*
      from sales_core.lead_import_rows row_data
      where row_data.batch_id = v_batch.id
        and row_data.tenant_id = v_tenant.id
        and row_data.validation_status = 'valid'
        and row_data.queue_status = 'awaiting_distribution'
        and (
          cardinality(v_row_ids) = 0
          or row_data.id = any(v_row_ids)
        )
      order by row_data.row_number
      for update skip locked
    loop
      select staff.id
      into v_assignee_id
      from people.staff_profiles staff
      left join sales_core.sales_assignment_profiles profile
        on profile.staff_id = staff.id
       and profile.tenant_id = staff.tenant_id
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
        and (
          (
            v_strategy = 'selected'
            and staff.id = any(v_staff_ids)
          )
          or (
            v_strategy = 'fair'
            and coalesce(profile.eligible_for_leads, false)
          )
          or (
            v_strategy = 'online_only'
            and coalesce(profile.eligible_for_leads, false)
            and coalesce(profile.sales_channel, 'online') in (
              'online',
              'hybrid'
            )
          )
        )
        and (
          select count(*)
          from sales_core.lead_assignments today_assignment
          where today_assignment.assigned_staff_id = staff.id
            and (
              today_assignment.assigned_at
              at time zone v_tenant.timezone
            )::date = (
              now() at time zone v_tenant.timezone
            )::date
        ) < coalesce(profile.daily_capacity, 50)
      order by
        (
          (
            select count(*)
            from sales_core.lead_assignments active_assignment
            where active_assignment.assigned_staff_id = staff.id
              and active_assignment.status = 'active'
              and active_assignment.first_action_at is null
          )::numeric
          / greatest(coalesce(profile.weight, 1), 1)
        ),
        profile.last_assigned_at nulls first,
        staff.id
      limit 1;

      if v_assignee_id is null then
        exit;
      end if;

      v_course_id := null;
      if v_import_row.program_name is not null then
        select course.id
        into v_course_id
        from academy.courses course
        where course.tenant_id = v_tenant.id
          and course.status = 'active'
          and (
            lower(course.course_code) =
              lower(v_import_row.program_name)
            or lower(course.title_ar) =
              lower(v_import_row.program_name)
            or lower(coalesce(course.title_en, '')) =
              lower(v_import_row.program_name)
          )
        order by course.created_at
        limit 1;
      end if;

      insert into sales_core.contacts (
        tenant_id,
        contact_key,
        full_name,
        organization_name,
        phone,
        whatsapp,
        email,
        source,
        status,
        owner_staff_id,
        interest_course_id,
        notes,
        created_by_subject_id,
        metadata,
        lead_status,
        lead_quality,
        next_action_type,
        next_action_at,
        campaign_name,
        ad_name
      )
      values (
        v_tenant.id,
        'lead-import-' || v_import_row.id::text,
        v_import_row.full_name,
        v_import_row.organization_name,
        v_import_row.phone,
        v_import_row.whatsapp,
        v_import_row.email,
        v_import_row.source,
        'new',
        v_assignee_id,
        v_course_id,
        v_import_row.notes,
        private_app.current_subject_id(),
        jsonb_strip_nulls(jsonb_build_object(
          'model', 'lead_intake_v2',
          'importBatchId', v_batch.id,
          'importRowId', v_import_row.id,
          'normalizedPhone', v_import_row.normalized_phone,
          'normalizedWhatsapp', v_import_row.normalized_whatsapp,
          'programName', v_import_row.program_name,
          'adSetName', v_import_row.ad_set_name
        )),
        'new',
        'unrated',
        'call',
        v_deadline_at,
        v_import_row.campaign_name,
        v_import_row.ad_name
      )
      returning id into v_contact_id;

      insert into sales_core.opportunities (
        tenant_id,
        opportunity_key,
        contact_id,
        course_id,
        stage_id,
        owner_staff_id,
        title,
        value_minor,
        next_action_type,
        next_action_at,
        status,
        created_by_subject_id,
        metadata
      )
      values (
        v_tenant.id,
        'lead-import-' || v_import_row.id::text,
        v_contact_id,
        v_course_id,
        v_stage_id,
        v_assignee_id,
        case
          when v_import_row.program_name is null
            then 'متابعة ' || v_import_row.full_name
          else
            'متابعة ' || v_import_row.full_name
            || ' — ' || v_import_row.program_name
        end,
        0,
        'call',
        v_deadline_at,
        'open',
        private_app.current_subject_id(),
        jsonb_build_object(
          'model', 'lead_intake_v2',
          'importBatchId', v_batch.id,
          'importRowId', v_import_row.id
        )
      )
      returning id into v_opportunity_id;

      insert into sales_core.lead_assignments (
        tenant_id,
        batch_id,
        import_row_id,
        contact_id,
        opportunity_id,
        assigned_staff_id,
        assigned_by_staff_id,
        assigned_by_subject_id,
        assignment_strategy,
        deadline_at,
        metadata
      )
      values (
        v_tenant.id,
        v_batch.id,
        v_import_row.id,
        v_contact_id,
        v_opportunity_id,
        v_assignee_id,
        v_current_staff_id,
        private_app.current_subject_id(),
        v_strategy,
        v_deadline_at,
        jsonb_build_object(
          'source', 'lead_queue',
          'campaignName', v_import_row.campaign_name,
          'adSetName', v_import_row.ad_set_name,
          'adName', v_import_row.ad_name
        )
      )
      returning id into v_assignment_id;

      insert into work_core.tasks (
        tenant_id,
        task_key,
        title,
        description,
        priority,
        status,
        assigned_staff_id,
        created_by_subject_id,
        contact_id,
        opportunity_id,
        starts_at,
        due_at,
        metadata
      )
      values (
        v_tenant.id,
        'lead-assignment-' || v_assignment_id::text,
        'متابعة العميل: ' || v_import_row.full_name,
        concat_ws(
          ' — ',
          nullif(v_import_row.program_name, ''),
          case
            when v_import_row.campaign_name is not null
              then 'الحملة: ' || v_import_row.campaign_name
          end,
          case
            when v_import_row.ad_name is not null
              then 'الإعلان: ' || v_import_row.ad_name
          end
        ),
        'high',
        'todo',
        v_assignee_id,
        private_app.current_subject_id(),
        v_contact_id,
        v_opportunity_id,
        now(),
        v_deadline_at,
        jsonb_build_object(
          'source', 'lead_assignment',
          'assignmentId', v_assignment_id,
          'batchId', v_batch.id,
          'rowId', v_import_row.id,
          'deadlineType', 'first_action'
        )
      )
      returning id into v_task_id;

      update sales_core.lead_assignments
      set task_id = v_task_id
      where id = v_assignment_id;

      update sales_core.lead_import_rows
      set queue_status = 'assigned',
          contact_id = v_contact_id
      where id = v_import_row.id;

      insert into sales_core.sales_assignment_profiles (
        tenant_id,
        staff_id,
        sales_channel,
        eligible_for_leads,
        daily_capacity,
        last_assigned_at,
        updated_by_subject_id
      )
      values (
        v_tenant.id,
        v_assignee_id,
        'online',
        true,
        50,
        now(),
        private_app.current_subject_id()
      )
      on conflict (tenant_id, staff_id) do update
      set last_assigned_at = excluded.last_assigned_at;

      v_distributed := v_distributed + 1;
    end loop;

    update sales_core.lead_import_batches batch
    set distributed_rows = (
          select count(*)
          from sales_core.lead_import_rows row_data
          where row_data.batch_id = batch.id
            and row_data.queue_status = 'assigned'
        ),
        last_distributed_by_staff_id = v_current_staff_id,
        last_distribution_strategy = v_strategy,
        last_deadline_at = v_deadline_at,
        distributed_at = case
          when v_distributed > 0 then now()
          else batch.distributed_at
        end,
        status = case
          when exists (
            select 1
            from sales_core.lead_import_rows remaining_row
            where remaining_row.batch_id = batch.id
              and remaining_row.validation_status = 'valid'
              and remaining_row.queue_status =
                'awaiting_distribution'
          ) then 'partially_distributed'
          else 'distributed'
        end
    where batch.id = v_batch.id;

    perform private_app.write_audit(
      'tenant.leads_distributed',
      'lead_import_batch',
      v_batch.id::text,
      v_tenant.id,
      jsonb_build_object(
        'distributed', v_distributed,
        'strategy', v_strategy,
        'deadlineAt', v_deadline_at,
        'candidateCount', v_candidate_count
      )
    );

    return jsonb_build_object(
      'batchId', v_batch.id,
      'distributed', v_distributed,
      'strategy', v_strategy,
      'deadlineAt', v_deadline_at,
      'teamSize', v_candidate_count
    );
  end if;

  raise exception 'invalid_lead_intake_action';
end;
$$;

revoke execute on function public.v2_tenant_lead_intake_snapshot(text)
from public, anon;
revoke execute on function public.v2_tenant_lead_intake_action(
  text,
  text,
  jsonb
) from public, anon;

grant execute on function public.v2_tenant_lead_intake_snapshot(text)
to authenticated;
grant execute on function public.v2_tenant_lead_intake_action(
  text,
  text,
  jsonb
) to authenticated;

comment on table sales_core.lead_import_batches is
'Tenant-scoped spreadsheet imports with source and campaign attribution.';
comment on table sales_core.lead_import_rows is
'Validated lead intake queue before a row becomes a CRM contact.';
comment on table sales_core.sales_assignment_profiles is
'Sales availability, channel, capacity, and distribution weight.';
comment on table sales_core.lead_assignments is
'Auditable lead assignment history and first-response SLA evidence.';
comment on function public.v2_tenant_lead_intake_action(
  text,
  text,
  jsonb
) is
'Imports validated lead batches and distributes ready rows atomically.';

commit;
