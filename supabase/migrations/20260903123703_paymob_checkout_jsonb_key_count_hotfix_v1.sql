-- Paymob checkout hotfix:
-- PostgreSQL exposes jsonb_object_keys(), but not jsonb_object_length().
-- Patch only the known validation expression in the existing checkout
-- function and fail closed if the deployed definition is not the expected one.

do $migration$
declare
  v_signature regprocedure := pg_catalog.to_regprocedure(
    'public.v1_tenant_paymob_prepare_checkout(text,uuid,text,jsonb)'
  );
  v_definition text;
  v_needle constant text :=
    $needle$jsonb_object_length(coalesce(p_billing_contact, '{}'::jsonb))$needle$;
  v_replacement constant text :=
    $replacement$(select pg_catalog.count(*)
       from pg_catalog.jsonb_object_keys(
         coalesce(p_billing_contact, '{}'::jsonb)
       ) as billing_contact_key)$replacement$;
  v_occurrences integer;
begin
  if v_signature is null then
    raise exception 'paymob_prepare_checkout_function_missing';
  end if;

  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  v_occurrences := (
    pg_catalog.length(v_definition)
    - pg_catalog.length(pg_catalog.replace(v_definition, v_needle, ''))
  ) / pg_catalog.length(v_needle);

  if v_occurrences <> 1 then
    raise exception 'paymob_jsonb_key_count_patch_precondition_failed';
  end if;

  v_definition := pg_catalog.replace(
    v_definition,
    v_needle,
    v_replacement
  );
  execute v_definition;

  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  if pg_catalog.strpos(v_definition, v_needle) <> 0
     or pg_catalog.strpos(v_definition, v_replacement) = 0 then
    raise exception 'paymob_jsonb_key_count_patch_verification_failed';
  end if;
end;
$migration$;
