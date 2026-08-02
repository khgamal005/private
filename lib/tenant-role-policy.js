const ROLE_PRIORITY=[
  'tenant_owner',
  'tenant_admin',
  'executive_manager',
  'sales_manager',
  'sales_supervisor',
  'sales_user',
  'customer_service',
  'data_officer',
  'data_analyst',
  'training_manager',
  'member'
];

export const FOCUSED_OPERATIONAL_ROLES=Object.freeze([
  'sales_user',
  'sales_supervisor',
  'data_officer',
  'data_analyst'
]);

export const DATA_CAMPAIGN_ROLES=Object.freeze([
  'data_officer',
  'data_analyst'
]);

const FOCUSED_OPERATIONAL_ROLE_SET=new Set(FOCUSED_OPERATIONAL_ROLES);
const DATA_CAMPAIGN_ROLE_SET=new Set(DATA_CAMPAIGN_ROLES);

export function resolveTenantRoleKey({
  context,
  slug,
  preferredRoleKey=null
}={}){
  if(context?.platformAccess)return 'platform_owner';
  if(preferredRoleKey&&preferredRoleKey!=='member')return preferredRoleKey;
  const membership=context?.memberships?.find(
    item=>item.tenantSlug===slug
  );
  const roles=new Set(membership?.roles||[]);
  return ROLE_PRIORITY.find(role=>roles.has(role))||'member';
}

export function tenantRolePolicy(roleKey,{platformAccess=false}={}){
  const focused=Boolean(
    !platformAccess&&FOCUSED_OPERATIONAL_ROLE_SET.has(roleKey)
  );
  return {
    focused,
    showNews:!focused,
    showInteractiveTraining:!focused,
    showMarketingAutomation:!focused,
    showTeam:!focused,
    personalReportsOnly:focused,
    showCampaignReports:!focused||DATA_CAMPAIGN_ROLE_SET.has(roleKey)
  };
}

export function tenantRolePolicyFromContext(context,slug){
  const roleKey=resolveTenantRoleKey({context,slug});
  return {
    roleKey,
    ...tenantRolePolicy(roleKey,{
      platformAccess:Boolean(context?.platformAccess)
    })
  };
}
