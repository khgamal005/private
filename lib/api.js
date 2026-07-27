import {authRpc} from './server-auth';

export async function getControl(){
  const [base,provisioning]=await Promise.all([
    authRpc('v2_platform_control_snapshot'),
    authRpc('v2_platform_provisioning_snapshot')
  ]);
  const tenantDetails=new Map((provisioning.tenants||[]).map(item=>[item.tenantId,item]));
  return {
    ...base,
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

export async function getTenant(slug){
  const [workspace,access]=await Promise.all([
    authRpc('v2_tenant_workspace_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_access_snapshot',{p_slug:slug})
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

export async function getTenantOperations(slug){
  const [operations,sales]=await Promise.all([
    authRpc('v2_tenant_operations_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_sales_pipeline_snapshot',{p_slug:slug})
  ]);
  const contacts=sales.contacts||[];
  const contactsById=new Map(contacts.map(contact=>[contact.id,contact]));
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

export async function getTenantAdmissions(slug){
  return authRpc('v2_tenant_admissions_snapshot',{p_slug:slug});
}
