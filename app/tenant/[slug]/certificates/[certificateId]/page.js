import {getTenantCertificate} from '../../../../../lib/api';
import {requireTenantAddon} from '../../../../../lib/server-auth';
import PrintCertificateButton from '../../../../../components/print-certificate-button';

export const dynamic='force-dynamic';

const date=value=>value?new Date(value).toLocaleDateString('ar-SA',{
  day:'numeric',
  month:'long',
  year:'numeric'
}):'—';

export default async function CertificatePage({params}){
  const {slug,certificateId}=await params;
  await requireTenantAddon(slug,'lms',{
    permission:'tenant.training.read'
  });
  const certificate=await getTenantCertificate(slug,certificateId);

  return <main className="mt-certificate-page" dir="rtl">
    <div className="mt-certificate-print-actions">
      <a href={`/tenant/${encodeURIComponent(slug)}/lms`}>
        العودة إلى تشغيل المتدربين
      </a>
      <PrintCertificateButton/>
    </div>
    <article className={`mt-certificate-sheet ${certificate.status}`}>
      <div className="mt-certificate-frame">
        <header>
          <div className="mt-certificate-mark">M</div>
          <div>
            <small>{certificate.tenant.name}</small>
            <h1>شهادة إتمام برنامج تدريبي</h1>
          </div>
          <span>{certificate.status==='issued'?'سارية':'ملغاة'}</span>
        </header>

        <section className="mt-certificate-copy">
          <p>تشهد <b>{certificate.tenant.name}</b> بأن المتدرب/ة</p>
          <h2>{certificate.student.fullName}</h2>
          <p>قد أتم/ت بنجاح البرنامج التدريبي</p>
          <h3>{certificate.course.name}</h3>
          <p>
            ضمن {certificate.courseRun.title}
            {certificate.course.durationHours
              ?` بواقع ${certificate.course.durationHours} ساعة تدريبية`
              :''}
          </p>
        </section>

        <section className="mt-certificate-details">
          <div><span>تاريخ الإصدار</span><b>{date(certificate.issuedAt)}</b></div>
          <div><span>رقم الشهادة</span><b dir="ltr">{certificate.certificateNumber}</b></div>
          <div><span>كود التحقق</span><b dir="ltr">{certificate.verificationCode}</b></div>
        </section>

        <footer>
          <div>
            <span>المدرب</span>
            <b>{certificate.courseRun.instructorName||'إدارة التدريب'}</b>
          </div>
          <div className="mt-certificate-seal">
            <span>MARKTONE</span>
            <b>VERIFIED</b>
          </div>
          <div>
            <span>اعتماد المنشأة</span>
            <b>{certificate.tenant.name}</b>
          </div>
        </footer>
      </div>
    </article>
  </main>;
}
