begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- Opt-in policy only. No tenant activation, historical repair or financial rewrite.
create table academy.admission_governance_settings (
 tenant_id uuid primary key references core.tenants(id) on delete cascade,
 enabled boolean not null default false,
 finance_sla_business_days integer not null default 1 check(finance_sla_business_days between 1 and 30),
 placement_sla_business_days integer not null default 1 check(placement_sla_business_days between 1 and 30),
 weekend_iso_days integer[] not null default array[5,6]
  check(cardinality(weekend_iso_days) between 0 and 6 and weekend_iso_days <@ array[1,2,3,4,5,6,7]),
 finance_owner_staff_id uuid references people.staff_profiles(id),
 placement_owner_staff_id uuid references people.staff_profiles(id),
 approved_by_subject_id uuid references access_control.subjects(id),
 activated_at timestamptz, updated_at timestamptz not null default now()
);
create table academy.admission_readiness (
 tenant_id uuid not null references core.tenants(id) on delete cascade,
 handoff_id uuid primary key references academy.registration_handoffs(id) on delete cascade,
 state text not null, waiting_reason text, state_since timestamptz not null default now(),
 review_at timestamptz, enrollment_id uuid references academy.enrollments(id),
 evaluated_at timestamptz not null default now()
);
comment on table academy.admission_readiness is 'Recomputable projection only: canonical handoff, documents, finance and enrollment remain authoritative.';
create index admission_readiness_review_idx on academy.admission_readiness(tenant_id,review_at) where waiting_reason is not null;
create table academy.admission_governance_queue (
 tenant_id uuid not null references core.tenants(id) on delete cascade,
 handoff_id uuid primary key references academy.registration_handoffs(id) on delete cascade,
 queued_at timestamptz not null default now(), attempts integer not null default 0,
 retry_at timestamptz not null default now(), last_error text
);
create index admission_governance_queue_due_idx on academy.admission_governance_queue(retry_at,queued_at,handoff_id);
create table academy.admission_governance_exceptions (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references core.tenants(id) on delete cascade,
 kind text not null check(kind in ('late_enrollment','payment_waiver','run_closure','run_reopen')),
 handoff_id uuid references academy.registration_handoffs(id), course_run_id uuid references academy.course_runs(id),
 agreed_course_id uuid references academy.courses(id),
 reason text not null check(length(trim(reason))>=3),
 approved_by_subject_id uuid not null references access_control.subjects(id),
 approved_at timestamptz not null default now(),
 check((kind='payment_waiver' and handoff_id is not null and course_run_id is null)
  or (kind='late_enrollment' and handoff_id is not null and course_run_id is not null)
  or (kind in ('run_closure','run_reopen') and handoff_id is null and course_run_id is not null))
);
create index admission_governance_exceptions_lookup_idx on academy.admission_governance_exceptions(tenant_id,handoff_id,course_run_id,kind);
create table academy.admission_commercial_terms (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 handoff_id uuid not null references academy.registration_handoffs(id),
 course_id uuid not null references academy.courses(id),
 amount_minor bigint not null check(amount_minor>=0),currency text not null check(currency ~ '^[A-Z]{3}$'),
 reason text not null check(length(trim(reason))>=3),approved_by_subject_id uuid not null references access_control.subjects(id),
 approved_at timestamptz not null default now()
);
create index admission_commercial_terms_handoff_idx on academy.admission_commercial_terms(tenant_id,handoff_id,approved_at desc,id);
create unique index if not exists admission_governance_enrollment_tenant_uidx on academy.enrollments(tenant_id,id);
create unique index if not exists admission_governance_run_tenant_uidx on academy.course_runs(tenant_id,id);
create unique index if not exists admission_governance_staff_tenant_uidx on people.staff_profiles(tenant_id,id);
create unique index if not exists admission_governance_course_tenant_uidx on academy.courses(tenant_id,id);
alter table academy.admission_readiness add foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 add foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id);
alter table academy.admission_governance_queue add foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id);
alter table academy.admission_governance_exceptions add foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 add foreign key(tenant_id,course_run_id) references academy.course_runs(tenant_id,id),
 add foreign key(tenant_id,agreed_course_id) references academy.courses(tenant_id,id);
alter table academy.admission_commercial_terms add foreign key(tenant_id,handoff_id) references academy.registration_handoffs(tenant_id,id),
 add foreign key(tenant_id,course_id) references academy.courses(tenant_id,id);
alter table academy.admission_governance_settings add foreign key(tenant_id,finance_owner_staff_id) references people.staff_profiles(tenant_id,id),
 add foreign key(tenant_id,placement_owner_staff_id) references people.staff_profiles(tenant_id,id);
alter table academy.admission_governance_settings enable row level security;
alter table academy.admission_readiness enable row level security;
alter table academy.admission_governance_queue enable row level security;
alter table academy.admission_governance_exceptions enable row level security;
alter table academy.admission_commercial_terms enable row level security;
revoke all on academy.admission_governance_settings,academy.admission_readiness,
 academy.admission_governance_queue,academy.admission_governance_exceptions,academy.admission_commercial_terms from public,anon,authenticated,service_role;

create function private_app.guard_admission_decision_history_v1() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'admission_decision_history_immutable';end $$;
create trigger admission_exceptions_immutable before update or delete on academy.admission_governance_exceptions
 for each row execute function private_app.guard_admission_decision_history_v1();
create trigger admission_terms_immutable before update or delete on academy.admission_commercial_terms
 for each row execute function private_app.guard_admission_decision_history_v1();

insert into access_control.permissions(permission_key,module_key,name_ar,description) values
 ('tenant.admissions.governance.manage','admissions','إدارة سياسة التسجيل','معاينة وتفعيل سياسة التسجيل والمهل والمسؤولين'),
 ('tenant.admissions.exceptions.approve','admissions','اعتماد استثناءات التسجيل','اعتماد التسجيل المتأخر وإغلاق الدفعات بأسباب موثقة')
on conflict(permission_key) do nothing;
insert into access_control.role_permissions(role_id,permission_key)
 select r.id,p.permission_key from access_control.roles r cross join access_control.permissions p
 where r.scope='tenant' and r.role_key in ('tenant_owner','tenant_admin','executive_manager')
 and p.permission_key in ('tenant.admissions.governance.manage','tenant.admissions.exceptions.approve') on conflict do nothing;

create function private_app.admission_governance_enabled_v1(p_tenant_id uuid) returns boolean
 language sql stable security definer set search_path='' as $$
 select exists(select 1 from academy.admission_governance_settings where tenant_id=p_tenant_id and enabled)
$$;
create function private_app.admission_business_deadline_v1(p_tenant_id uuid,p_start timestamptz,p_days integer)
 returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare zone text; local_time timestamp; weekends integer[]; remaining integer:=p_days;
begin
 if p_days not between 1 and 30 or p_start is null then raise exception 'invalid_business_deadline';end if;
 select timezone into zone from core.tenants where id=p_tenant_id;
 if zone is null then raise exception 'tenant_not_found';end if;
 select weekend_iso_days into weekends from academy.admission_governance_settings where tenant_id=p_tenant_id;
 weekends:=coalesce(weekends,array[5,6]);local_time:=p_start at time zone zone;
 while remaining>0 loop
  local_time:=local_time+interval '1 day';
  if not(extract(isodow from local_time)::integer=any(weekends)) then remaining:=remaining-1;end if;
 end loop;
 return local_time at time zone zone;
end $$;

create function private_app.admission_financial_eligibility_v1(p_tenant_id uuid,p_handoff_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h academy.registration_handoffs%rowtype;c academy.courses%rowtype; required_amount bigint;cash bigint;program_type text;agreed_currency text;cash_currency text;invoice_id uuid;invoice_net jsonb;
begin
 select * into h from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id;
 select * into c from academy.courses where tenant_id=p_tenant_id and id=h.course_id;
 if h.id is null or c.id is null then return jsonb_build_object('eligible',false,'reason','course_required');end if;
 program_type:=to_jsonb(c)->>'program_kind';
 if program_type='diploma' then return private_app.diploma_admission_eligibility_v1(p_tenant_id,p_handoff_id);end if;
 if program_type is distinct from 'short_course' then return jsonb_build_object('eligible',false,'reason','program_classification_required');end if;
 if exists(select 1 from academy.admission_governance_exceptions where tenant_id=p_tenant_id and handoff_id=h.id and agreed_course_id=h.course_id and kind='payment_waiver')
 then return jsonb_build_object('eligible',true,'reason','approved_payment_waiver','waiverApproved',true);end if;
 -- Legacy opportunity values may have been overwritten by a partial receipt. Require an explicit agreement.
 select terms.amount_minor,terms.currency into required_amount,agreed_currency from academy.admission_commercial_terms terms
  where terms.tenant_id=p_tenant_id and terms.handoff_id=h.id and terms.course_id=h.course_id order by terms.approved_at desc,terms.id desc limit 1;
 select link.invoice_id into invoice_id from academy.training_financial_links link where link.tenant_id=p_tenant_id and link.handoff_id=h.id;
 if invoice_id is not null then
  invoice_net:=private_app.accounting_invoice_net_v1(p_tenant_id,invoice_id);
  if invoice_net->>'totalMinor' is null then return jsonb_build_object('eligible',false,'reason','issued_invoice_required');end if;
  if coalesce((invoice_net->>'requiresReview')::boolean,false) then return jsonb_build_object('eligible',false,'reason','refund_invoice_allocation_required');end if;
  if required_amount is not null and (required_amount<>(invoice_net->>'totalMinor')::bigint or agreed_currency is distinct from invoice_net->>'currency') then
   return jsonb_build_object('eligible',false,'reason','commercial_terms_invoice_mismatch');
  end if;
  required_amount:=(invoice_net->>'totalMinor')::bigint;agreed_currency:=invoice_net->>'currency';
 end if;
 if required_amount is null then return jsonb_build_object('eligible',false,'reason','agreed_price_required');end if;
 -- A zero price is an explicit commercial choice; no fictional payment is inserted.
 if required_amount=0 then return jsonb_build_object('eligible',true,'reason','zero_price_agreement','requiredAmountMinor',0);end if;
 cash:=private_app.admission_verified_cash_v1(p_tenant_id,p_handoff_id);
 cash_currency:=private_app.admission_cash_currency_v1(p_tenant_id,p_handoff_id);
 if cash>0 and cash_currency is distinct from agreed_currency then return jsonb_build_object('eligible',false,'reason','payment_currency_mismatch');end if;
 return jsonb_build_object('eligible',cash>=required_amount,'reason',case when cash>=required_amount then 'financially_eligible' else 'full_payment_required' end,
  'requiredAmountMinor',required_amount,'verifiedAmountMinor',cash,'waiverApproved',false);
end $$;

create function private_app.admission_readiness_v1(p_tenant_id uuid,p_handoff_id uuid)
 returns jsonb language plpgsql stable security definer set search_path='' as $$
declare h academy.registration_handoffs%rowtype;r academy.course_runs%rowtype;financial jsonb;reason text;enrollment uuid;enrollment_status text;phone text;seat_count integer:=0;pending_seats integer:=0;inactive_seats integer:=0;missing_phones integer:=0;
begin
 select * into h from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id;
 if h.id is null then raise exception 'admission_not_found';end if;
 if h.status in ('cancelled','rejected') then return jsonb_build_object('state',h.status);end if;
 select e.id,e.status into enrollment,enrollment_status from academy.enrollments e where e.tenant_id=p_tenant_id and e.handoff_id=h.id
  and to_jsonb(e)->>'commerce_seat_id' is null order by e.created_at limit 1;
 if enrollment is not null then return jsonb_build_object('state',case when enrollment_status in ('confirmed','active','completed') then 'enrolled' else enrollment_status end,'enrollmentId',enrollment);end if;
 if to_regclass('sales_core.commerce_order_beneficiaries') is not null then
  execute 'select count(*),count(*) filter(where b.enrollment_id is null),count(*) filter(where b.enrollment_id is not null and e.status not in (''confirmed'',''active'',''completed'')),count(*) filter(where b.enrollment_id is null and nullif(trim(c.phone),'''') is null) from sales_core.commerce_order_beneficiaries b left join academy.enrollments e on e.tenant_id=b.tenant_id and e.id=b.enrollment_id left join sales_core.contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=$1 and b.handoff_id=$2'
   into seat_count,pending_seats,inactive_seats,missing_phones using p_tenant_id,h.id;
 end if;
 if inactive_seats>0 then return jsonb_build_object('state','waiting','waitingReason','beneficiary_enrollment_review_required');end if;
 if seat_count>0 and pending_seats=0 then return jsonb_build_object('state','enrolled','beneficiaryCount',seat_count);end if;
 select c.phone into phone from sales_core.contacts c where c.tenant_id=p_tenant_id and c.id=h.contact_id;
 if nullif(trim(phone),'') is null or missing_phones>0 then reason:='beneficiary_phone_required';
 elsif exists(select 1 from academy.students where tenant_id=p_tenant_id and contact_id=h.contact_id and status='blocked') then reason:='student_profile_blocked';
 elsif h.course_id is null then reason:='course_required';
 elsif exists(select 1 from academy.registration_documents d where d.tenant_id=p_tenant_id and d.handoff_id=h.id
  and d.is_required and d.status not in ('approved','not_required')) then reason:='required_documents_incomplete';
 else
  financial:=private_app.admission_financial_eligibility_v1(p_tenant_id,h.id);
  if not coalesce((financial->>'eligible')::boolean,false) then reason:=financial->>'reason';
  elsif h.metadata ? 'commerceSourceHold' then reason:='payment_source_review_required';
  elsif h.course_run_id is null then reason:='course_run_required';
  else
   select * into r from academy.course_runs where tenant_id=p_tenant_id and id=h.course_run_id and course_id=h.course_id;
   if r.id is null or r.status in ('completed','cancelled') then reason:='course_run_unavailable';
   elsif r.status='planning' then reason:='planned_run_reservation';
   elsif r.status='in_progress' and not exists(select 1 from academy.admission_governance_exceptions x
    where x.tenant_id=p_tenant_id and x.handoff_id=h.id and x.course_run_id=r.id and x.kind='late_enrollment') then reason:='late_enrollment_approval_required';
   elsif r.status='open' and (r.registration_opens_at>now() or r.registration_closes_at<now()) then reason:='registration_window_closed';
   elsif r.capacity is not null and (select count(*) from academy.enrollments e where e.tenant_id=p_tenant_id and e.course_run_id=r.id and e.status in ('confirmed','active','completed'))>=r.capacity then reason:='course_run_full';
   end if;
  end if;
 end if;
 -- Beneficiary orders retain their existing per-seat placement flow; do not enroll the payer as another learner.
 if seat_count>0 and (reason is null or reason='course_run_required') then reason:='beneficiary_placement_required';end if;
 return jsonb_build_object('state',case when reason='planned_run_reservation' then 'reserved' when reason is null then 'ready' else 'waiting' end,
  'waitingReason',reason,'courseRunId',h.course_run_id,'financiallyEligible',coalesce((financial->>'eligible')::boolean,false));
end $$;

create function private_app.queue_admission_governance_v1(p_tenant_id uuid,p_handoff_id uuid) returns void
 language plpgsql security definer set search_path='' as $$
begin
 if not private_app.admission_governance_enabled_v1(p_tenant_id) then return;end if;
 insert into academy.admission_governance_queue(tenant_id,handoff_id) values(p_tenant_id,p_handoff_id)
 on conflict(handoff_id) do update set retry_at=least(academy.admission_governance_queue.retry_at,now()),last_error=null;
end $$;

create function private_app.admission_waiting_label_v1(p_reason text) returns text language sql immutable set search_path='' as $$
 select case p_reason
  when 'beneficiary_phone_required' then 'استكمال رقم جوال مستقل للمستفيد'
  when 'course_required' then 'تحديد البرنامج المطلوب'
  when 'program_classification_required' then 'تصنيف البرنامج إلى دورة قصيرة أو دبلوم'
  when 'required_documents_incomplete' then 'مراجعة المستندات المطلوبة'
  when 'agreed_price_required' then 'توثيق القيمة والعملة المتفق عليهما'
  when 'full_payment_required' then 'مراجعة استكمال سداد الدورة'
  when 'first_installment_required' then 'مراجعة القسط الأول للدبلوم'
  when 'payment_currency_mismatch' then 'مراجعة اختلاف عملة السداد عن الاتفاق'
  when 'payment_source_review_required' then 'مراجعة التغيير في مصدر الدفع'
  when 'commercial_terms_invoice_mismatch' then 'مطابقة الاتفاق المالي مع الفاتورة؛ يلزم تعديل مالي موثق'
  when 'issued_invoice_required' then 'استكمال إصدار الفاتورة المرتبطة'
  when 'refund_invoice_allocation_required' then 'تحديد الفاتورة المتأثرة بالاسترداد'
  when 'approved_diploma_contract_required' then 'استكمال عقد دبلوم معتمد'
  when 'diploma_disabled' then 'مراجعة تفعيل سياسة الدبلومات'
  when 'course_run_required' then 'تسكين طلب مستوفٍ ماليًا في دفعة مناسبة'
  when 'course_run_unavailable' then 'اختيار دفعة بديلة أو مراجعة التسوية بعد إلغاء أو انتهاء الدفعة'
  when 'planned_run_reservation' then 'متابعة الحجز حتى فتح الدفعة'
  when 'late_enrollment_approval_required' then 'اعتماد التسجيل المتأخر وسببه'
  when 'registration_window_closed' then 'متابعة موعد فتح التسجيل'
  when 'course_run_full' then 'توفير مقعد أو اختيار دفعة بديلة'
  when 'beneficiary_placement_required' then 'تسكين المستفيدين في دفعاتهم'
  when 'beneficiary_enrollment_review_required' then 'مراجعة تسجيل مستفيد ملغى أو منسحب'
  when 'existing_student_run_review_required' then 'مراجعة التسجيل السابق للمتدرب في الدفعة'
  when 'student_profile_blocked' then 'مراجعة إيقاف ملف المتدرب'
  else 'مراجعة متطلبات التسجيل المتبقية' end
$$;

create function private_app.reconcile_admission_governance_v1(p_tenant_id uuid,p_handoff_id uuid) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare h academy.registration_handoffs%rowtype;contact sales_core.contacts%rowtype;cfg academy.admission_governance_settings%rowtype;
 result jsonb;prior academy.admission_readiness%rowtype;student uuid;enrollment uuid;since timestamptz;deadline timestamptz;owner uuid;v_task_key text;finance_waiting boolean;
begin
 if not private_app.admission_governance_enabled_v1(p_tenant_id) then return jsonb_build_object('enabled',false);end if;
 select * into cfg from academy.admission_governance_settings where tenant_id=p_tenant_id;
 select c.* into contact from sales_core.contacts c join academy.registration_handoffs handoff on handoff.tenant_id=c.tenant_id and handoff.contact_id=c.id
  where handoff.tenant_id=p_tenant_id and handoff.id=p_handoff_id;
 if contact.id is null then raise exception 'admission_not_found';end if;
 if not pg_try_advisory_xact_lock(hashtextextended(p_tenant_id::text||':'||contact.id::text,31603)) then
  perform private_app.queue_admission_governance_v1(p_tenant_id,p_handoff_id);return jsonb_build_object('state','queued');end if;
 perform 1 from sales_core.contacts where tenant_id=p_tenant_id and id=contact.id for update nowait;
 select * into h from academy.registration_handoffs where tenant_id=p_tenant_id and id=p_handoff_id for update nowait;
 perform 1 from academy.course_runs where tenant_id=p_tenant_id and id=h.course_run_id for update nowait;
 result:=private_app.admission_readiness_v1(p_tenant_id,h.id);
 if result->>'state'='ready' then
  insert into academy.students(tenant_id,student_key,student_number,contact_id,full_name,phone,email,created_by_subject_id,metadata)
  values(p_tenant_id,'contact-'||contact.id,'STU-'||replace(contact.id::text,'-',''),contact.id,contact.full_name,contact.phone,contact.email,
   private_app.current_subject_id(),jsonb_build_object('source','admission_governance','handoffId',h.id))
  on conflict(tenant_id,contact_id) do update set full_name=excluded.full_name,phone=excluded.phone,email=coalesce(excluded.email,academy.students.email),
   status=case when academy.students.status='blocked' then 'blocked' else 'active' end
  returning id into student;
  -- A different application for an existing learner/run cannot silently revive a withdrawn enrollment.
  if exists(select 1 from academy.enrollments where tenant_id=p_tenant_id and student_id=student and course_run_id=h.course_run_id) then
   result:=jsonb_build_object('state','waiting','waitingReason','existing_student_run_review_required');
  else
   insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status,confirmed_by_subject_id,metadata)
   values(p_tenant_id,'handoff-'||h.id,h.id,student,h.course_id,h.course_run_id,'confirmed',private_app.current_subject_id(),
    jsonb_build_object('source','admission_governance')) returning id into enrollment;
   update academy.course_runs r set enrolled_count=(select count(*) from academy.enrollments e where e.tenant_id=p_tenant_id and e.course_run_id=r.id
    and e.status in ('confirmed','active','completed')) where r.tenant_id=p_tenant_id and r.id=h.course_run_id;
   update academy.registration_handoffs set status='completed',accepted_at=coalesce(accepted_at,now()),
    accepted_by_subject_id=coalesce(accepted_by_subject_id,private_app.current_subject_id()),completed_at=now(),completed_by_subject_id=private_app.current_subject_id()
    where tenant_id=p_tenant_id and id=h.id;
   if auth.uid() is not null then
    perform private_app.write_audit('tenant.admission_auto_enrolled','registration_handoff',h.id::text,p_tenant_id,jsonb_build_object('enrollmentId',enrollment));
   else
    insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
     values(p_tenant_id,null,'tenant.admission_auto_enrolled','registration_handoff',h.id::text,
      jsonb_build_object('enrollmentId',enrollment,'source','admission_governance_worker','policyApprovedBySubjectId',cfg.approved_by_subject_id));
   end if;
   result:=jsonb_build_object('state','enrolled','enrollmentId',enrollment);
  end if;
 end if;
 select * into prior from academy.admission_readiness where tenant_id=p_tenant_id and handoff_id=h.id;
 since:=case when prior.waiting_reason is not distinct from result->>'waitingReason' and prior.state=result->>'state' then prior.state_since else now() end;
 finance_waiting:=result->>'waitingReason' in ('full_payment_required','first_installment_required','agreed_price_required','payment_currency_mismatch','payment_source_review_required','approved_diploma_contract_required','commercial_terms_invoice_mismatch','issued_invoice_required','refund_invoice_allocation_required');
 if result->>'waitingReason' is not null then
  deadline:=private_app.admission_business_deadline_v1(p_tenant_id,since,
   case when finance_waiting then cfg.finance_sla_business_days else cfg.placement_sla_business_days end);
  owner:=case when finance_waiting then cfg.finance_owner_staff_id else coalesce(h.assigned_staff_id,cfg.placement_owner_staff_id) end;
  if owner is not null and to_regprocedure('private_app.staff_operationally_available_v1(uuid,uuid,timestamptz)') is not null then
   if not private_app.staff_operationally_available_v1(p_tenant_id,owner,now()) then
    owner:=case when finance_waiting then cfg.finance_owner_staff_id else cfg.placement_owner_staff_id end;
    if owner is not null and not private_app.staff_operationally_available_v1(p_tenant_id,owner,now()) then owner:=null;end if;
   end if;
  end if;
 end if;
 insert into academy.admission_readiness(tenant_id,handoff_id,state,waiting_reason,state_since,review_at,enrollment_id)
 values(p_tenant_id,h.id,result->>'state',result->>'waitingReason',since,deadline,(result->>'enrollmentId')::uuid)
 on conflict(handoff_id) do update set state=excluded.state,waiting_reason=excluded.waiting_reason,state_since=excluded.state_since,
  review_at=excluded.review_at,enrollment_id=excluded.enrollment_id,evaluated_at=now();
 v_task_key:='registration-'||h.id;
 if deadline is not null then
  insert into work_core.tasks(tenant_id,task_key,title,description,status,assigned_staff_id,contact_id,opportunity_id,due_at,metadata)
  values(p_tenant_id,v_task_key,case when finance_waiting then 'مراجعة مالية طلب التسجيل' else 'استكمال التسجيل والتسكين' end,
   private_app.admission_waiting_label_v1(result->>'waitingReason'),'todo',owner,h.contact_id,h.opportunity_id,deadline,
   jsonb_build_object('source','admission_governance','handoffId',h.id,'waitingReason',result->>'waitingReason','ownerMissing',owner is null))
  on conflict(tenant_id,task_key) do update set title=excluded.title,description=excluded.description,due_at=excluded.due_at,
   assigned_staff_id=excluded.assigned_staff_id,
   status=case when work_core.tasks.status in ('completed','cancelled') then 'todo' else work_core.tasks.status end,
   completed_at=null,completion_timing=null,metadata=work_core.tasks.metadata||excluded.metadata;
 else
  update work_core.tasks set status=case when result->>'state'='enrolled' then 'completed' else 'cancelled' end,
   completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end
   where tenant_id=p_tenant_id and work_core.tasks.task_key=v_task_key and status in ('todo','in_progress');
 end if;
 delete from academy.admission_governance_queue where tenant_id=p_tenant_id and handoff_id=h.id;
 return result||jsonb_build_object('reviewAt',deadline,'ownerStaffId',owner);
end $$;

create function private_app.process_admission_governance_queue_v1(p_limit integer default 100) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare item record;processed integer:=0;failed integer:=0;outcome jsonb;closures jsonb;
begin
 for item in select q.* from academy.admission_governance_queue q join academy.admission_governance_settings cfg on cfg.tenant_id=q.tenant_id and cfg.enabled
  where q.retry_at<=now() order by q.retry_at,q.queued_at,q.handoff_id for update of q skip locked limit greatest(1,least(p_limit,100)) loop
  begin
   outcome:=private_app.reconcile_admission_governance_v1(item.tenant_id,item.handoff_id);
   if outcome->>'state'<>'queued' then processed:=processed+1;end if;
  exception when others then
   failed:=failed+1;
   update academy.admission_governance_queue set attempts=attempts+1,retry_at=now()+interval '5 minutes',last_error=left(sqlstate||':'||sqlerrm,240)
    where handoff_id=item.handoff_id;
  end;
 end loop;
 closures:=private_app.process_course_run_closure_v1(p_limit);
 return jsonb_build_object('processed',processed,'failed',failed,'closure',closures);
end $$;

create function private_app.process_admission_governance_run_v1(p_tenant_id uuid,p_run_id uuid) returns void
 language plpgsql security definer set search_path='' as $$
declare item record;
begin
 if not private_app.admission_governance_enabled_v1(p_tenant_id) then return;end if;
 for item in select q.handoff_id from academy.admission_governance_queue q
  join academy.registration_handoffs h on h.tenant_id=q.tenant_id and h.id=q.handoff_id
  where q.tenant_id=p_tenant_id and h.course_run_id=p_run_id order by q.queued_at,q.handoff_id
  for update of q skip locked limit 100 loop
  begin perform private_app.reconcile_admission_governance_v1(p_tenant_id,item.handoff_id);
  exception when lock_not_available then null;end;
 end loop;
end $$;

create function private_app.admission_governance_event_v1() returns trigger
 language plpgsql security definer set search_path='' as $$
declare h uuid;
begin
 if not private_app.admission_governance_enabled_v1(new.tenant_id) then return new;end if;
 if tg_table_name='course_runs' then
  if new.status is distinct from old.status or new.capacity is distinct from old.capacity then
   insert into academy.admission_governance_queue(tenant_id,handoff_id)
    select h.tenant_id,h.id from academy.registration_handoffs h where h.tenant_id=new.tenant_id and h.course_run_id=new.id and h.status not in ('completed','cancelled','rejected')
    on conflict(handoff_id) do update set retry_at=now();
  end if;
 else
  if tg_table_name='registration_handoffs' then h:=new.id;else h:=new.handoff_id;end if;
  perform private_app.queue_admission_governance_v1(new.tenant_id,h);
  begin perform private_app.reconcile_admission_governance_v1(new.tenant_id,h);
  exception when lock_not_available then null;end;
 end if;
 return new;
end $$;
create constraint trigger admission_governance_handoff after insert or update on academy.registration_handoffs
 deferrable initially deferred for each row execute function private_app.admission_governance_event_v1();
create constraint trigger admission_governance_document after insert or update on academy.registration_documents
 deferrable initially deferred for each row execute function private_app.admission_governance_event_v1();
create trigger admission_governance_run after update of status,capacity on academy.course_runs
 for each row execute function private_app.admission_governance_event_v1();

-- Retain optional documents for inactive policies; enabled policies may explicitly require documents.
alter table academy.registration_documents drop constraint if exists registration_documents_optional_only_check;
create or replace function private_app.force_registration_document_optional() returns trigger language plpgsql set search_path='' as $$
begin
 if not private_app.admission_governance_enabled_v1(new.tenant_id) then new.is_required:=false;end if;return new;
end $$;
comment on column academy.registration_documents.is_required is 'Optional by default; explicitly required documents block opt-in governance admissions until approved or a documented exception.';

alter function public.v2_tenant_update_admission_document(text,uuid,text,text,text,boolean) rename to v2_tenant_update_admission_document_before_governance_v1;
alter function public.v2_tenant_update_admission_document_before_governance_v1(text,uuid,text,text,text,boolean) set schema private_app;
create function public.v2_tenant_update_admission_document(p_tenant_slug text,p_handoff_id uuid,p_document_type text,p_status text,p_notes text default null,p_is_required boolean default true)
 returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid;was_required boolean;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.admission_governance_enabled_v1(t) then
  select is_required into was_required from academy.registration_documents where tenant_id=t and handoff_id=p_handoff_id and document_type=p_document_type;
  if coalesce(was_required,false) and (not p_is_required or p_status='not_required') then
   if private_app.current_subject_id() is null or not private_app.has_tenant_permission(t,'tenant.admissions.exceptions.approve') then raise exception 'document_exception_permission_required';end if;
   if length(trim(coalesce(p_notes,'')))<3 then raise exception 'reason_required';end if;
  end if;
 end if;
 return private_app.v2_tenant_update_admission_document_before_governance_v1(p_tenant_slug,p_handoff_id,p_document_type,p_status,p_notes,p_is_required);
end $$;

-- Preserve current integration locks/permissions and pilot fallback. Governance completion is its own atomic transition.
alter function public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text) rename to v2_tenant_update_admission_before_governance_v1;
alter function public.v2_tenant_update_admission_before_governance_v1(text,uuid,text,uuid,uuid,text,text) set schema private_app;
-- A delegated payment verifier may verify/reject an ordinary free admission
-- without receiving unrelated admissions editing or accounting permissions.
-- Preserve the legacy tenant/contact locks and every other action's ACL.
do $payment_verifier_acl$
declare definition text;needle text:=$needle$private_app.has_tenant_permission(t,'tenant.admissions.write')$needle$;
begin
 select pg_get_functiondef('private_app.v2_tenant_update_admission_before_governance_v1(text,uuid,text,uuid,uuid,text,text)'::regprocedure) into definition;
 if position(needle in definition)=0 then raise exception 'admission_verifier_acl_baseline_mismatch';end if;
 definition:=replace(definition,needle,needle||$replacement$ or (p_action in ('verify_payment','reject_payment') and (private_app.has_tenant_permission(t,'tenant.admissions.payment.verify') or private_app.has_accounting_permission(t,'tenant.accounting.payments.approve')))$replacement$);
 execute definition;
end $payment_verifier_acl$;
create function public.v2_tenant_update_admission(p_tenant_slug text,p_handoff_id uuid,p_action text,p_course_id uuid default null,
 p_course_run_id uuid default null,p_notes text default null,p_reason text default null) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare t uuid;result jsonb;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.admission_governance_enabled_v1(t) and p_action in ('complete','accept') then
  if private_app.current_subject_id() is null or not(private_app.has_tenant_permission(t,'tenant.admissions.write')
   or(p_action='complete' and p_course_id is null and p_course_run_id is null and private_app.training_journey_auto_admission_authorized_v1(t,p_handoff_id))) then raise exception 'forbidden';end if;
  if p_course_id is not null or p_course_run_id is not null or p_notes is not null then
   perform private_app.v2_tenant_update_admission_before_governance_v1(p_tenant_slug,p_handoff_id,'save_details',p_course_id,p_course_run_id,p_notes,p_reason);
  end if;
  result:=private_app.reconcile_admission_governance_v1(t,p_handoff_id);
  return result||jsonb_build_object('id',p_handoff_id,'action',p_action);
 end if;
 return private_app.v2_tenant_update_admission_before_governance_v1(p_tenant_slug,p_handoff_id,p_action,p_course_id,p_course_run_id,p_notes,p_reason);
end $$;

create or replace function private_app.validate_handoff_course_run() returns trigger language plpgsql set search_path='' as $$
declare r academy.course_runs%rowtype;n integer;enabled boolean:=private_app.admission_governance_enabled_v1(new.tenant_id);
begin
 if new.course_run_id is null then return new;end if;
 if tg_op='UPDATE' and new.course_run_id is not distinct from old.course_run_id and new.course_id is not distinct from old.course_id and new.tenant_id is not distinct from old.tenant_id then return new;end if;
 select * into r from academy.course_runs where id=new.course_run_id for update;
 if r.id is null or r.tenant_id<>new.tenant_id or r.course_id<>new.course_id then raise exception 'invalid_course_run';end if;
 if enabled then
  if r.status not in ('planning','open','in_progress') then raise exception 'course_run_unavailable';end if;
  return new;
 end if;
 if r.status<>'open' then raise exception 'course_run_not_open';end if;
 if r.registration_opens_at>now() then raise exception 'course_run_registration_not_started';end if;
 if r.registration_closes_at<now() then raise exception 'course_run_registration_closed';end if;
 select count(*) into n from academy.enrollments where course_run_id=r.id and status in ('confirmed','active','completed');
 if r.capacity is not null and n>=r.capacity then raise exception 'course_run_full';end if;return new;
end $$;
create or replace function private_app.validate_enrollment_course_run() returns trigger language plpgsql set search_path='' as $$
declare r academy.course_runs%rowtype;n integer;enabled boolean:=private_app.admission_governance_enabled_v1(new.tenant_id);financial jsonb;
begin
 if new.status not in ('confirmed','active','completed') then return new;end if;
 select * into r from academy.course_runs where id=new.course_run_id for update;
 if r.id is null or r.tenant_id<>new.tenant_id or r.course_id<>new.course_id then raise exception 'invalid_course_run';end if;
 if tg_op='UPDATE' and old.status in ('confirmed','active','completed') and new.course_run_id is not distinct from old.course_run_id and new.course_id is not distinct from old.course_id
  and new.tenant_id is not distinct from old.tenant_id and new.handoff_id=old.handoff_id and new.student_id=old.student_id and new.status in ('active','completed') then
  if r.status not in ('open','in_progress','completed') then raise exception 'course_run_not_operational';end if;return new;
 end if;
 if enabled then
  if not exists(select 1 from academy.registration_handoffs h where h.tenant_id=new.tenant_id and h.id=new.handoff_id and h.course_id=new.course_id and h.status not in ('cancelled','rejected')) then raise exception 'invalid_enrollment_handoff';end if;
  if r.status not in ('open','in_progress') then raise exception 'course_run_not_open';end if;
  if r.status='in_progress' and not exists(select 1 from academy.admission_governance_exceptions where tenant_id=new.tenant_id and handoff_id=new.handoff_id and course_run_id=r.id and kind='late_enrollment') then raise exception 'late_enrollment_approval_required';end if;
  if not exists(select 1 from academy.students s join sales_core.contacts c on c.tenant_id=s.tenant_id and c.id=s.contact_id
   where s.tenant_id=new.tenant_id and s.id=new.student_id and nullif(trim(c.phone),'') is not null) then raise exception 'beneficiary_phone_required';end if;
  if exists(select 1 from academy.registration_documents d where d.tenant_id=new.tenant_id and d.handoff_id=new.handoff_id and d.is_required and d.status not in ('approved','not_required')) then raise exception 'required_documents_incomplete';end if;
  financial:=private_app.admission_financial_eligibility_v1(new.tenant_id,new.handoff_id);
  if not coalesce((financial->>'eligible')::boolean,false) then raise exception '%',financial->>'reason';end if;
 elsif r.status<>'open' then raise exception 'course_run_not_open';end if;
 if r.status='open' then
  if r.registration_opens_at>now() then raise exception 'course_run_registration_not_started';end if;
  if r.registration_closes_at<now() then raise exception 'course_run_registration_closed';end if;
 end if;
 select count(*) into n from academy.enrollments where course_run_id=r.id and status in ('confirmed','active','completed') and id<>new.id;
 if r.capacity is not null and n>=r.capacity then raise exception 'course_run_full';end if;return new;
end $$;

-- Reuse the pilot's receipt and certificate guards. Its enrollment branch now
-- honors governed admission eligibility and never reclassifies academic progress as a debt event.
do $pilot_guard$
declare definition text;needle text:=$needle$ elsif tg_table_name='enrollments' and new.status in ('confirmed','active','completed') then$needle$;
begin
 definition:=pg_get_functiondef('private_app.training_journey_guard_finance_v1()'::regprocedure);
 if position(needle in definition)=0 then raise exception 'training_financial_guard_definition_changed';end if;
 definition:=replace(definition,needle,needle||$addition$
  if private_app.admission_governance_enabled_v1(new.tenant_id) then
   if tg_op='UPDATE' then
    if old.status in ('confirmed','active','completed') and new.course_run_id=old.course_run_id and new.student_id=old.student_id and new.handoff_id=old.handoff_id then return new;end if;
   end if;
   f:=private_app.admission_financial_eligibility_v1(new.tenant_id,new.handoff_id);
   if not coalesce((f->>'eligible')::boolean,false) then raise exception 'training_financial_clearance_required';end if;
   return new;
  end if;$addition$);
 execute definition;
end $pilot_guard$;

alter function private_app.training_journey_financial_access_v1(uuid,timestamptz) rename to training_journey_financial_access_before_governance_v1;
create function private_app.training_journey_financial_access_v1(p_enrollment_id uuid,p_as_of timestamptz default now()) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare e academy.enrollments%rowtype;result jsonb;academic_reasons jsonb:='[]';
begin
 result:=private_app.training_journey_financial_access_before_governance_v1(p_enrollment_id,p_as_of);
 select * into e from academy.enrollments where id=p_enrollment_id;
 if not private_app.admission_governance_enabled_v1(e.tenant_id) then return result;end if;
 if e.status not in ('confirmed','active','completed') then academic_reasons:=academic_reasons||jsonb_build_array('enrollment_inactive');end if;
 if e.metadata->>'trainingJourneyDeferred'='true' then academic_reasons:=academic_reasons||jsonb_build_array('enrollment_deferred');end if;
 if exists(select 1 from academy.students where tenant_id=e.tenant_id and id=e.student_id and status='blocked') then academic_reasons:=academic_reasons||jsonb_build_array('student_profile_blocked');end if;
 if not exists(select 1 from academy.registration_handoffs where tenant_id=e.tenant_id and id=e.handoff_id and status='completed') then academic_reasons:=academic_reasons||jsonb_build_array('admission_confirmation_required');end if;
 -- Enrollment already passed its initial financial gate. Collection continues,
 -- but later arrears cannot suspend study. A fee waiver does not erase the debt.
 return result||jsonb_build_object('trainingAllowed',jsonb_array_length(academic_reasons)=0,
  'certificationAllowed',jsonb_array_length(academic_reasons)=0 and coalesce((result->>'certificationAllowed')::boolean,false),
  'financialWarnings',coalesce(result->'reasonCodes','[]'),'reasonCodes',academic_reasons,'automaticFinancialSuspension',false);
end $$;

create function private_app.course_run_closure_evidence_v1(p_tenant_id uuid,p_run_id uuid) returns jsonb
 language sql stable security definer set search_path='' as $$
 select jsonb_build_object('dueForClosure',r.status='in_progress' and greatest(r.ends_at,(select max(s.ends_at) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status<>'cancelled'))+interval '48 hours'<=now(),
  'closureDueAt',greatest(r.ends_at,(select max(s.ends_at) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status<>'cancelled'))+interval '48 hours',
  'pendingSessions',(select count(*) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status='scheduled'),
  'futureSessions',(select count(*) from academy.course_run_sessions s where s.tenant_id=r.tenant_id and s.course_run_id=r.id and s.status<>'cancelled' and s.ends_at>now()),
  'missingAttendance',(select count(*) from academy.enrollments e join academy.course_run_sessions s on s.tenant_id=e.tenant_id and s.course_run_id=e.course_run_id
   and s.status<>'cancelled' and s.ends_at<=now() and e.enrolled_at<=s.ends_at
   where e.tenant_id=r.tenant_id and e.course_run_id=r.id and e.status in ('confirmed','active','completed')
   and not exists(select 1 from academy.attendance_records a where a.tenant_id=e.tenant_id and a.enrollment_id=e.id and a.session_id=s.id)))
 from academy.course_runs r where r.tenant_id=p_tenant_id and r.id=p_run_id
$$;
create function private_app.guard_course_run_closure_v1() returns trigger language plpgsql set search_path='' as $$
declare evidence jsonb;
begin
 if new.status='completed' and old.status<>'completed' and private_app.admission_governance_enabled_v1(new.tenant_id) then
  evidence:=private_app.course_run_closure_evidence_v1(new.tenant_id,new.id);
  if (evidence->>'futureSessions')::integer>0 or new.ends_at>now() then raise exception 'course_run_sessions_not_ended';end if;
  if (evidence->>'pendingSessions')::integer>0 then raise exception 'course_run_sessions_not_completed';end if;
  if (evidence->>'missingAttendance')::integer>0 and not exists(select 1 from academy.admission_governance_exceptions
   where tenant_id=new.tenant_id and course_run_id=new.id and kind='run_closure') then raise exception 'attendance_unrecorded_blocks_closure';end if;
  new.metadata:=new.metadata-'governanceClosureReviewOpen';
 end if;return new;
end $$;
create trigger admission_governance_closure_guard before update of status on academy.course_runs for each row execute function private_app.guard_course_run_closure_v1();

create function private_app.process_course_run_closure_v1(p_limit integer default 100) returns jsonb
 language plpgsql security definer set search_path='' as $$
declare run record;evidence jsonb;closed integer:=0;waiting integer:=0;owner uuid;v_key text;
begin
 for run in select r.*,cfg.placement_owner_staff_id,cfg.approved_by_subject_id from academy.course_runs r
  join academy.admission_governance_settings cfg on cfg.tenant_id=r.tenant_id and cfg.enabled
  where r.status='in_progress' and r.ends_at+interval '48 hours'<=now()
   and coalesce(r.metadata->>'governanceClosureReviewOpen','false')<>'true'
  order by r.metadata->>'governanceClosureCheckedAt' nulls first,r.ends_at,r.id for update of r skip locked limit greatest(1,least(p_limit,100)) loop
  update academy.course_runs set metadata=metadata||jsonb_build_object('governanceClosureCheckedAt',now()) where tenant_id=run.tenant_id and id=run.id;
  evidence:=private_app.course_run_closure_evidence_v1(run.tenant_id,run.id);
  if not coalesce((evidence->>'dueForClosure')::boolean,false) then continue;end if;
  v_key:='course-run-close-'||run.id;owner:=run.placement_owner_staff_id;
  if owner is not null and to_regprocedure('private_app.staff_operationally_available_v1(uuid,uuid,timestamptz)') is not null then
   if not private_app.staff_operationally_available_v1(run.tenant_id,owner,now()) then owner:=null;end if;
  end if;
  if (evidence->>'futureSessions')::integer=0 and (evidence->>'pendingSessions')::integer=0
   and ((evidence->>'missingAttendance')::integer=0 or exists(select 1 from academy.admission_governance_exceptions where tenant_id=run.tenant_id and course_run_id=run.id and kind='run_closure')) then
   update academy.course_runs set status='completed' where tenant_id=run.tenant_id and id=run.id;
   update work_core.tasks set status='completed',completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end
    where tenant_id=run.tenant_id and task_key=v_key and status in ('todo','in_progress');
   insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
    values(run.tenant_id,private_app.current_subject_id(),'tenant.course_run_auto_closed','course_run',run.id::text,
     evidence||jsonb_build_object('source','admission_governance_worker','policyApprovedBySubjectId',run.approved_by_subject_id));
   closed:=closed+1;
  else
   insert into work_core.tasks(tenant_id,task_key,title,description,status,assigned_staff_id,due_at,metadata)
   values(run.tenant_id,v_key,'استكمال متطلبات إغلاق الدفعة',
    'توجد محاضرات لم يؤكد إكمالها أو سجلات حضور غير مكتملة. راجع البيانات أو اطلب استثناء موثقًا.','todo',owner,
    (evidence->>'closureDueAt')::timestamptz,jsonb_build_object('source','admission_governance_run_closure','courseRunId',run.id,'ownerMissing',owner is null,'evidence',evidence))
   on conflict(tenant_id,task_key) do update set assigned_staff_id=excluded.assigned_staff_id,metadata=excluded.metadata;
   waiting:=waiting+1;
  end if;
 end loop;
 return jsonb_build_object('closed',closed,'waiting',waiting);
end $$;

-- Protect attendance evidence when editing a batch. Existing function signature/API remain unchanged.
do $preserve_sessions$
declare definition text;old_delete text:=E'  delete from academy.course_run_sessions\n  where course_run_id = v_run_id;';old_insert text:=$needle$      jsonb_build_object('source', 'course_run_workspace')
    );$needle$;
begin
 definition:=pg_get_functiondef('public.v2_tenant_save_course_run(text,uuid,text,text,timestamp without time zone,timestamp without time zone,integer,jsonb,uuid,text,text,text,bigint,timestamp without time zone,timestamp without time zone,text)'::regprocedure);
 if position(old_delete in definition)=0 or position(old_insert in definition)=0 then raise exception 'course_run_session_definition_changed';end if;
 definition:=replace(definition,old_delete,E'  delete from academy.course_run_sessions\n  where course_run_id = v_run_id and session_number > jsonb_array_length(p_sessions);');
 definition:=replace(definition,old_insert,$replacement$      jsonb_build_object('source', 'course_run_workspace')
    ) on conflict (course_run_id, session_number) do update set title=excluded.title,
      starts_at=excluded.starts_at,ends_at=excluded.ends_at,delivery_mode=excluded.delivery_mode,
      instructor_name=excluded.instructor_name,venue_or_link=excluded.venue_or_link;$replacement$);
 definition:=replace(definition,E'  return jsonb_build_object(\n    ''id'',',E'  perform private_app.process_admission_governance_run_v1(v_tenant.id,v_run_id);\n  return jsonb_build_object(\n    ''id'',');
 execute definition;
end $preserve_sessions$;
create function private_app.guard_session_evidence_v1() returns trigger language plpgsql set search_path='' as $$
begin
 if exists(select 1 from academy.attendance_records where tenant_id=old.tenant_id and session_id=old.id) then
  if tg_op='DELETE' then raise exception 'recorded_session_cannot_be_removed';end if;
  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at or new.session_number<>old.session_number
   or new.course_run_id<>old.course_run_id or new.status='cancelled' and old.status<>'cancelled' then raise exception 'recorded_session_schedule_locked';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
create trigger admission_session_evidence_guard before update or delete on academy.course_run_sessions for each row execute function private_app.guard_session_evidence_v1();

create function public.v1_tenant_admission_governance_snapshot(p_tenant_slug text) returns jsonb
 language plpgsql stable security definer set search_path='' as $$
declare t uuid;cfg academy.admission_governance_settings%rowtype;manage boolean;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.current_subject_id() is null or t is null or not private_app.has_tenant_permission(t,'tenant.admissions.read') then raise exception 'forbidden';end if;
 manage:=private_app.has_tenant_permission(t,'tenant.admissions.governance.manage');
 select * into cfg from academy.admission_governance_settings where tenant_id=t;
 return jsonb_build_object('enabled',coalesce(cfg.enabled,false),'canManage',manage,
  'canApproveExceptions',private_app.has_tenant_permission(t,'tenant.admissions.exceptions.approve'),
  'canApproveWaiver',private_app.has_accounting_permission(t,'tenant.accounting.payments.approve'),
  'canAgreePrice',private_app.has_accounting_permission(t,'tenant.accounting.invoices.write'),
  'financeBusinessDays',coalesce(cfg.finance_sla_business_days,1),'placementBusinessDays',coalesce(cfg.placement_sla_business_days,1),
  'weekendIsoDays',coalesce(cfg.weekend_iso_days,array[5,6]),'financeOwnerStaffId',cfg.finance_owner_staff_id,'placementOwnerStaffId',cfg.placement_owner_staff_id,
  'queueCount',(select count(*) from academy.admission_governance_queue where tenant_id=t),
  'failedCount',(select count(*) from academy.admission_governance_queue where tenant_id=t and last_error is not null),
  'staff',case when manage then coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.full_name)) from people.staff_profiles s where s.tenant_id=t and s.employment_status='active'),'[]'::jsonb) else '[]'::jsonb end);
end $$;

create function public.v1_tenant_admission_governance_action(p_tenant_slug text,p_action text,p_payload jsonb default '{}') returns jsonb
 language plpgsql security definer set search_path='' as $$
declare t uuid;h uuid;r uuid;token text;impact jsonb;enabled boolean;finance_days integer;placement_days integer;weekends integer[];staff uuid;reason text;result jsonb;
begin
 select id into t from core.tenants where slug=p_tenant_slug;
 if private_app.current_subject_id() is null or t is null then raise exception 'forbidden';end if;
 if p_action in ('preview_policy','save_policy') then
  if not private_app.has_tenant_permission(t,'tenant.admissions.governance.manage') then raise exception 'forbidden';end if;
  enabled:=coalesce((p_payload->>'enabled')::boolean,false);finance_days:=coalesce((p_payload->>'financeBusinessDays')::integer,1);
  placement_days:=coalesce((p_payload->>'placementBusinessDays')::integer,1);
  select coalesce(array_agg(distinct value::integer),array[]::integer[]) into weekends from jsonb_array_elements_text(coalesce(p_payload->'weekendIsoDays','[5,6]'));
  if finance_days not between 1 and 30 or placement_days not between 1 and 30 or cardinality(weekends)>6 or not weekends<@array[1,2,3,4,5,6,7] then raise exception 'invalid_admission_policy';end if;
  foreach staff in array array[(p_payload->>'financeOwnerStaffId')::uuid,(p_payload->>'placementOwnerStaffId')::uuid] loop
   if staff is not null and not exists(select 1 from people.staff_profiles where tenant_id=t and id=staff and employment_status='active') then raise exception 'invalid_sla_owner';end if;
  end loop;
  if enabled and (p_payload->>'financeOwnerStaffId' is null or p_payload->>'placementOwnerStaffId' is null) then raise exception 'sla_owners_required';end if;
  select jsonb_build_object('openAdmissions',count(*),'unclassifiedPrograms',count(*) filter(where to_jsonb(c)->>'program_kind' is null),
   'withoutRun',count(*) filter(where h.course_run_id is null),
   'readyToEnroll',count(*) filter(where private_app.admission_readiness_v1(t,h.id)->>'state'='ready')) into impact from academy.registration_handoffs h
   left join academy.courses c on c.tenant_id=h.tenant_id and c.id=h.course_id where h.tenant_id=t and h.status not in ('completed','cancelled','rejected');
  token:=md5(t::text||(p_payload-'previewToken'-'confirmed')::text||impact::text||coalesce((select updated_at::text from academy.admission_governance_settings where tenant_id=t),''));
  if p_action='preview_policy' then return jsonb_build_object('previewToken',token,'impact',impact,'enabled',enabled);end if;
  if p_payload->>'previewToken' is distinct from token or not coalesce((p_payload->>'confirmed')::boolean,false) then raise exception 'policy_preview_required';end if;
  insert into academy.admission_governance_settings(tenant_id,enabled,finance_sla_business_days,placement_sla_business_days,weekend_iso_days,finance_owner_staff_id,placement_owner_staff_id,approved_by_subject_id,activated_at)
  values(t,enabled,finance_days,placement_days,weekends,(p_payload->>'financeOwnerStaffId')::uuid,(p_payload->>'placementOwnerStaffId')::uuid,private_app.current_subject_id(),case when enabled then now() end)
  on conflict(tenant_id) do update set enabled=excluded.enabled,finance_sla_business_days=excluded.finance_sla_business_days,
   placement_sla_business_days=excluded.placement_sla_business_days,weekend_iso_days=excluded.weekend_iso_days,
   finance_owner_staff_id=excluded.finance_owner_staff_id,placement_owner_staff_id=excluded.placement_owner_staff_id,
   approved_by_subject_id=excluded.approved_by_subject_id,activated_at=coalesce(academy.admission_governance_settings.activated_at,excluded.activated_at),updated_at=now();
  if enabled then
   insert into academy.admission_governance_queue(tenant_id,handoff_id) select tenant_id,id from academy.registration_handoffs
    where tenant_id=t and status not in ('completed','cancelled','rejected') on conflict(handoff_id) do update set retry_at=now();
   if to_regnamespace('cron') is not null then execute $cron$select cron.schedule('admission-governance-v1','* * * * *','select private_app.process_admission_governance_queue_v1(100)')$cron$;end if;
  end if;
  perform private_app.write_audit('tenant.admission_governance_policy','tenant',t::text,t,jsonb_build_object('enabled',enabled,'impact',impact));
  return public.v1_tenant_admission_governance_snapshot(p_tenant_slug);
 end if;
 if not private_app.admission_governance_enabled_v1(t) then raise exception 'admission_governance_disabled';end if;
 h:=(p_payload->>'handoffId')::uuid;r:=(p_payload->>'courseRunId')::uuid;reason:=trim(coalesce(p_payload->>'reason',''));
 if p_action in ('approve_late_enrollment','approve_payment_waiver','close_run','reopen_run') then
  if p_action='approve_payment_waiver' then
   if not private_app.has_accounting_permission(t,'tenant.accounting.payments.approve') then raise exception 'forbidden';end if;
  elsif not private_app.has_tenant_permission(t,'tenant.admissions.exceptions.approve') then raise exception 'forbidden';end if;
  if length(reason)<3 then raise exception 'reason_required';end if;
  if p_action not in ('close_run','reopen_run') and not exists(select 1 from academy.registration_handoffs where tenant_id=t and id=h and status not in ('completed','cancelled')) then raise exception 'admission_not_found';end if;
  if p_action<>'approve_payment_waiver' and not exists(select 1 from academy.course_runs where tenant_id=t and id=r and status=case when p_action='reopen_run' then 'completed' else 'in_progress' end) then raise exception 'invalid_course_run_transition';end if;
  if p_action='approve_late_enrollment' and not exists(select 1 from academy.registration_handoffs where tenant_id=t and id=h and course_run_id=r) then raise exception 'handoff_run_mismatch';end if;
  if p_action='approve_payment_waiver' and exists(select 1 from academy.registration_handoffs h join academy.courses c on c.tenant_id=h.tenant_id and c.id=h.course_id where h.tenant_id=t and h.id=(p_payload->>'handoffId')::uuid and to_jsonb(c)->>'program_kind'='diploma') then raise exception 'use_diploma_contract_waiver';end if;
  insert into academy.admission_governance_exceptions(tenant_id,kind,handoff_id,course_run_id,agreed_course_id,reason,approved_by_subject_id)
  values(t,case p_action when 'approve_late_enrollment' then 'late_enrollment' when 'approve_payment_waiver' then 'payment_waiver' when 'reopen_run' then 'run_reopen' else 'run_closure' end,
   case when p_action not in ('close_run','reopen_run') then h end,case when p_action<>'approve_payment_waiver' then r end,
   (select course_id from academy.registration_handoffs where tenant_id=t and id=h),reason,private_app.current_subject_id());
  if p_action='close_run' then
   update academy.course_runs set status='completed' where tenant_id=t and id=r;
   update work_core.tasks set status='completed',completed_at=now(),completion_timing=case when now()<=due_at then 'on_time' else 'late' end
    where tenant_id=t and task_key='course-run-close-'||r and status in ('todo','in_progress');
   result:=jsonb_build_object('courseRunId',r,'status','completed');
  elsif p_action='reopen_run' then
   update academy.course_runs set status='in_progress',metadata=metadata||jsonb_build_object('governanceClosureReviewOpen',true)
    where tenant_id=t and id=r;
   select placement_owner_staff_id into staff from academy.admission_governance_settings where tenant_id=t;
   if staff is not null and to_regprocedure('private_app.staff_operationally_available_v1(uuid,uuid,timestamptz)') is not null then
    if not private_app.staff_operationally_available_v1(t,staff,now()) then staff:=null;end if;
   end if;
   insert into work_core.tasks(tenant_id,task_key,title,description,status,assigned_staff_id,due_at,metadata)
   values(t,'course-run-close-'||r,'مراجعة الدفعة المعاد فتحها',reason,'todo',staff,
    private_app.admission_business_deadline_v1(t,now(),(select placement_sla_business_days from academy.admission_governance_settings where tenant_id=t)),
    jsonb_build_object('source','admission_governance_run_closure','courseRunId',r,'manualReview',true,'ownerMissing',staff is null))
   on conflict(tenant_id,task_key) do update set title=excluded.title,description=excluded.description,status='todo',completed_at=null,completion_timing=null,
    assigned_staff_id=excluded.assigned_staff_id,due_at=excluded.due_at,metadata=work_core.tasks.metadata||excluded.metadata;
   result:=jsonb_build_object('courseRunId',r,'status','in_progress','manualClosureReview',true);
  else result:=private_app.reconcile_admission_governance_v1(t,h);end if;
  perform private_app.write_audit('tenant.'||p_action,'admission_governance',coalesce(h,r)::text,t,jsonb_build_object('reason',reason));return result;
 elsif p_action='set_agreed_price' then
  if not private_app.has_accounting_permission(t,'tenant.accounting.invoices.write') then raise exception 'forbidden';end if;
  if length(reason)<3 then raise exception 'reason_required';end if;
  if not exists(select 1 from academy.registration_handoffs where tenant_id=t and id=h and status not in ('completed','cancelled')) then raise exception 'admission_not_found';end if;
  insert into academy.admission_commercial_terms(tenant_id,handoff_id,course_id,amount_minor,currency,reason,approved_by_subject_id)
  values(t,h,(select course_id from academy.registration_handoffs where tenant_id=t and id=h),(p_payload->>'amountMinor')::bigint,p_payload->>'currency',reason,private_app.current_subject_id());
  perform private_app.write_audit('tenant.admission_price_agreed','registration_handoff',h::text,t,p_payload-'handoffId');
  return private_app.reconcile_admission_governance_v1(t,h);
 elsif p_action='reevaluate' then
  if not private_app.has_tenant_permission(t,'tenant.admissions.write') then raise exception 'forbidden';end if;
  return private_app.reconcile_admission_governance_v1(t,h);
 elsif p_action='process_queue' then
  if not private_app.has_tenant_permission(t,'tenant.admissions.governance.manage') then raise exception 'forbidden';end if;
  -- Tenant-scoped requests may never drain another tenant's queue.
  for h in select q.handoff_id from academy.admission_governance_queue q where q.tenant_id=t order by q.queued_at for update skip locked limit 100 loop
   perform private_app.reconcile_admission_governance_v1(t,h);
  end loop;return jsonb_build_object('ok',true);
 end if;raise exception 'invalid_admission_governance_action';
end $$;

alter function public.v3_tenant_admissions_snapshot(text) rename to v3_tenant_admissions_snapshot_before_governance_v1;
alter function public.v3_tenant_admissions_snapshot_before_governance_v1(text) set schema private_app;
create function public.v3_tenant_admissions_snapshot(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;t uuid;enabled boolean;
begin
 result:=private_app.v3_tenant_admissions_snapshot_before_governance_v1(p_slug);select id into t from core.tenants where slug=p_slug;
 enabled:=private_app.admission_governance_enabled_v1(t);
 result:=result||jsonb_build_object('admissionGovernance',public.v1_tenant_admission_governance_snapshot(p_slug));
 if not coalesce((result#>>'{viewer,canViewFinancialDetails}')::boolean,false) then
  result:=jsonb_set(result,'{cases}',(select coalesce(jsonb_agg(case when x.value ? 'beneficiaries' then
   jsonb_set(x.value,'{beneficiaries}',(select coalesce(jsonb_agg(seat-'allocatedMinor'),'[]') from jsonb_array_elements(x.value->'beneficiaries') seat)) else x.value end order by x.ordinality),'[]')
   from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)));
 end if;
 if enabled then
  result:=result||jsonb_build_object('cases',(select coalesce(jsonb_agg(x.value||jsonb_build_object('readiness',
   private_app.admission_readiness_v1(t,(x.value->>'id')::uuid)||jsonb_build_object('reviewAt',r.review_at)) order by x.ordinality),'[]')
   from jsonb_array_elements(result->'cases') with ordinality x(value,ordinality)
   left join academy.admission_readiness r on r.tenant_id=t and r.handoff_id=(x.value->>'id')::uuid));
 end if;return result;
end $$;

alter function public.v2_tenant_course_runs_snapshot(text) rename to v2_tenant_course_runs_snapshot_before_governance_v1;
alter function public.v2_tenant_course_runs_snapshot_before_governance_v1(text) set schema private_app;
create function public.v2_tenant_course_runs_snapshot(p_slug text) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;t uuid;
begin
 result:=private_app.v2_tenant_course_runs_snapshot_before_governance_v1(p_slug);select id into t from core.tenants where slug=p_slug;
 if not private_app.admission_governance_enabled_v1(t) then return result;end if;
 result:=jsonb_set(result,'{viewer}',coalesce(result->'viewer','{}')||jsonb_build_object('canApproveClosure',private_app.has_tenant_permission(t,'tenant.admissions.exceptions.approve')));
 return result||jsonb_build_object('courseRuns',(select coalesce(jsonb_agg(x.value||jsonb_build_object('closureEvidence',
  private_app.course_run_closure_evidence_v1(t,(x.value->>'id')::uuid)) order by x.ordinality),'[]')
  from jsonb_array_elements(result->'courseRuns') with ordinality x(value,ordinality)));
end $$;

revoke all on function private_app.admission_governance_enabled_v1(uuid),private_app.admission_business_deadline_v1(uuid,timestamptz,integer),
 private_app.admission_financial_eligibility_v1(uuid,uuid),private_app.admission_readiness_v1(uuid,uuid),
 private_app.queue_admission_governance_v1(uuid,uuid),private_app.admission_waiting_label_v1(text),private_app.reconcile_admission_governance_v1(uuid,uuid),
 private_app.process_admission_governance_queue_v1(integer),private_app.process_admission_governance_run_v1(uuid,uuid),private_app.process_course_run_closure_v1(integer),private_app.admission_governance_event_v1(),
 private_app.v2_tenant_update_admission_before_governance_v1(text,uuid,text,uuid,uuid,text,text),
 private_app.v2_tenant_update_admission_document_before_governance_v1(text,uuid,text,text,text,boolean),
 private_app.course_run_closure_evidence_v1(uuid,uuid),private_app.guard_course_run_closure_v1(),private_app.guard_session_evidence_v1(),
 private_app.guard_admission_decision_history_v1(),
 private_app.training_journey_financial_access_before_governance_v1(uuid,timestamptz),private_app.training_journey_financial_access_v1(uuid,timestamptz),
 private_app.v3_tenant_admissions_snapshot_before_governance_v1(text),private_app.v2_tenant_course_runs_snapshot_before_governance_v1(text) from public,anon,authenticated,service_role;
revoke all on function public.v1_tenant_admission_governance_snapshot(text),public.v1_tenant_admission_governance_action(text,text,jsonb),
 public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text),public.v2_tenant_update_admission_document(text,uuid,text,text,text,boolean),public.v3_tenant_admissions_snapshot(text),public.v2_tenant_course_runs_snapshot(text) from public,anon,authenticated,service_role;
grant execute on function public.v1_tenant_admission_governance_snapshot(text),public.v1_tenant_admission_governance_action(text,text,jsonb),
 public.v2_tenant_update_admission(text,uuid,text,uuid,uuid,text,text),public.v2_tenant_update_admission_document(text,uuid,text,text,text,boolean),public.v3_tenant_admissions_snapshot(text),public.v2_tenant_course_runs_snapshot(text) to authenticated;

commit;
