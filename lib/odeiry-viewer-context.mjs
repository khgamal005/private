const TENANT_SLUG=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ROLE_KEY=/^[a-z][a-z0-9_]{1,63}$/;
const TENANT_PERMISSION=/^tenant\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/;

const KNOWN_ROLES=new Set([
  'tenant_owner','tenant_admin','executive_manager','sales_manager',
  'sales_supervisor','sales_user','customer_service','data_officer',
  'data_analyst','training_manager','admissions_officer','finance_manager',
  'accountant','cashier','member'
]);

const ROLE_PRIORITY=[
  'tenant_owner','tenant_admin','executive_manager','sales_manager',
  'sales_supervisor','training_manager','admissions_officer','sales_user',
  'customer_service','data_officer','data_analyst','finance_manager',
  'accountant','cashier','member'
];

export function resolveOdeiryViewerContext({
  currentUserContext,
  tenantSlug,
  accessMode
}){
  const slug=typeof tenantSlug==='string'?tenantSlug.trim().toLowerCase():'';
  if(!TENANT_SLUG.test(slug))return null;

  if(accessMode==='platform_operator'){
    return Object.freeze({
      roleKey:'platform_owner',
      permissions:Object.freeze([]),
      accessMode:'platform_operator',
      platformAccess:true
    });
  }
  if(accessMode!=='tenant_member')return null;

  const memberships=Array.isArray(currentUserContext?.memberships)
    ?currentUserContext.memberships:[];
  const membership=memberships.find(item=>
    item&&typeof item==='object'&&item.tenantSlug===slug
  );
  if(!membership)return null;

  const roles=uniqueStrings(membership.roles,ROLE_KEY,24)
    .filter(role=>KNOWN_ROLES.has(role));
  const roleKey=ROLE_PRIORITY.find(role=>roles.includes(role))||'member';
  const permissions=uniqueStrings(
    membership.permissions,TENANT_PERMISSION,120
  );

  return Object.freeze({
    roleKey,
    permissions:Object.freeze(permissions),
    accessMode:'tenant_member',
    platformAccess:false
  });
}

export function publicOdeiryViewerContext(viewer){
  if(!viewer||typeof viewer!=='object')return null;
  return Object.freeze({
    roleKey:KNOWN_ROLES.has(viewer.roleKey)||viewer.roleKey==='platform_owner'
      ?viewer.roleKey:'member',
    accessMode:viewer.accessMode==='platform_operator'
      ?'platform_operator':'tenant_member',
    platformAccess:viewer.platformAccess===true
  });
}

function uniqueStrings(value,pattern,limit){
  if(!Array.isArray(value))return [];
  const output=[];
  const seen=new Set();
  for(const candidate of value){
    if(typeof candidate!=='string')continue;
    const normalized=candidate.trim().toLowerCase();
    if(!pattern.test(normalized)||seen.has(normalized))continue;
    seen.add(normalized);
    output.push(normalized);
    if(output.length>=limit)break;
  }
  return output;
}
