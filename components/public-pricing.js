'use client';

import Link from 'next/link';
import {useState, useEffect, useRef} from 'react';
import {OdeirSiteHeader, OdeirSiteFooter} from './odeir-site-chrome';
import styles from './public-pricing.module.css';

const money = value => new Intl.NumberFormat('ar-SA', {maximumFractionDigits: 2}).format(value / 100);
const count = value => new Intl.NumberFormat('ar-SA').format(value);
const benefits = [
  ['عملاؤك أمامك', 'من أول استفسار إلى متابعة فرصة التسجيل.'],
  ['فريقك على بيّنة', 'مهام ومسؤوليات ومواعيد في مكان واحد.'],
  ['تشغيلك مترابط', 'المبيعات والتسجيل والبرامج في مسار واضح.'],
  ['قرارك يستند إلى بيانات', 'تقارير تساعدك على قراءة أداء منشأتك.'],
];
const groups = [
  {key: 'all', label: 'كل الإضافات'},
  {key: 'communications', label: 'التواصل', items: ['whatsapp', 'email', 'yeastar', 'templates']},
  {key: 'growth', label: 'التسويق والنمو', items: ['marketing_attribution', 'automation', 'cms_pro']},
  {key: 'training', label: 'التدريب', items: ['zoom', 'lms']},
  {key: 'commerce', label: 'المتاجر', items: ['salla', 'zid', 'shopify', 'woocommerce', 'custom_store']},
  {key: 'integrations', label: 'الربط والفوترة', items: ['zatca', 'api']},
];
const integrationLogos = {
  whatsapp: ['whatsapp-color.svg', 'WhatsApp'], zoom: ['zoom-color.svg', 'Zoom'],
  salla: ['salla-color.svg', 'سلة'], zid: ['zid-color.svg', 'زد'],
  shopify: ['shopify.svg', 'Shopify'], woocommerce: ['woocommerce-color.svg', 'WooCommerce'],
  yeastar: ['yeastar-color.svg', 'Yeastar'], marketing_attribution: ['meta-color.svg', 'Meta'],
  zatca: ['zatca-color.svg', 'زاتكا'], lms: ['lms.svg', 'التدريب'], api: ['custom-api.svg', 'API'],
};
const railKeys = ['whatsapp','meta','zoom','salla','zid','shopify','woocommerce','yeastar'];
function IntegrationLogo({addonKey}) {
  const logo = integrationLogos[addonKey === 'meta' ? 'marketing_attribution' : addonKey];
  return logo ? <img src={`/integrations/${logo[0]}`} alt={logo[1]} width="72" height="40" loading="lazy" decoding="async"/> : <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="4" width="6" height="6" rx="2"/><rect x="14" y="4" width="6" height="6" rx="2"/><rect x="4" y="14" width="6" height="6" rx="2"/><path d="M17 14v6m-3-3h6"/></svg>;
}
const faqs = [
  ['ما الفرق بين الباقات؟', 'تختلف باقات أودير الحالية في عدد مستخدمي الفريق، وتتوفر فيها وظائف التشغيل الأساسية نفسها. اختر السعة التي تحتاجها اليوم؛ الإضافات لها اشتراكات مستقلة.'],
  ['هل أحتاج إلى شراء الإضافات من البداية؟', 'ابدأ بوظائف النظام الأساسية، ثم اختر الإضافة التي تخدم احتياجًا محددًا لديك. سعر الإضافة ومزاياها المتاحة لا يتغيران باختلاف باقة أودير، والقوالب المتقدمة مجانية للجميع.'],
  ['ماذا يشمل السعر؟', 'الأسعار بالريال السعودي قبل الضريبة. الاشتراك السنوي يغطي 12 شهرًا ويُدفع مقدمًا. رسوم مزودي الرسائل والمكالمات والتراخيص الخارجية والخدمات البشرية منفصلة عن اشتراك أودير والإضافات.'],
  ['كيف أعرف متطلبات الإضافة؟', 'راجع تفاصيل الإضافة داخل متجر منشأتك قبل الاشتراك. قد يتطلب الربط حسابًا أو ترخيصًا لدى المزود؛ ويمكنك التواصل مع الدعم الفني داخل منشأتك للاستفسار عن متطلبات التشغيل.'],
  ['ماذا عن العملاء والملفات والاشتراكات الحالية؟', 'لا تفرض الباقات الحالية حصة تجارية على عدد العملاء والدفعات. تخضع الملفات لضوابط الاستضافة التقنية. وتظل العقود السابقة ومددها المدفوعة محفوظة؛ تغيير باقة البرنامج لا يغيّر اشتراك الإضافة أو مزاياها.'],
];

function Check() {
  return <svg className={styles.check} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m6 12 4 4 8-8" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function LineIcon({name = 'forward'}) {
  const paths = {
    forward: <><path d="M19 12H5"/><path d="m11 6-6 6 6 6"/></>,
    down: <><path d="M12 4v16"/><path d="m6 14 6 6 6-6"/></>,
    up: <><path d="M12 20V4"/><path d="m6 10 6-6 6 6"/></>,
    compare: <><path d="M4 8h16"/><path d="m16 4 4 4-4 4"/><path d="M20 16H4"/><path d="m8 12-4 4 4 4"/></>,
    plus: <><path d="M12 5v14"/><path d="M5 12h14"/></>,
    minus: <path d="M5 12h14"/>,
  };
  return <svg className={styles.lineIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths[name]}</svg>;
}

function CompassIcon() {
  return <svg className={styles.compassIcon} viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="m14.8 9.2-1.7 3.9-3.9 1.7 1.7-3.9 3.9-1.7Z"/><circle cx="12" cy="12" r="1"/></svg>;
}

export default function PublicPricing({catalog}) {
  const pageRef = useRef(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.animate?.([{opacity:.35,transform:'translateY(16px)'},{opacity:1,transform:'translateY(0)'}],{duration:550,easing:'cubic-bezier(.2,.7,.2,1)'});
      observer.unobserve(entry.target);
    }),{threshold:.08});
    pageRef.current?.querySelectorAll('[data-pricing-reveal]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);
  const [cycle, setCycle] = useState('month');
  const [teamSize, setTeamSize] = useState('3');
  const [category, setCategory] = useState('all');
  const amount = item => cycle === 'month' ? item.monthlyAmountMinor : item.annualAmountMinor;
  const staff = Number(teamSize);
  const validStaff = teamSize !== '' && Number.isSafeInteger(staff) && staff > 0;
  const suggested = validStaff ? [...catalog.plans]
    .filter(plan => Number(plan.profile?.limits?.staff) >= staff)
    .sort((a, b) => amount(a) - amount(b) || Number(a.profile?.limits?.staff) - Number(b.profile?.limits?.staff))[0] : null;
  const selectedGroup = groups.find(group => group.key === category);
  const visibleAddons = category === 'all' ? catalog.addons : catalog.addons.filter(addon => selectedGroup?.items?.includes(addon.key));
  const listedAddons = category === 'all' && !showAll ? visibleAddons.slice(0,6) : visibleAddons;
  const availableGroups = groups.filter(group => group.key === 'all' || catalog.addons.some(addon => group.items.includes(addon.key)));

  return <div className="odeir-experience pricing-landing">
    <div className="odeir-managed-header-shell"><OdeirSiteHeader/></div>
    <main ref={pageRef} className={styles.page} data-commerce-release={catalog.releaseKey || 'independent-v1'}>
      <section className={styles.hero} aria-labelledby="pricing-title">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <span className={styles.eyebrow}>باقات وإضافات أودير</span>
            <h1 id="pricing-title"><span>اختر ما يخدم منشأتك اليوم.</span><em>وابنِ ما تطمح إليه غدًا.</em></h1>
            <p>شريكك في رحلة التشغيل والنمو. نجمع أعمال منشأتك في منظومة واحدة، لتمنح فريقك وضوحًا أكبر، وتتخذ قرارك على بيّنة.</p>
            <div className={styles.heroActions}>
              <a className={styles.primaryCta} href="#core-editions">اكتشف الباقات <LineIcon name="down"/></a>
              <a className={styles.textCta} href="#addons">استكشف الإضافات <LineIcon name="down"/></a>
            </div>
            <div className={styles.heroTrust}><span><Check/>بداية مجانية</span><span><Check/>إضافات حسب احتياجك</span><span><Check/>أسعار واضحة</span></div>
          </div>
          <aside className={styles.advisor} aria-labelledby="advisor-title">
            <div className={styles.advisorTop}><span>اختيار على مقاس منشأتك</span><span className={styles.advisorMark} aria-hidden="true"><CompassIcon/></span></div>
            <h2 id="advisor-title">احتياجك أولًا.<br/> والباقة المناسبة بعده.</h2>
            <p>وظائف التشغيل الأساسية في جميع الباقات. ابدأ بحجم فريقك.</p>
            <label htmlFor="pricing-team-size">كم عدد المستخدمين، بما فيهم المالك؟</label>
            <div className={styles.teamInput}><input id="pricing-team-size" type="number" min="1" step="1" inputMode="numeric" value={teamSize} onChange={event => setTeamSize(event.target.value)} aria-describedby="advisor-result"/><span>مستخدمين</span></div>
            <div id="advisor-result" className={styles.advisorResult} aria-live="polite" aria-atomic="true">
              {!validStaff ? <p>أدخل عددًا صحيحًا يبدأ من مستخدم واحد.</p> : suggested ? <>
                <span>أقل باقة سعرًا تستوعب فريقك</span>
                <div><strong>{suggested.name}</strong><b>{amount(suggested) === 0 ? 'مجانية' : `${money(amount(suggested))} ريال`}<small>{amount(suggested) > 0 ? (cycle === 'month' ? ' / شهر' : ' / سنة') : ''}</small></b></div>
                <a href={`#plan-${suggested.key}`}>شاهد تفاصيل الباقة <LineIcon/></a>
              </> : <p>عدد فريقك أكبر من السعات المعروضة حاليًا. <Link href="/login">ادخل إلى منشأتك للتواصل مع الدعم الفني.</Link></p>}
            </div>
          </aside>
        </div>
        <div className={styles.heroFoot}><span>منظومة واحدة. رؤية أوضح.</span><span>من أول استفسار إلى التسجيل وقراءة الأداء</span></div>
      </section>

      <section className={styles.integrationBand} aria-label="أمثلة تكاملات أودير"><div className={styles.integrationIntro}><span>أدوات تعرفها.</span><strong>وتشغيل أكثر ترابطًا.</strong></div><div className={styles.logoRail}>{railKeys.map((key,index)=><div className={styles.logoTile} key={key} style={{'--logo-delay':`${index*65}ms`}}><IntegrationLogo addonKey={key}/></div>)}</div><p>التكاملات حسب الإضافة ومتطلبات مزودها.</p></section>
      <section data-pricing-reveal className={styles.benefits} aria-label="مميزات التشغيل الأساسية">
        {benefits.map(([title, description]) => <div key={title}><Check/><div><h2>{title}</h2><p>{description}</p></div></div>)}
      </section>

      <section data-pricing-reveal className={styles.plansSection} id="core-editions" aria-labelledby="core-editions-title">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>أساس قوي لكل مرحلة</span><h2 id="core-editions-title">طموحك يكبر. وأودير معك.</h2><p>اختر سعة فريقك. وظائف التشغيل الأساسية متاحة في كل باقة.</p></div>
          <div className={styles.billing}><div className={styles.cycle} role="group" aria-label="عرض الأسعار حسب مدة الاشتراك"><button type="button" aria-pressed={cycle === 'month'} onClick={() => setCycle('month')}>شهري</button><button type="button" aria-pressed={cycle === 'year'} onClick={() => setCycle('year')}>سنوي</button></div><span>اختر المدة الأنسب لمنشأتك</span></div>
        </div>
        <p className={styles.priceNote}>الأسعار بالريال السعودي قبل الضريبة. {cycle === 'year' ? 'السعر السنوي مقابل 12 شهرًا، مدفوعًا مقدمًا.' : 'السعر المعروض لاشتراك شهري.'}</p>
        <p className={styles.swipeHint}>اسحب البطاقات للمقارنة <LineIcon name="compare"/></p><div className={styles.plans} tabIndex="0" aria-label="بطاقات الباقات، اسحب أفقيًا على الجوال للمقارنة">{catalog.plans.map(plan => {
          const recommended = suggested?.key === plan.key;
          const free = amount(plan) === 0;
          const saving = plan.monthlyAmountMinor * 12 - plan.annualAmountMinor;
          return <article className={`${styles.plan} ${recommended ? styles.recommended : ''}`} id={`plan-${plan.key}`} key={plan.key}>
            <div className={styles.planLabel}>{recommended ? <span className={styles.badge}><Check/>تناسب فريقك</span> : <span className={styles.planEyebrow}>{free ? 'ابدأ بخطوة واثقة' : 'مساحة أكبر لفريقك'}</span>}</div>
            <h3>{plan.name}</h3><p className={styles.planDescription}>{plan.profile?.description || plan.description}</p>
            <div className={styles.price}><b>{free ? 'مجانية' : money(amount(plan))}</b>{!free && <span>ريال / {cycle === 'month' ? 'شهر' : 'سنة'}</span>}</div>
            <p className={styles.saving}>{cycle === 'year' && !free && saving > 0 ? `وفّر ${money(saving)} ريال مقارنة بـ12 اشتراكًا شهريًا` : free ? 'بداية عملية لتنظيم منشأتك' : cycle === 'year' ? 'اشتراك لمدة 12 شهرًا، مدفوع مقدمًا' : 'سعة واضحة، باشتراك شهري'}</p>
            <Link className={styles.planCta} href={free ? '/free-trial/apply' : '/login'}>{free ? 'ابدأ مجانًا' : 'دخول المنشأة للاشتراك'}<LineIcon/></Link>
            <ul className={styles.planFeatures}>
              <li><Check/><span>حتى <strong>{count(plan.profile?.limits?.staff)}</strong> مستخدمين، شامل المالك</span></li>
              <li><Check/><span>العملاء والمبيعات والمتابعة</span></li>
              <li><Check/><span>التسجيل والبرامج والمهام</span></li>
              <li><Check/><span>الفوترة وتقارير التشغيل</span></li>
            </ul>
            <div className={styles.planFooter}>الإضافات باشتراك مستقل</div>
          </article>;
        })}</div>
        <div className={styles.planPrinciple}><Check/><p><strong>اختيارك يبدأ من احتياجك.</strong> الباقة الأكبر توسّع سعة الفريق، والإضافات تختارها بصورة مستقلة.</p><a href="#pricing-faq">تفاصيل الاشتراك <LineIcon name="down"/></a></div>
      </section>

      <section className={styles.addonsSection} id="addons" aria-labelledby="addons-title">
        <div className={styles.addonsInner}>
          <div className={styles.sectionHeading}><div><span className={styles.kicker}>ابنِ منظومتك بطريقتك</span><h2 id="addons-title">إمكانات إضافية.<br/> حين يصنع وجودها فرقًا.</h2><p>اختر ما يخدم عملك. لكل إضافة سعر مستقل ومزاياها المتاحة نفسها في جميع الباقات.</p></div><a className={styles.outlineCta} href="/login">متجر إضافات منشأتك <LineIcon/></a></div>
          <div className={styles.filters} role="group" aria-label="تصنيف الإضافات">{availableGroups.map(group => <button type="button" key={group.key} aria-pressed={category === group.key} onClick={() => setCategory(group.key)}>{group.label}</button>)}</div>
          <div className={styles.addonBar}><span role="status">{count(visibleAddons.length)} إضافات {category === 'all' ? 'لخدمة منشأتك' : `في ${selectedGroup.label}`}</span><span>الأسعار {cycle === 'month' ? 'شهرية' : 'سنوية مقابل 12 شهرًا'} · قبل الضريبة <a href="#core-editions">تغيير المدة <LineIcon name="up"/></a></span></div>
          <div className={styles.addons} key={category}>{listedAddons.map(addon => {
            const group = groups.find(item => item.items?.includes(addon.key));
            return <article data-pricing-reveal key={addon.key}>
              <div className={styles.addonTop}><div className={styles.addonLogo}><IntegrationLogo addonKey={addon.key}/></div><span>{group?.label || 'إضافات أودير'}</span>{amount(addon) === 0 ? <b>مجانية للجميع</b> : <span className={styles.addonArrow} aria-hidden="true"><LineIcon name="plus"/></span>}</div>
              <h3>{addon.name}</h3><p>{addon.description}</p>
              <div className={styles.addonPrice}><b>{amount(addon) === 0 ? 'مجانية' : <>{money(amount(addon))}<small>ريال / {cycle === 'month' ? 'شهر' : 'سنة'}</small></>}</b><span>اشتراك مستقل</span></div>
            </article>;
          })}</div>
          {category === 'all' && visibleAddons.length > 6 && <button className={styles.showMore} type="button" onClick={() => setShowAll(value => !value)} aria-expanded={showAll}>{showAll ? 'عرض مختصر' : `استكشف جميع الإضافات (${count(visibleAddons.length)})`}<span aria-hidden="true"><LineIcon name={showAll ? 'minus' : 'plus'}/></span></button>}
          <p className={styles.addonNote}>راجع تفاصيل الإضافة ومتطلبات ربطها قبل الاشتراك. رسوم المزود والتراخيص الخارجية منفصلة.</p>
        </div>
      </section>

      <section data-pricing-reveal className={styles.faqSection} id="pricing-faq" aria-labelledby="pricing-faq-title"><div><span className={styles.kicker}>وضوح قبل القرار</span><h2 id="pricing-faq-title">أسئلة في مكانها.</h2><p>التفاصيل التي تساعدك على اختيار مناسب لمنشأتك.</p><Link href="/p/information-security" className={styles.securityLink}>تعرّف على حماية بيانات منشأتك <LineIcon/></Link></div><div className={styles.faqList}>{faqs.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>

      <section data-pricing-reveal className={styles.closing} aria-labelledby="pricing-closing-title"><span className={styles.eyebrow}>مستشارك في التشغيل. وشريك في النمو.</span><h2 id="pricing-closing-title">منشأتك تستحق رؤية أوضح.<br/><em>ابدأ من هنا.</em></h2><p>نظّم عمل اليوم، وامنح طموح الغد أساسًا أقوى.</p><Link className={styles.primaryCta} href="/free-trial/apply">سجّل منشأتك مجانًا <LineIcon/></Link><span className={styles.closingNote}>ابدأ بالأساس، وأضف ما تحتاجه في وقته.</span></section>
    </main>
    <OdeirSiteFooter/>
  </div>;
}
