import Link from 'next/link';
import OdeirBrand from '../../components/odeir-brand';

export const metadata={
  title:'تأكيد التسجيل | أودير',
  robots:{index:false,follow:false}
};

const COPY={
  ready:{
    title:'باقي ضغطة واحدة لتفعيل مساحتك',
    description:'بتأكيدك الآن ننشئ مساحة مستقلة تعمل مباشرة وفق الباقة المحددة، وتبقى موثوقية المنشأة قيد المراجعة.',
    action:true
  },
  manual_review:{
    title:'تم تأكيد البريد والطلب تحت المراجعة',
    description:'حفاظًا على أمان الحساب، يحتاج هذا الطلب مراجعة بشرية قبل إنشاء المساحة. سيتواصل معك فريق أودير.'
  },
  invalid:{
    title:'رابط التأكيد غير صالح أو انتهت صلاحيته',
    description:'ارجع إلى تسجيل المنشأة وأرسل الطلب مرة أخرى للحصول على رابط جديد.'
  },
  unavailable:{
    title:'تعذر إكمال التفعيل الآن',
    description:'بيانات طلبك محفوظة بأمان. حاول فتح الرابط بعد قليل، أو تواصل مع فريق أودير.'
  }
};

export default async function RegistrationConfirmationPage({searchParams}){
  const params=await searchParams;
  const copy=COPY[params?.state]||COPY.invalid;
  return <main className="registration-confirmation" dir="rtl">
    <section>
      <OdeirBrand subtitle="منصة إدارة المنشآت"/>
      <span aria-hidden="true">{params?.state==='ready'?'✓':'!'}</span>
      <h1>{copy.title}</h1>
      <p>{copy.description}</p>
      {copy.action?<form action="/api/public/registration/confirm" method="post">
        <button type="submit">تأكيد البريد وتفعيل المساحة</button>
        <small>لن يتم إنشاء أي مساحة قبل ضغط الزر بنفسك.</small>
      </form>:<div>
          <Link href="/free-trial/apply">العودة إلى التسجيل</Link>
          <Link href="/login">تسجيل الدخول</Link>
        </div>}
    </section>
    <style>{`
      .registration-confirmation{min-height:100dvh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 20% 15%,rgba(18,198,190,.18),transparent 30%),linear-gradient(145deg,#041729,#082c47);font-family:Tahoma,"Segoe UI",Arial,sans-serif}
      .registration-confirmation>section{width:min(540px,100%);padding:34px;border:1px solid rgba(255,255,255,.14);border-radius:24px;background:#fff;box-shadow:0 30px 90px rgba(0,0,0,.28);text-align:center}
      .registration-confirmation>section>span{width:58px;height:58px;display:grid;place-items:center;margin:26px auto 14px;border-radius:18px;background:#e9f8f6;color:#08857f;font-size:28px;font-weight:900}
      .registration-confirmation h1{margin:0;color:#082c47;font-size:27px;line-height:1.55}
      .registration-confirmation p{margin:12px auto 24px;color:#607787;font-size:14px;line-height:1.9}
      .registration-confirmation section>div{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      .registration-confirmation a{min-height:46px;display:grid;place-items:center;border:1px solid #cfe0e8;border-radius:12px;color:#0b5f79;text-decoration:none;font-size:12px;font-weight:900}
      .registration-confirmation a:first-child{border-color:#082c47;background:#082c47;color:#fff}
      .registration-confirmation form{display:grid;gap:9px}.registration-confirmation form button{min-height:50px;border:0;border-radius:13px;background:#082f4d;color:#fff;font-size:13px;font-weight:900;cursor:pointer}.registration-confirmation form small{color:#7d909d;font-size:9px}
      @media(max-width:520px){.registration-confirmation>section{padding:26px 18px}.registration-confirmation h1{font-size:22px}.registration-confirmation section>div{grid-template-columns:1fr}}
    `}</style>
  </main>;
}
