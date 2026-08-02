import {cache} from 'react';
import {authRpc} from './server-auth';

export async function getControl(){
  const [base,provisioning,addonCenter]=await Promise.all([
    authRpc('v2_platform_control_snapshot'),
    authRpc('v2_platform_provisioning_snapshot'),
    authRpc('v2_platform_addon_center_snapshot')
  ]);
  const tenantDetails=new Map((provisioning.tenants||[]).map(item=>[
    item.tenantId,
    item
  ]));
  return {
    ...base,
    addonCenter,
    pendingInvitations:provisioning.pendingInvitations||0,
    invitations:provisioning.invitations||[],
    tenants:(base.tenants||[]).map(tenant=>{
      const details=tenantDetails.get(tenant.id)||{};
      return {
        ...tenant,
        ...details,
        employees:details.memberCount??tenant.employees??0
      };
    })
  };
}

export async function getTenant(slug,{includeAccess=false}={}){
  const [workspace,access]=await Promise.all([
    authRpc('v2_tenant_workspace_snapshot',{p_slug:slug}),
    includeAccess
      ?authRpc('v2_tenant_access_snapshot',{p_slug:slug})
      :Promise.resolve({})
  ]);
  return {
    ...workspace,
    ...access,
    users:access.employees||[],
    employees:workspace.employees||[],
    services:workspace.services||[],
    departments:workspace.departments||[]
  };
}

export async function getTenantWooCommerce(slug){
  return authRpc('v2_tenant_woocommerce_snapshot',{p_slug:slug});
}

export async function getTenantSettings(slug){
  const [
    tenant,
    integrationHub,
    automationStudio,
    deliveryAnalytics,
    addonCenter
  ]=await Promise.all([
    getTenant(slug,{includeAccess:true}),
    authRpc('v2_tenant_integration_hub_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_automation_studio_snapshot_v2',{p_slug:slug}),
    authRpc('v2_tenant_delivery_analytics_snapshot_v2',{
      p_slug:slug,
      p_days:30
    }),
    authRpc('v2_tenant_addon_center_snapshot',{p_slug:slug})
  ]);
  return {
    ...tenant,
    integrationHub,
    automationStudio,
    deliveryAnalytics,
    addonCenter
  };
}

export async function getTenantOperations(slug,{includeSales=true}={}){
  const [operations,sales]=await Promise.all([
    authRpc('v2_tenant_operations_snapshot',{p_slug:slug}),
    includeSales
      ?authRpc('v2_tenant_sales_pipeline_snapshot',{p_slug:slug})
      :Promise.resolve({})
  ]);
  const contacts=sales.contacts||operations.contacts||[];
  const contactsById=new Map(contacts.map(contact=>[
    contact.id,
    contact
  ]));
  return {
    ...operations,
    ...sales,
    viewer:{...(operations.viewer||{}),...(sales.viewer||{})},
    summary:{...(operations.summary||{}),...(sales.summary||{})},
    contacts,
    tasks:(operations.tasks||[]).map(task=>{
      const contact=contactsById.get(task.contactId)||{};
      return {
        ...task,
        contactPhone:contact.phone||null,
        contactStatus:contact.leadStatus||null,
        contactQuality:contact.leadQuality||null,
        contactCourseName:contact.interestCourseName||null,
        contactSource:contact.source||null,
        contactNextActionType:contact.nextActionType||null
      };
    })
  };
}

export const getTenantRoleDashboard=cache(async function getTenantRoleDashboard(
  slug
){
  return authRpc('v2_tenant_role_dashboard_snapshot_v2',{p_slug:slug});
});

export async function getTenantReports(slug,{
  from,
  to,
  staffId=null,
  report='overview',
  limit=50,
  page=1
}={}){
  return authRpc('v2_tenant_reports_snapshot_v1',{
    p_slug:slug,
    p_from:from||null,
    p_to:to||null,
    p_staff_id:staffId||null,
    p_report:report,
    p_limit:limit,
    p_offset:(Math.max(1,Number(page)||1)-1)*limit
  });
}

export async function getTenantLeadIntake(slug){
  return authRpc('v2_tenant_lead_intake_snapshot',{p_slug:slug});
}

export async function getTenantAdmissions(slug){
  const [
    admissions,
    batches,
    trainingOperations,
    trainingAutomation
  ]=await Promise.all([
    authRpc('v2_tenant_admissions_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_course_runs_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_training_operations_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_training_automation_snapshot',{p_slug:slug})
  ]);
  return {
    ...admissions,
    timezone:batches.timezone,
    batchSummary:batches.summary||{},
    courses:batches.courses||admissions.courses||[],
    courseRuns:batches.courseRuns||[],
    trainingOperations,
    trainingAutomation,
    viewer:{
      ...(admissions.viewer||{}),
      ...(batches.viewer||{})
    }
  };
}

export async function getTenantCertificate(slug,certificateId){
  return authRpc('v2_tenant_certificate_snapshot',{
    p_slug:slug,
    p_certificate_id:certificateId
  });
}
