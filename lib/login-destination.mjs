function isPathInside(path,base){
  return path===base||path.startsWith(`${base}/`)||path.startsWith(`${base}?`);
}

export function safeInternalPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')){
    return null;
  }
  try{
    const parsed=new URL(value,'https://odeir.com');
    if(parsed.origin!=='https://odeir.com')return null;
    const destination=`${parsed.pathname}${parsed.search}`;
    if(destination.startsWith('//'))return null;
    return destination;
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
    ||permissions.includes('platform.support.read')
    ||permissions.includes('platform.support.reply')
    ||permissions.includes('platform.support.manage')
  );
}

function platformHome(context){
  const permissions=Array.isArray(context?.platformPermissions)
    ?context.platformPermissions
    :[];
  const canOpenOverview=Boolean(
    context?.platformControlAccess
    ||context?.platformAccess
    ||permissions.includes('platform.control.read')
  );
  return canOpenOverview?'/control':'/control/support';
}

export function resolvePostLoginPath({
  context={},
  requestedNext=null,
  acceptedTenantInvitation=null,
  acceptedPlatformInvitation=null
}={}){
  if(context.subject?.mustChangePassword)return '/change-password';
  if(acceptedPlatformInvitation)return platformHome(context);
  if(acceptedTenantInvitation?.tenantSlug){
    return `/tenant/${encodeURIComponent(acceptedTenantInvitation.tenantSlug)}`;
  }

  const requested=safeInternalPath(requestedNext);
  if(canAccessPlatformControl(context)){
    const home=platformHome(context);
    if(requested&&isPathInside(requested,'/control')){
      if(home==='/control/support'&&!isPathInside(requested,home))return home;
      return requested;
    }
    return home;
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
