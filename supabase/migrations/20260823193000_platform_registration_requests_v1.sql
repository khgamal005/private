begin;

create table if not exists platform.registration_requests (
  id uuid primary key default gen_random_uuid(),
  request_reference text not null unique,
  source text not null default 'odeir_public_registration'
    check (source in ('odeir_public_registration','marktone_legacy_import')),
  source_request_id uuid,
  external_account_id uuid,
  institution_state text not null
    check (institution_state in ('existing','new')),
  institution_name text not null
    check (char_length(institution_name) between 2 and 240),
  commercial_registration text,
  national_registration text,
  tvtc_license_number text,
  contact_name text not null
    check (char_length(contact_name) between 2 and 160),
  contact_job_title text not null
    check (char_length(contact_job_title) between 2 and 160),
  contact_email text not null
    check (position('@' in contact_email)>1),
  contact_phone text not null
    check (char_length(contact_phone) between 8 and 24),
  status text not null default 'pending_review'
    check (status in (
      'pending_review','under_review','approved','rejected','converted'
    )),
  tvtc_notice_acknowledged boolean not null default false
    check (tvtc_notice_acknowledged),
  privacy_consent_at timestamptz not null,
  request_ip_hash text
    check (request_ip_hash is null or request_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text
    check (user_agent_hash is null or user_agent_hash ~ '^[a-f0-9]{64}$'),
  reviewed_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  review_started_at timestamptz,
  reviewed_at timestamptz,
  review_notes text,
  provisioned_tenant_id uuid unique
    references core.tenants(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  version integer not null default 1 check (version>0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source,source_request_id)
);

create index if not exists platform_registration_status_created_idx
on platform.registration_requests(status,created_at);

create index if not exists platform_registration_reference_search_idx
on platform.registration_requests(lower(request_reference));

create index if not exists platform_registration_name_search_idx
on platform.registration_requests(lower(institution_name));

create index if not exists platform_registration_email_created_idx
on platform.registration_requests(lower(contact_email),created_at desc);

create index if not exists platform_registration_external_account_idx
on platform.registration_requests(external_account_id)
where external_account_id is not null;

create table if not exists platform.registration_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null
    references platform.registration_requests(id) on delete cascade,
  actor_subject_id uuid
    references access_control.subjects(id) on delete set null,
  action text not null check (action in (
    'submitted','imported','start_review','approve','reject','reopen','provision'
  )),
  from_status text,
  to_status text not null,
  notes text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now()
);

create index if not exists platform_registration_events_request_time_idx
on platform.registration_request_events(request_id,created_at desc,id desc);

create table if not exists platform.registration_rate_limits (
  rate_key text primary key check (char_length(rate_key) between 16 and 160),
  window_started_at timestamptz not null,
  hit_count integer not null check (hit_count>0),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists platform_registration_rate_expiry_idx
on platform.registration_rate_limits(expires_at);

drop trigger if exists platform_registration_requests_set_updated_at
on platform.registration_requests;
create trigger platform_registration_requests_set_updated_at
before update on platform.registration_requests
for each row execute function private_app.set_updated_at();

alter table platform.registration_requests enable row level security;
alter table platform.registration_request_events enable row level security;
alter table platform.registration_rate_limits enable row level security;

revoke all on table platform.registration_requests
from public,anon,authenticated;
revoke all on table platform.registration_request_events
from public,anon,authenticated;
revoke all on table platform.registration_rate_limits
from public,anon,authenticated;
revoke all on sequence platform.registration_request_events_id_seq
from public,anon,authenticated;

grant select,insert,update on table platform.registration_requests
to service_role;
grant select,insert on table platform.registration_request_events
to service_role;
grant select,insert,update,delete on table platform.registration_rate_limits
to service_role;
grant usage,select on sequence platform.registration_request_events_id_seq
to service_role;

create or replace function public.v1_registration_rate_limit_consume(
  p_rate_key text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path=''
as $$
declare
  v_hits integer;
  v_now timestamptz:=now();
begin
  if p_rate_key is null or char_length(p_rate_key) not between 16 and 160
     or p_limit not between 1 and 1000
     or p_window_seconds not between 60 and 172800 then
    raise exception 'invalid_rate_limit';
  end if;

  delete from platform.registration_rate_limits rate
  where rate.rate_key in (
    select expired.rate_key
    from platform.registration_rate_limits expired
    where expired.expires_at < v_now-interval '7 days'
    order by expired.expires_at
    limit 20
  );

  insert into platform.registration_rate_limits(
    rate_key,window_started_at,hit_count,expires_at,updated_at
  ) values (
    p_rate_key,v_now,1,v_now+make_interval(secs=>p_window_seconds),v_now
  )
  on conflict (rate_key) do update
  set window_started_at=case
        when platform.registration_rate_limits.expires_at<=v_now then v_now
        else platform.registration_rate_limits.window_started_at
      end,
      hit_count=case
        when platform.registration_rate_limits.expires_at<=v_now then 1
        else least(platform.registration_rate_limits.hit_count+1,p_limit+1)
      end,
      expires_at=case
        when platform.registration_rate_limits.expires_at<=v_now
          then v_now+make_interval(secs=>p_window_seconds)
        else platform.registration_rate_limits.expires_at
      end,
      updated_at=v_now
  returning hit_count into v_hits;

  return v_hits<=p_limit;
end;
$$;

create or replace function public.v1_public_submit_registration_request(
  p_payload jsonb,
  p_ip_hash text,
  p_user_agent_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_state text:=trim(coalesce(p_payload->>'institutionState',''));
  v_account_id uuid;
  v_name text:=trim(coalesce(p_payload->>'institutionName',''));
  v_contact_name text:=trim(coalesce(p_payload->>'contactName',''));
  v_contact_title text:=trim(coalesce(p_payload->>'contactJobTitle',''));
  v_contact_email text:=lower(trim(coalesce(p_payload->>'contactEmail','')));
  v_contact_phone text:=trim(coalesce(p_payload->>'contactPhone',''));
  v_commercial text:=nullif(regexp_replace(
    coalesce(p_payload->>'commercialRegistration',''),'[^0-9]','','g'
  ),'');
  v_national text:=nullif(regexp_replace(
    coalesce(p_payload->>'nationalRegistration',''),'[^0-9]','','g'
  ),'');
  v_tvtc text:=nullif(trim(coalesce(p_payload->>'tvtcLicenseNumber','')),'');
  v_duplicate platform.registration_requests%rowtype;
  v_request platform.registration_requests%rowtype;
  v_reference text;
  v_attempt integer;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'registration_payload_invalid';
  end if;
  if v_state not in ('existing','new') then
    raise exception 'invalid_institution_state';
  end if;
  if coalesce((p_payload->>'tvtcAcknowledged')::boolean,false) is not true
     or coalesce((p_payload->>'privacyConsent')::boolean,false) is not true then
    raise exception 'consent_required';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
     or (p_user_agent_hash is not null
         and p_user_agent_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'registration_fingerprint_invalid';
  end if;
  if char_length(v_name) not between 2 and 240 then
    raise exception 'institution_name_required';
  end if;
  if char_length(v_contact_name) not between 2 and 160 then
    raise exception 'contact_name_required';
  end if;
  if char_length(v_contact_title) not between 2 and 160 then
    raise exception 'job_title_required';
  end if;
  if v_contact_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or char_length(v_contact_email)>240 then
    raise exception 'invalid_email';
  end if;
  if char_length(v_contact_phone) not between 8 and 24 then
    raise exception 'invalid_phone';
  end if;
  if (v_commercial is not null and char_length(v_commercial)>24)
     or (v_national is not null and char_length(v_national)>24)
     or (v_tvtc is not null and char_length(v_tvtc)>80) then
    raise exception 'registration_identifier_invalid';
  end if;

  if nullif(trim(coalesce(p_payload->>'accountId','')),'') is not null then
    if (p_payload->>'accountId') !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_external_account';
    end if;
    v_account_id:=(p_payload->>'accountId')::uuid;
  end if;
  if v_state='existing' and v_account_id is null then
    raise exception 'institution_required';
  end if;

  select request.* into v_duplicate
  from platform.registration_requests request
  where lower(request.contact_email)=v_contact_email
    and request.created_at>=now()-interval '24 hours'
    and (
      (v_account_id is not null and request.external_account_id=v_account_id)
      or (v_account_id is null and request.institution_state='new')
    )
  order by request.created_at desc
  limit 1;

  if v_duplicate.id is not null then
    return jsonb_build_object(
      'duplicate',true,
      'reference',v_duplicate.request_reference,
      'status',v_duplicate.status,
      'message','request_already_received'
    );
  end if;

  for v_attempt in 1..8 loop
    v_reference:='MT-'||to_char(current_date,'YYYYMMDD')||'-'||upper(substr(
      replace(gen_random_uuid()::text,'-',''),1,6
    ));
    exit when not exists(
      select 1 from platform.registration_requests existing
      where existing.request_reference=v_reference
    );
  end loop;
  if exists(
    select 1 from platform.registration_requests existing
    where existing.request_reference=v_reference
  ) then
    raise exception 'registration_reference_unavailable';
  end if;

  insert into platform.registration_requests(
    request_reference,source,external_account_id,institution_state,
    institution_name,commercial_registration,national_registration,
    tvtc_license_number,contact_name,contact_job_title,contact_email,
    contact_phone,tvtc_notice_acknowledged,privacy_consent_at,
    request_ip_hash,user_agent_hash,metadata
  ) values (
    v_reference,'odeir_public_registration',v_account_id,v_state,
    v_name,v_commercial,v_national,v_tvtc,v_contact_name,v_contact_title,
    v_contact_email,v_contact_phone,true,now(),p_ip_hash,p_user_agent_hash,
    jsonb_build_object(
      'page','registration-modal',
      'locale','ar-SA',
      'submittedAt',now()
    )
  ) returning * into v_request;

  insert into platform.registration_request_events(
    request_id,action,to_status,metadata
  ) values (
    v_request.id,'submitted',v_request.status,
    jsonb_build_object('source',v_request.source)
  );

  return jsonb_build_object(
    'duplicate',false,
    'reference',v_request.request_reference,
    'status',v_request.status,
    'expectedResponse','one_business_day'
  );
end;
$$;

create or replace function public.v1_platform_registration_requests_snapshot(
  p_status text default null,
  p_query text default null,
  p_offset integer default 0,
  p_limit integer default 25
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_status text:=nullif(trim(coalesce(p_status,'')),'');
  v_query text:=lower(nullif(trim(coalesce(p_query,'')),''));
  v_offset integer:=greatest(0,least(coalesce(p_offset,0),100000));
  v_limit integer:=greatest(1,least(coalesce(p_limit,25),50));
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  if v_status is not null and v_status not in (
    'pending_review','under_review','approved','rejected','converted'
  ) then
    raise exception 'registration_status_invalid';
  end if;
  if v_query is not null and char_length(v_query)>80 then
    raise exception 'registration_query_invalid';
  end if;

  return jsonb_build_object(
    'summary',jsonb_build_object(
      'pendingReview',count(*) filter(
        where request.status='pending_review'
          and not (
            coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
            and to_jsonb(request)->>'email_confirmed_at' is null
          )
      ),
      'awaitingEmail',count(*) filter(
        where request.status='pending_review'
          and coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
          and to_jsonb(request)->>'email_confirmed_at' is null
      ),
      'underReview',count(*) filter(where request.status='under_review'),
      'approved',count(*) filter(where request.status='approved'),
      'rejected',count(*) filter(where request.status='rejected'),
      'converted',count(*) filter(where request.status='converted'),
      'trustPending',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review') in (
            'pending_review','under_review'
          )
      ),
      'trusted',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review')='trusted'
      ),
      'trustRestricted',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review')='restricted'
      ),
      'overdue',count(*) filter(where request.status in ('pending_review','under_review')
        and request.created_at<now()-interval '24 hours'),
      'oldestPendingAt',min(request.created_at) filter(
        where request.status in ('pending_review','under_review')
      )
    ),
    'total',(
      select count(*)
      from platform.registration_requests filtered
      where (v_status is null or filtered.status=v_status)
        and (
          v_query is null
          or lower(filtered.request_reference) like '%'||v_query||'%'
          or lower(filtered.institution_name) like '%'||v_query||'%'
          or coalesce(filtered.commercial_registration,'') like '%'||v_query||'%'
          or coalesce(filtered.national_registration,'') like '%'||v_query||'%'
          or lower(coalesce(filtered.tvtc_license_number,'')) like '%'||v_query||'%'
        )
    ),
    'offset',v_offset,
    'limit',v_limit,
    'items',coalesce((
      select jsonb_agg(row_data.payload order by
        row_data.active_rank,row_data.active_created,row_data.created_at desc
      )
      from (
        select
          case when filtered.status in ('pending_review','under_review')
            then 0 else 1 end as active_rank,
          case when filtered.status in ('pending_review','under_review')
            then filtered.created_at end as active_created,
          filtered.created_at,
          jsonb_build_object(
            'id',filtered.id,
            'reference',filtered.request_reference,
            'institutionState',filtered.institution_state,
            'institutionName',filtered.institution_name,
            'commercialRegistration',filtered.commercial_registration,
            'nationalRegistration',filtered.national_registration,
            'tvtcLicenseNumber',filtered.tvtc_license_number,
            'status',case
              when filtered.status='pending_review'
                and coalesce(to_jsonb(filtered)->>'activation_mode','manual_review')='email_verified_trial'
                and to_jsonb(filtered)->>'email_confirmed_at' is null
                then 'awaiting_email'
              when filtered.status='converted'
                and coalesce(to_jsonb(filtered)->>'activation_mode','manual_review')='email_verified_trial'
                and coalesce(to_jsonb(filtered)->>'trust_status','pending_review')='pending_review'
                then 'trust_pending'
              when filtered.status='converted'
                and coalesce(to_jsonb(filtered)->>'activation_mode','manual_review')='email_verified_trial'
                and coalesce(to_jsonb(filtered)->>'trust_status','pending_review')='under_review'
                then 'trust_review'
              when filtered.status='converted'
                and coalesce(to_jsonb(filtered)->>'activation_mode','manual_review')='email_verified_trial'
                and coalesce(to_jsonb(filtered)->>'trust_status','pending_review')='restricted'
                then 'trust_restricted'
              else filtered.status
            end,
            'requestStatus',filtered.status,
            'activationMode',coalesce(
              to_jsonb(filtered)->>'activation_mode','manual_review'
            ),
            'trustStatus',coalesce(
              to_jsonb(filtered)->>'trust_status','pending_review'
            ),
            'emailConfirmedAt',to_jsonb(filtered)->>'email_confirmed_at',
            'reviewerName',reviewer.full_name,
            'reviewStartedAt',filtered.review_started_at,
            'reviewedAt',filtered.reviewed_at,
            'provisionedTenantId',filtered.provisioned_tenant_id,
            'provisionedTenantSlug',tenant.slug,
            'version',filtered.version,
            'createdAt',filtered.created_at,
            'updatedAt',filtered.updated_at
          ) as payload
        from platform.registration_requests filtered
        left join access_control.subjects reviewer
          on reviewer.id=filtered.reviewed_by_subject_id
        left join core.tenants tenant
          on tenant.id=filtered.provisioned_tenant_id
        where (v_status is null or filtered.status=v_status)
          and (
            v_query is null
            or lower(filtered.request_reference) like '%'||v_query||'%'
            or lower(filtered.institution_name) like '%'||v_query||'%'
            or coalesce(filtered.commercial_registration,'') like '%'||v_query||'%'
            or coalesce(filtered.national_registration,'') like '%'||v_query||'%'
            or lower(coalesce(filtered.tvtc_license_number,'')) like '%'||v_query||'%'
          )
        order by
          case when filtered.status in ('pending_review','under_review')
            then 0 else 1 end,
          case when filtered.status in ('pending_review','under_review')
            then filtered.created_at end,
          filtered.created_at desc
        limit v_limit offset v_offset
      ) row_data
    ),'[]'::jsonb)
  )
  from platform.registration_requests request;
end;
$$;

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
  select request
  into v_request
  from platform.registration_requests request
  where request.id=p_request_id;

  select reviewer.full_name,tenant.slug
  into v_reviewer_name,v_tenant_slug
  from platform.registration_requests request
  left join access_control.subjects reviewer
    on reviewer.id=request.reviewed_by_subject_id
  left join core.tenants tenant
    on tenant.id=request.provisioned_tenant_id
  where request.id=p_request_id;
  if v_request.id is null then raise exception 'registration_request_not_found'; end if;

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

create or replace function public.v1_platform_registration_requests_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  return (
    select jsonb_build_object(
      'pendingReview',count(*) filter(
        where request.status='pending_review'
          and not (
            coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
            and to_jsonb(request)->>'email_confirmed_at' is null
          )
      ),
      'awaitingEmail',count(*) filter(
        where request.status='pending_review'
          and coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
          and to_jsonb(request)->>'email_confirmed_at' is null
      ),
      'underReview',count(*) filter(where request.status='under_review'),
      'approved',count(*) filter(where request.status='approved'),
      'trustPending',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'activation_mode','manual_review')='email_verified_trial'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review') in (
            'pending_review','under_review'
          )
      ),
      'trusted',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review')='trusted'
      ),
      'trustRestricted',count(*) filter(
        where request.status='converted'
          and coalesce(to_jsonb(request)->>'trust_status','pending_review')='restricted'
      ),
      'overdue',count(*) filter(
        where request.status in ('pending_review','under_review')
          and request.created_at<now()-interval '24 hours'
      )
    )
    from platform.registration_requests request
  );
end;
$$;

create or replace function public.v1_platform_registration_request_action(
  p_request_id uuid,
  p_action text,
  p_expected_version integer,
  p_notes text default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_request platform.registration_requests%rowtype;
  v_actor uuid;
  v_action text:=trim(coalesce(p_action,''));
  v_notes text:=nullif(trim(coalesce(p_notes,'')),'');
  v_from_status text;
  v_to_status text;
  v_provisioning jsonb;
  v_existing_tenant core.tenants%rowtype;
begin
  if not private_app.has_platform_permission('platform.tenants.manage') then
    raise exception 'forbidden';
  end if;
  v_actor:=private_app.current_subject_id();
  if v_actor is null then raise exception 'platform_subject_not_found'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' then
    raise exception 'registration_payload_invalid';
  end if;
  if v_notes is not null and char_length(v_notes)>1200 then
    raise exception 'registration_notes_too_long';
  end if;

  select * into v_request
  from platform.registration_requests request
  where request.id=p_request_id
  for update;
  if v_request.id is null then raise exception 'registration_request_not_found'; end if;
  if coalesce(to_jsonb(v_request)->>'activation_mode','manual_review')=
     'email_verified_trial' then
    raise exception 'registration_email_activation_managed';
  end if;
  if v_action='provision'
     and v_request.status='converted'
     and v_request.provisioned_tenant_id is not null then
    select * into v_existing_tenant
    from core.tenants tenant where tenant.id=v_request.provisioned_tenant_id;
    return jsonb_build_object(
      'request',jsonb_build_object(
        'id',v_request.id,'reference',v_request.request_reference,
        'status',v_request.status,'version',v_request.version,
        'provisionedTenantId',v_request.provisioned_tenant_id
      ),
      'provisioning',jsonb_build_object(
        'id',v_existing_tenant.id,'slug',v_existing_tenant.slug,
        'status',v_existing_tenant.status,'replayed',true
      )
    );
  end if;
  if p_expected_version is null or p_expected_version<>v_request.version then
    raise exception 'registration_request_conflict';
  end if;
  v_from_status:=v_request.status;

  if v_action='start_review' then
    if v_request.status<>'pending_review' then
      raise exception 'registration_transition_invalid';
    end if;
    v_to_status:='under_review';
    update platform.registration_requests
    set status=v_to_status,
        reviewed_by_subject_id=v_actor,
        review_started_at=coalesce(review_started_at,now()),
        version=version+1
    where id=v_request.id
    returning * into v_request;
  elsif v_action='approve' then
    if v_request.status<>'under_review' then
      raise exception 'registration_transition_invalid';
    end if;
    v_to_status:='approved';
    update platform.registration_requests
    set status=v_to_status,
        reviewed_by_subject_id=v_actor,
        reviewed_at=now(),
        review_notes=v_notes,
        version=version+1
    where id=v_request.id
    returning * into v_request;
  elsif v_action='reject' then
    if v_request.status<>'under_review' then
      raise exception 'registration_transition_invalid';
    end if;
    if v_notes is null or char_length(v_notes)<3 then
      raise exception 'registration_rejection_reason_required';
    end if;
    v_to_status:='rejected';
    update platform.registration_requests
    set status=v_to_status,
        reviewed_by_subject_id=v_actor,
        reviewed_at=now(),
        review_notes=v_notes,
        version=version+1
    where id=v_request.id
    returning * into v_request;
  elsif v_action='reopen' then
    if v_request.status<>'rejected' then
      raise exception 'registration_transition_invalid';
    end if;
    if v_notes is null or char_length(v_notes)<3 then
      raise exception 'registration_reopen_reason_required';
    end if;
    v_to_status:='under_review';
    update platform.registration_requests
    set status=v_to_status,
        reviewed_by_subject_id=v_actor,
        review_started_at=now(),
        reviewed_at=null,
        review_notes=null,
        version=version+1
    where id=v_request.id
    returning * into v_request;
  elsif v_action='provision' then
    if v_request.status<>'approved' then
      raise exception 'registration_transition_invalid';
    end if;
    if v_request.institution_state<>'new'
       or v_request.external_account_id is not null then
      raise exception 'registration_existing_institution_requires_manual_link';
    end if;
    if exists(
      select 1 from platform.registration_requests other
      where other.id<>v_request.id
        and other.provisioned_tenant_id is not null
        and (
          (nullif(v_request.commercial_registration,'') is not null
            and regexp_replace(other.commercial_registration,'[^0-9]','','g')=
              regexp_replace(v_request.commercial_registration,'[^0-9]','','g'))
          or (nullif(v_request.national_registration,'') is not null
            and regexp_replace(other.national_registration,'[^0-9]','','g')=
              regexp_replace(v_request.national_registration,'[^0-9]','','g'))
        )
    ) then
      raise exception 'registration_identifier_already_provisioned';
    end if;

    v_provisioning:=public.v2_platform_provision_tenant(
      p_payload->>'displayName',
      coalesce(nullif(p_payload->>'legalName',''),p_payload->>'displayName'),
      p_payload->>'slug',
      coalesce(nullif(p_payload->>'countryCode',''),'SA'),
      coalesce(nullif(p_payload->>'timezone',''),'Asia/Riyadh'),
      coalesce(nullif(p_payload->>'planKey',''),'free'),
      coalesce(nullif(p_payload->>'ownerName',''),v_request.contact_name),
      coalesce(nullif(p_payload->>'ownerEmail',''),v_request.contact_email),
      nullif(p_payload->>'hostname','')
    );
    v_to_status:='converted';
    update platform.registration_requests
    set status=v_to_status,
        provisioned_tenant_id=(v_provisioning->>'id')::uuid,
        reviewed_by_subject_id=v_actor,
        version=version+1,
        metadata=metadata||jsonb_build_object(
          'provisionedAt',now(),
          'provisionedSlug',v_provisioning->>'slug'
        )
    where id=v_request.id
    returning * into v_request;
  else
    raise exception 'registration_action_invalid';
  end if;

  insert into platform.registration_request_events(
    request_id,actor_subject_id,action,from_status,to_status,notes,metadata
  ) values (
    v_request.id,v_actor,v_action,v_from_status,v_to_status,v_notes,
    case when v_action='provision' then jsonb_build_object(
      'tenantId',v_request.provisioned_tenant_id,
      'tenantSlug',v_provisioning->>'slug'
    ) else '{}'::jsonb end
  );

  perform private_app.write_audit(
    'platform.registration_request.'||v_action,
    'registration_request',
    v_request.id::text,
    null,
    jsonb_strip_nulls(jsonb_build_object(
      'reference',v_request.request_reference,
      'fromStatus',v_from_status,
      'toStatus',v_to_status,
      'tenantId',v_request.provisioned_tenant_id
    ))
  );

  return jsonb_build_object(
    'request',jsonb_build_object(
      'id',v_request.id,
      'reference',v_request.request_reference,
      'status',v_request.status,
      'version',v_request.version,
      'reviewedAt',v_request.reviewed_at,
      'provisionedTenantId',v_request.provisioned_tenant_id
    ),
    'provisioning',v_provisioning
  );
end;
$$;

revoke all on function public.v1_registration_rate_limit_consume(text,integer,integer)
from public,anon,authenticated;
revoke all on function public.v1_public_submit_registration_request(jsonb,text,text)
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_requests_snapshot(text,text,integer,integer)
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_request_detail(uuid)
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_requests_summary()
from public,anon,authenticated;
revoke all on function public.v1_platform_registration_request_action(uuid,text,integer,text,jsonb)
from public,anon,authenticated;

grant execute on function public.v1_registration_rate_limit_consume(text,integer,integer)
to service_role;
grant execute on function public.v1_public_submit_registration_request(jsonb,text,text)
to service_role;
grant execute on function public.v1_platform_registration_requests_snapshot(text,text,integer,integer)
to authenticated;
grant execute on function public.v1_platform_registration_request_detail(uuid)
to authenticated;
grant execute on function public.v1_platform_registration_requests_summary()
to authenticated;
grant execute on function public.v1_platform_registration_request_action(uuid,text,integer,text,jsonb)
to authenticated;

comment on table platform.registration_requests is
'Pre-tenant ODEIR registration requests. No tenant data is read or changed until an explicit provision action.';
comment on table platform.registration_request_events is
'Append-only review and provisioning history for ODEIR registration requests.';
comment on function public.v1_platform_registration_request_action(uuid,text,integer,text,jsonb) is
'Permission-checked, version-checked request lifecycle. Approval and provisioning are separate actions.';

commit;
