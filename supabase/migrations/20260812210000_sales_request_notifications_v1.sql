begin;

create table work_core.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null
    references core.tenants(id) on delete cascade,
  notification_key text not null,
  recipient_staff_id uuid not null
    references people.staff_profiles(id) on delete cascade,
  notification_type text not null,
  title text not null check (length(trim(title)) >= 2),
  message text not null check (length(trim(message)) >= 2),
  severity text not null default 'info'
    check (severity in ('info', 'success', 'warning', 'danger')),
  action_path text not null default 'sales',
  contact_id uuid
    references sales_core.contacts(id) on delete cascade,
  handoff_id uuid
    references academy.registration_handoffs(id) on delete cascade,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (tenant_id, notification_key, recipient_staff_id)
);

create index work_notifications_recipient_time_idx
on work_core.notifications (
  tenant_id,
  recipient_staff_id,
  created_at desc
);

create index work_notifications_recipient_unread_idx
on work_core.notifications (
  tenant_id,
  recipient_staff_id,
  created_at desc
)
where read_at is null;

create index work_notifications_recipient_reference_idx
on work_core.notifications (recipient_staff_id);

create index work_notifications_contact_reference_idx
on work_core.notifications (contact_id)
where contact_id is not null;

create index work_notifications_handoff_reference_idx
on work_core.notifications (handoff_id)
where handoff_id is not null;

alter table work_core.notifications enable row level security;

create policy work_notifications_recipient_read
on work_core.notifications
for select
to authenticated
using (
  private_app.can_access_tenant(tenant_id)
  and recipient_staff_id = private_app.current_staff_id(tenant_id)
);

revoke all on table work_core.notifications
from public, anon, authenticated;

create or replace function private_app.notify_sales_owner_on_admission_status()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner_staff_id uuid;
  v_contact_name text;
  v_reason text;
  v_task_id uuid;
  v_title text;
  v_message text;
  v_type text;
  v_severity text;
  v_action_path text;
begin
  if new.status is not distinct from old.status
     or new.status not in ('accepted', 'rejected') then
    return new;
  end if;

  select
    coalesce(contact.owner_staff_id, opportunity.owner_staff_id),
    contact.full_name
  into v_owner_staff_id, v_contact_name
  from sales_core.contacts contact
  left join sales_core.opportunities opportunity
    on opportunity.id = new.opportunity_id
   and opportunity.tenant_id = new.tenant_id
  where contact.id = new.contact_id
    and contact.tenant_id = new.tenant_id
  limit 1;

  if v_owner_staff_id is null and new.created_by_subject_id is not null then
    select staff.id
    into v_owner_staff_id
    from people.staff_profiles staff
    join access_control.memberships membership
      on membership.id = staff.membership_id
     and membership.tenant_id = new.tenant_id
     and membership.subject_id = new.created_by_subject_id
     and membership.scope = 'tenant'
     and membership.status = 'active'
    where staff.tenant_id = new.tenant_id
      and staff.employment_status = 'active'
    limit 1;
  end if;

  if v_owner_staff_id is null then
    return new;
  end if;

  v_contact_name := coalesce(nullif(trim(v_contact_name), ''), 'العميل');

  if new.status = 'rejected' then
    v_reason := nullif(trim(new.payment_rejection_reason), '');
    if v_reason is null or length(v_reason) < 3 then
      raise exception 'rejection_reason_required';
    end if;

    select task.id
    into v_task_id
    from work_core.tasks task
    where task.tenant_id = new.tenant_id
      and task.contact_id = new.contact_id
      and task.status in ('todo', 'in_progress')
      and coalesce(task.metadata ->> 'source', '') in (
        'opportunity_next_action',
        'activity_next_action',
        'lead_next_action',
        'lead_assignment',
        'sales_followup'
      )
    order by task.due_at desc, task.created_at desc, task.id
    limit 1
    for update;

    if v_task_id is not null then
      update work_core.tasks task
      set title = 'متابعة طلب مرفوض: ' || v_contact_name,
          description = 'سبب الرفض: ' || v_reason
            || ' · تواصل مع العميل أو عدّل الطلب ثم أعد إرساله.',
          status = 'todo',
          priority = 'urgent',
          assigned_staff_id = v_owner_staff_id,
          opportunity_id = coalesce(new.opportunity_id, task.opportunity_id),
          due_at = now() + interval '1 day',
          completed_at = null,
          completion_timing = null,
          metadata = (
            task.metadata
            - 'resolvedByActivityId'
            - 'completedBySubjectId'
            - 'cancelReason'
          ) || jsonb_build_object(
            'source', 'sales_followup',
            'actionType', 'payment_followup',
            'leadStatus', 'awaiting_payment',
            'handoffId', new.id,
            'rejectionReason', v_reason,
            'autoCreated', true,
            'taskUpdateMode', 'single_record',
            'lastMovedAt', now()
          )
      where task.id = v_task_id;
    else
      insert into work_core.tasks (
        tenant_id,
        task_key,
        title,
        description,
        status,
        priority,
        assigned_staff_id,
        created_by_subject_id,
        contact_id,
        opportunity_id,
        due_at,
        metadata
      )
      values (
        new.tenant_id,
        'admission-rejection-' || new.id::text,
        'متابعة طلب مرفوض: ' || v_contact_name,
        'سبب الرفض: ' || v_reason
          || ' · تواصل مع العميل أو عدّل الطلب ثم أعد إرساله.',
        'todo',
        'urgent',
        v_owner_staff_id,
        coalesce(
          private_app.current_subject_id(),
          new.created_by_subject_id
        ),
        new.contact_id,
        new.opportunity_id,
        now() + interval '1 day',
        jsonb_build_object(
          'source', 'sales_followup',
          'actionType', 'payment_followup',
          'leadStatus', 'awaiting_payment',
          'handoffId', new.id,
          'rejectionReason', v_reason,
          'autoCreated', true,
          'taskUpdateMode', 'single_record'
        )
      )
      on conflict (tenant_id, task_key) do update
      set title = excluded.title,
          description = excluded.description,
          status = 'todo',
          priority = 'urgent',
          assigned_staff_id = excluded.assigned_staff_id,
          opportunity_id = excluded.opportunity_id,
          due_at = excluded.due_at,
          completed_at = null,
          completion_timing = null,
          metadata = excluded.metadata || jsonb_build_object(
            'lastMovedAt', now()
          )
      returning id into v_task_id;
    end if;

    v_type := 'sales_request_rejected';
    v_severity := 'danger';
    v_action_path := 'tasks';
    v_title := 'تم رفض طلب البيع: ' || v_contact_name;
    v_message := 'سبب الرفض: ' || v_reason
      || ' · أُنشئت مهمة متابعة تلقائية في التقويم.';
  else
    v_type := 'sales_request_accepted';
    v_severity := 'success';
    v_action_path := 'sales';
    v_title := 'تم قبول طلب البيع: ' || v_contact_name;
    v_message := 'تم اعتماد طلب العميل ويمكنك متابعة حالته من شاشة المبيعات.';
  end if;

  insert into work_core.notifications (
    tenant_id,
    notification_key,
    recipient_staff_id,
    notification_type,
    title,
    message,
    severity,
    action_path,
    contact_id,
    handoff_id,
    metadata
  )
  values (
    new.tenant_id,
    'admission-status:' || new.id::text || ':' || new.status
      || ':' || new.updated_at::text,
    v_owner_staff_id,
    v_type,
    v_title,
    v_message,
    v_severity,
    v_action_path,
    new.contact_id,
    new.id,
    jsonb_strip_nulls(jsonb_build_object(
      'handoffId', new.id,
      'contactId', new.contact_id,
      'status', new.status,
      'rejectionReason', v_reason
    ))
  )
  on conflict (tenant_id, notification_key, recipient_staff_id)
  do nothing;

  return new;
end;
$$;

revoke all on function private_app.notify_sales_owner_on_admission_status()
from public, anon, authenticated;

create trigger registration_handoff_notify_sales_owner
after update of status on academy.registration_handoffs
for each row
execute function private_app.notify_sales_owner_on_admission_status();

create or replace function public.v1_tenant_notification_center(
  p_tenant_slug text,
  p_action text default 'list',
  p_notification_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant_id uuid;
  v_staff_id uuid;
  v_updated integer;
begin
  if auth.uid() is null then raise exception 'forbidden'; end if;

  select tenant.id
  into v_tenant_id
  from core.tenants tenant
  where tenant.slug = p_tenant_slug
  limit 1;

  if v_tenant_id is null then raise exception 'tenant_not_found'; end if;
  if not private_app.has_tenant_permission(
    v_tenant_id,
    'tenant.workspace.read'
  ) then raise exception 'forbidden'; end if;

  v_staff_id := private_app.current_staff_id(v_tenant_id);
  if v_staff_id is null then
    return jsonb_build_object(
      'generatedAt', now(),
      'unreadCount', 0,
      'notifications', '[]'::jsonb
    );
  end if;

  if p_action not in ('list', 'mark_read', 'mark_all_read') then
    raise exception 'invalid_notification_action';
  end if;

  if p_action = 'mark_read' then
    if p_notification_id is null then
      raise exception 'notification_id_required';
    end if;
    update work_core.notifications notification
    set read_at = coalesce(notification.read_at, now())
    where notification.id = p_notification_id
      and notification.tenant_id = v_tenant_id
      and notification.recipient_staff_id = v_staff_id;
    get diagnostics v_updated = row_count;
    if v_updated = 0 then raise exception 'notification_not_found'; end if;
  elsif p_action = 'mark_all_read' then
    update work_core.notifications notification
    set read_at = now()
    where notification.tenant_id = v_tenant_id
      and notification.recipient_staff_id = v_staff_id
      and notification.read_at is null;
  end if;

  return jsonb_build_object(
    'generatedAt', now(),
    'unreadCount', (
      select count(*)
      from work_core.notifications notification
      where notification.tenant_id = v_tenant_id
        and notification.recipient_staff_id = v_staff_id
        and notification.read_at is null
    ),
    'notifications', coalesce((
      select jsonb_agg(item.payload order by item.created_at desc)
      from (
        select
          notification.created_at,
          jsonb_build_object(
            'id', notification.id,
            'type', notification.notification_type,
            'title', notification.title,
            'message', notification.message,
            'severity', notification.severity,
            'actionUrl', '/tenant/' || p_tenant_slug || '/'
              || notification.action_path,
            'contactId', notification.contact_id,
            'handoffId', notification.handoff_id,
            'readAt', notification.read_at,
            'createdAt', notification.created_at
          ) as payload
        from work_core.notifications notification
        where notification.tenant_id = v_tenant_id
          and notification.recipient_staff_id = v_staff_id
          and (
            notification.read_at is null
            or notification.created_at >= now() - interval '30 days'
          )
        order by notification.created_at desc
        limit 30
      ) item
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.v1_tenant_notification_center(
  text,
  text,
  uuid
) from public, anon, authenticated;

grant execute on function public.v1_tenant_notification_center(
  text,
  text,
  uuid
) to authenticated;

comment on table work_core.notifications is
'Tenant-isolated, staff-targeted system notifications with read state.';

comment on function public.v1_tenant_notification_center(text, text, uuid) is
'Authenticated per-staff RPC. SECURITY DEFINER is intentional because the private table is fully revoked and every operation checks auth, tenant permission, tenant id and recipient staff id.';

commit;
