begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

-- Support tickets and conversations remain available, but attachments stay
-- unavailable until a later reviewed migration installs a quarantine,
-- magic-byte validation and malware-scanning pipeline.  This is deliberately
-- enforced at both the RPC and Storage RLS boundaries; an application flag is
-- not treated as a security boundary.

update storage.buckets bucket
set public=false
where bucket.id='support-attachments';

drop policy if exists support_attachments_insert on storage.objects;
drop policy if exists support_attachments_select on storage.objects;
drop policy if exists support_attachments_update on storage.objects;
drop policy if exists support_attachments_delete on storage.objects;
drop policy if exists support_attachments_scanner_fail_closed
on storage.objects;
create policy support_attachments_scanner_fail_closed
on storage.objects
as restrictive
for all
to public
using (bucket_id<>'support-attachments')
with check (bucket_id<>'support-attachments');

comment on policy support_attachments_scanner_fail_closed
on storage.objects is
'Restrictive DB boundary denying every non-bypass role access to support attachments until a reviewed scanner pipeline replaces this policy.';

create or replace function public.v3_support_storage_can_upload(
  p_object_path text
)
returns boolean
language sql
immutable
security definer
set search_path=''
as $$
  select false
$$;

create or replace function public.v3_support_storage_can_read(
  p_object_path text
)
returns boolean
language sql
immutable
security definer
set search_path=''
as $$
  select false
$$;

create or replace function public.v3_support_attachment_upload_ticket(
  p_ticket_id uuid,
  p_message_id uuid,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_client_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

create or replace function public.v3_support_attachment_finalize(
  p_attachment_id uuid,
  p_size_bytes bigint
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

create or replace function public.v3_support_attachment_resolve(
  p_attachment_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $$
begin
  raise exception 'support_attachments_scanner_unavailable';
end;
$$;

revoke all on function public.v3_support_storage_can_upload(text)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_storage_can_read(text)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_finalize(uuid,bigint)
from public,anon,authenticated,service_role;
revoke all on function public.v3_support_attachment_resolve(uuid)
from public,anon,authenticated,service_role;

-- Expired pending manifests and their objects still need bounded cleanup.
-- Reassert the narrow worker grants without restoring any user attachment RPC.
revoke all on function public.v3_support_attachment_cleanup_snapshot(integer)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_cleanup_snapshot(integer)
to service_role;
revoke all on function public.v3_support_attachment_cleanup_finalize(uuid)
from public,anon,authenticated,service_role;
grant execute on function public.v3_support_attachment_cleanup_finalize(uuid)
to service_role;

comment on function public.v3_support_attachment_upload_ticket(
  uuid,uuid,text,text,bigint,text
) is
'Fail-closed attachment boundary. A later reviewed scanner migration must replace this guard and restore only the required grant.';
comment on function public.v3_support_storage_can_upload(text) is
'Fail-closed Storage helper returning false until support attachment scanning is implemented.';
comment on function public.v3_support_storage_can_read(text) is
'Fail-closed Storage helper returning false so unscanned support objects cannot be read.';
comment on function public.v3_support_attachment_finalize(uuid,bigint) is
'Fail-closed attachment boundary pending quarantine, magic-byte validation and malware scanning.';
comment on function public.v3_support_attachment_resolve(uuid) is
'Fail-closed attachment boundary: unscanned support objects cannot be resolved or downloaded.';

commit;