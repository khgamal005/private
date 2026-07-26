import {getControl} from '../../../lib/api';
import MarketMirrorControl from '../../../components/market-mirror-control';

export const dynamic='force-dynamic';

export default async function PlatformSettings(){
  const data=await getControl();
  return <>
    <header className="mt-page-head"><div><small>PLATFORM SETTINGS</small><h2>إعدادات المنصة والتكاملات</h2><p>إعدادات عامة منفصلة عن إعدادات كل منشأة.</p></div></header>
    <section className="mt-kpis">
      <article className="mt-kpi"><span>قوالب الأدوار</span><b>{data.roles?.length||0}</b><small>أدوار مركزية للنظام</small></article>
      <article className="mt-kpi"><span>الإضافات</span><b>{data.features?.length||0}</b><small>خصائص قابلة للتفعيل</small></article>
      <article className="mt-kpi"><span>التكاملات</span><b>{data.integrations?.length||0}</b><small>مزودو الخدمات والاتصالات</small></article>
      <article className="mt-kpi"><span>سجلات الأمان</span><b>{data.audit?.length||0}</b><small>عمليات محفوظة في اللقطة الحالية</small></article>
    </section>
    <section className="mt-grid">
      <article className="mt-panel"><header className="mt-panel-head"><div><h3>التكاملات</h3><p>حالة الاتصالات الحالية</p></div></header><div className="mt-panel-body mt-list">{(data.integrations||[]).map(item=><div className="mt-list-row" key={item.id}><div><b>{item.name}</b><small>{item.type} · {item.tenantName||'المنصة المركزية'}</small></div><span className={`mt-status ${item.status==='active'?'active':''}`}>{item.status}</span></div>)}{!(data.integrations||[]).length&&<div className="mt-empty">لا توجد تكاملات مسجلة.</div>}</div></article>
      <article className="mt-panel"><header className="mt-panel-head"><div><h3>الأدوار المركزية</h3><p>قوالب الوصول على مستوى المنصة</p></div></header><div className="mt-panel-body mt-list">{(data.roles||[]).slice(0,8).map(item=><div className="mt-list-row" key={item.key}><div><b>{item.nameAr}</b><small>{item.key} · {item.scope}</small></div><span className="mt-status active">{item.system?'نظام':'مخصص'}</span></div>)}</div></article>
    </section>
    <section className="mt-settings-section"><MarketMirrorControl/></section>
  </>;
}
