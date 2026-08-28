'use client';

import FreeTrialLanding from './free-trial-landing';
import OdeirBrand from './odeir-brand';

export default function LifetimeFreeApplication({embedded=false}){
  return <main className={embedded?'lifetime-free-application lifetime-free-application--embedded':'lifetime-free-application'} dir="rtl">
    {!embedded&&<header className="lifetime-header">
      <a href="/" className="lifetime-brand" aria-label="أودير - الرئيسية">
        <OdeirBrand subtitle="منصة إدارة المنشآت"/>
      </a>
      <nav>
        <a href="/">عن أودير</a>
        <a href="/free-trial">التسجيل المجاني</a>
        <a href="/login">دخول المنشآت</a>
      </nav>
    </header>}

    <section className="lifetime-apply-hero">
      {!embedded&&<div className="lifetime-copy">
        <span className="lifetime-pill">ابدأ مع أودير مجانًا</span>
        <h1>ابدأ مجانًا.<br/><em>ثم توسّع حسب احتياج منشأتك.</em></h1>
        <p>فعّل الخطة المجانية الحالية لإدارة العملاء والمهام والتسجيل والدورات والتقارير دون بطاقة بنكية. تخضع الخصائص والسعات والحدود للسياسة المعلنة، ويمكنك إضافة الخدمات والتكاملات المدفوعة عندما تحتاج إليها.</p>
        <div className="lifetime-benefits">
          <span><b>0</b><small>بدون بطاقة بنكية للبدء</small></span>
          <span><b>↗</b><small>توسّع مرن عند الحاجة</small></span>
          <span><b>✓</b><small>حدود الخطة موضحة ومعلنة</small></span>
        </div>
        <div className="lifetime-note">
          <strong>ما الذي تشملُه الخطة المجانية؟</strong>
          <p>الحساب الأساسي والوحدات والحدود المنشورة في سياسة البرنامج وقت الاستخدام. يجوز تعديل عدد المستخدمين أو المساحة أو السجلات أو الأتمتة أو التكاملات أو عمق التقارير والدعم، مع إشعار مناسب عند التغيير الجوهري كلما كان ذلك ممكنًا.</p>
        </div>
      </div>}

      <div className="lifetime-form-shell">
        <FreeTrialLanding registrationOnly={embedded}/>
      </div>
    </section>

    {!embedded&&<footer className="lifetime-footer">
      <span>© 2026 أودير</span>
      <a href="/">العودة إلى أودير</a>
    </footer>}

    <style jsx global>{`
      .lifetime-free-application{min-height:100vh;background:radial-gradient(circle at 12% 18%,rgba(19,199,209,.15),transparent 28%),radial-gradient(circle at 88% 4%,rgba(240,197,52,.12),transparent 24%),linear-gradient(145deg,#031326 0%,#06182e 52%,#020b16 100%);color:#fff;font-family:inherit}
      .lifetime-header{position:relative;z-index:4;max-width:1240px;margin:auto;padding:24px 28px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,.09)}
      .lifetime-brand{display:inline-flex}.lifetime-header nav{display:flex;gap:24px;align-items:center}.lifetime-header nav a{color:#c8d6e4;text-decoration:none;font-size:13px;font-weight:750}.lifetime-header nav a:last-child{border:1px solid rgba(255,255,255,.18);padding:10px 16px;border-radius:10px;color:#fff}
      .lifetime-apply-hero{max-width:1240px;margin:auto;padding:72px 28px 94px;display:grid;grid-template-columns:minmax(0,.9fr) minmax(480px,1.1fr);gap:56px;align-items:start}
      .lifetime-copy{padding-top:42px}.lifetime-pill{display:inline-flex;padding:8px 13px;border:1px solid rgba(19,199,209,.38);background:rgba(19,199,209,.10);color:#7eeaf0;border-radius:999px;font-size:11px;font-weight:900}.lifetime-copy h1{font-size:clamp(46px,6vw,78px);line-height:1.06;letter-spacing:-.045em;margin:24px 0 20px}.lifetime-copy h1 em{font-style:normal;color:#f0c534}.lifetime-copy>p{color:#aebfd0;font-size:17px;line-height:1.95;max-width:650px}
      .lifetime-benefits{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:28px 0}.lifetime-benefits span{padding:17px;border-radius:15px;background:rgba(255,255,255,.055);border:1px solid rgba(255,255,255,.09);display:grid;gap:5px}.lifetime-benefits b{font-size:25px;color:#13c7d1}.lifetime-benefits small{color:#c3d0dc;font-size:10px;line-height:1.5}
      .lifetime-note{border-right:3px solid #f0c534;background:rgba(240,197,52,.075);padding:17px 19px;border-radius:14px}.lifetime-note strong{color:#fff;font-size:13px}.lifetime-note p{margin:7px 0 0;color:#b9c7d3;font-size:11px;line-height:1.8}
      .lifetime-form-shell{min-width:0}.lifetime-form-shell>.free-trial-route{min-height:auto!important;background:transparent!important}.lifetime-form-shell .site-header,.lifetime-form-shell .hero-copy,.lifetime-form-shell .fit-strip,.lifetime-form-shell .platform-section,.lifetime-form-shell .product-section,.lifetime-form-shell .journey-section,.lifetime-form-shell .modules-section,.lifetime-form-shell .guide-section,.lifetime-form-shell .saudi-section,.lifetime-form-shell .faq-section,.lifetime-form-shell .closing-cta,.lifetime-form-shell .site-footer{display:none!important}.lifetime-form-shell .hero{display:block!important;min-height:0!important;padding:0!important;background:transparent!important}.lifetime-form-shell .trial-card{width:100%!important;max-width:none!important;margin:0!important;box-shadow:0 42px 110px rgba(0,0,0,.38)!important;border:1px solid rgba(255,255,255,.12)!important}.lifetime-form-shell .trial-card:before{content:'تسجيل منشأتك في أودير';display:block;padding:15px 20px;background:linear-gradient(90deg,#08b8b1,#13c7d1);color:#06182e;font-size:12px;font-weight:900;text-align:center}.lifetime-form-shell .trial-body{max-height:none!important}.lifetime-form-shell .card-subtitle:after{content:' — وفق حدود الخطة المجانية الحالية.';color:#087f7a;font-weight:800}.lifetime-form-shell .contact-form .card-heading h2{font-size:0}.lifetime-form-shell .contact-form .card-heading h2:after{content:'جهّز حساب منشأتك';font-size:22px}.lifetime-form-shell .consent-row a{color:#087f7a;text-decoration:underline;font-weight:900}.lifetime-form-shell .success-state h2{font-size:28px}.lifetime-form-shell .success-state>p{font-size:14px}
      .lifetime-footer{max-width:1240px;margin:auto;padding:22px 28px;border-top:1px solid rgba(255,255,255,.09);display:flex;justify-content:space-between;color:#71869a;font-size:11px}.lifetime-footer a{color:#13c7d1;text-decoration:none}
      .lifetime-free-application--embedded{min-height:0;background:#f5f9fb;color:#112c42}.lifetime-free-application--embedded .lifetime-apply-hero{display:block;max-width:none;margin:0;padding:0}.lifetime-free-application--embedded .lifetime-form-shell .trial-card{border:0!important;border-radius:0!important;box-shadow:none!important}.lifetime-free-application--embedded .lifetime-form-shell .trial-card:before{display:none!important}
      @media(max-width:980px){.lifetime-apply-hero{grid-template-columns:1fr;padding-top:42px}.lifetime-copy{padding-top:0}.lifetime-benefits{grid-template-columns:1fr 1fr 1fr}.lifetime-header nav a:first-child{display:none}}
      @media(max-width:650px){.lifetime-header{padding:18px}.lifetime-header nav{gap:10px}.lifetime-header nav a{font-size:10px}.lifetime-apply-hero{padding:38px 16px 70px;gap:32px}.lifetime-copy h1{font-size:44px}.lifetime-copy>p{font-size:14px}.lifetime-benefits{grid-template-columns:1fr}.lifetime-footer{padding:18px 16px}}
    `}</style>
  </main>;
}
