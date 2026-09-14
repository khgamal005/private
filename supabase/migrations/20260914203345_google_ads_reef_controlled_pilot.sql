-- ODEIR Google Ads: explicit, reporting-only protected-tenant approval.
-- No tenant is enabled by this migration. No CRM, finance or plan writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='30s';
alter table google_ads.rollouts
 add column protected_tenant_approved boolean not null default false,
 add column reporting_only boolean not null default false;

create or replace function google_ads.tenant(p_slug text,p_manage boolean default false,p_enabled boolean default true)
returns uuid language plpgsql stable set search_path='' as $$
declare t core.tenants%rowtype;
begin
 select * into t from core.tenants where slug=p_slug and status in('trial','active');
 if t.id is null then raise exception 'google_ads_tenant_not_found'; end if;
 if t.slug in('reef-skills','reefskills') and not (
  t.slug='reef-skills' and exists(
   select 1 from google_ads.rollouts r where r.tenant_id=t.id
    and r.protected_tenant_approved and r.reporting_only
  )
 ) then raise exception 'google_ads_protected_tenant'; end if;
 if auth.uid() is null or private_app.current_subject_id() is null
  or not coalesce(private_app.has_tenant_permission(t.id,'tenant.reports.campaigns'),false)
 then raise exception 'google_ads_forbidden'; end if;
 if p_manage and not coalesce(
  private_app.has_tenant_permission(t.id,'tenant.marketing.manage')
   or private_app.has_tenant_permission(t.id,'tenant.settings.manage'),false)
 then raise exception 'google_ads_forbidden'; end if;
 if p_enabled and (
  not coalesce(private_app.tenant_addon_enabled(t.id,'addon.integrations.google_ads_connect'),false)
  or not exists(select 1 from google_ads.rollouts r where r.tenant_id=t.id and r.enabled)
 ) then raise exception 'google_ads_not_enabled'; end if;
 return t.id;
end $$;

-- This check also protects direct authorized RPC requests that bypass the UI.
create function google_ads.guard_reporting_only_review()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if exists(select 1 from google_ads.rollouts r where r.tenant_id=new.tenant_id and r.reporting_only)
 then raise exception 'google_ads_reporting_only'; end if;
 return new;
end $$;
revoke all on function google_ads.guard_reporting_only_review() from public,anon,authenticated,service_role;
create trigger google_ads_reporting_only_commands before insert on google_ads.review_commands
for each row execute function google_ads.guard_reporting_only_review();
create trigger google_ads_reporting_only_sources before insert on google_ads.source_reviews
for each row execute function google_ads.guard_reporting_only_review();
comment on column google_ads.rollouts.protected_tenant_approved is
 'Explicit operator approval for the canonical protected tenant. Does not bypass permission, entitlement or rollout checks.';
comment on column google_ads.rollouts.reporting_only is
 'Disallows Google source-review writes. Disconnect remains available after disabling rollout; history is retained.';
commit;
