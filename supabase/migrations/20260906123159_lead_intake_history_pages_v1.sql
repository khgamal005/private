-- Additive read API only. No customer, import, assignment, task or audit rows are changed.
-- Deploy the migration before the web release. Rolling back the web release is sufficient.
set lock_timeout = '2s';
set statement_timeout = '60s';

create index if not exists lead_assignments_tenant_history_page_idx
  on sales_core.lead_assignments (tenant_id, assigned_at desc, id desc);
create index if not exists lead_import_rows_tenant_history_page_idx
  on sales_core.lead_import_rows (tenant_id, created_at desc, id desc);
create index if not exists lead_batches_tenant_history_page_idx
  on sales_core.lead_import_batches (tenant_id, created_at desc, id desc);
create index if not exists lead_assignments_import_row_history_idx
  on sales_core.lead_assignments (tenant_id, import_row_id, (status = 'active') desc, assigned_at desc, id desc)
  where import_row_id is not null;

create or replace function public.v1_tenant_lead_intake_page(
  p_slug text,
  p_section text default 'queue',
  p_from date default null,
  p_to date default null,
  p_query text default null,
  p_quality text default null,
  p_source text default null,
  p_campaign text default null,
  p_batch_id uuid default null,
  p_validation text default null,
  p_limit integer default 100,
  p_anchor timestamptz default null,
  p_after_at timestamptz default null,
  p_after_id uuid default null,
  p_include_total boolean default true
) returns jsonb
language plpgsql stable security definer
set search_path = ''
set statement_timeout = '6s'
as $$
declare
  v_tenant_id uuid;
  v_timezone text;
  v_from_at timestamptz;
  v_to_at timestamptz;
  v_anchor timestamptz := coalesce(p_anchor, now());
  v_query text := nullif(lower(trim(p_query)), '');
  v_phone text := regexp_replace(translate(coalesce(p_query, ''),
    '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g');
  v_quality text := nullif(trim(p_quality), '');
  v_source text := nullif(trim(p_source), '');
  v_campaign text := nullif(trim(p_campaign), '');
  v_limit integer := coalesce(p_limit, 100);
  v_records jsonb;
  v_total bigint;
  v_has_more boolean;
  v_last jsonb;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;
  select tenant.id, coalesce(nullif(tenant.timezone, ''), 'UTC')
    into v_tenant_id, v_timezone
  from core.tenants tenant where tenant.slug = p_slug;
  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not coalesce(private_app.has_tenant_permission(v_tenant_id, 'tenant.leads.read'), false)
    then raise exception 'forbidden'; end if;
  if p_section is null or p_section not in ('queue', 'assignments', 'batches')
    or v_limit < 1 or v_limit > 100
    or (p_from is not null and p_to is not null and p_from > p_to)
    or length(coalesce(p_query, '')) > 100
    or length(coalesce(p_quality, '')) > 64
    or length(coalesce(p_source, '')) > 200
    or length(coalesce(p_campaign, '')) > 500
    or (p_after_at is null) <> (p_after_id is null)
    or (p_after_id is not null and p_anchor is null)
    or v_anchor > now() + interval '5 minutes'
    or (p_validation is not null and p_validation not in ('awaiting', 'valid', 'duplicate', 'invalid'))
    or (p_section <> 'queue' and (p_batch_id is not null or p_validation is not null))
    then raise exception 'invalid_page_request'; end if;
  v_from_at := p_from::timestamp at time zone v_timezone;
  v_to_at := (p_to + 1)::timestamp at time zone v_timezone;

  if p_section = 'assignments' then
    with filtered as not materialized (
      select a.id, a.assigned_at as sort_at
      from sales_core.lead_assignments a
      join sales_core.contacts c on c.id = a.contact_id and c.tenant_id = a.tenant_id
      join people.staff_profiles owner on owner.id = a.assigned_staff_id and owner.tenant_id = a.tenant_id
      left join sales_core.lead_import_rows r on r.id = a.import_row_id and r.tenant_id = a.tenant_id
      where a.tenant_id = v_tenant_id
        and a.created_at <= v_anchor and a.assigned_at <= v_anchor
        and (v_from_at is null or a.assigned_at >= v_from_at)
        and (v_to_at is null or a.assigned_at < v_to_at)
        and (v_quality is null or c.lead_quality = v_quality or c.lead_status = v_quality)
        and (v_source is null or coalesce(r.source, c.source) = v_source)
        and (v_campaign is null or coalesce(r.campaign_name, c.campaign_name) = v_campaign)
        and (v_query is null or position(v_query in lower(coalesce(c.full_name, ''))) > 0
          or (v_phone <> '' and position(v_phone in regexp_replace(coalesce(c.phone, c.whatsapp, ''), '[^0-9]', '', 'g')) > 0))
    ), page as (
      select * from filtered
      where p_after_id is null or (sort_at, id) < (p_after_at, p_after_id)
      order by sort_at desc, id desc limit v_limit + 1
    )
    select case when coalesce(p_include_total, true) then (select count(*) from filtered) else null end,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'batchId', a.batch_id, 'rowId', a.import_row_id,
        'contactId', a.contact_id, 'contactName', c.full_name, 'phone', c.phone,
        'source', coalesce(r.source, c.source), 'campaignName', coalesce(r.campaign_name, c.campaign_name),
        'adName', coalesce(r.ad_name, c.ad_name), 'leadStatus', c.lead_status, 'leadQuality', c.lead_quality,
        'assignedStaffId', a.assigned_staff_id, 'assignedStaffName', owner.full_name,
        'assignedByName', assigner.full_name, 'strategy', a.assignment_strategy,
        'status', a.status, 'assignedAt', a.assigned_at, 'deadlineAt', a.deadline_at,
        'firstActionAt', a.first_action_at,
        'previousStaffName', a.metadata ->> 'previousStaffName',
        'reassignmentReason', a.metadata ->> 'reassignmentReason',
        'overdue', a.status = 'active' and a.first_action_at is null and a.deadline_at < now(),
        'responseMinutes', case when a.first_action_at is null then null else
          round((extract(epoch from (a.first_action_at - a.assigned_at)) / 60)::numeric, 1) end
      ) order by page.sort_at desc, page.id desc)
      from page
      join sales_core.lead_assignments a on a.id = page.id and a.tenant_id = v_tenant_id
      join sales_core.contacts c on c.id = a.contact_id and c.tenant_id = v_tenant_id
      join people.staff_profiles owner on owner.id = a.assigned_staff_id and owner.tenant_id = v_tenant_id
      left join people.staff_profiles assigner on assigner.id = a.assigned_by_staff_id and assigner.tenant_id = v_tenant_id
      left join sales_core.lead_import_rows r on r.id = a.import_row_id and r.tenant_id = v_tenant_id), '[]'::jsonb)
    into v_total, v_records;

  elsif p_section = 'queue' then
    with latest as materialized (
      select distinct on (a.import_row_id) a.import_row_id,
        c.lead_quality, c.lead_status, a.assigned_at, a.first_action_at
      from sales_core.lead_assignments a
      join sales_core.contacts c on c.id = a.contact_id and c.tenant_id = a.tenant_id
      where a.tenant_id = v_tenant_id and a.import_row_id is not null and a.created_at <= v_anchor
        and (v_quality is not null or v_from_at is not null or v_to_at is not null)
      order by a.import_row_id, (a.status = 'active') desc, a.assigned_at desc, a.id desc
    ), filtered as not materialized (
      select r.id, r.created_at as sort_at
      from sales_core.lead_import_rows r
      join sales_core.lead_import_batches b on b.id = r.batch_id and b.tenant_id = r.tenant_id
      left join latest on latest.import_row_id = r.id
      where r.tenant_id = v_tenant_id and r.created_at <= v_anchor
        and (p_batch_id is null or r.batch_id = p_batch_id)
        and (p_validation is null
          or (p_validation = 'awaiting' and r.queue_status = 'awaiting_distribution')
          or r.validation_status = p_validation)
        and (v_source is null or r.source = v_source)
        and (v_campaign is null or r.campaign_name = v_campaign)
        and (v_quality is null or coalesce(latest.lead_quality, 'unrated') = v_quality
          or latest.lead_status = v_quality)
        and ((v_from_at is null and v_to_at is null)
          or ((v_from_at is null or r.created_at >= v_from_at) and (v_to_at is null or r.created_at < v_to_at))
          or ((v_from_at is null or latest.assigned_at >= v_from_at) and (v_to_at is null or latest.assigned_at < v_to_at))
          or ((v_from_at is null or latest.first_action_at >= v_from_at) and (v_to_at is null or latest.first_action_at < v_to_at)))
        and (v_query is null or position(v_query in lower(concat_ws(' ', r.full_name,
          r.phone, r.whatsapp, r.email, r.program_name, r.source, r.campaign_name, r.ad_name, b.file_name))) > 0
          or (v_phone <> '' and (position(v_phone in coalesce(r.normalized_phone, '')) > 0
            or position(v_phone in coalesce(r.normalized_whatsapp, '')) > 0)))
    ), page as (
      select * from filtered
      where p_after_id is null or (sort_at, id) < (p_after_at, p_after_id)
      order by sort_at desc, id desc limit v_limit + 1
    )
    select case when coalesce(p_include_total, true) then (select count(*) from filtered) else null end,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'batchId', r.batch_id, 'batchFileName', b.file_name,
        'rowNumber', r.row_number, 'name', r.full_name, 'organizationName', r.organization_name,
        'phone', r.phone, 'whatsapp', r.whatsapp, 'email', r.email, 'source', r.source,
        'campaignName', r.campaign_name, 'adSetName', r.ad_set_name, 'adName', r.ad_name,
        'programName', r.program_name, 'validationStatus', r.validation_status,
        'validationErrors', to_jsonb(r.validation_errors), 'duplicateKind', r.duplicate_kind,
        'duplicateContactId', r.duplicate_contact_id, 'queueStatus', r.queue_status,
        'contactId', r.contact_id, 'createdAt', r.created_at
      ) order by page.sort_at desc, page.id desc)
      from page
      join sales_core.lead_import_rows r on r.id = page.id and r.tenant_id = v_tenant_id
      join sales_core.lead_import_batches b on b.id = r.batch_id and b.tenant_id = v_tenant_id), '[]'::jsonb)
    into v_total, v_records;

  elsif p_section = 'batches' then
    with latest as materialized (
      select distinct on (a.import_row_id) a.import_row_id, c.lead_quality, c.lead_status
      from sales_core.lead_assignments a
      join sales_core.contacts c on c.id = a.contact_id and c.tenant_id = a.tenant_id
      where a.tenant_id = v_tenant_id and a.import_row_id is not null
        and a.created_at <= v_anchor and v_quality is not null
      order by a.import_row_id, (a.status = 'active') desc, a.assigned_at desc, a.id desc
    ), filtered as not materialized (
      select b.id, b.created_at as sort_at
      from sales_core.lead_import_batches b
      where b.tenant_id = v_tenant_id and b.created_at <= v_anchor
        and (v_source is null or b.source = v_source)
        and (v_campaign is null or b.campaign_name = v_campaign)
        and ((v_from_at is null and v_to_at is null)
          or ((v_from_at is null or b.created_at >= v_from_at) and (v_to_at is null or b.created_at < v_to_at))
          or ((v_from_at is null or b.distributed_at >= v_from_at) and (v_to_at is null or b.distributed_at < v_to_at)))
        and (v_quality is null or exists (
          select 1 from sales_core.lead_import_rows r
          left join latest on latest.import_row_id = r.id
          where r.tenant_id = b.tenant_id and r.batch_id = b.id
            and (coalesce(latest.lead_quality, 'unrated') = v_quality or latest.lead_status = v_quality)
        ))
    ), page as (
      select * from filtered
      where p_after_id is null or (sort_at, id) < (p_after_at, p_after_id)
      order by sort_at desc, id desc limit v_limit + 1
    )
    select case when coalesce(p_include_total, true) then (select count(*) from filtered) else null end,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'key', b.batch_key, 'fileName', b.file_name,
        'source', b.source, 'campaignName', b.campaign_name, 'adSetName', b.ad_set_name,
        'adName', b.ad_name, 'status', b.status, 'totalRows', b.total_rows,
        'validRows', b.valid_rows, 'duplicateRows', b.duplicate_rows,
        'invalidRows', b.invalid_rows, 'distributedRows', b.distributed_rows,
        'awaitingRows', (select count(*) from sales_core.lead_import_rows waiting
          where waiting.tenant_id = v_tenant_id and waiting.batch_id = b.id
            and waiting.validation_status = 'valid' and waiting.queue_status = 'awaiting_distribution'),
        'importerName', importer.full_name, 'lastDistributorName', distributor.full_name,
        'lastStrategy', b.last_distribution_strategy, 'lastDeadlineAt', b.last_deadline_at,
        'distributedAt', b.distributed_at, 'createdAt', b.created_at
      ) order by page.sort_at desc, page.id desc)
      from page
      join sales_core.lead_import_batches b on b.id = page.id and b.tenant_id = v_tenant_id
      left join people.staff_profiles importer on importer.id = b.imported_by_staff_id and importer.tenant_id = v_tenant_id
      left join people.staff_profiles distributor on distributor.id = b.last_distributed_by_staff_id and distributor.tenant_id = v_tenant_id), '[]'::jsonb)
    into v_total, v_records;

  end if;
  v_has_more := jsonb_array_length(v_records) > v_limit;
  if v_has_more then v_records := v_records - v_limit; end if;
  v_last := v_records -> (jsonb_array_length(v_records) - 1);
  return jsonb_build_object(
    'schemaVersion', 'lead-intake-page-v1', 'section', p_section,
    'anchor', v_anchor, 'limit', v_limit, 'total', v_total,
    'records', v_records, 'hasMore', v_has_more,
    'nextCursor', case when v_has_more then jsonb_build_object(
      'id', v_last ->> 'id',
      'at', v_last ->> case when p_section = 'assignments' then 'assignedAt' else 'createdAt' end
    ) else null end
  );
end;
$$;

revoke all on function public.v1_tenant_lead_intake_page(text,text,date,date,text,text,text,text,uuid,text,integer,timestamptz,timestamptz,uuid,boolean)
  from public, anon;
grant execute on function public.v1_tenant_lead_intake_page(text,text,date,date,text,text,text,text,uuid,text,integer,timestamptz,timestamptz,uuid,boolean)
  to authenticated;
reset lock_timeout;
reset statement_timeout;
