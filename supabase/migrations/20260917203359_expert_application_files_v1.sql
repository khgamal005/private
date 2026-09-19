-- Optional private application files. No customer backfill; uploads start disabled.
alter table marketplace.service_hub_settings add column expert_uploads_enabled boolean not null default false;
create table marketplace.expert_application_uploads (
 id uuid primary key,
 payload jsonb not null check(jsonb_typeof(payload)='object' and octet_length(payload::text)<=18000),
 manifest jsonb not null check(jsonb_typeof(manifest)='array' and jsonb_array_length(manifest) between 1 and 2 and octet_length(manifest::text)<=3000),
 status text not null default 'reserved' check(status in ('reserved','completed','duplicate','expired','cleaned')),
 application_id uuid references marketplace.expert_applications(id) on delete restrict,
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '24 hours'
);
create index expert_uploads_application_idx on marketplace.expert_application_uploads(application_id);
create index expert_uploads_created_idx on marketplace.expert_application_uploads(created_at);
create index expert_uploads_cleanup_idx on marketplace.expert_application_uploads(expires_at) where status in ('reserved','duplicate','expired');
create table marketplace.expert_application_files (
 application_id uuid not null references marketplace.expert_applications(id) on delete restrict,
 kind text not null check(kind in ('cv','photo')),
 upload_id uuid not null references marketplace.expert_application_uploads(id) on delete restrict,
 object_path text not null unique,
 mime_type text not null,
 size_bytes integer not null check(size_bytes between 1 and 5242880),
 original_name text not null check(length(original_name) between 1 and 160),
 primary key(application_id,kind),
 check((kind='cv' and mime_type='application/pdf') or (kind='photo' and mime_type in ('image/jpeg','image/png','image/webp') and size_bytes<=2097152))
);
create index expert_files_upload_idx on marketplace.expert_application_files(upload_id);
alter table marketplace.expert_application_uploads enable row level security;
alter table marketplace.expert_application_files enable row level security;
revoke all on marketplace.expert_application_uploads,marketplace.expert_application_files from public,anon,authenticated,service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('expert-application-files','expert-application-files',false,5242880,array['application/pdf','image/jpeg','image/png','image/webp']);

create function private_app.create_expert_application_v2(p_payload jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_email text; v_limit marketplace.expert_application_limits%rowtype;
begin
  perform private_app.require_service_hub_v1();
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>18000
    or coalesce(p_payload->>'consent','')<>'true'
    or coalesce(p_payload->>'type','') not in ('lecturer','trainer','consultant')
    or coalesce(length(btrim(p_payload->>'name')),0) not between 2 and 150
    or coalesce(length(btrim(p_payload->>'title')),0) not between 2 and 180
    or coalesce(length(btrim(p_payload->>'bio')),0) not between 30 and 4000
    or coalesce(length(btrim(p_payload->>'expertise')),0) not between 2 and 1000
    or coalesce(length(btrim(p_payload->>'languages')),0) not between 2 and 300
    or cardinality(regexp_split_to_array(p_payload->>'languages','[,،\n]+'))>20
    or cardinality(regexp_split_to_array(p_payload->>'expertise','[,،\n]+'))>30
    or coalesce(length(btrim(p_payload->>'city')),0) not between 2 and 100
    or coalesce(p_payload->>'phone','') !~ '^\+?[0-9 ()-]{7,40}$'
    or coalesce(p_payload->>'yearsExperience','') !~ '^[0-9]{1,2}$'
  then raise exception 'service_application_invalid'; end if;
  if (p_payload->>'yearsExperience')::integer>80 then raise exception 'service_application_invalid'; end if;
  v_email:=lower(btrim(p_payload->>'email'));
  if coalesce(v_email,'') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(v_email)>254
    or (coalesce(p_payload->>'portfolioUrl','')<>'' and (length(p_payload->>'portfolioUrl')>2000 or p_payload->>'portfolioUrl' !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'))
  then raise exception 'service_application_invalid'; end if;
  -- The singleton bounds anonymous writes and storage without trusting forwarded IPs.
  select * into v_limit from marketplace.expert_application_limits where singleton for update;
  if v_limit.window_start < now()-interval '1 hour' then
    update marketplace.expert_application_limits set window_start=now(),submissions=0 where singleton;
  elsif v_limit.submissions>=100 then raise exception 'service_application_rate_limited'; end if;
  update marketplace.expert_application_limits set submissions=submissions+1 where singleton;
  -- Same response for new and existing emails; never overwrite an earlier submission.
  insert into marketplace.expert_applications(email,payload)
  values(v_email,jsonb_build_object('name',btrim(p_payload->>'name'),'title',btrim(p_payload->>'title'),
    'email',v_email,'phone',btrim(p_payload->>'phone'),'bio',btrim(p_payload->>'bio'),
    'expertise',p_payload->>'expertise','languages',p_payload->>'languages','city',p_payload->>'city',
    'yearsExperience',(p_payload->>'yearsExperience')::integer,'type',p_payload->>'type',
    'portfolioUrl',nullif(p_payload->>'portfolioUrl',''),'consent',true,'consentVersion','expert-application-v1'))
  on conflict(email) do nothing returning id into v_id;
  return v_id;
end $$;


-- Preserve the old JSON API and its generic duplicate receipt. The private helper returns
-- an ID only for a newly inserted row, preventing attachments from claiming an existing email.
create or replace function public.v1_public_expert_application(p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$ begin
 perform private_app.create_expert_application_v2(p_payload);
 return jsonb_build_object('received',true);
end $$;

create or replace function public.v1_public_expert_registration_status() returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('enabled',coalesce(enabled,false),'uploadsEnabled',coalesce(enabled and expert_uploads_enabled,false))
 from marketplace.service_hub_settings where singleton;
$$;

create function public.v1_expert_upload_reserve(p_id uuid,p_payload jsonb,p_manifest jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u marketplace.expert_application_uploads%rowtype; f jsonb; kinds text[]:=array[]::text[];
begin
 if not exists(select 1 from marketplace.service_hub_settings where enabled and expert_uploads_enabled) then raise exception 'service_hub_not_enabled'; end if;
 if p_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>18000
   or jsonb_typeof(p_manifest) is distinct from 'array' or jsonb_array_length(p_manifest) not between 1 and 2 then raise exception 'service_application_invalid'; end if;
 for f in select value from jsonb_array_elements(p_manifest) loop
  if coalesce(f->>'kind','') not in ('cv','photo') or (f->>'kind')=any(kinds)
    or coalesce(f->>'sha256','') !~ '^[0-9a-f]{64}$'
    or coalesce(length(f->>'name'),0) not between 1 and 160
    or coalesce(f->>'size','') !~ '^[0-9]{1,7}$' then raise exception 'service_application_invalid'; end if;
  if (f->>'size')::integer<1 or (f->>'size')::integer>(case when f->>'kind'='cv' then 5242880 else 2097152 end)
    or (f->>'kind'='cv' and (f->>'mimeType') is distinct from 'application/pdf')
    or (f->>'kind'='photo' and coalesce(f->>'mimeType','') not in ('image/jpeg','image/png','image/webp')) then raise exception 'service_application_invalid'; end if;
  kinds:=array_append(kinds,f->>'kind');
 end loop;
 -- Serialize quota and reservation checks in a short transaction, never across storage calls.
 perform pg_advisory_xact_lock(76239143);
 select * into u from marketplace.expert_application_uploads where id=p_id for update;
 if found then
  if u.payload<>p_payload or u.manifest<>p_manifest then raise exception 'service_upload_conflict'; end if;
  if u.status not in ('reserved','completed','duplicate') or (u.status='reserved' and u.expires_at<=now()) then raise exception 'service_upload_expired'; end if;
  return jsonb_build_object('complete',u.status in ('completed','duplicate'));
 end if;
 if (select count(*) from marketplace.expert_application_uploads where created_at>now()-interval '1 hour')>=20
   or (select count(*) from marketplace.expert_application_uploads where created_at>now()-interval '1 day')>=200 then raise exception 'service_application_rate_limited'; end if;
 insert into marketplace.expert_application_uploads(id,payload,manifest) values(p_id,p_payload,p_manifest);
 return jsonb_build_object('complete',false);
end $$;

create function public.v1_expert_upload_finalize(p_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u marketplace.expert_application_uploads%rowtype; aid uuid; f jsonb; path text; descriptors jsonb:='[]';
begin
 if not exists(select 1 from marketplace.service_hub_settings where enabled and expert_uploads_enabled) then raise exception 'service_hub_not_enabled'; end if;
 select * into u from marketplace.expert_application_uploads where id=p_id for update;
 if not found then raise exception 'service_upload_expired'; end if;
 if u.status in ('completed','duplicate') then return jsonb_build_object('received',true); end if;
 if u.status<>'reserved' or u.expires_at<=now() then raise exception 'service_upload_expired'; end if;
 for f in select value from jsonb_array_elements(u.manifest) loop
  path:=u.id::text||'/'||(f->>'kind');
  if not exists(select 1 from storage.objects where bucket_id='expert-application-files' and name=path
    and (metadata->>'size')::bigint=(f->>'size')::bigint and metadata->>'mimetype'=f->>'mimeType') then raise exception 'service_upload_incomplete'; end if;
 end loop;
 aid:=private_app.create_expert_application_v2(u.payload);
 if aid is not null then
  for f in select value from jsonb_array_elements(u.manifest) loop
   insert into marketplace.expert_application_files(application_id,kind,upload_id,object_path,mime_type,size_bytes,original_name)
    values(aid,f->>'kind',u.id,u.id::text||'/'||(f->>'kind'),f->>'mimeType',(f->>'size')::integer,f->>'name');
   descriptors:=descriptors||jsonb_build_array(jsonb_build_object('kind',f->>'kind','name',f->>'name','size',(f->>'size')::integer,'mimeType',f->>'mimeType'));
  end loop;
  update marketplace.expert_applications set payload=payload||jsonb_build_object('attachments',descriptors,'consentVersion','expert-application-files-v1') where id=aid;
 end if;
 update marketplace.expert_application_uploads set status=case when aid is null then 'duplicate' else 'completed' end,application_id=aid where id=p_id;
 return jsonb_build_object('received',true);
end $$;

-- Cleanup returns storage paths to the Edge function; delete bytes through Storage API only.
create function public.v1_expert_upload_cleanup() returns jsonb
language plpgsql security definer set search_path='' as $$
declare u marketplace.expert_application_uploads%rowtype; result jsonb:='[]';
begin
 for u in select * from marketplace.expert_application_uploads where status in ('reserved','duplicate','expired') and expires_at<now()
   order by expires_at,id limit 10 for update skip locked loop
  update marketplace.expert_application_uploads set status='expired' where id=u.id;
  result:=result||jsonb_build_array(jsonb_build_object('id',u.id,'paths',(select jsonb_agg(u.id::text||'/'||(value->>'kind')) from jsonb_array_elements(u.manifest))));
 end loop;
 return result;
end $$;
create function public.v1_expert_upload_cleaned(p_id uuid) returns void
language sql security definer set search_path='' as $$
 -- Keep a small quota tombstone; never scrub a successful application's attachments.
 update marketplace.expert_application_uploads set status='cleaned',payload='{}',manifest='[{"kind":"removed"}]'
 where id=p_id and status='expired';
$$;

create function private_app.expert_file_readable(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from marketplace.expert_application_files f join marketplace.expert_applications a on a.id=f.application_id
 where f.object_path=p_path and (private_app.has_platform_permission('platform.billing.manage') or
 (f.kind='photo' and a.status='approved' and private_app.service_provider_visible_v1(a.provider_id))));
$$;
create policy expert_files_read on storage.objects for select to anon,authenticated
 using(bucket_id='expert-application-files' and private_app.expert_file_readable(name));
-- Restrictive defense prevents broader future bucket policies exposing CVs or permitting client writes.
create policy expert_files_read_guard on storage.objects as restrictive for select to anon,authenticated
 using(bucket_id<>'expert-application-files' or private_app.expert_file_readable(name));
create policy expert_files_insert_guard on storage.objects as restrictive for insert to anon,authenticated with check(bucket_id<>'expert-application-files');
create policy expert_files_update_guard on storage.objects as restrictive for update to anon,authenticated using(bucket_id<>'expert-application-files') with check(bucket_id<>'expert-application-files');
create policy expert_files_delete_guard on storage.objects as restrictive for delete to anon,authenticated using(bucket_id<>'expert-application-files');

create function public.v1_platform_expert_file(p_application_id uuid,p_kind text) returns jsonb
language plpgsql stable security definer set search_path='' as $$ begin
 if not private_app.has_platform_permission('platform.billing.manage') then raise exception 'forbidden'; end if;
 return (select jsonb_build_object('path',object_path,'mimeType',mime_type,'size',size_bytes,'name',original_name)
  from marketplace.expert_application_files where application_id=p_application_id and kind=p_kind);
end $$;
create function public.v1_public_expert_photo(p_provider_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('path',f.object_path,'mimeType',f.mime_type,'size',f.size_bytes,'name',f.original_name)
 from marketplace.expert_application_files f join marketplace.expert_applications a on a.id=f.application_id
 where f.kind='photo' and a.status='approved' and a.provider_id=p_provider_id and private_app.service_provider_visible_v1(p_provider_id)
 order by a.reviewed_at desc,a.id limit 1;
$$;

do $$ declare definition text; begin
 definition:=pg_get_functiondef('private_app.service_provider_public_payload(uuid)'::regprocedure);
 if position($needle$'avatarUrl', provider.avatar_url$needle$ in definition)=0 then raise exception 'expert_avatar_contract_changed'; end if;
 execute replace(definition,$needle$'avatarUrl', provider.avatar_url$needle$,$replacement$'avatarUrl', coalesce(nullif(provider.avatar_url, ''), case when public.v1_public_expert_photo(provider.id) is not null then '/api/experts/photos/'||provider.id::text end)$replacement$);
end $$;

revoke all on function private_app.create_expert_application_v2(jsonb),private_app.expert_file_readable(text),
 public.v1_expert_upload_reserve(uuid,jsonb,jsonb),public.v1_expert_upload_finalize(uuid),public.v1_expert_upload_cleanup(),public.v1_expert_upload_cleaned(uuid),
 public.v1_platform_expert_file(uuid,text),public.v1_public_expert_photo(uuid) from public,anon,authenticated,service_role;
grant execute on function public.v1_expert_upload_reserve(uuid,jsonb,jsonb),public.v1_expert_upload_finalize(uuid),public.v1_expert_upload_cleanup(),public.v1_expert_upload_cleaned(uuid) to service_role;
grant execute on function private_app.expert_file_readable(text),public.v1_public_expert_photo(uuid) to anon,authenticated;
grant execute on function public.v1_platform_expert_file(uuid,text) to authenticated;
