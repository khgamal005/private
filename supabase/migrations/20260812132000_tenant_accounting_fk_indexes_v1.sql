-- Tenant accounting v1: foreign-key index hardening.
-- DDL only. This migration does not insert, update, delete, import or backfill tenant data.

-- The platform already has sales_contacts_tenant_id_id_uidx with the same keys.
-- Remove the redundant accounting bootstrap index after the dependent foreign keys exist.
drop index if exists sales_core.sales_contacts_tenant_id_id_accounting_idx;

create index if not exists accounting_tenant_profiles_created_by_idx
on accounting_core.tenant_profiles(created_by_subject_id);
create index if not exists accounting_tenant_profiles_updated_by_idx
on accounting_core.tenant_profiles(updated_by_subject_id);

create index if not exists accounting_customers_created_by_idx
on accounting_core.customer_accounts(created_by_subject_id);
create index if not exists accounting_customers_updated_by_idx
on accounting_core.customer_accounts(updated_by_subject_id);

create index if not exists accounting_documents_created_by_idx
on accounting_core.sales_documents(created_by_subject_id);
create index if not exists accounting_documents_updated_by_idx
on accounting_core.sales_documents(updated_by_subject_id);
create index if not exists accounting_documents_issued_by_idx
on accounting_core.sales_documents(issued_by_subject_id);
create index if not exists accounting_documents_contact_fk_idx
on accounting_core.sales_documents(tenant_id,contact_id);
create index if not exists accounting_documents_parent_fk_idx
on accounting_core.sales_documents(tenant_id,parent_document_id);

create index if not exists accounting_schedules_created_by_idx
on accounting_core.payment_schedules(created_by_subject_id);

create index if not exists accounting_payments_created_by_idx
on accounting_core.payments(created_by_subject_id);
create index if not exists accounting_payments_verified_by_idx
on accounting_core.payments(verified_by_subject_id);

create index if not exists accounting_allocations_created_by_idx
on accounting_core.payment_allocations(created_by_subject_id);
create index if not exists accounting_allocations_invoice_fk_idx
on accounting_core.payment_allocations(tenant_id,invoice_id);

create index if not exists accounting_receipts_issued_by_idx
on accounting_core.receipts(issued_by_subject_id);

create index if not exists accounting_collections_created_by_idx
on accounting_core.collection_actions(created_by_subject_id);
create index if not exists accounting_collections_customer_fk_idx
on accounting_core.collection_actions(tenant_id,customer_account_id);
create index if not exists accounting_collections_invoice_fk_idx
on accounting_core.collection_actions(tenant_id,invoice_id);

create index if not exists accounting_refunds_requested_by_idx
on accounting_core.refunds(requested_by_subject_id);
create index if not exists accounting_refunds_approved_by_idx
on accounting_core.refunds(approved_by_subject_id);
create index if not exists accounting_refunds_completed_by_idx
on accounting_core.refunds(completed_by_subject_id);
create index if not exists accounting_refunds_customer_fk_idx
on accounting_core.refunds(tenant_id,customer_account_id);
create index if not exists accounting_refunds_payment_fk_idx
on accounting_core.refunds(tenant_id,payment_id);
create index if not exists accounting_refunds_invoice_fk_idx
on accounting_core.refunds(tenant_id,invoice_id);
create index if not exists accounting_refunds_credit_note_fk_idx
on accounting_core.refunds(tenant_id,credit_note_id);

create index if not exists accounting_document_events_actor_idx
on accounting_core.document_events(actor_subject_id);
create index if not exists accounting_commands_actor_idx
on accounting_core.commands(actor_subject_id);

create index if not exists zatca_config_created_by_idx
on accounting_zatca.tenant_configurations(created_by_subject_id);
create index if not exists zatca_config_updated_by_idx
on accounting_zatca.tenant_configurations(updated_by_subject_id);
