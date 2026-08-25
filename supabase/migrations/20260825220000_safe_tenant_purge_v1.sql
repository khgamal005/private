begin;

-- Permanent tenant removal is deliberately narrower than ordinary tenant
-- management. Only the platform owner receives this permission.
insert into access_control.permissions(
  permission_key,module_key,name_ar,description
) values (
  'platform.tenants.delete','platform','الحذف النهائي للمنشآت',
  'معاينة وحذف منشأة نظيفة نهائيًا مع تحرير بيانات التسجيل'
)
on conflict(permission_key) do update
set module_key=excluded.module_key,
    name_ar=excluded.name_ar,
    description=excluded.description;

insert into access_control.role_permissions(role_id,permission_key)
select role.id,'platform.tenants.delete'
from access_control.roles role
where role.scope='platform'
  and role.tenant_id is null
  and role.role_key='platform_owner'
on conflict do nothing;

create table platform.tenant_deletion_protections(
  tenant_id uuid primary key
    references core.tenants(id) on delete restrict,
  protection_key text not null unique
    check (protection_key ~ '^[a-z][a-z0-9_]{2,80}$'),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  created_at timestamptz not null default now()
);

alter table platform.tenant_deletion_protections enable row level security;
revoke all on table platform.tenant_deletion_protections
from public,anon,authenticated,service_role;

-- Reef is protected by an actual RESTRICT foreign key, not by UI hiding or a
-- mutable display name. The triple identity prevents a similarly named tenant
-- from being treated as Reef.
insert into platform.tenant_deletion_protections(
  tenant_id,protection_key,reason
)
select tenant.id,'reef_live_tenant','منشأة ريف التشغيلية محمية من الحذف النهائي'
from core.tenants tenant
join core.organizations organization on organization.id=tenant.organization_id
where tenant.tenant_key='tenant-reef-skills'
  and tenant.slug='reef-skills'
  and organization.organization_key='org-reef-skills'
on conflict do nothing;

create table platform.tenant_deletion_receipts(
  id uuid primary key default extensions.gen_random_uuid(),
  idempotency_key uuid not null unique,
  tenant_id uuid not null,
  tenant_key text not null,
  tenant_slug text not null,
  organization_id uuid not null,
  requested_by_subject_id uuid
    references access_control.subjects(id) on delete set null,
  reason text not null check (length(btrim(reason)) between 8 and 500),
  preview_digest text not null check (preview_digest ~ '^[a-f0-9]{64}$'),
  deletion_manifest jsonb not null
    check (jsonb_typeof(deletion_manifest)='object'),
  deleted_at timestamptz not null default now()
);

create index tenant_deletion_receipts_tenant_time_idx
on platform.tenant_deletion_receipts(tenant_id,deleted_at desc);

create index tenant_deletion_receipts_requested_by_subject_idx
on platform.tenant_deletion_receipts(requested_by_subject_id)
where requested_by_subject_id is not null;

alter table platform.tenant_deletion_receipts enable row level security;
revoke all on table platform.tenant_deletion_receipts
from public,anon,authenticated,service_role;

comment on table platform.tenant_deletion_receipts is
'Minimal non-blocking deletion proof. It contains no customer rows, files, credentials, invitation tokens, or raw registration identifiers.';

-- The external-account claim remains immutable for every normal workflow. A
-- delete is allowed only inside the privileged tenant purge transaction, bound
-- to the exact tenant id and to the dedicated platform permission.
create or replace function private_app.registration_external_claim_immutable()
returns trigger
language plpgsql
set search_path=''
as $$
begin
  if tg_op='DELETE'
     and current_setting('odeir.tenant_purge_id',true)=old.tenant_id::text
     and private_app.has_platform_permission('platform.tenants.delete') then
    return old;
  end if;
  raise exception 'registration_external_claim_immutable';
end;
$$;

revoke all on function private_app.registration_external_claim_immutable()
from public,anon,authenticated,service_role;

create or replace function private_app.v1_tenant_deletion_preview_document(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
declare
  v_tenant core.tenants%rowtype;
  v_organization core.organizations%rowtype;
  v_protected boolean:=false;
  v_financial_documents bigint:=0;
  v_accounting_events bigint:=0;
  v_payments bigint:=0;
  v_zatca_submissions bigint:=0;
  v_marketplace_orders bigint:=0;
  v_bank_transfers bigint:=0;
  v_addon_events bigint:=0;
  v_protected_addons bigint:=0;
  v_integrations bigint:=0;
  v_default_integrations bigint:=0;
  v_storage_objects bigint:=0;
  v_members bigint:=0;
  v_staff bigint:=0;
  v_contacts bigint:=0;
  v_tasks bigint:=0;
  v_students bigint:=0;
  v_enrollments bigint:=0;
  v_courses bigint:=0;
  v_domains bigint:=0;
  v_requests bigint:=0;
  v_unknown_dependencies jsonb:='[]'::jsonb;
  v_dependency_fingerprint text;
  v_counts jsonb;
  v_blockers jsonb:='[]'::jsonb;
  v_digest text;
begin
  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id=p_tenant_id;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  select organization.* into v_organization
  from core.organizations organization
  where organization.id=v_tenant.organization_id;

  select exists(
    select 1 from platform.tenant_deletion_protections protection
    where protection.tenant_id=v_tenant.id
  ) into v_protected;

  select count(*) into v_financial_documents
  from accounting_core.sales_documents document
  where document.tenant_id=v_tenant.id and document.status<>'draft';
  select count(*) into v_accounting_events
  from accounting_core.document_events event
  where event.tenant_id=v_tenant.id;
  select count(*) into v_payments
  from accounting_core.payments payment
  where payment.tenant_id=v_tenant.id;
  select count(*) into v_zatca_submissions
  from accounting_zatca.submission_metadata submission
  where submission.tenant_id=v_tenant.id;
  select count(*) into v_marketplace_orders
  from marketplace.orders market_order
  where market_order.tenant_id=v_tenant.id;
  select count(*) into v_bank_transfers
  from marketplace.bank_transfer_submissions transfer
  where transfer.tenant_id=v_tenant.id;
  select count(*) into v_addon_events
  from catalog.tenant_addon_subscription_events event
  where event.tenant_id=v_tenant.id;
  select count(*) into v_protected_addons
  from catalog.tenant_addon_subscriptions subscription
  where subscription.tenant_id=v_tenant.id
    and subscription.lifecycle_protected_until is not null;

  -- Provisioning creates three inert draft rows for every tenant. They contain
  -- only the exact built-in dispatcher placeholder and have never been checked;
  -- these rows are local defaults, not remote integrations or credentials.
  select count(*) into v_default_integrations
  from core.integrations item
  where item.tenant_id=v_tenant.id
    and item.status='draft'
    and item.last_checked_at is null
    and (item.system_type,item.display_name) in (
      ('whatsapp_cloud','WhatsApp Cloud API'),
      ('resend_email','Resend Email'),
      ('zoom_meetings','Zoom Meetings')
    )
    and item.configuration=jsonb_build_object(
      'dispatchMode','supabase_edge_function',
      'providerState','unknown'
    );

  select
    (select count(*) from core.integrations item
      where item.tenant_id=v_tenant.id
        and not (
          item.status='draft'
          and item.last_checked_at is null
          and (item.system_type,item.display_name) in (
            ('whatsapp_cloud','WhatsApp Cloud API'),
            ('resend_email','Resend Email'),
            ('zoom_meetings','Zoom Meetings')
          )
          and item.configuration=jsonb_build_object(
            'dispatchMode','supabase_edge_function',
            'providerState','unknown'
          )
        ))
    +(select count(*) from communication_hub.provider_connections item where item.tenant_id=v_tenant.id)
    +(select count(*) from commerce_hub.connections item where item.tenant_id=v_tenant.id)
    +(select count(*) from commerce_sync.connections item where item.tenant_id=v_tenant.id)
    +(select count(*) from marketing_hub.connections item where item.tenant_id=v_tenant.id)
  into v_integrations;

  select count(*) into v_storage_objects
  from storage.objects object
  where object.bucket_id in (
      'cms-assets','cms-template-staging','cms-template-assets'
    )
    and exists(
      select 1 from website.sites site
      where site.tenant_id=v_tenant.id
        and (object.name=site.id::text or object.name like site.id::text||'/%')
    );

  select count(*) into v_members from access_control.memberships item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_staff from people.staff_profiles item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_contacts from sales_core.contacts item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_tasks from work_core.tasks item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_students from academy.students item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_enrollments from academy.enrollments item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_courses from academy.courses item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_domains from core.domains item
  where item.tenant_id=v_tenant.id;
  select count(*) into v_requests from platform.registration_requests item
  where item.provisioned_tenant_id=v_tenant.id;

  -- Every direct tenant FK is catalogued. New CASCADE relations remain safe;
  -- new RESTRICT/SET NULL relations stop deletion until explicitly reviewed.
  select coalesce(jsonb_agg(jsonb_build_object(
    'table',dependency.table_name,
    'constraint',dependency.constraint_name,
    'deleteAction',dependency.delete_action
  ) order by dependency.table_name,dependency.constraint_name),'[]'::jsonb)
  into v_unknown_dependencies
  from (
    select
      namespace.nspname||'.'||relation.relname as table_name,
      constraint_row.conname as constraint_name,
      constraint_row.confdeltype as delete_action
    from pg_catalog.pg_constraint constraint_row
    join pg_catalog.pg_class relation on relation.oid=constraint_row.conrelid
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    where constraint_row.contype='f'
      and constraint_row.confrelid='core.tenants'::regclass
      and not (
        constraint_row.confdeltype='c'
        or (
          constraint_row.confdeltype='n'
          and namespace.nspname||'.'||relation.relname in (
            'audit_log.events','core.support_requests'
          )
        )
        or (
          constraint_row.confdeltype in ('a','r')
          and namespace.nspname||'.'||relation.relname in (
            'catalog.tenant_addon_subscription_events',
            'marketplace.bank_transfer_submissions',
            'marketplace.order_events',
            'marketplace.orders',
            'platform.registration_external_account_claims',
            'platform.registration_identity_claims',
            'platform.registration_requests',
            'platform.tenant_deletion_protections'
          )
        )
      )
  ) dependency;

  select encode(extensions.digest(coalesce(string_agg(
    namespace.nspname||'.'||relation.relname||':'||
    constraint_row.conname||':'||constraint_row.confdeltype::text,
    '|' order by namespace.nspname,relation.relname,constraint_row.conname
  ),''),'sha256'),'hex')
  into v_dependency_fingerprint
  from pg_catalog.pg_constraint constraint_row
  join pg_catalog.pg_class relation on relation.oid=constraint_row.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
  where constraint_row.contype='f'
    and constraint_row.confrelid='core.tenants'::regclass;

  v_counts:=jsonb_build_object(
    'members',v_members,
    'staff',v_staff,
    'contacts',v_contacts,
    'tasks',v_tasks,
    'students',v_students,
    'enrollments',v_enrollments,
    'courses',v_courses,
    'domains',v_domains,
    'registrationRequests',v_requests,
    'financialDocuments',v_financial_documents,
    'accountingEvents',v_accounting_events,
    'payments',v_payments,
    'zatcaSubmissions',v_zatca_submissions,
    'marketplaceOrders',v_marketplace_orders,
    'bankTransfers',v_bank_transfers,
    'addonEvents',v_addon_events,
    'protectedAddons',v_protected_addons,
    'integrations',v_integrations,
    'defaultIntegrationRows',v_default_integrations,
    'storageObjects',v_storage_objects
  );

  if v_protected then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','protected_tenant','message','هذه المنشأة محمية من الحذف النهائي'
    ));
  end if;
  if v_financial_documents+v_accounting_events+v_payments+v_zatca_submissions>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','financial_records','message','توجد فواتير أو مدفوعات أو سجلات ضريبية واجبة الحفظ'
    ));
  end if;
  if v_marketplace_orders+v_bank_transfers>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','marketplace_records','message','توجد طلبات متجر أو تحويلات بنكية مرتبطة بالمنشأة'
    ));
  end if;
  if v_addon_events+v_protected_addons>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','addon_history','message','توجد دورة اشتراك إضافة محمية أو سجل أحداث فوترة'
    ));
  end if;
  if v_integrations>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','integrations','message','افصل التكاملات وأسرارها قبل الحذف النهائي'
    ));
  end if;
  if v_storage_objects>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','storage_objects','message','توجد ملفات موقع يجب حذفها عبر مدير الملفات أولًا'
    ));
  end if;
  if jsonb_array_length(v_unknown_dependencies)>0 then
    v_blockers:=v_blockers||jsonb_build_array(jsonb_build_object(
      'code','unknown_database_dependency',
      'message','ظهر اعتماد جديد في قاعدة البيانات ويحتاج مراجعة هندسية قبل الحذف'
    ));
  end if;

  v_digest:=encode(extensions.digest(
    v_tenant.id::text||'|'||v_tenant.updated_at::text||'|'||
    v_counts::text||'|'||v_dependency_fingerprint||'|'||v_blockers::text,
    'sha256'
  ),'hex');

  return jsonb_build_object(
    'previewVersion',1,
    'tenant',jsonb_build_object(
      'id',v_tenant.id,
      'name',v_tenant.name,
      'slug',v_tenant.slug,
      'tenantKey',v_tenant.tenant_key,
      'status',v_tenant.status,
      'organizationId',v_tenant.organization_id,
      'organizationKey',v_organization.organization_key
    ),
    'counts',v_counts,
    'blockers',v_blockers,
    'canDelete',jsonb_array_length(v_blockers)=0,
    'confirmationPhrase','حذف '||v_tenant.slug,
    'dependencyFingerprint',v_dependency_fingerprint,
    'previewDigest',v_digest
  );
end;
$$;

revoke all on function private_app.v1_tenant_deletion_preview_document(uuid)
from public,anon,authenticated,service_role;

create or replace function public.v1_platform_tenant_deletion_preview(
  p_tenant_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
as $$
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private_app.has_platform_permission('platform.tenants.delete') then
    raise exception 'forbidden';
  end if;
  return private_app.v1_tenant_deletion_preview_document(p_tenant_id);
end;
$$;

revoke all on function public.v1_platform_tenant_deletion_preview(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_tenant_deletion_preview(uuid)
to authenticated;

create or replace function public.v1_platform_tenant_delete(
  p_tenant_id uuid,
  p_preview_digest text,
  p_confirmation text,
  p_reason text,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
declare
  v_actor uuid;
  v_tenant core.tenants%rowtype;
  v_preview jsonb;
  v_receipt platform.tenant_deletion_receipts%rowtype;
  v_request_ids uuid[]:='{}'::uuid[];
  v_organization_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication_required'; end if;
  if not private_app.has_platform_permission('platform.tenants.delete') then
    raise exception 'forbidden';
  end if;
  if p_tenant_id is null or p_idempotency_key is null then
    raise exception 'tenant_deletion_payload_invalid';
  end if;
  if coalesce(p_preview_digest,'')!~'^[a-f0-9]{64}$' then
    raise exception 'tenant_deletion_preview_invalid';
  end if;
  if length(btrim(coalesce(p_reason,''))) not between 8 and 500 then
    raise exception 'tenant_deletion_reason_required';
  end if;

  v_actor:=private_app.current_subject_id();
  if v_actor is null then raise exception 'forbidden'; end if;

  select receipt.* into v_receipt
  from platform.tenant_deletion_receipts receipt
  where receipt.idempotency_key=p_idempotency_key;
  if v_receipt.id is not null then
    if v_receipt.tenant_id<>p_tenant_id then
      raise exception 'tenant_deletion_idempotency_conflict';
    end if;
    return jsonb_build_object(
      'deleted',true,'replayed',true,'tenantId',v_receipt.tenant_id,
      'tenantSlug',v_receipt.tenant_slug,'receiptId',v_receipt.id,
      'deletedAt',v_receipt.deleted_at,'registrationReleased',true,
      'authUserDeleted',false
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'odeir:tenant-delete-idempotency:'||p_idempotency_key::text,0
    )
  );

  -- A first request may have committed while this retry was waiting. Re-read
  -- the receipt under the idempotency lock before looking for the tenant,
  -- because a successful first request has already removed that tenant row.
  select receipt.* into v_receipt
  from platform.tenant_deletion_receipts receipt
  where receipt.idempotency_key=p_idempotency_key;
  if v_receipt.id is not null then
    if v_receipt.tenant_id<>p_tenant_id then
      raise exception 'tenant_deletion_idempotency_conflict';
    end if;
    return jsonb_build_object(
      'deleted',true,'replayed',true,'tenantId',v_receipt.tenant_id,
      'tenantSlug',v_receipt.tenant_slug,'receiptId',v_receipt.id,
      'deletedAt',v_receipt.deleted_at,'registrationReleased',true,
      'authUserDeleted',false
    );
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('odeir:tenant-delete:'||p_tenant_id::text,0)
  );

  select tenant.* into v_tenant
  from core.tenants tenant
  where tenant.id=p_tenant_id
  for update;
  if v_tenant.id is null then raise exception 'tenant_not_found'; end if;

  v_preview:=private_app.v1_tenant_deletion_preview_document(p_tenant_id);
  if v_preview->>'previewDigest'<>p_preview_digest then
    raise exception 'tenant_deletion_preview_stale';
  end if;
  if coalesce((v_preview->>'canDelete')::boolean,false) is not true then
    raise exception 'tenant_deletion_blocked';
  end if;
  if btrim(coalesce(p_confirmation,''))<>v_preview->>'confirmationPhrase' then
    raise exception 'tenant_deletion_confirmation_mismatch';
  end if;

  v_organization_id:=v_tenant.organization_id;
  select coalesce(array_agg(request.id),'{}'::uuid[]) into v_request_ids
  from platform.registration_requests request
  where request.provisioned_tenant_id=v_tenant.id;

  perform pg_catalog.set_config('odeir.tenant_purge_id',v_tenant.id::text,true);

  -- Remove only the registration history belonging to this ODEIR tenant. The
  -- legacy directory tenant referenced by external_account_id is never touched.
  delete from platform.registration_email_webhook_events event
  where event.delivery_id in (
    select delivery.id from platform.registration_email_deliveries delivery
    where delivery.request_id=any(v_request_ids)
  );
  delete from platform.registration_email_delivery_attempts attempt
  where attempt.delivery_id in (
    select delivery.id from platform.registration_email_deliveries delivery
    where delivery.request_id=any(v_request_ids)
  );
  delete from platform.registration_confirmation_token_aliases alias
  where alias.request_id=any(v_request_ids);
  delete from platform.registration_email_deliveries delivery
  where delivery.request_id=any(v_request_ids);
  delete from platform.registration_request_identity_reservations reservation
  where reservation.request_id=any(v_request_ids);
  delete from platform.registration_activation_attestations attestation
  where attestation.request_id=any(v_request_ids);
  delete from platform.registration_external_account_claims claim
  where claim.tenant_id=v_tenant.id
     or claim.originating_request_id=any(v_request_ids);
  delete from platform.registration_identity_claims claim
  where claim.tenant_id=v_tenant.id
     or claim.request_id=any(v_request_ids);
  delete from platform.registration_request_events event
  where event.request_id=any(v_request_ids);
  delete from platform.registration_requests request
  where request.id=any(v_request_ids);

  -- Draft accounting data is removable. Issued documents, payments, ZATCA
  -- submissions and append-only events were already rejected by the preview.
  delete from accounting_core.refunds item where item.tenant_id=v_tenant.id;
  delete from accounting_core.receipts item where item.tenant_id=v_tenant.id;
  delete from accounting_core.payment_allocations item where item.tenant_id=v_tenant.id;
  delete from accounting_core.payment_schedules item where item.tenant_id=v_tenant.id;
  delete from accounting_core.collection_actions item where item.tenant_id=v_tenant.id;
  delete from accounting_core.document_events item where item.tenant_id=v_tenant.id;
  delete from accounting_core.sales_document_lines item where item.tenant_id=v_tenant.id;
  delete from accounting_core.sales_documents item
  where item.tenant_id=v_tenant.id and item.status='draft';

  -- SET NULL would retain free text and JSON context. Explicit deletion keeps
  -- the purge free of orphaned tenant PII; the minimal receipt below remains.
  delete from core.support_requests item where item.tenant_id=v_tenant.id;
  delete from audit_log.events item where item.tenant_id=v_tenant.id;

  delete from core.tenants tenant where tenant.id=v_tenant.id;
  if not found then raise exception 'tenant_deletion_failed'; end if;

  delete from core.organizations organization
  where organization.id=v_organization_id
    and not exists(
      select 1 from core.tenants tenant
      where tenant.organization_id=organization.id
    );

  insert into platform.tenant_deletion_receipts(
    idempotency_key,tenant_id,tenant_key,tenant_slug,organization_id,
    requested_by_subject_id,reason,preview_digest,deletion_manifest
  ) values (
    p_idempotency_key,v_tenant.id,v_tenant.tenant_key,v_tenant.slug,
    v_organization_id,v_actor,btrim(p_reason),p_preview_digest,
    jsonb_build_object(
      'previewVersion',v_preview->'previewVersion',
      'counts',v_preview->'counts',
      'dependencyFingerprint',v_preview->'dependencyFingerprint',
      'registrationReleased',true,
      'authUserDeleted',false
    )
  ) returning * into v_receipt;

  return jsonb_build_object(
    'deleted',true,'replayed',false,'tenantId',v_tenant.id,
    'tenantSlug',v_tenant.slug,'receiptId',v_receipt.id,
    'deletedAt',v_receipt.deleted_at,'registrationReleased',true,
    'authUserDeleted',false
  );
end;
$$;

revoke all on function public.v1_platform_tenant_delete(
  uuid,text,text,text,uuid
) from public,anon,authenticated,service_role;
grant execute on function public.v1_platform_tenant_delete(
  uuid,text,text,text,uuid
) to authenticated;

comment on function public.v1_platform_tenant_deletion_preview(uuid) is
'Fail-closed preview for permanent deletion. Financial records, storage, integrations, protected tenants, and unknown direct FK behavior block execution.';
comment on function public.v1_platform_tenant_delete(uuid,text,text,text,uuid) is
'Idempotent clean-tenant purge. Preserves Auth users, releases registration identity, and never touches legacy platform.tenants.';

commit;
