import {cache} from 'react';
import {authRpc} from './server-auth';

function missingRpc(error,functionName){
  const detail=error instanceof Error?error.message:String(error||'');
  return detail.includes('PGRST202')
    ||detail.includes(`Could not find the function public.${functionName}`)
    ||detail.includes(`function public.${functionName}`);
}

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

export async function getTenant(slug,{
  includeAccess=false,
  includeRoles=false
}={}){
  const shouldLoadRoles=includeAccess||includeRoles;
  const [workspace,access,effectiveRoles]=await Promise.all([
    authRpc('v2_tenant_workspace_snapshot',{p_slug:slug}),
    includeAccess
      ?authRpc('v2_tenant_access_snapshot',{p_slug:slug})
      :Promise.resolve({}),
    shouldLoadRoles
      ?authRpc('v2_tenant_effective_roles_snapshot',{p_slug:slug})
        .catch(error=>{
          if(missingRpc(error,'v2_tenant_effective_roles_snapshot')){
            return null;
          }
          throw error;
        })
      :Promise.resolve(null)
  ]);
  return {
    ...workspace,
    ...access,
    users:access.employees||[],
    employees:workspace.employees||[],
    services:workspace.services||[],
    departments:workspace.departments||[],
    roles:effectiveRoles?.roles||access.roles||workspace.roles||[]
  };
}

export async function getTenantWooCommerce(slug){
  return authRpc('v2_tenant_woocommerce_snapshot',{p_slug:slug});
}

export const getTenantAddonNavigation=cache(async function getTenantAddonNavigation(slug){
  return authRpc('v3_tenant_addon_navigation_snapshot',{p_slug:slug});
});

export async function getTenantSettings(slug,{addonAccess}={}){
  const access=addonAccess||await getTenantAddonNavigation(slug);
  const enabled=new Set(access?.enabledProductKeys||[]);
  const hasAny=keys=>keys.some(key=>enabled.has(key));
  const [
    tenant,
    integrationHub,
    automationStudio,
    deliveryAnalytics,
    roleManagement
  ]=await Promise.all([
    getTenant(slug,{includeAccess:true,includeRoles:true}),
    hasAny(['whatsapp','email','api','templates'])
      ?authRpc('v2_tenant_integration_hub_snapshot',{p_slug:slug})
      :Promise.resolve(null),
    enabled.has('automation')
      ?authRpc('v2_tenant_automation_studio_snapshot_v2',{p_slug:slug})
      :Promise.resolve(null),
    enabled.has('delivery_analytics')
      ?authRpc('v2_tenant_delivery_analytics_snapshot_v2',{
        p_slug:slug,
        p_days:30
      })
      :Promise.resolve(null),
    authRpc('v2_tenant_role_management_snapshot',{p_slug:slug})
      .catch(error=>{
        if(missingRpc(error,'v2_tenant_role_management_snapshot')){
          return null;
        }
        throw error;
      })
  ]);
  return {
    ...tenant,
    integrationHub,
    automationStudio,
    deliveryAnalytics,
    addonAccess:access,
    roleManagement:roleManagement||{
      roles:tenant.roles||[],
      permissions:[],
      departments:tenant.departments||[]
    }
  };
}

export async function getTenantMarketplace(slug){
  return authRpc('v3_tenant_service_marketplace_snapshot',{p_slug:slug})
    .catch(error=>{
      if(missingRpc(error,'v2_tenant_service_marketplace_snapshot')){
        return authRpc('v1_tenant_marketplace_snapshot',{p_slug:slug});
      }
      throw error;
    });
}

export async function getPlatformMarketplace(){
  return authRpc('v1_platform_marketplace_snapshot');
}

export async function getPlatformMarketplacePromotions(){
  return authRpc('v1_platform_marketplace_promotions_snapshot');
}

export async function getPlatformCommerce(){
  const [commerce,providerAdmin]=await Promise.all([
    authRpc('v4_platform_commerce_snapshot'),
    authRpc('v3_platform_payment_provider_admin_snapshot')
  ]);
  return {
    ...commerce,
    paymentProviders:providerAdmin.paymentProviders||[],
    paymentProviderAdmin:{
      schemaVersion:providerAdmin.schemaVersion,
      generatedAt:providerAdmin.generatedAt
    }
  };
}

export async function getPlatformServiceMarketplace(){
  return authRpc('v2_platform_service_marketplace_snapshot')
    .catch(async error=>{
      if(!missingRpc(error,'v1_platform_service_marketplace_snapshot')){
        throw error;
      }
      const commerce=await getPlatformCommerce();
      return {
        ...commerce,
        summary:{
          providerCount:0,
          activeProviders:0,
          verifiedProviders:0,
          courseCount:0,
          publishedServices:(commerce.services||[]).filter(
            item=>['active','beta'].includes(item.status)
          ).length,
          openServiceOrders:(commerce.orders||[]).filter(
            item=>item.kind==='service'
              &&['paid','in_progress'].includes(item.status)
          ).length
        },
        providers:[],
        courses:[]
      };
    });
}

export async function getTenantAddonCenter(slug){
  return authRpc('v3_tenant_addon_center_snapshot',{p_slug:slug});
}

export async function getPlatformAddonCenter(){
  const [center,providerAdmin]=await Promise.all([
    authRpc('v3_platform_addon_center_snapshot'),
    authRpc('v3_platform_payment_provider_admin_snapshot')
  ]);
  return {
    ...center,
    paymentProviders:providerAdmin.paymentProviders||[],
    paymentProviderAdmin:{
      schemaVersion:providerAdmin.schemaVersion,
      generatedAt:providerAdmin.generatedAt
    }
  };
}

export async function getTenantYeastarAccess(slug){
  return authRpc('v3_tenant_yeastar_access_snapshot',{
    p_slug:slug
  });
}

export const getTenantDashboardLive=cache(async function getTenantDashboardLive(slug){
  return authRpc(
    'v2_tenant_dashboard_live_snapshot',
    {p_slug:slug},
    {retryTransient:true,timeoutMs:8000}
  );
});

export async function getTenantTaskCalendar(slug,{
  includeSales=true,
  taskScope='all'
}={}){
  return authRpc(
    'v1_tenant_task_calendar_snapshot',
    {
      p_slug:slug,
      p_task_scope:taskScope,
      p_include_sales:includeSales
    },
    {retryTransient:true,timeoutMs:8000}
  );
}

export async function getTenantSalesWorkspace(slug,{
  limit=80,
  query=null,
  filter='all',
  from=null,
  to=null,
  focusContactId=null,
  includeAuxiliary=true,
  cursor=null
}={}){
  return authRpc(
    'v2_tenant_sales_workspace_snapshot',
    {
      p_slug:slug,
      p_limit:limit,
      p_query:query||null,
      p_filter:filter,
      p_from:from||null,
      p_to:to||null,
      p_focus_contact_id:focusContactId||null,
      p_include_auxiliary:includeAuxiliary,
      p_after_next_action_at:cursor?.nextActionAt||null,
      p_after_created_at:cursor?.createdAt||null,
      p_after_id:cursor?.id||null,
      p_after_next_action_is_null:Boolean(cursor?.nextActionIsNull)
    },
    {timeoutMs:4500}
  );
}

const SALES_TASK_ROLE_KEYS=new Set([
  'sales_manager',
  'sales_supervisor',
  'sales_user'
]);
const SALES_TASK_SOURCES=new Set([
  'lead_assignment',
  'opportunity_next_action',
  'activity_next_action',
  'lead_next_action',
  'sales_followup'
]);

export async function getTenantOperations(slug,{
  includeSales=true,
  taskScope='all'
}={}){
  const [operations,sales,reassignment]=await Promise.all([
    authRpc('v4_tenant_operations_snapshot',{p_slug:slug}),
    includeSales
      ?authRpc('v4_tenant_sales_pipeline_snapshot',{p_slug:slug})
      :Promise.resolve({}),
    includeSales
      ?authRpc('v1_tenant_lead_reassignment_snapshot',{p_slug:slug})
        .catch(error=>{
          if(missingRpc(error,'v1_tenant_lead_reassignment_snapshot')){
            return {
              viewer:{canReassign:false,isDataOfficer:false},
              activeAssignments:[],
              dailyLeadDistribution:{
                total:0,
                taskIds:[],
                byStaff:[],
                items:[]
              }
            };
          }
          throw error;
        })
      :Promise.resolve({})
  ]);
  const activeAssignmentsByContact=new Map(
    (reassignment.activeAssignments||[]).map(assignment=>[
      assignment.contactId,
      assignment
    ])
  );
  const contacts=(sales.contacts||operations.contacts||[]).map(contact=>{
    const assignment=activeAssignmentsByContact.get(contact.id);
    return {
      ...contact,
      activeAssignmentId:assignment?.assignmentId||null,
      activeAssignmentStaffId:assignment?.assignedStaffId||null
    };
  });
  const contactsById=new Map(contacts.map(contact=>[
    contact.id,
    contact
  ]));
  const enrichTask=task=>{
    const contact=contactsById.get(task.contactId)||{};
    return {
      ...task,
      contactPhone:contact.phone||null,
      contactStatus:contact.leadStatus||null,
      contactQuality:contact.leadQuality||null,
      contactCourseName:contact.interestCourseName||null,
      contactSource:contact.source||null,
      contactNextActionType:contact.nextActionType||null,
      contactLatestNote:contact.latestNote||contact.notes||null,
      contactLatestNoteAt:contact.latestNoteAt||contact.updatedAt||null,
      contactLatestNoteType:contact.latestNoteType||null
    };
  };
  const dailyLeadDistribution=reassignment.dailyLeadDistribution||{
    total:0,
    taskIds:[],
    byStaff:[],
    items:[]
  };
  const staff=operations.staff||[];
  const staffById=new Map(staff.map(item=>[item.id,item]));
  const salesScope=taskScope==='sales';
  const taskInScope=task=>{
    if(!salesScope)return true;
    if(task.taskSource==='registration_handoff')return false;
    return SALES_TASK_SOURCES.has(task.taskSource)
      ||SALES_TASK_ROLE_KEYS.has(
        staffById.get(task.assignedStaffId)?.roleKey
      );
  };
  return {
    ...operations,
    ...sales,
    viewer:{
      ...(operations.viewer||{}),
      ...(sales.viewer||{}),
      ...(reassignment.viewer||{})
    },
    summary:{...(operations.summary||{}),...(sales.summary||{})},
    dailyLeadDistribution:{
      ...dailyLeadDistribution,
      items:(dailyLeadDistribution.items||[]).map(enrichTask)
    },
    staff:salesScope
      ?staff.filter(item=>SALES_TASK_ROLE_KEYS.has(item.roleKey))
      :staff,
    contacts,
    tasks:(operations.tasks||[]).map(enrichTask).filter(taskInScope)
  };
}

export async function getTenantCustomerSearch(slug){
  return authRpc('v2_tenant_customer_search',{p_slug:slug});
}

export const getTenantRoleDashboard=cache(async function getTenantRoleDashboard(
  slug,
  from=null,
  to=null
){
  return authRpc('v2_tenant_role_dashboard_snapshot_v8',{
    p_slug:slug,
    p_from:from,
    p_to:to
  },{timeoutMs:12000});
});

export async function getTenantReports(slug,{
  from,
  to,
  staffId=null,
  report='overview',
  limit=50,
  page=1
}={}){
  return authRpc('v5_tenant_reports_snapshot',{
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
  const [leadIntake,commerceOrders,reassignment]=await Promise.all([
    authRpc('v2_tenant_lead_intake_snapshot',{p_slug:slug}),
    authRpc('v3_tenant_commerce_order_queue_snapshot',{p_slug:slug})
      .catch(error=>{
        if(missingRpc(error,'v3_tenant_commerce_order_queue_snapshot')){
          return null;
        }
        throw error;
      }),
    authRpc('v1_tenant_lead_reassignment_snapshot',{p_slug:slug})
      .catch(error=>{
        if(missingRpc(error,'v1_tenant_lead_reassignment_snapshot')){
          return {viewer:{canReassign:false,isDataOfficer:false}};
        }
        throw error;
      })
  ]);
  return {
    ...leadIntake,
    commerceOrders,
    viewer:{
      ...(leadIntake.viewer||{}),
      ...(reassignment.viewer||{})
    }
  };
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

export async function getTenantLms(slug){
  const [
    batches,
    trainingOperations,
    trainingAutomation
  ]=await Promise.all([
    authRpc('v2_tenant_course_runs_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_training_operations_snapshot',{p_slug:slug}),
    authRpc('v2_tenant_training_automation_snapshot',{p_slug:slug})
  ]);
  return {
    ...batches,
    timezone:batches.timezone,
    batchSummary:batches.summary||{},
    courses:batches.courses||[],
    courseRuns:batches.courseRuns||[],
    trainingOperations,
    trainingAutomation,
    viewer:batches.viewer||{}
  };
}

export async function getTenantAccounting(slug){
  const [accounting,zatca]=await Promise.all([
    authRpc('v1_tenant_accounting_snapshot',{p_slug:slug}),
    authRpc('v1_tenant_zatca_snapshot',{p_slug:slug}).catch(error=>{
      if(missingRpc(error,'v1_tenant_zatca_snapshot')){
        return {addonEnabled:false,availability:'addon_required'};
      }
      throw error;
    })
  ]);
  return {...accounting,zatca};
}

export async function getTenantCertificate(slug,certificateId){
  return authRpc('v2_tenant_certificate_snapshot',{
    p_slug:slug,
    p_certificate_id:certificateId
  });
}
