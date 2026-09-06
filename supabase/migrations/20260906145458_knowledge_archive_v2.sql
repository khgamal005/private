begin;

alter table public.knowledge_posts add column if not exists is_archived boolean not null default false;
alter table public.knowledge_sources add column if not exists logo_url text;
alter table public.knowledge_sources add column if not exists sync_lease_token uuid;
alter table public.knowledge_sources add column if not exists sync_lease_until timestamptz;
alter table public.knowledge_sources add column if not exists backfill_cursor jsonb not null default '{}'::jsonb;
create index if not exists knowledge_posts_archive_page_idx on public.knowledge_posts
  (status, (coalesce(source_published_at,published_at,created_at)) desc, id desc);
create index if not exists knowledge_posts_canonical_lookup_idx on public.knowledge_posts(canonical_url);

create or replace function private_app.knowledge_preserve_history()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception 'knowledge_history_preserved_use_archive' using errcode='23514';
end;
$$;
drop trigger if exists knowledge_preserve_posts on public.knowledge_posts;
create trigger knowledge_preserve_posts before delete on public.knowledge_posts
for each row execute function private_app.knowledge_preserve_history();
drop trigger if exists knowledge_preserve_raw on public.knowledge_raw_items;
create trigger knowledge_preserve_raw before delete on public.knowledge_raw_items
for each row execute function private_app.knowledge_preserve_history();
revoke delete,truncate on public.knowledge_posts,public.knowledge_raw_items from anon,authenticated,service_role;

create or replace function private_app.knowledge_visible_in_tenant(p_post public.knowledge_posts,p_tenant uuid,p_slug text)
returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null
 and private_app.has_tenant_permission(p_tenant,'tenant.content.read')
 and p_post.status='published' and (p_post.published_at is null or p_post.published_at<=now())
 and (coalesce(cardinality(p_post.target_tenants),0)=0 or p_slug=any(p_post.target_tenants))
 and (coalesce(cardinality(p_post.target_roles),0)=0
   or exists(select 1 from access_control.subjects s
     join access_control.memberships m on m.subject_id=s.id and m.scope='tenant' and m.status='active' and m.tenant_id=p_tenant
     join access_control.membership_roles mr on mr.membership_id=m.id
     join access_control.roles r on r.id=mr.role_id and r.scope='tenant'
     where s.auth_user_id=auth.uid() and s.status='active' and not s.must_change_password
       and r.role_key=any(p_post.target_roles)));
$$;
revoke all on function private_app.knowledge_visible_in_tenant(public.knowledge_posts,uuid,text) from public,anon,authenticated;

-- Public website reads retain their current publication/expiry semantics. Audience-targeted
-- material is accessible only through the tenant RPC, or to a platform content admin.
drop policy if exists "public read published posts" on public.knowledge_posts;
drop policy if exists "public reads published knowledge posts" on public.knowledge_posts;
drop policy if exists "anonymous reads published knowledge posts" on public.knowledge_posts;
create policy "anonymous reads published knowledge posts" on public.knowledge_posts for select to anon using (
 status='published' and not is_archived and (published_at is null or published_at<=now())
 and (expires_at is null or expires_at>now())
 and coalesce(cardinality(target_tenants),0)=0 and coalesce(cardinality(target_roles),0)=0);
drop policy if exists "authenticated reads visible knowledge posts" on public.knowledge_posts;
create policy "authenticated reads visible knowledge posts" on public.knowledge_posts for select to authenticated using (
 platform.is_platform_content_admin() or (
 status='published' and not is_archived and (published_at is null or published_at<=now())
 and (expires_at is null or expires_at>now())
 and coalesce(cardinality(target_tenants),0)=0 and coalesce(cardinality(target_roles),0)=0));

create or replace function private_app.knowledge_lifecycle(p public.knowledge_posts)
returns text language sql stable set search_path='' as $$
 select case
 when p.content_type='tender' and (p.tender_status in ('expired','closed','awarded','cancelled')
   or p.tender_deadline<=now() or p.expires_at<=now()) then 'expired'
 when p.is_archived or p.expires_at<=now() or (p.content_type='event' and p.event_ends_at<=now()) then 'archived'
 when p.content_type='tender' and (p.tender_deadline is null or coalesce(p.tender_status,'') in ('unknown','new')) then 'unverified'
 else 'active' end;
$$;
revoke all on function private_app.knowledge_lifecycle(public.knowledge_posts) from public,anon,authenticated;

create or replace function public.v3_tenant_knowledge_snapshot(
 p_slug text,p_search text default null,p_category uuid default null,p_content_type text default null,
 p_view text default 'all',p_source uuid default null,p_from date default null,p_to date default null,
 p_sort text default 'latest',p_limit integer default 24,p_offset integer default 0,p_as_of timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 v_tenant uuid; v_result jsonb; v_limit integer:=greatest(1,least(coalesce(p_limit,24),60));
 v_offset integer:=greatest(0,coalesce(p_offset,0)); v_as_of timestamptz:=least(coalesce(p_as_of,now()),now());
begin
 select id into v_tenant from core.tenants where slug=p_slug and status in ('active','trial');
 if auth.uid() is null or v_tenant is null or not private_app.has_tenant_permission(v_tenant,'tenant.content.read') then
   raise exception 'forbidden' using errcode='42501';
 end if;
 if p_view not in ('all','active','expired','archive','important','saved') or p_sort not in ('latest','oldest','relevance') then
   raise exception 'knowledge_invalid_filter' using errcode='22023';
 end if;
 with visible as materialized (
  select p.*,private_app.knowledge_lifecycle(p) as lifecycle,
    coalesce(p.source_published_at,p.published_at,p.created_at) as article_time,
    exists(select 1 from public.knowledge_bookmarks b where b.tenant_id=v_tenant and b.auth_user_id=auth.uid() and b.post_id=p.id) as is_saved
  from public.knowledge_posts p where p.created_at<=v_as_of and private_app.knowledge_visible_in_tenant(p,v_tenant,p_slug)
 ), filtered as materialized (
  select * from visible p where (p_category is null or p.category_id=p_category)
   and (nullif(p_content_type,'') is null or p.content_type=p_content_type)
   and (p_source is null or p.source_id=p_source)
   and (p_from is null or p.article_time >= (p_from::timestamp at time zone 'Asia/Riyadh'))
   and (p_to is null or p.article_time < ((p_to+1)::timestamp at time zone 'Asia/Riyadh'))
   and (nullif(trim(p_search),'') is null or concat_ws(' ',p.title,p.excerpt,p.smart_summary,p.source_name,array_to_string(p.tags,' ')) ilike '%'||left(trim(p_search),200)||'%')
   and (p_view='all' or (p_view='active' and p.lifecycle='active') or (p_view='expired' and p.lifecycle='expired')
     or (p_view='archive' and p.lifecycle in ('expired','archived')) or (p_view='saved' and p.is_saved)
     or (p_view='important' and (p.is_breaking or p.importance_level in ('high','urgent') or p.relevance_score>=80)))
 ), page as (
  select p.*,row_number() over(order by
   case when p_sort='relevance' then p.relevance_score end desc nulls last,
   case when p_sort='oldest' then p.article_time end asc nulls last,
   case when p_sort<>'oldest' then p.article_time end desc nulls last,p.id desc) as ordinal
  from filtered p order by ordinal limit v_limit offset v_offset
 )
 select jsonb_build_object(
  'posts',coalesce((select jsonb_agg(
   (to_jsonb(p)-array['content','review_notes','target_roles','target_tenants','extracted_entities','created_by','reviewed_by','approved_by','source_fingerprint','ordinal'])
   ||jsonb_build_object('source_logo_url',s.logo_url,'source_base_url',s.base_url,'knowledge_categories',
     case when c.id is null then null else jsonb_build_object('id',c.id,'name',c.name,'slug',c.slug) end)
   order by p.ordinal) from page p left join public.knowledge_sources s on s.id=p.source_id left join public.knowledge_categories c on c.id=p.category_id),'[]'::jsonb),
  'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name) from public.knowledge_categories c where c.is_active),'[]'::jsonb),
  'sources',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'logo_url',s.logo_url) order by s.name) from public.knowledge_sources s where exists(select 1 from visible v where v.source_id=s.id)),'[]'::jsonb),
  'pagination',jsonb_build_object('total',(select count(*) from filtered),'limit',v_limit,'offset',v_offset,'hasMore',v_offset+v_limit<(select count(*) from filtered),'asOf',v_as_of),
  'stats',(select jsonb_build_object('total',count(*),'activeTenders',count(*) filter(where content_type='tender' and lifecycle='active'),
   'expiredTenders',count(*) filter(where lifecycle='expired'),'archived',count(*) filter(where lifecycle in ('expired','archived')),
   'closingSoon',count(*) filter(where content_type='tender' and lifecycle='active' and tender_deadline<=now()+interval '7 days'),
   'important',count(*) filter(where is_breaking or importance_level in ('high','urgent') or relevance_score>=80),
   'saved',count(*) filter(where is_saved),'lastUpdatedAt',max(updated_at)) from visible),
  'generatedAt',now()) into v_result;
 return v_result;
end;
$$;
revoke all on function public.v3_tenant_knowledge_snapshot(text,text,uuid,text,text,uuid,date,date,text,integer,integer,timestamptz) from public,anon;
grant execute on function public.v3_tenant_knowledge_snapshot(text,text,uuid,text,text,uuid,date,date,text,integer,integer,timestamptz) to authenticated;

create or replace function public.v3_tenant_knowledge_post(p_slug text,p_post_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_tenant uuid; p public.knowledge_posts; v_logo text;
begin
 select id into v_tenant from core.tenants where slug=p_slug and status in ('active','trial');
 select * into p from public.knowledge_posts where id=p_post_id;
 if v_tenant is null or p.id is null or not private_app.knowledge_visible_in_tenant(p,v_tenant,p_slug) then
   raise exception 'forbidden' using errcode='42501';
 end if;
 select logo_url into v_logo from public.knowledge_sources where id=p.source_id;
 return (to_jsonb(p)-array['review_notes','target_roles','target_tenants','extracted_entities','created_by','reviewed_by','approved_by','source_fingerprint'])
  ||jsonb_build_object('lifecycle',private_app.knowledge_lifecycle(p),'source_logo_url',v_logo,
   'is_saved',exists(select 1 from public.knowledge_bookmarks b where b.tenant_id=v_tenant and b.auth_user_id=auth.uid() and b.post_id=p.id));
end;
$$;
revoke all on function public.v3_tenant_knowledge_post(text,uuid) from public,anon;
grant execute on function public.v3_tenant_knowledge_post(text,uuid) to authenticated;

create or replace function public.v2_tenant_knowledge_action(p_slug text,p_action text,p_post_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_tenant uuid; p public.knowledge_posts;
begin
 select id into v_tenant from core.tenants where slug=p_slug and status in ('active','trial');
 select * into p from public.knowledge_posts where id=p_post_id;
 if v_tenant is null or p.id is null or not private_app.knowledge_visible_in_tenant(p,v_tenant,p_slug) then
  raise exception 'forbidden' using errcode='42501';
 end if;
 case p_action
 when 'save' then insert into public.knowledge_bookmarks(tenant_id,auth_user_id,post_id) values(v_tenant,auth.uid(),p_post_id) on conflict(tenant_id,auth_user_id,post_id) do nothing;
 when 'unsave' then delete from public.knowledge_bookmarks where tenant_id=v_tenant and auth_user_id=auth.uid() and post_id=p_post_id;
 when 'read' then insert into public.knowledge_read_events(tenant_id,auth_user_id,post_id) values(v_tenant,auth.uid(),p_post_id);
 else raise exception 'knowledge_action_not_supported';
 end case;
 return jsonb_build_object('ok',true,'saved',exists(select 1 from public.knowledge_bookmarks where tenant_id=v_tenant and auth_user_id=auth.uid() and post_id=p_post_id));
end;
$$;
revoke all on function public.v2_tenant_knowledge_action(text,text,uuid) from public,anon;
grant execute on function public.v2_tenant_knowledge_action(text,text,uuid) to authenticated;

-- Atomic short lease: concurrent manual and scheduled invocations cannot own one source.
create or replace function public.knowledge_claim_source(p_source_id uuid,p_trigger text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.knowledge_sources; v_token uuid:=gen_random_uuid(); v_run uuid;
begin
 select * into s from public.knowledge_sources where id=p_source_id for update skip locked;
 if not found or not s.is_active or s.source_type='manual' or s.sync_lease_until>now()
  or (p_trigger='scheduled' and (s.sync_frequency='manual' or s.next_sync_at>now())) then return null; end if;
 update public.knowledge_ingestion_runs set status='failed',finished_at=now(),error_detail='interrupted_run_recovered',error_count=greatest(error_count,1)
  where source_id=s.id and status='running';
 insert into public.knowledge_ingestion_runs(source_id,trigger_type,status) values(s.id,p_trigger,'running') returning id into v_run;
 update public.knowledge_sources set sync_lease_token=v_token,sync_lease_until=now()+interval '10 minutes',last_status='running' where id=s.id;
 return jsonb_build_object('token',v_token,'runId',v_run,'source',to_jsonb(s));
end;
$$;
revoke all on function public.knowledge_claim_source(uuid,text) from public,anon,authenticated;
grant execute on function public.knowledge_claim_source(uuid,text) to service_role;

-- Persist one item and its provenance in one transaction. Advisory lock serializes
-- identical canonical URLs without holding a lock during any network request.
create or replace function public.knowledge_store_item(p_source_id uuid,p_lease uuid,p_run_id uuid,p_raw jsonb,p_post jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_post uuid; v_raw uuid; v_canonical text:=p_post->>'canonical_url'; v_existing public.knowledge_posts;
begin
 if not exists(select 1 from public.knowledge_sources where id=p_source_id and sync_lease_token=p_lease and sync_lease_until>now())
  or not exists(select 1 from public.knowledge_ingestion_runs where id=p_run_id and source_id=p_source_id and status='running') then raise exception 'knowledge_lease_lost'; end if;
 if coalesce(v_canonical,'')='' or coalesce(p_post->>'title','')='' then raise exception 'knowledge_item_invalid'; end if;
 perform pg_advisory_xact_lock(hashtextextended(v_canonical,17));
 select * into v_existing from public.knowledge_posts where canonical_url=v_canonical order by created_at,id limit 1;
 if v_existing.id is not null then
  -- Fill only missing image metadata; never overwrite editorial content or status.
  update public.knowledge_posts set cover_image_url=p_post->>'cover_image_url'
   where id=v_existing.id and nullif(cover_image_url,'') is null and nullif(p_post->>'cover_image_url','') is not null;
  return jsonb_build_object('duplicate',true,'id',v_existing.id);
 end if;
 select id,post_id into v_raw,v_post from public.knowledge_raw_items where source_id=p_source_id and fingerprint=p_raw->>'fingerprint';
 if v_post is not null then return jsonb_build_object('duplicate',true,'id',v_post); end if;
 if v_raw is null then
  insert into public.knowledge_raw_items(source_id,run_id,external_id,canonical_url,title,excerpt,content,cover_image_url,source_published_at,raw_payload,fingerprint,detected_type,detected_category_id,trust_score,relevance_score,why_it_matters,recommended_action,status,error_detail)
  select p_source_id,p_run_id,x.external_id,x.canonical_url,x.title,x.excerpt,x.content,x.cover_image_url,x.source_published_at,x.raw_payload,x.fingerprint,x.detected_type,x.detected_category_id,x.trust_score,x.relevance_score,x.why_it_matters,x.recommended_action,x.status,x.error_detail
  from jsonb_populate_record(null::public.knowledge_raw_items,p_raw) x returning id into v_raw;
 end if;
 insert into public.knowledge_posts(title,slug,excerpt,content,cover_image_url,category_id,content_type,status,source_id,source_name,source_url,canonical_url,external_id,source_fingerprint,trust_score,relevance_score,importance_level,why_it_matters,recommended_action,smart_summary,source_published_at,last_verified_at,is_automated,tags,published_at,review_notes,tender_authority,tender_number,tender_deadline,tender_status,expires_at,application_url,is_archived)
 select x.title,x.slug,x.excerpt,x.content,x.cover_image_url,x.category_id,x.content_type,x.status,p_source_id,x.source_name,x.source_url,x.canonical_url,x.external_id,x.source_fingerprint,x.trust_score,x.relevance_score,x.importance_level,x.why_it_matters,x.recommended_action,x.smart_summary,x.source_published_at,x.last_verified_at,true,coalesce(x.tags,'{}'),x.published_at,x.review_notes,x.tender_authority,x.tender_number,x.tender_deadline,x.tender_status,x.expires_at,x.application_url,coalesce(x.is_archived,false)
 from jsonb_populate_record(null::public.knowledge_posts,p_post) x returning id into v_post;
 update public.knowledge_raw_items set post_id=v_post,status=p_raw->>'status',error_detail=p_raw->>'error_detail' where id=v_raw;
 return jsonb_build_object('duplicate',false,'id',v_post);
end;
$$;
revoke all on function public.knowledge_store_item(uuid,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.knowledge_store_item(uuid,uuid,uuid,jsonb,jsonb) to service_role;

create or replace function public.v3_knowledge_admin_snapshot(p_filter text default 'all',p_search text default '',p_offset integer default 0,p_review_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not platform.is_platform_content_admin() then raise exception 'forbidden' using errcode='42501';end if;
 return jsonb_build_object(
 'posts',coalesce((select jsonb_agg(to_jsonb(p) order by p.created_at desc,p.id desc) from (
   select * from public.knowledge_posts where (p_filter='all' or (p_filter='archive' and (is_archived or status='archived')) or status=p_filter)
   and (nullif(trim(p_search),'') is null or concat_ws(' ',title,source_name) ilike '%'||left(trim(p_search),200)||'%')
   order by created_at desc,id desc limit 36 offset greatest(0,p_offset))p),'[]'::jsonb),
 'postTotal',(select count(*) from public.knowledge_posts where (p_filter='all' or (p_filter='archive' and (is_archived or status='archived')) or status=p_filter)
   and (nullif(trim(p_search),'') is null or concat_ws(' ',title,source_name) ilike '%'||left(trim(p_search),200)||'%')),
 'categories',coalesce((select jsonb_agg(to_jsonb(c) order by c.sort_order,c.name) from public.knowledge_categories c),'[]'::jsonb),
 'sources',coalesce((select jsonb_agg(to_jsonb(s)-array['sync_lease_token'] order by s.is_active desc,s.name) from public.knowledge_sources s),'[]'::jsonb),
 'runs',coalesce((select jsonb_agg(to_jsonb(r) order by r.created_at desc) from(select r.*,jsonb_build_object('name',s.name) as knowledge_sources from public.knowledge_ingestion_runs r left join public.knowledge_sources s on s.id=r.source_id order by r.created_at desc limit 24)r),'[]'::jsonb),
 'rawItems',coalesce((select jsonb_agg(to_jsonb(r)-'raw_payload' order by r.created_at desc,r.id desc) from(select r.*,jsonb_build_object('name',s.name) as knowledge_sources from public.knowledge_raw_items r left join public.knowledge_sources s on s.id=r.source_id where r.status in ('new','review','error') order by r.created_at desc,r.id desc limit 24 offset greatest(0,p_review_offset))r),'[]'::jsonb),
 'reviewTotal',(select count(*) from public.knowledge_raw_items where status in ('new','review','error')),
 'stats',jsonb_build_object('total',(select count(*) from public.knowledge_posts),'published',(select count(*) from public.knowledge_posts where status='published'),
  'review',(select count(*) from public.knowledge_posts where status in ('review','imported')),
  'automated',(select count(*) from public.knowledge_posts where is_automated),
  'activeSources',(select count(*) from public.knowledge_sources where is_active and source_type<>'manual'),
  'sourceErrors',(select count(*) from public.knowledge_sources where is_active and last_status in ('error','partial'))));
end;
$$;
revoke all on function public.v3_knowledge_admin_snapshot(text,text,integer,integer) from public,anon;
grant execute on function public.v3_knowledge_admin_snapshot(text,text,integer,integer) to authenticated;

-- Keep older clients on the same audience checks and counts.
create or replace function public.v2_tenant_knowledge_snapshot(p_slug text,p_search text default null,p_category uuid default null,p_content_type text default null,p_only_saved boolean default false,p_limit integer default 60,p_offset integer default 0)
returns jsonb language sql stable security definer set search_path='' as $$
 select public.v3_tenant_knowledge_snapshot(p_slug,p_search,p_category,p_content_type,
   case when p_only_saved then 'saved' else 'all' end,null,null,null,'relevance',least(coalesce(p_limit,60),60),p_offset,null);
$$;
revoke all on function public.v2_tenant_knowledge_snapshot(text,text,uuid,text,boolean,integer,integer) from public,anon;
grant execute on function public.v2_tenant_knowledge_snapshot(text,text,uuid,text,boolean,integer,integer) to authenticated;
commit;
