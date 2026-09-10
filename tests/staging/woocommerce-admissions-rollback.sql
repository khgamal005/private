-- Execute only on platform-Staging. Every synthetic row and role change rolls back.
-- No permission helper replacement, trigger disabling, production writes or network messages.
begin;
set local statement_timeout='45s';
do $qa$
declare t uuid; actor uuid; auth_user uuid; member uuid; manager uuid; previous uuid; seller uuid; registrar uuid;
 department uuid; c1 uuid; c2 uuid; contact uuid; connection uuid; entity uuid; task uuid; work_item uuid; run uuid;
 cmd uuid:=gen_random_uuid(); choices jsonb; ctx jsonb; result jsonb; args_revision text; first_handoff uuid; denied boolean;
 report jsonb; baseline jsonb; qplan jsonb;
begin
 select id into strict t from core.tenants where slug='modaar-training-center';
 if exists(select 1 from sales_core.contacts where tenant_id=t) or exists(select 1 from sales_core.commerce_order_work_items where tenant_id=t)
  or exists(select 1 from people.staff_profiles where tenant_id=t) then raise exception 'QA requires empty staging model';end if;
 select m.id,s.id,s.auth_user_id into strict member,actor,auth_user from access_control.memberships m
  join access_control.subjects s on s.id=m.subject_id where m.tenant_id=t and m.status='active' and s.status='active';
 perform set_config('request.jwt.claims',jsonb_build_object('sub',auth_user,'role','authenticated')::text,true);
 if not private_app.has_tenant_permission(t,'tenant.commerce_orders.distribute') then raise exception 'real manager permission missing';end if;
 insert into people.departments(tenant_id,department_key,name_ar) values(t,'admissions','التسجيل التجريبي') returning id into department;
 insert into people.staff_profiles(tenant_id,membership_id,full_name,job_title,role_key) values(t,member,'مدير اختبار Woo','QA','sales_manager') returning id into manager;
 insert into people.staff_profiles(tenant_id,full_name,job_title,role_key) values(t,'الموظف السابق التجريبي','QA','sales_user') returning id into previous;
 insert into people.staff_profiles(tenant_id,full_name,job_title,role_key) values(t,'الموظف الجديد التجريبي','QA','sales_user') returning id into seller;
 insert into people.staff_profiles(tenant_id,full_name,job_title,role_key,department_id) values(t,'التسجيل التجريبي','QA','customer_service',department) returning id into registrar;
 insert into academy.courses(tenant_id,course_code,title_ar,category) values(t,'WOO-QA-A','دورة اختبار أولى','general') returning id into c1;
 insert into academy.courses(tenant_id,course_code,title_ar,category) values(t,'WOO-QA-B','دورة اختبار ثانية','general') returning id into c2;
 insert into academy.course_runs(tenant_id,course_id,run_code,title,delivery_mode,status,starts_at,capacity)
  values(t,c1,'WOO-QA-RUN','دفعة اختبار معزولة','online','open',now()+interval '30 days',10) returning id into run;
 insert into sales_core.contacts(tenant_id,full_name,phone,owner_staff_id)
  values(t,'عميل اختبار Woo معزول','0509999911',previous) returning id into contact;
 insert into commerce_sync.connections(tenant_id,store_url,status,frequency)
  values(t,'https://synthetic-woo.invalid','disabled','manual') returning id into connection;
 insert into commerce_sync.external_entities(tenant_id,connection_id,entity_type,external_id,raw_payload)
  values(t,connection,'orders','9001',jsonb_build_object('id',9001,'status','completed','total','150.01','currency','SAR',
   '_marktone',jsonb_build_object('paidAt','2026-09-01T21:30:00Z'),'refunds','[]'::jsonb,'line_items',jsonb_build_array(
    jsonb_build_object('id',101,'name','منتج أول','quantity',1,'total','100.00','total_tax','0'),
    jsonb_build_object('id',102,'name','منتج ثان','quantity',1,'total','50.00','total_tax','0')))) returning id into entity;
 insert into work_core.tasks(tenant_id,task_key,title,status,assigned_staff_id,contact_id,due_at,metadata)
  values(t,'woo-rollback-qa','طلب Woo تجريبي','todo',previous,contact,now()+interval '1 day','{"source":"woocommerce_order"}') returning id into task;
 insert into sales_core.commerce_order_work_items(tenant_id,connection_id,external_entity_id,external_order_id,task_id,
  contact_id,assigned_staff_id,routing_state,order_number,order_status,payment_state,amount_minor,paid_at,first_seen_at)
  values(t,connection,entity,'9001',task,contact,previous,'assigned','9001','completed','paid',15001,'2026-09-01T21:30Z',now()-interval '10 days') returning id into work_item;
 insert into sales_core.commerce_admission_rollouts(tenant_id,enabled) values(t,true);
 perform public.v3_tenant_commerce_order_action('modaar-training-center','assign',jsonb_build_object('itemIds',jsonb_build_array(work_item),'staffId',seller));
 if (select owner_staff_id from sales_core.contacts where id=contact)<>seller then raise exception 'owner did not move';end if;
 if (select count(*) from work_core.notifications where tenant_id=t and notification_type='lead_reassigned')<>3 then raise exception 'recipient mismatch';end if;
 ctx:=public.v1_tenant_woocommerce_admission_context('modaar-training-center',task);
 if ctx->'blockers'<>'[]'::jsonb then raise exception 'unexpected blockers: %',ctx->'blockers';end if;
 choices:=jsonb_build_array(jsonb_build_object('lineId','101','courseId',c1,'handoffId',null),jsonb_build_object('lineId','102','courseId',c2,'handoffId',null));
 denied:=false;begin
  perform public.v1_tenant_woocommerce_admission_action('modaar-training-center',task,'complete',ctx->>'revision',gen_random_uuid(),choices,'');
 exception when others then if sqlerrm='woocommerce_review_required' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'historical order bypassed review';end if;
 result:=public.v1_tenant_woocommerce_admission_action('modaar-training-center',task,'review',ctx->>'revision',cmd,choices,'تمت مراجعة الطلب التجريبي القديم');
 ctx:=public.v1_tenant_woocommerce_admission_context('modaar-training-center',task);args_revision:=ctx->>'revision';cmd:=gen_random_uuid();
 result:=public.v1_tenant_woocommerce_admission_action('modaar-training-center',task,'complete',args_revision,cmd,choices,'');
 if jsonb_array_length(result->'handoffs')<>2 then raise exception 'handoff count mismatch';end if;
 result:=public.v1_tenant_woocommerce_admission_action('modaar-training-center',task,'complete',args_revision,cmd,choices,'');
 if result->>'replayed'<>'true' then raise exception 'command retry failed';end if;
 if (select count(*) from academy.registration_handoffs where tenant_id=t and payment_status='verified')<>2
  or (select sum(payment_amount_minor) from academy.registration_handoffs where tenant_id=t)<>15001 then raise exception 'money or verification mismatch';end if;
 select handoff_id into first_handoff from sales_core.commerce_admission_lines where tenant_id=t and course_id=c1;
 result:=public.v2_tenant_update_admission('modaar-training-center',first_handoff,'complete',c1,run,null,null);
 if result->>'enrollmentId' is null then raise exception 'enrollment missing';end if;
 if (select enrolled_count from academy.course_runs where id=run)<>1 then raise exception 'capacity counter mismatch';end if;
 ctx:=public.v3_tenant_admissions_snapshot('modaar-training-center');
 if (select count(*) from jsonb_array_elements(ctx->'cases') x where x->>'paymentSource'='woocommerce')<>2
  then raise exception 'admission source labels missing';end if;
 execute format('explain (analyze,buffers,format json) select public.v1_tenant_woocommerce_admission_context(%L,%L::uuid)',
  'modaar-training-center',task) into qplan;
 report:=jsonb_build_object('realPermissionHelpers',true,'ownershipTransferred',true,'notificationRecipients',3,
  'verifiedHandoffs',2,'totalMinor',15001,'enrollments',1,'idempotent',true,'contextBytes',
  octet_length(public.v1_tenant_woocommerce_admission_context('modaar-training-center',task)::text),'queryPlan',qplan);
 -- Actual authenticated role: direct storage and unauthorized RPCs remain denied.
 execute 'set local role authenticated';
 denied:=false;begin execute 'select * from sales_core.commerce_admission_orders';exception when insufficient_privilege then denied:=true;end;
 if not denied then raise exception 'private table exposed';end if;
 perform public.v1_tenant_woocommerce_admission_context('modaar-training-center',task);
 perform set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000999","role":"authenticated"}',true);
 denied:=false;begin perform public.v1_tenant_woocommerce_admission_context('modaar-training-center',task);
 exception when others then if sqlerrm='forbidden' then denied:=true;else raise;end if;end;
 if not denied then raise exception 'nonmember read allowed';end if;
 execute 'reset role';
 perform set_config('odeir.woo_qa_report',report::text,true);
end $qa$;
select current_setting('odeir.woo_qa_report')::jsonb as report;
rollback;
