begin;

create or replace function public.v2_tenant_lead_intake_export_v1(
  p_slug text,
  p_section text default 'assignments',
  p_from date default null,
  p_to date default null,
  p_quality text default null,
  p_source text default null,
  p_campaign text default null,
  p_batch_id uuid default null,
  p_validation text default null,
  p_query text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_section text := lower(coalesce(nullif(trim(p_section), ''), 'assignments'));
  v_from date := p_from;
  v_to date := p_to;
  v_quality text := nullif(trim(p_quality), '');
  v_source text := nullif(trim(p_source), '');
  v_campaign text := nullif(trim(p_campaign), '');
  v_validation text := nullif(trim(p_validation), '');
  v_query text := nullif(trim(p_query), '');
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
  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'invalid_report_range';
  end if;
  if v_section not in (
    'queue',
    'batches',
    'assignments',
    'analytics',
    'team'
  ) then
    raise exception 'invalid_lead_export_section';
  end if;
  if v_section = 'analytics'
     and not private_app.has_tenant_permission(
       v_tenant.id,
       'tenant.leads.analytics'
     ) then
    raise exception 'forbidden';
  end if;
  if v_section = 'team'
     and not private_app.has_tenant_permission(
       v_tenant.id,
       'tenant.leads.distribute'
     ) then
    raise exception 'forbidden';
  end if;

  if v_section = 'assignments' then
    return jsonb_build_object(
      'assignments',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'العميل', contact.full_name,
          'رقم الجوال', contact.phone,
          'المصدر', coalesce(row_data.source, contact.source),
          'الحملة', coalesce(row_data.campaign_name, contact.campaign_name),
          'مجموعة الإعلانات', row_data.ad_set_name,
          'الإعلان', coalesce(row_data.ad_name, contact.ad_name),
          'المسؤول', assignee.full_name,
          'تم الإسناد بواسطة', coalesce(assigner.full_name, 'إدارة المنشأة'),
          'طريقة التوزيع', assignment.assignment_strategy,
          'حالة الإسناد', assignment.status,
          'تاريخ الإسناد', assignment.assigned_at,
          'موعد أول متابعة', assignment.deadline_at,
          'تاريخ أول استجابة', assignment.first_action_at,
          'زمن الاستجابة بالدقائق', case
            when assignment.first_action_at is null then null
            else round((
              extract(epoch from (
                assignment.first_action_at - assignment.assigned_at
              )) / 60
            )::numeric, 1)
          end,
          'حالة العميل', contact.lead_status,
          'جودة الصف', contact.lead_quality,
          'متأخر', (
            assignment.status = 'active'
            and assignment.first_action_at is null
            and assignment.deadline_at < now()
          )
        ) order by assignment.assigned_at desc)
        from sales_core.lead_assignments assignment
        join sales_core.contacts contact
          on contact.id = assignment.contact_id
        join people.staff_profiles assignee
          on assignee.id = assignment.assigned_staff_id
        left join people.staff_profiles assigner
          on assigner.id = assignment.assigned_by_staff_id
        left join sales_core.lead_import_rows row_data
          on row_data.id = assignment.import_row_id
        where assignment.tenant_id = v_tenant.id
          and (
            (v_from is null and v_to is null)
            or (
              (
                assignment.assigned_at at time zone v_tenant.timezone
              )::date between coalesce(v_from, '-infinity'::date)
                and coalesce(v_to, 'infinity'::date)
              or (
                assignment.first_action_at is not null
                and (
                  assignment.first_action_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
              )
            )
          )
          and (
            v_quality is null
            or contact.lead_quality = v_quality
            or contact.lead_status = v_quality
          )
          and (
            v_source is null
            or coalesce(row_data.source, contact.source) = v_source
          )
          and (
            v_campaign is null
            or coalesce(
              row_data.campaign_name,
              contact.campaign_name
            ) = v_campaign
          )
      ), '[]'::jsonb)
    );
  end if;

  if v_section = 'queue' then
    return jsonb_build_object(
      'queue',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'رقم الصف', row_data.row_number,
          'العميل', row_data.full_name,
          'رقم الجوال', row_data.phone,
          'رقم واتساب', row_data.whatsapp,
          'البريد الإلكتروني', row_data.email,
          'المنشأة', row_data.organization_name,
          'البرنامج', row_data.program_name,
          'المصدر', row_data.source,
          'الحملة', row_data.campaign_name,
          'مجموعة الإعلانات', row_data.ad_set_name,
          'الإعلان', row_data.ad_name,
          'ملف الرفع', batch.file_name,
          'جودة الاستيراد', row_data.validation_status,
          'أخطاء الفحص', array_to_string(row_data.validation_errors, '، '),
          'حالة الصف', row_data.queue_status,
          'حالة العميل', contact.lead_status,
          'جودة الصف', coalesce(contact.lead_quality, 'unrated'),
          'المسؤول', assignee.full_name,
          'تاريخ الإسناد', assignment.assigned_at,
          'أول استجابة', assignment.first_action_at,
          'تاريخ الرفع', row_data.created_at
        ) order by row_data.created_at desc, row_data.row_number)
        from sales_core.lead_import_rows row_data
        join sales_core.lead_import_batches batch
          on batch.id = row_data.batch_id
        left join lateral (
          select latest_assignment.*
          from sales_core.lead_assignments latest_assignment
          where latest_assignment.import_row_id = row_data.id
          order by latest_assignment.assigned_at desc
          limit 1
        ) assignment on true
        left join sales_core.contacts contact
          on contact.id = assignment.contact_id
        left join people.staff_profiles assignee
          on assignee.id = assignment.assigned_staff_id
        where row_data.tenant_id = v_tenant.id
          and (
            (v_from is null and v_to is null)
            or (
              (
                row_data.created_at at time zone v_tenant.timezone
              )::date between coalesce(v_from, '-infinity'::date)
                and coalesce(v_to, 'infinity'::date)
              or (
                assignment.assigned_at is not null
                and (
                  assignment.assigned_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
              )
              or (
                assignment.first_action_at is not null
                and (
                  assignment.first_action_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
              )
            )
          )
          and (
            v_quality is null
            or contact.lead_quality = v_quality
            or contact.lead_status = v_quality
            or (v_quality = 'unrated' and contact.id is null)
          )
          and (v_source is null or row_data.source = v_source)
          and (
            v_campaign is null
            or row_data.campaign_name = v_campaign
          )
          and (p_batch_id is null or row_data.batch_id = p_batch_id)
          and (
            v_validation is null
            or (
              v_validation = 'awaiting'
              and row_data.queue_status = 'awaiting_distribution'
            )
            or (
              v_validation <> 'awaiting'
              and row_data.validation_status = v_validation
            )
          )
          and (
            v_query is null
            or concat_ws(
              ' ',
              row_data.full_name,
              row_data.phone,
              row_data.whatsapp,
              row_data.email,
              row_data.program_name,
              row_data.source,
              row_data.campaign_name,
              row_data.ad_name,
              batch.file_name
            ) ilike '%' || v_query || '%'
          )
      ), '[]'::jsonb)
    );
  end if;

  if v_section = 'batches' then
    return jsonb_build_object(
      'batches',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'اسم الملف', batch.file_name,
          'المصدر', batch.source,
          'الحملة', batch.campaign_name,
          'مجموعة الإعلانات', batch.ad_set_name,
          'الإعلان', batch.ad_name,
          'الحالة', batch.status,
          'إجمالي الصفوف', batch.total_rows,
          'صالح', batch.valid_rows,
          'مكرر', batch.duplicate_rows,
          'غير صالح', batch.invalid_rows,
          'تم توزيعه', batch.distributed_rows,
          'في الانتظار', greatest(
            batch.valid_rows - batch.distributed_rows,
            0
          ),
          'رفعها', importer.full_name,
          'آخر مسؤول توزيع', distributor.full_name,
          'آخر طريقة توزيع', batch.last_distribution_strategy,
          'آخر موعد متابعة', batch.last_deadline_at,
          'تاريخ التوزيع', batch.distributed_at,
          'تاريخ الرفع', batch.created_at
        ) order by batch.created_at desc)
        from sales_core.lead_import_batches batch
        left join people.staff_profiles importer
          on importer.id = batch.imported_by_staff_id
        left join people.staff_profiles distributor
          on distributor.id = batch.last_distributed_by_staff_id
        where batch.tenant_id = v_tenant.id
          and (
            (v_from is null and v_to is null)
            or (
              (
                batch.created_at at time zone v_tenant.timezone
              )::date between coalesce(v_from, '-infinity'::date)
                and coalesce(v_to, 'infinity'::date)
              or (
                batch.distributed_at is not null
                and (
                  batch.distributed_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
              )
            )
          )
          and (v_source is null or batch.source = v_source)
          and (
            v_campaign is null
            or batch.campaign_name = v_campaign
          )
          and (
            v_quality is null
            or exists (
              select 1
              from sales_core.lead_import_rows quality_row
              left join lateral (
                select quality_assignment.*
                from sales_core.lead_assignments quality_assignment
                where quality_assignment.import_row_id = quality_row.id
                order by quality_assignment.assigned_at desc
                limit 1
              ) quality_assignment on true
              left join sales_core.contacts quality_contact
                on quality_contact.id = quality_assignment.contact_id
              where quality_row.batch_id = batch.id
                and (
                  quality_contact.lead_quality = v_quality
                  or quality_contact.lead_status = v_quality
                  or (
                    v_quality = 'unrated'
                    and quality_contact.id is null
                  )
                )
            )
          )
      ), '[]'::jsonb)
    );
  end if;

  if v_section = 'analytics' then
    return jsonb_build_object(
      'analytics',
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'المصدر', campaign.source,
          'الحملة', campaign.campaign_name,
          'مجموعة الإعلانات', campaign.ad_set_name,
          'الإعلان', campaign.ad_name,
          'الإجمالي', campaign.total_rows,
          'صالح', campaign.valid_rows,
          'مكرر', campaign.duplicate_rows,
          'غير صالح', campaign.invalid_rows,
          'تم توزيعه', campaign.distributed_rows,
          'تم التواصل', campaign.contacted_rows,
          'مؤهل', campaign.qualified_rows,
          'مدفوع', campaign.paid_rows,
          'رقم خاطئ', campaign.wrong_number_rows,
          'نسبة الجودة السيئة', campaign.bad_data_rate,
          'نسبة التأهيل', campaign.qualification_rate,
          'نسبة التحويل', campaign.conversion_rate,
          'متوسط أول استجابة بالدقائق',
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
                'qualified',
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
                or contact.lead_quality = 'wrong_number'
            ) as wrong_number_rows,
            round((
              (
                count(*) filter (
                  where row_data.validation_status in (
                    'duplicate',
                    'invalid'
                  )
                )
                + count(contact.id) filter (
                  where contact.lead_status = 'wrong_number'
                    or contact.lead_quality = 'wrong_number'
                )
              )::numeric
              / nullif(count(*), 0)
            ) * 100, 1) as bad_data_rate,
            round((
              count(contact.id) filter (
                where contact.lead_status in (
                  'qualified',
                  'interested',
                  'very_interested',
                  'awaiting_payment',
                  'payment_submitted',
                  'paid'
                )
              )::numeric
              / nullif(count(assignment.id), 0)
            ) * 100, 1) as qualification_rate,
            round((
              count(contact.id) filter (
                where contact.lead_status = 'paid'
              )::numeric
              / nullif(count(assignment.id), 0)
            ) * 100, 1) as conversion_rate,
            round((
              avg(
                extract(epoch from (
                  assignment.first_action_at - assignment.assigned_at
                )) / 60
              ) filter (
                where assignment.first_action_at is not null
              )
            )::numeric, 1) as average_first_response_minutes
          from sales_core.lead_import_rows row_data
          left join lateral (
            select latest_assignment.*
            from sales_core.lead_assignments latest_assignment
            where latest_assignment.import_row_id = row_data.id
            order by latest_assignment.assigned_at desc
            limit 1
          ) assignment on true
          left join sales_core.contacts contact
            on contact.id = assignment.contact_id
          where row_data.tenant_id = v_tenant.id
            and (
              (v_from is null and v_to is null)
              or (
                (
                  row_data.created_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
                or (
                  assignment.assigned_at is not null
                  and (
                    assignment.assigned_at
                    at time zone v_tenant.timezone
                  )::date between coalesce(v_from, '-infinity'::date)
                    and coalesce(v_to, 'infinity'::date)
                )
                or (
                  assignment.first_action_at is not null
                  and (
                    assignment.first_action_at
                    at time zone v_tenant.timezone
                  )::date between coalesce(v_from, '-infinity'::date)
                    and coalesce(v_to, 'infinity'::date)
                )
              )
            )
            and (
              v_quality is null
              or contact.lead_quality = v_quality
              or contact.lead_status = v_quality
              or (v_quality = 'unrated' and contact.id is null)
            )
            and (v_source is null or row_data.source = v_source)
            and (
              v_campaign is null
              or row_data.campaign_name = v_campaign
            )
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
    );
  end if;

  return jsonb_build_object(
    'team',
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'الموظف', staff.full_name,
        'المسمى الوظيفي', staff.job_title,
        'نوع المبيعات', coalesce(profile.sales_channel, 'online'),
        'متاح للتوزيع', coalesce(profile.eligible_for_leads, false),
        'الطاقة اليومية', coalesce(profile.daily_capacity, 50),
        'وزن التوزيع', coalesce(profile.weight, 1),
        'إجمالي الإسنادات المطابقة', metrics.total_assignments,
        'تم التواصل', metrics.contacted_assignments,
        'بانتظار أول تواصل', metrics.active_assignments,
        'متأخر', metrics.overdue_assignments,
        'متوسط أول استجابة بالدقائق',
          metrics.average_first_response_minutes,
        'آخر إسناد', profile.last_assigned_at
      ) order by staff.full_name)
      from people.staff_profiles staff
      left join sales_core.sales_assignment_profiles profile
        on profile.staff_id = staff.id
       and profile.tenant_id = staff.tenant_id
      left join lateral (
        select
          count(*) as total_assignments,
          count(*) filter (
            where assignment.first_action_at is not null
          ) as contacted_assignments,
          count(*) filter (
            where assignment.status = 'active'
              and assignment.first_action_at is null
          ) as active_assignments,
          count(*) filter (
            where assignment.status = 'active'
              and assignment.first_action_at is null
              and assignment.deadline_at < now()
          ) as overdue_assignments,
          round((
            avg(
              extract(epoch from (
                assignment.first_action_at - assignment.assigned_at
              )) / 60
            ) filter (
              where assignment.first_action_at is not null
            )
          )::numeric, 1) as average_first_response_minutes
        from sales_core.lead_assignments assignment
        join sales_core.contacts contact
          on contact.id = assignment.contact_id
        left join sales_core.lead_import_rows row_data
          on row_data.id = assignment.import_row_id
        where assignment.assigned_staff_id = staff.id
          and assignment.tenant_id = v_tenant.id
          and (
            (v_from is null and v_to is null)
            or (
              (
                assignment.assigned_at at time zone v_tenant.timezone
              )::date between coalesce(v_from, '-infinity'::date)
                and coalesce(v_to, 'infinity'::date)
              or (
                assignment.first_action_at is not null
                and (
                  assignment.first_action_at at time zone v_tenant.timezone
                )::date between coalesce(v_from, '-infinity'::date)
                  and coalesce(v_to, 'infinity'::date)
              )
            )
          )
          and (
            v_quality is null
            or contact.lead_quality = v_quality
            or contact.lead_status = v_quality
          )
          and (
            v_source is null
            or coalesce(row_data.source, contact.source) = v_source
          )
          and (
            v_campaign is null
            or coalesce(
              row_data.campaign_name,
              contact.campaign_name
            ) = v_campaign
          )
      ) metrics on true
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and staff.role_key in (
          'sales_user',
          'sales_supervisor',
          'sales_manager'
        )
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.v2_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) from public, anon;

grant execute on function public.v2_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) to authenticated;

comment on function public.v2_tenant_lead_intake_export_v1(
  text,
  text,
  date,
  date,
  text,
  text,
  text,
  uuid,
  text,
  text
) is
'Exports complete tenant-scoped lead distribution datasets with date, quality, source, campaign, and queue filters.';

commit;
