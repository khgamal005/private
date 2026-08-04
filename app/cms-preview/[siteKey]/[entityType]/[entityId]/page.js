import {notFound} from 'next/navigation';
import BuiltPublicPage from '../../../../../components/built-public-page';
import {authRpc,requirePlatform,requireTenantPermission} from '../../../../../lib/server-auth';
import {getCmsPublicSnapshot} from '../../../../../lib/cms-public';

export const dynamic='force-dynamic';
export const metadata={title:'معاينة المحتوى | Marktone CMS',robots:{index:false,follow:false}};

export default async function CmsPreviewPage({params}){
  const raw=await params;
  const siteKey=decodeURIComponent(raw.siteKey);
  const entityType=raw.entityType;
  if(!['page','article'].includes(entityType))notFound();
  const tenantSlug=siteKey.startsWith('tenant:')?siteKey.slice(7):null;
  if(tenantSlug)await requireTenantPermission(tenantSlug,'tenant.website.manage');
  else await requirePlatform();
  const [builder,snapshot]=await Promise.all([
    authRpc('v3_cms_builder_snapshot',{
      p_site_key:siteKey,p_tenant_slug:tenantSlug,
      p_entity_type:entityType,p_entity_id:raw.entityId
    }),
    getCmsPublicSnapshot({siteKey,tenantSlug})
  ]);
  if(!builder?.entity)notFound();
  return <BuiltPublicPage
    snapshot={snapshot}
    content={{...builder.entity,content:builder.document?.draftDocument}}
    preview
  />;
}
