begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Commercial entitlement remains mandatory at every existing Google RPC.
-- Only fill a missing runtime record; an explicit false is an operator kill switch.
create function google_ads.enable_entitled_tenant_v1(p_tenant_id uuid,p_reason text)
returns boolean language plpgsql security definer set search_path='' as $$
declare inserted_id uuid;
begin
 if not exists(select 1 from core.tenants t where t.id=p_tenant_id
   and t.status in ('active','trial') and lower(t.slug) not in ('reef-skills','reefskills')) then return false;end if;
 if not coalesce(private_app.tenant_addon_enabled(p_tenant_id,'addon.integrations.google_ads_connect'),false) then return false;end if;
 insert into google_ads.rollouts(tenant_id,enabled) values(p_tenant_id,true)
 on conflict(tenant_id) do nothing returning tenant_id into inserted_id;
 if inserted_id is null then return false;end if;
 insert into audit_log.events(tenant_id,actor_subject_id,action,resource_type,resource_id,context)
 values(p_tenant_id,private_app.current_subject_id(),'google_ads.runtime_activated','google_ads.rollout',p_tenant_id::text,
 jsonb_build_object('reason',left(coalesce(p_reason,'entitlement'),100),'entitlementChecked',true));
 return true;
end $$;
revoke all on function google_ads.enable_entitled_tenant_v1(uuid,text) from public,anon,authenticated,service_role;

create function google_ads.subscription_activation_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from catalog.addon_products p where p.id=new.product_id and p.product_key='google_ads_connect') then
  perform google_ads.enable_entitled_tenant_v1(new.tenant_id,'subscription_activation');
 end if;
 return new;
end $$;
revoke all on function google_ads.subscription_activation_v1() from public,anon,authenticated,service_role;
create trigger google_kit_subscription_activation_v1
 after insert or update of status,period_start,period_end,trial_start,trial_end,product_id
 on catalog.tenant_addon_subscriptions for each row
 execute function google_ads.subscription_activation_v1();

-- Preserve the entire existing marketplace permission/payment gateway.
alter function public.v2_tenant_marketplace_action(text,text,jsonb)
 rename to v2_tenant_marketplace_action_before_google_activation_v1;
alter function public.v2_tenant_marketplace_action_before_google_activation_v1(text,text,jsonb) set schema private_app;
revoke all on function private_app.v2_tenant_marketplace_action_before_google_activation_v1(text,text,jsonb)
 from public,anon,authenticated,service_role;
create function public.v2_tenant_marketplace_action(p_slug text,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;tenant_id uuid;
begin
 result:=private_app.v2_tenant_marketplace_action_before_google_activation_v1(p_slug,p_action,p_payload);
 if (p_action='activate_free_addon' or (p_action='create_order' and p_payload->>'itemType'='addon')) and p_payload->>'productKey'='google_ads_connect' then
  select id into tenant_id from core.tenants where slug=p_slug;
  perform google_ads.enable_entitled_tenant_v1(tenant_id,'marketplace_activation');
 end if;
 return result;
end $$;
revoke all on function public.v2_tenant_marketplace_action(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.v2_tenant_marketplace_action(text,text,jsonb) to authenticated;

-- Scoped repair requested by the owner; no sweep of other tenants or data.
select google_ads.enable_entitled_tenant_v1(t.id,'marktone_existing_entitlement_repair')
from core.tenants t where t.slug='marktone';
commit;
