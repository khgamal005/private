begin;

-- A platform administrator must be able to stop a pending email-confirmation
-- request before the public capability is consumed.  The request row is the
-- serialization point shared with confirmation, so cancellation and
-- provisioning cannot both win.
create or replace function public.v1_platform_registration_email_cancel(
  p_request_id uuid,
  p_expected_version integer,
  p_notes text,
  p_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_actor uuid;
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_category text:=coalesce(nullif(trim(coalesce(p_category,'')),''),'other');
  v_at timestamptz:=pg_catalog.clock_timestamp();
  v_cancelled_deliveries integer:=0;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then
    raise exception 'platform_subject_not_found';
  end if;
  if v_notes is null or char_length(v_notes) not between 3 and 1200 then
    raise exception 'registration_email_cancel_reason_required';
  end if;
  if v_category not in (
    'incomplete_data','unable_to_verify','duplicate','not_eligible','other'
  ) then
    raise exception 'registration_email_cancel_category_invalid';
  end if;

  select request.* into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  if v_request.activation_mode<>'email_verified_trial'
     or v_request.institution_state<>'new'
     or v_request.external_account_id is not null
     or v_request.status<>'pending_review'
     or v_request.email_confirmed_at is not null
     or v_request.provisioned_tenant_id is not null then
    raise exception 'registration_email_cancel_not_allowed';
  end if;

  update platform.registration_requests request
  set status='rejected',
      reviewed_by_subject_id=v_actor,
      review_started_at=coalesce(request.review_started_at,v_at),
      reviewed_at=v_at,
      review_notes=v_notes,
      email_confirmation_token_hash=null,
      email_confirmation_expires_at=null,
      version=request.version+1,
      updated_at=v_at,
      metadata=request.metadata||jsonb_build_object(
        'emailCancellationAt',v_at,
        'emailCancellationSource','platform_admin',
        'emailCancellationCategory',v_category
      )
  where request.id=v_request.id
  returning * into v_request;

  -- Consume every issued alias first, then make every non-final confirmation
  -- generation non-actionable while retaining provider delivery evidence.
  perform private_app.registration_email_cancel_siblings(v_request.id);
  update platform.registration_email_deliveries delivery
  set state='cancelled',
      cancelled_at=coalesce(delivery.cancelled_at,v_at),
      lease_id=null,
      lease_expires_at=null,
      updated_at=v_at
  where delivery.request_id=v_request.id
    and delivery.state='accepted';
  get diagnostics v_cancelled_deliveries=row_count;

  insert into platform.registration_request_events(
    request_id,actor_subject_id,action,from_status,to_status,notes,metadata
  ) values (
    v_request.id,v_actor,'reject','pending_review','rejected',v_notes,
    jsonb_build_object(
      'category',v_category,
      'activationMode','email_verified_trial',
      'emailConfirmationInvalidated',true,
      'acceptedDeliveriesCancelled',v_cancelled_deliveries
    )
  );

  perform private_app.write_audit(
    'platform.registration_request.reject_pending_email',
    'registration_request',
    v_request.id::text,
    null,
    jsonb_build_object(
      'reference',v_request.request_reference,
      'fromStatus','pending_review',
      'toStatus','rejected',
      'requestVersion',v_request.version,
      'category',v_category,
      'emailConfirmationInvalidated',true,
      'tenantId',null
    )
  );

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status',v_request.status,
      'requestStatus',v_request.status,
      'queueStatus','rejected',
      'activationMode',v_request.activation_mode,
      'trustStatus',v_request.trust_status,
      'version',v_request.version,
      'reviewedAt',v_request.reviewed_at,
      'provisionedTenantId',v_request.provisioned_tenant_id
    ),
    'emailDelivery',jsonb_build_object(
      'state','cancelled',
      'confirmationInvalidated',true
    ),
    'provisioning',null,
    'automaticProvisioning',false
  );
end;
$$;

revoke all on function public.v1_platform_registration_email_cancel(
  uuid,integer,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_registration_email_cancel(
  uuid,integer,text,text
) to authenticated;

comment on function public.v1_platform_registration_email_cancel(
  uuid,integer,text,text
) is
  'Atomically rejects an unconfirmed email-activation request, invalidates all confirmation capabilities, releases its identity reservation through the rejection trigger, and never provisions or mutates a tenant.';

commit;
