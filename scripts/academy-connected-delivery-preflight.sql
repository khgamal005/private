-- Read-only release preflight. Contains no activation or production mutations.
select id,slug,status,timezone from core.tenants
 where id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and slug='marktone';
select tenant_id,mode,enabled,lms_enabled,website_enabled,store_enabled,version from academy.platform_settings
 where tenant_id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid;
select p.oid::regprocedure::text signature,md5(pg_get_functiondef(p.oid)) definition_hash
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where (n.nspname='public' and p.proname in ('v1_academy_storefront','v1_academy_store_order','v1_academy_commerce_action'))
 or (n.nspname='private_app' and p.proname in ('academy_store_order_view_v1','admission_financial_eligibility_v1','commerce_order_pick_assignee','commerce_order_queue_owner'));
select policyname,permissive,roles,cmd,qual,with_check from pg_policies
 where schemaname='storage' and tablename='objects' order by policyname;
select id,public,file_size_limit,allowed_mime_types from storage.buckets where id='academy-course-media';
select n.nspname,c.relname,pg_size_pretty(pg_total_relation_size(c.oid)) total_size
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where (n.nspname,c.relname) in (('academy','store_orders'),('academy','students'),('academy','training_enrollment_versions'),('academy','training_learning_events'),('people','staff_profiles'),('work_core','tasks'));
-- Global Storage file limit and billing/quota headroom must be checked in the
-- authorized project settings; bucket limits alone cannot raise a global limit.
