-- Fix the platform registration detail reader without touching request data.
--
-- A table alias is a single composite value in PL/pgSQL. Selecting the alias
-- directly into a %rowtype variable attempts to cast that composite value into
-- the first UUID field. Expanding the alias assigns every column correctly.

create or replace function public.v1_platform_registration_request_detail(
  p_request_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_reviewer_name text;
  v_tenant_slug text;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;

  select request.*
  into v_request
  from platform.registration_requests request
  where request.id=p_request_id;

  if v_request.id is null then
    raise exception 'registration_request_not_found';
  end if;

  select reviewer.full_name,tenant.slug
  into v_reviewer_name,v_tenant_slug
  from platform.registration_requests request
  left join access_control.subjects reviewer
    on reviewer.id=request.reviewed_by_subject_id
  left join core.tenants tenant
    on tenant.id=request.provisioned_tenant_id
  where request.id=p_request_id;

  return jsonb_build_object(
    'id',v_request.id,
    'reference',v_request.request_reference,
    'source',v_request.source,
    'institutionState',v_request.institution_state,
    'externalAccountId',v_request.external_account_id,
    'institutionName',v_request.institution_name,
    'commercialRegistration',v_request.commercial_registration,
    'nationalRegistration',v_request.national_registration,
    'tvtcLicenseNumber',v_request.tvtc_license_number,
    'contactName',v_request.contact_name,
    'contactJobTitle',v_request.contact_job_title,
    'contactEmail',v_request.contact_email,
    'contactPhone',v_request.contact_phone,
    'status',case
      when v_request.status='pending_review'
        and coalesce(to_jsonb(v_request)->>'activation_mode','manual_review')='email_verified_trial'
        and to_jsonb(v_request)->>'email_confirmed_at' is null
        then 'awaiting_email'
      when v_request.status='converted'
        and coalesce(to_jsonb(v_request)->>'activation_mode','manual_review')='email_verified_trial'
        and coalesce(to_jsonb(v_request)->>'trust_status','pending_review')='pending_review'
        then 'trust_pending'
      when v_request.status='converted'
        and coalesce(to_jsonb(v_request)->>'activation_mode','manual_review')='email_verified_trial'
        and coalesce(to_jsonb(v_request)->>'trust_status','pending_review')='under_review'
        then 'trust_review'
      when v_request.status='converted'
        and coalesce(to_jsonb(v_request)->>'activation_mode','manual_review')='email_verified_trial'
        and coalesce(to_jsonb(v_request)->>'trust_status','pending_review')='restricted'
        then 'trust_restricted'
      else v_request.status
    end,
    'requestStatus',v_request.status,
    'activationMode',coalesce(
      to_jsonb(v_request)->>'activation_mode','manual_review'
    ),
    'trustStatus',coalesce(to_jsonb(v_request)->>'trust_status','pending_review'),
    'emailConfirmationSentAt',to_jsonb(v_request)->>'email_confirmation_sent_at',
    'emailConfirmedAt',to_jsonb(v_request)->>'email_confirmed_at',
    'tvtcNoticeAcknowledged',v_request.tvtc_notice_acknowledged,
    'privacyConsentAt',v_request.privacy_consent_at,
    'reviewerName',v_reviewer_name,
    'reviewStartedAt',v_request.review_started_at,
    'reviewedAt',v_request.reviewed_at,
    'reviewNotes',v_request.review_notes,
    'provisionedTenantId',v_request.provisioned_tenant_id,
    'provisionedTenantSlug',v_tenant_slug,
    'version',v_request.version,
    'createdAt',v_request.created_at,
    'updatedAt',v_request.updated_at,
    'events',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',event.id,
        'action',event.action,
        'fromStatus',event.from_status,
        'toStatus',event.to_status,
        'notes',event.notes,
        'actorName',actor.full_name,
        'createdAt',event.created_at
      ) order by event.created_at,event.id)
      from platform.registration_request_events event
      left join access_control.subjects actor on actor.id=event.actor_subject_id
      where event.request_id=v_request.id
    ),'[]'::jsonb)
  );
end;
$$;

revoke all on function public.v1_platform_registration_request_detail(uuid)
from public,anon,authenticated;

grant execute on function public.v1_platform_registration_request_detail(uuid)
to authenticated;

comment on function public.v1_platform_registration_request_detail(uuid) is
'Returns one authorized platform registration request with reviewer, tenant, and append-only event details.';
