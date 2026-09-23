-- Connected academy delivery. Additive; the exact pilot remains disabled until release.
begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

create table academy.delivery_settings (
 tenant_id uuid primary key references core.tenants(id),
 enabled boolean not null default false,
 updated_by_subject_id uuid references access_control.subjects(id),
 updated_at timestamptz not null default now()
);
create index academy_delivery_settings_actor_idx on academy.delivery_settings(updated_by_subject_id);
alter table academy.delivery_settings enable row level security;
alter table academy.delivery_settings force row level security;
revoke all on academy.delivery_settings from public,anon,authenticated,service_role;

create function private_app.academy_delivery_enabled_v1(t uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select t='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid
 and exists(select 1 from core.tenants where id=t and slug='marktone' and status in ('active','trial'))
 and private_app.academy_platform_enabled_v1(t,'lms')
 and exists(select 1 from academy.delivery_settings where tenant_id=t and enabled)
$$;

create function private_app.academy_delivery_tenant_v1(p_slug text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 if private_app.academy_delivery_enabled_v1(t) is not true then raise exception 'academy_delivery_disabled' using errcode='42501';end if;
 return t;
end $$;

create table academy.course_media (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),course_id uuid not null,
 command_id uuid not null,request_hash text not null,
 object_path text not null unique,file_name text not null check(length(file_name) between 1 and 180),
 mime_type text not null check(mime_type in ('video/mp4','video/webm')),
 size_bytes bigint not null check(size_bytes between 1 and 524288000),
 state text not null default 'pending' check(state in ('pending','ready','cancelled')),
 allow_download boolean not null default false,policy_version integer not null default 1,
 created_by_subject_id uuid not null references access_control.subjects(id),
 created_at timestamptz not null default now(),upload_expires_at timestamptz not null default now()+interval '24 hours',ready_at timestamptz,
 unique(tenant_id,id),unique(tenant_id,command_id),
 foreign key(tenant_id,course_id) references academy.courses(tenant_id,id),
 check(object_path=tenant_id::text||'/'||course_id::text||'/'||id::text||case mime_type when 'video/mp4' then '.mp4' else '.webm' end),
 check((state='ready')=(ready_at is not null))
);
create index academy_course_media_course_idx on academy.course_media(tenant_id,course_id,created_at desc,id);
create index academy_course_media_actor_idx on academy.course_media(created_by_subject_id);
alter table academy.course_media enable row level security;
alter table academy.course_media force row level security;
revoke all on academy.course_media from public,anon,authenticated,service_role;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('academy-course-media','academy-course-media',false,524288000,array['video/mp4','video/webm']);

create function private_app.academy_media_allowed_v1(p_path text,p_write boolean default false) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare asset academy.course_media%rowtype;s uuid:=private_app.current_subject_id();
begin
 if auth.uid() is null or s is null or not exists(select 1 from access_control.subjects where id=s and status='active' and not must_change_password) then return false;end if;
 select * into asset from academy.course_media where object_path=p_path;
 if asset.id is null or private_app.academy_platform_enabled_v1(asset.tenant_id,'lms') is not true then return false;end if;
 if p_write then
  return asset.state='pending' and asset.created_by_subject_id=s and asset.upload_expires_at>now()
  and private_app.academy_delivery_enabled_v1(asset.tenant_id)
  and private_app.academy_has_permission_v1(asset.tenant_id,'manageCourses') and private_app.academy_has_permission_v1(asset.tenant_id,'manageLearning');
 end if;
 if asset.state<>'ready' then return false;end if;
 if private_app.academy_has_permission_v1(asset.tenant_id,'manageLearning') then return true;end if;
 if exists(select 1 from academy.training_run_instructors i join academy.course_runs r on r.tenant_id=i.tenant_id and r.id=i.run_id
  where i.tenant_id=asset.tenant_id and i.subject_id=s and i.active and r.course_id=asset.course_id and private_app.training_is_instructor_v1(i.tenant_id,i.run_id)) then return true;end if;
 return exists(select 1 from academy.training_learner_accounts a
  join academy.students st on st.tenant_id=a.tenant_id and st.id=a.student_id and st.status in ('active','graduated')
  join academy.enrollments e on e.tenant_id=a.tenant_id and e.student_id=a.student_id and e.course_id=asset.course_id and e.status in ('confirmed','active','completed')
  join academy.training_enrollment_versions ev on ev.tenant_id=e.tenant_id and ev.enrollment_id=e.id
  join academy.training_units u on u.tenant_id=ev.tenant_id and u.version_id=ev.version_id and u.kind='video'
  where a.tenant_id=asset.tenant_id and a.subject_id=s and a.status='active'
  and u.url='https://odeir.com/api/academy-media/'||asset.id::text||'?tenantSlug=marktone'
  and coalesce((private_app.training_journey_financial_access_v1(e.id)->>'trainingAllowed')::boolean,false));
end $$;
create policy academy_course_media_insert on storage.objects for insert to authenticated
with check(bucket_id='academy-course-media' and private_app.academy_media_allowed_v1(name,true));
create policy academy_course_media_read on storage.objects for select to authenticated
using(bucket_id='academy-course-media' and private_app.academy_media_allowed_v1(name,false));
-- Restrictive bucket guards also survive unrelated permissive policies added later.
create policy academy_media_read_guard on storage.objects as restrictive for select to anon,authenticated
using(bucket_id<>'academy-course-media' or private_app.academy_media_allowed_v1(name,false));
create policy academy_media_insert_guard on storage.objects as restrictive for insert to anon,authenticated
with check(bucket_id<>'academy-course-media' or private_app.academy_media_allowed_v1(name,true));
create policy academy_media_update_guard on storage.objects as restrictive for update to anon,authenticated
using(bucket_id<>'academy-course-media') with check(bucket_id<>'academy-course-media');
create policy academy_media_delete_guard on storage.objects as restrictive for delete to anon,authenticated
using(bucket_id<>'academy-course-media');
-- No UPDATE/DELETE policy: a signed upload cannot overwrite a published asset.

create function public.v1_academy_media_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid;actor uuid:=private_app.current_subject_id();asset academy.course_media%rowtype;cid uuid;aid uuid;mime text;bytes bigint;obj jsonb;hash text;cached academy.platform_commands%rowtype;result jsonb;
begin
 t:=private_app.academy_delivery_tenant_v1(p_slug);
 if private_app.academy_has_permission_v1(t,'manageCourses') is not true or private_app.academy_has_permission_v1(t,'manageLearning') is not true then raise exception 'forbidden' using errcode='42501';end if;
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>4096 then raise exception 'invalid_request';end if;
 if p_action='set_download' then
  perform pg_advisory_xact_lock(hashtextextended(t::text||':academy-media-policy:'||p_command_id::text,230926));
  select * into cached from academy.platform_commands where tenant_id=t and command_id=p_command_id;
  if cached.command_id is not null then
   if cached.actor_subject_id<>actor or cached.action<>'media.set_download' or cached.payload<>p_payload then raise exception 'academy_command_conflict';end if;
   return cached.response;
  end if;
 end if;
 if p_action='create_upload' then
  cid:=(p_payload->>'courseId')::uuid;
  perform 1 from academy.courses where tenant_id=t and id=cid and status in ('active','draft') for update;
  if not found then raise exception 'academy_authoring_course_not_found';end if;
  hash:=md5(p_payload::text);
  select * into asset from academy.course_media where tenant_id=t and command_id=p_command_id;
  if asset.id is not null then
   if asset.request_hash<>hash or asset.created_by_subject_id<>actor then raise exception 'academy_command_conflict';end if;
   if asset.state='cancelled' or (asset.state='pending' and asset.upload_expires_at<=now()) then raise exception 'academy_media_upload_expired';end if;
  else
   mime:=p_payload->>'mimeType';bytes:=(p_payload->>'sizeBytes')::bigint;aid:=gen_random_uuid();
   if mime is null or mime not in ('video/mp4','video/webm') or coalesce(length(p_payload->>'fileName'),0) not between 1 and 180
    or p_payload->>'fileName' ~ '[[:cntrl:]/\\]' or lower(p_payload->>'fileName') not like (case mime when 'video/mp4' then '%.mp4' else '%.webm' end)
    or bytes is null or bytes not between 1 and 524288000 then raise exception 'invalid_request';end if;
   if (select count(*) from academy.course_media where tenant_id=t and course_id=cid and state='pending' and upload_expires_at>now())>=5 then raise exception 'academy_media_upload_limit';end if;
   insert into academy.course_media(id,tenant_id,course_id,command_id,request_hash,object_path,file_name,mime_type,size_bytes,created_by_subject_id)
   values(aid,t,cid,p_command_id,hash,t::text||'/'||cid::text||'/'||aid::text||case mime when 'video/mp4' then '.mp4' else '.webm' end,p_payload->>'fileName',mime,bytes,actor) returning * into asset;
  end if;
 elsif p_action in ('complete_upload','set_download','cancel_upload') then
  select * into asset from academy.course_media where tenant_id=t and id=(p_payload->>'assetId')::uuid for update;
  if asset.id is null then raise exception 'academy_media_not_found';end if;
  if p_action='complete_upload' then
   if asset.state='cancelled' then raise exception 'academy_media_upload_expired';end if;
   if asset.state='pending' then
    if asset.upload_expires_at<=now() then raise exception 'academy_media_upload_expired';end if;
    select metadata into obj from storage.objects where bucket_id='academy-course-media' and name=asset.object_path;
    if obj is null or (obj->>'size')::bigint is distinct from asset.size_bytes or obj->>'mimetype' is distinct from asset.mime_type then raise exception 'academy_media_not_ready';end if;
    update academy.course_media set state='ready',ready_at=now() where id=asset.id returning * into asset;
    perform private_app.write_audit('academy.media.ready','academy_media',asset.id::text,t,jsonb_build_object('courseId',asset.course_id));
   end if;
  elsif p_action='set_download' then
   if asset.state<>'ready' or jsonb_typeof(p_payload->'allowDownload') is distinct from 'boolean' then raise exception 'invalid_request';end if;
   if (p_payload->>'expectedVersion')::integer is distinct from asset.policy_version then raise exception 'academy_media_policy_conflict';end if;
   if asset.allow_download is distinct from (p_payload->>'allowDownload')::boolean then
    update academy.course_media set allow_download=(p_payload->>'allowDownload')::boolean,policy_version=policy_version+1 where id=asset.id returning * into asset;
    perform private_app.write_audit('academy.media.download_policy','academy_media',asset.id::text,t,jsonb_build_object('allowDownload',asset.allow_download,'policyVersion',asset.policy_version));
   end if;
  else
   if asset.state='ready' then raise exception 'academy_media_not_editable';end if;
   update academy.course_media set state='cancelled' where id=asset.id returning * into asset;
  end if;
 else raise exception 'invalid_request';end if;
 result:=jsonb_build_object('assetId',asset.id,'state',asset.state,'bucket','academy-course-media','objectPath',asset.object_path,'fileName',asset.file_name,
  'allowDownload',asset.allow_download,'policyVersion',asset.policy_version,'expiresAt',asset.upload_expires_at,'playbackUrl','https://odeir.com/api/academy-media/'||asset.id::text||'?tenantSlug=marktone');
 if p_action='set_download' then
  insert into academy.platform_commands(tenant_id,command_id,actor_subject_id,action,payload,response) values(t,p_command_id,actor,'media.set_download',p_payload,result);
 end if;
 return result;
end $$;

create function public.v1_academy_media_access(p_slug text,p_asset_id uuid,p_download boolean default false) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;asset academy.course_media%rowtype;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);
 select * into asset from academy.course_media where tenant_id=t and id=p_asset_id;
 if asset.id is null or private_app.academy_media_allowed_v1(asset.object_path,false) is not true then raise exception 'academy_media_not_found' using errcode='42501';end if;
 if p_download and not asset.allow_download then raise exception 'academy_media_download_disabled' using errcode='42501';end if;
 return jsonb_build_object('bucket','academy-course-media','objectPath',asset.object_path,'fileName',asset.file_name,'allowDownload',asset.allow_download,'policyVersion',asset.policy_version,'expiresIn',300);
end $$;

revoke all on function private_app.academy_delivery_enabled_v1(uuid),private_app.academy_delivery_tenant_v1(text),private_app.academy_media_allowed_v1(text,boolean),public.v1_academy_media_action(text,text,uuid,jsonb),public.v1_academy_media_access(text,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function private_app.academy_media_allowed_v1(text,boolean),public.v1_academy_media_action(text,text,uuid,jsonb),public.v1_academy_media_access(text,uuid,boolean) to authenticated;
grant execute on function private_app.academy_media_allowed_v1(text,boolean) to anon;

create function private_app.academy_media_unit_guard_v1() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.url like 'https://odeir.com/api/academy-media/%' then
  if new.kind<>'video' or not exists(select 1 from academy.course_media asset join academy.training_course_versions v on v.tenant_id=asset.tenant_id and v.course_id=asset.course_id
   where asset.tenant_id=new.tenant_id and v.id=new.version_id and asset.state='ready'
   and new.url='https://odeir.com/api/academy-media/'||asset.id::text||'?tenantSlug=marktone') then raise exception 'academy_media_not_ready';end if;
 end if;
 return new;
end $$;
create trigger academy_media_unit_guard before insert on academy.training_units for each row execute function private_app.academy_media_unit_guard_v1();
revoke all on function private_app.academy_media_unit_guard_v1() from public,anon,authenticated,service_role;

-- A single capability flag accompanies the existing authoring snapshot.
do $authoring_capability$
declare definition text;needle text:='return jsonb_build_object(''available'',true,''tenant''';
begin
 definition:=pg_get_functiondef('public.v1_academy_authoring_snapshot(text,uuid,uuid,integer,text,integer)'::regprocedure);
 if (length(definition)-length(replace(definition,needle,'')))/length(needle)<>1 then raise exception 'academy_authoring_snapshot_baseline_changed';end if;
 execute replace(definition,needle,'return jsonb_build_object(''available'',true,''deliveryEnabled'',private_app.academy_delivery_enabled_v1(t),''tenant''');
end $authoring_capability$;
commit;
