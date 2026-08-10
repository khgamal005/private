-- Make the explicit analytics permission authoritative for tenant-wide report scope.
begin;

do $patch$
declare
  v_oid oid;
  v_definition text;
  v_existing text:=E'  v_view_team := (\n    v_is_platform\n    or v_role_key in (';
  v_replacement text:=E'  v_view_team := (\n    v_is_platform\n    or private_app.has_tenant_permission(\n      v_tenant.id,\n      ''tenant.reports.analytics''\n    )\n    or v_role_key in (';
begin
  select procedure.oid
  into v_oid
  from pg_proc procedure
  join pg_namespace namespace
    on namespace.oid=procedure.pronamespace
  where namespace.nspname='public'
    and procedure.proname='v2_tenant_reports_snapshot_v1'
    and pg_get_function_identity_arguments(procedure.oid)=
      'p_slug text, p_from date, p_to date, p_staff_id uuid, p_report text, p_limit integer, p_offset integer'
  limit 1;

  if v_oid is null then
    raise exception 'v2_tenant_reports_snapshot_v1_not_found';
  end if;

  v_definition:=pg_get_functiondef(v_oid);

  if position(
    E'    or private_app.has_tenant_permission(\n      v_tenant.id,\n      ''tenant.reports.analytics''\n    )\n    or v_role_key in ('
    in v_definition
  )>0 then
    return;
  end if;

  if position(v_existing in v_definition)=0 then
    raise exception 'v2_tenant_reports_snapshot_v1_scope_shape_changed';
  end if;

  execute replace(v_definition,v_existing,v_replacement);
end;
$patch$;

comment on function public.v2_tenant_reports_snapshot_v1(
  text,date,date,uuid,text,integer,integer
) is
  'Tenant reporting snapshot. tenant.reports.analytics grants tenant-wide aggregate scope and employee filtering; otherwise existing personal/management role scopes apply.';

notify pgrst,'reload schema';
commit;
