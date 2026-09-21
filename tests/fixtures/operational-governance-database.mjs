import {readFile} from 'node:fs/promises';
import {setup as trainingSetup,id} from './training-journey-database.mjs';
const read=path=>readFile(new URL(path,new URL('../',import.meta.url)),'utf8');
const migrations=[
  '20260921125610_financial_governance_v1.sql',
  '20260921125620_sales_identity_governance_v1.sql',
  '20260921125631_admissions_lifecycle_governance_v1.sql',
  '20260921125642_diploma_contracts_governance_v1.sql',
  '20260921125653_tenant_operating_foundation_v1.sql'
];
export async function setup({database=null}={}){
  const db=await trainingSetup({database});
  try{
    const incentives=await read('../supabase/migrations/20260729213000_goals_incentives_v2.sql');
    await db.exec(incentives.slice(0,incentives.indexOf('create or replace function private_app.incentive_role_keys')));
    await db.exec(await read('./fixtures/operational-governance-live-schema.sql'));
    await db.exec(await read('./fixtures/operational-governance-live-functions.sql'));
    await db.exec(await read('./fixtures/financial-governance-live-functions.sql'));
    // Main contains a future beneficiary migration that is not present in the
    // inspected production schema. This deliberately tests the production case.
    await db.exec('set check_function_bodies=off');
    await db.exec(await read('../supabase/migrations/20260910143003_sales_followup_multiple_interests_v1.sql'));
    await db.exec('set check_function_bodies=on');
    await db.exec(`
      create trigger registration_documents_force_optional before insert or update of is_required on academy.registration_documents for each row execute function private_app.force_registration_document_optional();
      create trigger sales_contacts_prepare_identity_fields before insert or update of phone,whatsapp,email on sales_core.contacts for each row execute function private_app.prepare_contact_identity_fields();
      create trigger sales_contacts_sync_identities after insert or update of phone,whatsapp,email on sales_core.contacts for each row execute function private_app.sync_contact_identities();
      create trigger sales_contacts_set_updated_at before update on sales_core.contacts for each row execute function private_app.set_updated_at();
      create trigger capture_task_history_after_update after update of status,due_at,assigned_staff_id,title,description,priority,metadata on work_core.tasks for each row execute function private_app.capture_task_history_v1();
      create trigger guard_terminal_contact_sales_task_before_insert before insert on work_core.tasks for each row execute function private_app.guard_terminal_contact_sales_task_insert_v1();
      create trigger complete_terminal_contact_sales_tasks_after_update after update of lead_status on sales_core.contacts for each row when(old.lead_status is distinct from new.lead_status and new.lead_status in('paid','payment_submitted','not_interested','unqualified','wrong_number','duplicate','cancelled')) execute function private_app.complete_terminal_contact_sales_tasks_v1();
    `);
    for(const migration of migrations){
      try{await db.exec(await read('../supabase/migrations/'+migration));}
      catch(error){error.message=migration+': '+error.message;throw error;}
    }
    // The public v3 snapshot reads the existing order header even for free
    // admissions. Keep this empty connector seam separate from the optional
    // beneficiary schema, which is deliberately absent from this fixture.
    await db.exec(`alter table sales_core.commerce_order_work_items add column order_number text;
      create unique index fixture_commerce_work_item_tenant_id on sales_core.commerce_order_work_items(tenant_id,id);`);
    const commerce=await read('../supabase/migrations/20260910201255_woocommerce_admissions_v1.sql');
    await db.exec(commerce.slice(commerce.indexOf('create table sales_core.commerce_admission_orders ('),commerce.indexOf('create table sales_core.commerce_admission_lines (')));
    for(const permission of ['tenant.crm.read','tenant.crm.write','tenant.people.manage','tenant.accounting.customers.write','tenant.accounting.payments.record','tenant.accounting.refunds.request','tenant.accounting.settings.manage','tenant.accounting.invoices.write','tenant.accounting.invoices.issue']){
      await db.query("insert into access_control.permissions(permission_key,module_key,name_ar) values($1,'operating',$1) on conflict do nothing",[permission]);
      await db.query('insert into access_control.role_permissions(role_id,permission_key) values($1,$2) on conflict do nothing',[id(21),permission]);
    }
    await db.query("select set_config('fixture.addon','no',false)");
    return db;
  }catch(error){await db.close();delete error.query;throw error;}
}
