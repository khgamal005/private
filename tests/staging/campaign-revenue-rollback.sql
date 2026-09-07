-- Staging-only PostgreSQL role/contract check, not a browser/JWT transport test.
-- Run only on platform-Staging (pzflscqwfkixclmjyran). The model tenant must
-- contain no sales data. Every fixture, grant, event and review is rolled back.
-- No role/helper replacement, trigger disabling or Reef fixture is used.
set statement_timeout='45s';
do $qa$
declare
  tenant uuid; actor uuid; auth_user uuid; product uuid; course uuid; stage uuid;
  contact_paid uuid; contact_wrong uuid; opportunity_first uuid; opportunity_repeat uuid;
  batch uuid; queued uuid; duplicate_row uuid; handoff uuid; repeat_handoff uuid;
  customer uuid; ledger_payment uuid; connection uuid; account uuid; campaign uuid;
  command uuid:=gen_random_uuid(); preview jsonb; rows_to_review jsonb; report jsonb;
  first_result jsonb; replay jsonb; cash_result jsonb; explain_result jsonb;
  result jsonb; report_bytes integer; denied boolean; saved_role text;
begin
  select id into strict tenant from core.tenants where slug='modaar-training-center';
  if exists(select 1 from sales_core.contacts where tenant_id=tenant)
    or exists(select 1 from sales_core.lead_import_rows where tenant_id=tenant)
    or exists(select 1 from academy.registration_handoffs where tenant_id=tenant) then
    raise exception 'QA requires the empty staging model tenant; never run on production';
  end if;
  select s.id,s.auth_user_id into strict actor,auth_user
  from access_control.memberships m join access_control.subjects s on s.id=m.subject_id
  where m.tenant_id=tenant and m.status='active' and s.status='active';
  saved_role:=current_user;
  begin
    perform set_config('request.jwt.claims',jsonb_build_object('sub',auth_user,'role','authenticated')::text,true);
    if not private_app.has_tenant_permission(tenant,'tenant.reports.campaigns')
      or not private_app.has_tenant_permission(tenant,'tenant.meta_connect.manage')
      or not private_app.has_accounting_permission(tenant,'tenant.accounting.reports.read') then
      raise exception 'Staging model owner lacks required real permissions';
    end if;
    if has_table_privilege('authenticated','marketing_hub.campaign_source_reviews','SELECT')
      or has_table_privilege('anon','marketing_hub.campaign_source_reviews','SELECT')
      or has_table_privilege('service_role','marketing_hub.campaign_source_reviews','SELECT')
      or has_function_privilege('authenticated','private_app.campaign_origins_v1(uuid)','EXECUTE') then
      raise exception 'Private report storage or helper is exposed';
    end if;
    select id into strict product from catalog.addon_products where product_key='social_connect';
    insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status,source,decision_note,period_start,activated_at,auto_renew,period_is_authoritative)
    values(tenant,product,'active','migration','Rollback-only campaign QA',now(),now(),false,false);
    insert into marketing_hub.campaign_report_rollouts values(tenant,true);
    insert into academy.courses(tenant_id,course_code,title_ar,category)
    values(tenant,'CAMPAIGN-ROLLBACK-QA','دورة اختبار التقرير','general') returning id into course;
    select id into strict stage from sales_core.pipeline_stages where tenant_id=tenant order by id limit 1;
    insert into sales_core.contacts(tenant_id,full_name,phone,source,campaign_name,lead_status,interest_course_id,created_at)
    values(tenant,'QA verified customer','+12025550101','meta','QA Campaign','paid',course,'2026-08-05T00:00:00Z') returning id into contact_paid;
    insert into sales_core.contacts(tenant_id,full_name,phone,source,campaign_name,lead_status,closure_reason,closed_at,created_at)
    values(tenant,'QA wrong number','+12025550102','meta','QA Campaign','wrong_number','Synthetic QA closure',now(),'2026-08-06T00:00:00Z') returning id into contact_wrong;
    insert into sales_core.opportunities(tenant_id,contact_id,stage_id,title,status,created_at)
    values(tenant,contact_paid,stage,'QA first registration','won','2026-08-05T01:00:00Z') returning id into opportunity_first;
    insert into sales_core.opportunities(tenant_id,contact_id,stage_id,title,status,created_at)
    values(tenant,contact_paid,stage,'QA repeat registration','won','2026-09-01T01:00:00Z') returning id into opportunity_repeat;
    insert into sales_core.lead_import_batches(tenant_id,batch_key,file_name)
    values(tenant,'campaign-rollback-qa','campaign-rollback-qa.xlsx') returning id into batch;
    insert into sales_core.lead_import_rows(tenant_id,batch_id,row_number,source,campaign_name,full_name,validation_status,queue_status,raw_data,created_at)
    values(tenant,batch,1,'meta','QA Campaign','QA queued','valid','awaiting_distribution','{"receivedAt":"2026-08-04"}','2026-08-07T00:00:00Z') returning id into queued;
    insert into sales_core.lead_import_rows(tenant_id,batch_id,row_number,source,campaign_name,full_name,duplicate_contact_id,validation_status,queue_status,created_at)
    values(tenant,batch,2,'meta','QA Campaign','QA duplicate',contact_paid,'duplicate','skipped','2026-08-08T00:00:00Z') returning id into duplicate_row;
    insert into sales_core.lead_import_rows(tenant_id,batch_id,row_number,full_name,validation_status,queue_status,created_at)
    values(tenant,batch,3,'QA invalid','invalid','skipped','2026-08-08T00:00:00Z');
    insert into academy.registration_handoffs(tenant_id,handoff_key,contact_id,opportunity_id,course_id,status,payment_status,payment_verified_at,payment_verified_by_subject_id,payment_amount_minor)
    values(tenant,'campaign-qa-first',contact_paid,opportunity_first,course,'accepted','verified','2026-09-02T00:00:00Z',actor,10000) returning id into handoff;
    insert into academy.registration_handoffs(tenant_id,handoff_key,contact_id,opportunity_id,course_id,status,payment_status,payment_amount_minor)
    values(tenant,'campaign-qa-repeat',contact_paid,opportunity_repeat,course,'accepted','pending_verification',90000) returning id into repeat_handoff;
    insert into marketing_hub.connections(tenant_id,provider_key,api_version,status,frequency)
    values(tenant,'meta','v26.0','draft','manual') returning id into connection;
    insert into marketing_hub.ad_accounts(tenant_id,connection_id,provider_key,external_account_id,name,currency)
    values(tenant,connection,'meta','qa-rollback-account','QA account','SAR') returning id into account;
    insert into marketing_hub.campaigns(tenant_id,ad_account_id,provider_key,external_campaign_id,name)
    values(tenant,account,'meta','qa-rollback-campaign','QA Campaign') returning id into campaign;

    execute 'set local role authenticated';
    report:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05');
    if (report#>>'{summary,leads}')::int<>3 or (report#>>'{summary,payers}')::int<>1
      or (report#>>'{summary,duplicates}')::int<>1 or (report#>>'{summary,invalid}')::int<>1
      or (report#>>'{groups,0,conversion}')::numeric<>33.33
      or (report#>>'{groups,0,unqualified}')::int<>1 then raise exception 'Cohort denominator/confirmation mismatch'; end if;
    report:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-08-31');
    if (report#>>'{summary,payers}')::int<>0 then raise exception 'Late payment included before its confirmation'; end if;
    preview:=public.v1_tenant_campaign_sources('modaar-training-center');
    select jsonb_agg(jsonb_build_object('key',value->>'key','token',value->>'token')) into rows_to_review
    from jsonb_array_elements(preview->'rows');
    first_result:=public.v1_tenant_campaign_source_review('modaar-training-center',command,rows_to_review,campaign,null,'Rollback-only reviewed source evidence');
    replay:=public.v1_tenant_campaign_source_review('modaar-training-center',command,rows_to_review,campaign,null,'Rollback-only reviewed source evidence');
    if (first_result->>'reviewed')::int<>5 or replay->>'replayed'<>'true' then raise exception 'Review retry is not idempotent'; end if;
    denied:=false;
    begin
      perform public.v1_tenant_campaign_source_review('modaar-training-center',gen_random_uuid(),rows_to_review,campaign,null,'Stale preview must fail');
    exception when others then
      if sqlerrm='source_changed_refresh_preview' then denied:=true; else raise; end if;
    end;
    if not denied then raise exception 'Stale source preview was accepted'; end if;
    execute format('set local role %I',saved_role);
    insert into accounting_core.customer_accounts(tenant_id,contact_id,account_number,display_name)
    values(tenant,contact_paid,'CAMPAIGN-QA','QA customer') returning id into customer;
    insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,status,source_type,source_id,verified_at,verified_by_subject_id)
    values(tenant,customer,'CAMPAIGN-QA-1',10000,'verified','registration_handoff',handoff::text,'2026-09-03T00:00:00Z',actor) returning id into ledger_payment;
    insert into accounting_core.refunds(tenant_id,customer_account_id,payment_id,amount_minor,reason,status,completed_at,completed_by_subject_id)
    values(tenant,customer,ledger_payment,2000,'QA partial refund','completed','2026-09-04T00:00:00Z',actor);
    insert into accounting_core.payments(tenant_id,customer_account_id,payment_number,amount_minor,status,source_type,verified_at,verified_by_subject_id)
    values(tenant,customer,'CAMPAIGN-QA-UNLINKED',20000,'verified','manual','2026-09-03T00:00:00Z',actor);
    update academy.registration_handoffs set payment_status='verified',payment_verified_at='2026-09-04T00:00:00Z',payment_verified_by_subject_id=actor where id=repeat_handoff and tenant_id=tenant;
    execute 'set local role authenticated';
    cash_result:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-09-01','2026-09-05','2026-09-05','cash');
    if (cash_result#>>'{groups,0,money,0,netMinor}')::bigint<>8000
      or (cash_result#>>'{unattributedCash,0,netMinor}')::bigint<>110000
      or cash_result#>>'{groups,0,conversion}' is not null then raise exception 'Cash dedup/refund/unlinked reconciliation mismatch'; end if;
    execute format('set local role %I',saved_role);
    update sales_core.opportunities set metadata=jsonb_build_object('importRowId',duplicate_row) where id=opportunity_repeat and tenant_id=tenant;
    execute 'set local role authenticated';
    report:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05');
    if (report#>>'{summary,payers}')::int<>1 or (report#>>'{groups,0,money,0,netMinor}')::bigint<>8000
      or (report#>>'{additionalCash,0,netMinor}')::bigint<>90000 then raise exception 'Repeat purchase was credited as new acquisition'; end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
    denied:=false;
    begin
      perform public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05');
    exception when others then
      if sqlerrm='forbidden' then denied:=true; else raise; end if;
    end;
    if not denied then raise exception 'Nonmember report request was accepted'; end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',auth_user,'role','authenticated')::text,true);
    execute format('set local role %I',saved_role);
    insert into sales_core.lead_import_rows(tenant_id,batch_id,row_number,source,campaign_name,full_name,validation_status,queue_status,created_at)
    select tenant,batch,10+n,'manual','QA volume '||(n%30),'QA queued volume','valid','awaiting_distribution','2026-08-12T00:00:00Z'
    from generate_series(1,3000) n;
    execute 'set local role authenticated';
    execute $plan$explain(analyze,buffers,format json) select public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05')$plan$ into explain_result;
    report:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05');
    report_bytes:=octet_length(report::text);
    if (report#>>'{summary,leads}')::int<>3003 or jsonb_array_length(report->'details')<>50
      or (explain_result#>>'{0,Execution Time}')::numeric>5000 or report_bytes>250000 then raise exception 'Staging volume/payload threshold exceeded'; end if;
    preview:=public.v1_tenant_campaign_sources('modaar-training-center',null,200);
    if jsonb_array_length(preview->'rows')<>200 then raise exception 'Source preview is not bounded'; end if;
    execute format('set local role %I',saved_role);
    update marketing_hub.campaign_report_rollouts set enabled=false where tenant_id=tenant;
    execute 'set local role authenticated';
    report:=public.v1_tenant_campaign_revenue_report('modaar-training-center','2026-08-01','2026-08-31','2026-09-05');
    if report->>'enabled'<>'false' then raise exception 'Rollout rollback did not disable the report'; end if;
    result:=jsonb_build_object('passed',true,'role','authenticated','realPermissionHelpers',true,'jwtTransportTest',false,
      'leadVolume',3003,'groups',31,'reportBytes',report_bytes,'reportExplain',explain_result,
      'checks',jsonb_build_array('private grants','real member permissions','late confirmation','queued/invalid/duplicate denominator','review replay','stale review rejection','accounting deduplication','partial refund','unknown origin','repeat purchase','nonmember denial','bounded pages','kill switch'));
    raise exception using errcode='ZQ001',message='rollback successful synthetic QA';
  exception when sqlstate 'ZQ001' then null;
  end;
  if exists(select 1 from sales_core.contacts where tenant_id=tenant)
    or exists(select 1 from marketing_hub.campaign_source_reviews where tenant_id=tenant)
    or exists(select 1 from marketing_hub.campaign_report_rollouts where tenant_id=tenant) then
    raise exception 'Staging fixtures were not rolled back';
  end if;
  perform set_config('campaign.qa.result',result::text,true);
end;
$qa$;
select current_setting('campaign.qa.result')::jsonb as result;
