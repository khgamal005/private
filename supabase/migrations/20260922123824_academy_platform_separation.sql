begin;
set local lock_timeout='5s';
set local statement_timeout='120s';

-- Academy invitations require independently confirmed email. Legacy invitations
-- keep their existing activation path; a new token cannot cross into that path.
alter table academy.training_invitations add column auth_mode text not null default 'legacy' check(auth_mode in ('legacy','confirmed_email'));

-- Independent academy control plane. No subscriptions, tenants, students or
-- production activation are created by this migration. Existing Odeir ACLs stay intact.
create table academy.platform_settings (
 tenant_id uuid primary key references core.tenants(id),
 enabled boolean not null default false,
 mode text not null default 'connected' check(mode in ('connected','standalone')),
 lms_enabled boolean not null default false,website_enabled boolean not null default false,store_enabled boolean not null default false,
 access_until timestamptz,version integer not null default 1 check(version>0),
 updated_by_subject_id uuid not null references access_control.subjects(id),updated_at timestamptz not null default now()
);
create table academy.platform_memberships (
 tenant_id uuid not null references core.tenants(id),subject_id uuid not null references access_control.subjects(id),
 role_key text not null check(role_key in ('manager','website_editor','instructor')),
 status text not null default 'active' check(status in ('active','suspended')),
 created_by_subject_id uuid not null references access_control.subjects(id),updated_at timestamptz not null default now(),
 primary key(tenant_id,subject_id)
);
create index academy_platform_memberships_subject_idx on academy.platform_memberships(subject_id,tenant_id) where status='active';
create table academy.platform_commands (
 tenant_id uuid not null references core.tenants(id),command_id uuid not null,
 actor_subject_id uuid not null references access_control.subjects(id),action text not null,payload jsonb not null,
 response jsonb not null,created_at timestamptz not null default now(),primary key(tenant_id,command_id)
);
create index academy_platform_commands_actor_idx on academy.platform_commands(actor_subject_id,created_at desc);
create table academy.platform_invitations (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),
 email text not null check(email=lower(trim(email)) and length(email)<=254),
 role_key text not null check(role_key in ('manager','website_editor','instructor')),
 token_hash text not null unique check(token_hash~'^[0-9a-f]{64}$'),
 expires_at timestamptz not null,status text not null default 'pending' check(status in ('pending','accepted','revoked')),
 invited_by_subject_id uuid not null references access_control.subjects(id),accepted_by_subject_id uuid references access_control.subjects(id),
 accepted_at timestamptz,created_at timestamptz not null default now(),check(expires_at>created_at),
 check((status='accepted')=(accepted_at is not null))
);
create unique index academy_platform_invitation_pending_idx on academy.platform_invitations(tenant_id,email) where status='pending';
create index academy_platform_invitation_actor_idx on academy.platform_invitations(invited_by_subject_id);
create index academy_platform_invitation_accepted_idx on academy.platform_invitations(accepted_by_subject_id) where accepted_by_subject_id is not null;
create index academy_platform_settings_actor_idx on academy.platform_settings(updated_by_subject_id);
create index academy_platform_memberships_actor_idx on academy.platform_memberships(created_by_subject_id);
alter table academy.platform_settings enable row level security;
alter table academy.platform_memberships enable row level security;
alter table academy.platform_commands enable row level security;
alter table academy.platform_invitations enable row level security;
revoke all on academy.platform_settings,academy.platform_memberships,academy.platform_commands,academy.platform_invitations from public,anon,authenticated;

create function private_app.academy_platform_enabled_v1(p_tenant_id uuid,p_component text default 'lms') returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from academy.platform_settings s join core.tenants t on t.id=s.tenant_id
 where s.tenant_id=p_tenant_id and t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone'
 and t.status in ('trial','active') and s.enabled
 and case p_component when 'lms' then s.lms_enabled when 'website' then s.website_enabled when 'store' then s.store_enabled else false end
 and ((s.access_until is not null and s.access_until>now()) or
 case p_component when 'lms' then private_app.tenant_addon_enabled(t.id,'addon.training.lms')
 when 'website' then private_app.tenant_addon_enabled(t.id,'module.website_cms')
 when 'store' then private_app.tenant_addon_enabled(t.id,'addon.training.lms') and private_app.tenant_addon_enabled(t.id,'module.website_cms') else false end))
$$;

create function private_app.academy_has_permission_v1(p_tenant_id uuid,p_permission text) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare s uuid;role_name text;component text;mode_name text;legacy_permission text;
begin
 select id into s from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password;
 if s is null then return false;end if;
 component:=case when p_permission in ('manageWebsite','publishWebsite') then 'website' when p_permission='manageStore' then 'store' else 'lms' end;
 if p_permission not in ('manageLearning','manageCourses','manageWebsite','publishWebsite','manageAdmissions','verifyPayments','manageTeam','manageStore') then return false;end if;
 if not private_app.academy_platform_enabled_v1(p_tenant_id,component) then return false;end if;
 if private_app.has_platform_permission('platform.tenants.manage') then return true;end if;
 select mode into mode_name from academy.platform_settings where tenant_id=p_tenant_id;
 select role_key into role_name from academy.platform_memberships where tenant_id=p_tenant_id and subject_id=s and status='active';
 if role_name='manager' and (p_permission not in ('manageAdmissions','verifyPayments') or mode_name='standalone') then return true;end if;
 if role_name='website_editor' and p_permission='manageWebsite' then return true;end if;
 legacy_permission:=case p_permission when 'manageLearning' then 'tenant.academy.write' when 'manageCourses' then 'tenant.academy.write'
 when 'manageWebsite' then 'tenant.website.manage' when 'publishWebsite' then 'tenant.website.publish'
 when 'manageAdmissions' then 'tenant.admissions.write' when 'verifyPayments' then 'tenant.admissions.payment.verify'
 when 'manageTeam' then 'tenant.settings.manage' when 'manageStore' then 'tenant.academy.write' end;
 return private_app.has_tenant_permission(p_tenant_id,legacy_permission)
 or (p_permission='verifyPayments' and private_app.has_accounting_permission(p_tenant_id,'tenant.accounting.payments.approve'));
end $$;

create function private_app.academy_training_tenant_v1(p_slug text) returns uuid
language plpgsql stable security definer set search_path='' as $$
declare t uuid;
begin
 if auth.uid() is null or not exists(select 1 from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password) then raise exception 'authentication_required' using errcode='42501';end if;
 select id into t from core.tenants where slug=p_slug;
 if t is null or not private_app.academy_platform_enabled_v1(t,'lms') then raise exception 'academy_not_available' using errcode='42501';end if;
 return t;
end $$;

create function public.v1_academy_workspace_snapshot(p_slug text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t core.tenants%rowtype;s access_control.subjects%rowtype;cfg academy.platform_settings%rowtype;perms jsonb;component_values jsonb;
begin
 select * into s from access_control.subjects where auth_user_id=auth.uid() and status='active';
 if auth.uid() is null or s.id is null then raise exception 'authentication_required' using errcode='42501';end if;
 if s.must_change_password then raise exception 'password_change_required' using errcode='42501';end if;
 select * into t from core.tenants where slug=p_slug and status in ('trial','active');
 if t.id is null or not (private_app.can_access_tenant(t.id) or exists(select 1 from academy.platform_memberships m where m.tenant_id=t.id and m.subject_id=s.id and m.status='active')) then raise exception 'forbidden' using errcode='42501';end if;
 select * into cfg from academy.platform_settings where tenant_id=t.id;
 component_values:=jsonb_build_object('lms',private_app.academy_platform_enabled_v1(t.id,'lms'),'website',private_app.academy_platform_enabled_v1(t.id,'website'),'store',private_app.academy_platform_enabled_v1(t.id,'store'));
 select jsonb_object_agg(k,private_app.academy_has_permission_v1(t.id,k)) into perms from unnest(array['manageLearning','manageCourses','manageWebsite','publishWebsite','manageAdmissions','verifyPayments','manageTeam','manageStore']) k;
 return jsonb_build_object('enabled',coalesce((component_values->>'lms')::boolean,false) or coalesce((component_values->>'website')::boolean,false) or coalesce((component_values->>'store')::boolean,false),
 'tenant',jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'timezone',t.timezone,'currency',coalesce((select base_currency from accounting_core.tenant_profiles where tenant_id=t.id),'SAR')),
 'subject',jsonb_build_object('id',s.id,'name',s.full_name,'email',s.email),'mode',coalesce(cfg.mode,'connected'),'components',component_values,'permissions',perms,
 'odeirAccess',private_app.can_access_tenant(t.id));
end $$;

create function private_app.academy_platform_config_v1(p_tenant_id uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('id',t.id,'slug',t.slug,'name',t.name,'enabled',coalesce(s.enabled,false),'mode',coalesce(s.mode,'connected'),
 'components',jsonb_build_object('lms',coalesce(s.lms_enabled,false),'website',coalesce(s.website_enabled,false),'store',coalesce(s.store_enabled,false)),
 'accessUntil',s.access_until,'version',coalesce(s.version,0),'pilotEligible',t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone',
 'actions',jsonb_build_object('canConfigure',t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone' and private_app.has_platform_permission('platform.tenants.manage'),'canGrantTrial',t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone' and private_app.has_platform_permission('platform.tenants.manage') and private_app.has_platform_permission('platform.billing.manage'),'canManageMembers',t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.slug='marktone' and private_app.has_platform_permission('platform.tenants.manage') and private_app.has_platform_permission('platform.access.manage')),
 'academyMembers',coalesce((select jsonb_agg(jsonb_build_object('subjectId',m.subject_id,'name',a.full_name,'email',a.email,'role',m.role_key,'status',m.status) order by a.full_name)
 from academy.platform_memberships m join access_control.subjects a on a.id=m.subject_id where m.tenant_id=t.id),'[]'::jsonb),
 'pendingInvitations',coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role_key,'expiresAt',i.expires_at) order by i.created_at desc)
 from academy.platform_invitations i where i.tenant_id=t.id and i.status='pending' and i.expires_at>now()),'[]'::jsonb))
 from core.tenants t left join academy.platform_settings s on s.tenant_id=t.id where t.id=p_tenant_id
$$;

create function public.v1_platform_academy_snapshot(p_slug text default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare tenants jsonb;prices jsonb;
begin
 if not private_app.has_platform_permission('platform.control.read') then raise exception 'forbidden' using errcode='42501';end if;
 select coalesce(jsonb_agg(x.row),'[]') into tenants from (select private_app.academy_platform_config_v1(t.id) row from core.tenants t where p_slug is null or t.slug=p_slug order by t.name,t.id limit 200)x;
 select coalesce(jsonb_agg(jsonb_build_object('productKey',p.product_key,'name',p.name_ar,'productId',p.id,'featureKey',f.feature_key,'currency',p.currency,'amountMinor',p.amount_minor,'interval',p.interval,'pricingMode',p.pricing_mode)),'[]') into prices
 from catalog.addon_products p join catalog.features f on f.id=p.feature_id where p.product_key in ('lms','cms_pro');
 return jsonb_build_object('tenants',tenants,'catalogReferences',prices,'actions',jsonb_build_object(
 'canConfigure',private_app.has_platform_permission('platform.tenants.manage'),
 'canGrantTrial',private_app.has_platform_permission('platform.tenants.manage') and private_app.has_platform_permission('platform.billing.manage'),
 'canManageMembers',private_app.has_platform_permission('platform.tenants.manage') and private_app.has_platform_permission('platform.access.manage')));
end $$;

create function public.v1_platform_academy_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare t uuid;actor uuid;target uuid;cfg academy.platform_settings%rowtype;cached academy.platform_commands%rowtype;before_state jsonb;result jsonb;
 until_at timestamptz;enabled_value boolean;mode_value text;parts jsonb;email_value text;role_value text;expiry timestamptz;
begin
 if not private_app.has_platform_permission('platform.tenants.manage') then raise exception 'forbidden' using errcode='42501';end if;
 actor:=private_app.current_subject_id();
 if p_command_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>32768 then raise exception 'academy_invalid_request';end if;
 select id into t from core.tenants where slug=p_slug for update;
 if t is null then raise exception 'tenant_not_found';end if;
 select * into cached from academy.platform_commands where tenant_id=t and command_id=p_command_id;
 if cached.command_id is not null then
  if cached.actor_subject_id<>actor or cached.action<>p_action or cached.payload<>p_payload then raise exception 'academy_command_conflict';end if;
  return cached.response;
 end if;
 before_state:=private_app.academy_platform_config_v1(t);
 if t<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid or p_slug<>'marktone' then raise exception 'academy_pilot_only';end if;
 if p_action='configure' then
  select * into cfg from academy.platform_settings where tenant_id=t;
  if jsonb_typeof(p_payload->'expectedVersion') is distinct from 'number' or (p_payload->>'expectedVersion')::integer<>coalesce(cfg.version,0) then raise exception 'academy_config_conflict';end if;
  if jsonb_typeof(p_payload->'enabled') is distinct from 'boolean' or jsonb_typeof(p_payload->'components') is distinct from 'object' then raise exception 'academy_invalid_request';end if;
  mode_value:=p_payload->>'mode';enabled_value:=(p_payload->>'enabled')::boolean;parts:=p_payload->'components';
  if mode_value not in ('standalone','connected') or mode_value is null or exists(select 1 from unnest(array['lms','website','store']) k where jsonb_typeof(parts->k) is distinct from 'boolean') then raise exception 'academy_invalid_request';end if;
  until_at:=nullif(p_payload->>'accessUntil','')::timestamptz;
  if not enabled_value then until_at:=null;end if;
  if until_at is not null and (until_at<=now() or until_at>now()+interval '30 days' or length(trim(coalesce(p_payload->>'reason','')))<3 or not private_app.has_platform_permission('platform.billing.manage')) then raise exception 'academy_trial_invalid';end if;
  if enabled_value and not ((parts->>'lms')::boolean or (parts->>'website')::boolean or (parts->>'store')::boolean) then raise exception 'academy_component_required';end if;
  if enabled_value and until_at is null and (((parts->>'lms')::boolean and not private_app.tenant_addon_enabled(t,'addon.training.lms')) or ((parts->>'website')::boolean and not private_app.tenant_addon_enabled(t,'module.website_cms')) or ((parts->>'store')::boolean and not (private_app.tenant_addon_enabled(t,'addon.training.lms') and private_app.tenant_addon_enabled(t,'module.website_cms')))) then raise exception 'academy_subscription_required';end if;
  insert into academy.platform_settings(tenant_id,enabled,mode,lms_enabled,website_enabled,store_enabled,access_until,updated_by_subject_id)
  values(t,enabled_value,mode_value,(parts->>'lms')::boolean,(parts->>'website')::boolean,(parts->>'store')::boolean,until_at,actor)
  on conflict(tenant_id) do update set enabled=excluded.enabled,mode=excluded.mode,lms_enabled=excluded.lms_enabled,website_enabled=excluded.website_enabled,store_enabled=excluded.store_enabled,access_until=excluded.access_until,version=academy.platform_settings.version+1,updated_by_subject_id=actor,updated_at=now();
 elsif p_action in ('set_member','issue_invitation') then
  if not private_app.has_platform_permission('platform.access.manage') then raise exception 'forbidden' using errcode='42501';end if;
  email_value:=lower(trim(p_payload->>'email'));role_value:=p_payload->>'role';
  if email_value is null or length(email_value)>254 or email_value!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or role_value is null or role_value not in ('manager','website_editor','instructor') then raise exception 'academy_member_invalid';end if;
  if p_action='set_member' then
   if p_payload->>'status' is null or p_payload->>'status' not in ('active','suspended') then raise exception 'academy_member_invalid';end if;
   select s.id into target from access_control.subjects s join auth.users u on u.id=s.auth_user_id where lower(trim(u.email))=email_value and lower(trim(s.email))=email_value and u.email_confirmed_at is not null and s.status='active' and not s.must_change_password;
   if target is null then raise exception 'academy_verified_account_required';end if;
   insert into academy.platform_memberships(tenant_id,subject_id,role_key,status,created_by_subject_id) values(t,target,role_value,p_payload->>'status',actor)
   on conflict(tenant_id,subject_id) do update set role_key=excluded.role_key,status=excluded.status,updated_at=now();
   update academy.platform_invitations set status='revoked' where tenant_id=t and email=email_value and status='pending';
  else
   expiry:=coalesce(nullif(p_payload->>'expiresAt','')::timestamptz,now()+interval '7 days');
   if expiry<now()+interval '5 minutes' or expiry>now()+interval '7 days' or coalesce(p_payload->>'tokenHash','')!~'^[0-9a-f]{64}$' then raise exception 'academy_invitation_invalid';end if;
   update academy.platform_invitations set status='revoked' where tenant_id=t and email=email_value and status='pending';
   insert into academy.platform_invitations(tenant_id,email,role_key,token_hash,expires_at,invited_by_subject_id) values(t,email_value,role_value,p_payload->>'tokenHash',expiry,actor);
  end if;
 else raise exception 'academy_unknown_action';end if;
 result:=jsonb_build_object('before',before_state,'after',private_app.academy_platform_config_v1(t),'commandId',p_command_id);
 insert into academy.platform_commands(tenant_id,command_id,actor_subject_id,action,payload,response) values(t,p_command_id,actor,p_action,p_payload,result);
 return result;
end $$;

create function public.v1_academy_membership_accept(p_slug text,p_token_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare inv academy.platform_invitations%rowtype;subject uuid;email_value text;confirmed timestamptz;
begin
 if auth.uid() is null then raise exception 'authentication_required' using errcode='42501';end if;
 select * into inv from academy.platform_invitations where token_hash=p_token_hash for update;
 select lower(trim(email)),email_confirmed_at into email_value,confirmed from auth.users where id=auth.uid();
 if inv.id is null or confirmed is null or inv.email is distinct from email_value
 or not exists(select 1 from core.tenants t where t.id=inv.tenant_id and t.slug=p_slug and t.slug='marktone' and t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.status in ('trial','active')) then raise exception 'academy_invitation_invalid';end if;
 if inv.status='accepted' then
  if exists(select 1 from access_control.subjects s join academy.platform_memberships m on m.subject_id=s.id and m.tenant_id=inv.tenant_id
   where s.id=inv.accepted_by_subject_id and s.auth_user_id=auth.uid() and s.status='active' and not s.must_change_password and m.status='active' and m.role_key=inv.role_key)
  then return jsonb_build_object('tenantId',inv.tenant_id,'slug',p_slug,'role',inv.role_key);end if;
  raise exception 'academy_invitation_invalid';
 end if;
 if inv.status<>'pending' or inv.expires_at<=now() then raise exception 'academy_invitation_invalid';end if;
 insert into access_control.subjects(auth_user_id,email,full_name,status,must_change_password) values(auth.uid(),email_value,split_part(email_value,'@',1),'active',false) on conflict(auth_user_id) do nothing;
 select id into subject from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password and lower(trim(email))=email_value;
 if subject is null then raise exception 'academy_account_inactive';end if;
 insert into academy.platform_memberships(tenant_id,subject_id,role_key,status,created_by_subject_id) values(inv.tenant_id,subject,inv.role_key,'active',inv.invited_by_subject_id)
 on conflict(tenant_id,subject_id) do update set role_key=excluded.role_key,status='active',updated_at=now();
 update academy.platform_invitations set status='accepted',accepted_at=now(),accepted_by_subject_id=subject where id=inv.id;
 return jsonb_build_object('tenantId',inv.tenant_id,'slug',p_slug,'role',inv.role_key);
end $$;

-- Learning/CMS scoped adapters follow. Existing global ACL helpers are unchanged.
create function public.v1_academy_invitation_preview(p_slug text,p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if coalesce(p_token_hash,'')!~'^[0-9a-f]{64}$' then raise exception 'academy_invitation_invalid';end if;
 select jsonb_build_object('tenantId',t.id,'slug',t.slug,'tenantName',t.name,'email',i.email,'role',i.role_key,'expiresAt',i.expires_at)
 into result from academy.platform_invitations i join core.tenants t on t.id=i.tenant_id
 where i.token_hash=p_token_hash and i.status='pending' and i.expires_at>now()
 and t.slug=p_slug and t.slug='marktone' and t.id='3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid and t.status in ('trial','active');
 if result is null then raise exception 'academy_invitation_invalid';end if;
 return result;
end $$;
CREATE OR REPLACE FUNCTION private_app.training_is_instructor_v1(p_tenant_id uuid, p_run_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select auth.uid() is not null and exists(select 1 from academy.training_run_instructors i join access_control.subjects actor on actor.id=i.subject_id and actor.status='active' and not actor.must_change_password where i.tenant_id=p_tenant_id and i.run_id=p_run_id and i.subject_id=private_app.current_subject_id() and i.active and (exists(select 1 from access_control.memberships m where m.tenant_id=i.tenant_id and m.subject_id=i.subject_id and m.scope='tenant' and m.status='active') or (private_app.academy_platform_enabled_v1(i.tenant_id,'lms') and exists(select 1 from academy.platform_memberships am where am.tenant_id=i.tenant_id and am.subject_id=i.subject_id and am.status='active' and am.role_key in ('manager','instructor')))))
$function$;


CREATE OR REPLACE FUNCTION public.v1_academy_training_action(p_slug text, p_action text, p_command_id uuid, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
 t uuid;s uuid;v_cached jsonb;v_response jsonb;v_course uuid;v_version uuid;v_num int;v_i int;v_n int;v_correct int;v_score numeric;v_passed boolean;v_q jsonb;v_item jsonb;v_policy jsonb;
 e academy.enrollments%rowtype;v academy.training_course_versions%rowtype;u academy.training_units%rowtype;
 inv academy.training_invitations%rowtype;sub academy.training_submissions%rowtype;v_student academy.students%rowtype;
 v_email text;v_confirmed timestamptz;v_expiry timestamptz;v_id uuid;v_subject uuid;v_finance jsonb;v_eligibility jsonb;v_before jsonb;
begin
 if auth.uid() is null then raise exception 'authentication_required';end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>1048576 then raise exception 'training_invalid_payload';end if;
 if p_command_id is null then raise exception 'training_command_required';end if;
 -- Invitation proof is the sole bootstrap path for a new learner subject.
 if p_action='accept_invitation' then
  select * into inv from academy.training_invitations where token_hash=p_payload->>'tokenHash' for update;
  select lower(trim(email)),email_confirmed_at into v_email,v_confirmed from auth.users where id=auth.uid();
  if inv.id is null or inv.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid or p_slug<>'marktone' or inv.expires_at<=now() or inv.status='revoked' or v_email is distinct from inv.email or v_confirmed is null then raise exception 'training_invitation_invalid';end if;
  select * into v_student from academy.students where tenant_id=inv.tenant_id and id=inv.student_id;
  if v_student.id is null or v_student.status not in ('active','graduated') or lower(trim(v_student.email)) is distinct from inv.email then raise exception 'training_invitation_invalid';end if;
  insert into access_control.subjects(auth_user_id,email,full_name,status,must_change_password) values(auth.uid(),v_email,v_student.full_name,'active',false) on conflict(auth_user_id) do nothing;
  select id into s from access_control.subjects where auth_user_id=auth.uid() and status='active' and not must_change_password and lower(email)=v_email;
  if s is null then raise exception 'training_subject_inactive';end if;
 end if;
 t:=private_app.academy_training_tenant_v1(p_slug);s:=private_app.current_subject_id();
 if s is null then raise exception 'authentication_required';end if;
 if p_action in ('save_draft','publish_version','assign_version','assign_instructor','issue_invitation','issue_certificate') then
  if not private_app.academy_has_permission_v1(t,'manageLearning') then raise exception 'training_permission_denied';end if;
 elsif p_action in ('open_unit','complete_unit','submit_quiz','submit_assignment') then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'training_permission_denied';end if;
  if e.status not in ('confirmed','active','completed') then raise exception 'training_enrollment_inactive';end if;
  select unit.* into u from academy.training_enrollment_versions ev join academy.training_units unit on unit.tenant_id=ev.tenant_id and unit.version_id=ev.version_id where ev.tenant_id=t and ev.enrollment_id=e.id and unit.id=(p_payload->>'unitId')::uuid;
  if u.id is null then raise exception 'training_unit_not_found';end if;
  v_finance:=private_app.training_journey_financial_access_v1(e.id);
  if not coalesce((v_finance->>'trainingAllowed')::boolean,false) and not (p_action='open_unit' and exists(select 1 from academy.training_unit_progress where tenant_id=t and enrollment_id=e.id and unit_id=u.id and completed_at is not null)) then raise exception 'training_financial_access_suspended';end if;
  if exists(select 1 from academy.training_units prior where prior.tenant_id=t and prior.version_id=u.version_id and prior.position<u.position and prior.required and not exists(select 1 from academy.training_unit_progress p where p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=prior.id and p.completed_at is not null)) then raise exception 'training_previous_units_required';end if;
 elsif p_action='grade_assignment' then
  select * into sub from academy.training_submissions where tenant_id=t and id=(p_payload->>'submissionId')::uuid;
  select * into e from academy.enrollments where tenant_id=t and id=sub.enrollment_id for update;
  if e.id is null or not private_app.training_is_instructor_v1(t,e.course_run_id) then raise exception 'training_instructor_assignment_required';end if;
 elsif p_action='create_request' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not private_app.training_is_learner_v1(t,e.id) then raise exception 'training_permission_denied';end if;
 elsif p_action='record_attendance' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null or not(private_app.training_is_instructor_v1(t,e.course_run_id) or private_app.academy_has_permission_v1(t,'manageLearning')) then raise exception 'training_permission_denied';end if;
 elsif p_action<>'accept_invitation' then raise exception 'training_unknown_action';end if;
 v_cached:=private_app.training_journey_command_v1(t,p_command_id,'learning.'||p_action,p_payload);
 if v_cached is not null then return v_cached;end if;

 if p_action='save_draft' then
  v_course:=(p_payload->>'courseId')::uuid;
  perform 1 from academy.courses where tenant_id=t and id=v_course for update;
  if not found then raise exception 'training_course_not_found';end if;
  if jsonb_typeof(p_payload->'units') is distinct from 'array' or jsonb_array_length(p_payload->'units') not between 1 and 100 then raise exception 'training_units_required';end if;
  v_version:=nullif(p_payload->>'versionId','')::uuid;
  if v_version is null then
   select coalesce(max(version),0)+1 into v_num from academy.training_course_versions where tenant_id=t and course_id=v_course;
   insert into academy.training_course_versions(tenant_id,course_id,version,title,learning_mode,policy,created_by_subject_id) values(t,v_course,v_num,trim(p_payload->>'title'),p_payload->>'learningMode',coalesce(p_payload->'policy','{}'),s) returning id into v_version;
  else
   select * into v from academy.training_course_versions where tenant_id=t and id=v_version and course_id=v_course for update;
   if v.id is null or v.status<>'draft' then raise exception 'training_draft_required';end if;
   update academy.training_course_versions set title=trim(p_payload->>'title'),learning_mode=p_payload->>'learningMode',policy=coalesce(p_payload->'policy','{}'),updated_at=now() where tenant_id=t and id=v_version;
   delete from academy.training_units where tenant_id=t and version_id=v_version;
  end if;
  v_i:=0;
  for v_item in select value from jsonb_array_elements(p_payload->'units') loop
   v_i:=v_i+1;
   insert into academy.training_units(tenant_id,version_id,position,title,kind,required,minimum_seconds,body,url,questions,max_attempts,pass_percent) values(t,v_version,v_i,trim(v_item->>'title'),v_item->>'kind',coalesce((v_item->>'required')::boolean,true),coalesce((v_item->>'minimumSeconds')::int,0),coalesce(v_item->>'body',''),nullif(v_item->>'url',''),coalesce(v_item->'questions','[]'),coalesce((v_item->>'maxAttempts')::int,3),coalesce((v_item->>'passPercent')::numeric,70));
  end loop;
  perform private_app.training_learning_event_v1(t,null,'draft_saved',jsonb_build_object('id',v_version,'courseId',v_course));
  v_response:=jsonb_build_object('versionId',v_version);
 elsif p_action='publish_version' then
  select * into v from academy.training_course_versions where tenant_id=t and id=(p_payload->>'versionId')::uuid for update;
  if v.id is null or v.status<>'draft' then raise exception 'training_draft_required';end if;
  if p_payload->'humanReviewed' is distinct from 'true'::jsonb then raise exception 'training_human_review_required';end if;
  v_policy:=v.policy;
  if jsonb_typeof(v_policy->'minAttendancePercent') is distinct from 'number' or jsonb_typeof(v_policy->'minAssessmentPercent') is distinct from 'number' or not(v_policy?'minAttendancePercent' and v_policy?'minAssessmentPercent' and v_policy?'requireCompletedRun' and v_policy?'certificateEnabled') or (v_policy->>'minAttendancePercent')::numeric not between 0 and 100 or (v_policy->>'minAssessmentPercent')::numeric not between 0 and 100 or jsonb_typeof(v_policy->'requireCompletedRun')<>'boolean' or jsonb_typeof(v_policy->'certificateEnabled')<>'boolean' or length(trim(coalesce(v_policy->>'termsVersion','')))<2 or coalesce(v_policy->>'supportEmail','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'training_policy_review_required';end if;
  if not exists(select 1 from academy.training_units where tenant_id=t and version_id=v.id and required and kind in ('quiz','assignment')) then raise exception 'training_assessment_required';end if;
  for u in select * from academy.training_units where tenant_id=t and version_id=v.id loop
   if u.kind in ('text','assignment') and length(trim(u.body))<2 then raise exception 'training_unit_content_required';end if;
   if u.kind in ('video','link') and u.url is null then raise exception 'training_unit_url_required';end if;
   if u.kind='quiz' then
    if jsonb_array_length(u.questions)=0 then raise exception 'training_quiz_questions_required';end if;
    if (select count(distinct q->>'id') from jsonb_array_elements(u.questions)q)<>jsonb_array_length(u.questions) then raise exception 'training_quiz_question_ids_invalid';end if;
    for v_q in select value from jsonb_array_elements(u.questions) loop
     if coalesce(v_q->>'id','') !~ '^[a-zA-Z0-9_-]{1,64}$' or length(trim(coalesce(v_q->>'prompt','')))<2 or length(v_q->>'prompt')>2000 or jsonb_typeof(v_q->'options') is distinct from 'array' then raise exception 'training_quiz_question_invalid';end if;
     if jsonb_typeof(v_q->'correctOptionIndex') is distinct from 'number' or coalesce(v_q->>'correctOptionIndex','') !~ '^[0-9]+$' or jsonb_array_length(v_q->'options') not between 2 and 8 or (v_q->>'correctOptionIndex')::int not between 0 and jsonb_array_length(v_q->'options')-1 or not(v_q?'correctOptionIndex') or exists(select 1 from jsonb_array_elements(v_q->'options')x where jsonb_typeof(x)<>'string' or length(trim(x#>>'{}')) not between 1 and 2000) then raise exception 'training_quiz_options_invalid';end if;
    end loop;
   end if;
  end loop;
  update academy.training_course_versions set status='published',reviewed_by_subject_id=s,published_at=now(),updated_at=now() where tenant_id=t and id=v.id;
  perform private_app.training_learning_event_v1(t,null,'version_published',jsonb_build_object('id',v.id,'courseId',v.course_id,'policy',v.policy));
  v_response:=jsonb_build_object('versionId',v.id,'status','published');
 elsif p_action='assign_version' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null then raise exception 'training_enrollment_not_found';end if;
  v_version:=(p_payload->>'versionId')::uuid;
  if exists(select 1 from academy.training_enrollment_versions where tenant_id=t and enrollment_id=e.id and version_id<>v_version) then raise exception 'training_enrollment_version_immutable';end if;
  insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(t,e.id,v_version,s) on conflict(tenant_id,enrollment_id) do nothing;
  perform private_app.training_learning_event_v1(t,e.id,'version_assigned',jsonb_build_object('versionId',v_version));
  v_response:=jsonb_build_object('enrollmentId',e.id,'versionId',v_version);
 elsif p_action='assign_instructor' then
  v_id:=(p_payload->>'runId')::uuid;v_subject:=(p_payload->>'subjectId')::uuid;
  if not exists(select 1 from academy.course_runs where tenant_id=t and id=v_id) or not exists(select 1 from access_control.subjects a where a.id=v_subject and a.status='active' and not a.must_change_password and (exists(select 1 from access_control.memberships m where m.subject_id=a.id and m.tenant_id=t and m.status='active' and m.scope='tenant') or exists(select 1 from academy.platform_memberships am where am.tenant_id=t and am.subject_id=a.id and am.status='active' and am.role_key in ('manager','instructor')))) then raise exception 'training_instructor_subject_invalid';end if;
  insert into academy.training_run_instructors(tenant_id,run_id,subject_id,active,assigned_by_subject_id) values(t,v_id,v_subject,coalesce((p_payload->>'active')::boolean,true),s) on conflict(tenant_id,run_id,subject_id) do update set active=excluded.active,assigned_by_subject_id=s,assigned_at=now();
  perform private_app.training_learning_event_v1(t,null,'instructor_assigned',jsonb_build_object('runId',v_id,'subjectId',v_subject,'active',coalesce((p_payload->>'active')::boolean,true)));
  v_response:=jsonb_build_object('runId',v_id,'subjectId',v_subject);
 elsif p_action='issue_invitation' then
  select * into v_student from academy.students where tenant_id=t and id=(p_payload->>'studentId')::uuid for update;
  v_email:=lower(trim(p_payload->>'email'));
  if v_student.id is null or v_student.status not in ('active','graduated') or v_email is distinct from lower(trim(v_student.email)) or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'training_student_email_mismatch';end if;
  v_expiry:=coalesce(nullif(p_payload->>'expiresAt','')::timestamptz,now()+interval '7 days');
  if v_expiry not between now()+interval '5 minutes' and now()+interval '7 days' then raise exception 'training_invitation_expiry_invalid';end if;
  if exists(select 1 from academy.training_learner_accounts where tenant_id=t and student_id=v_student.id) then raise exception 'training_student_already_linked';end if;
  update academy.training_invitations set status='revoked' where tenant_id=t and student_id=v_student.id and status='pending';
  insert into academy.training_invitations(tenant_id,student_id,email,token_hash,expires_at,invited_by_subject_id,auth_mode) values(t,v_student.id,v_email,p_payload->>'tokenHash',v_expiry,s,'confirmed_email') returning id into v_id;
  perform private_app.training_learning_event_v1(t,null,'invitation_created',jsonb_build_object('id',v_id,'studentId',v_student.id));
  v_response:=jsonb_build_object('invitationId',v_id,'expiresAt',v_expiry);
 elsif p_action='accept_invitation' then
  if inv.status<>'pending' then raise exception 'training_invitation_already_used';end if;
  insert into academy.training_learner_accounts(tenant_id,student_id,subject_id) values(t,inv.student_id,s);
  update academy.training_invitations set status='accepted',accepted_by_subject_id=s,accepted_at=now(),activation_claim_id=null,activation_claim_expires_at=null where id=inv.id;
  perform private_app.training_learning_event_v1(t,null,'learner_bound',jsonb_build_object('studentId',inv.student_id));
  v_response:=jsonb_build_object('studentId',inv.student_id,'tenantSlug',p_slug);
 elsif p_action='open_unit' then
  insert into academy.training_unit_progress(tenant_id,enrollment_id,version_id,unit_id) values(t,e.id,u.version_id,u.id) on conflict(tenant_id,enrollment_id,unit_id) do update set last_opened_at=now();
  perform private_app.training_learning_event_v1(t,e.id,'unit_opened',jsonb_build_object('unitId',u.id));
  v_response:=jsonb_build_object('unit',jsonb_build_object('id',u.id,'title',u.title,'kind',u.kind,'body',u.body,'url',u.url,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent,'questions',coalesce((select jsonb_agg(jsonb_build_object('id',q->>'id','prompt',q->>'prompt','options',q->'options')) from jsonb_array_elements(u.questions)q),'[]'::jsonb)));
 elsif p_action in ('complete_unit','submit_quiz','submit_assignment') then
  if not exists(select 1 from academy.training_unit_progress where tenant_id=t and enrollment_id=e.id and unit_id=u.id and opened_at<=now()-make_interval(secs=>u.minimum_seconds)) then raise exception 'training_unit_review_required';end if;
  if p_action='complete_unit' then
   if u.kind not in ('text','video','link') then raise exception 'training_unit_requires_assessment';end if;
   update academy.training_unit_progress set completed_at=coalesce(completed_at,now()),completed_by_subject_id=s where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   perform private_app.training_learning_event_v1(t,e.id,'unit_completed',jsonb_build_object('unitId',u.id,'evidenceType','learner_acknowledgement','minimumSeconds',u.minimum_seconds));
   v_response:=jsonb_build_object('unitId',u.id,'completed',true);
  elsif p_action='submit_quiz' then
   if u.kind<>'quiz' or jsonb_typeof(p_payload->'answers') is distinct from 'object' then raise exception 'training_quiz_answers_invalid';end if;
   select count(*)+1 into v_num from academy.training_quiz_attempts where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   if v_num>u.max_attempts then raise exception 'training_attempts_exhausted';end if;
   v_correct:=0;v_n:=jsonb_array_length(u.questions);
   if (select count(*) from jsonb_object_keys(p_payload->'answers'))<>v_n then raise exception 'training_quiz_answers_invalid';end if;
   for v_q in select value from jsonb_array_elements(u.questions) loop
    if not(p_payload->'answers' ? (v_q->>'id')) or jsonb_typeof(p_payload->'answers'->(v_q->>'id'))<>'number' or (p_payload->'answers'->>(v_q->>'id')) !~ '^[0-9]+$' then raise exception 'training_quiz_answers_invalid';end if;
    v_i:=(p_payload->'answers'->>(v_q->>'id'))::int;
    if v_i not between 0 and jsonb_array_length(v_q->'options')-1 then raise exception 'training_quiz_answers_invalid';end if;
    if v_i=(v_q->>'correctOptionIndex')::int then v_correct:=v_correct+1;end if;
   end loop;
   v_score:=round(v_correct*100.0/v_n,2);v_passed:=v_score>=u.pass_percent;
   insert into academy.training_quiz_attempts(tenant_id,enrollment_id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id) values(t,e.id,u.version_id,u.id,v_num,p_payload->'answers',v_score,v_passed,s);
   if v_passed then update academy.training_unit_progress set completed_at=coalesce(completed_at,now()),completed_by_subject_id=s where tenant_id=t and enrollment_id=e.id and unit_id=u.id;end if;
   perform private_app.training_reconcile_assessment_v1(t,e.id);
   perform private_app.training_learning_event_v1(t,e.id,'quiz_submitted',jsonb_build_object('unitId',u.id,'score',v_score,'passed',v_passed,'attempt',v_num));
   v_response:=jsonb_build_object('score',v_score,'passed',v_passed,'attempt',v_num);
  else
   if u.kind<>'assignment' then raise exception 'training_assignment_required';end if;
   if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
   select count(*)+1 into v_num from academy.training_submissions where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   if v_num>u.max_attempts then raise exception 'training_attempts_exhausted';end if;
   insert into academy.training_submissions(tenant_id,enrollment_id,version_id,unit_id,attempt,body,submitted_by_subject_id) values(t,e.id,u.version_id,u.id,v_num,trim(p_payload->>'body'),s) returning id into v_id;
   update academy.training_unit_progress set completed_at=null,completed_by_subject_id=null where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
   perform private_app.training_learning_event_v1(t,e.id,'assignment_submitted',jsonb_build_object('submissionId',v_id,'unitId',u.id));
   v_response:=jsonb_build_object('submissionId',v_id);
  end if;
 elsif p_action='grade_assignment' then
  if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
  if exists(select 1 from academy.training_submissions where tenant_id=t and enrollment_id=e.id and unit_id=sub.unit_id and attempt>sub.attempt) then raise exception 'training_latest_submission_required';end if;
  select * into u from academy.training_units where tenant_id=t and id=sub.unit_id;
  v_score:=(p_payload->>'score')::numeric;
  insert into academy.training_grades(tenant_id,submission_id,score,feedback,graded_by_subject_id) values(t,sub.id,v_score,trim(p_payload->>'feedback'),s) returning id into v_id;
  update academy.training_unit_progress set completed_at=case when v_score>=u.pass_percent then now() end,completed_by_subject_id=case when v_score>=u.pass_percent then s end where tenant_id=t and enrollment_id=e.id and unit_id=u.id;
  perform private_app.training_reconcile_assessment_v1(t,e.id);
  perform private_app.training_learning_event_v1(t,e.id,'assignment_graded',jsonb_build_object('gradeId',v_id,'submissionId',sub.id,'score',v_score));
  v_response:=jsonb_build_object('gradeId',v_id,'score',v_score,'passed',v_score>=u.pass_percent);
 elsif p_action='create_request' then
  if p_payload->>'kind' not in ('transfer','defer','resume','withdraw') then raise exception 'training_request_kind_invalid';end if;
  if exists(select 1 from academy.platform_settings where tenant_id=t and mode='standalone') then
   v_response:=private_app.academy_request_create_v1(t,e.id,p_payload->>'kind',p_payload->>'reason',nullif(p_payload->>'targetRunId','')::uuid);
  else v_response:=private_app.training_journey_request_v1(t,e.id,p_payload->>'kind',p_payload->>'reason',nullif(p_payload->>'targetRunId','')::uuid);end if;
 elsif p_action='record_attendance' then
  if exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_certificate_already_issued';end if;
  if not exists(select 1 from academy.course_run_sessions where tenant_id=t and course_run_id=e.course_run_id and id=(p_payload->>'sessionId')::uuid and status<>'cancelled') then raise exception 'training_session_not_found';end if;
  if length(trim(coalesce(p_payload->>'reason',''))) not between 3 and 2000 then raise exception 'training_attendance_reason_required';end if;
  select to_jsonb(a) into v_before from academy.attendance_records a where tenant_id=t and enrollment_id=e.id and session_id=(p_payload->>'sessionId')::uuid;
  insert into academy.attendance_records(tenant_id,course_run_id,session_id,enrollment_id,status,minutes_late,notes,marked_by_subject_id,metadata) values(t,e.course_run_id,(p_payload->>'sessionId')::uuid,e.id,p_payload->>'status',coalesce((p_payload->>'minutesLate')::int,0),p_payload->>'reason',s,jsonb_build_object('source','training_journey_manual')) on conflict(enrollment_id,session_id) do update set status=excluded.status,minutes_late=excluded.minutes_late,notes=excluded.notes,marked_by_subject_id=s,marked_at=now();
  perform private_app.training_learning_event_v1(t,e.id,'attendance_recorded',jsonb_build_object('sessionId',p_payload->>'sessionId','before',v_before,'status',p_payload->>'status','reason',p_payload->>'reason'));
  v_response:=jsonb_build_object('recorded',true);
 elsif p_action='issue_certificate' then
  select * into e from academy.enrollments where tenant_id=t and id=(p_payload->>'enrollmentId')::uuid for update;
  if e.id is null then raise exception 'training_enrollment_not_found';end if;
  v_eligibility:=private_app.training_learning_eligibility_v1(e.id);
  if v_eligibility is null or not coalesce((v_eligibility->>'eligible')::boolean,false) then raise exception 'training_certificate_not_eligible';end if;
  select id into v_id from academy.certificates where tenant_id=t and enrollment_id=e.id;
  if v_id is not null then raise exception 'training_certificate_already_exists';end if;
  v_id:=gen_random_uuid();
  insert into academy.certificates(id,tenant_id,course_run_id,enrollment_id,certificate_number,verification_code,issued_by_subject_id,metadata) values(v_id,t,e.course_run_id,e.id,'TR-'||upper(replace(v_id::text,'-','')),replace(gen_random_uuid()::text,'-',''),s,jsonb_build_object('trainingJourneyEvidence',v_eligibility-'financialAccess'));
  update academy.enrollments set status='completed' where tenant_id=t and id=e.id;
  perform private_app.training_learning_event_v1(t,e.id,'certificate_issued',jsonb_build_object('certificateId',v_id,'versionId',v_eligibility->>'versionId'));
  v_response:=jsonb_build_object('certificateId',v_id);
 end if;
 return private_app.training_journey_complete_command_v1(t,p_command_id,v_response);
end $function$;


CREATE OR REPLACE FUNCTION public.v1_academy_training_snapshot(p_slug text, p_role text DEFAULT 'manager'::text, p_enrollment_id uuid DEFAULT NULL::uuid, p_course_id uuid DEFAULT NULL::uuid, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare t uuid;s uuid;v_courses jsonb;v_enrollments jsonb;v_submissions jsonb;v_instructors jsonb:='[]';v_candidates jsonb:='[]';v_requests jsonb:='[]';v_available_runs jsonb:='[]';v_total int;v_course_total int;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);s:=private_app.current_subject_id();
 if s is null or p_role not in ('learner','manager','instructor') or p_offset not between 0 and 100000 then raise exception 'training_permission_denied';end if;
 if p_role='manager' and not private_app.academy_has_permission_v1(t,'manageLearning') then raise exception 'training_permission_denied';end if;
 if p_role='learner' and not exists(select 1 from academy.training_learner_accounts a where a.tenant_id=t and a.subject_id=s and a.status='active') then raise exception 'training_learner_binding_required';end if;
 if p_role='instructor' and not exists(select 1 from academy.training_run_instructors i where i.tenant_id=t and i.subject_id=s and i.active and private_app.training_is_instructor_v1(t,i.run_id)) then raise exception 'training_instructor_assignment_required';end if;
 if p_enrollment_id is not null and not exists(select 1 from academy.enrollments e where e.tenant_id=t and e.id=p_enrollment_id and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))) then raise exception 'training_permission_denied';end if;
 select coalesce(jsonb_agg(x.row),'[]') into v_courses from (
 select jsonb_build_object('id',c.id,'title',c.title_ar,'status',c.status,'versions',coalesce((
  select jsonb_agg(vr.row order by vr.version desc) from (
   select v.version,jsonb_build_object('id',v.id,'version',v.version,'title',v.title,'status',v.status,'learningMode',v.learning_mode,'policy',v.policy,'publishedAt',v.published_at,'units',coalesce((
    select jsonb_agg(jsonb_build_object('id',u.id,'position',u.position,'title',u.title,'kind',u.kind,'required',u.required,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent)||case when p_role='manager' then jsonb_build_object('body',u.body,'url',u.url,'questions',u.questions) else '{}'::jsonb end order by u.position) from academy.training_units u where u.tenant_id=t and u.version_id=v.id and p_role='manager' and p_course_id=c.id and v.version=(select max(latest.version) from academy.training_course_versions latest where latest.tenant_id=t and latest.course_id=c.id)
   ),'[]')) row from academy.training_course_versions v where v.tenant_id=t and v.course_id=c.id and (p_role='manager' or (v.status='published' and exists(select 1 from academy.training_enrollment_versions ev join academy.enrollments e on e.tenant_id=ev.tenant_id and e.id=ev.enrollment_id where ev.tenant_id=t and ev.version_id=v.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))))) order by v.version desc limit 10
  ) vr
 ),'[]')) row from academy.courses c where c.tenant_id=t and (p_course_id is null or c.id=p_course_id) and (p_role='manager' or exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=c.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))))) order by c.title_ar,c.id limit 50 offset p_offset
 ) x;
 select count(*) into v_course_total from academy.courses c where c.tenant_id=t and (p_course_id is null or c.id=p_course_id) and (p_role='manager' or exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=c.id and ((p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)))));
 select count(*) into v_total from academy.enrollments e where e.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id)));
 select coalesce(jsonb_agg(x.row),'[]') into v_enrollments from (
 select jsonb_build_object('id',e.id,'studentId',e.student_id,'studentName',st.full_name,'studentEmail',st.email,'courseId',e.course_id,'courseTitle',coalesce(v.title,c.title_ar),'runId',e.course_run_id,'runTitle',coalesce(r.title,r.run_code),'status',e.status,'deferred',coalesce((e.metadata->>'trainingJourneyDeferred')::boolean,false),'versionId',ev.version_id,'policy',v.policy,'learningMode',v.learning_mode,'financialAccess',f.access,'eligibility',case when ev.version_id is not null then private_app.training_learning_eligibility_v1(e.id)||jsonb_build_object('financialAccess',f.access) end,
 'progress',(select jsonb_build_object('completedUnits',count(*) filter(where p.completed_at is not null),'totalUnits',count(*),'percent',case when count(*)=0 then 0 else round(100.0*count(*) filter(where p.completed_at is not null)/count(*),0) end) from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=u.id where u.tenant_id=t and u.version_id=ev.version_id and u.required),
 'units',coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'title',u.title,'kind',u.kind,'position',u.position,'required',u.required,'minimumSeconds',u.minimum_seconds,'maxAttempts',u.max_attempts,'passPercent',u.pass_percent,'completedAt',p.completed_at,'score',case when u.kind='quiz' then (select max(a.score) from academy.training_quiz_attempts a where a.tenant_id=t and a.enrollment_id=e.id and a.unit_id=u.id) else (select g.score from academy.training_submissions sub join academy.training_grades g on g.tenant_id=t and g.submission_id=sub.id where sub.tenant_id=t and sub.enrollment_id=e.id and sub.unit_id=u.id order by sub.attempt desc,g.graded_at desc,g.id desc limit 1) end,'attemptCount',case when u.kind='quiz' then (select count(*) from academy.training_quiz_attempts a where a.tenant_id=t and a.enrollment_id=e.id and a.unit_id=u.id) when u.kind='assignment' then (select count(*) from academy.training_submissions sub where sub.tenant_id=t and sub.enrollment_id=e.id and sub.unit_id=u.id) else 0 end) order by u.position) from academy.training_units u left join academy.training_unit_progress p on p.tenant_id=t and p.enrollment_id=e.id and p.unit_id=u.id where u.tenant_id=t and u.version_id=ev.version_id),'[]'),
 'sessions',coalesce((select jsonb_agg(sx.row order by sx.starts_at) from (select sess.starts_at,jsonb_build_object('id',sess.id,'title',sess.title,'startsAt',sess.starts_at,'endsAt',sess.ends_at,'status',sess.status,'joinUrl',case when p_role<>'learner' or coalesce((f.access->>'trainingAllowed')::boolean,false) then coalesce(sess.meeting_join_url,sess.venue_or_link) end,'attendance',(select ar.status from academy.attendance_records ar where ar.tenant_id=t and ar.enrollment_id=e.id and ar.session_id=sess.id)) row from academy.course_run_sessions sess where sess.tenant_id=t and sess.course_run_id=e.course_run_id order by sess.starts_at limit 100) sx),'[]'),
 'certificate',(select jsonb_build_object('id',cert.id,'number',cert.certificate_number,'verificationCode',cert.verification_code,'status',cert.status,'issuedAt',cert.issued_at) from academy.certificates cert where cert.tenant_id=t and cert.enrollment_id=e.id),
 'learnerLinked',exists(select 1 from academy.training_learner_accounts la where la.tenant_id=t and la.student_id=e.student_id and la.status='active')) row
 from academy.enrollments e join academy.students st on st.tenant_id=t and st.id=e.student_id join academy.courses c on c.tenant_id=t and c.id=e.course_id join academy.course_runs r on r.tenant_id=t and r.id=e.course_run_id left join academy.training_enrollment_versions ev on ev.tenant_id=t and ev.enrollment_id=e.id left join academy.training_course_versions v on v.tenant_id=t and v.id=ev.version_id cross join lateral(select private_app.training_financial_projection_v1(t,e.id,p_role) access)f
 where e.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by e.enrolled_at desc,e.id limit 50 offset p_offset
 ) x;
 select coalesce(jsonb_agg(x.row),'[]') into v_submissions from (
 select jsonb_build_object('id',sub.id,'enrollmentId',sub.enrollment_id,'studentName',st.full_name,'unitId',sub.unit_id,'unitTitle',u.title,'body',sub.body,'attempt',sub.attempt,'submittedAt',sub.submitted_at,'grade',(select jsonb_build_object('score',g.score,'feedback',g.feedback,'gradedAt',g.graded_at) from academy.training_grades g where g.tenant_id=t and g.submission_id=sub.id order by g.graded_at desc,g.id desc limit 1)) row from academy.training_submissions sub join academy.enrollments e on e.tenant_id=t and e.id=sub.enrollment_id join academy.students st on st.tenant_id=t and st.id=e.student_id join academy.training_units u on u.tenant_id=t and u.id=sub.unit_id where sub.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_course_id is null or e.course_id=p_course_id) and (p_role='manager' or (p_role='instructor' and private_app.training_is_instructor_v1(t,e.course_run_id)) or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by sub.submitted_at desc,sub.id limit 100
 )x;
 if p_role in ('manager','instructor') then
  select coalesce(jsonb_agg(x.row),'[]') into v_instructors from (select jsonb_build_object('runId',i.run_id,'subjectId',i.subject_id,'name',a.full_name,'active',i.active) row from academy.training_run_instructors i join access_control.subjects a on a.id=i.subject_id where i.tenant_id=t and (p_role='manager' or i.subject_id=s) order by i.assigned_at desc limit 100)x;
 end if;
 if p_role='manager' then
  select coalesce(jsonb_agg(x.row),'[]') into v_candidates from (select distinct jsonb_build_object('subjectId',a.id,'name',a.full_name) row from access_control.subjects a where a.status='active' and not a.must_change_password and (exists(select 1 from access_control.memberships m where m.subject_id=a.id and m.tenant_id=t and m.status='active' and m.scope='tenant') or exists(select 1 from academy.platform_memberships am where am.tenant_id=t and am.subject_id=a.id and am.status='active' and am.role_key in ('manager','instructor'))) limit 100)x;
 end if;
 if p_role='learner' then
  select coalesce(jsonb_agg(x.row),'[]') into v_available_runs from (select jsonb_build_object('id',r.id,'courseId',r.course_id,'title',coalesce(r.title,r.run_code),'status',r.status,'startsAt',r.starts_at,'endsAt',r.ends_at) row from academy.course_runs r where r.tenant_id=t and r.status='open' and coalesce(r.metadata->>'hiddenDeliveryRun','false')<>'true' and exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=r.course_id and private_app.training_is_learner_v1(t,e.id)) order by r.starts_at nulls last,r.id limit 100)x;
 end if;
 select coalesce(jsonb_agg(x.row),'[]') into v_requests from (select jsonb_build_object('id',req.id,'enrollmentId',req.enrollment_id,'kind',req.kind,'status',req.status,'reason',req.reason,'dueAt',req.due_at,'decisionReason',req.decision_reason) row from academy.training_journey_requests req join academy.enrollments e on e.tenant_id=t and e.id=req.enrollment_id where req.tenant_id=t and (p_enrollment_id is null or e.id=p_enrollment_id) and (p_role='manager' or (p_role='learner' and private_app.training_is_learner_v1(t,e.id))) order by req.created_at desc limit 100)x;
 if p_role in ('manager','learner') and exists(select 1 from academy.platform_settings where tenant_id=t and mode='standalone') then
  v_requests:=public.v1_academy_request_snapshot(p_slug,p_role,p_offset)->'requests';
 end if;
 return jsonb_build_object('tenant',(select jsonb_build_object('id',tt.id,'slug',tt.slug,'name',tt.name,'timezone',tt.timezone,'currency',coalesce((select base_currency from accounting_core.tenant_profiles where tenant_id=t),'SAR')) from core.tenants tt where tt.id=t),'mode',(select mode from academy.platform_settings where tenant_id=t),'role',p_role,'courses',v_courses,'enrollments',v_enrollments,'submissions',v_submissions,'instructors',v_instructors,'instructorCandidates',v_candidates,'requests',v_requests,'availableRuns',v_available_runs,'pagination',jsonb_build_object('offset',p_offset,'limit',50,'total',greatest(v_total,v_course_total),'enrollmentTotal',v_total,'courseTotal',v_course_total,'hasMore',p_offset+50<greatest(v_total,v_course_total)));
end $function$;


CREATE OR REPLACE FUNCTION private_app.cms_module_enabled(p_tenant_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select private_app.academy_platform_enabled_v1(p_tenant_id,'website') or coalesce((
    select tm.enabled
    from core.tenant_modules tm
    join core.modules m on m.id=tm.module_id
    where tm.tenant_id=p_tenant_id and m.module_key='website_cms'
    limit 1
  ),false)
$function$;


CREATE OR REPLACE FUNCTION private_app.cms_access_subject(p_site_id uuid, p_permission text DEFAULT 'manage'::text)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_permission text;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  select * into v_site from website.sites where id=p_site_id limit 1;
  if v_site.id is null then raise exception 'cms_site_not_found'; end if;
  select subject.id into v_subject_id
  from access_control.subjects subject
  where subject.auth_user_id=auth.uid()
    and subject.status='active'
    and not subject.must_change_password
  limit 1;
  if v_subject_id is null then raise exception 'account_not_linked'; end if;
  if v_site.site_scope='platform' then
    if not private_app.has_platform_permission('platform.website.manage') then
      raise exception 'forbidden';
    end if;
    return v_subject_id;
  end if;
  if not private_app.cms_module_enabled(v_site.tenant_id) then
    raise exception 'cms_addon_required';
  end if;
  v_permission:=case lower(coalesce(p_permission,'manage'))
    when 'read' then 'tenant.website.read'
    when 'publish' then 'tenant.website.publish'
    else 'tenant.website.manage'
  end;
  if not (private_app.has_tenant_permission(v_site.tenant_id,v_permission) or private_app.academy_has_permission_v1(v_site.tenant_id,case lower(coalesce(p_permission,'manage')) when 'publish' then 'publishWebsite' else 'manageWebsite' end)) then
    raise exception 'forbidden';
  end if;
  return v_subject_id;
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_cms_action(p_site_key text, p_tenant_slug text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_payload jsonb:=coalesce(p_payload,'{}'::jsonb);
  v_row jsonb;
  v_publish_permission boolean:=false;
  v_target text;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  v_publish_permission:=case
    when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage')
    else (private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish') or private_app.academy_has_permission_v1(v_site.tenant_id,'publishWebsite'))
  end;

  if v_action='save-site' then
    update website.sites site
    set name_ar=coalesce(nullif(trim(v_payload->>'nameAr'),''),site.name_ar),
        name_en=nullif(trim(coalesce(v_payload->>'nameEn','')),''),
        status=case when v_payload->>'status' in ('draft','published','maintenance') then v_payload->>'status' else site.status end,
        primary_domain=nullif(lower(trim(coalesce(v_payload->>'primaryDomain',''))),''),
        locale=coalesce(nullif(trim(v_payload->>'locale'),''),site.locale),
        settings=case when jsonb_typeof(v_payload->'settings')='object' then site.settings||(v_payload->'settings') else site.settings end,
        theme=case when jsonb_typeof(v_payload->'theme')='object' then site.theme||(v_payload->'theme') else site.theme end,
        published_at=case when coalesce(v_payload->>'status',site.status)='published' then coalesce(site.published_at,now()) else site.published_at end
    where site.id=v_site.id
    returning to_jsonb(site) into v_row;
  elsif v_action=any(array[
    'create-page','update-page','duplicate-page','archive-page','set-home-page'
  ]) then
    v_row:=private_app.cms_page_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'create-menu','update-menu','archive-menu','save-menu-item',
    'archive-menu-item','move-menu-item'
  ]) then
    v_row:=private_app.cms_menu_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'create-article','update-article','archive-article',
    'create-category','update-category','archive-category'
  ]) then
    v_row:=private_app.cms_content_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  elsif v_action=any(array[
    'register-asset','update-asset','archive-asset','set-submission-status'
  ]) then
    v_row:=private_app.cms_asset_action(
      v_site.id,v_subject_id,v_publish_permission,v_action,v_payload
    );
  else
    raise exception 'cms_action_invalid';
  end if;

  v_target:=coalesce(v_row->>'id',v_row->>'pageId',v_row->>'articleId',v_site.id::text);
  perform private_app.write_audit(
    'cms.'||replace(v_action,'-','.'),'cms',v_target,
    v_site.tenant_id,jsonb_build_object(
      'siteId',v_site.id,'scope',v_site.site_scope,'action',v_action
    )
  );
  return jsonb_build_object(
    'success',true,'action',v_action,'result',v_row,'siteId',v_site.id
  );
exception when unique_violation then
  raise exception 'cms_unique_value_conflict';
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_cms_builder_action(p_site_key text, p_tenant_slug text, p_entity_type text, p_entity_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_document website.content_documents%rowtype;
  v_action text:=lower(trim(coalesce(p_action,'')));
  v_validated jsonb;
  v_version integer;
  v_version_id uuid;
  v_versions jsonb;
  v_can_publish boolean;
begin
  if p_entity_type not in ('page','article') then raise exception 'cms_entity_type_invalid'; end if;
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  v_document:=private_app.cms_ensure_document(v_site.id,p_entity_type,p_entity_id,v_subject_id);
  v_can_publish:=case
    when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage')
    else (private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish') or private_app.academy_has_permission_v1(v_site.tenant_id,'publishWebsite'))
  end;

  if v_action in ('save-draft','publish') then
    v_validated:=private_app.website_builder_validate_document(p_payload->'document');
    update website.content_documents document
    set draft_document=v_validated,draft_updated_at=now(),updated_by_subject_id=v_subject_id
    where document.id=v_document.id
    returning * into v_document;
    v_version:=private_app.cms_record_version(
      v_document.id,v_validated,
      case when v_action='publish' then 'published' else 'draft' end,
      case when v_action='publish' then 'نشر المحتوى' else 'حفظ مسودة' end,
      v_subject_id
    );

    if v_action='publish' then
      if not v_can_publish then raise exception 'publish_forbidden'; end if;
      update website.content_documents document
      set published_document=v_validated,published_at=now(),published_by_subject_id=v_subject_id
      where document.id=v_document.id
      returning * into v_document;
      if p_entity_type='page' then
        update website.pages page
        set content=v_validated,template_key='visual-builder',status='published',published_at=coalesce(page.published_at,now())
        where page.id=p_entity_id and page.site_id=v_site.id;
      else
        update website.articles article
        set content=v_validated,status='published',published_at=coalesce(article.published_at,now())
        where article.id=p_entity_id and article.site_id=v_site.id;
      end if;
    end if;

  elsif v_action='restore-version' then
    v_version_id:=nullif(p_payload->>'versionId','')::uuid;
    select version.document into v_validated
    from website.content_document_versions version
    where version.id=v_version_id and version.content_document_id=v_document.id
    limit 1;
    if v_validated is null then raise exception 'builder_version_not_found'; end if;
    v_validated:=private_app.website_builder_validate_document(v_validated);
    update website.content_documents document
    set draft_document=v_validated,draft_updated_at=now(),updated_by_subject_id=v_subject_id
    where document.id=v_document.id
    returning * into v_document;
    v_version:=private_app.cms_record_version(
      v_document.id,v_validated,'restored','استعادة إصدار سابق',v_subject_id
    );
  else
    raise exception 'builder_action_invalid';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',version.id,'versionNumber',version.version_number,'versionKind',version.version_kind,
    'note',version.note,'createdAt',version.created_at
  ) order by version.version_number desc),'[]'::jsonb)
  into v_versions
  from (select * from website.content_document_versions where content_document_id=v_document.id order by version_number desc limit 40) version;

  return jsonb_build_object(
    'entityId',p_entity_id,'entityType',p_entity_type,'documentId',v_document.id,
    'draftDocument',v_document.draft_document,'publishedDocument',v_document.published_document,
    'versionNumber',v_version,'versions',v_versions,'savedAt',now()
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_cms_builder_snapshot(p_site_key text, p_tenant_slug text, p_entity_type text, p_entity_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_document website.content_documents%rowtype;
  v_entity jsonb;
  v_versions jsonb;
  v_saved_blocks jsonb;
begin
  if p_entity_type not in ('page','article') then raise exception 'cms_entity_type_invalid'; end if;
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  v_document:=private_app.cms_ensure_document(v_site.id,p_entity_type,p_entity_id,v_subject_id);

  if p_entity_type='page' then
    select jsonb_build_object(
      'id',page.id,'type','page','slug',page.slug,'title',page.title,'excerpt',page.excerpt,
      'status',page.status,'isHome',page.is_home,'pageKind',page.page_kind,
      'canonicalUrl',page.canonical_url,'robots',page.robots,'coverUrl',page.cover_url,
      'updatedAt',page.updated_at,'publishedAt',page.published_at
    ) into v_entity
    from website.pages page where page.id=p_entity_id and page.site_id=v_site.id;
  else
    select jsonb_build_object(
      'id',article.id,'type','article','slug',article.slug,'title',article.title,
      'excerpt',article.excerpt,'status',article.status,'canonicalUrl',article.canonical_url,
      'robots',article.robots,'coverUrl',article.cover_url,
      'category',article.category,'authorName',article.author_name,
      'updatedAt',article.updated_at,'publishedAt',article.published_at
    ) into v_entity
    from website.articles article where article.id=p_entity_id and article.site_id=v_site.id;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',version.id,'versionNumber',version.version_number,'versionKind',version.version_kind,
    'note',version.note,'createdAt',version.created_at
  ) order by version.version_number desc),'[]'::jsonb)
  into v_versions
  from (select * from website.content_document_versions where content_document_id=v_document.id order by version_number desc limit 40) version;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',saved.id,
    'key',saved.block_key,
    'name',saved.name,
    'description',saved.description,
    'category',saved.category,
    'block',saved.block,
    'isSystem',saved.is_system,
    'createdAt',saved.created_at,
    'updatedAt',saved.updated_at
  ) order by saved.sort_order,saved.created_at),'[]'::jsonb)
  into v_saved_blocks
  from website.saved_blocks saved
  where saved.site_id=v_site.id and saved.status='active';

  return jsonb_build_object(
    'context',jsonb_build_object('scope',v_site.site_scope,'siteKey',v_site.site_key,'siteId',v_site.id,'tenantSlug',p_tenant_slug),
    'entity',v_entity,'page',v_entity,
    'document',jsonb_build_object(
      'id',v_document.id,'draftDocument',v_document.draft_document,
      'publishedDocument',v_document.published_document,'draftUpdatedAt',v_document.draft_updated_at,
      'publishedAt',v_document.published_at
    ),
    'versions',v_versions,
    'savedBlocks',v_saved_blocks
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.v3_cms_storage_can_write(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_site_id uuid;
begin
  if auth.uid() is null then return false; end if;
  begin
    v_site_id:=((storage.foldername(p_name))[1])::uuid;
  exception when others then
    return false;
  end;
  select * into v_site from website.sites where id=v_site_id limit 1;
  if v_site.id is null then return false; end if;
  if v_site.site_scope='platform' then
    return private_app.has_platform_permission('platform.website.manage');
  end if;
  return private_app.cms_module_enabled(v_site.tenant_id)
    and (private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.manage') or private_app.academy_has_permission_v1(v_site.tenant_id,'manageWebsite'));
end $function$;


CREATE OR REPLACE FUNCTION public.v3_cms_workspace_snapshot(p_site_key text DEFAULT 'marktone-main'::text, p_tenant_slug text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_site website.sites%rowtype;
  v_subject_id uuid;
  v_pages jsonb;
  v_menus jsonb;
  v_menu_items jsonb;
  v_articles jsonb;
  v_assets jsonb;
  v_categories jsonb;
  v_submissions jsonb;
  v_can_publish boolean:=false;
begin
  v_site:=private_app.cms_resolve_site(p_site_key,p_tenant_slug,'manage',true);
  v_subject_id:=private_app.cms_access_subject(v_site.id,'manage');
  perform private_app.cms_bootstrap_site(v_site.id,v_subject_id);
  select * into v_site from website.sites where id=v_site.id;

  v_can_publish:=case
    when v_site.site_scope='platform' then private_app.has_platform_permission('platform.website.manage')
    else (private_app.has_tenant_permission(v_site.tenant_id,'tenant.website.publish') or private_app.academy_has_permission_v1(v_site.tenant_id,'publishWebsite'))
  end;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',page.id,'slug',page.slug,'title',page.title,'menuLabel',page.menu_label,
    'excerpt',page.excerpt,'coverUrl',page.cover_url,'pageKind',page.page_kind,
    'isHome',page.is_home,'parentPageId',page.parent_page_id,'sortOrder',page.sort_order,
    'visibility',page.visibility,'showInMenu',page.show_in_menu,'menuOrder',page.menu_order,
    'status',page.status,'templateKey',page.template_key,'seoTitle',page.seo_title,
    'seoDescription',page.seo_description,'canonicalUrl',page.canonical_url,
    'robots',page.robots,'updatedAt',page.updated_at,'publishedAt',page.published_at,
    'builder',jsonb_build_object(
      'documentId',document.id,
      'blockCount',coalesce(jsonb_array_length(document.draft_document->'blocks'),0),
      'hasDraft',document.id is not null,
      'hasPublished',document.published_document is not null,
      'hasUnpublishedChanges',document.draft_document is distinct from document.published_document,
      'draftUpdatedAt',document.draft_updated_at,'publishedAt',document.published_at
    )
  ) order by page.is_home desc,page.sort_order,page.updated_at desc),'[]'::jsonb)
  into v_pages
  from website.pages page
  left join website.content_documents document
    on document.site_id=page.site_id and document.entity_type='page' and document.entity_id=page.id
  where page.site_id=v_site.id and page.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',menu.id,'key',menu.menu_key,'name',menu.name,'location',menu.location,
    'description',menu.description,'settings',menu.settings,'status',menu.status,
    'updatedAt',menu.updated_at,
    'itemCount',(select count(*) from website.menu_items item where item.menu_id=menu.id and item.status<>'archived')
  ) order by case menu.location when 'header' then 0 when 'footer' then 1 else 2 end,menu.name),'[]'::jsonb)
  into v_menus
  from website.menus menu
  where menu.site_id=v_site.id and menu.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item.id,'menuId',item.menu_id,'parentId',item.parent_id,'label',item.label,
    'mobileLabel',item.mobile_label,'href',item.href,'kind',item.item_kind,
    'targetPageId',item.target_page_id,'targetArticleId',item.target_article_id,
    'description',item.description,'icon',item.icon,'badge',item.badge,'imageUrl',item.image_url,
    'columnIndex',item.column_index,'isMega',item.is_mega,'megaSettings',item.mega_settings,
    'cssClass',item.css_class,'openInNewTab',item.open_in_new_tab,
    'sortOrder',item.sort_order,'isVisible',item.is_visible,'status',item.status
  ) order by item.menu_id,item.parent_id nulls first,item.column_index,item.sort_order,item.created_at),'[]'::jsonb)
  into v_menu_items
  from website.menu_items item
  where item.site_id=v_site.id and item.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',article.id,'slug',article.slug,'title',article.title,'excerpt',article.excerpt,
    'body',article.body,'category',article.category,'tags',article.tags,
    'authorName',article.author_name,'coverUrl',article.cover_url,'featured',article.featured,
    'readingMinutes',article.reading_minutes,'status',article.status,
    'visibility',article.visibility,'scheduledAt',article.scheduled_at,
    'seoTitle',article.seo_title,'seoDescription',article.seo_description,
    'canonicalUrl',article.canonical_url,'robots',article.robots,
    'publishedAt',article.published_at,'updatedAt',article.updated_at,
    'builder',jsonb_build_object(
      'documentId',document.id,
      'blockCount',coalesce(jsonb_array_length(document.draft_document->'blocks'),0),
      'hasDraft',document.id is not null,'hasPublished',document.published_document is not null,
      'hasUnpublishedChanges',document.draft_document is distinct from document.published_document,
      'draftUpdatedAt',document.draft_updated_at,'publishedAt',document.published_at
    )
  ) order by article.updated_at desc),'[]'::jsonb)
  into v_articles
  from website.articles article
  left join website.content_documents document
    on document.site_id=article.site_id and document.entity_type='article' and document.entity_id=article.id
  where article.site_id=v_site.id and article.status<>'archived';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',asset.id,'url',asset.public_url,'fileName',asset.file_name,'mimeType',asset.mime_type,
    'sizeBytes',asset.size_bytes,'width',asset.width,'height',asset.height,
    'altText',asset.alt_text,'caption',asset.caption,'createdAt',asset.created_at
  ) order by asset.created_at desc),'[]'::jsonb)
  into v_assets
  from (select * from website.assets where site_id=v_site.id and status='active' order by created_at desc limit 240) asset;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',category.id,'parentId',category.parent_id,'name',category.name,
    'slug',category.slug,'description',category.description,'sortOrder',category.sort_order
  ) order by category.sort_order,category.name),'[]'::jsonb)
  into v_categories
  from website.article_categories category
  where category.site_id=v_site.id and category.status='active';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',submission.id,'reference',submission.reference_key,'name',submission.name,
    'email',submission.email,'phone',submission.phone,'organization',submission.organization,
    'message',submission.message,'sourcePage',submission.source_page,'status',submission.status,
    'createdAt',submission.created_at
  ) order by submission.created_at desc),'[]'::jsonb)
  into v_submissions
  from (select * from website.contact_submissions where site_id=v_site.id and status<>'archived' order by created_at desc limit 100) submission;

  return jsonb_build_object(
    'context',jsonb_build_object(
      'scope',v_site.site_scope,'siteKey',v_site.site_key,'siteId',v_site.id,
      'tenantId',v_site.tenant_id,'tenantSlug',p_tenant_slug,
      'canPublish',v_can_publish,'cmsVersion',v_site.cms_version,'addonStatus',v_site.addon_status
    ),
    'site',jsonb_build_object(
      'id',v_site.id,'siteKey',v_site.site_key,'nameAr',v_site.name_ar,'nameEn',v_site.name_en,
      'status',v_site.status,'settings',v_site.settings,'theme',v_site.theme,
      'locale',v_site.locale,'primaryDomain',v_site.primary_domain,'updatedAt',v_site.updated_at
    ),
    'stats',jsonb_build_object(
      'pages',(select count(*) from website.pages p where p.site_id=v_site.id and p.status<>'archived'),
      'publishedPages',(select count(*) from website.pages p where p.site_id=v_site.id and p.status='published'),
      'articles',(select count(*) from website.articles a where a.site_id=v_site.id and a.status<>'archived'),
      'publishedArticles',(select count(*) from website.articles a where a.site_id=v_site.id and a.status='published'),
      'menus',(select count(*) from website.menus m where m.site_id=v_site.id and m.status<>'archived'),
      'assets',(select count(*) from website.assets a where a.site_id=v_site.id and a.status='active'),
      'newMessages',(select count(*) from website.contact_submissions c where c.site_id=v_site.id and c.status='new')
    ),
    'pages',v_pages,'menus',v_menus,'menuItems',v_menu_items,
    'articles',v_articles,'assets',v_assets,'categories',v_categories,
    'submissions',v_submissions
  );
end;
$function$;


create function public.v1_academy_learning_invitation_preview(p_slug text,p_token_hash text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if coalesce(p_token_hash,'')!~'^[0-9a-f]{64}$' then raise exception 'training_invitation_invalid';end if;
 select jsonb_build_object('tenantId',t.id,'slug',t.slug,'tenantName',t.name,'email',i.email,'role','learner','expiresAt',i.expires_at)
 into result from academy.training_invitations i join core.tenants t on t.id=i.tenant_id
 join academy.students s on s.tenant_id=t.id and s.id=i.student_id and s.status in ('active','graduated') and lower(trim(s.email))=i.email
 where i.token_hash=p_token_hash and i.status='pending' and i.expires_at>now() and t.slug=p_slug and private_app.academy_platform_enabled_v1(t.id,'lms');
 if result is null then raise exception 'training_invitation_invalid';end if;
 return result;
end $$;

revoke all on function private_app.academy_platform_enabled_v1(uuid,text),private_app.academy_has_permission_v1(uuid,text),private_app.academy_training_tenant_v1(text),private_app.academy_platform_config_v1(uuid) from public,anon,authenticated;
revoke all on function public.v1_academy_workspace_snapshot(text),public.v1_platform_academy_snapshot(text),public.v1_platform_academy_action(text,text,uuid,jsonb),public.v1_academy_membership_accept(text,text),public.v1_academy_training_action(text,text,uuid,jsonb),public.v1_academy_training_snapshot(text,text,uuid,uuid,integer) from public,anon;
grant execute on function public.v1_academy_workspace_snapshot(text),public.v1_platform_academy_snapshot(text),public.v1_platform_academy_action(text,text,uuid,jsonb),public.v1_academy_membership_accept(text,text),public.v1_academy_training_action(text,text,uuid,jsonb),public.v1_academy_training_snapshot(text,text,uuid,uuid,integer) to authenticated;
revoke all on function public.v1_academy_invitation_preview(text,text) from public;
grant execute on function public.v1_academy_invitation_preview(text,text) to anon,authenticated;
revoke all on function public.v1_academy_learning_invitation_preview(text,text) from public;
grant execute on function public.v1_academy_learning_invitation_preview(text,text) to anon,authenticated;
create function public.v1_academy_public_navigation(p_slug text) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce((select jsonb_build_object('enabled',true,'tenant',jsonb_build_object('slug',t.slug,'name',t.name),
 'components',jsonb_build_object('lms',private_app.academy_platform_enabled_v1(t.id,'lms'),'website',private_app.academy_platform_enabled_v1(t.id,'website'),'store',private_app.academy_platform_enabled_v1(t.id,'store')))
 from core.tenants t where t.slug=p_slug and (private_app.academy_platform_enabled_v1(t.id,'lms') or private_app.academy_platform_enabled_v1(t.id,'website') or private_app.academy_platform_enabled_v1(t.id,'store'))),
 jsonb_build_object('enabled',false,'tenant',null,'components',jsonb_build_object('lms',false,'website',false,'store',false)))
$$;
revoke all on function public.v1_academy_public_navigation(text) from public;
grant execute on function public.v1_academy_public_navigation(text) to anon,authenticated;

create table academy.platform_requests (
 id uuid primary key default gen_random_uuid(),tenant_id uuid not null references core.tenants(id),enrollment_id uuid not null,
 kind text not null check(kind in ('transfer','defer','resume','withdraw')),status text not null default 'pending' check(status in ('pending','approved','rejected')),
 reason text not null check(length(trim(reason)) between 3 and 2000),target_run_id uuid,
 requested_by_subject_id uuid not null references access_control.subjects(id),decided_by_subject_id uuid references access_control.subjects(id),
 decision_reason text,decided_at timestamptz,result jsonb,created_at timestamptz not null default now(),
 foreign key(tenant_id,enrollment_id) references academy.enrollments(tenant_id,id),
 foreign key(tenant_id,target_run_id) references academy.course_runs(tenant_id,id),
 check((status='pending')=(decided_at is null))
);
create index academy_requests_queue_idx on academy.platform_requests(tenant_id,status,created_at,id);
create index academy_requests_enrollment_idx on academy.platform_requests(tenant_id,enrollment_id);
create index academy_requests_target_idx on academy.platform_requests(tenant_id,target_run_id) where target_run_id is not null;
create index academy_requests_actor_idx on academy.platform_requests(requested_by_subject_id);
create index academy_requests_decider_idx on academy.platform_requests(decided_by_subject_id) where decided_by_subject_id is not null;
create unique index academy_requests_pending_idx on academy.platform_requests(tenant_id,enrollment_id,kind) where status='pending';
alter table academy.platform_requests enable row level security;
revoke all on academy.platform_requests from public,anon,authenticated;

create function private_app.academy_request_create_v1(p_tenant_id uuid,p_enrollment_id uuid,p_kind text,p_reason text,p_target_run_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e academy.enrollments%rowtype;request_id uuid;
begin
 if not private_app.academy_platform_enabled_v1(p_tenant_id,'lms') or not exists(select 1 from academy.platform_settings where tenant_id=p_tenant_id and mode='standalone') then raise exception 'academy_standalone_required';end if;
 if not (private_app.academy_has_permission_v1(p_tenant_id,'manageAdmissions') or private_app.training_is_learner_v1(p_tenant_id,p_enrollment_id)) then raise exception 'training_permission_denied';end if;
 select * into e from academy.enrollments where tenant_id=p_tenant_id and id=p_enrollment_id for update;
 if e.id is null or e.status not in ('active','confirmed') or exists(select 1 from academy.certificates where tenant_id=p_tenant_id and enrollment_id=e.id and status='issued') then raise exception 'training_completed_enrollment_change_requires_review';end if;
 if p_kind is null or p_kind not in ('transfer','defer','resume','withdraw') or length(trim(coalesce(p_reason,''))) not between 3 and 2000 then raise exception 'training_request_kind_invalid';end if;
 if p_kind='resume' and coalesce(e.metadata->>'trainingJourneyDeferred','false')<>'true' then raise exception 'training_enrollment_not_deferred';end if;
 if p_kind='transfer' and not exists(select 1 from academy.course_runs where tenant_id=p_tenant_id and id=p_target_run_id and course_id=e.course_id and status='open' and id<>e.course_run_id) then raise exception 'training_target_run_invalid';end if;
 insert into academy.platform_requests(tenant_id,enrollment_id,kind,reason,target_run_id,requested_by_subject_id)
 values(p_tenant_id,p_enrollment_id,p_kind,trim(p_reason),case when p_kind='transfer' then p_target_run_id end,private_app.current_subject_id()) returning id into request_id;
 perform private_app.training_learning_event_v1(p_tenant_id,p_enrollment_id,'academy_request_created',jsonb_build_object('requestId',request_id,'kind',p_kind));
 return jsonb_build_object('requestId',request_id,'status','pending');
end $$;

create function public.v1_academy_request_snapshot(p_slug text,p_role text default 'manager',p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare t uuid;rows jsonb;runs jsonb;can_manage boolean;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);can_manage:=private_app.academy_has_permission_v1(t,'manageAdmissions');
 if p_role is null or p_role not in ('manager','learner') or p_offset is null or p_offset not between 0 and 100000 or (p_role='manager' and not (can_manage or private_app.academy_has_permission_v1(t,'manageLearning'))) then raise exception 'training_permission_denied';end if;
 if p_role='learner' and not exists(select 1 from academy.training_learner_accounts where tenant_id=t and subject_id=private_app.current_subject_id() and status='active') then raise exception 'training_learner_binding_required';end if;
 select coalesce(jsonb_agg(x.row),'[]') into rows from (select jsonb_build_object('id',r.id,'enrollmentId',r.enrollment_id,'kind',r.kind,'status',r.status,'reason',r.reason,'targetRunId',r.target_run_id,'createdAt',r.created_at,'decisionReason',r.decision_reason,'result',r.result,'studentName',s.full_name,'courseTitle',c.title_ar) row
 from academy.platform_requests r join academy.enrollments e on e.tenant_id=t and e.id=r.enrollment_id join academy.students s on s.tenant_id=t and s.id=e.student_id join academy.courses c on c.tenant_id=t and c.id=e.course_id
 where r.tenant_id=t and (p_role='manager' or private_app.training_is_learner_v1(t,e.id)) order by r.created_at desc,r.id limit 50 offset p_offset)x;
 select coalesce(jsonb_agg(x.row),'[]') into runs from(select jsonb_build_object('id',r.id,'courseId',r.course_id,'title',coalesce(r.title,r.run_code),'status',r.status) row from academy.course_runs r
 where r.tenant_id=t and r.status='open' and (p_role='manager' or exists(select 1 from academy.enrollments e where e.tenant_id=t and e.course_id=r.course_id and private_app.training_is_learner_v1(t,e.id))) order by r.starts_at nulls last,r.id limit 100)x;
 return jsonb_build_object('requests',rows,'runs',runs,'canManage',can_manage and p_role='manager','offset',p_offset,'limit',50);
end $$;

create function private_app.academy_transfer_payment_authorized_v1(p_tenant_id uuid,p_handoff_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select private_app.academy_has_permission_v1(p_tenant_id,'manageAdmissions') and exists(
 select 1 from academy.registration_handoffs target
 join academy.registration_handoffs origin on origin.tenant_id=target.tenant_id and origin.id::text=target.metadata->>'originHandoffId'
 join academy.training_financial_links target_fin on target_fin.tenant_id=target.tenant_id and target_fin.handoff_id=target.id
 join academy.training_financial_links origin_fin on origin_fin.tenant_id=origin.tenant_id and origin_fin.handoff_id=origin.id and origin_fin.invoice_id=target_fin.invoice_id
 where target.tenant_id=p_tenant_id and target.id=p_handoff_id and target.metadata->>'source'='academy_transfer'
 and origin.course_id=target.course_id and origin.contact_id=target.contact_id and origin.payment_status='verified' and origin.status='completed'
 and target.payment_amount_minor=0 and private_app.training_journey_handoff_finance_v1(origin.id)->>'trainingAllowed'='true')
$$;

create function public.v1_academy_request_action(p_slug text,p_action text,p_command_id uuid,p_payload jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
<<request_operation>>
declare t uuid;actor uuid;cached jsonb;result jsonb;r academy.platform_requests%rowtype;e academy.enrollments%rowtype;
 h academy.registration_handoffs%rowtype;l academy.training_financial_links%rowtype;target academy.course_runs%rowtype;new_h uuid;new_e uuid;capacity_used integer;
begin
 t:=private_app.academy_training_tenant_v1(p_slug);actor:=private_app.current_subject_id();
 if not exists(select 1 from academy.platform_settings where tenant_id=t and mode='standalone') then raise exception 'academy_standalone_required';end if;
 if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>16384 or p_action is null or p_action not in ('create_request','decide_request') then raise exception 'academy_invalid_request';end if;
 if p_action='decide_request' and not private_app.academy_has_permission_v1(t,'manageAdmissions') then raise exception 'training_permission_denied';end if;
 if p_action='create_request' and not (private_app.academy_has_permission_v1(t,'manageAdmissions') or private_app.training_is_learner_v1(t,(p_payload->>'enrollmentId')::uuid)) then raise exception 'training_permission_denied';end if;
 cached:=private_app.training_journey_command_v1(t,p_command_id,'academy.request.'||p_action,p_payload);if cached is not null then return cached;end if;
 if p_action='create_request' then
  result:=private_app.academy_request_create_v1(t,(p_payload->>'enrollmentId')::uuid,p_payload->>'kind',p_payload->>'reason',nullif(p_payload->>'targetRunId','')::uuid);
 else
  select * into r from academy.platform_requests where tenant_id=t and id=(p_payload->>'requestId')::uuid for update;
  if r.id is null or r.status<>'pending' then raise exception 'training_request_not_pending';end if;
  if p_payload->>'decision' is null or p_payload->>'decision' not in ('approve','reject') or length(trim(coalesce(p_payload->>'reason',''))) not between 3 and 2000 then raise exception 'training_decision_invalid';end if;
  select * into e from academy.enrollments where tenant_id=t and id=r.enrollment_id for update;
  if p_payload->>'decision'='approve' then
   if e.status not in ('confirmed','active') or exists(select 1 from academy.certificates where tenant_id=t and enrollment_id=e.id and status='issued') then raise exception 'training_completed_enrollment_change_requires_review';end if;
   if r.kind='defer' then update academy.enrollments set metadata=metadata||jsonb_build_object('trainingJourneyDeferred',true,'academyDeferredRequestId',r.id) where tenant_id=t and id=e.id;
   elsif r.kind='resume' then
    if coalesce(e.metadata->>'trainingJourneyDeferred','false')<>'true' or not coalesce((private_app.training_journey_handoff_finance_v1(e.handoff_id)->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required';end if;
    update academy.enrollments set metadata=metadata||jsonb_build_object('trainingJourneyDeferred',false,'academyResumedRequestId',r.id) where tenant_id=t and id=e.id;
   elsif r.kind='withdraw' then
    perform 1 from academy.course_runs where tenant_id=t and id=e.course_run_id for update;
    update academy.enrollments set status='withdrawn',metadata=metadata||jsonb_build_object('academyWithdrawalRequestId',r.id,'refundReviewRequired',true) where tenant_id=t and id=e.id;
    update academy.course_runs cr set enrolled_count=(select count(*) from academy.enrollments en where en.tenant_id=t and en.course_run_id=cr.id and en.status in ('confirmed','active','completed')) where cr.tenant_id=t and cr.id=e.course_run_id;
   elsif r.kind='transfer' then
    perform 1 from academy.course_runs where tenant_id=t and id in (e.course_run_id,r.target_run_id) order by id for update;
    select * into target from academy.course_runs where tenant_id=t and id=r.target_run_id and status='open' and course_id=e.course_id and id<>e.course_run_id;
    if target.id is null then raise exception 'training_target_run_invalid';end if;
    if exists(select 1 from academy.enrollments where tenant_id=t and student_id=e.student_id and course_run_id=target.id) then raise exception 'training_target_already_enrolled';end if;
    select count(*) into capacity_used from academy.enrollments where tenant_id=t and course_run_id=target.id and status in ('confirmed','active','completed');
    if target.capacity is not null and capacity_used>=target.capacity then raise exception 'training_run_full';end if;
    select * into h from academy.registration_handoffs where tenant_id=t and id=e.handoff_id;
    select * into l from academy.training_financial_links where tenant_id=t and handoff_id=h.id;
    if l.handoff_id is null or h.payment_status<>'verified' or not coalesce((private_app.training_journey_handoff_finance_v1(h.id)->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required';end if;
    new_h:=gen_random_uuid();
    insert into academy.registration_handoffs(id,tenant_id,handoff_key,contact_id,course_id,course_run_id,status,paid_at,payment_amount_minor,payment_status,created_by_subject_id,metadata)
    values(new_h,t,'academy-transfer-'||r.id,h.contact_id,e.course_id,target.id,'pending',h.paid_at,0,'pending_verification',actor,jsonb_build_object('source','academy_transfer','originHandoffId',h.id,'originEnrollmentId',e.id,'requestId',r.id,'newFinancialAmountMinor',0));
    insert into academy.training_financial_links(tenant_id,handoff_id,invoice_id,payer_account_id,policy,sponsor,credit_limit_minor,credit_expires_on,credit_approved_by_subject_id,credit_approved_at,credit_reason,certificate_requires_settlement,created_by_subject_id)
    values(t,new_h,l.invoice_id,l.payer_account_id,l.policy,l.sponsor,l.credit_limit_minor,l.credit_expires_on,l.credit_approved_by_subject_id,l.credit_approved_at,l.credit_reason,l.certificate_requires_settlement,actor);
    update academy.registration_handoffs set status='completed',payment_status='verified',payment_verified_at=h.payment_verified_at,payment_verified_by_subject_id=h.payment_verified_by_subject_id,accepted_at=now(),accepted_by_subject_id=actor,completed_at=now(),completed_by_subject_id=actor where tenant_id=t and id=new_h;
    update academy.enrollments set status='withdrawn',metadata=metadata||jsonb_build_object('academyTransferRequestId',r.id,'transferredToHandoffId',new_h) where tenant_id=t and id=e.id;
    insert into academy.enrollments(tenant_id,enrollment_key,handoff_id,student_id,course_id,course_run_id,status,confirmed_by_subject_id,metadata)
    values(t,'handoff-'||new_h,new_h,e.student_id,e.course_id,target.id,'confirmed',actor,jsonb_build_object('source','academy_transfer','originEnrollmentId',e.id,'requestId',r.id)) returning id into new_e;
    perform private_app.academy_learning_transfer_v1(e.id,new_e);
    update academy.course_runs cr set enrolled_count=(select count(*) from academy.enrollments en where en.tenant_id=t and en.course_run_id=cr.id and en.status in ('confirmed','active','completed')) where cr.tenant_id=t and cr.id in (e.course_run_id,target.id);
   end if;
  end if;
  result:=jsonb_build_object('requestId',r.id,'status',case when p_payload->>'decision'='approve' then 'approved' else 'rejected' end,'newEnrollmentId',new_e,'financialSettlementRequired',r.kind='withdraw' and p_payload->>'decision'='approve','refundProcessed',false);
  update academy.platform_requests set status=request_operation.result->>'status',decided_by_subject_id=actor,decided_at=now(),decision_reason=trim(p_payload->>'reason'),result=request_operation.result where tenant_id=t and id=r.id;
  perform private_app.training_learning_event_v1(t,e.id,'academy_request_decided',result||jsonb_build_object('decisionReason',p_payload->>'reason'));
 end if;
 return private_app.training_journey_complete_command_v1(t,p_command_id,result);
end $$;
revoke all on function private_app.academy_request_create_v1(uuid,uuid,text,text,uuid),private_app.academy_transfer_payment_authorized_v1(uuid,uuid) from public,anon,authenticated;
revoke all on function public.v1_academy_request_action(text,text,uuid,jsonb),public.v1_academy_request_snapshot(text,text,integer) from public,anon;
grant execute on function public.v1_academy_request_action(text,text,uuid,jsonb),public.v1_academy_request_snapshot(text,text,integer) to authenticated;
CREATE OR REPLACE FUNCTION private_app.academy_learning_transfer_v1(p_old_enrollment_id uuid, p_new_enrollment_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare old_e academy.enrollments%rowtype;new_e academy.enrollments%rowtype;v_version uuid;sub academy.training_submissions%rowtype;new_sub uuid;
begin
 select * into old_e from academy.enrollments where id=p_old_enrollment_id;
 select * into new_e from academy.enrollments where id=p_new_enrollment_id;
 if old_e.id is null or new_e.id is null or old_e.tenant_id<>new_e.tenant_id or old_e.student_id<>new_e.student_id or not private_app.academy_has_permission_v1(old_e.tenant_id,'manageAdmissions') then raise exception 'training_transfer_not_authorized';end if;
 if old_e.course_id<>new_e.course_id then return;end if;
 select version_id into v_version from academy.training_enrollment_versions where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 if v_version is null then return;end if;
 if exists(select 1 from academy.training_enrollment_versions where tenant_id=new_e.tenant_id and enrollment_id=new_e.id) then raise exception 'training_transfer_target_already_bound';end if;
 insert into academy.training_enrollment_versions(tenant_id,enrollment_id,version_id,assigned_by_subject_id) values(new_e.tenant_id,new_e.id,v_version,private_app.current_subject_id());
 insert into academy.training_unit_progress(tenant_id,enrollment_id,version_id,unit_id,opened_at,last_opened_at,completed_at,completed_by_subject_id) select tenant_id,new_e.id,version_id,unit_id,opened_at,last_opened_at,completed_at,completed_by_subject_id from academy.training_unit_progress where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 insert into academy.training_quiz_attempts(tenant_id,enrollment_id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id,submitted_at) select tenant_id,new_e.id,version_id,unit_id,attempt,answers,score,passed,submitted_by_subject_id,submitted_at from academy.training_quiz_attempts where tenant_id=old_e.tenant_id and enrollment_id=old_e.id;
 for sub in select * from academy.training_submissions where tenant_id=old_e.tenant_id and enrollment_id=old_e.id order by unit_id,attempt loop
  insert into academy.training_submissions(tenant_id,enrollment_id,version_id,unit_id,attempt,body,submitted_by_subject_id,submitted_at) values(new_e.tenant_id,new_e.id,sub.version_id,sub.unit_id,sub.attempt,sub.body,sub.submitted_by_subject_id,sub.submitted_at) returning id into new_sub;
  insert into academy.training_grades(tenant_id,submission_id,score,feedback,graded_by_subject_id,graded_at) select tenant_id,new_sub,score,feedback,graded_by_subject_id,graded_at from academy.training_grades where tenant_id=old_e.tenant_id and submission_id=sub.id;
 end loop;
 perform private_app.training_reconcile_assessment_v1(new_e.tenant_id,new_e.id);
 perform private_app.training_learning_event_v1(new_e.tenant_id,new_e.id,'equivalent_progress_transferred',jsonb_build_object('sourceEnrollmentId',old_e.id,'versionId',v_version,'equivalence','same_course_and_version'));
end $function$;

CREATE OR REPLACE FUNCTION private_app.training_journey_guard_finance_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f jsonb;
begin
 if new.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid or not exists(
 select 1 from academy.training_journey_settings where tenant_id=new.tenant_id and enabled) then return new; end if;
 if tg_table_name='registration_handoffs' then
  if not exists(select 1 from academy.training_financial_links where tenant_id=new.tenant_id and handoff_id=new.id) then return new; end if;
  if new.payment_status='verified' and (tg_op='INSERT' or old.payment_status is distinct from 'verified') then
   if not private_app.training_journey_payment_authorized_v1(new.tenant_id) and not private_app.academy_transfer_payment_authorized_v1(new.tenant_id,new.id) then raise exception 'training_payment_verification_forbidden' using errcode='42501'; end if;
   f:=private_app.training_journey_handoff_finance_v1(new.id);
   if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required'; end if;
   if coalesce((f->>'paidMinor')::bigint,0)<=0 and coalesce((f->>'totalMinor')::bigint,1)>0 then raise exception 'training_payment_evidence_required'; end if;
  end if;
 elsif tg_table_name='enrollments' and new.status in ('confirmed','active','completed') then
  if private_app.admission_governance_enabled_v1(new.tenant_id) then
   if tg_op='UPDATE' then
    if old.status in ('confirmed','active','completed') and new.course_run_id=old.course_run_id and new.student_id=old.student_id and new.handoff_id=old.handoff_id then return new;end if;
   end if;
   f:=private_app.admission_financial_eligibility_v1(new.tenant_id,new.handoff_id);
   if not coalesce((f->>'eligible')::boolean,false) then raise exception 'training_financial_clearance_required';end if;
   return new;
  end if;
  if not exists(select 1 from academy.training_financial_links where tenant_id=new.tenant_id and handoff_id=new.handoff_id) then return new; end if;
  f:=private_app.training_journey_handoff_finance_v1(new.handoff_id);
  if not coalesce((f->>'trainingAllowed')::boolean,false) then raise exception 'training_financial_clearance_required'; end if;
 elsif tg_table_name='certificates' and new.status='issued' then
  if not exists(select 1 from academy.training_financial_links l join academy.enrollments e on e.tenant_id=l.tenant_id and e.handoff_id=l.handoff_id where e.tenant_id=new.tenant_id and e.id=new.enrollment_id) then return new; end if;
  f:=private_app.training_journey_financial_access_v1(new.enrollment_id);
  if not coalesce((f->>'certificationAllowed')::boolean,false) then raise exception 'training_certificate_financial_clearance_required'; end if;
 end if;
 return new;
end $function$;

revoke all on function private_app.academy_learning_transfer_v1(uuid,uuid) from public,anon,authenticated;
CREATE OR REPLACE FUNCTION public.v1_training_invitation_activation(p_token_hash text, p_claim_id uuid, p_action text DEFAULT 'claim'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare inv academy.training_invitations%rowtype;v_name text;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'training_service_role_required';end if;
 if p_claim_id is null or p_action not in ('claim','release') then raise exception 'training_activation_claim_invalid';end if;
 select * into inv from academy.training_invitations where token_hash=p_token_hash for update;
 if inv.id is null or inv.auth_mode<>'legacy' or inv.status<>'pending' or inv.expires_at<=now() or inv.tenant_id<>'3d185482-b916-49cc-b868-b6dfdb93eba8'::uuid then raise exception 'training_invitation_invalid';end if;
 if not exists(select 1 from core.tenants t join academy.training_journey_settings c on c.tenant_id=t.id and c.enabled where t.id=inv.tenant_id and t.slug='marktone' and t.status in ('active','trial')) or not private_app.tenant_addon_enabled(inv.tenant_id,'addon.training.lms') then raise exception 'training_journey_disabled';end if;
 if not exists(select 1 from academy.students st where st.tenant_id=inv.tenant_id and st.id=inv.student_id and st.status in ('active','graduated') and lower(trim(st.email))=inv.email) then raise exception 'training_invitation_invalid';end if;
 if p_action='release' then
  if inv.activation_claim_id is distinct from p_claim_id then raise exception 'training_activation_claim_invalid';end if;
  update academy.training_invitations set activation_claim_id=null,activation_claim_expires_at=null where id=inv.id;
  return jsonb_build_object('released',true);
 end if;
 if inv.activation_claim_id is not null and inv.activation_claim_expires_at>now() then raise exception 'training_activation_in_progress';end if;
 update academy.training_invitations set activation_claim_id=p_claim_id,activation_claim_expires_at=least(now()+interval '10 minutes',expires_at) where id=inv.id;
 select full_name into v_name from academy.students where tenant_id=inv.tenant_id and id=inv.student_id;
 return jsonb_build_object('email',inv.email,'fullName',v_name,'tenantSlug','marktone','expiresAt',inv.expires_at);
end $function$;

commit;
