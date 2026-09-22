begin;
insert into access_control.permissions(permission_key,module_key,name_ar) values('tenant.zoom.webinars.manage','marketing','إدارة ندوات زووم التسويقية') on conflict do nothing;
create unique index if not exists zoom_campaign_tenant_id on marketing_hub.campaigns(tenant_id,id);
create unique index if not exists zoom_contact_tenant_id on sales_core.contacts(tenant_id,id);
create table zoom_core.webinars (
 tenant_id uuid not null,link_id uuid not null,campaign_id uuid,source text not null,consent_version text not null,updated_by uuid not null references access_control.subjects(id),
 primary key(tenant_id,link_id),foreign key(tenant_id,link_id) references zoom_core.links(tenant_id,id),foreign key(tenant_id,campaign_id) references marketing_hub.campaigns(tenant_id,id)
);
create table zoom_core.webinar_registrations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null,link_id uuid not null,contact_id uuid not null,registrant_id text,secret_id uuid,
 state text not null default 'new' check(state in ('new','registering','registered','uncertain','revoked')),registration_consent boolean not null,marketing_consent boolean not null default false,consent_version text not null,
 actor_subject_id uuid not null references access_control.subjects(id),auth_user_id uuid not null references auth.users(id),lease_id uuid,lease_until timestamptz,
 registered_at timestamptz,attended_seconds integer,quality text not null default 'unknown',created_at timestamptz not null default now(),
 foreign key(tenant_id,link_id) references zoom_core.webinars(tenant_id,link_id),foreign key(tenant_id,contact_id) references sales_core.contacts(tenant_id,id),unique(tenant_id,link_id,contact_id),unique(tenant_id,id),unique(link_id,registrant_id)
);
create function public.v1_zoom_webinar_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
<<operation>>
declare t uuid:=zoom_core.tenant(p_slug);l zoom_core.links%rowtype;w zoom_core.webinars%rowtype;c sales_core.contacts%rowtype;cid uuid;result jsonb;cnt int;created jsonb;rid uuid;
begin
 if not zoom_core.allowed(t,'webinars.manage') or not private_app.has_tenant_permission(t,'tenant.crm.write') then raise exception 'zoom_forbidden';end if;
 result:=zoom_core.command(t,p_command_id,'webinar.'||p_action,p_payload);if result is not null then return result;end if;
 select * into l from zoom_core.links where tenant_id=t and id=(p_payload->>'linkId')::uuid and kind='webinar';
 if l.id is null then raise exception 'zoom_not_found';end if;
 if p_action='webinar_configure' then
  if length(trim(coalesce(p_payload->>'source','')))<2 or length(trim(coalesce(p_payload->>'consentVersion','')))<2 then raise exception 'zoom_consent_required';end if;
  insert into zoom_core.webinars(tenant_id,link_id,campaign_id,source,consent_version,updated_by) values(t,l.id,(p_payload->>'campaignId')::uuid,left(p_payload->>'source',150),left(p_payload->>'consentVersion',100),private_app.current_subject_id()) on conflict(tenant_id,link_id) do update set campaign_id=excluded.campaign_id,source=excluded.source,consent_version=excluded.consent_version,updated_by=excluded.updated_by;
  result:=jsonb_build_object('linkId',l.id,'status','configured');
 elsif p_action='webinar_prepare' then
  select * into w from zoom_core.webinars where tenant_id=t and link_id=l.id;
  if w.link_id is null or l.state not in ('ready','live','imported') or p_payload->>'registrationConsent' is distinct from 'true' or p_payload->>'consentVersion' is distinct from w.consent_version then raise exception 'zoom_consent_required';end if;
  perform pg_advisory_xact_lock(hashtextextended(t::text,1729));
  if p_payload->>'contactId' is not null then cid:=(p_payload->>'contactId')::uuid;
  else
   select count(distinct contact_id) into cnt from sales_core.contact_identities where tenant_id=t and ((identity_type='phone' and identity_value=private_app.normalize_lead_phone(p_payload->>'phone'))or(identity_type='email' and identity_value=lower(trim(p_payload->>'email'))));
   if cnt>1 then raise exception 'zoom_identity_review_required';end if;
   cid:=private_app.find_contact_by_identity(t,p_payload->>'phone',null,p_payload->>'email');
   if cid is null then
    created:=public.v2_tenant_create_contact(p_slug,p_payload->>'name',p_payload->>'phone',null,lower(trim(p_payload->>'email')),null,w.source,null,null,'سجل للندوة؛ لا يمنح التسجيل استحقاقًا دراسيًا أو موافقة تسويقية.');cid:=(created->>'id')::uuid;
   end if;
  end if;
  c:=private_app.sales_followup_contact(p_slug,cid,true);
  if c.tenant_id<>t or c.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'zoom_verified_email_required';end if;
  insert into zoom_core.webinar_registrations(tenant_id,link_id,contact_id,registration_consent,marketing_consent,consent_version,actor_subject_id,auth_user_id)
  values(t,l.id,c.id,true,p_payload->>'marketingConsent'='true',w.consent_version,private_app.current_subject_id(),auth.uid()) on conflict(tenant_id,link_id,contact_id) do update set registration_consent=true returning id into rid;
  result:=jsonb_build_object('registrationId',rid);
 else raise exception 'zoom_invalid_action';end if;
 update zoom_core.commands set result=operation.result where tenant_id=t and id=p_command_id;
 perform private_app.write_audit('zoom.'||p_action,'zoom_webinar',l.id::text,t,jsonb_build_object('contactId',cid));return result;
end $$;
create function public.v1_zoom_webinar_registration(p_slug text,p_registration_id uuid,p_lease_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);r zoom_core.webinar_registrations%rowtype;l zoom_core.links%rowtype;c sales_core.contacts%rowtype;
begin
 if not zoom_core.allowed(t,'webinars.manage') then raise exception 'zoom_forbidden';end if;
 select * into r from zoom_core.webinar_registrations where tenant_id=t and id=p_registration_id for update;select * into l from zoom_core.links where tenant_id=t and id=r.link_id;
 if r.id is null or l.state not in ('ready','live','imported') then raise exception 'zoom_not_found';end if;
 c:=private_app.sales_followup_contact(p_slug,r.contact_id,true);
 if r.state='registered' then return jsonb_build_object('status','registered','registrationId',r.id);end if;
 if r.state='registering' and r.lease_id=p_lease_id and r.lease_until>now() then null;
 elsif r.state='registering' or r.state='uncertain' then return jsonb_build_object('status','uncertain');
 elsif r.state='new' then update zoom_core.webinar_registrations set state='registering',lease_id=p_lease_id,lease_until=now()+interval '45 seconds',actor_subject_id=private_app.current_subject_id(),auth_user_id=auth.uid() where id=r.id;
 else raise exception 'zoom_not_found';end if;
 return jsonb_build_object('status','register','registrationId',r.id,'connectionId',l.connection_id,'meetingId',l.meeting_id,'name',c.full_name,'email',c.email);
end $$;
create function public.v1_zoom_webinar_complete(p_registration_id uuid,p_lease_id uuid,p_generation integer,p_result jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare r zoom_core.webinar_registrations%rowtype;l zoom_core.links%rowtype;secret uuid;w zoom_core.webinars%rowtype;
begin
 perform zoom_core.service_only();select * into r from zoom_core.webinar_registrations where id=p_registration_id for update;select * into l from zoom_core.links where tenant_id=r.tenant_id and id=r.link_id;
 if r.id is null or r.state<>'registering' or r.lease_id is distinct from p_lease_id or r.lease_until<=now() or l.state not in ('ready','live','imported') or not exists(select 1 from zoom_core.connections where tenant_id=l.tenant_id and id=l.connection_id and generation=p_generation and status in ('connected','paused')) then raise exception 'zoom_stale_lease';end if;
 perform zoom_core.assert_actor(r.tenant_id,r.auth_user_id,r.actor_subject_id,'webinars.manage');
 if nullif(p_result->>'registrant_id','') is null or coalesce(p_result->>'join_url','') !~ '^https://([a-zA-Z0-9-]+\.)*zoom\.us/' then raise exception 'zoom_invalid_provider_response';end if;
 select vault.create_secret(jsonb_build_object('join_url',p_result->>'join_url')::text,'zoom-webinar:'||r.id,'ODEIR customer webinar registration',null) into secret;
 update zoom_core.webinar_registrations set secret_id=secret,registrant_id=p_result->>'registrant_id',state='registered',registered_at=now(),lease_id=null,lease_until=null where id=r.id;
 select * into w from zoom_core.webinars where tenant_id=r.tenant_id and link_id=r.link_id;
 insert into sales_core.activities(tenant_id,activity_key,contact_id,activity_type,summary,created_by_subject_id,metadata) values(r.tenant_id,'zoom:webinar:registered:'||r.id,r.contact_id,'note','سجّل العميل في ندوة زووم',r.actor_subject_id,jsonb_build_object('source','zoom_webinar','linkId',r.link_id,'campaignId',w.campaign_id,'sourceLabel',w.source,'marketingConsent',r.marketing_consent)) on conflict(tenant_id,activity_key) do nothing;
 return jsonb_build_object('status','registered','registrationId',r.id);
end $$;
create function public.v1_zoom_webinar_evidence(p_operation_id uuid,p_lease_id uuid,p_fence integer,p_uuid text,p_participants jsonb,p_complete boolean) returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb;l zoom_core.links%rowtype;r zoom_core.webinar_registrations%rowtype;p jsonb;intervals tstzmultirange;seconds_value numeric;w zoom_core.webinars%rowtype;
begin
 ctx:=public.v1_zoom_operation_context(p_operation_id,p_lease_id,p_fence);select * into l from zoom_core.links where id=(ctx->'link'->>'id')::uuid;select * into w from zoom_core.webinars where tenant_id=l.tenant_id and link_id=l.id;
 if w.link_id is null then return jsonb_build_object('marketing',false);end if;
 if not exists(select 1 from zoom_core.instances where tenant_id=l.tenant_id and link_id=l.id and uuid=p_uuid) or not p_complete or jsonb_typeof(p_participants)<>'array' or jsonb_array_length(p_participants)>5000 then return jsonb_build_object('marketing',true,'status','incomplete');end if;
 for r in select * from zoom_core.webinar_registrations where tenant_id=l.tenant_id and link_id=l.id and state='registered' loop
  select range_agg(tstzrange((value->>'join_time')::timestamptz,(value->>'leave_time')::timestamptz,'[)')) into intervals from jsonb_array_elements(p_participants) where value->>'registrant_id'=r.registrant_id and nullif(value->>'join_time','') is not null and (value->>'leave_time')::timestamptz>(value->>'join_time')::timestamptz;
  select coalesce(sum(extract(epoch from upper(x)-lower(x))),0) into seconds_value from unnest(coalesce(intervals,'{}'))x;
  -- Per-instance rows retain restart evidence; no sum of overlapping devices.
  insert into sales_core.activities(tenant_id,activity_key,contact_id,activity_type,summary,metadata) values(l.tenant_id,'zoom:webinar:attendance:'||r.id||':'||p_uuid,r.contact_id,'note','تحديث دليل حضور ندوة زووم',jsonb_build_object('source','zoom_webinar','linkId',l.id,'instanceUuid',p_uuid,'seconds',seconds_value,'complete',true,'campaignId',w.campaign_id)) on conflict(tenant_id,activity_key) do update set metadata=excluded.metadata;
  update zoom_core.webinar_registrations set attended_seconds=seconds_value::int,quality='complete' where id=r.id;
 end loop;return jsonb_build_object('marketing',true,'status','stored');
end $$;
create function public.v1_zoom_webinar_snapshot(p_slug text,p_link_id uuid,p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare t uuid:=zoom_core.tenant(p_slug);
begin
 if not zoom_core.allowed(t,'webinars.manage') or not private_app.has_tenant_permission(t,'tenant.crm.read') or p_offset not between 0 and 100000 then raise exception 'zoom_forbidden';end if;
 return jsonb_build_object('campaign',(select to_jsonb(w)-'updated_by' from zoom_core.webinars w where tenant_id=t and link_id=p_link_id),'registrations',coalesce((select jsonb_agg(to_jsonb(x)) from(select r.id,c.id contact_id,c.full_name,r.state,r.marketing_consent,r.attended_seconds,r.quality from zoom_core.webinar_registrations r join sales_core.contacts c on c.tenant_id=r.tenant_id and c.id=r.contact_id where r.tenant_id=t and r.link_id=p_link_id and (private_app.can_view_tenant_team(t) or c.owner_staff_id=private_app.current_staff_id(t)) order by r.created_at,r.id limit 50 offset p_offset)x),'[]'),'revenue',null,'revenueReason','use_canonical_campaign_accounting_report');
end $$;
do $$declare r record;begin
 for r in select tablename from pg_tables where schemaname='zoom_core' loop execute format('alter table zoom_core.%I enable row level security',r.tablename);execute format('revoke all on zoom_core.%I from public,anon,authenticated,service_role',r.tablename);end loop;
 for r in select p.oid::regprocedure sig,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('v1_zoom_webinar_action','v1_zoom_webinar_registration','v1_zoom_webinar_complete','v1_zoom_webinar_evidence','v1_zoom_webinar_snapshot') loop
 execute format('revoke all on function %s from public,anon,authenticated,service_role',r.sig);execute format('grant execute on function %s to %I',r.sig,case when r.proname in ('v1_zoom_webinar_complete','v1_zoom_webinar_evidence') then 'service_role' else 'authenticated' end);end loop;
end $$;
commit;
