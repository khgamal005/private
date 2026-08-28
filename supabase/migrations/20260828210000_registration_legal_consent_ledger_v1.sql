begin;

-- Registration policy sets are immutable snapshots. A future material legal
-- change must create a new version and coordinate a new UI/Edge/DB rollout;
-- old acceptances are never rewritten to point at newer documents.
create table if not exists platform.registration_legal_policy_sets (
  policy_set_version text primary key
    check (policy_set_version ~ '^[a-z0-9][a-z0-9._-]{7,79}$'),
  terms_version text not null
    check (terms_version ~ '^[a-z0-9][a-z0-9._-]{7,79}$'),
  privacy_version text not null
    check (privacy_version ~ '^[a-z0-9][a-z0-9._-]{7,79}$'),
  fair_use_version text not null
    check (fair_use_version ~ '^[a-z0-9][a-z0-9._-]{7,79}$'),
  presentation_version text not null
    check (presentation_version ~ '^[a-z0-9][a-z0-9._-]{7,79}$'),
  summary_text text not null
    check (char_length(summary_text) between 200 and 10000),
  summary_text_hash text not null
    check (summary_text_hash ~ '^[a-f0-9]{64}$'),
  consent_text text not null
    check (char_length(consent_text) between 80 and 2000),
  consent_text_hash text not null
    check (consent_text_hash ~ '^[a-f0-9]{64}$'),
  action_label text not null
    check (char_length(action_label) between 10 and 160),
  terms_document_id uuid not null
    references website.content_documents(id) on delete restrict,
  terms_document_version integer not null
    check (terms_document_version>0),
  terms_document_hash text not null
    check (terms_document_hash ~ '^[a-f0-9]{64}$'),
  privacy_document_id uuid not null
    references website.content_documents(id) on delete restrict,
  privacy_document_version integer not null
    check (privacy_document_version>0),
  privacy_document_hash text not null
    check (privacy_document_hash ~ '^[a-f0-9]{64}$'),
  locale text not null default 'ar-SA' check (locale='ar-SA'),
  effective_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (terms_document_id,terms_document_version)
    references website.content_document_versions(
      content_document_id,version_number
    ) on delete restrict,
  foreign key (privacy_document_id,privacy_document_version)
    references website.content_document_versions(
      content_document_id,version_number
    ) on delete restrict,
  check (
    summary_text_hash=encode(
      extensions.digest(summary_text,'sha256'),'hex'
    )
  ),
  check (
    consent_text_hash=encode(
      extensions.digest(consent_text,'sha256'),'hex'
    )
  )
);

-- This is an append-only evidentiary ledger while its parent request exists.
-- The cascade deliberately preserves the established verified privacy-purge
-- path instead of leaving orphaned applicant identifiers behind.
create table if not exists platform.registration_request_consents (
  id uuid primary key default extensions.gen_random_uuid(),
  request_id uuid not null
    references platform.registration_requests(id) on delete cascade,
  policy_set_version text not null
    references platform.registration_legal_policy_sets(policy_set_version)
      on delete restrict,
  terms_version text not null,
  privacy_version text not null,
  fair_use_version text not null,
  presentation_version text not null,
  summary_text text not null,
  summary_text_hash text not null
    check (summary_text_hash ~ '^[a-f0-9]{64}$'),
  consent_text text not null,
  consent_text_hash text not null
    check (consent_text_hash ~ '^[a-f0-9]{64}$'),
  action_label text not null,
  terms_document_id uuid not null
    references website.content_documents(id) on delete restrict,
  terms_document_version integer not null
    check (terms_document_version>0),
  terms_document_hash text not null
    check (terms_document_hash ~ '^[a-f0-9]{64}$'),
  privacy_document_id uuid not null
    references website.content_documents(id) on delete restrict,
  privacy_document_version integer not null
    check (privacy_document_version>0),
  privacy_document_hash text not null
    check (privacy_document_hash ~ '^[a-f0-9]{64}$'),
  authority_declared boolean not null check (authority_declared),
  terms_accepted boolean not null check (terms_accepted),
  privacy_notice_acknowledged boolean not null
    check (privacy_notice_acknowledged),
  summary_reviewed boolean not null check (summary_reviewed),
  consent_method text not null check (consent_method='scroll_clickwrap'),
  request_ip_hash text not null
    check (request_ip_hash ~ '^[a-f0-9]{64}$'),
  user_agent_hash text
    check (user_agent_hash is null or user_agent_hash ~ '^[a-f0-9]{64}$'),
  locale text not null default 'ar-SA' check (locale='ar-SA'),
  accepted_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata)='object'),
  unique (request_id,policy_set_version,presentation_version),
  foreign key (terms_document_id,terms_document_version)
    references website.content_document_versions(
      content_document_id,version_number
    ) on delete restrict,
  foreign key (privacy_document_id,privacy_document_version)
    references website.content_document_versions(
      content_document_id,version_number
    ) on delete restrict,
  check (
    summary_text_hash=encode(
      extensions.digest(summary_text,'sha256'),'hex'
    )
  ),
  check (
    consent_text_hash=encode(
      extensions.digest(consent_text,'sha256'),'hex'
    )
  )
);

create index if not exists platform_registration_consents_accepted_idx
on platform.registration_request_consents(accepted_at desc,id desc);

create index if not exists platform_registration_policy_terms_document_idx
on platform.registration_legal_policy_sets(
  terms_document_id,terms_document_version
);
create index if not exists platform_registration_policy_privacy_document_idx
on platform.registration_legal_policy_sets(
  privacy_document_id,privacy_document_version
);
create index if not exists platform_registration_consents_policy_idx
on platform.registration_request_consents(policy_set_version);
create index if not exists platform_registration_consents_terms_document_idx
on platform.registration_request_consents(
  terms_document_id,terms_document_version
);
create index if not exists platform_registration_consents_privacy_document_idx
on platform.registration_request_consents(
  privacy_document_id,privacy_document_version
);

alter table platform.registration_legal_policy_sets enable row level security;
alter table platform.registration_request_consents enable row level security;

-- No application role can insert, update, or delete evidence directly. The
-- service role receives execute only on the transactional v4 wrapper below.
revoke all on table platform.registration_legal_policy_sets
from public,anon,authenticated,service_role;
revoke all on table platform.registration_request_consents
from public,anon,authenticated,service_role;

do $policy$
declare
  v_site_id uuid;
  v_terms_document_id uuid;
  v_terms_document_version integer;
  v_terms_document_hash text;
  v_privacy_document_id uuid;
  v_privacy_document_version integer;
  v_privacy_document_hash text;
  v_summary_text constant text := $summary$صلاحية إنشاء الحساب
أقر بأنني مخوّل بالتصرف باسم المنشأة، وأن بيانات المنشأة ومسؤول الطلب صحيحة ومحدثة.
مسؤولية مدير المنشأة
مدير المنشأة مسؤول عن المستخدمين والصلاحيات والمحتوى والبيانات والعمليات والخدمات التي تقدمها المنشأة عبر الحساب.
بيانات المنشأة
تحتفظ المنشأة بحقوقها في بياناتها ومحتواها، وتعالجها أودير بالقدر اللازم لتشغيل الخدمة وحمايتها وتطويرها ووفق سياسة الخصوصية.
الخطة المجانية والاستخدام العادل
يجوز تحديد أو تعديل عدد المستخدمين أو المساحة أو المزايا أو العمليات أو مدة الاحتفاظ، كما يجوز استبدال الخطة المجانية أو إيقافها وفق الشروط والإشعارات المطبقة.
الاستخدام المقبول
يُمنع النشاط غير المشروع أو التحايل على الحدود أو الإضرار بأمن المنصة أو مستخدميها أو إعادة بيع الخدمة دون تصريح.
التكاملات الخارجية
تخضع خدمات الأطراف الثالثة لشروط مزوديها وتوافرها، ولا تضمن أودير استمرار ما يخرج عن سيطرتها المعقولة.
التعليق أو الإنهاء
يجوز تقييد الخدمة أو تعليقها أو إنهاؤها عند المخالفة أو الخطر الأمني أو عدم السداد أو لأسباب نظامية أو تقنية أو تجارية وفق الشروط والأنظمة.
الإلغاء وخروج البيانات
يمكن لمدير المنشأة طلب الإلغاء أو الحذف، وعند الإنهاء يطبق مسار التصدير الآمن أو الحذف النهائي وسياسة الاحتفاظ والنسخ الاحتياطية والالتزامات النظامية.
توافر الخدمة وحدود المسؤولية
تقدم الخدمة وفق الإمكانات المتاحة ولا تضمن نتيجة تجارية أو تشغيلية محددة، وتطبق حدود الضمان والمسؤولية الواردة في الشروط بالقدر الذي يسمح به النظام.$summary$;
  v_summary_hash constant text :=
    '7a911bf6b72684c66cb89a8810e5c3985e8cf0e721d8ed08a37376408e3bc9a8';
  v_consent_text constant text :=
    'أقر بأنني مخوّل بإنشاء حساب هذه المنشأة، وأنني قرأت وأوافق على شروط الاستخدام والاشتراك وسياسة الاستخدام العادل وحدود الخطة المجانية، وأقر بأنني اطلعت على سياسة الخصوصية، بما يشمل مسؤولية إدارة المنشأة، وتعديل حدود الخطة المجانية، وتعليق الخدمة أو إنهاءها، وخيارات تصدير البيانات أو حذفها وفق الوثائق المعتمدة.';
  v_consent_hash constant text :=
    'b901d6e3b7c00c3c9d4b6af77465d3ffae24de19bb296824cf80339ecb2aa0c4';
begin
  select site.id into v_site_id
  from website.sites site
  where site.site_key='marktone-main'
  limit 1;

  select document.id,version.version_number,
         encode(
           extensions.digest(document.published_document::text,'sha256'),
           'hex'
         )
  into v_terms_document_id,v_terms_document_version,v_terms_document_hash
  from website.pages page
  join website.content_documents document
    on document.site_id=page.site_id
   and document.entity_type='page'
   and document.entity_id=page.id
  join lateral (
    select snapshot.version_number
    from website.content_document_versions snapshot
    where snapshot.content_document_id=document.id
      and snapshot.version_kind='published'
      and snapshot.document=document.published_document
    order by snapshot.version_number desc
    limit 1
  ) version on true
  where page.site_id=v_site_id
    and page.slug='terms-of-use'
    and page.status='published'
    and document.published_document is not null
  limit 1;

  select document.id,version.version_number,
         encode(
           extensions.digest(document.published_document::text,'sha256'),
           'hex'
         )
  into v_privacy_document_id,v_privacy_document_version,
       v_privacy_document_hash
  from website.pages page
  join website.content_documents document
    on document.site_id=page.site_id
   and document.entity_type='page'
   and document.entity_id=page.id
  join lateral (
    select snapshot.version_number
    from website.content_document_versions snapshot
    where snapshot.content_document_id=document.id
      and snapshot.version_kind='published'
      and snapshot.document=document.published_document
    order by snapshot.version_number desc
    limit 1
  ) version on true
  where page.site_id=v_site_id
    and page.slug='privacy-policy'
    and page.status='published'
    and document.published_document is not null
  limit 1;

  if v_site_id is null
     or v_terms_document_id is null
     or v_terms_document_version is null
     or v_privacy_document_id is null
     or v_privacy_document_version is null then
    raise exception 'legal_policy_unavailable';
  end if;
  if encode(extensions.digest(v_consent_text,'sha256'),'hex')<>v_consent_hash
  then
    raise exception 'legal_consent_text_hash_invalid';
  end if;
  if encode(extensions.digest(v_summary_text,'sha256'),'hex')<>v_summary_hash
  then
    raise exception 'legal_summary_text_hash_invalid';
  end if;

  insert into platform.registration_legal_policy_sets(
    policy_set_version,terms_version,privacy_version,fair_use_version,
    presentation_version,summary_text,summary_text_hash,consent_text,
    consent_text_hash,action_label,
    terms_document_id,terms_document_version,terms_document_hash,
    privacy_document_id,privacy_document_version,privacy_document_hash,
    effective_at
  ) values (
    'odeir-legal-2026-08-28-v1','terms-of-use-2026-08-28',
    'privacy-policy-2026-08-28','free-plan-fair-use-2026-08-28',
    'registration-clickwrap-v1',v_summary_text,v_summary_hash,
    v_consent_text,v_consent_hash,
    'أوافق وأرسل طلب إنشاء منشأتي',
    v_terms_document_id,v_terms_document_version,v_terms_document_hash,
    v_privacy_document_id,v_privacy_document_version,v_privacy_document_hash,
    '2026-08-28T00:00:00Z'::timestamptz
  ) on conflict (policy_set_version) do nothing;

  if not exists (
    select 1
    from platform.registration_legal_policy_sets policy
    where policy.policy_set_version='odeir-legal-2026-08-28-v1'
      and policy.terms_version='terms-of-use-2026-08-28'
      and policy.privacy_version='privacy-policy-2026-08-28'
      and policy.fair_use_version='free-plan-fair-use-2026-08-28'
      and policy.presentation_version='registration-clickwrap-v1'
      and policy.summary_text_hash=v_summary_hash
      and policy.consent_text_hash=v_consent_hash
      and policy.action_label='أوافق وأرسل طلب إنشاء منشأتي'
      and policy.locale='ar-SA'
      and policy.effective_at='2026-08-28T00:00:00Z'::timestamptz
      and policy.terms_document_id=v_terms_document_id
      and policy.terms_document_version=v_terms_document_version
      and policy.terms_document_hash=v_terms_document_hash
      and policy.privacy_document_id=v_privacy_document_id
      and policy.privacy_document_version=v_privacy_document_version
      and policy.privacy_document_hash=v_privacy_document_hash
  ) then
    raise exception 'legal_policy_version_collision';
  end if;
end
$policy$;

-- The request and its clickwrap receipt commit in one database transaction.
-- v2 remains the registration implementation; v3 remains the guarded email
-- entry point. The updated Edge calls only v4. Their service_role execute
-- grants remain temporarily for a zero-downtime staged rollout and must be
-- revoked in a follow-up hardening migration after the Edge version is proven.
create or replace function public.v4_public_submit_registration_request(
  p_payload jsonb,
  p_ip_hash text,
  p_user_agent_hash text,
  p_configuration_fingerprint text,
  p_email_activation_ready boolean
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_policy platform.registration_legal_policy_sets%rowtype;
  v_result jsonb;
  v_request_id uuid;
  v_current_terms_version integer;
  v_current_terms_hash text;
  v_current_privacy_version integer;
  v_current_privacy_hash text;
  v_requires_email_guard boolean;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'registration_payload_invalid';
  end if;
  -- Keep routing semantics canonical inside the trusted RPC as well as at
  -- Edge. In particular, do not let a whitespace-padded "new" value bypass
  -- the email-activation guard while v2 later trims and accepts it.
  if p_payload->>'institutionState' is null
     or p_payload->>'institutionState' not in ('existing','new') then
    raise exception 'invalid_institution_state';
  end if;
  if p_payload->'tvtcAcknowledged' is distinct from 'true'::jsonb
     or p_payload->'privacyConsent' is distinct from 'true'::jsonb then
    raise exception 'consent_required';
  end if;
  if p_payload->'legalConsent' is distinct from 'true'::jsonb
     or p_payload->'termsConsent' is distinct from 'true'::jsonb
     or p_payload->'privacyAcknowledged' is distinct from 'true'::jsonb
     or p_payload->'legalSummaryReviewed' is distinct from 'true'::jsonb then
    raise exception 'legal_consent_required';
  end if;
  if p_ip_hash is null or p_ip_hash !~ '^[a-f0-9]{64}$'
     or (p_user_agent_hash is not null
         and p_user_agent_hash !~ '^[a-f0-9]{64}$') then
    raise exception 'registration_payload_invalid';
  end if;

  select policy.* into v_policy
  from platform.registration_legal_policy_sets policy
  where policy.policy_set_version='odeir-legal-2026-08-28-v1';
  if v_policy.policy_set_version is null then
    raise exception 'legal_policy_unavailable';
  end if;
  if p_payload->>'legalPolicySetVersion' is distinct from
       v_policy.policy_set_version
     or p_payload->>'termsVersion' is distinct from v_policy.terms_version
     or p_payload->>'privacyVersion' is distinct from v_policy.privacy_version
     or p_payload->>'fairUseVersion' is distinct from v_policy.fair_use_version
     or p_payload->>'legalPresentationVersion' is distinct from
       v_policy.presentation_version
     or p_payload->>'legalSummaryTextHash' is distinct from
       v_policy.summary_text_hash
     or p_payload->>'legalConsentTextHash' is distinct from
       v_policy.consent_text_hash then
    raise exception 'legal_policy_version_stale';
  end if;

  -- Lock both legal pages and documents in a stable order for the remainder
  -- of this transaction. This prevents a CMS publication from changing either
  -- link target after verification but before the acceptance receipt commits.
  perform 1
  from website.content_documents document
  join website.pages page
    on page.site_id=document.site_id
   and document.entity_type='page'
   and page.id=document.entity_id
  where document.id in (
    v_policy.terms_document_id,
    v_policy.privacy_document_id
  )
  order by document.id
  for share of document,page;

  -- Fail closed if a CMS publication changed after this immutable policy set
  -- was captured. The browser links and the recorded receipt must refer to the
  -- same currently published documents at the instant of acceptance.
  select version.version_number,
         encode(
           extensions.digest(document.published_document::text,'sha256'),
           'hex'
         )
  into v_current_terms_version,v_current_terms_hash
  from website.content_documents document
  join website.pages page
    on page.site_id=document.site_id
   and document.entity_type='page'
   and page.id=document.entity_id
  join lateral (
    select snapshot.version_number
    from website.content_document_versions snapshot
    where snapshot.content_document_id=document.id
      and snapshot.version_kind='published'
      and snapshot.document=document.published_document
    order by snapshot.version_number desc
    limit 1
  ) version on true
  where document.id=v_policy.terms_document_id
    and page.slug='terms-of-use'
    and page.status='published'
    and document.published_document is not null;

  select version.version_number,
         encode(
           extensions.digest(document.published_document::text,'sha256'),
           'hex'
         )
  into v_current_privacy_version,v_current_privacy_hash
  from website.content_documents document
  join website.pages page
    on page.site_id=document.site_id
   and document.entity_type='page'
   and page.id=document.entity_id
  join lateral (
    select snapshot.version_number
    from website.content_document_versions snapshot
    where snapshot.content_document_id=document.id
      and snapshot.version_kind='published'
      and snapshot.document=document.published_document
    order by snapshot.version_number desc
    limit 1
  ) version on true
  where document.id=v_policy.privacy_document_id
    and page.slug='privacy-policy'
    and page.status='published'
    and document.published_document is not null;

  if v_current_terms_version is distinct from v_policy.terms_document_version
     or v_current_terms_hash is distinct from v_policy.terms_document_hash
     or v_current_privacy_version is distinct from
       v_policy.privacy_document_version
     or v_current_privacy_hash is distinct from
       v_policy.privacy_document_hash then
    -- This is server-side publication drift, not a stale browser bundle. A
    -- reload cannot repair it; registration resumes after a new reviewed
    -- policy set is released.
    raise exception 'legal_policy_unavailable';
  end if;

  v_requires_email_guard:=p_payload->>'institutionState'='new'
    and nullif(trim(coalesce(p_payload->>'accountId','')),'') is null;
  if v_requires_email_guard then
    v_result:=public.v3_public_submit_registration_request(
      p_payload,p_ip_hash,p_user_agent_hash,
      p_configuration_fingerprint,p_email_activation_ready
    );
  else
    v_result:=public.v2_public_submit_registration_request(
      p_payload,p_ip_hash,p_user_agent_hash
    );
  end if;

  -- v3 asks Edge to retry after atomically failing email activation closed.
  -- No request exists yet in that case, so there is no receipt to record.
  if coalesce((v_result->>'_retryManual')::boolean,false) then
    return v_result;
  end if;
  if coalesce(v_result->>'requestId','')
       !~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
  then
    raise exception 'registration_legal_request_invalid';
  end if;
  v_request_id:=(v_result->>'requestId')::uuid;

  insert into platform.registration_request_consents(
    request_id,policy_set_version,terms_version,privacy_version,
    fair_use_version,presentation_version,summary_text,summary_text_hash,
    consent_text,consent_text_hash,action_label,terms_document_id,
    terms_document_version,terms_document_hash,
    privacy_document_id,privacy_document_version,privacy_document_hash,
    authority_declared,terms_accepted,privacy_notice_acknowledged,
    summary_reviewed,consent_method,request_ip_hash,user_agent_hash,
    locale,metadata
  ) values (
    v_request_id,v_policy.policy_set_version,v_policy.terms_version,
    v_policy.privacy_version,v_policy.fair_use_version,
    v_policy.presentation_version,v_policy.summary_text,
    v_policy.summary_text_hash,v_policy.consent_text,
    v_policy.consent_text_hash,v_policy.action_label,
    v_policy.terms_document_id,v_policy.terms_document_version,
    v_policy.terms_document_hash,v_policy.privacy_document_id,
    v_policy.privacy_document_version,v_policy.privacy_document_hash,
    true,true,true,true,'scroll_clickwrap',p_ip_hash,p_user_agent_hash,
    v_policy.locale,
    jsonb_build_object(
      'institutionState',p_payload->>'institutionState',
      'duplicate',coalesce((v_result->>'duplicate')::boolean,false),
      'recordedBy','registration-v4'
    )
  )
  on conflict (request_id,policy_set_version,presentation_version)
  do nothing;

  return v_result;
end;
$function$;

revoke all on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) from public,anon,authenticated,service_role;
grant execute on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) to service_role;

comment on table platform.registration_legal_policy_sets is
  'Immutable registration clickwrap policy snapshots and published-document hashes.';
comment on table platform.registration_request_consents is
  'Append-only registration clickwrap receipts; direct application-role writes are denied.';
comment on function public.v4_public_submit_registration_request(
  jsonb,text,text,text,boolean
) is
  'Atomic public registration submit plus immutable legal-consent receipt. SERVICE ROLE only.';

commit;
