import ExpertApplication from '../../../components/expert-application';
import {OdeirSiteHeader,OdeirSiteFooter} from '../../../components/odeir-site-chrome';
import {getCmsPublicSnapshot} from '../../../lib/cms-public';
import {serviceRpc} from '../../../lib/service-hub-http';
import s from '../../../components/service-hub.module.css';

export const dynamic='force-dynamic';
export const metadata={title:'انضم إلى الخبراء والمحاضرين | أودير',description:'شارك خبرتك مع منشآت أودير. قدّم طلب الانضمام كمحاضر أو مدرب أو مستشار.',alternates:{canonical:'/experts/join'}};

export default async function ExpertJoinPage(){
  const [cms,registration]=await Promise.all([getCmsPublicSnapshot({siteKey:'marktone-main'}).catch(()=>null),serviceRpc('v1_public_expert_registration_status',{},{publicAccess:true}).catch(()=>({enabled:false}))]);
  return <div className={`odeir-experience ${s.hub} ${s.public}`}><div className={s.publicHeader}><OdeirSiteHeader menu={cms?.menu} settings={cms?.site?.settings}/></div>
    <main className={s.publicMain}><section className={s.intro}><span className={s.badge}>شبكة خبراء أودير</span><h1>خبرتك تصل إلى المنشأة التي تحتاجها</h1><p>انضم إلى الخبراء والمحاضرين، وقدّم برامجك وخدماتك للمنشآت من خلال متجر أودير.</p><ol><li><b>عرّفنا بخبرتك</b>تخصصاتك، البرامج التي تقدمها، ووسيلة التواصل.</li><li><b>نراجع طلبك معك</b>يتحقق الفريق من ملاءمة البيانات والخدمات.</li><li><b>ملف مهني داخل المتجر</b>بعد الاعتماد والنشر، تستطيع المنشآت طلب خبرتك حتى قبل إضافة باقة جاهزة.</li></ol></section><ExpertApplication available={registration.enabled}/></main>
    <OdeirSiteFooter footerMenu={cms?.footerMenu} settings={cms?.site?.settings}/></div>;
}
