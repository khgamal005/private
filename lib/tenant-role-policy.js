const ROLE_PRIORITY=[
  'tenant_owner',
  'tenant_admin',
  'executive_manager',
  'sales_manager',
  'sales_supervisor',
  'training_manager',
  'admissions_officer',
  'sales_user',
  'customer_service',
  'data_officer',
  'data_analyst',
  'member'
];

export const FOCUSED_OPERATIONAL_ROLES=Object.freeze([
  'sales_user',
  'sales_supervisor',
  'data_officer',
  'data_analyst',
  'admissions_officer'
]);

export const DATA_CAMPAIGN_ROLES=Object.freeze([
  'data_officer',
  'data_analyst'
]);

const FOCUSED_OPERATIONAL_ROLE_SET=new Set(FOCUSED_OPERATIONAL_ROLES);
const DATA_CAMPAIGN_ROLE_SET=new Set(DATA_CAMPAIGN_ROLES);
const POLICY_PREFIX='permissions:';

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
  const known=ROLE_PRIORITY.find(role=>roles.has(role));
  if(known)return known;
  return (membership?.roles||[]).find(role=>role&&role!=='member')
    ||'member';
}

export function navigationPolicyRoleKey(
  permissions=[],
  {platformAccess=false}={}
){
  if(platformAccess)return `${POLICY_PREFIX}111111`;
  const allowed=new Set(permissions||[]);
  const flags=[
    allowed.has('tenant.content.read'),
    allowed.has('tenant.academy.write'),
    allowed.has('tenant.users.manage')
      ||allowed.has('tenant.settings.manage'),
    allowed.has('tenant.people.read'),
    allowed.has('tenant.reports.team'),
    allowed.has('tenant.reports.campaigns')
  ].map(value=>value?'1':'0').join('');
  return `${POLICY_PREFIX}${flags}`;
}

export function tenantRolePolicy(roleKey,{platformAccess=false}={}){
  if(platformAccess){
    return {
      focused:false,
      showNews:true,
      showInteractiveTraining:true,
      showMarketingAutomation:true,
      showTeam:true,
      personalReportsOnly:false,
      showCampaignReports:true
    };
  }

  if(String(roleKey||'').startsWith(POLICY_PREFIX)){
    const flags=String(roleKey).slice(POLICY_PREFIX.length).padEnd(6,'0');
    const [
      showNews,
      showInteractiveTraining,
      showMarketingAutomation,
      showTeam,
      viewTeamReports,
      showCampaignReports
    ]=Array.from(flags).map(value=>value==='1');
    return {
      focused:!viewTeamReports,
      showNews,
      showInteractiveTraining,
      showMarketingAutomation,
      showTeam,
      personalReportsOnly:!viewTeamReports,
      showCampaignReports
    };
  }

  const focused=FOCUSED_OPERATIONAL_ROLE_SET.has(roleKey);
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
  const membership=context?.memberships?.find(
    item=>item.tenantSlug===slug
  );
  const policyKey=navigationPolicyRoleKey(
    membership?.permissions||[],
    {platformAccess:Boolean(context?.platformAccess)}
  );
  return {
    roleKey,
    ...tenantRolePolicy(policyKey,{
      platformAccess:Boolean(context?.platformAccess)
    })
  };
}
