-- Paymob Hosted Redirect v2
--
-- QuickLink needs API Key to create/query and HMAC to authenticate callbacks.
-- Secret/Public keys may remain in Vault for historical Intention attempts, but
-- optional rows must never close the current QuickLink runtime gate.
--
-- This migration is deliberately replay-safe. A governed rollout may apply the
-- SQL through the Supabase Management API before the repository migration
-- version reaches an environment. Replaying the repository file therefore
-- verifies the exact postcondition instead of failing or mutating a second time.

create or replace function private_app.paymob_required_secret_refs_valid_v2(
  p_version_id uuid,
  p_environment text,
  p_checkout_flow text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  with selected_version as (
    select
      version.id,
      version.api_key_vault_secret_id,
      version.hmac_vault_secret_id,
      version.secret_key_vault_secret_id,
      version.public_key_vault_secret_id
    from marketplace.paymob_credential_versions version
    where version.id = p_version_id
      and version.provider_key = 'paymob'
      and version.environment = p_environment
      and version.checkout_flow = p_checkout_flow
      and version.status = 'active'
      and version.revoked_at is null
  ), required_secret(secret_key,vault_secret_id) as (
    select 'apiKey'::text,api_key_vault_secret_id
    from selected_version
    union all
    select 'hmacSecret'::text,hmac_vault_secret_id
    from selected_version
    union all
    select 'secretKey'::text,secret_key_vault_secret_id
    from selected_version
    where p_checkout_flow = 'intention'
    union all
    select 'publicKey'::text,public_key_vault_secret_id
    from selected_version
    where p_checkout_flow = 'intention'
  )
  select p_environment in ('sandbox','live')
    and p_checkout_flow in ('quicklink','intention')
    and exists (select 1 from selected_version)
    and not exists (
      select 1
      from required_secret required
      where required.vault_secret_id is null
         or not exists (
           select 1
           from marketplace.payment_provider_secret_refs secret_ref
           join vault.decrypted_secrets decrypted
             on decrypted.id = secret_ref.vault_secret_id
           where secret_ref.provider_key = 'paymob'
             and secret_ref.credentials_environment = p_environment
             and secret_ref.secret_key = required.secret_key
             and secret_ref.vault_secret_id = required.vault_secret_id
             and nullif(decrypted.decrypted_secret,'') is not null
         )
    )
$function$;

revoke all on function private_app.paymob_required_secret_refs_valid_v2(
  uuid,text,text
) from public,anon,authenticated,service_role;

do $migration$
declare
  v_definition text;
  v_before text;
  v_helper constant text :=
    'private_app.paymob_required_secret_refs_valid_v2(';
  v_helper_count integer;
begin
  -- Runtime claim gate -------------------------------------------------------
  select pg_get_functiondef(
    'public.v1_service_paymob_runtime_config(uuid,text,text)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);

  if v_helper_count = 0 then
    v_before := v_definition;
    v_definition := replace(
      v_definition,
$old_runtime$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_runtime$,
$new_runtime$
     or not private_app.paymob_required_secret_refs_valid_v2(
       v_version.id,v_attempt.environment,v_attempt.checkout_flow
     )
$new_runtime$
    );
    if v_definition = v_before then
      raise exception 'paymob_runtime_required_secret_patch_target_missing';
    end if;
    execute v_definition;
  elsif v_helper_count <> 1
     or strpos(
       v_definition,
$old_runtime$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_runtime$
     ) > 0 then
    raise exception 'paymob_runtime_required_secret_patch_conflict';
  end if;

  select pg_get_functiondef(
    'public.v1_service_paymob_runtime_config(uuid,text,text)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);
  if v_helper_count <> 1
     or strpos(
       v_definition,
$old_runtime$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_runtime$
     ) > 0 then
    raise exception 'paymob_runtime_required_secret_patch_postcondition_failed';
  end if;

  -- Resume gate --------------------------------------------------------------
  select pg_get_functiondef(
    'public.v1_service_paymob_resume_checkout(uuid)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);

  if v_helper_count = 0 then
    v_before := v_definition;
    v_definition := replace(
      v_definition,
$old_resume$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_resume$,
$new_resume$
     or not private_app.paymob_required_secret_refs_valid_v2(
       v_version.id,v_attempt.environment,v_attempt.checkout_flow
     )
$new_resume$
    );
    if v_definition = v_before then
      raise exception 'paymob_resume_required_secret_patch_target_missing';
    end if;
    execute v_definition;
  elsif v_helper_count <> 1
     or strpos(
       v_definition,
$old_resume$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_resume$
     ) > 0 then
    raise exception 'paymob_resume_required_secret_patch_conflict';
  end if;

  select pg_get_functiondef(
    'public.v1_service_paymob_resume_checkout(uuid)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);
  if v_helper_count <> 1
     or strpos(
       v_definition,
$old_resume$
     or v_bound_secret_ref_count <> (
       case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
     )
$old_resume$
     ) > 0 then
    raise exception 'paymob_resume_required_secret_patch_postcondition_failed';
  end if;

  -- Provider-create persistence gate ----------------------------------------
  select pg_get_functiondef(
    'public.v1_service_paymob_record_intention(uuid,uuid,text,text,text,text,timestamptz,text,text,text)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);

  if v_helper_count = 0 then
    v_before := v_definition;
    v_definition := replace(
      v_definition,
$old_record$
       or v_bound_secret_count <> (
         case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
       ) then
$old_record$,
$new_record$
       or not private_app.paymob_required_secret_refs_valid_v2(
         v_version.id,v_attempt.environment,v_attempt.checkout_flow
       ) then
$new_record$
    );
    if v_definition = v_before then
      raise exception 'paymob_record_required_secret_patch_target_missing';
    end if;
    execute v_definition;
  elsif v_helper_count <> 1
     or strpos(
       v_definition,
$old_record$
       or v_bound_secret_count <> (
         case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
       ) then
$old_record$
     ) > 0 then
    raise exception 'paymob_record_required_secret_patch_conflict';
  end if;

  select pg_get_functiondef(
    'public.v1_service_paymob_record_intention(uuid,uuid,text,text,text,text,timestamptz,text,text,text)'::regprocedure
  ) into v_definition;
  v_helper_count := (
    length(v_definition)-length(replace(v_definition,v_helper,''))
  )/length(v_helper);
  if v_helper_count <> 1
     or strpos(
       v_definition,
$old_record$
       or v_bound_secret_count <> (
         case when v_attempt.checkout_flow = 'quicklink' then 2 else 4 end
       ) then
$old_record$
     ) > 0 then
    raise exception 'paymob_record_required_secret_patch_postcondition_failed';
  end if;
end
$migration$;
