import Link from 'next/link';
import styles from './campaign-report-platform-nav.module.css';

export const CAMPAIGN_REPORT_PLATFORMS=[
  {
    key:'overview',
    label:'التقرير العام',
    badge:'موحّد',
    description:'ملخص الإنفاق والنتائج والتسجيلات المؤكدة من كل المصادر.',
    route:'campaigns'
  },
  {
    key:'meta',
    label:'Meta',
    badge:'تفصيلي',
    description:'ربط الحساب ومراجعة أداء حملات Facebook وInstagram.',
    route:'campaigns',
    platform:'meta'
  },
  {
    key:'google',
    label:'Google Kit',
    badge:'Google Ads + GA4',
    description:'الحملات والإنفاق والتحويلات وتحليلات الموقع في مكان واحد.',
    route:'google-ads'
  },
  {
    key:'snapchat',
    label:'Snapchat',
    badge:'قريبًا',
    description:'جاهز للإضافة عند اعتماد موصل Snapchat.',
    upcoming:true
  },
  {
    key:'tiktok',
    label:'TikTok',
    badge:'قريبًا',
    description:'جاهز للإضافة عند اعتماد موصل TikTok.',
    upcoming:true
  }
];

function reportHref({slug,route,platform,from,to}){
  const query=new URLSearchParams();
  if(platform) query.set('platform',platform);
  if(from) query.set('from',from);
  if(to) query.set('to',to);
  const suffix=query.toString();
  return `/tenant/${encodeURIComponent(slug)}/reports/${route}${suffix?`?${suffix}`:''}`;
}

export default function CampaignReportPlatformNav({slug,active='overview',from='',to=''}) {
  return (
    <section className={styles.hub} aria-labelledby="campaign-report-platforms-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>مركز تقارير الحملات</p>
          <h2 id="campaign-report-platforms-title">اختر مستوى التقرير</h2>
        </div>
        <p>ابدأ بالصورة العامة، ثم افتح المنصة المطلوبة للتفاصيل والربط.</p>
      </div>
      <nav className={styles.grid} aria-label="منصات تقارير الحملات">
        {CAMPAIGN_REPORT_PLATFORMS.map(item=>{
          const content=(
            <>
              <span className={styles.cardTop}>
                <strong>{item.label}</strong>
                <small>{item.badge}</small>
              </span>
              <span className={styles.description}>{item.description}</span>
            </>
          );
          if(item.upcoming){
            return <span key={item.key} className={styles.upcoming} aria-disabled="true">{content}</span>;
          }
          return (
            <Link
              key={item.key}
              className={active===item.key?styles.active:styles.card}
              href={reportHref({...item,slug,from,to})}
              aria-current={active===item.key?'page':undefined}
            >
              {content}
            </Link>
          );
        })}
      </nav>
    </section>
  );
}
