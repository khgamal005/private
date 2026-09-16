import Link from 'next/link';
import {authRpc,requireTenantPermission} from '../../../../../lib/server-auth';
import {campaignFilters} from '../../../../../lib/campaign-revenue.mjs';
import SocialConnectV2 from '../../../../../components/social-connect-v2';
import styles from '../../../../../components/campaign-report-platform-nav.module.css';
export const dynamic='force-dynamic';
export default async function SocialConnectPage({params,searchParams}){
 const [{slug},query]=await Promise.all([params,searchParams]);
 const context=await requireTenantPermission(slug,'tenant.meta_connect.read');
 const membership=context?.memberships?.find(item=>item.tenantSlug===slug);
 const canManage=Boolean(context?.platformAccess||membership?.permissions?.includes('tenant.meta_connect.manage'));
 const snapshot=await authRpc('v1_tenant_meta_connect_v2_snapshot',{p_tenant_slug:slug},{timeoutMs:8000,retryTransient:true});
 const filters=campaignFilters(query);
 return <main className={styles.platformPage} dir="rtl"><header className={styles.platformHeading}><div><h1>إعدادات Meta</h1><p>الحساب الإعلاني، وحالة الاتصال، والمزامنة.</p></div><Link href={`/tenant/${encodeURIComponent(slug)}/reports/campaigns?platform=meta`}>عرض التقرير ←</Link></header>
 <SocialConnectV2 slug={slug} initialData={snapshot} reportFilters={filters} canManage={canManage} outcome={query.social_connect} reason={query.reason} display="connection"/>
 </main>;
}
