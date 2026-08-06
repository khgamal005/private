import Link from 'next/link';
import {getTenantYeastarAccess} from '../../../../../lib/api';
import {requireTenantPermission} from '../../../../../lib/server-auth';
import YeastarAddonUnavailable from '../../../../../components/yeastar-addon-unavailable';
import YeastarSettings from '../../../../../components/yeastar-settings';

export const dynamic='force-dynamic';

export default async function YeastarSettingsPage({params}){
  const {slug}=await params;
  await requireTenantPermission(slug,'tenant.settings.manage');
  const access=await getTenantYeastarAccess(slug);

  if(!access.enabled){
    return <YeastarAddonUnavailable
      slug={slug}
      canManage={access.canManage}
    />;
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>إضافة مدفوعة · YEASTAR P-SERIES</small>
        <h2>إعدادات إضافة Yeastar</h2>
        <p>
          إعداد الاتصال والتحويلات والمزامنة مستقل تمامًا عن
          إعدادات المستخدمين والأدوار والصلاحيات.
        </p>
      </div>
      <div className="mt-page-actions">
        <Link
          className="mt-button"
          href={`/tenant/${encodeURIComponent(slug)}/yeastar`}
        >
          تقارير المكالمات
        </Link>
        <span className="mt-status active">الإضافة نشطة</span>
      </div>
    </header>
    <YeastarSettings slug={slug}/>
  </>;
}
