import {getPlatformControl} from '../../../lib/platform-api';
import {hasPlatformPermission,requireAnyPlatformPermission} from '../../../lib/server-auth';
import MarketMirrorControl from '../../../components/market-mirror-control';
import RegistrationActivationPolicy from '../../../components/registration-activation-policy';
import {getPlatformRegistrationPolicy} from '../../../lib/platform-registration-policy';

export const dynamic='force-dynamic';

export default async function PlatformSettings(){
  const context=await requireAnyPlatformPermission([
    'platform.settings.manage',
    'platform.control.write'
  ]);
  const canManageRegistrationPolicy=hasPlatformPermission(
    context,'platform.settings.manage'
  );
  const [data,registrationPolicy]=await Promise.all([
    getPlatformControl(),
    canManageRegistrationPolicy?getPlatformRegistrationPolicy():Promise.resolve(null)
  ]);
  return <>
    <header className="mt-page-head"><div><small>PLATFORM SETTINGS</small><h2>إعدادات المنصة والتكاملات</h2><p>إعدادات عامة منفصلة عن إعدادات كل منشأة وتظهر للمخولين فقط.</p></div></header>
    {registrationPolicy&&<RegistrationActivationPolicy initialPolicy={registrationPolicy}/>} 
    <section className="mt-kpis">
      <article className="mt-kpi"><span>الإضافات</span><b>{data.features?.length||0}</b><small>خصائص قابلة للتفعيل</small></article>
      <article className="mt-kpi"><span>التكاملات</span><b>{data.integrations?.length||0}</b><small>مزودو الخدمات والاتصالات</small></article>
      <article className="mt-kpi"><span>سجلات الأمان</span><b>{data.audit?.length||0}</b><small>عمليات متاحة وفق الصلاحية</small></article>
      <article className="mt-kpi"><span>حالة المنصة</span><b>نشطة</b><small>الإعدادات المركزية تعمل</small></article>
    </section>
    <section className="mt-grid">
      <article className="mt-panel"><header className="mt-panel-head"><div><h3>التكاملات</h3><p>حالة الاتصالات الحالية</p></div></header><div className="mt-panel-body mt-list">{(data.integrations||[]).map(item=><div className="mt-list-row" key={item.id}><div><b>{item.name}</b><small>{item.type} · {item.tenantName||'المنصة المركزية'}</small></div><span className={`mt-status ${item.status==='active'?'active':''}`}>{item.status}</span></div>)}{!(data.integrations||[]).length&&<div className="mt-empty">لا توجد تكاملات مسجلة.</div>}</div></article>
      <article className="mt-panel"><header className="mt-panel-head"><div><h3>الإضافات المركزية</h3><p>الخصائص المتاحة للباقات والمنشآت</p></div></header><div className="mt-panel-body mt-list">{(data.features||[]).slice(0,10).map(item=><div className="mt-list-row" key={item.key}><div><b>{item.nameAr}</b><small>{item.key} · {item.category}</small></div><span className="mt-status active">{item.status}</span></div>)}{!(data.features||[]).length&&<div className="mt-empty">لا توجد إضافات متاحة لهذه الصلاحية.</div>}</div></article>
    </section>
    <section className="mt-settings-section"><MarketMirrorControl/></section>
  </>;
}
