import Link from 'next/link';
import {requirePlatformPermission} from '../../../../lib/server-auth';
import {zoomGateway} from '../../../../lib/zoom-server';
import {ZOOM_SETUP_CHECKS} from '../../../../lib/zoom-setup.mjs';
import styles from '../../../../components/zoom-workspace.module.css';
export const dynamic='force-dynamic';
export const metadata={title:'تجهيز Zoom | إدارة أودير',robots:{index:false,follow:false}};

export default async function ZoomPlatformSetup(){
 await requirePlatformPermission('platform.billing.manage');
 let status=null;try{status=await zoomGateway('platform_setup',{});}catch{/* Keep a reviewable setup page if the gateway is unavailable. */}
 return <main className={styles.workspace} dir="rtl"><header className={styles.header}><div><h1>تجهيز ربط Zoom</h1><p>إعداد عام يديره مسؤول أودير، ثم يربط مسؤول كل منشأة حسابه بصورة مستقلة.</p></div><Link href="/control/addons">العودة لإدارة الإضافات</Link></header>
  <section className={styles.card}><h2>{status?.runtime?.canSchedule?'إعدادات التشغيل متوفرة':'متطلبات التجهيز'}</h2><p>هذه قراءة للإعدادات والجدولة. لا تثبت وحدها نجاح التفويض أو وصول إشعارات Zoom أو جودة محاضرة حية.</p>{!status&&<p role="alert">تعذر التحقق من الخدمة. راجع نشر خدمة Zoom وصلاحية حساب الإدارة ثم حدّث الصفحة.</p>}
   <ul className={styles.checks}>{ZOOM_SETUP_CHECKS.map(([key,label,setting])=><li key={key}><b>{label}</b><p>{!status?'لم يُتحقق':status.runtime?.checks?.[key]?'متوفر':'يحتاج إعدادًا'}</p><code>{setting}</code></li>)}</ul>
  </section>
  <section className={styles.card}><h2>خطوات مسؤول أودير</h2><ol><li>جهّز تطبيق General OAuth لإدارة حسابات المنشآت، واضبط صلاحياته والأحداث وفق دليل الربط.</li><li>احفظ بيانات التطبيق والتحقق في إعدادات الخدمة الخادمية. لا تضع الأسرار في الواجهة أو رسائل الدعم.</li><li>اضبط عناوين الإنتاج أدناه، ثم تحقق من إشعارات Zoom وشغّل العامل وفق خطة الإطلاق المعتمدة.</li><li>بعد الإذن بالتفعيل، افتح التشغيل العام وتحقق من هذه الصفحة. مسؤول المنشأة يكمل الربط من شاشة حسابات Zoom.</li></ol>
   <p>عنوان العودة في إنتاج أودير:</p><code>https://odeir.com/api/zoom/callback</code><p>عنوان إشعارات الإنتاج:</p><code>https://gswpbwdactcstkasddta.supabase.co/functions/v1/zoom-connect/webhook</code>
   <p><a href="https://supabase.com/dashboard/project/gswpbwdactcstkasddta/functions" target="_blank" rel="noreferrer">فتح إعدادات الخدمات الخادمية</a></p>
   <p><a href="https://github.com/Marktonesa/marktone-platform-control/blob/main/docs/zoom/runbook.md" target="_blank" rel="noreferrer">دليل إعداد التطبيق والصلاحيات والتشغيل</a></p>
  </section>
  <section className={styles.card}><h2>القبول الفعلي قبل تعميم الاستخدام</h2><p>اختبر بحساب مصرح به: الربط، مزامنة المضيف، إنشاء محاضرة اصطناعية، دخول المدرب والمتدرب، عودة الحضور، ثم إتاحة تسجيل معتمد إن كان مرخصًا. قبول Meeting SDK والندوات والتسجيل السحابي متطلبات منفصلة حسب الاستخدام.</p></section>
 </main>;
}
