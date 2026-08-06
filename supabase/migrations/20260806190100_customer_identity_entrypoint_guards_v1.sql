begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';
alter function public.v2_tenant_create_contact(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text
) rename to v2_tenant_create_contact_unhardened_20260806;

revoke all on function public.v2_tenant_create_contact_unhardened_20260806(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text
) from public, anon, authenticated;

create function public.v2_tenant_create_contact(
  p_tenant_slug text,
  p_full_name text,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_organization_name text default null,
  p_source text default 'manual',
  p_owner_staff_id uuid default null,
  p_interest_course_id uuid default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_existing_contact_id uuid;
  v_existing_name text;
  v_existing_owner_name text;
  v_phone text;
  v_whatsapp text;
  v_email text;
  v_result jsonb;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  v_phone := private_app.normalize_lead_phone(p_phone);
  v_whatsapp := private_app.normalize_lead_phone(p_whatsapp);
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');

  if nullif(trim(coalesce(p_phone, '')), '') is not null
     and v_phone is null then
    raise exception 'رقم الجوال غير صالح';
  end if;
  if nullif(trim(coalesce(p_whatsapp, '')), '') is not null
     and v_whatsapp is null then
    raise exception 'رقم واتساب غير صالح';
  end if;
  if v_email is not null
     and (
       length(v_email) > 320
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ) then
    raise exception 'البريد الإلكتروني غير صالح';
  end if;
  if v_phone is null and v_whatsapp is null and v_email is null then
    raise exception 'رقم جوال أو واتساب أو بريد إلكتروني مطلوب';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id::text, 1729)
  );

  v_existing_contact_id := private_app.find_contact_by_identity(
    v_tenant_id,
    v_phone,
    v_whatsapp,
    v_email
  );

  if v_existing_contact_id is not null then
    select contact.full_name, owner.full_name
    into v_existing_name, v_existing_owner_name
    from sales_core.contacts contact
    left join people.staff_profiles owner
      on owner.id = contact.owner_staff_id
    where contact.id = v_existing_contact_id;

    raise exception '%', format(
      'العميل %s موجود بالفعل ومسند إلى %s؛ لم يتم إنشاء سجل مكرر.',
      coalesce(v_existing_name, 'بنفس الرقم'),
      coalesce(v_existing_owner_name, 'مسؤول آخر')
    );
  end if;

  v_result := public.v2_tenant_create_contact_unhardened_20260806(
    p_tenant_slug,
    p_full_name,
    v_phone,
    v_whatsapp,
    v_email,
    p_organization_name,
    p_source,
    p_owner_staff_id,
    p_interest_course_id,
    p_notes
  );

  return v_result || jsonb_build_object(
    'created', true,
    'duplicate', false
  );
end;
$$;

revoke all on function public.v2_tenant_create_contact(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text
) from public, anon;
grant execute on function public.v2_tenant_create_contact(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text
) to authenticated;

alter function public.v2_tenant_create_sales_lead(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  text
) rename to v2_tenant_create_sales_lead_unhardened_20260806;

revoke all on function public.v2_tenant_create_sales_lead_unhardened_20260806(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  text
) from public, anon, authenticated;

create function public.v2_tenant_create_sales_lead(
  p_tenant_slug text,
  p_full_name text,
  p_phone text default null,
  p_whatsapp text default null,
  p_email text default null,
  p_organization_name text default null,
  p_source text default 'manual',
  p_campaign_name text default null,
  p_ad_name text default null,
  p_owner_staff_id uuid default null,
  p_interest_course_id uuid default null,
  p_lead_quality text default 'unrated',
  p_next_action_type text default 'call',
  p_next_action_at timestamptz default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_existing_contact_id uuid;
  v_existing_name text;
  v_existing_owner_name text;
  v_phone text;
  v_whatsapp text;
  v_email text;
  v_result jsonb;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.crm.write'
  ) then raise exception 'forbidden'; end if;

  v_phone := private_app.normalize_lead_phone(p_phone);
  v_whatsapp := private_app.normalize_lead_phone(p_whatsapp);
  v_email := nullif(lower(trim(coalesce(p_email, ''))), '');

  if nullif(trim(coalesce(p_phone, '')), '') is not null
     and v_phone is null then
    raise exception 'رقم الجوال غير صالح';
  end if;
  if nullif(trim(coalesce(p_whatsapp, '')), '') is not null
     and v_whatsapp is null then
    raise exception 'رقم واتساب غير صالح';
  end if;
  if v_email is not null
     and (
       length(v_email) > 320
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     ) then
    raise exception 'البريد الإلكتروني غير صالح';
  end if;
  if v_phone is null and v_whatsapp is null then
    raise exception 'phone_required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id::text, 1729)
  );

  v_existing_contact_id := private_app.find_contact_by_identity(
    v_tenant_id,
    v_phone,
    v_whatsapp,
    v_email
  );

  if v_existing_contact_id is not null then
    select contact.full_name, owner.full_name
    into v_existing_name, v_existing_owner_name
    from sales_core.contacts contact
    left join people.staff_profiles owner
      on owner.id = contact.owner_staff_id
    where contact.id = v_existing_contact_id;

    raise exception '%', format(
      'العميل %s موجود بالفعل ومسند إلى %s؛ لم يتم إنشاء سجل مكرر.',
      coalesce(v_existing_name, 'بنفس الرقم'),
      coalesce(v_existing_owner_name, 'مسؤول آخر')
    );
  end if;

  v_result := public.v2_tenant_create_sales_lead_unhardened_20260806(
    p_tenant_slug,
    p_full_name,
    v_phone,
    v_whatsapp,
    v_email,
    p_organization_name,
    p_source,
    p_campaign_name,
    p_ad_name,
    p_owner_staff_id,
    p_interest_course_id,
    p_lead_quality,
    p_next_action_type,
    p_next_action_at,
    p_notes
  );

  return v_result || jsonb_build_object(
    'created', true,
    'duplicate', false
  );
end;
$$;

revoke all on function public.v2_tenant_create_sales_lead(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  text
) from public, anon;
grant execute on function public.v2_tenant_create_sales_lead(
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  text,
  text,
  timestamptz,
  text
) to authenticated;

alter function public.v2_tenant_customer_search(
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  text,
  integer,
  integer
) rename to v2_tenant_customer_search_unhardened_20260806;

revoke all on function public.v2_tenant_customer_search_unhardened_20260806(
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  text,
  integer,
  integer
) from public, anon, authenticated;

create function public.v2_tenant_customer_search(
  p_slug text,
  p_phone text default null,
  p_name text default null,
  p_email text default null,
  p_course_id uuid default null,
  p_status text default null,
  p_owner_staff_id uuid default null,
  p_source text default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_phone_identity text;
  v_email_identity text;
  v_effective_phone text := p_phone;
  v_effective_email text := p_email;
begin
  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.can_access_tenant(v_tenant_id) then
    raise exception 'forbidden';
  end if;

  v_phone_identity := private_app.normalize_lead_phone(p_phone);
  if v_phone_identity is not null then
    select coalesce(contact.phone, contact.whatsapp)
    into v_effective_phone
    from sales_core.contact_identities identity
    join sales_core.contacts contact
      on contact.id = identity.contact_id
     and contact.tenant_id = identity.tenant_id
    where identity.tenant_id = v_tenant_id
      and identity.identity_type = 'phone'
      and identity.identity_value = v_phone_identity
    limit 1;

    v_effective_phone := coalesce(v_effective_phone, p_phone);
  end if;

  v_email_identity := nullif(lower(trim(coalesce(p_email, ''))), '');
  if v_email_identity is not null then
    select contact.email
    into v_effective_email
    from sales_core.contact_identities identity
    join sales_core.contacts contact
      on contact.id = identity.contact_id
     and contact.tenant_id = identity.tenant_id
    where identity.tenant_id = v_tenant_id
      and identity.identity_type = 'email'
      and identity.identity_value = v_email_identity
    limit 1;

    v_effective_email := coalesce(v_effective_email, p_email);
  end if;

  return public.v2_tenant_customer_search_unhardened_20260806(
    p_slug,
    v_effective_phone,
    p_name,
    v_effective_email,
    p_course_id,
    p_status,
    p_owner_staff_id,
    p_source,
    p_limit,
    p_offset
  );
end;
$$;

revoke all on function public.v2_tenant_customer_search(
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  text,
  integer,
  integer
) from public, anon;
grant execute on function public.v2_tenant_customer_search(
  text,
  text,
  text,
  text,
  uuid,
  text,
  uuid,
  text,
  integer,
  integer
) to authenticated;

alter table sales_core.lead_import_rows
add column if not exists duplicate_import_row_id uuid
references sales_core.lead_import_rows(id) on delete set null;

create index if not exists lead_import_rows_duplicate_import_row_idx
on sales_core.lead_import_rows (duplicate_import_row_id);

alter table sales_core.lead_import_rows
drop constraint if exists lead_import_rows_duplicate_kind_check;

alter table sales_core.lead_import_rows
add constraint lead_import_rows_duplicate_kind_check
check (
  duplicate_kind is null
  or duplicate_kind in (
    'same_file',
    'existing_contact',
    'pending_import'
  )
);

alter function public.v2_tenant_lead_intake_action(text, text, jsonb)
rename to v2_tenant_lead_intake_action_unhardened_20260806;

revoke all on function public.v2_tenant_lead_intake_action_unhardened_20260806(
  text,
  text,
  jsonb
) from public, anon, authenticated;

create function public.v2_tenant_lead_intake_action(
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
  v_tenant_id uuid;
  v_batch_id uuid;
  v_result jsonb;
  v_duplicate_skipped integer := 0;
  v_remaining_target integer := 0;
  v_total integer := 0;
  v_valid integer := 0;
  v_duplicate integer := 0;
  v_invalid integer := 0;
  v_deadline_at timestamptz;
  v_strategy text;
begin
  if p_action not in ('import', 'distribute') then
    return public.v2_tenant_lead_intake_action_unhardened_20260806(
      p_tenant_slug,
      p_action,
      p_payload
    );
  end if;

  select tenant.id into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if p_action = 'import' and not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.leads.import'
  ) then raise exception 'forbidden'; end if;
  if p_action = 'distribute' and not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.leads.distribute'
  ) then raise exception 'forbidden'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id::text, 1729)
  );

  if p_action = 'import' then
    v_result := public.v2_tenant_lead_intake_action_unhardened_20260806(
      p_tenant_slug,
      p_action,
      p_payload
    );
    v_batch_id := (v_result ->> 'batchId')::uuid;

    with matches as (
      select distinct on (row_data.id)
        row_data.id as row_id,
        identity.contact_id
      from sales_core.lead_import_rows row_data
      join sales_core.contact_identities identity
        on identity.tenant_id = row_data.tenant_id
       and (
         (
           identity.identity_type = 'phone'
           and identity.identity_value in (
             row_data.normalized_phone,
             row_data.normalized_whatsapp
           )
         )
         or (
           identity.identity_type = 'email'
           and identity.identity_value = lower(row_data.email)
         )
       )
      where row_data.batch_id = v_batch_id
        and row_data.validation_status = 'valid'
        and row_data.queue_status = 'awaiting_distribution'
      order by row_data.id, identity.contact_id
    )
    update sales_core.lead_import_rows row_data
    set validation_status = 'duplicate',
        validation_errors = case
          when array_position(
            row_data.validation_errors,
            'العميل موجود مسبقًا في CRM'
          ) is null then array_append(
            row_data.validation_errors,
            'العميل موجود مسبقًا في CRM'
          )
          else row_data.validation_errors
        end,
        duplicate_kind = 'existing_contact',
        duplicate_contact_id = matches.contact_id,
        contact_id = matches.contact_id,
        queue_status = 'skipped'
    from matches
    where row_data.id = matches.row_id;

    with earlier_matches as (
      select distinct on (later_row.id)
        later_row.id as later_row_id,
        earlier_row.id as earlier_row_id,
        earlier_row.batch_id as earlier_batch_id
      from sales_core.lead_import_rows later_row
      join sales_core.lead_import_rows earlier_row
        on earlier_row.tenant_id = later_row.tenant_id
       and earlier_row.id <> later_row.id
       and earlier_row.validation_status = 'valid'
       and earlier_row.queue_status = 'awaiting_distribution'
       and (
         (
           earlier_row.normalized_phone is not null
           and earlier_row.normalized_phone in (
             later_row.normalized_phone,
             later_row.normalized_whatsapp
           )
         )
         or (
           earlier_row.normalized_whatsapp is not null
           and earlier_row.normalized_whatsapp in (
             later_row.normalized_phone,
             later_row.normalized_whatsapp
           )
         )
         or (
           earlier_row.email is not null
           and lower(earlier_row.email) = lower(later_row.email)
         )
       )
       and (
         earlier_row.created_at,
         earlier_row.batch_id,
         earlier_row.row_number,
         earlier_row.id
       ) < (
         later_row.created_at,
         later_row.batch_id,
         later_row.row_number,
         later_row.id
       )
      where later_row.batch_id = v_batch_id
        and later_row.validation_status = 'valid'
        and later_row.queue_status = 'awaiting_distribution'
      order by
        later_row.id,
        earlier_row.created_at,
        earlier_row.batch_id,
        earlier_row.row_number,
        earlier_row.id
    )
    update sales_core.lead_import_rows later_row
    set validation_status = 'duplicate',
        validation_errors = array_append(
          later_row.validation_errors,
          case
            when earlier_matches.earlier_batch_id = later_row.batch_id
              then 'مكرر داخل نفس الملف'
            else 'مكرر في دفعة رفع سابقة تنتظر التوزيع'
          end
        ),
        duplicate_kind = case
          when earlier_matches.earlier_batch_id = later_row.batch_id
            then 'same_file'
          else 'pending_import'
        end,
        duplicate_import_row_id = earlier_matches.earlier_row_id,
        queue_status = 'skipped'
    from earlier_matches
    where later_row.id = earlier_matches.later_row_id;

    select
      count(*),
      count(*) filter (where validation_status = 'valid'),
      count(*) filter (where validation_status = 'duplicate'),
      count(*) filter (where validation_status = 'invalid')
    into v_total, v_valid, v_duplicate, v_invalid
    from sales_core.lead_import_rows
    where batch_id = v_batch_id;

    update sales_core.lead_import_batches
    set total_rows = v_total,
        valid_rows = v_valid,
        duplicate_rows = v_duplicate,
        invalid_rows = v_invalid
    where id = v_batch_id;

    return jsonb_build_object(
      'batchId', v_batch_id,
      'totalRows', v_total,
      'validRows', v_valid,
      'duplicateRows', v_duplicate,
      'invalidRows', v_invalid
    );
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
  if v_strategy = 'selected'
     and (
       case
         when jsonb_typeof(p_payload -> 'staffIds') = 'array'
           then jsonb_array_length(p_payload -> 'staffIds') = 0
         else true
       end
     ) then
    raise exception 'distribution_staff_required';
  end if;
  if v_deadline_at is null or v_deadline_at <= now() then
    raise exception 'invalid_distribution_deadline';
  end if;
  if v_deadline_at > now() + interval '90 days' then
    raise exception 'distribution_deadline_too_far';
  end if;
  if not exists (
    select 1
    from sales_core.lead_import_batches batch
    where batch.id = v_batch_id
      and batch.tenant_id = v_tenant_id
      and batch.status in ('ready', 'partially_distributed')
  ) then
    raise exception 'lead_batch_not_ready';
  end if;

  with target_rows as (
    select row_data.*
    from sales_core.lead_import_rows row_data
    where row_data.batch_id = v_batch_id
      and row_data.tenant_id = v_tenant_id
      and row_data.validation_status = 'valid'
      and row_data.queue_status = 'awaiting_distribution'
      and (
        jsonb_array_length(coalesce(p_payload -> 'rowIds', '[]'::jsonb)) = 0
        or row_data.id in (
          select value::uuid
          from jsonb_array_elements_text(
            coalesce(p_payload -> 'rowIds', '[]'::jsonb)
          )
        )
      )
  ), matches as (
    select distinct on (target.id)
      target.id as row_id,
      identity.contact_id
    from target_rows target
    join sales_core.contact_identities identity
      on identity.tenant_id = target.tenant_id
     and (
       (
         identity.identity_type = 'phone'
         and identity.identity_value in (
           target.normalized_phone,
           target.normalized_whatsapp
         )
       )
       or (
         identity.identity_type = 'email'
         and identity.identity_value = lower(target.email)
       )
     )
    order by target.id, identity.contact_id
  )
  update sales_core.lead_import_rows row_data
  set validation_status = 'duplicate',
      validation_errors = case
        when array_position(
          row_data.validation_errors,
          'أعيد فحصه لحظة التوزيع والعميل موجود بالفعل'
        ) is null then array_append(
          row_data.validation_errors,
          'أعيد فحصه لحظة التوزيع والعميل موجود بالفعل'
        )
        else row_data.validation_errors
      end,
      duplicate_kind = 'existing_contact',
      duplicate_contact_id = matches.contact_id,
      contact_id = matches.contact_id,
      queue_status = 'skipped'
  from matches
  where row_data.id = matches.row_id;

  get diagnostics v_duplicate_skipped = row_count;

  select count(*)
  into v_remaining_target
  from sales_core.lead_import_rows row_data
  where row_data.batch_id = v_batch_id
    and row_data.tenant_id = v_tenant_id
    and row_data.validation_status = 'valid'
    and row_data.queue_status = 'awaiting_distribution'
    and (
      jsonb_array_length(coalesce(p_payload -> 'rowIds', '[]'::jsonb)) = 0
      or row_data.id in (
        select value::uuid
        from jsonb_array_elements_text(
          coalesce(p_payload -> 'rowIds', '[]'::jsonb)
        )
      )
    );

  update sales_core.lead_import_batches batch
  set valid_rows = (
        select count(*)
        from sales_core.lead_import_rows row_data
        where row_data.batch_id = batch.id
          and row_data.validation_status = 'valid'
      ),
      duplicate_rows = (
        select count(*)
        from sales_core.lead_import_rows row_data
        where row_data.batch_id = batch.id
          and row_data.validation_status = 'duplicate'
      )
  where batch.id = v_batch_id;

  if v_remaining_target = 0 then
    update sales_core.lead_import_batches batch
    set status = case
      when exists (
        select 1
        from sales_core.lead_import_rows remaining_row
        where remaining_row.batch_id = batch.id
          and remaining_row.validation_status = 'valid'
          and remaining_row.queue_status = 'awaiting_distribution'
      ) then case
        when batch.distributed_rows > 0 then 'partially_distributed'
        else 'ready'
      end
      else 'distributed'
    end
    where batch.id = v_batch_id;

    return jsonb_build_object(
      'batchId', v_batch_id,
      'distributed', 0,
      'duplicatesSkipped', v_duplicate_skipped,
      'strategy', v_strategy,
      'deadlineAt', v_deadline_at,
      'teamSize', 0
    );
  end if;

  v_result := public.v2_tenant_lead_intake_action_unhardened_20260806(
    p_tenant_slug,
    p_action,
    p_payload
  );

  return v_result || jsonb_build_object(
    'duplicatesSkipped', v_duplicate_skipped
  );
end;
$$;

revoke all on function public.v2_tenant_lead_intake_action(
  text,
  text,
  jsonb
) from public, anon;
grant execute on function public.v2_tenant_lead_intake_action(
  text,
  text,
  jsonb
) to authenticated;

comment on table sales_core.contact_identities is
'Canonical and historical tenant-scoped customer identities. Phone and WhatsApp share one phone namespace.';
comment on table sales_core.contact_merge_archive is
'Recoverable archive of every CRM contact removed by deterministic deduplication.';
comment on function public.v2_tenant_lead_intake_action(text, text, jsonb) is
'Hardened lead import and distribution with tenant locking and distribution-time duplicate rechecks.';

commit;
