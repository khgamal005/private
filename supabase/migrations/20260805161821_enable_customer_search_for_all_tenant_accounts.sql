-- Customer search is available to every active tenant account.
-- Record opening and full customer details remain governed by team/ownership rules.
create index if not exists sales_contacts_tenant_phone_digits_idx
  on sales_core.contacts (
    tenant_id,
    (right(
      pg_catalog.regexp_replace(
        coalesce(phone, ''),
        '[^0-9]',
        '',
        'g'
      ),
      9
    ))
  )
  where phone is not null;

create index if not exists sales_contacts_tenant_whatsapp_digits_idx
  on sales_core.contacts (
    tenant_id,
    (right(
      pg_catalog.regexp_replace(
        coalesce(whatsapp, ''),
        '[^0-9]',
        '',
        'g'
      ),
      9
    ))
  )
  where whatsapp is not null;

create or replace function public.v2_tenant_customer_search(
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
  v_tenant core.tenants%rowtype;
  v_staff_id uuid;
  v_view_team boolean;
  v_can_write_crm boolean;
  v_phone_digits text;
  v_name text;
  v_email text;
  v_exact_phone_lookup boolean;
  v_has_criteria boolean;
  v_page jsonb;
begin
  select tenant.*
  into v_tenant
  from core.tenants tenant
  where tenant.slug = p_slug
  limit 1;

  if v_tenant.id is null then
    raise exception 'tenant_not_found';
  end if;
  if not private_app.can_access_tenant(v_tenant.id) then
    raise exception 'forbidden';
  end if;

  v_staff_id := private_app.current_staff_id(v_tenant.id);
  v_view_team := private_app.can_view_tenant_team(v_tenant.id);
  v_can_write_crm := private_app.has_tenant_permission(
    v_tenant.id,
    'tenant.crm.write'
  );
  v_phone_digits := pg_catalog.regexp_replace(
    coalesce(pg_catalog.btrim(p_phone), ''),
    '[^0-9]',
    '',
    'g'
  );
  v_name := pg_catalog.lower(
    coalesce(pg_catalog.btrim(p_name), '')
  );
  v_email := pg_catalog.lower(
    coalesce(pg_catalog.btrim(p_email), '')
  );
  v_exact_phone_lookup := pg_catalog.length(v_phone_digits) >= 9;
  v_has_criteria := pg_catalog.length(v_phone_digits) >= 3
    or pg_catalog.length(v_name) >= 2
    or pg_catalog.length(v_email) >= 3
    or p_course_id is not null
    or coalesce(pg_catalog.btrim(p_status), '') <> ''
    or p_owner_staff_id is not null
    or coalesce(pg_catalog.btrim(p_source), '') <> '';

  if v_has_criteria then
    with matched as materialized (
      select
        contact.id,
        contact.full_name,
        contact.organization_name,
        contact.phone,
        contact.whatsapp,
        contact.email,
        contact.source,
        contact.campaign_name,
        contact.lead_status,
        contact.lead_quality,
        contact.owner_staff_id,
        owner.full_name as owner_name,
        contact.interest_course_id,
        course.title_ar as interest_course_name,
        contact.next_action_type,
        contact.next_action_at,
        contact.last_activity_at,
        contact.created_at,
        contact.updated_at,
        (
          v_view_team
          or contact.owner_staff_id = v_staff_id
        ) as can_open,
        (
          v_exact_phone_lookup
          and (
            right(
              pg_catalog.regexp_replace(
                coalesce(contact.phone, ''),
                '[^0-9]',
                '',
                'g'
              ),
              9
            ) = right(v_phone_digits, 9)
            or right(
              pg_catalog.regexp_replace(
                coalesce(contact.whatsapp, ''),
                '[^0-9]',
                '',
                'g'
              ),
              9
            ) = right(v_phone_digits, 9)
          )
        ) as exact_phone_match
      from sales_core.contacts contact
      left join people.staff_profiles owner
        on owner.id = contact.owner_staff_id
        and owner.tenant_id = contact.tenant_id
      left join academy.courses course
        on course.id = contact.interest_course_id
        and course.tenant_id = contact.tenant_id
      where contact.tenant_id = v_tenant.id
        and (
          v_phone_digits = ''
          or (
            pg_catalog.length(v_phone_digits) >= 3
            and case
              when v_exact_phone_lookup then
                right(
                  pg_catalog.regexp_replace(
                    coalesce(contact.phone, ''),
                    '[^0-9]',
                    '',
                    'g'
                  ),
                  9
                ) = right(v_phone_digits, 9)
                or right(
                  pg_catalog.regexp_replace(
                    coalesce(contact.whatsapp, ''),
                    '[^0-9]',
                    '',
                    'g'
                  ),
                  9
                ) = right(v_phone_digits, 9)
              else
                pg_catalog.strpos(
                  pg_catalog.regexp_replace(
                    coalesce(contact.phone, ''),
                    '[^0-9]',
                    '',
                    'g'
                  ),
                  v_phone_digits
                ) > 0
                or pg_catalog.strpos(
                  pg_catalog.regexp_replace(
                    coalesce(contact.whatsapp, ''),
                    '[^0-9]',
                    '',
                    'g'
                  ),
                  v_phone_digits
                ) > 0
            end
          )
        )
        and (
          v_name = ''
          or pg_catalog.strpos(
            pg_catalog.lower(contact.full_name),
            v_name
          ) > 0
        )
        and (
          v_email = ''
          or pg_catalog.strpos(
            pg_catalog.lower(coalesce(contact.email, '')),
            v_email
          ) > 0
        )
        and (p_course_id is null or contact.interest_course_id = p_course_id)
        and (
          coalesce(pg_catalog.btrim(p_status), '') = ''
          or contact.lead_status = pg_catalog.btrim(p_status)
        )
        and (
          p_owner_staff_id is null
          or contact.owner_staff_id = p_owner_staff_id
        )
        and (
          coalesce(pg_catalog.btrim(p_source), '') = ''
          or contact.source = pg_catalog.btrim(p_source)
        )
        and (
          v_view_team
          or contact.owner_staff_id = v_staff_id
          or (
            v_exact_phone_lookup
            and (
              right(
                pg_catalog.regexp_replace(
                  coalesce(contact.phone, ''),
                  '[^0-9]',
                  '',
                  'g'
                ),
                9
              ) = right(v_phone_digits, 9)
              or right(
                pg_catalog.regexp_replace(
                  coalesce(contact.whatsapp, ''),
                  '[^0-9]',
                  '',
                  'g'
                ),
                9
              ) = right(v_phone_digits, 9)
            )
          )
        )
    ), page as (
      select matched.*
      from matched
      order by matched.exact_phone_match desc, matched.updated_at desc
      offset greatest(p_offset, 0)
      limit least(greatest(p_limit, 1), 100)
    )
    select jsonb_build_object(
      'total', (select count(*) from matched),
      'results', coalesce((
        select jsonb_agg(jsonb_build_object(
          'matchKey', pg_catalog.md5(page.id::text),
          'id', case when page.can_open then page.id else null end,
          'name', page.full_name,
          'organizationName', case
            when page.can_open then page.organization_name
            else null
          end,
          'phone', case
            when page.can_open then page.phone
            else pg_catalog.concat(
              '••••••',
              right(
                pg_catalog.regexp_replace(
                  coalesce(page.phone, page.whatsapp, ''),
                  '[^0-9]',
                  '',
                  'g'
                ),
                4
              )
            )
          end,
          'whatsapp', case when page.can_open then page.whatsapp else null end,
          'email', case when page.can_open then page.email else null end,
          'source', page.source,
          'campaignName', case when page.can_open then page.campaign_name else null end,
          'leadStatus', page.lead_status,
          'leadQuality', page.lead_quality,
          'ownerStaffId', case when page.can_open then page.owner_staff_id else null end,
          'ownerName', page.owner_name,
          'interestCourseId', page.interest_course_id,
          'interestCourseName', page.interest_course_name,
          'nextActionType', case when page.can_open then page.next_action_type else null end,
          'nextActionAt', case when page.can_open then page.next_action_at else null end,
          'lastActivityAt', case when page.can_open then page.last_activity_at else null end,
          'createdAt', case when page.can_open then page.created_at else null end,
          'canOpen', page.can_open,
          'restricted', not page.can_open
        ) order by page.exact_phone_match desc, page.updated_at desc)
        from page
      ), '[]'::jsonb)
    )
    into v_page;
  else
    v_page := jsonb_build_object('total', 0, 'results', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'hasCriteria', v_has_criteria,
    'viewer', jsonb_build_object(
      'staffId', v_staff_id,
      'viewTeam', v_view_team,
      'canWriteCrm', v_can_write_crm
    ),
    'courses', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', course.id,
        'nameAr', course.title_ar
      ) order by course.title_ar)
      from academy.courses course
      where course.tenant_id = v_tenant.id
        and course.status = 'active'
    ), '[]'::jsonb),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', staff.id,
        'name', staff.full_name
      ) order by staff.full_name)
      from people.staff_profiles staff
      where staff.tenant_id = v_tenant.id
        and staff.employment_status = 'active'
        and (v_view_team or staff.id = v_staff_id)
    ), '[]'::jsonb),
    'sources', coalesce((
      select jsonb_agg(source_item.source order by source_item.source)
      from (
        select distinct contact.source
        from sales_core.contacts contact
        where contact.tenant_id = v_tenant.id
          and contact.source is not null
          and contact.source <> ''
          and (v_view_team or contact.owner_staff_id = v_staff_id)
      ) source_item
    ), '[]'::jsonb),
    'total', coalesce((v_page ->> 'total')::integer, 0),
    'results', coalesce(v_page -> 'results', '[]'::jsonb),
    'limit', least(greatest(p_limit, 1), 100),
    'offset', greatest(p_offset, 0)
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
) to authenticated, service_role;
