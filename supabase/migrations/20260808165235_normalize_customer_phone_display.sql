begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

lock table
  sales_core.contacts,
  sales_core.contact_identities,
  sales_core.lead_import_rows
in share row exclusive mode;

create or replace function private_app.format_customer_phone(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_original text;
  v_identity text;
begin
  v_original := nullif(pg_catalog.btrim(coalesce(p_value, '')), '');
  if v_original is null then
    return null;
  end if;

  v_identity := private_app.normalize_lead_phone(v_original);
  if v_identity is null then
    return null;
  end if;

  if v_identity ~ '^9665[0-9]{8}$' then
    return '0' || pg_catalog.right(v_identity, 9);
  end if;

  -- A non-Saudi number keeps its country code and entered representation.
  return v_original;
end;
$$;

revoke all on function private_app.format_customer_phone(text)
from public, anon, authenticated;

comment on function private_app.format_customer_phone(text) is
'Formats Saudi mobiles as 05XXXXXXXX for display and Linkus dialing while preserving non-Saudi international numbers.';

create or replace function private_app.prepare_contact_identity_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_normalized text;
begin
  if nullif(pg_catalog.btrim(coalesce(new.phone, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.phone);
    if v_normalized is null then
      raise exception 'invalid_phone';
    end if;
    new.phone := private_app.format_customer_phone(new.phone);
  else
    new.phone := null;
  end if;

  if nullif(pg_catalog.btrim(coalesce(new.whatsapp, '')), '') is not null then
    v_normalized := private_app.normalize_lead_phone(new.whatsapp);
    if v_normalized is null then
      raise exception 'invalid_whatsapp';
    end if;
    new.whatsapp := private_app.format_customer_phone(new.whatsapp);
  else
    new.whatsapp := null;
  end if;

  new.email := nullif(pg_catalog.lower(pg_catalog.btrim(
    coalesce(new.email, '')
  )), '');
  if new.email is not null
     and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'invalid_email';
  end if;
  if new.phone is null
     and new.whatsapp is null
     and new.email is null then
    raise exception 'contact_identity_required';
  end if;

  return new;
end;
$$;

create or replace function private_app.sync_contact_identities()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.tenant_id is distinct from new.tenant_id then
    delete from sales_core.contact_identities
    where contact_id = new.id;
  elsif tg_op = 'UPDATE' then
    update sales_core.contact_identities
    set source_slot = 'historical_alias',
        is_alias = true,
        updated_at = now()
    where contact_id = new.id
      and not is_alias;
  else
    delete from sales_core.contact_identities
    where contact_id = new.id
      and not is_alias;
  end if;

  delete from sales_core.contact_identities identity
  where identity.contact_id = new.id
    and identity.is_alias
    and (
      (
        identity.identity_type = 'phone'
        and identity.identity_value in (
          private_app.normalize_lead_phone(new.phone),
          private_app.normalize_lead_phone(new.whatsapp)
        )
      )
      or (
        identity.identity_type = 'email'
        and identity.identity_value = new.email
      )
    );

  insert into sales_core.contact_identities (
    tenant_id,
    contact_id,
    identity_type,
    identity_value,
    source_slot,
    is_alias
  )
  select distinct on (candidate.identity_type, candidate.identity_value)
    new.tenant_id,
    new.id,
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_slot,
    false
  from (
    values
      (
        'phone'::text,
        private_app.normalize_lead_phone(new.phone),
        'phone'::text,
        1
      ),
      (
        'phone'::text,
        private_app.normalize_lead_phone(new.whatsapp),
        'whatsapp'::text,
        2
      ),
      ('email'::text, new.email, 'email'::text, 3)
  ) as candidate(identity_type, identity_value, source_slot, source_order)
  where candidate.identity_value is not null
  order by
    candidate.identity_type,
    candidate.identity_value,
    candidate.source_order;

  return new;
end;
$$;

revoke all on function private_app.prepare_contact_identity_fields()
from public, anon, authenticated;
revoke all on function private_app.sync_contact_identities()
from public, anon, authenticated;

create or replace function private_app.prepare_lead_import_phone_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_normalized text;
begin
  if nullif(pg_catalog.btrim(coalesce(new.phone, '')), '') is null then
    new.phone := null;
    new.normalized_phone := null;
  else
    v_normalized := private_app.normalize_lead_phone(new.phone);
    new.normalized_phone := v_normalized;
    if v_normalized is not null then
      new.phone := private_app.format_customer_phone(new.phone);
    end if;
  end if;

  if nullif(pg_catalog.btrim(coalesce(new.whatsapp, '')), '') is null then
    new.whatsapp := null;
    new.normalized_whatsapp := null;
  else
    v_normalized := private_app.normalize_lead_phone(new.whatsapp);
    new.normalized_whatsapp := v_normalized;
    if v_normalized is not null then
      new.whatsapp := private_app.format_customer_phone(new.whatsapp);
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private_app.prepare_lead_import_phone_fields()
from public, anon, authenticated;

drop trigger if exists lead_import_rows_prepare_phone_fields
on sales_core.lead_import_rows;
create trigger lead_import_rows_prepare_phone_fields
before insert or update of phone, normalized_phone, whatsapp, normalized_whatsapp
on sales_core.lead_import_rows
for each row execute function private_app.prepare_lead_import_phone_fields();

create temporary table customer_phone_display_snapshot
on commit drop
as
select id, phone, whatsapp, updated_at
from sales_core.contacts;

create temporary table lead_import_phone_display_snapshot
on commit drop
as
select id, phone, whatsapp, updated_at
from sales_core.lead_import_rows;

alter table sales_core.contacts
disable trigger sales_contacts_set_updated_at;

update sales_core.contacts contact
set phone = private_app.format_customer_phone(contact.phone),
    whatsapp = private_app.format_customer_phone(contact.whatsapp)
where contact.phone is distinct from
      private_app.format_customer_phone(contact.phone)
   or contact.whatsapp is distinct from
      private_app.format_customer_phone(contact.whatsapp);

alter table sales_core.contacts
enable trigger sales_contacts_set_updated_at;

alter table sales_core.lead_import_rows
disable trigger lead_import_rows_set_updated_at;

update sales_core.lead_import_rows import_row
set phone = case
      when private_app.normalize_lead_phone(import_row.phone) is null
        then import_row.phone
      else private_app.format_customer_phone(import_row.phone)
    end,
    normalized_phone = private_app.normalize_lead_phone(import_row.phone),
    whatsapp = case
      when private_app.normalize_lead_phone(import_row.whatsapp) is null
        then import_row.whatsapp
      else private_app.format_customer_phone(import_row.whatsapp)
    end,
    normalized_whatsapp = private_app.normalize_lead_phone(
      import_row.whatsapp
    )
where import_row.phone is not null
   or import_row.whatsapp is not null
   or import_row.normalized_phone is not null
   or import_row.normalized_whatsapp is not null;

alter table sales_core.lead_import_rows
enable trigger lead_import_rows_set_updated_at;

do $$
begin
  if private_app.format_customer_phone('+966 51 234 5678')
       <> '0512345678'
     or private_app.format_customer_phone('00966512345678')
       <> '0512345678'
     or private_app.format_customer_phone('9660512345678')
       <> '0512345678'
     or private_app.format_customer_phone('0512345678')
       <> '0512345678' then
    raise exception 'saudi_customer_phone_display_verification_failed';
  end if;

  if private_app.format_customer_phone('+20 10 1234 5678')
       <> '+20 10 1234 5678'
     or private_app.format_customer_phone('963912345678')
       <> '963912345678' then
    raise exception 'international_customer_phone_preservation_failed';
  end if;

  if exists (
    select 1
    from sales_core.contacts contact
    where (
      private_app.normalize_lead_phone(contact.phone)
        ~ '^9665[0-9]{8}$'
      and contact.phone !~ '^05[0-9]{8}$'
    ) or (
      private_app.normalize_lead_phone(contact.whatsapp)
        ~ '^9665[0-9]{8}$'
      and contact.whatsapp !~ '^05[0-9]{8}$'
    )
  ) then
    raise exception 'saudi_contact_phone_backfill_incomplete';
  end if;

  if exists (
    select 1
    from customer_phone_display_snapshot snapshot
    join sales_core.contacts contact on contact.id = snapshot.id
    where (
      snapshot.phone is not null
      and coalesce(
        private_app.normalize_lead_phone(snapshot.phone)
          !~ '^9665[0-9]{8}$',
        true
      )
      and contact.phone is distinct from snapshot.phone
    ) or (
      snapshot.whatsapp is not null
      and coalesce(
        private_app.normalize_lead_phone(snapshot.whatsapp)
          !~ '^9665[0-9]{8}$',
        true
      )
      and contact.whatsapp is distinct from snapshot.whatsapp
    ) or contact.updated_at is distinct from snapshot.updated_at
  ) then
    raise exception 'customer_phone_backfill_changed_protected_data';
  end if;

  if exists (
    select 1
    from lead_import_phone_display_snapshot snapshot
    join sales_core.lead_import_rows import_row on import_row.id = snapshot.id
    where import_row.updated_at is distinct from snapshot.updated_at
  ) then
    raise exception 'lead_import_phone_backfill_changed_timestamps';
  end if;

  if exists (
    select 1
    from sales_core.contact_identities identity
    where identity.identity_type = 'phone'
      and identity.identity_value ~ '^05[0-9]{8}$'
  ) then
    raise exception 'contact_identity_was_changed_to_local_display_format';
  end if;
end;
$$;

commit;
