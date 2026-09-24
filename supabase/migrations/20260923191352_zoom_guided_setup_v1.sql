begin;
-- Explicit setup only. Applying this migration creates no settings or activations.
create function public.v1_zoom_setup_snapshot(p_slug text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug,false);cfg zoom_core.settings%rowtype;
begin
 if not (zoom_core.allowed(t,'connections.manage') or zoom_core.allowed(t,'sessions.manage')) then raise exception 'zoom_forbidden' using errcode='42501';end if;
 select * into cfg from zoom_core.settings where tenant_id=t;
 return jsonb_build_object(
  'authUserId',auth.uid(),'subjectId',private_app.current_subject_id(),
  'initialized',cfg.tenant_id is not null,'tenantEnabled',coalesce(cfg.enabled,false),
  'environment',cfg.environment,'revision',cfg.revision,
  'entitled',private_app.tenant_addon_enabled(t,'addon.integration.zoom'),
  'canConfigure',zoom_core.allowed(t,'retention.manage'),
  'ownerReady',exists(select 1 from people.staff_profiles where tenant_id=t and id=cfg.owner_staff_id and employment_status='active'),
  'accounts',(select count(*) from zoom_core.connections where tenant_id=t),
  'connectedAccounts',(select count(*) from zoom_core.connections where tenant_id=t and status='connected'),
  'hosts',(select count(*) from zoom_core.hosts where tenant_id=t),
  'eligibleHosts',(select count(*) from zoom_core.hosts h join zoom_core.connections c on c.tenant_id=h.tenant_id and c.id=h.connection_id
   where h.tenant_id=t and h.allowed and h.provider_active and h.licensed and h.verified_at>now()-interval '24 hours'
   and c.status='connected' and h.capacity>0 and h.concurrency_limit>0 and exists(select 1 from zoom_core.host_instructors hi
    where hi.tenant_id=t and hi.host_id=h.id and hi.subject_id=h.instructor_subject_id and hi.active
    and hi.verified_at>now()-interval '24 hours' and zoom_core.active_instructor(t,hi.subject_id))),
  'linkedSessions',(select count(*) from zoom_core.links where tenant_id=t),
  'instructors',(select count(distinct subject_id) from academy.training_run_instructors where tenant_id=t and active));
end $$;

create function public.v1_zoom_initialize(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug,false);result jsonb;cfg zoom_core.settings%rowtype;
 owner_id uuid:=nullif(p_payload->>'ownerStaffId','')::uuid;environment_key text:=coalesce(p_payload->>'environment','production');
begin
 if not zoom_core.allowed(t,'connections.manage') or not zoom_core.allowed(t,'retention.manage') then raise exception 'zoom_forbidden' using errcode='42501';end if;
 if not private_app.tenant_addon_enabled(t,'addon.integration.zoom') then raise exception 'zoom_addon_required';end if;
 if environment_key not in ('production','test') then raise exception 'zoom_configuration_missing';end if;
 perform pg_advisory_xact_lock(hashtextextended(t::text||':setup',0));
 result:=zoom_core.command(t,p_command_id,'initialize',p_payload);if result is not null then return result;end if;
 select * into cfg from zoom_core.settings where tenant_id=t for update;
 if cfg.tenant_id is null then
  if not exists(select 1 from people.staff_profiles where tenant_id=t and id=owner_id and employment_status='active') then raise exception 'zoom_invalid_owner';end if;
  insert into zoom_core.settings(tenant_id,enabled,environment,owner_staff_id) values(t,false,environment_key,owner_id) returning * into cfg;
  perform private_app.write_audit('zoom.initialize','zoom_settings',t::text,t,jsonb_build_object('enabled',false,'environment',environment_key));
 end if;
 result:=jsonb_build_object('initialized',true,'enabled',cfg.enabled,'revision',cfg.revision);
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 return result;
end $$;

-- Only the Edge gateway can activate after inspecting actual runtime configuration.
-- The user identity is obtained by a JWT-authenticated setup RPC, never request fields.
create function public.v1_zoom_activate(p_slug text,p_auth_user_id uuid,p_subject_id uuid,p_command_id uuid,p_revision integer,p_environment text) returns jsonb
language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid;cfg zoom_core.settings%rowtype;result jsonb;
 old_claims text:=current_setting('request.jwt.claims',true);old_sub text:=current_setting('request.jwt.claim.sub',true);
begin
 perform zoom_core.service_only();
 select id into t from core.tenants where slug=p_slug and status='active';
 if t is null then raise exception 'zoom_forbidden' using errcode='42501';end if;
 perform zoom_core.assert_actor(t,p_auth_user_id,p_subject_id,'connections.manage');
 perform zoom_core.assert_actor(t,p_auth_user_id,p_subject_id,'retention.manage');
 if not private_app.tenant_addon_enabled(t,'addon.integration.zoom') then raise exception 'zoom_addon_required';end if;
 perform set_config('request.jwt.claim.sub',p_auth_user_id::text,true);
 perform set_config('request.jwt.claims',jsonb_build_object('sub',p_auth_user_id,'role','authenticated')::text,true);
 perform pg_advisory_xact_lock(hashtextextended(t::text||':setup',0));
 result:=zoom_core.command(t,p_command_id,'activate',jsonb_build_object('revision',p_revision,'environment',p_environment));
 if result is null then
  select * into cfg from zoom_core.settings where tenant_id=t for update;
  if cfg.tenant_id is null then raise exception 'zoom_setup_required';end if;
  if cfg.revision is distinct from p_revision then raise exception 'zoom_revision_conflict';end if;
  if cfg.environment is distinct from p_environment then raise exception 'zoom_configuration_missing';end if;
  if not exists(select 1 from people.staff_profiles where tenant_id=t and id=cfg.owner_staff_id and employment_status='active') then raise exception 'zoom_invalid_owner';end if;
  update zoom_core.settings set enabled=true,revision=revision+1,updated_at=now() where tenant_id=t returning * into cfg;
  result:=jsonb_build_object('enabled',true,'revision',cfg.revision);
  update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
  perform private_app.write_audit('zoom.activate','zoom_settings',t::text,t,result);
 end if;
 perform set_config('request.jwt.claim.sub',coalesce(old_sub,''),true);
 perform set_config('request.jwt.claims',coalesce(old_claims,''),true);
 return result;
end $$;

create function public.v1_zoom_platform_setup_authorize() returns boolean
language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not private_app.has_platform_permission('platform.billing.manage') then raise exception 'zoom_forbidden' using errcode='42501';end if;
 return true;
end $$;

create function public.v1_zoom_runtime_probe() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare scheduled boolean:=false;
begin
 perform zoom_core.service_only();
 if to_regclass('cron.job') is not null then
  execute 'select exists(select 1 from cron.job where active and command like ''%/functions/v1/zoom-connect/dispatch%'')' into scheduled;
 end if;
 return jsonb_build_object('schedulerConfigured',scheduled);
end $$;

-- Policy editing is allowed during explicit preparation, before provider activation.
create or replace function public.v1_zoom_settings(p_slug text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug,false);result jsonb;settings zoom_core.settings%rowtype;
begin
 if not zoom_core.allowed(t,'connections.manage') or not zoom_core.allowed(t,'retention.manage') then raise exception 'zoom_forbidden' using errcode='42501';end if;
 if not private_app.tenant_addon_enabled(t,'addon.integration.zoom') then raise exception 'zoom_addon_required';end if;
 result:=zoom_core.command(t,p_command_id,'settings',p_payload);if result is not null then return result;end if;
 select * into settings from zoom_core.settings where tenant_id=t for update;
 if settings.tenant_id is null then raise exception 'zoom_setup_required';end if;
 if settings.revision is distinct from (p_payload->>'expectedVersion')::int then raise exception 'zoom_revision_conflict';end if;
 if p_payload->>'ownerStaffId' is not null and not exists(select 1 from people.staff_profiles where tenant_id=t and id=(p_payload->>'ownerStaffId')::uuid and employment_status='active') then raise exception 'zoom_invalid_owner';end if;
 if p_payload?'retentionDays' and coalesce((p_payload->>'retentionDays')::int,0) not between 1 and 3650 then raise exception 'zoom_invalid_retention';end if;
 update zoom_core.settings set join_before_minutes=coalesce((p_payload->>'joinBeforeMinutes')::int,join_before_minutes),recording_policy=coalesce(p_payload->>'recordingPolicy',recording_policy),owner_staff_id=coalesce((p_payload->>'ownerStaffId')::uuid,owner_staff_id),
 retention_policy=case when p_payload?'retentionDays' and p_payload->>'retentionApproved'='true' then jsonb_build_object('days',(p_payload->>'retentionDays')::int,'approved',true,'approvedBy',private_app.current_subject_id(),'approvedAt',now(),'delivery','provider','revocationLimitAcknowledged',p_payload->>'providerLimitAcknowledged'='true') else retention_policy end,revision=revision+1,updated_at=now() where tenant_id=t;
 result:=jsonb_build_object('revision',settings.revision+1);update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.settings','zoom_settings',t::text,t,result);return result;
end $$;

revoke all on function public.v1_zoom_setup_snapshot(text),public.v1_zoom_initialize(text,uuid,jsonb),public.v1_zoom_platform_setup_authorize(),public.v1_zoom_runtime_probe(),public.v1_zoom_activate(text,uuid,uuid,uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.v1_zoom_setup_snapshot(text),public.v1_zoom_initialize(text,uuid,jsonb),public.v1_zoom_platform_setup_authorize() to authenticated;
grant execute on function public.v1_zoom_runtime_probe(),public.v1_zoom_activate(text,uuid,uuid,uuid,integer,text) to service_role;
commit;
