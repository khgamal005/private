const validSlug=value=>typeof value==='string'&&/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(value);

// This decorator accepts only public navigation metadata. It never forwards the
// authenticated academy workspace, memberships, billing, or staff capabilities.
export function withAcademyPublicNavigation(snapshot,config){
  const slug=config?.tenant?.slug;
  if(config?.enabled!==true||config.components?.website!==true||!validSlug(slug)||snapshot?.site?.key!==`tenant:${slug}`)return snapshot;
  return {...snapshot,site:{...snapshot.site,academyNavigation:{
    slug,lms:config.components?.lms===true,store:config.components?.store===true
  }}};
}

export function academyPublicLinks(site){
  const config=site?.academyNavigation;
  if(!validSlug(config?.slug)||site?.key!==`tenant:${config.slug}`)return null;
  const slug=encodeURIComponent(config.slug);
  return {
    catalog:config.store===true?`/site/${slug}/courses`:null,
    learner:config.lms===true?`/training/login?tenant=${slug}&workspace=academy`:null,
    instructor:config.lms===true?`/training/login?tenant=${slug}&workspace=academy&role=instructor`:null,
    manager:`/academy/login?tenant=${slug}`
  };
}

export function academyPublicMenu(menu,links){
  if(!links)return menu;
  return menu.map(item=>item.href==='/login'?{
    ...item,href:links.learner||links.manager,label:links.learner?'دخول المتدرب':'إدارة المنصة'
  }:item);
}
