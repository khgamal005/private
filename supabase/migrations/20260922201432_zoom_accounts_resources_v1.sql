begin;
-- Additive, opt-in provider resources. No tenant activation or historical backfill.
create schema zoom_core;
revoke all on schema zoom_core from public,anon,authenticated,service_role;

create table zoom_core.settings (
 tenant_id uuid primary key references core.tenants(id), enabled boolean not null default false,
 environment text not null default 'production' check(environment in ('test','production')),
 revision integer not null default 1, join_before_minutes integer not null default 15 check(join_before_minutes between 0 and 60),
 before_minutes integer not null default 10 check(before_minutes between 0 and 120),
 after_minutes integer not null default 10 check(after_minutes between 0 and 120),
 recording_policy text not null default 'off' check(recording_policy in ('off','manual','cloud')),
 retention_policy jsonb not null default '{}', ai_policy jsonb not null default '{}',
 owner_staff_id uuid references people.staff_profiles(id), updated_at timestamptz not null default now()
);
create table zoom_core.connections (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 environment text not null check(environment in ('test','production')), account_id text not null,
 grant_user_id text not null,label text not null,status text not null default 'connected'
 check(status in ('connected','missing_scope','reauth_required','paused','disconnected','deauthorized')),
 scopes jsonb not null default '[]', vault_secret_id uuid, expires_at timestamptz,
 generation integer not null default 1, refresh_lease uuid, refresh_until timestamptz,
 last_synced_at timestamptz, sync_coverage text not null default 'unknown', last_error text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(tenant_id,id),unique(environment,account_id)
);
create index zoom_connections_tenant on zoom_core.connections(tenant_id,status,id);
create table zoom_core.oauth_attempts (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 auth_user_id uuid not null references auth.users(id),subject_id uuid not null references access_control.subjects(id),
 state_hash text not null unique check(state_hash ~ '^[a-f0-9]{64}$'),
 mode text not null check(mode in ('add','reconnect')),connection_id uuid,
 environment text not null,return_path text not null,expires_at timestamptz not null default now()+interval '10 minutes',
 claimed_at timestamptz,finished_at timestamptz,
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),
 check((mode='add' and connection_id is null) or(mode='reconnect' and connection_id is not null))
);
create index zoom_oauth_expiry on zoom_core.oauth_attempts(expires_at);
create table zoom_core.hosts (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 connection_id uuid not null,account_id text not null,user_id text not null,name text not null,
 provider_active boolean not null default false,licensed boolean not null default false,
 allowed boolean not null default false,capacity integer check(capacity>0),
 provider_concurrency integer not null default 1 check(provider_concurrency between 1 and 10),
 concurrency_limit integer not null default 1 check(concurrency_limit between 1 and provider_concurrency),
 capabilities jsonb not null default '{}',verified_at timestamptz,verification_source text,
 instructor_subject_id uuid references access_control.subjects(id), branch_key text,
 preference integer not null default 0,before_minutes integer not null default 10 check(before_minutes between 0 and 120),
 after_minutes integer not null default 10 check(after_minutes between 0 and 120),last_assigned_at timestamptz,
 revision integer not null default 1,
 foreign key(tenant_id,connection_id) references zoom_core.connections(tenant_id,id),
 unique(tenant_id,id),unique(connection_id,user_id)
);
create index zoom_hosts_candidates on zoom_core.hosts(tenant_id,allowed,connection_id,id);
create table zoom_core.host_instructors (
 tenant_id uuid not null,host_id uuid not null,subject_id uuid not null references access_control.subjects(id),
 provider_user_id text not null,authorization_kind text not null check(authorization_kind in ('host','alternative_host')),
 verified_at timestamptz not null,active boolean not null default true,
 primary key(tenant_id,host_id,subject_id),foreign key(tenant_id,host_id) references zoom_core.hosts(tenant_id,id)
);
create table zoom_core.commands (
 tenant_id uuid not null references core.tenants(id),id uuid not null,actor_subject_id uuid not null references access_control.subjects(id),
 action text not null,fingerprint text not null,result jsonb,created_at timestamptz not null default now(),primary key(tenant_id,id)
);
insert into access_control.permissions(permission_key,module_key,name_ar)
select 'tenant.zoom.'||k,'academy',label from(values
 ('connections.manage','إدارة حسابات زووم'),('hosts.manage','إدارة مضيفي زووم'),
 ('sessions.manage','إدارة محاضرات زووم'),('attendance.review','مراجعة أدلة حضور زووم'),('attendance.override','اعتماد استثناء حضور زووم'),
 ('recordings.publish','نشر تسجيلات زووم'),('reports.export','تصدير تقارير زووم'),
 ('retention.manage','إدارة احتفاظ بيانات زووم'),('ai.generate','إنشاء مسودات زووم بالذكاء الاصطناعي')
)v(k,label) on conflict(permission_key) do nothing;

create function zoom_core.service_only() returns void language plpgsql set search_path='' as $$
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then raise exception 'zoom_forbidden' using errcode='42501';end if;
end $$;
create function zoom_core.allowed(t uuid,operation text) returns boolean language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and private_app.current_subject_id() is not null and (
 private_app.has_tenant_permission(t,'tenant.zoom.'||operation)
 or (operation in ('connections.manage','hosts.manage','retention.manage') and private_app.has_tenant_permission(t,'tenant.settings.manage'))
 or (operation in ('sessions.manage','attendance.review','attendance.override','recordings.publish') and private_app.has_tenant_permission(t,'tenant.academy.write')))
$$;
-- Same active staff/academy instructor authority as the canonical training helper,
-- evaluated for the assigned subject, never a client-supplied display role.
create function zoom_core.active_instructor(t uuid,teacher uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from access_control.subjects a where a.id=teacher and a.status='active' and not a.must_change_password and (
 exists(select 1 from access_control.memberships m where m.tenant_id=t and m.subject_id=a.id and m.scope='tenant' and m.status='active') or
 (private_app.academy_platform_enabled_v1(t,'lms') and exists(select 1 from academy.platform_memberships am where am.tenant_id=t and am.subject_id=a.id and am.status='active' and am.role_key in ('manager','instructor')))))
$$;
create function zoom_core.tenant(p_slug text,p_enabled boolean default true) returns uuid language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 if auth.uid() is null or private_app.current_subject_id() is null then raise exception 'zoom_forbidden';end if;
 select id into t from core.tenants where slug=p_slug and status='active';
 if t is null then raise exception 'zoom_forbidden';end if;
 if p_enabled and not(exists(select 1 from zoom_core.settings where tenant_id=t and enabled)
 and private_app.tenant_addon_enabled(t,'addon.integration.zoom')) then raise exception 'zoom_not_enabled';end if;
 return t;
end $$;
create function zoom_core.assert_actor(t uuid,u uuid,s uuid,operation text) returns void language plpgsql security definer set search_path='' as $$
declare previous_claims text:=current_setting('request.jwt.claims',true);previous_sub text:=current_setting('request.jwt.claim.sub',true);permitted boolean;
begin
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
 permitted:=private_app.current_subject_id()=s and zoom_core.allowed(t,operation);
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 perform set_config('request.jwt.claims',coalesce(previous_claims,''),true);
 if not coalesce(permitted,false) then raise exception 'zoom_forbidden';end if;
end $$;
create function zoom_core.command(t uuid,command_id uuid,operation text,payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare c zoom_core.commands%rowtype;fp text:=md5(operation||payload::text);
begin
 if command_id is null then raise exception 'zoom_command_required';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':command:'||command_id::text,0));
 select * into c from zoom_core.commands where tenant_id=t and id=command_id;
 if c.id is not null then
  if c.fingerprint<>fp or c.actor_subject_id<>private_app.current_subject_id() then raise exception 'zoom_command_reused';end if;
  return c.result;
 end if;
 insert into zoom_core.commands(tenant_id,id,actor_subject_id,action,fingerprint) values(t,command_id,private_app.current_subject_id(),operation,fp);
 return null;
end $$;
create function public.v1_zoom_oauth(p_slug text,p_action text,p_state_hash text,p_connection_id uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);a zoom_core.oauth_attempts%rowtype;environment_key text;
begin
 if not zoom_core.allowed(t,'connections.manage') then raise exception 'zoom_forbidden';end if;
 if p_state_hash !~ '^[a-f0-9]{64}$' then raise exception 'zoom_invalid_state';end if;
 select environment into environment_key from zoom_core.settings where tenant_id=t;
 if p_action in ('add','reconnect') then
  if (p_action='add' and p_connection_id is not null) or(p_action='reconnect' and not exists(select 1 from zoom_core.connections where tenant_id=t and id=p_connection_id and environment=environment_key)) then raise exception 'zoom_invalid_connection';end if;
  insert into zoom_core.oauth_attempts(tenant_id,auth_user_id,subject_id,state_hash,mode,connection_id,environment,return_path)
  values(t,auth.uid(),private_app.current_subject_id(),p_state_hash,p_action,p_connection_id,environment_key,'/tenant/'||p_slug||'/addons/zoom') returning * into a;
 elsif p_action='claim' then
  update zoom_core.oauth_attempts set claimed_at=now() where tenant_id=t and state_hash=p_state_hash and auth_user_id=auth.uid()
   and subject_id=private_app.current_subject_id() and claimed_at is null and expires_at>now() and environment=environment_key returning * into a;
  if a.id is null then raise exception 'zoom_invalid_state';end if;
 else raise exception 'zoom_invalid_action';end if;
 return jsonb_build_object('attemptId',a.id,'environment',a.environment,'returnPath',a.return_path);
end $$;
create function public.v1_zoom_finish_oauth(p_attempt_id uuid,p_identity jsonb,p_tokens jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare a zoom_core.oauth_attempts%rowtype;c zoom_core.connections%rowtype;secret_id uuid;account_key text:=p_identity->>'account_id';
begin
 perform zoom_core.service_only();
 select * into a from zoom_core.oauth_attempts where id=p_attempt_id for update;
 if a.id is null or a.claimed_at is null or a.finished_at is not null or a.expires_at<=now() then raise exception 'zoom_invalid_state';end if;
 perform zoom_core.assert_actor(a.tenant_id,a.auth_user_id,a.subject_id,'connections.manage');
 if not exists(select 1 from zoom_core.settings where tenant_id=a.tenant_id and enabled and environment=a.environment) or not private_app.tenant_addon_enabled(a.tenant_id,'addon.integration.zoom') then raise exception 'zoom_not_enabled';end if;
 if nullif(account_key,'') is null or nullif(p_identity->>'id','') is null or nullif(p_tokens->>'access_token','') is null or nullif(p_tokens->>'refresh_token','') is null or coalesce((p_tokens->>'expires_in')::int,0) not between 1 and 86400 then raise exception 'zoom_invalid_provider_response';end if;
 perform pg_advisory_xact_lock(hashtextextended(a.environment||':zoom-account:'||account_key,0));
 select * into c from zoom_core.connections where environment=a.environment and account_id=account_key for update;
 if c.id is not null and c.tenant_id<>a.tenant_id then raise exception 'zoom_account_unavailable';end if;
 if a.mode='reconnect' and (c.id is null or c.id<>a.connection_id) then raise exception 'zoom_account_mismatch';end if;
 -- A repeat add reconnects the same resource; never duplicates host capacity.
 if c.vault_secret_id is null then
  select vault.create_secret(jsonb_build_object('access_token',p_tokens->>'access_token','refresh_token',p_tokens->>'refresh_token')::text,'zoom:'||a.tenant_id||':'||gen_random_uuid(),'ODEIR Zoom OAuth tokens',null) into secret_id;
 else
  secret_id:=c.vault_secret_id;
  perform vault.update_secret(secret_id,jsonb_build_object('access_token',p_tokens->>'access_token','refresh_token',p_tokens->>'refresh_token')::text,null,null);
 end if;
 insert into zoom_core.connections(tenant_id,environment,account_id,grant_user_id,label,scopes,vault_secret_id,expires_at)
 values(a.tenant_id,a.environment,account_key,p_identity->>'id',left(coalesce(nullif(p_identity->>'display_name',''),nullif(p_identity->>'first_name',''),'Zoom'),120),to_jsonb(string_to_array(coalesce(p_tokens->>'scope',''),' ')),secret_id,now()+make_interval(secs=>(p_tokens->>'expires_in')::int))
 on conflict(environment,account_id) do update set grant_user_id=excluded.grant_user_id,label=excluded.label,scopes=excluded.scopes,vault_secret_id=excluded.vault_secret_id,expires_at=excluded.expires_at,status='connected',generation=zoom_core.connections.generation+1,refresh_lease=null,refresh_until=null,last_error=null,updated_at=now() returning * into c;
 update zoom_core.oauth_attempts set finished_at=now() where id=a.id;
 perform private_app.write_audit('zoom.connected','zoom_connection',c.id::text,c.tenant_id,jsonb_build_object('subjectId',a.subject_id,'mode',a.mode));
 return jsonb_build_object('connectionId',c.id,'status',c.status);
end $$;
create function public.v1_zoom_token_lease(p_connection_id uuid,p_lease_id uuid,p_action text,p_generation integer default null,p_tokens jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare c zoom_core.connections%rowtype;secret_value jsonb;
begin
 perform zoom_core.service_only();
 select * into c from zoom_core.connections where id=p_connection_id for update;
 if c.id is null or c.status not in ('connected','missing_scope','paused') or not exists(select 1 from zoom_core.settings where tenant_id=c.tenant_id and enabled and environment=c.environment) or not private_app.tenant_addon_enabled(c.tenant_id,'addon.integration.zoom') then raise exception 'zoom_reauth_required';end if;
 if p_action='claim' then
  if c.refresh_lease is not null then
   if c.refresh_until>now() then return jsonb_build_object('status','busy');end if;
   -- An expired lease could have consumed the rotating token. Never reuse it.
   update zoom_core.connections set status='reauth_required',last_error='refresh_outcome_unknown',generation=generation+1 where id=c.id;
   return jsonb_build_object('status','reauth_required');
  end if;
  select decrypted_secret::jsonb into secret_value from vault.decrypted_secrets where id=c.vault_secret_id;
  if secret_value is null then raise exception 'zoom_reauth_required';end if;
  if c.expires_at>now()+interval '90 seconds' then return jsonb_build_object('status','ready','accessToken',secret_value->>'access_token','generation',c.generation);end if;
  if p_lease_id is null then raise exception 'zoom_invalid_lease';end if;
  update zoom_core.connections set refresh_lease=p_lease_id,refresh_until=now()+interval '45 seconds' where id=c.id;
  return jsonb_build_object('status','refresh','refreshToken',secret_value->>'refresh_token','generation',c.generation);
 elsif p_action in ('complete','failed') then
  if p_lease_id is null or c.refresh_lease is distinct from p_lease_id or c.generation is distinct from p_generation or c.refresh_until<=now() then raise exception 'zoom_stale_lease';end if;
  if p_action='failed' then
   update zoom_core.connections set status='reauth_required',refresh_lease=null,refresh_until=null,last_error='refresh_failed',generation=generation+1 where id=c.id;
   return jsonb_build_object('status','reauth_required');
  end if;
  if nullif(p_tokens->>'access_token','') is null or nullif(p_tokens->>'refresh_token','') is null or coalesce((p_tokens->>'expires_in')::int,0) not between 1 and 86400 then raise exception 'zoom_invalid_provider_response';end if;
  perform vault.update_secret(c.vault_secret_id,jsonb_build_object('access_token',p_tokens->>'access_token','refresh_token',p_tokens->>'refresh_token')::text,null,null);
  update zoom_core.connections set expires_at=now()+make_interval(secs=>(p_tokens->>'expires_in')::int),refresh_lease=null,refresh_until=null,generation=generation+1,last_error=null where id=c.id;
  return jsonb_build_object('status','ready','accessToken',p_tokens->>'access_token','generation',c.generation+1);
 else raise exception 'zoom_invalid_action';end if;
end $$;
create function public.v1_zoom_connection_authorize(p_slug text,p_connection_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);c zoom_core.connections%rowtype;
begin
 if not zoom_core.allowed(t,'connections.manage') then raise exception 'zoom_forbidden';end if;
 select * into c from zoom_core.connections where tenant_id=t and id=p_connection_id;
 if c.id is null then raise exception 'zoom_not_found';end if;
 return jsonb_build_object('connectionId',c.id,'accountId',c.account_id,'generation',c.generation,'environment',c.environment,'grantUserId',c.grant_user_id);
end $$;
create function public.v1_zoom_sync_hosts(p_connection_id uuid,p_generation integer,p_hosts jsonb,p_coverage text) returns jsonb language plpgsql security definer set search_path='' as $$
declare c zoom_core.connections%rowtype;u jsonb;total integer:=0;
begin
 perform zoom_core.service_only();
 select * into c from zoom_core.connections where id=p_connection_id for update;
 if c.id is null or c.generation<>p_generation or c.status<>'connected' then raise exception 'zoom_stale_lease';end if;
 if jsonb_typeof(p_hosts)<>'array' or jsonb_array_length(p_hosts)>500 or p_coverage not in ('complete','partial','user_only') then raise exception 'zoom_invalid_provider_response';end if;
 for u in select value from jsonb_array_elements(p_hosts) loop
  if nullif(u->>'id','') is null or u->>'account_id' is distinct from c.account_id then raise exception 'zoom_account_mismatch';end if;
  insert into zoom_core.hosts(tenant_id,connection_id,account_id,user_id,name,provider_active,licensed,capacity,capabilities,verified_at,verification_source)
  values(c.tenant_id,c.id,c.account_id,u->>'id',left(coalesce(u->>'display_name',u->>'first_name','Zoom host'),120),u->>'status'='active',u->>'type' in ('2','3'),(u->>'capacity')::integer,coalesce(u->'capabilities','{}'),case when u->>'capacity' is not null then now() end,'zoom_api')
  on conflict(connection_id,user_id) do update set name=excluded.name,provider_active=excluded.provider_active,licensed=excluded.licensed,capacity=excluded.capacity,capabilities=excluded.capabilities,verified_at=excluded.verified_at,verification_source=excluded.verification_source,revision=zoom_core.hosts.revision+1;
  total:=total+1;
 end loop;
 if p_coverage='complete' then update zoom_core.hosts h set provider_active=false where h.connection_id=c.id and not exists(select 1 from jsonb_array_elements(p_hosts) item where item->>'id'=h.user_id);end if;
 update zoom_core.connections set last_synced_at=now(),sync_coverage=p_coverage where id=c.id;
 return jsonb_build_object('count',total,'coverage',p_coverage);
end $$;

do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='zoom_core' loop
  execute format('alter table zoom_core.%I enable row level security',r.tablename);
  execute format('revoke all on zoom_core.%I from public,anon,authenticated,service_role',r.tablename);
 end loop;
end $$;
revoke all on all functions in schema zoom_core from public,anon,authenticated,service_role;
revoke all on function public.v1_zoom_oauth(text,text,text,uuid),public.v1_zoom_finish_oauth(uuid,jsonb,jsonb),public.v1_zoom_token_lease(uuid,uuid,text,integer,jsonb),public.v1_zoom_connection_authorize(text,uuid),public.v1_zoom_sync_hosts(uuid,integer,jsonb,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_oauth(text,text,text,uuid),public.v1_zoom_connection_authorize(text,uuid) to authenticated;
grant execute on function public.v1_zoom_finish_oauth(uuid,jsonb,jsonb),public.v1_zoom_token_lease(uuid,uuid,text,integer,jsonb),public.v1_zoom_sync_hosts(uuid,integer,jsonb,text) to service_role;
commit;
