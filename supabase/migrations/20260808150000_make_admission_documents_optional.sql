-- All admissions documents are optional.
-- Existing registrations are preserved; only the requirement flag and future default change.

update academy.registration_documents
set is_required = false
where is_required;

alter table academy.registration_documents
  alter column is_required set default false;

create or replace function private_app.force_registration_document_optional()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.is_required := false;
  return new;
end
$$;

drop trigger if exists registration_documents_force_optional
on academy.registration_documents;

create trigger registration_documents_force_optional
before insert or update of is_required
on academy.registration_documents
for each row
execute function private_app.force_registration_document_optional();

alter table academy.registration_documents
  drop constraint if exists registration_documents_optional_only_check;

alter table academy.registration_documents
  add constraint registration_documents_optional_only_check
  check (is_required = false);

comment on column academy.registration_documents.is_required is
'Always false: admissions documents are optional and never block registration completion.';
