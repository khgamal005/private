begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

create index if not exists contact_identities_tenant_contact_idx
on sales_core.contact_identities (tenant_id, contact_id);

drop policy if exists contact_identities_no_direct_access
on sales_core.contact_identities;
create policy contact_identities_no_direct_access
on sales_core.contact_identities
as restrictive
for all
to public
using (false)
with check (false);

drop policy if exists contact_merge_archive_no_direct_access
on sales_core.contact_merge_archive;
create policy contact_merge_archive_no_direct_access
on sales_core.contact_merge_archive
as restrictive
for all
to public
using (false)
with check (false);

commit;
