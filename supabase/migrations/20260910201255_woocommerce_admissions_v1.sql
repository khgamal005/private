-- Additive release. Activation and historical review are separate operations.
begin;

create table sales_core.commerce_admission_rollouts (
  tenant_id uuid primary key references core.tenants(id),
  enabled boolean not null default false,
  enabled_at timestamptz not null default now()
);
alter table sales_core.commerce_order_work_items add unique(tenant_id,id);
alter table academy.registration_handoffs add unique(tenant_id,id);
create table sales_core.commerce_admission_reviews (
  tenant_id uuid not null,
  work_item_id uuid not null,
  revision text not null,
  lines jsonb not null check(jsonb_typeof(lines)='array'),
  reason text not null check(length(trim(reason)) between 3 and 1000),
  reviewed_by uuid not null references access_control.subjects(id),
  reviewed_at timestamptz not null default now(),
  primary key(tenant_id,work_item_id),
  foreign key(tenant_id,work_item_id) references sales_core.commerce_order_work_items(tenant_id,id)
);
create unique index if not exists commerce_staff_tenant_id_idx on people.staff_profiles(tenant_id,id);
create table sales_core.commerce_admission_orders (
  tenant_id uuid not null,
  work_item_id uuid not null,
  contact_id uuid not null,
  sales_staff_id uuid not null,
  amount_minor bigint not null check(amount_minor>0),
  currency text not null check(currency='SAR'),
  paid_at timestamptz not null,
  submitted_at timestamptz not null default now(),
  submitted_by uuid not null references access_control.subjects(id),
  source_revision text not null,
  review_reason text,
  primary key(tenant_id,work_item_id),
  foreign key(tenant_id,work_item_id) references sales_core.commerce_order_work_items(tenant_id,id),
  foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id),
  foreign key(tenant_id,sales_staff_id) references people.staff_profiles(tenant_id,id)
);
create table sales_core.commerce_admission_lines (
  tenant_id uuid not null,
  work_item_id uuid not null,
  external_line_id text not null,
  course_id uuid not null,
  handoff_id uuid not null,
  allocated_minor bigint not null check(allocated_minor>=0),
  reused boolean not null default false,
  primary key(tenant_id,work_item_id,external_line_id),
  unique(tenant_id,handoff_id),
  foreign key(tenant_id,work_item_id) references sales_core.commerce_admission_orders(tenant_id,work_item_id),
  foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
  foreign key(tenant_id,course_id) references academy.courses(tenant_id,id)
);
create table sales_core.commerce_admission_commands (
  tenant_id uuid not null references core.tenants(id),
  command_id uuid not null,
  actor_id uuid not null references access_control.subjects(id),
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key(tenant_id,command_id)
);
create index commerce_admission_reviews_actor_idx on sales_core.commerce_admission_reviews(reviewed_by);
create index commerce_admission_orders_contact_idx on sales_core.commerce_admission_orders(tenant_id,contact_id);
create index commerce_admission_orders_staff_idx on sales_core.commerce_admission_orders(sales_staff_id);
create index commerce_admission_orders_actor_idx on sales_core.commerce_admission_orders(submitted_by);
create index commerce_admission_lines_course_idx on sales_core.commerce_admission_lines(course_id);
create index commerce_admission_commands_actor_idx on sales_core.commerce_admission_commands(actor_id);
alter table sales_core.commerce_admission_rollouts enable row level security;
alter table sales_core.commerce_admission_reviews enable row level security;
alter table sales_core.commerce_admission_orders enable row level security;
alter table sales_core.commerce_admission_lines enable row level security;
alter table sales_core.commerce_admission_commands enable row level security;
revoke all on sales_core.commerce_admission_rollouts,sales_core.commerce_admission_reviews,
 sales_core.commerce_admission_orders,sales_core.commerce_admission_lines,sales_core.commerce_admission_commands
 from public,anon,authenticated,service_role;

create function private_app.commerce_admission_tenant_v1(p_slug text)
returns uuid language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 select id into t from core.tenants where slug=p_slug;
 if private_app.current_subject_id() is null or t is null or not (
  private_app.has_tenant_permission(t,'tenant.work.read') or
  private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute') or
  private_app.has_tenant_permission(t,'tenant.admissions.write')) then raise exception 'forbidden';end if;
 return t;
end $$;

-- Financial fingerprint deliberately excludes sync heartbeats and routing timestamps.
create function private_app.commerce_payment_revision_v1(p_work_item uuid)
returns text language sql stable set search_path='' as $$
 select md5(jsonb_build_object('order',w.external_order_id,'connection',w.connection_id,
  'state',w.payment_state,'status',w.order_status,'amount',w.amount_minor,'currency',w.currency,
  'digits',w.minor_digits,'paidAt',w.paid_at,'rawPaidAt',e.raw_payload#>>'{_marktone,paidAt}',
  'lines',e.raw_payload->'line_items','refunds',e.raw_payload->'refunds',
  'rawStatus',e.raw_payload->>'status','rawTotal',e.raw_payload->>'total')::text)
 from sales_core.commerce_order_work_items w join commerce_sync.external_entities e
  on e.id=w.external_entity_id and e.tenant_id=w.tenant_id and e.connection_id=w.connection_id
 where w.id=p_work_item
$$;

-- Allocate the order's exact total, including taxes/fees, without double counting.
-- Largest-remainder allocation keeps the sum exact in integer minor units.
create function private_app.commerce_admission_items_v1(p_work_item uuid)
returns table(line_id text,title text,quantity numeric,amount_minor bigint,suggested_course_id uuid)
language sql stable set search_path='' as $$
 with source as (
  select w.*,e.raw_payload from sales_core.commerce_order_work_items w
  join commerce_sync.external_entities e on e.id=w.external_entity_id and e.tenant_id=w.tenant_id
   and e.connection_id=w.connection_id where w.id=p_work_item
 ), items as (
  select s.tenant_id,s.connection_id,s.amount_minor total,li->>'id' line_id,li->>'name' title,
   (li->>'quantity')::numeric quantity,
   greatest(0,coalesce((li->>'total')::numeric,0)+coalesce((li->>'total_tax')::numeric,0)) weight,
   coalesce(nullif(li->>'variation_id','0'),li->>'product_id') product_id
  from source s cross join lateral jsonb_array_elements(s.raw_payload->'line_items') li
 ), weighted as (
  select *,case when sum(weight) over()>0 then total*weight/sum(weight) over()
   else total::numeric/count(*) over() end exact from items
 ), allocated as (
  select *,floor(exact)::bigint base,row_number() over(order by exact-floor(exact) desc,line_id) remainder_rank,
   total-sum(floor(exact)::bigint) over() remainder from weighted
 ) select a.line_id,a.title,a.quantity,a.base+case when a.remainder_rank<=a.remainder then 1 else 0 end,
  (select e.local_course_id from commerce_sync.external_entities e join academy.courses c
   on c.id=e.local_course_id and c.tenant_id=a.tenant_id and c.status='active'
   where e.tenant_id=a.tenant_id and e.connection_id=a.connection_id and e.entity_type='products'
    and e.external_id=a.product_id limit 1)
 from allocated a order by a.line_id
$$;

create function public.v1_tenant_woocommerce_admission_context(p_tenant_slug text,p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid; w sales_core.commerce_order_work_items%rowtype; task work_core.tasks%rowtype;
 c sales_core.contacts%rowtype; r sales_core.commerce_admission_rollouts%rowtype;
 rev text; financial text; candidates jsonb; items jsonb; blockers jsonb:='[]'; can_review boolean;
 receipt jsonb; review sales_core.commerce_admission_reviews%rowtype; source jsonb;
begin
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 select * into w from sales_core.commerce_order_work_items where tenant_id=t and task_id=p_task_id;
 if w.id is null then raise exception 'commerce_order_not_found';end if;
 can_review:=private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute')
  or private_app.has_tenant_permission(t,'tenant.admissions.write');
 if w.assigned_staff_id is distinct from private_app.current_staff_id(t) and not can_review
  then raise exception 'forbidden';end if;
 select * into r from sales_core.commerce_admission_rollouts where tenant_id=t;
 if not coalesce(r.enabled,false) then return jsonb_build_object('enabled',false);end if;
 select * into task from work_core.tasks where id=p_task_id and tenant_id=t;
 select * into c from sales_core.contacts where id=w.contact_id and tenant_id=t;
 select raw_payload into source from commerce_sync.external_entities
  where id=w.external_entity_id and tenant_id=t and connection_id=w.connection_id;
 select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'courseId',h.course_id,'courseName',course.title_ar,
  'amountMinor',h.payment_amount_minor,'reference',h.payment_reference,'status',h.status,
  'paymentStatus',h.payment_status,'paidAt',h.paid_at,'updatedAt',h.updated_at,
  'linked',exists(select 1 from sales_core.commerce_admission_lines l where l.tenant_id=t and l.handoff_id=h.id))
  order by h.created_at desc),'[]') into candidates
 from academy.registration_handoffs h join academy.courses course on course.id=h.course_id and course.tenant_id=t
 where h.tenant_id=t and h.contact_id=c.id;
 financial:=private_app.commerce_payment_revision_v1(w.id);
 rev:=md5(jsonb_build_object('payment',financial,'contact',c.id,'owner',c.owner_staff_id,
  'assignee',w.assigned_staff_id,'routing',w.routing_state,'taskStatus',task.status,'candidates',candidates)::text);
 select * into review from sales_core.commerce_admission_reviews where tenant_id=t and work_item_id=w.id;
 if source is null or jsonb_typeof(source->'line_items') is distinct from 'array' then
  blockers:=blockers||'"woocommerce_items_missing"'::jsonb;items:='[]';
 else
  select coalesce(jsonb_agg(jsonb_build_object('lineId',i.line_id,'title',i.title,'quantity',i.quantity,
   'amountMinor',i.amount_minor,'suggestedCourseId',i.suggested_course_id)),'[]') into items
  from private_app.commerce_admission_items_v1(w.id) i;
  if jsonb_array_length(items)=0 or jsonb_array_length(items)>50 then blockers:=blockers||'"woocommerce_items_missing"'::jsonb;end if;
  if exists(select 1 from private_app.commerce_admission_items_v1(w.id) where quantity is distinct from 1::numeric)
   then blockers:=blockers||'"woocommerce_beneficiaries_required"'::jsonb;end if;
 end if;
 if w.payment_state<>'paid' or w.order_status not in ('completed','processing')
  or source->>'status' not in ('completed','processing') then blockers:=blockers||'"woocommerce_payment_unconfirmed"'::jsonb;end if;
 if w.paid_at is null or nullif(source#>>'{_marktone,paidAt}','') is null
  or private_app.woocommerce_try_timestamptz(source#>>'{_marktone,paidAt}') is distinct from w.paid_at
  then blockers:=blockers||'"woocommerce_payment_date_missing"'::jsonb;end if;
 if jsonb_array_length(coalesce(source->'refunds','[]'))>0 then blockers:=blockers||'"woocommerce_refund_review"'::jsonb;end if;
 if w.currency<>'SAR' or source->>'currency' is distinct from 'SAR' or w.minor_digits<>2 or coalesce(w.amount_minor,0)<=0
  or round(private_app.woocommerce_try_numeric(source->>'total')*100)::bigint is distinct from w.amount_minor
  then blockers:=blockers||'"woocommerce_currency_or_amount"'::jsonb;end if;
 if c.id is null then blockers:=blockers||'"woocommerce_customer_required"'::jsonb;end if;
 if w.routing_state<>'assigned' or w.assigned_staff_id is null then blockers:=blockers||'"woocommerce_assignment_required"'::jsonb;end if;
 if c.owner_staff_id is distinct from w.assigned_staff_id then blockers:=blockers||'"woocommerce_owner_transfer_required"'::jsonb;end if;
 select jsonb_build_object('submittedAt',o.submitted_at,'lines',(
  select jsonb_agg(jsonb_build_object('lineId',l.external_line_id,'handoffId',l.handoff_id,'courseId',l.course_id))
  from sales_core.commerce_admission_lines l where l.tenant_id=t and l.work_item_id=w.id)) into receipt
 from sales_core.commerce_admission_orders o where o.tenant_id=t and o.work_item_id=w.id;
 return jsonb_build_object('enabled',true,'revision',rev,'financialRevision',financial,'workItemId',w.id,
  'taskId',task.id,'taskStatus',task.status,'orderNumber',w.order_number,'contactName',c.full_name,
  'amountMinor',w.amount_minor,'currency',w.currency,'paidAt',w.paid_at,'timeZone',(select timezone from core.tenants where id=t),
  'canReview',can_review,'canComplete',private_app.has_tenant_permission(t,'tenant.work.write'),
  'reviewRequired',w.first_seen_at<r.enabled_at or jsonb_array_length(candidates)>0,
  'reviewValid',review.revision=rev,'reviewLines',case when review.revision=rev then review.lines else null end,
  'reviewReason',review.reason,'candidates',candidates,'items',items,'blockers',blockers,'receipt',receipt,
  'courses',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',title_ar) order by title_ar),'[]')
   from academy.courses where tenant_id=t and status='active'));
end $$;

-- Manager-only bounded dry run; the calendar loads order details on demand.
create function public.v1_tenant_woocommerce_admission_preview(p_tenant_slug text,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 if not private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute')
  and not private_app.has_tenant_permission(t,'tenant.admissions.write') then raise exception 'forbidden';end if;
 return jsonb_build_object('total',(select count(*) from sales_core.commerce_order_work_items w
  join work_core.tasks task on task.id=w.task_id and task.tenant_id=t where w.tenant_id=t and w.payment_state='paid'
   and task.status in ('todo','in_progress')),'items',(
  select coalesce(jsonb_agg(x),'[]') from (select w.id,w.task_id as "taskId",w.order_number as "orderNumber",
   w.amount_minor as "amountMinor",w.paid_at as "paidAt",c.full_name as "contactName",
   c.owner_staff_id is distinct from w.assigned_staff_id as "needsOwnershipTransfer",
   (select count(*) from academy.registration_handoffs h where h.tenant_id=t and h.contact_id=w.contact_id) as "candidateCount"
  from sales_core.commerce_order_work_items w join work_core.tasks task on task.id=w.task_id and task.tenant_id=t
  left join sales_core.contacts c on c.id=w.contact_id and c.tenant_id=t
  where w.tenant_id=t and w.payment_state='paid' and task.status in ('todo','in_progress')
  order by w.paid_at,w.id limit 100 offset greatest(0,coalesce(p_offset,0))) x));
end $$;

create function private_app.commerce_transfer_owner_v1(p_tenant uuid,p_contact uuid,p_staff uuid,p_order uuid)
returns void language plpgsql security definer set search_path='' as $$
declare c sales_core.contacts%rowtype; old_name text; new_name text; op uuid:=gen_random_uuid();
 a sales_core.lead_assignments%rowtype; replacement uuid;
begin
 select * into c from sales_core.contacts where tenant_id=p_tenant and id=p_contact for update;
 if c.id is null then raise exception 'woocommerce_customer_required';end if;
 select full_name into new_name from people.staff_profiles where tenant_id=p_tenant and id=p_staff
  and employment_status='active' and role_key in ('sales_user','sales_supervisor','sales_manager');
 if new_name is null then raise exception 'invalid_sales_assignee';end if;
 if c.owner_staff_id=p_staff then return;end if;
 select full_name into old_name from people.staff_profiles where tenant_id=p_tenant and id=c.owner_staff_id;
 old_name:=coalesce(old_name,'غير مسند');
 -- Keep distribution history; a replacement is explicitly a reassignment, never a fresh lead.
 for a in select * from sales_core.lead_assignments where tenant_id=p_tenant and contact_id=c.id
  and status='active' order by id for update loop
  replacement:=gen_random_uuid();
  update sales_core.lead_assignments set status='reassigned',completed_at=now(),
   metadata=metadata||jsonb_build_object('replacementAssignmentId',replacement,'reassignmentOperationId',op,
    'reassignedToStaffId',p_staff,'reassignmentReason','إسناد طلب WooCommerce') where id=a.id;
  insert into sales_core.lead_assignments(id,tenant_id,batch_id,import_row_id,contact_id,opportunity_id,task_id,
   assigned_staff_id,assigned_by_staff_id,assigned_by_subject_id,assignment_strategy,status,assigned_at,deadline_at,metadata)
  values(replacement,p_tenant,a.batch_id,a.import_row_id,c.id,a.opportunity_id,a.task_id,p_staff,
   private_app.current_staff_id(p_tenant),private_app.current_subject_id(),'selected','active',now(),
   greatest(a.deadline_at,now()+interval '1 day'),a.metadata||jsonb_build_object('source','manual_reassignment',
    'previousAssignmentId',a.id,'previousStaffId',c.owner_staff_id,'previousStaffName',old_name,
    'reassignmentOperationId',op,'reassignmentReason','إسناد طلب WooCommerce','commerceWorkItemId',p_order));
 end loop;
 update sales_core.contacts set owner_staff_id=p_staff,metadata=metadata||jsonb_build_object('lastReassignment',
  jsonb_build_object('at',now(),'fromStaffId',c.owner_staff_id,'fromStaffName',old_name,'toStaffId',p_staff,
   'toStaffName',new_name,'reason','إسناد طلب WooCommerce','operationId',op)) where tenant_id=p_tenant and id=c.id;
 update sales_core.opportunities set owner_staff_id=p_staff,
  metadata=metadata||jsonb_build_object('lastReassignmentOperationId',op,'previousOwnerStaffId',c.owner_staff_id)
  where tenant_id=p_tenant and contact_id=c.id and status in ('open','pending_verification');
 update work_core.tasks set assigned_staff_id=p_staff,metadata=metadata||jsonb_build_object('reassignmentOperationId',op)
  where tenant_id=p_tenant and contact_id=c.id and status in ('todo','in_progress') and metadata->>'source' in
  ('lead_assignment','sales_followup','opportunity_next_action','activity_next_action','lead_next_action');
 insert into sales_core.activities(tenant_id,activity_key,contact_id,actor_staff_id,activity_type,summary,
  created_by_subject_id,metadata) values(p_tenant,'woo-owner-'||op,c.id,private_app.current_staff_id(p_tenant),'note',
  'إسناد العميل من '||old_name||' إلى '||new_name||' بسبب طلب WooCommerce',private_app.current_subject_id(),
  jsonb_build_object('source','lead_reassignment_audit','operationId',op,'commerceWorkItemId',p_order,
   'fromStaffId',c.owner_staff_id,'toStaffId',p_staff));
 with recipients as (
  select c.owner_staff_id id union select p_staff union
  select s.id from people.staff_profiles s join access_control.memberships m on m.id=s.membership_id
   and m.tenant_id=p_tenant and m.status='active'
  join access_control.membership_roles mr on mr.membership_id=m.id join access_control.roles role on role.id=mr.role_id
  where s.tenant_id=p_tenant and s.employment_status='active' and role.scope='tenant'
   and role.role_key in ('tenant_owner','tenant_admin','executive_manager','sales_manager','sales_supervisor')
 ) insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,
  action_path,contact_id,metadata)
 select p_tenant,'woo-owner:'||op,r.id,'lead_reassigned','تغيير إسناد العميل: '||c.full_name,
  'تم نقل ملكية العميل من '||old_name||' إلى '||new_name||' واحتساب بيع طلب WooCommerce للمسؤول الجديد.',
  'lead-queue',c.id,jsonb_build_object('operationId',op,'workItemId',p_order,'fromStaffId',c.owner_staff_id,'toStaffId',p_staff)
 from recipients r where r.id is not null on conflict(tenant_id,notification_key,recipient_staff_id) do nothing;
 perform private_app.write_audit('tenant.woocommerce_owner_transferred','contact',c.id::text,p_tenant,
  jsonb_build_object('operationId',op,'workItemId',p_order,'fromStaffId',c.owner_staff_id,'toStaffId',p_staff));
end $$;

alter function public.v3_tenant_commerce_order_action(text,text,jsonb) set schema private_app;
alter function private_app.v3_tenant_commerce_order_action(text,text,jsonb) rename to commerce_order_action_before_admissions_v1;
revoke all on function private_app.commerce_order_action_before_admissions_v1(text,text,jsonb) from public,anon,authenticated,service_role;
create function public.v4_tenant_commerce_order_action(p_tenant_slug text,p_action text,p_payload jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; ids uuid[]; row record; result jsonb;
begin
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 if not exists(select 1 from sales_core.commerce_admission_rollouts where tenant_id=t and enabled)
  or p_action not in ('assign','auto_distribute') then
  return private_app.commerce_order_action_before_admissions_v1(p_tenant_slug,p_action,p_payload);end if;
 if not private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute') then raise exception 'forbidden';end if;
 if jsonb_typeof(p_payload->'itemIds') is distinct from 'array' or jsonb_array_length(p_payload->'itemIds') not between 1 and 100
  then raise exception 'commerce_order_work_items_required';end if;
 select array_agg(distinct value::uuid) into ids from jsonb_array_elements_text(p_payload->'itemIds');
 -- Match the sync worker's connection lock before touching task/contact rows.
 perform pg_advisory_xact_lock(hashtextextended('woocommerce-order-routing:'||t,2401));
 perform 1 from commerce_sync.connections where tenant_id=t and id in (
  select connection_id from sales_core.commerce_order_work_items where tenant_id=t and id=any(ids)) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text,3917));
 for row in select distinct contact_id from sales_core.commerce_order_work_items where tenant_id=t and id=any(ids)
  and contact_id is not null order by contact_id loop
  perform pg_advisory_xact_lock(hashtextextended(t::text||':'||row.contact_id::text,31603));
  perform 1 from sales_core.contacts where tenant_id=t and id=row.contact_id for update;
 end loop;
 result:=private_app.commerce_order_action_before_admissions_v1(p_tenant_slug,p_action,p_payload);
 if exists(select 1 from sales_core.commerce_order_work_items w join work_core.tasks task on task.id=w.task_id
  where w.tenant_id=t and w.id=any(ids) and w.contact_id is not null and task.status in ('todo','in_progress')
  group by w.contact_id having count(distinct w.assigned_staff_id)>1) then raise exception 'woocommerce_owner_conflict';end if;
 for row in select w.* from sales_core.commerce_order_work_items w join work_core.tasks task on task.id=w.task_id
  where w.tenant_id=t and w.id=any(ids) and w.contact_id is not null and task.status in ('todo','in_progress')
  and w.routing_state='assigned' order by w.contact_id,w.id loop
  perform private_app.commerce_transfer_owner_v1(t,row.contact_id,row.assigned_staff_id,row.id);
 end loop;
 return result;
end $$;

create function public.v3_tenant_commerce_order_action(p_tenant_slug text,p_action text,p_payload jsonb default '{}')
returns jsonb language sql security definer set search_path='' as $$
 select public.v4_tenant_commerce_order_action(p_tenant_slug,p_action,p_payload)
$$;
revoke all on function public.v3_tenant_commerce_order_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v3_tenant_commerce_order_action(text,text,jsonb) to authenticated;

create function public.v1_tenant_woocommerce_admission_action(p_tenant_slug text,p_task_id uuid,p_action text,
 p_expected_revision text,p_command_id uuid,p_lines jsonb default '[]',p_reason text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; w sales_core.commerce_order_work_items%rowtype; ctx jsonb; before_ctx jsonb; choices jsonb;
 request_hash text; old_command sales_core.commerce_admission_commands%rowtype; result jsonb;
 item record; choice jsonb; course uuid; v_handoff academy.registration_handoffs%rowtype; hid uuid; oid uuid;
 aid uuid; did uuid; stage uuid; ref text; v_metadata jsonb; can_review boolean; line_ids text[]; chosen_ids text[];
begin
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 if p_command_id is null or p_action not in ('review','complete') or p_expected_revision is null
  or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines)>50
  then raise exception 'invalid_commerce_order_payload';end if;
 request_hash:=md5(jsonb_build_object('task',p_task_id,'action',p_action,'revision',p_expected_revision,
  'lines',p_lines,'reason',p_reason)::text);
 -- Authorize even replayed commands. The old agent cannot replay after a reassignment.
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 if ctx->>'enabled' is distinct from 'true' then raise exception 'woocommerce_admissions_disabled';end if;
 select * into w from sales_core.commerce_order_work_items where tenant_id=t and task_id=p_task_id;
 perform 1 from commerce_sync.connections where id=w.connection_id and tenant_id=t for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text,3917));
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||w.contact_id::text,31603));
 perform 1 from sales_core.contacts where id=w.contact_id and tenant_id=t for update;
 perform 1 from sales_core.commerce_order_work_items where id=w.id and tenant_id=t for update;
 perform 1 from work_core.tasks where id=p_task_id and tenant_id=t for update;
 perform 1 from academy.registration_handoffs where tenant_id=t and contact_id=w.contact_id order by id for update;
 select * into w from sales_core.commerce_order_work_items where tenant_id=t and task_id=p_task_id;
 select * into old_command from sales_core.commerce_admission_commands where tenant_id=t and command_id=p_command_id;
 if old_command.command_id is not null then
  if old_command.actor_id<>private_app.current_subject_id() or old_command.request_hash<>request_hash
   then raise exception 'woocommerce_command_conflict';end if;
  return old_command.result||jsonb_build_object('replayed',true);
 end if;
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 if ctx->>'revision' is distinct from p_expected_revision then raise exception 'woocommerce_order_changed';end if;
 if ctx->'receipt' is distinct from 'null'::jsonb then raise exception 'woocommerce_already_submitted';end if;
 if ctx->>'taskStatus' not in ('todo','in_progress') then raise exception 'task_closed';end if;
 can_review:=(ctx->>'canReview')::boolean;
 before_ctx:=ctx;
 if p_action='review' then
  if not can_review then raise exception 'forbidden';end if;
  if length(trim(coalesce(p_reason,''))) not between 3 and 1000 then raise exception 'woocommerce_review_reason_required';end if;
  -- The user explicitly authorized transferring legacy assigned orders too. Each review is audited.
  if ctx->'blockers' ? 'woocommerce_owner_transfer_required' then
   if not private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute') then raise exception 'woocommerce_owner_transfer_required';end if;
   perform private_app.commerce_transfer_owner_v1(t,w.contact_id,w.assigned_staff_id,w.id);
   ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
  end if;
 elsif not (ctx->>'canComplete')::boolean then raise exception 'forbidden';
 end if;
 if jsonb_array_length(ctx->'blockers')>0 then raise exception '%',ctx->'blockers'->>0;end if;
 if p_action='complete' and (ctx->>'reviewRequired')::boolean then
  if ctx->>'reviewValid' is distinct from 'true' then raise exception 'woocommerce_review_required';end if;
  choices:=ctx->'reviewLines';
  -- Sales cannot change an approved course or linkage from a second tab/API client.
  if p_lines<>choices then raise exception 'woocommerce_review_changed';end if;
 else choices:=p_lines;end if;
 select array_agg(line_id order by line_id) into line_ids from private_app.commerce_admission_items_v1(w.id);
 select array_agg(value->>'lineId' order by value->>'lineId') into chosen_ids from jsonb_array_elements(choices);
 if line_ids is distinct from chosen_ids or array_position(line_ids,null) is not null
  or cardinality(line_ids)<>(select count(distinct x) from unnest(line_ids) x) then raise exception 'woocommerce_choose_all_courses';end if;
 if exists(select 1 from jsonb_array_elements(choices) x where nullif(x->>'handoffId','') is not null
  group by x->>'handoffId' having count(*)>1) then raise exception 'woocommerce_duplicate_handoff';end if;
 -- A reference already pointing to this order cannot be bypassed by selecting "new".
 if exists(select 1 from academy.registration_handoffs h where h.tenant_id=t and h.contact_id=w.contact_id
  and h.payment_status='verified' and h.payment_reference in(w.order_number,'WooCommerce #'||w.order_number)
  and not exists(select 1 from sales_core.commerce_admission_lines l where l.tenant_id=t and l.handoff_id=h.id)
  and not exists(select 1 from jsonb_array_elements(choices) x where x->>'handoffId'=h.id::text))
  then raise exception 'woocommerce_existing_payment_unlinked';end if;
 for item in select * from private_app.commerce_admission_items_v1(w.id) loop
  select value into choice from jsonb_array_elements(choices) where value->>'lineId'=item.line_id;
  course:=nullif(choice->>'courseId','')::uuid;
  if not exists(select 1 from academy.courses where id=course and tenant_id=t and status='active')
   then raise exception 'invalid_course';end if;
  hid:=nullif(choice->>'handoffId','')::uuid;
  if hid is not null then
   if not can_review and not coalesce((ctx->>'reviewValid')::boolean,false) then raise exception 'forbidden';end if;
   select * into v_handoff from academy.registration_handoffs where id=hid and tenant_id=t and contact_id=w.contact_id for update;
   if v_handoff.id is null or v_handoff.payment_status in ('rejected','refunded') or v_handoff.status in ('cancelled','rejected')
    then raise exception 'woocommerce_invalid_existing_admission';end if;
   if exists(select 1 from sales_core.commerce_admission_lines where tenant_id=t and handoff_id=hid)
    then raise exception 'woocommerce_duplicate_handoff';end if;
   if v_handoff.payment_amount_minor is distinct from item.amount_minor or (v_handoff.status='completed' and v_handoff.course_id<>course)
    then raise exception 'woocommerce_existing_payment_mismatch';end if;
   if exists(select 1 from incentives_core.events e where e.tenant_id=t and e.source_type='registration_handoff'
    and e.source_id=hid and e.staff_id<>w.assigned_staff_id and e.state in ('approved','paid'))
    then raise exception 'woocommerce_settled_incentive_review';end if;
  end if;
 end loop;
 if p_action='review' then
  insert into sales_core.commerce_admission_reviews(tenant_id,work_item_id,revision,lines,reason,reviewed_by)
  values(t,w.id,ctx->>'revision',choices,trim(p_reason),private_app.current_subject_id())
  on conflict(tenant_id,work_item_id) do update set revision=excluded.revision,lines=excluded.lines,
   reason=excluded.reason,reviewed_by=excluded.reviewed_by,reviewed_at=now();
  result:=jsonb_build_object('reviewed',true,'taskId',p_task_id);
 else
  select id into stage from sales_core.pipeline_stages where tenant_id=t and is_won order by position,id limit 1;
  if stage is null then raise exception 'sales_pipeline_not_configured';end if;
  select id into did from people.departments where tenant_id=t and department_key='admissions' and status='active' limit 1;
  select id into aid from people.staff_profiles where tenant_id=t and employment_status='active'
   and (department_id=did or role_key='customer_service') order by (department_id=did) desc,created_at,id limit 1;
  if aid is null then raise exception 'woocommerce_admissions_staff_required';end if;
  insert into sales_core.commerce_admission_orders(tenant_id,work_item_id,contact_id,sales_staff_id,
   amount_minor,currency,paid_at,submitted_by,source_revision,review_reason)
  values(t,w.id,w.contact_id,w.assigned_staff_id,w.amount_minor,w.currency,w.paid_at,private_app.current_subject_id(),
   ctx->>'financialRevision',ctx->>'reviewReason');
  for item in select * from private_app.commerce_admission_items_v1(w.id) loop
   select value into choice from jsonb_array_elements(choices) where value->>'lineId'=item.line_id;
   course:=(choice->>'courseId')::uuid;hid:=nullif(choice->>'handoffId','')::uuid;
   ref:='WooCommerce #'||w.order_number;
   v_metadata:=jsonb_build_object('source','woocommerce_order','commerceWorkItemId',w.id,'externalOrderId',w.external_order_id,
    'connectionId',w.connection_id,'externalLineId',item.line_id,'currency',w.currency,'salesStaffId',w.assigned_staff_id,
    'paymentEvidence','woocommerce_sync','submittedAt',now(),'sourcePaidAt',w.paid_at);
   if hid is null then
    insert into sales_core.opportunities(tenant_id,opportunity_key,contact_id,course_id,stage_id,owner_staff_id,
     title,value_minor,currency,status,created_by_subject_id,metadata)
    values(t,'woo-admission-'||w.id||'-'||item.line_id,w.contact_id,course,stage,w.assigned_staff_id,
     ref||' · '||item.title,item.amount_minor,w.currency,'won',private_app.current_subject_id(),v_metadata) returning id into oid;
    -- Insert pending then confirm after the line identity is recorded; automation and incentives use their existing hooks.
    insert into academy.registration_handoffs(tenant_id,handoff_key,contact_id,opportunity_id,course_id,
     assigned_department_id,assigned_staff_id,status,paid_at,payment_status,payment_reported_at,
     payment_amount_minor,payment_reference,notes,created_by_subject_id,metadata)
    values(t,'woo-'||w.id||'-'||item.line_id,w.contact_id,oid,course,did,aid,'in_review',w.paid_at,
     'pending_verification',now(),item.amount_minor,ref,'طلب مدفوع من WooCommerce؛ بانتظار تحديد الدفعة',
     private_app.current_subject_id(),v_metadata) returning id into hid;
   else
    select * into v_handoff from academy.registration_handoffs where id=hid and tenant_id=t;
    oid:=v_handoff.opportunity_id;
    if oid is null then raise exception 'woocommerce_existing_payment_mismatch';end if;
    update incentives_core.events set state='cancelled',metadata=metadata||jsonb_build_object(
     'reason','woocommerce_sales_owner_transfer','newStaffId',w.assigned_staff_id),updated_at=now()
     where tenant_id=t and source_type='registration_handoff' and source_id=hid and staff_id<>w.assigned_staff_id
      and state not in ('approved','paid','cancelled','refunded');
    update sales_core.opportunities set owner_staff_id=w.assigned_staff_id,course_id=course,stage_id=stage,
     value_minor=item.amount_minor,status='won',next_action_type=null,next_action_at=null,metadata=metadata||
     jsonb_build_object('commerceWorkItemId',w.id,'externalLineId',item.line_id)
     where tenant_id=t and id=oid;
   end if;
   insert into sales_core.commerce_admission_lines(tenant_id,work_item_id,external_line_id,course_id,handoff_id,allocated_minor,reused)
   values(t,w.id,item.line_id,course,hid,item.amount_minor,nullif(choice->>'handoffId','') is not null);
   update academy.registration_handoffs h set course_id=course,
    status=case when h.status in ('pending','in_review') then 'in_review' else h.status end,
    assigned_department_id=coalesce(h.assigned_department_id,did),assigned_staff_id=coalesce(h.assigned_staff_id,aid),
    payment_status='verified',payment_verified_at=coalesce(h.payment_verified_at,now()),
    payment_rejection_reason=null,metadata=h.metadata||v_metadata
    where h.tenant_id=t and h.id=hid;
   insert into academy.registration_documents(tenant_id,handoff_id,document_type,is_required,status)
   select t,hid,x,false,case when x='payment_receipt' then 'approved' else 'pending' end
    from unnest(array['payment_receipt','national_id','qualification','personal_photo']) x
    on conflict(handoff_id,document_type) do nothing;
   if not exists(select 1 from academy.registration_handoffs where id=hid and status='completed') then
    insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,
     contact_id,opportunity_id,starts_at,due_at,metadata)
    values(t,'registration-'||hid,'تسجيل العميل: '||(ctx->>'contactName'),ref||' · '||item.title,'todo','high',aid,
     w.contact_id,oid,now(),now()+interval '1 day',jsonb_build_object('source','registration_handoff','handoffId',hid,
      'commerceWorkItemId',w.id,'paymentStatus','verified')) on conflict(tenant_id,task_key) do nothing;
   end if;
   insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,
    severity,action_path,contact_id,handoff_id,metadata)
   values(t,'woo-admission:'||hid,aid,'woocommerce_admission','طلب تسجيل بدفع مؤكد',ref||' · '||item.title,
    'success','admissions',w.contact_id,hid,jsonb_build_object('workItemId',w.id))
    on conflict(tenant_id,notification_key,recipient_staff_id) do nothing;
  end loop;
  if (select sum(allocated_minor) from sales_core.commerce_admission_lines where tenant_id=t and work_item_id=w.id)
   <>w.amount_minor then raise exception 'woocommerce_allocation_mismatch';end if;
  insert into sales_core.lead_status_history(tenant_id,contact_id,from_status,to_status,reason,changed_by_subject_id,metadata)
   select t,c.id,c.lead_status,'paid','دفع WooCommerce مؤكد',private_app.current_subject_id(),jsonb_build_object('workItemId',w.id)
   from sales_core.contacts c where c.tenant_id=t and c.id=w.contact_id and c.lead_status<>'paid';
  update sales_core.contacts set lead_status='paid',lead_status_changed_at=case when lead_status<>'paid' then now()
   else lead_status_changed_at end,interest_course_id=coalesce(interest_course_id,(choices->0->>'courseId')::uuid)
   where tenant_id=t and id=w.contact_id;
  -- The receipt exists before this update; the generic completion guard cannot be bypassed from old tabs.
  update work_core.tasks set status='completed',completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end,
   metadata=metadata||jsonb_build_object('admissionSubmitted',true,'commerceWorkItemId',w.id,'completedBySubjectId',private_app.current_subject_id())
   where id=p_task_id and tenant_id=t;
  result:=jsonb_build_object('completed',true,'taskId',p_task_id,'handoffs',(
   select jsonb_agg(jsonb_build_object('id',handoff_id,'courseId',course_id,'reused',reused))
   from sales_core.commerce_admission_lines where tenant_id=t and work_item_id=w.id));
 end if;
 perform private_app.write_audit('tenant.woocommerce_admission_'||p_action,'commerce_order_work_item',w.id::text,t,
  jsonb_build_object('commandId',p_command_id,'before',before_ctx-'courses'-'candidates','lines',choices,
   'reason',p_reason,'result',result));
 insert into sales_core.commerce_admission_commands(tenant_id,command_id,actor_id,request_hash,result)
 values(t,p_command_id,private_app.current_subject_id(),request_hash,result);
 return result;
end $$;

-- Match the contact-first lock order used by follow-up and Woo completion.
-- The prior admission RPC locked handoff before contact, which could deadlock a concurrent handoff review.
alter function public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text) set schema private_app;
alter function private_app.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text)
 rename to update_admission_before_commerce_v1;
revoke all on function private_app.update_admission_before_commerce_v1(text,uuid,text,uuid,uuid,text,text)
 from public,anon,authenticated,service_role;
create function public.v2_tenant_update_admission(p_tenant_slug text,p_handoff_id uuid,p_action text,
 p_course_id uuid default null,p_course_run_id uuid default null,p_notes text default null,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; contact uuid;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.current_subject_id() is null or t is null or not private_app.has_tenant_permission(t,'tenant.admissions.write')
  then raise exception 'forbidden';end if;
 select contact_id into contact from academy.registration_handoffs where tenant_id=t and id=p_handoff_id;
 if contact is null then raise exception 'admission_not_found';end if;
 perform 1 from commerce_sync.connections where tenant_id=t and id in (
  select w.connection_id from sales_core.commerce_admission_lines l join sales_core.commerce_order_work_items w
   on w.tenant_id=t and w.id=l.work_item_id where l.tenant_id=t and l.handoff_id=p_handoff_id) order by id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||contact::text,31603));
 perform 1 from sales_core.contacts where tenant_id=t and id=contact for update;
 return private_app.update_admission_before_commerce_v1(p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason);
end $$;
revoke all on function public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text) to authenticated;

create function private_app.commerce_task_completion_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.status='completed' and old.status is distinct from new.status and new.metadata->>'source'='woocommerce_order'
  and exists(select 1 from sales_core.commerce_admission_rollouts where tenant_id=new.tenant_id and enabled)
  and exists(select 1 from sales_core.commerce_order_work_items w where w.tenant_id=new.tenant_id and w.task_id=new.id
   and w.payment_state='paid' and not exists(select 1 from sales_core.commerce_admission_orders o
    where o.tenant_id=w.tenant_id and o.work_item_id=w.id)) then raise exception 'woocommerce_choose_all_courses';end if;
 return new;
end $$;
create trigger commerce_task_completion_guard_v1 before update of status on work_core.tasks
 for each row execute function private_app.commerce_task_completion_guard_v1();

create function private_app.commerce_admission_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare source sales_core.commerce_admission_orders%rowtype; course uuid;
begin
 select o.* into source from sales_core.commerce_admission_orders o
  join sales_core.commerce_admission_lines l on l.tenant_id=o.tenant_id and l.work_item_id=o.work_item_id
  where l.tenant_id=new.tenant_id and l.handoff_id=new.id;
 -- The line is the immutable purchased course; admissions selects its batch.
 select l.course_id into course from sales_core.commerce_admission_lines l where l.tenant_id=new.tenant_id and l.handoff_id=new.id;
 if source.work_item_id is null then return new;end if;
 if new.course_id<>course then raise exception 'woocommerce_course_locked';end if;
 if new.payment_status='verified' and (new.status is distinct from old.status or new.course_run_id is distinct from old.course_run_id
  or new.payment_status is distinct from old.payment_status) and
  source.source_revision is distinct from private_app.commerce_payment_revision_v1(source.work_item_id)
  then raise exception 'woocommerce_payment_changed';end if;
 return new;
end $$;
create trigger commerce_admission_guard_v1 before update of status,payment_status,course_id,course_run_id
 on academy.registration_handoffs for each row execute function private_app.commerce_admission_guard_v1();

-- A refund or edited source is never silently treated as a still-verified payment.
-- Preserve the amount/enrollment history and notify admissions for resolution.
create function private_app.commerce_admission_source_change_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare source sales_core.commerce_admission_orders%rowtype; revision text; h record;
begin
 select * into source from sales_core.commerce_admission_orders where tenant_id=new.tenant_id and work_item_id=new.id;
 if source.work_item_id is null then return new;end if;
 revision:=private_app.commerce_payment_revision_v1(new.id);
 if revision is not distinct from source.source_revision then return new;end if;
 for h in select handoff.* from academy.registration_handoffs handoff join sales_core.commerce_admission_lines l
  on l.tenant_id=handoff.tenant_id and l.handoff_id=handoff.id
  where l.tenant_id=new.tenant_id and l.work_item_id=new.id order by handoff.id for update of handoff loop
  if h.metadata->>'commerceSourceHold' is not distinct from revision then continue;end if;
  update academy.registration_handoffs set payment_status=case when new.payment_state='refunded' then 'refunded'
   else 'pending_verification' end,metadata=metadata||jsonb_build_object('commerceSourceHold',revision,
    'commerceSourceHoldAt',now(),'commercePreviousPaymentStatus',h.payment_status)
   where tenant_id=new.tenant_id and id=h.id;
  if h.assigned_staff_id is not null then
   insert into work_core.notifications(tenant_id,notification_key,recipient_staff_id,notification_type,title,message,
    severity,action_path,contact_id,handoff_id,metadata)
   values(new.tenant_id,'woo-payment-change:'||h.id||':'||coalesce(revision,'missing'),h.assigned_staff_id,
    'woocommerce_payment_review','تغيرت بيانات دفع WooCommerce',
    'طلب #'||new.order_number||': راجع الدفع أو الاسترداد قبل استكمال التسجيل.','warning','admissions',new.contact_id,h.id,
    jsonb_build_object('workItemId',new.id,'sourceRevision',revision))
   on conflict(tenant_id,notification_key,recipient_staff_id) do nothing;
  end if;
 end loop;
 return new;
end $$;
create trigger commerce_admission_source_change_v1 after update on sales_core.commerce_order_work_items
 for each row execute function private_app.commerce_admission_source_change_v1();

create function public.v3_tenant_admissions_snapshot(p_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; t uuid;
begin
 result:=public.v2_tenant_admissions_snapshot(p_slug);
 select id into t from core.tenants where slug=p_slug;
 return result||jsonb_build_object('cases',(select coalesce(jsonb_agg(
  case when o.work_item_id is null then x.value else x.value||jsonb_build_object('paymentSource','woocommerce',
   'paymentSourceLabel','WooCommerce','sourcePaidAt',o.paid_at,'submittedAt',o.submitted_at,
   'salesOwnerName',s.full_name,'orderNumber',w.order_number,'paymentOnHold',h.metadata ? 'commerceSourceHold') end
  order by x.ordinality),'[]') from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)
  left join sales_core.commerce_admission_lines l on l.tenant_id=t and l.handoff_id=(x.value->>'id')::uuid
  left join sales_core.commerce_admission_orders o on o.tenant_id=l.tenant_id and o.work_item_id=l.work_item_id
  left join sales_core.commerce_order_work_items w on w.tenant_id=t and w.id=o.work_item_id
  left join academy.registration_handoffs h on h.tenant_id=t and h.id=l.handoff_id
  left join people.staff_profiles s on s.tenant_id=t and s.id=o.sales_staff_id));
end $$;

create function public.v4_tenant_commerce_order_queue_snapshot(p_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 result:=public.v3_tenant_commerce_order_queue_snapshot(p_slug);
 return result||jsonb_build_object('admissionsEnabled',exists(select 1 from sales_core.commerce_admission_rollouts r
  join core.tenants t on t.id=r.tenant_id where t.slug=p_slug and r.enabled));
end $$;
revoke all on function public.v4_tenant_commerce_order_queue_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v4_tenant_commerce_order_queue_snapshot(text) to authenticated;

-- Private helpers remain inaccessible even through PostgREST's exposed RPC namespace.
revoke all on function private_app.commerce_admission_tenant_v1(text),private_app.commerce_payment_revision_v1(uuid),
 private_app.commerce_admission_items_v1(uuid),private_app.commerce_transfer_owner_v1(uuid,uuid,uuid,uuid),
 private_app.commerce_task_completion_guard_v1(),private_app.commerce_admission_guard_v1(),
 private_app.commerce_admission_source_change_v1() from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_woocommerce_admission_context(text,uuid),
 public.v1_tenant_woocommerce_admission_preview(text,integer),public.v4_tenant_commerce_order_action(text,text,jsonb),
 public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text),public.v3_tenant_admissions_snapshot(text)
 from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_woocommerce_admission_context(text,uuid),
 public.v1_tenant_woocommerce_admission_preview(text,integer),public.v4_tenant_commerce_order_action(text,text,jsonb),
 public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text),public.v3_tenant_admissions_snapshot(text)
 to authenticated;

CREATE OR REPLACE FUNCTION private_app.sync_incentive_source(p_handoff_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_handoff academy.registration_handoffs%rowtype;
  v_contact sales_core.contacts%rowtype;
  v_row record;
  v_metric numeric;
  v_revenue numeric;
  v_achievement numeric;
  v_amount numeric;
  v_state text;
  v_hold timestamptz;
  v_course_name text;
begin
  select * into v_handoff
  from academy.registration_handoffs
  where id = p_handoff_id;
  if v_handoff.id is null then return; end if;

  select * into v_contact
  from sales_core.contacts
  where id = v_handoff.contact_id;
  -- A Woo sale keeps the owner who received this order, even after a later purchase transfers the contact.
  select coalesce((select o.sales_staff_id from sales_core.commerce_admission_lines l
    join sales_core.commerce_admission_orders o on o.tenant_id=l.tenant_id and o.work_item_id=l.work_item_id
    where l.tenant_id=v_handoff.tenant_id and l.handoff_id=v_handoff.id),v_contact.owner_staff_id)
    into v_contact.owner_staff_id;
  if v_contact.owner_staff_id is null then return; end if;

  select c.title_ar into v_course_name
  from academy.courses c
  where c.id = v_handoff.course_id;

  for v_row in
    select a as assignment_row, p as plan_row
    from incentives_core.assignments a
    join incentives_core.plans p on p.id = a.plan_id
    where a.tenant_id = v_handoff.tenant_id
      and a.staff_id = v_contact.owner_staff_id
      and a.active
      and p.status = 'active'
      and v_handoff.created_at::date between p.period_start and p.period_end
      and (
        p.scope_type not in ('course','campaign')
        or (p.scope_type = 'course' and p.scope_reference = v_handoff.course_id::text)
        or (p.scope_type = 'campaign' and p.scope_reference = coalesce(v_contact.campaign_name,''))
      )
  loop
    v_revenue := coalesce(v_handoff.payment_amount_minor,0)::numeric / 100;
    v_metric := case
      when (v_row.plan_row).metric_type in ('revenue','collections') then v_revenue
      else 1
    end;
    select coalesce(sum(e.metric_value),0) + v_metric
    into v_achievement
    from incentives_core.events e
    where e.assignment_id = (v_row.assignment_row).id
      and e.state not in ('cancelled','refunded')
      and not (e.source_type = 'registration_handoff' and e.source_id = v_handoff.id);

    v_amount := private_app.calculate_incentive(
      v_row.plan_row, v_metric, v_revenue, v_achievement
    );
    v_state := private_app.incentive_source_state(v_row.plan_row, v_handoff);
    v_hold := case
      when v_state = 'pending'
       and (v_row.plan_row).cancellation_window_days > 0
       and (
         v_handoff.payment_status = 'verified'
         or v_handoff.status in ('accepted','completed')
       )
      then coalesce(v_handoff.payment_verified_at,v_handoff.accepted_at,now())
           + make_interval(days => (v_row.plan_row).cancellation_window_days)
      else null
    end;

    insert into incentives_core.events(
      tenant_id, assignment_id, staff_id, source_type, source_id,
      customer_name, course_name, campaign_name, metric_value, revenue_amount,
      incentive_amount, state, hold_until, occurred_at, plan_snapshot, metadata
    ) values (
      v_handoff.tenant_id, (v_row.assignment_row).id, (v_row.assignment_row).staff_id,
      'registration_handoff', v_handoff.id, v_contact.full_name, v_course_name,
      v_contact.campaign_name, v_metric, v_revenue, v_amount, v_state, v_hold,
      v_handoff.created_at,
      jsonb_build_object(
        'planId',(v_row.plan_row).id,'title',(v_row.plan_row).title,
        'metricType',(v_row.plan_row).metric_type,
        'calculationType',(v_row.plan_row).calculation_type,
        'incentiveValue',(v_row.plan_row).incentive_value,
        'tiers',(v_row.plan_row).tiers,'earningTrigger',(v_row.plan_row).earning_trigger
      ),
      jsonb_build_object(
        'paymentStatus',v_handoff.payment_status,
        'registrationStatus',v_handoff.status,
        'paymentReference',v_handoff.payment_reference
      )
    )
    on conflict (assignment_id, source_type, source_id)
      where source_id is not null
    do update set
      customer_name = excluded.customer_name,
      course_name = excluded.course_name,
      campaign_name = excluded.campaign_name,
      metric_value = excluded.metric_value,
      revenue_amount = excluded.revenue_amount,
      incentive_amount = case
        when incentives_core.events.state in ('approved','paid')
          then incentives_core.events.incentive_amount
        else excluded.incentive_amount
      end,
      state = case
        when incentives_core.events.state in ('approved','paid')
          then incentives_core.events.state
        else excluded.state
      end,
      hold_until = excluded.hold_until,
      metadata = excluded.metadata,
      updated_at = now();
  end loop;
end
$function$;

commit;
