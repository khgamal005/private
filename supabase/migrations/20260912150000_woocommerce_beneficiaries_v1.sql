-- ODEIR only. Forward, additive release; no tenant activation or customer backfill.
-- Financial handoffs stay at purchased-line granularity. Seats are learner entitlements,
-- not extra payment reports, opportunities, or incentive sources.
begin;

create unique index if not exists commerce_enrollments_tenant_id_idx on academy.enrollments(tenant_id,id);
create table sales_core.commerce_order_beneficiaries (
 id uuid primary key default gen_random_uuid(),
 tenant_id uuid not null,
 work_item_id uuid not null,
 external_line_id text not null,
 seat_number integer not null check(seat_number between 1 and 100),
 contact_id uuid not null,
 handoff_id uuid,
 enrollment_id uuid,
 allocated_minor bigint check(allocated_minor>=0),
 source_revision text not null,
 selected_by uuid not null references access_control.subjects(id),
 selected_at timestamptz not null default now(),
 unique(tenant_id,id),
 unique(tenant_id,work_item_id,external_line_id,seat_number),
 unique(tenant_id,work_item_id,external_line_id,contact_id),
 unique(enrollment_id),
 foreign key(tenant_id,work_item_id) references sales_core.commerce_order_work_items(tenant_id,id),
 foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id),
 foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id)
);
create index commerce_beneficiaries_handoff_idx on sales_core.commerce_order_beneficiaries(tenant_id,handoff_id,seat_number);
create index commerce_beneficiaries_contact_idx on sales_core.commerce_order_beneficiaries(tenant_id,contact_id);
create index commerce_beneficiaries_actor_idx on sales_core.commerce_order_beneficiaries(selected_by);
alter table sales_core.commerce_order_beneficiaries enable row level security;
revoke all on sales_core.commerce_order_beneficiaries from public,anon,authenticated,service_role;

-- Preserve the ordinary one-handoff/one-enrollment contract. Only explicit Woo seats
-- may add further enrollments. Historical enrollments are reused without rewriting them.
alter table academy.enrollments add column commerce_seat_id uuid;
alter table academy.enrollments add constraint enrollment_commerce_seat_fk
 foreign key(tenant_id,commerce_seat_id) references sales_core.commerce_order_beneficiaries(tenant_id,id);
alter table academy.enrollments drop constraint enrollments_handoff_id_key;
create unique index enrollments_ordinary_handoff_uidx on academy.enrollments(handoff_id) where commerce_seat_id is null;
create unique index enrollments_commerce_seat_uidx on academy.enrollments(commerce_seat_id) where commerce_seat_id is not null;

-- One deliberately bounded compatibility edit, verified against the inspected legacy
-- function. Abort on drift; never replace an unknown implementation or migration history.
do $migration$
declare body text; needle text:='on conflict (handoff_id) do update';
begin
 select pg_get_functiondef('private_app.update_admission_before_commerce_v1(text,uuid,text,uuid,uuid,text,text)'::regprocedure) into body;
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then
  raise exception 'woocommerce_legacy_enrollment_contract_drift';
 end if;
 execute replace(body,needle,'on conflict (handoff_id) where commerce_seat_id is null do update');
end $migration$;

create function private_app.commerce_beneficiary_phone_v1(p_value text)
returns text language sql immutable set search_path='' as $$
 with raw as (select regexp_replace(translate(coalesce(p_value,''),'٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹','01234567890123456789'),'[[:space:]()+.-]','','g') value),
 local as (select case when value ~ '^009665[0-9]{8}$' then '0'||substr(value,6)
  when value ~ '^9665[0-9]{8}$' then '0'||substr(value,4) else value end value from raw)
 select case when value ~ '^05[0-9]{8}$' then value else null end from local
$$;

create function private_app.commerce_beneficiaries_valid_v1(p_work uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from sales_core.commerce_order_beneficiaries where work_item_id=p_work)
 and not exists(
  select 1 from private_app.commerce_admission_items_v1(p_work) i where
   i.quantity is null or i.quantity<>trunc(i.quantity) or i.quantity not between 1 and 100
   or (select count(*) from sales_core.commerce_order_beneficiaries b
       where b.work_item_id=p_work and b.external_line_id=i.line_id)<>i.quantity
   or exists(select 1 from sales_core.commerce_order_beneficiaries b
       where b.work_item_id=p_work and b.external_line_id=i.line_id and
        (b.seat_number>i.quantity or b.source_revision is distinct from private_app.commerce_payment_revision_v1(p_work))))
 and not exists(select 1 from sales_core.commerce_order_beneficiaries b where b.work_item_id=p_work
  and not exists(select 1 from private_app.commerce_admission_items_v1(p_work) i where i.line_id=b.external_line_id))
$$;

alter function public.v1_tenant_woocommerce_admission_context(text,uuid) set schema private_app;
alter function private_app.v1_tenant_woocommerce_admission_context(text,uuid) rename to commerce_context_before_beneficiaries_v1;
revoke all on function private_app.commerce_context_before_beneficiaries_v1(text,uuid) from public,anon,authenticated,service_role;
create function public.v1_tenant_woocommerce_admission_context(p_tenant_slug text,p_task_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ctx jsonb; w sales_core.commerce_order_work_items%rowtype; seats jsonb; rev text; review sales_core.commerce_admission_reviews%rowtype;
begin
 ctx:=private_app.commerce_context_before_beneficiaries_v1(p_tenant_slug,p_task_id);
 if ctx->>'enabled' is distinct from 'true' then return ctx;end if;
 select * into w from sales_core.commerce_order_work_items where id=(ctx->>'workItemId')::uuid;
 select coalesce(jsonb_agg(jsonb_build_object('id',b.id,'lineId',b.external_line_id,'seatNumber',b.seat_number,
  'contactId',b.contact_id,'name',c.full_name,'phone',c.phone,'enrollmentId',b.enrollment_id)
  order by b.external_line_id,b.seat_number),'[]') into seats
 from sales_core.commerce_order_beneficiaries b join sales_core.contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id
 where b.tenant_id=w.tenant_id and b.work_item_id=w.id;
 ctx:=ctx||jsonb_build_object('beneficiaryEditorEnabled',true,'contactId',w.contact_id,'beneficiaries',seats,
  'beneficiariesValid',private_app.commerce_beneficiaries_valid_v1(w.id));
 if jsonb_array_length(seats)>0 then
  rev:=md5((ctx->>'revision')||seats::text);
  select * into review from sales_core.commerce_admission_reviews where tenant_id=w.tenant_id and work_item_id=w.id;
  ctx:=ctx||jsonb_build_object('revision',rev,'reviewValid',review.revision=rev,
   'reviewLines',case when review.revision=rev then review.lines else null end);
  if private_app.commerce_beneficiaries_valid_v1(w.id) then
   ctx:=jsonb_set(ctx,'{blockers}',(ctx->'blockers')-'woocommerce_beneficiaries_required');
  elsif not(ctx->'blockers' ? 'woocommerce_beneficiaries_required') then
   ctx:=jsonb_set(ctx,'{blockers}',(ctx->'blockers')||'"woocommerce_beneficiaries_required"'::jsonb);
  end if;
 end if;
 return ctx;
end $$;

create function public.v1_tenant_woocommerce_beneficiary_search(p_tenant_slug text,p_task_id uuid,p_query text default '')
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare ctx jsonb; t uuid; q text:=trim(coalesce(p_query,''));
begin
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 if ctx->>'enabled' is distinct from 'true' then raise exception 'woocommerce_admissions_disabled';end if;
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 if length(q)<2 or length(q)>100 then return '[]';end if;
 return (select coalesce(jsonb_agg(x),'[]') from (
  select c.id,c.full_name as name,c.phone from sales_core.contacts c where c.tenant_id=t
   and (coalesce((ctx->>'canReview')::boolean,false) or c.owner_staff_id=private_app.current_staff_id(t) or c.id=(ctx->>'contactId')::uuid)
   and (strpos(lower(c.full_name),lower(q))>0 or strpos(coalesce(c.phone,''),q)>0
    or private_app.commerce_beneficiary_phone_v1(c.phone)=private_app.commerce_beneficiary_phone_v1(q))
  order by (c.id=(ctx->>'contactId')::uuid) desc,c.full_name,c.id limit 20) x);
end $$;

create function public.v1_tenant_woocommerce_save_beneficiaries(p_tenant_slug text,p_task_id uuid,
 p_expected_revision text,p_command_id uuid,p_lines jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; ctx jsonb; w sales_core.commerce_order_work_items%rowtype; item record; line jsonb; b jsonb;
 hash text; old sales_core.commerce_admission_commands%rowtype; result jsonb; resolved jsonb:='[]'; before_rows jsonb;
 cid uuid; beneficiary_phone text; name text; seat integer; total integer:=0; ids uuid[]; existing sales_core.contacts%rowtype;
begin
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 if ctx->>'enabled' is distinct from 'true' then raise exception 'woocommerce_admissions_disabled';end if;
 if not coalesce((ctx->>'canReview')::boolean,false) and not coalesce((ctx->>'canComplete')::boolean,false) then raise exception 'forbidden';end if;
 if p_command_id is null or p_expected_revision is null or jsonb_typeof(p_lines) is distinct from 'array'
  or jsonb_array_length(p_lines) not between 1 and 50 then raise exception 'woocommerce_beneficiaries_invalid';end if;
 hash:=md5(jsonb_build_object('action','beneficiaries','task',p_task_id,'revision',p_expected_revision,'lines',p_lines)::text);
 select * into w from sales_core.commerce_order_work_items where tenant_id=t and task_id=p_task_id;
 perform 1 from commerce_sync.connections where tenant_id=t and id=w.connection_id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text,3917));
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||w.contact_id::text,31603));
 perform 1 from sales_core.contacts where tenant_id=t and id=w.contact_id for update;
 perform 1 from sales_core.commerce_order_work_items where tenant_id=t and id=w.id for update;
 select * into old from sales_core.commerce_admission_commands where tenant_id=t and command_id=p_command_id;
 if old.command_id is not null then
  if old.actor_id<>private_app.current_subject_id() or old.request_hash<>hash then raise exception 'woocommerce_command_conflict';end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 if ctx->>'revision' is distinct from p_expected_revision then raise exception 'woocommerce_order_changed';end if;
 if ctx->'receipt' is distinct from 'null'::jsonb or exists(select 1 from sales_core.commerce_order_beneficiaries
  where tenant_id=t and work_item_id=w.id and (handoff_id is not null or enrollment_id is not null))
  then raise exception 'woocommerce_beneficiaries_locked';end if;
 if ctx->>'taskStatus' not in ('todo','in_progress') then raise exception 'task_closed';end if;
 if ctx->>'reviewValid'='true' and not coalesce((ctx->>'canReview')::boolean,false) then raise exception 'woocommerce_review_changed';end if;
 if (select array_agg(i.line_id order by i.line_id) from private_app.commerce_admission_items_v1(w.id) i)
   is distinct from (select array_agg(x->>'lineId' order by x->>'lineId') from jsonb_array_elements(p_lines) x)
  then raise exception 'woocommerce_beneficiaries_invalid';end if;
 before_rows:=ctx->'beneficiaries';
 for item in select * from private_app.commerce_admission_items_v1(w.id) loop
  if item.quantity is null or item.quantity<>trunc(item.quantity) or item.quantity not between 1 and 100 then raise exception 'woocommerce_beneficiaries_limit';end if;
  total:=total+item.quantity::integer;if total>100 then raise exception 'woocommerce_beneficiaries_limit';end if;
  select value into line from jsonb_array_elements(p_lines) where value->>'lineId'=item.line_id;
  if jsonb_typeof(line->'beneficiaries') is distinct from 'array' or jsonb_array_length(line->'beneficiaries')<>item.quantity
   then raise exception 'woocommerce_beneficiaries_required';end if;
  seat:=0;ids:='{}';
  for b in select value from jsonb_array_elements(line->'beneficiaries') loop
   seat:=seat+1;cid:=nullif(b->>'contactId','')::uuid;
   if cid is not null then
    select * into existing from sales_core.contacts where tenant_id=t and id=cid;
    if existing.id is null or (not coalesce((ctx->>'canReview')::boolean,false)
     and existing.owner_staff_id is distinct from private_app.current_staff_id(t) and cid<>w.contact_id)
     then raise exception 'woocommerce_beneficiary_contact_unavailable';end if;
   else
    beneficiary_phone:=private_app.commerce_beneficiary_phone_v1(b->>'phone');name:=trim(coalesce(b->>'name',''));
    if length(name) not between 2 and 150 or beneficiary_phone is null then raise exception 'woocommerce_beneficiary_identity_required';end if;
    -- Use a tenant identity lock in addition to the source-order lock. Existing
    -- identities are selected explicitly, never silently renamed or reassigned.
    perform pg_advisory_xact_lock(hashtextextended(t::text||':woo-beneficiary:'||beneficiary_phone,3917));
    if exists(select 1 from sales_core.contacts c where c.tenant_id=t and
      (private_app.commerce_beneficiary_phone_v1(c.phone)=beneficiary_phone or private_app.commerce_beneficiary_phone_v1(c.whatsapp)=beneficiary_phone))
     or exists(select 1 from sales_core.contact_identities i where i.tenant_id=t and
      private_app.commerce_beneficiary_phone_v1(i.identity_value)=beneficiary_phone)
     then raise exception 'woocommerce_beneficiary_exists';end if;
    insert into sales_core.contacts(tenant_id,contact_key,full_name,phone,source,owner_staff_id,created_by_subject_id,metadata)
    values(t,'woo-beneficiary-'||gen_random_uuid(),name,beneficiary_phone,'woocommerce_beneficiary',w.assigned_staff_id,
     private_app.current_subject_id(),jsonb_build_object('source','woocommerce_beneficiary','commerceWorkItemId',w.id)) returning id into cid;
   end if;
   if cid=any(ids) then raise exception 'woocommerce_beneficiary_duplicate';end if;
   ids:=array_append(ids,cid);
   resolved:=resolved||jsonb_build_object('lineId',item.line_id,'seatNumber',seat,'contactId',cid);
  end loop;
 end loop;
 -- Only editable, unsubmitted seat assignments are replaced. The audit retains
 -- their previous selection. No financial/admission/enrollment history is deleted.
 delete from sales_core.commerce_order_beneficiaries where tenant_id=t and work_item_id=w.id;
 insert into sales_core.commerce_order_beneficiaries(tenant_id,work_item_id,external_line_id,seat_number,contact_id,source_revision,selected_by)
 select t,w.id,x->>'lineId',(x->>'seatNumber')::integer,(x->>'contactId')::uuid,ctx->>'financialRevision',private_app.current_subject_id()
 from jsonb_array_elements(resolved) x;
 result:=jsonb_build_object('saved',true,'count',total,'taskId',p_task_id);
 perform private_app.write_audit('tenant.woocommerce_beneficiaries_saved','commerce_order_work_item',w.id::text,t,
  jsonb_build_object('commandId',p_command_id,'before',before_rows,'after',resolved));
 insert into sales_core.commerce_admission_commands(tenant_id,command_id,actor_id,request_hash,result)
 values(t,p_command_id,private_app.current_subject_id(),hash,result);
 return result;
end $$;

alter function public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text) set schema private_app;
alter function private_app.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text) rename to commerce_action_before_beneficiaries_v1;
revoke all on function private_app.commerce_action_before_beneficiaries_v1(text,uuid,text,text,uuid,jsonb,text) from public,anon,authenticated,service_role;
create function public.v1_tenant_woocommerce_admission_action(p_tenant_slug text,p_task_id uuid,p_action text,
 p_expected_revision text,p_command_id uuid,p_lines jsonb default '[]',p_reason text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; t uuid; w sales_core.commerce_order_work_items%rowtype; result jsonb; line record; pending integer;
begin
 ctx:=public.v1_tenant_woocommerce_admission_context(p_tenant_slug,p_task_id);
 t:=private_app.commerce_admission_tenant_v1(p_tenant_slug);
 select * into w from sales_core.commerce_order_work_items where tenant_id=t and task_id=p_task_id;
 perform 1 from commerce_sync.connections where tenant_id=t and id=w.connection_id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text,3917));
 -- Serialize historical learner review with the ordinary registration endpoint.
 perform pg_advisory_xact_lock(hashtextextended(t::text||':'||w.contact_id::text,31603));
 perform 1 from sales_core.contacts where tenant_id=t and id=w.contact_id for update;
 -- A completed historical enrollment can cover exactly its original beneficiary.
 -- Refuse a mapping that would silently orphan or replace that learner.
 if exists(select 1 from sales_core.commerce_order_beneficiaries where tenant_id=t and work_item_id=w.id)
  and exists(select 1 from jsonb_array_elements(p_lines) x join academy.enrollments e on e.handoff_id=nullif(x->>'handoffId','')::uuid
   and e.tenant_id=t join academy.students s on s.id=e.student_id and s.tenant_id=t
   where not exists(select 1 from sales_core.commerce_order_beneficiaries b where b.tenant_id=t and b.work_item_id=w.id
    and b.external_line_id=x->>'lineId' and b.contact_id=s.contact_id))
  then raise exception 'woocommerce_existing_beneficiary_mismatch';end if;
 if exists(select 1 from sales_core.commerce_order_beneficiaries where tenant_id=t and work_item_id=w.id)
  and exists(select 1 from jsonb_array_elements(p_lines) x join academy.enrollments e
   on e.tenant_id=t and e.handoff_id=nullif(x->>'handoffId','')::uuid
   where e.status not in ('confirmed','active','completed'))
  then raise exception 'woocommerce_existing_enrollment_review';end if;
 result:=private_app.commerce_action_before_beneficiaries_v1(p_tenant_slug,p_task_id,p_action,p_expected_revision,p_command_id,p_lines,p_reason);
 if result->>'completed' is distinct from 'true' or result->>'replayed'='true' then return result;end if;
 for line in select l.*,i.quantity from sales_core.commerce_admission_lines l
  join lateral private_app.commerce_admission_items_v1(w.id) i on i.line_id=l.external_line_id
  where l.tenant_id=t and l.work_item_id=w.id loop
  update sales_core.commerce_order_beneficiaries b set handoff_id=line.handoff_id,
   allocated_minor=line.allocated_minor/line.quantity::bigint+case when b.seat_number<=mod(line.allocated_minor,line.quantity::bigint) then 1 else 0 end,
   enrollment_id=(select e.id from academy.enrollments e join academy.students s on s.id=e.student_id and s.tenant_id=t
    where e.tenant_id=t and e.handoff_id=line.handoff_id and s.contact_id=b.contact_id limit 1)
   where b.tenant_id=t and b.work_item_id=w.id and b.external_line_id=line.external_line_id;
  select count(*) into pending from sales_core.commerce_order_beneficiaries where tenant_id=t and handoff_id=line.handoff_id and enrollment_id is null;
  if pending>0 and exists(select 1 from academy.registration_handoffs where tenant_id=t and id=line.handoff_id and status='completed') then
   insert into work_core.tasks(tenant_id,task_key,title,description,status,priority,assigned_staff_id,contact_id,due_at,metadata)
   select t,'registration-beneficiaries-'||h.id,'استكمال المستفيدين: '||(ctx->>'contactName'),
    'WooCommerce #'||w.order_number||' · مستفيدون بانتظار الدفعة','todo','high',h.assigned_staff_id,w.contact_id,now()+interval '1 day',
    jsonb_build_object('source','registration_handoff','handoffId',h.id,'commerceWorkItemId',w.id,'paymentStatus','verified')
   from academy.registration_handoffs h where h.tenant_id=t and h.id=line.handoff_id
   on conflict(tenant_id,task_key) do nothing;
  end if;
 end loop;
 return result;
end $$;

create function private_app.commerce_beneficiary_revision_v1(p_tenant uuid,p_handoff uuid)
returns text language sql stable set search_path='' as $$
 select md5(jsonb_build_object('status',h.status,'payment',h.payment_status,'updated',h.updated_at,
  'source',private_app.commerce_payment_revision_v1(l.work_item_id),
  'seats',(select jsonb_agg(jsonb_build_array(b.id,b.contact_id,b.enrollment_id) order by b.seat_number)
    from sales_core.commerce_order_beneficiaries b where b.tenant_id=p_tenant and b.handoff_id=p_handoff))::text)
 from academy.registration_handoffs h join sales_core.commerce_admission_lines l on l.tenant_id=p_tenant and l.handoff_id=h.id
 where h.tenant_id=p_tenant and h.id=p_handoff
$$;

create function private_app.commerce_seat_enrollment_guard_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare b sales_core.commerce_order_beneficiaries%rowtype; student_contact uuid; h academy.registration_handoffs%rowtype;
begin
 if new.commerce_seat_id is null then
  if tg_op='INSERT' and exists(select 1 from sales_core.commerce_order_beneficiaries where tenant_id=new.tenant_id and handoff_id=new.handoff_id)
   then raise exception 'woocommerce_use_beneficiary_registration';end if;
  return new;
 end if;
 select * into b from sales_core.commerce_order_beneficiaries where tenant_id=new.tenant_id and id=new.commerce_seat_id;
 select contact_id into student_contact from academy.students where tenant_id=new.tenant_id and id=new.student_id;
 select * into h from academy.registration_handoffs where tenant_id=new.tenant_id and id=new.handoff_id;
 if b.id is null or b.handoff_id is distinct from new.handoff_id or b.contact_id is distinct from student_contact
  or h.course_id is distinct from new.course_id then raise exception 'woocommerce_beneficiaries_invalid';end if;
 if h.payment_status<>'verified' or h.status in ('cancelled','rejected') then raise exception 'payment_not_verified';end if;
 if exists(select 1 from sales_core.commerce_admission_orders o where o.tenant_id=new.tenant_id and o.work_item_id=b.work_item_id
  and o.source_revision is distinct from private_app.commerce_payment_revision_v1(b.work_item_id)) then raise exception 'woocommerce_payment_changed';end if;
 return new;
end $$;
create trigger commerce_seat_enrollment_guard_v1 before insert or update of tenant_id,handoff_id,student_id,course_id,commerce_seat_id
 on academy.enrollments for each row execute function private_app.commerce_seat_enrollment_guard_v1();

create function public.v1_tenant_woocommerce_enroll_beneficiaries(p_tenant_slug text,p_handoff_id uuid,
 p_expected_revision text,p_command_id uuid,p_seats jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid; h academy.registration_handoffs%rowtype; w sales_core.commerce_order_work_items%rowtype;
 beneficiary sales_core.commerce_order_beneficiaries%rowtype; c sales_core.contacts%rowtype; run academy.course_runs%rowtype;
 item jsonb; hash text; old sales_core.commerce_admission_commands%rowtype; result jsonb; sid uuid; eid uuid; rid uuid;
 pending integer; needed integer; occupied integer; total integer:=0; contact uuid;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if t is null or private_app.current_subject_id() is null or not private_app.has_tenant_permission(t,'tenant.admissions.write') then raise exception 'forbidden';end if;
 if p_command_id is null or p_expected_revision is null or jsonb_typeof(p_seats) is distinct from 'array'
  or jsonb_array_length(p_seats) not between 1 and 100 then raise exception 'woocommerce_beneficiaries_invalid';end if;
 select * into h from academy.registration_handoffs where tenant_id=t and id=p_handoff_id;
 if h.id is null then raise exception 'admission_not_found';end if;
 select work.* into w from sales_core.commerce_admission_lines l join sales_core.commerce_order_work_items work on work.tenant_id=t and work.id=l.work_item_id
  where l.tenant_id=t and l.handoff_id=h.id;
 if w.id is null then raise exception 'woocommerce_beneficiaries_invalid';end if;
 perform 1 from commerce_sync.connections where tenant_id=t and id=w.connection_id for update;
 perform pg_advisory_xact_lock(hashtextextended(t::text,3917));
 for contact in select distinct id from sales_core.contacts where tenant_id=t and (id=h.contact_id or id in (
   select contact_id from sales_core.commerce_order_beneficiaries where tenant_id=t and handoff_id=h.id)) order by id loop
  perform pg_advisory_xact_lock(hashtextextended(t::text||':'||contact::text,31603));
  perform 1 from sales_core.contacts where tenant_id=t and id=contact for update;
 end loop;
 perform 1 from academy.registration_handoffs where tenant_id=t and id=h.id for update;
 hash:=md5(jsonb_build_object('action','enroll_beneficiaries','handoff',p_handoff_id,'revision',p_expected_revision,'seats',p_seats)::text);
 select * into old from sales_core.commerce_admission_commands where tenant_id=t and command_id=p_command_id;
 if old.command_id is not null then
  if old.actor_id<>private_app.current_subject_id() or old.request_hash<>hash then raise exception 'woocommerce_command_conflict';end if;
  return old.result||jsonb_build_object('replayed',true);
 end if;
 if private_app.commerce_beneficiary_revision_v1(t,h.id) is distinct from p_expected_revision then raise exception 'woocommerce_order_changed';end if;
 select * into h from academy.registration_handoffs where tenant_id=t and id=p_handoff_id;
 if h.status in ('cancelled','rejected') or h.payment_status<>'verified' then raise exception 'payment_not_verified';end if;
 if exists(select 1 from sales_core.commerce_admission_orders o where o.tenant_id=t and o.work_item_id=w.id
   and o.source_revision is distinct from private_app.commerce_payment_revision_v1(w.id)) then raise exception 'woocommerce_payment_changed';end if;
 if exists(select 1 from academy.registration_documents where tenant_id=t and handoff_id=h.id and is_required and status not in ('approved','not_required'))
  then raise exception 'documents_incomplete';end if;
 if exists(select 1 from jsonb_array_elements(p_seats) x group by x->>'id' having count(*)>1)
  or exists(select 1 from jsonb_array_elements(p_seats) x where nullif(x->>'courseRunId','') is null
   or not exists(select 1 from sales_core.commerce_order_beneficiaries b where b.tenant_id=t and b.handoff_id=h.id and b.id=(x->>'id')::uuid))
  then raise exception 'woocommerce_beneficiaries_invalid';end if;
 -- Lock all selected batches in deterministic order before capacity checks/inserts.
 for rid in select distinct (x->>'courseRunId')::uuid from jsonb_array_elements(p_seats) x order by 1 loop
  select * into run from academy.course_runs where tenant_id=t and id=rid and course_id=h.course_id
   and status='open' for update;
  if run.id is null then raise exception 'invalid_course_run';end if;
  if (run.registration_opens_at is not null and now()<run.registration_opens_at)
   or (run.registration_closes_at is not null and now()>run.registration_closes_at) then raise exception 'course_run_registration_closed';end if;
  select count(*) into needed from jsonb_array_elements(p_seats) x join sales_core.commerce_order_beneficiaries b
   on b.tenant_id=t and b.handoff_id=h.id and b.id=(x->>'id')::uuid where b.enrollment_id is null and (x->>'courseRunId')::uuid=rid;
  select count(*) into occupied from academy.enrollments where tenant_id=t and course_run_id=rid and status in ('confirmed','active','completed');
  if run.capacity is not null and needed+occupied>run.capacity then raise exception 'course_run_full';end if;
 end loop;
 for item in select value from jsonb_array_elements(p_seats) loop
  select * into beneficiary from sales_core.commerce_order_beneficiaries where tenant_id=t and handoff_id=h.id and id=(item->>'id')::uuid for update;
  rid:=(item->>'courseRunId')::uuid;
  if beneficiary.enrollment_id is not null then
   if not exists(select 1 from academy.enrollments where tenant_id=t and id=beneficiary.enrollment_id and course_run_id=rid)
    then raise exception 'woocommerce_beneficiaries_locked';end if;
   continue;
  end if;
  select * into c from sales_core.contacts where tenant_id=t and id=beneficiary.contact_id;
  select id into sid from academy.students where tenant_id=t and contact_id=c.id;
  if sid is not null and exists(select 1 from academy.students where tenant_id=t and id=sid and status='blocked') then raise exception 'woocommerce_beneficiary_blocked';end if;
  if sid is null then
   insert into academy.students(tenant_id,student_key,student_number,contact_id,full_name,phone,email,created_by_subject_id,metadata)
   values(t,'contact-'||c.id,'STU-'||upper(replace(c.id::text,'-','')),c.id,c.full_name,coalesce(c.phone,c.whatsapp),c.email,
    private_app.current_subject_id(),jsonb_build_object('source','woocommerce_beneficiary','handoffId',h.id))
   on conflict(tenant_id,contact_id) do nothing returning id into sid;
   if sid is null then select id into sid from academy.students where tenant_id=t and contact_id=c.id;end if;
  end if;
  if exists(select 1 from academy.enrollments where tenant_id=t and student_id=sid and course_run_id=rid)
   then raise exception 'woocommerce_beneficiary_already_enrolled';end if;
  insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status,confirmed_by_subject_id,commerce_seat_id,metadata)
  values(t,'woo-seat-'||beneficiary.id,h.id,sid,h.course_id,rid,'confirmed',private_app.current_subject_id(),beneficiary.id,
   jsonb_build_object('source','woocommerce_beneficiary','commerceWorkItemId',w.id,'seatNumber',beneficiary.seat_number,
    'allocatedMinor',beneficiary.allocated_minor,'paymentHandoffId',h.id)) returning id into eid;
  update sales_core.commerce_order_beneficiaries set enrollment_id=eid where tenant_id=t and id=beneficiary.id;
  total:=total+1;
 end loop;
 update academy.course_runs r set enrolled_count=(select count(*) from academy.enrollments e where e.tenant_id=t and e.course_run_id=r.id
  and e.status in ('confirmed','active','completed')) where r.tenant_id=t and r.id in (select (x->>'courseRunId')::uuid from jsonb_array_elements(p_seats) x);
 select count(*) into pending from sales_core.commerce_order_beneficiaries where tenant_id=t and handoff_id=h.id and enrollment_id is null;
 if pending=0 then
  update academy.registration_handoffs set status='completed',completed_at=coalesce(completed_at,now()),
   completed_by_subject_id=coalesce(completed_by_subject_id,private_app.current_subject_id()),
   accepted_at=coalesce(accepted_at,now()),accepted_by_subject_id=coalesce(accepted_by_subject_id,private_app.current_subject_id())
   where tenant_id=t and id=h.id and status<>'completed';
  update work_core.tasks set status='completed',completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end
   where tenant_id=t and task_key in ('registration-'||h.id,'registration-beneficiaries-'||h.id) and status in ('todo','in_progress');
 end if;
 result:=jsonb_build_object('saved',true,'enrolled',total,'remaining',pending,'handoffId',h.id);
 perform private_app.write_audit('tenant.woocommerce_beneficiaries_enrolled','registration_handoff',h.id::text,t,
  jsonb_build_object('commandId',p_command_id,'seats',p_seats,'result',result));
 insert into sales_core.commerce_admission_commands(tenant_id,command_id,actor_id,request_hash,result)
 values(t,p_command_id,private_app.current_subject_id(),hash,result);
 return result;
end $$;

alter function public.v3_tenant_admissions_snapshot(text) set schema private_app;
alter function private_app.v3_tenant_admissions_snapshot(text) rename to admissions_snapshot_before_beneficiaries_v1;
revoke all on function private_app.admissions_snapshot_before_beneficiaries_v1(text) from public,anon,authenticated,service_role;
create function public.v3_tenant_admissions_snapshot(p_slug text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; t uuid; extra integer;
begin
 result:=private_app.admissions_snapshot_before_beneficiaries_v1(p_slug);
 select id into t from core.tenants where slug=p_slug;
 result:=jsonb_set(result,'{cases}',(select coalesce(jsonb_agg(case when seats.value is null then x.value else
  x.value||jsonb_build_object('beneficiaries',seats.value,'beneficiaryRevision',private_app.commerce_beneficiary_revision_v1(t,(x.value->>'id')::uuid),
   'originalStatus',x.value->>'status','status',case when x.value->>'status'='completed' and seats.pending>0 then 'in_review' else x.value->>'status' end) end
  order by x.ordinality),'[]') from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)
  left join lateral (select jsonb_agg(jsonb_build_object('id',b.id,'seatNumber',b.seat_number,'contactId',b.contact_id,
   'name',c.full_name,'phone',c.phone,'allocatedMinor',b.allocated_minor,'enrollmentId',b.enrollment_id,
   'courseRunId',e.course_run_id,'courseRunName',r.title,'studentNumber',s.student_number) order by b.seat_number) value,
   count(*) filter(where b.enrollment_id is null) pending
   from sales_core.commerce_order_beneficiaries b join sales_core.contacts c on c.tenant_id=t and c.id=b.contact_id
   left join academy.enrollments e on e.tenant_id=t and e.id=b.enrollment_id
   left join academy.students s on s.tenant_id=t and s.id=e.student_id
   left join academy.course_runs r on r.tenant_id=t and r.id=e.course_run_id
   where b.tenant_id=t and b.handoff_id=(x.value->>'id')::uuid) seats on true));
 select count(*) into extra from academy.registration_handoffs h where h.tenant_id=t and h.status='completed'
  and exists(select 1 from sales_core.commerce_order_beneficiaries b where b.tenant_id=t and b.handoff_id=h.id and b.enrollment_id is null);
 return jsonb_set(result,'{summary}',(result->'summary')||jsonb_build_object(
  'completed',greatest(0,coalesce((result#>>'{summary,completed}')::integer,0)-extra),
  'inReview',coalesce((result#>>'{summary,inReview}')::integer,0)+extra));
end $$;

-- The existing public admission API remains compatible for ordinary registrations.
-- Its INSERT guard rejects group completion from an old tab/API client as well.
revoke all on function private_app.commerce_beneficiary_phone_v1(text),private_app.commerce_beneficiaries_valid_v1(uuid),
 private_app.commerce_beneficiary_revision_v1(uuid,uuid),private_app.commerce_seat_enrollment_guard_v1()
 from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_woocommerce_admission_context(text,uuid),
 public.v1_tenant_woocommerce_beneficiary_search(text,uuid,text),
 public.v1_tenant_woocommerce_save_beneficiaries(text,uuid,text,uuid,jsonb),
 public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text),
 public.v1_tenant_woocommerce_enroll_beneficiaries(text,uuid,text,uuid,jsonb),public.v3_tenant_admissions_snapshot(text)
 from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_woocommerce_admission_context(text,uuid),
 public.v1_tenant_woocommerce_beneficiary_search(text,uuid,text),
 public.v1_tenant_woocommerce_save_beneficiaries(text,uuid,text,uuid,jsonb),
 public.v1_tenant_woocommerce_admission_action(text,uuid,text,text,uuid,jsonb,text),
 public.v1_tenant_woocommerce_enroll_beneficiaries(text,uuid,text,uuid,jsonb),public.v3_tenant_admissions_snapshot(text)
 to authenticated;
commit;
