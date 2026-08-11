function isPathInside(path,base){
  return path===base||path.startsWith(`${base}/`)||path.startsWith(`${base}?`);
}

export function safeInternalPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')){
    return null;
  }
  try{
    const parsed=new URL(value,'https://app.marktone.sa');
    if(parsed.origin!=='https://app.marktone.sa')return null;
    return `${parsed.pathname}${parsed.search}`;
  }catch{
    return null;
  }
}

export function canAccessPlatformControl(context){
  const permissions=Array.isArray(context?.platformPermissions)
    ?context.platformPermissions
    :[];
  return Boolean(
    context?.platformControlAccess
    ||context?.platformAccess
    ||permissions.includes('platform.control.read')
  );
}

export function resolvePostLoginPath({
  context={},
  requestedNext=null,
  acceptedTenantInvitation=null,
  acceptedPlatformInvitation=null
}={}){
  if(context.subject?.mustChangePassword)return '/change-password';
  if(acceptedPlatformInvitation)return '/control';
  if(acceptedTenantInvitation?.tenantSlug){
    return `/tenant/${encodeURIComponent(acceptedTenantInvitation.tenantSlug)}`;
  }

  const requested=safeInternalPath(requestedNext);
  if(canAccessPlatformControl(context)){
    return requested&&isPathInside(requested,'/control')
      ?requested
      :'/control';
  }

  const memberships=Array.isArray(context.memberships)
    ?context.memberships
    :[];
  if(requested){
    const matching=memberships.find(item=>{
      if(!item?.tenantSlug)return false;
      const base=`/tenant/${encodeURIComponent(item.tenantSlug)}`;
      return isPathInside(requested,base);
    });
    if(matching)return requested;
  }

  return memberships[0]?.tenantSlug
    ?`/tenant/${encodeURIComponent(memberships[0].tenantSlug)}`
    :'/';
}
