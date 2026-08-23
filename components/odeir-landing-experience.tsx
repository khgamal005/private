"use client";

import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import OdeirRegistrationModal from "./odeir-registration-modal";

const APP_ORIGIN = "";

type CmsItem = { title?: string; description?: string };
type CmsSection = {
  eyebrow?: string;
  title?: string;
  body?: string;
  items?: CmsItem[];
};
type LandingArticle = {
  slug?: string;
  title?: string;
  excerpt?: string;
  category?: string;
  coverUrl?: string;
  featured?: boolean;
  readingMinutes?: number | null;
  publishedAt?: string | null;
};
type LandingCms = {
  hero?: {
    eyebrow?: string;
    title?: string;
    body?: string;
    primaryLabel?: string;
    primaryHref?: string;
    secondaryLabel?: string;
    secondaryHref?: string;
  };
  capabilities?: CmsSection;
  trust?: CmsSection;
  faq?: CmsSection;
  cta?: {
    eyebrow?: string;
    title?: string;
    body?: string;
    buttonLabel?: string;
    buttonHref?: string;
  };
  settings?: {
    customerLoginLabel?: string;
    customerLoginUrl?: string;
  };
  articles?: LandingArticle[];
};

const LEGACY_HERO = {
  eyebrow: "منصة تشغيل وإدارة للمنشآت التعليمية والتدريبية",
  title: "كل منشأتك في مكان واحد. واضحة، مترابطة، وتحت السيطرة.",
  body: "أودير يوحّد العملاء والمبيعات، التسجيل والدورات، المهام، الفوترة، الفريق والتقارير في مسار واحد. ابدأ مجانًا دون بطاقة بنكية.",
  secondaryLabel: "تسجيل دخول المنشآت",
  secondaryHref: "/login",
};

const LEGACY_CAPABILITIES = [
  ["العملاء والمبيعات", "من مصدر العميل والتوزيع إلى المتابعة والتحويل والتسجيل."],
  ["المهام والتقويم", "أولويات واضحة، مواعيد، تنبيهات وتسليم موثق بين أعضاء الفريق."],
  ["التسجيل والقبول", "ملف منظم للمتدرب وربط مباشر بالبرنامج والدفعة المطلوبة."],
  ["البرامج والدورات", "إدارة البرامج والأسعار والدفعات والجداول من مصدر واحد."],
] as const;

const LEGACY_TRUST = [
  ["عزل بيانات كل منشأة", "سياق مستقل يمنع ظهور بيانات منشأة داخل مساحة منشأة أخرى."],
  ["صلاحيات حسب الدور", "كل مستخدم يصل إلى ما يحتاجه لأداء عمله فقط."],
  ["سجل واضح للأنشطة", "تتبع للإجراءات الحساسة لدعم المراجعة والمساءلة."],
  ["ضوابط ومراجعة", "طبقات حماية وإدارة وصول وتحديثات تُراجع مع تطور الخدمة."],
] as const;

const LEGACY_FAQ = [
  ["هل التسجيل المجاني يحتاج بطاقة بنكية؟", "لا. الحساب الأساسي لا يتطلب بطاقة بنكية، وقد تتوفر إضافات أو سعات أو خدمات اختيارية مدفوعة عند الحاجة."],
  ["هل يجب نقل بياناتنا الحالية فورًا؟", "لا. يمكنك البدء بالتهيئة الأساسية، ثم تحديد ما يلزم نقله أو ربطه وفق جاهزية المنشأة."],
  ["هل بيانات المنشآت منفصلة؟", "نعم. الوصول مصمم حول سياق المنشأة وصلاحيات الدور لتقليل الوصول غير المصرح به ومنع اختلاط البيانات."],
  ["هل يمكن تعديل الموقع من أودير؟", "نعم. صفحات الموقع والقوائم والسياسات قابلة للإدارة والنشر من لوحة الموقع والبيلدر المرئي."],
] as const;

function cmsText(value: string | undefined, legacy: string, polished: string) {
  const text = String(value ?? "").trim();
  return !text || text === legacy ? polished : text;
}

function cmsHref(value: string | undefined, legacy: string, polished: string) {
  const href = String(value ?? "").trim();
  return !href || href === legacy ? polished : href;
}

const demoViews = {
  overview: {
    label: "لوحة المدير",
    eyebrow: "صباحك يبدأ من هنا",
    title: "الصورة كاملة قبل ما تتحول الملاحظة إلى مشكلة.",
    metrics: [
      ["العملاء الجدد", "184", "+12%"],
      ["طلبات التسجيل", "63", "+8"],
      ["مهام تحتاج تدخلك", "12", "الآن"],
      ["مبيعات الشهر", "126,450", "ر.س"],
    ],
    bars: [58, 41, 27, 13, 9],
  },
  sales: {
    label: "المبيعات",
    eyebrow: "كل فرصة لها خطوة جاية",
    title: "اعرف مين تواصل، ومين تأخر، ووين توقف العميل.",
    metrics: [
      ["فرص اليوم", "47", "+9"],
      ["متوسط الاستجابة", "04:18", "دقيقة"],
      ["بانتظار الدفع", "13", "فرصة"],
      ["قيمة متوقعة", "84,600", "ر.س"],
    ],
    bars: [72, 55, 38, 26, 18],
  },
  operations: {
    label: "التشغيل",
    eyebrow: "المهمة تتحرك، والسجل يبقى",
    title: "كل موظف يعرف وش عليه، وكل إجراء محفوظ في مكانه.",
    metrics: [
      ["مهام اليوم", "36", "مهمة"],
      ["اكتملت", "24", "67%"],
      ["مواعيد قريبة", "7", "اليوم"],
      ["تنبيهات حرجة", "2", "تحتاج قرار"],
    ],
    bars: [67, 52, 44, 31, 20],
  },
  reports: {
    label: "التقارير",
    eyebrow: "أرقام تقود القرار",
    title: "شوف وين يتعطل المسار، وأي برنامج يتحرك، ومن يحتاج دعمًا.",
    metrics: [
      ["نسبة التحويل", "18.7%", "+2.4"],
      ["المضاف يدويًا", "29", "عميل"],
      ["غير مهتم", "16", "8.6%"],
      ["مكالمات الفريق", "126", "4س 32د"],
    ],
    bars: [84, 64, 78, 48, 69],
  },
} as const;

type DemoViewKey = keyof typeof demoViews;

const journeyEvents = [
  { time: "09:03", source: "Meta", text: "وصل استفسار جديد عن برنامج إدارة المشاريع" },
  { time: "09:04", source: "أودير", text: "توزّع تلقائيًا على الموظفة نورة" },
  { time: "09:08", source: "Yeastar", text: "تمت المكالمة وحُفظت النتيجة في سجل العميل" },
  { time: "09:12", source: "التقويم", text: "تحددت متابعة اليوم الساعة 1:30" },
  { time: "13:42", source: "التسجيل", text: "انتقل الطلب إلى بانتظار الدفع" },
] as const;

function ArrowMark() {
  return <span className="arrow-mark" aria-hidden="true" />;
}

function opensRegistrationModal(href: string) {
  const path = String(href || "").trim().split(/[?#]/, 1)[0].replace(/^https?:\/\/[^/]+/i, "");
  return path === "/free-trial" || path === "/free-trial/apply";
}

function openRegistrationFromLink(
  event: MouseEvent<HTMLAnchorElement>,
  href: string,
  onRegister: () => void,
) {
  if (!opensRegistrationModal(href)) return;
  event.preventDefault();
  onRegister();
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "brand brand--compact" : "brand"} aria-label="أودير ODEIR">
      <Image
        className="brand-logo"
        src="/odeir/odeir-logo-transparent.webp"
        width={1126}
        height={522}
        alt="أودير ODEIR — أدر على بيّنة"
      />
    </span>
  );
}

function useReveal() {
  useEffect(() => {
    const nodes = Array.from(document.querySelectorAll<HTMLElement>(".odeir-experience [data-reveal]"));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }
    if (!("IntersectionObserver" in window)) {
      nodes.forEach((node) => node.classList.add("is-visible"));
      return;
    }
    const revealNearViewport = () => nodes.forEach((node) => {
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight * 1.08 && rect.bottom > -80) node.classList.add("is-visible");
    });
    revealNearViewport();
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        }
      }),
      { threshold: 0.05, rootMargin: "0px 0px -6% 0px" },
    );
    nodes.filter((node) => !node.classList.contains("is-visible")).forEach((node) => observer.observe(node));
    const fallback = window.setInterval(revealNearViewport, 900);
    const stopFallback = window.setTimeout(() => window.clearInterval(fallback), 45000);
    return () => {
      window.clearInterval(fallback);
      window.clearTimeout(stopFallback);
      observer.disconnect();
    };
  }, []);
}

function Header({ cms, onRegister }: { cms: LandingCms; onRegister: () => void }) {
  const [open, setOpen] = useState(false);
  const primaryLabel = cms.hero?.primaryLabel || "سجّل منشأتك مجانًا";
  const primaryHref = cms.hero?.primaryHref || "/free-trial/apply";
  const loginLabel = cms.settings?.customerLoginLabel || "دخول المنشآت";
  const loginHref = cms.settings?.customerLoginUrl || "/login";
  return (
    <header className="site-header">
      <a className="brand-link" href="#top" aria-label="أودير - الرئيسية"><Brand /></a>
      <nav className={open ? "main-nav is-open" : "main-nav"} aria-label="التنقل الرئيسي">
        <a href="#morning-brief" onClick={() => setOpen(false)}>أول فنجان</a>
        <a href="#story" onClick={() => setOpen(false)}>كيف يعمل</a>
        <a href="#product" onClick={() => setOpen(false)}>جولة داخل أودير</a>
        <a href="#integrations" onClick={() => setOpen(false)}>التكاملات</a>
        <a href="#security" onClick={() => setOpen(false)}>الحماية</a>
        <a className="mobile-nav-only" href={`${APP_ORIGIN}${loginHref}`} onClick={() => setOpen(false)}>{loginLabel}</a>
        <a className="mobile-nav-only mobile-nav-cta" href={`${APP_ORIGIN}${primaryHref}`} onClick={(event) => { setOpen(false); openRegistrationFromLink(event, primaryHref, onRegister); }}>{primaryLabel}</a>
      </nav>
      <div className="header-actions">
        <a className="login-link" href={`${APP_ORIGIN}${loginHref}`}>{loginLabel}</a>
        <a className="button button--small" href={`${APP_ORIGIN}${primaryHref}`} onClick={(event) => openRegistrationFromLink(event, primaryHref, onRegister)}>{primaryLabel.replace("منشأتك ", "")} <ArrowMark /></a>
      </div>
      <button className={open ? "menu-toggle is-open" : "menu-toggle"} type="button" aria-label={open ? "إغلاق القائمة" : "فتح القائمة"} aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span /><span /><span />
      </button>
    </header>
  );
}

function MiniChart({ values }: { values: readonly number[] }) {
  const points = values.map((value, index) => `${index * 130},${155 - value}`).join(" ");
  return (
    <div className="mini-chart" aria-label="رسم بياني توضيحي">
      <div className="chart-grid" aria-hidden="true" />
      <svg viewBox="0 0 520 170" role="img" aria-label="اتجاه المؤشر خلال الفترة">
        <defs><linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#12d6c7" stopOpacity=".34" /><stop offset="100%" stopColor="#12d6c7" stopOpacity="0" /></linearGradient></defs>
        <path className="chart-area" d={`M0 170 L${points.replaceAll(",", " ").replaceAll(" ", " L")} L520 170 Z`} />
        <polyline className="chart-line" points={points} />
        {values.map((value, index) => <circle key={`${value}-${index}`} cx={index * 130} cy={155 - value} r="5" />)}
      </svg>
      <div className="chart-labels"><span>الأسبوع 1</span><span>الأسبوع 2</span><span>الأسبوع 3</span><span>اليوم</span></div>
    </div>
  );
}

function DashboardWindow({ activeView = "overview", hero = false }: { activeView?: DemoViewKey; hero?: boolean }) {
  const view = demoViews[activeView];
  const activeIndex = activeView === "overview" ? 0 : activeView === "sales" ? 1 : activeView === "operations" ? 2 : 4;
  return (
    <div className={hero ? "dashboard-window dashboard-window--hero" : "dashboard-window"}>
      <div className="window-bar"><span className="window-brand"><Brand compact /></span><span className="window-search">ابحث عن عميل أو طلب...</span><span className="window-user">م ك</span></div>
      <div className="window-body">
        <aside className="window-sidebar" aria-label="قائمة توضيحية">
          <span className="sidebar-logo"><span /></span>
          {["home", "sales", "calendar", "courses", "chart", "settings"].map((item, index) => <i key={item} className={index === activeIndex ? "active" : ""} />)}
        </aside>
        <div className="window-content">
          <div className="demo-heading"><div><small>{view.eyebrow}</small><h3>{view.label}</h3></div><span className="live-pill"><i /> مباشر</span></div>
          <div className="metric-grid">
            {view.metrics.map(([label, value, delta], index) => (
              <article key={label} className={index === 0 ? "metric-card is-primary" : "metric-card"}><small>{label}</small><strong>{value}</strong><span>{delta}</span></article>
            ))}
          </div>
          <div className="dashboard-lower">
            <div className="chart-card"><div className="card-title"><b>حركة المسار</b><span>آخر 30 يومًا</span></div><MiniChart values={view.bars} /></div>
            <div className="activity-card">
              <div className="card-title"><b>يحتاج انتباهك</b><span>الآن</span></div>
              <ul>
                <li><i className="status-dot status-dot--yellow" /><span><b>3 فرص</b><small>بانتظار التوزيع</small></span><em>الآن</em></li>
                <li><i className="status-dot status-dot--teal" /><span><b>7 متابعات</b><small>خلال ساعتين</small></span><em>اليوم</em></li>
                <li><i className="status-dot status-dot--blue" /><span><b>طلبان</b><small>بانتظار الاعتماد</small></span><em>جديد</em></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
      <span className="demo-watermark">تجربة توضيحية · بيانات افتراضية</span>
    </div>
  );
}

function MobileHeroSnapshot({ activeEvent }: { activeEvent: number }) {
  const event = journeyEvents[activeEvent];
  return (
    <div className="mobile-hero-snapshot" data-reveal aria-label="لوحة تشغيل توضيحية للجوال">
      <div className="mobile-snapshot-head">
        <span><small>لوحة اليوم</small><b>منشأتك في نظرة واحدة</b></span>
        <em><i /> مباشر</em>
      </div>
      <div className="mobile-snapshot-kpis">
        <span><small>طلبات جديدة</small><b>63</b><em>+8 اليوم</em></span>
        <span><small>متابعات قريبة</small><b>7</b><em>خلال ساعتين</em></span>
        <span><small>نسبة التحويل</small><b>18.7%</b><em>+2.4%</em></span>
      </div>
      <div className="mobile-snapshot-event" key={event.time} aria-live="polite">
        <span className="mobile-event-mark"><i /></span>
        <span><small>{event.source} · {event.time}</small><b>{event.text}</b></span>
        <em>تم</em>
      </div>
      <div className="mobile-snapshot-progress" aria-hidden="true"><span /><span /><span /><span /><span /></div>
      <p><i /> تجربة توضيحية بأرقام وبيانات افتراضية</p>
    </div>
  );
}

function Hero({ cms, onRegister }: { cms: LandingCms; onRegister: () => void }) {
  const [activeEvent, setActiveEvent] = useState(0);
  const eyebrow = cmsText(cms.hero?.eyebrow, LEGACY_HERO.eyebrow, "منصة تشغيل وإدارة للمنشآت التدريبية الأهلية المعتمدة");
  const title = cmsText(cms.hero?.title, LEGACY_HERO.title, "من أول استفسار… إلى مقعد مكتمل، كل خطوة تحت عينك.");
  const body = cmsText(cms.hero?.body, LEGACY_HERO.body, "أودير يجمع المبيعات والتسجيل والقبول والبرامج والمهام والتقارير في مساحة واحدة؛ حتى يعمل فريقك بوضوح، وتتخذ إدارتك القرار في وقته.");
  const primaryLabel = cms.hero?.primaryLabel || "سجّل منشأتك مجانًا";
  const primaryHref = cms.hero?.primaryHref || "/free-trial/apply";
  const secondaryLabel = cmsText(cms.hero?.secondaryLabel, LEGACY_HERO.secondaryLabel, "جرّب أودير بنفسك");
  const secondaryHref = cmsHref(cms.hero?.secondaryHref, LEGACY_HERO.secondaryHref, "#product");
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setActiveEvent((value) => (value + 1) % journeyEvents.length), 2600);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <section className="odeir-home-hero" id="top">
      <div className="hero-glow hero-glow--one" aria-hidden="true" /><div className="hero-glow hero-glow--two" aria-hidden="true" />
      <div className="hero-copy" data-reveal>
        <div className="eyebrow"><span /> {eyebrow}</div>
        <h1>{title === "من أول استفسار… إلى مقعد مكتمل، كل خطوة تحت عينك." ? <>
          <span className="hero-title-desktop">من أول استفسار…<br /><span className="hero-title-accent">إلى مقعد مكتمل،</span><br />كل خطوة تحت عينك.</span>
          <span className="hero-title-mobile">من أول استفسار،<br /><span className="hero-title-accent">حتى مقعد مكتمل.</span></span>
        </> : title}</h1>
        <p>{body}</p>
        <div className="hero-actions"><a className="button button--primary" href={`${APP_ORIGIN}${primaryHref}`} onClick={(event) => openRegistrationFromLink(event, primaryHref, onRegister)}>{primaryLabel} <ArrowMark /></a><a className="button button--ghost" href={`${APP_ORIGIN}${secondaryHref}`}>{secondaryLabel}</a></div>
        <ul className="hero-trust" aria-label="مزايا البداية"><li><i /> بدون بطاقة بنكية</li><li><i /> إعداد بخطوات واضحة</li><li><i /> بيانات مستقلة لكل منشأة</li></ul>
      </div>
      <MobileHeroSnapshot activeEvent={activeEvent} />
      <div className="hero-visual" data-reveal>
        <div className="hero-orbit hero-orbit--one" aria-hidden="true" /><div className="hero-orbit hero-orbit--two" aria-hidden="true" />
        <DashboardWindow hero />
        <div className="floating-event" aria-live="polite"><span className="event-time">{journeyEvents[activeEvent].time}</span><span className="event-icon"><i /></span><span><b>{journeyEvents[activeEvent].source}</b><small>{journeyEvents[activeEvent].text}</small></span></div>
        <div className="floating-result"><i /><span><small>نسبة التحويل</small><b>18.7%</b></span><em>+2.4%</em></div>
      </div>
      <a href="#morning-brief" className="scroll-cue" aria-label="انتقل للمحتوى"><span /> اكتشف أودير</a>
    </section>
  );
}

const morningFallback = [
  {
    category: "أخبار السوق",
    title: "زبدة ما يستجد في قطاع التدريب.",
    excerpt: "أبرز التحديثات العامة التي تهم صاحب القرار، باختصار وبدون ضجيج.",
    mark: "نبض",
  },
  {
    category: "فرص ومنافسات",
    title: "فرص تستحق أن تكون على رادارك.",
    excerpt: "مساحة للفرص العامة والمنافسات بعد مراجعتها ونشرها من إدارة أودير.",
    mark: "فرصة",
  },
  {
    category: "معرفة عملية",
    title: "فكرة واحدة تحسّن قرار اليوم.",
    excerpt: "ممارسات تشغيل ومبيعات وبيانات تقدر تناقشها مع فريقك من الصباح.",
    mark: "فكرة",
  },
] as const;

function briefDate(value?: string | null) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "مختارات أودير";
  const months = ["يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو", "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"];
  return `${Number(match[3])} ${months[Number(match[2]) - 1] || ""}`.trim();
}

function safeBriefCover(value?: string | null) {
  const url = String(value || "").trim();
  return (/^(https:\/\/|\/(?!\/))/i.test(url) && !/["'()]/.test(url)) ? url : "";
}

function MorningBriefing({ articles = [] }: { articles?: LandingArticle[] }) {
  const published = articles
    .filter((article) => String(article.slug || "").trim() && String(article.title || "").trim())
    .slice(0, 3)
    .map((article) => ({
      category: article.category || "رؤى أودير",
      title: article.title || "",
      excerpt: article.excerpt || "اقرأ المادة المنشورة واكتشف التفاصيل.",
      mark: article.featured ? "مميز" : "جديد",
      meta: article.readingMinutes ? `${article.readingMinutes} دقائق · ${briefDate(article.publishedAt)}` : briefDate(article.publishedAt),
      href: `/articles/${encodeURIComponent(String(article.slug))}`,
      coverUrl: safeBriefCover(article.coverUrl),
    }));
  const cards = [
    ...published,
    ...morningFallback.slice(0, Math.max(0, 3 - published.length)).map((item) => ({
      ...item,
      meta: "يُحدّث من إدارة الموقع",
      href: "/articles",
      coverUrl: "",
    })),
  ];
  return (
    <section className="morning-section" id="morning-brief">
      <div className="morning-inner section">
        <div className="morning-copy" data-reveal>
          <div className="morning-kicker"><i /> أول فنجان</div>
          <h2>قبل أول اجتماع…<br /><span>خذ زبدة السوق مع قهوتك.</span></h2>
          <p>موجز يومي ذكي يجمع أخبار قطاع التدريب، الفرص والمنافسات، ومعرفة عملية تساعدك تبدأ يومك بقرار أوضح.</p>
          <ul><li><i /> من المواد العامة المنشورة</li><li><i /> مختصر ومباشر لصاحب القرار</li><li><i /> بدون خلط مع بيانات أي منشأة</li></ul>
          <a className="morning-link" href="/articles">افتح الأخبار والمعارف <ArrowMark /></a>
        </div>
        <div className="morning-feed" data-reveal>
          <header><span><i /> موجز اليوم</span><small>المواد المنشورة والمعتمدة فقط</small></header>
          <div className="morning-cards">
            {cards.map((card, index) => (
              <a className={`morning-card morning-card--${index + 1}`} href={card.href} key={`${card.title}-${index}`}>
                <span className={card.coverUrl ? "morning-card-media has-cover" : "morning-card-media"} style={card.coverUrl ? { backgroundImage: `linear-gradient(145deg, rgba(2,13,32,.14), rgba(2,13,32,.72)), url(${card.coverUrl})` } : undefined}>
                  <i>{card.mark}</i><em aria-hidden="true" />
                </span>
                <span className="morning-card-copy"><small>{card.category}<i />{card.meta}</small><b>{card.title}</b><p>{card.excerpt}</p><em>اقرأها الآن <ArrowMark /></em></span>
              </a>
            ))}
          </div>
          <p className="morning-note"><i /> لا تظهر هنا إلا المواد العامة التي نُشرت من إدارة موقع أودير.</p>
        </div>
      </div>
    </section>
  );
}

type JourneyCategoryKey = "commerce" | "ads" | "sales" | "admissions" | "trainees";

type JourneySource = {
  key: string;
  label: string;
  nodeLabel?: string;
  description: string;
  logo: string;
  logoClass?: string;
};

type JourneyCategory = {
  key: JourneyCategoryKey;
  label: string;
  shortLabel: string;
  caption: string;
  description: string;
  coreKicker: string;
  coreTitle: string;
  coreSecond: string;
  sources: readonly JourneySource[];
  notice?: string;
};

const JOURNEY_CATEGORIES: readonly JourneyCategory[] = [
  {
    key: "commerce",
    label: "المتاجر والتجارة الإلكترونية",
    shortLabel: "المتاجر",
    caption: "طلبات ومدفوعات",
    description: "استقبل الطلب بحالته ومصدره، واربطه بالعميل والسداد والتسجيل بدون إعادة إدخال.",
    coreKicker: "الطلبات مترابطة",
    coreTitle: "كل طلب واضح.",
    coreSecond: "في مسار واحد.",
    sources: [
      { key: "salla", label: "سلة", description: "طلبات المتجر", logo: "/integrations/salla-color.svg" },
      { key: "zid", label: "زد", description: "إدارة المتجر", logo: "/integrations/zid-color.svg" },
      { key: "shopify", label: "Shopify", description: "التجارة العالمية", logo: "/integrations/shopify.svg", logoClass: "is-wide" },
      { key: "woo", label: "WooCommerce", description: "متجر ووردبريس", logo: "/integrations/woocommerce-color.svg", logoClass: "is-wide" },
      { key: "other-stores", label: "متاجر أخرى", description: "واجهات وربط مرن", logo: "/integrations/other-stores.svg" },
    ],
  },
  {
    key: "ads",
    label: "الإعلانات ومصادر العملاء",
    shortLabel: "الإعلانات",
    caption: "حملات ومصادر",
    description: "اعرف أي حملة جابت العميل، ووصل الاستفسار بفريق المبيعات قبل ما تبرد الفرصة.",
    coreKicker: "المصدر محفوظ",
    coreTitle: "من النقرة للفرصة.",
    coreSecond: "بدون حلقة ضايعة.",
    sources: [
      { key: "meta", label: "Meta", description: "إعلانات ورسائل", logo: "/integrations/meta-color.svg", logoClass: "is-wide" },
      { key: "instagram", label: "Instagram", description: "إعلانات ومحادثات", logo: "/integrations/instagram-color.svg" },
      { key: "google-ads", label: "Google Ads", description: "بحث وحملات", logo: "/integrations/google-ads-color.svg" },
      { key: "snapchat", label: "Snapchat", description: "حملات سناب", logo: "/integrations/snapchat-color.svg" },
      { key: "tiktok", label: "TikTok", description: "حملات المحتوى", logo: "/integrations/tiktok-color.svg" },
      { key: "x", label: "منصة X", nodeLabel: "X", description: "حملات ومحادثات", logo: "/integrations/x-color.svg" },
    ],
  },
  {
    key: "sales",
    label: "المبيعات وإدارة العملاء",
    shortLabel: "المبيعات والعملاء",
    caption: "CRM واتصالات",
    description: "المكالمة والمحادثة والمرحلة القادمة في ملف واحد؛ حتى ما يبدأ الموظف من الصفر.",
    coreKicker: "السياق كامل",
    coreTitle: "كل عميل واضح.",
    coreSecond: "وخطوته جاية.",
    sources: [
      { key: "yeastar", label: "Yeastar", description: "الاتصالات والسنترال", logo: "/integrations/yeastar-color.svg" },
      { key: "salesforce", label: "Salesforce", description: "إدارة علاقات العملاء", logo: "/integrations/salesforce-color.svg" },
      { key: "hubspot", label: "HubSpot", description: "مبيعات وتسويق", logo: "/integrations/hubspot-color.svg" },
      { key: "zoho", label: "Zoho CRM", description: "إدارة العملاء", logo: "/integrations/zoho-crm-color.svg" },
    ],
  },
  {
    key: "admissions",
    label: "التسجيل والقبول",
    shortLabel: "التسجيل والقبول",
    caption: "متطلبات الجهات",
    description: "رتّب الطلب والوثائق والبرنامج والفاتورة في مسار يساعدك على مواءمة التشغيل مع المتطلبات ذات الصلة.",
    coreKicker: "الملف مكتمل",
    coreTitle: "قبول منظم.",
    coreSecond: "ومتطلبات أوضح.",
    sources: [
      { key: "tvtc", label: "المؤسسة العامة للتدريب التقني والمهني", nodeLabel: "التدريب التقني", description: "متطلبات منشآت التدريب", logo: "/integrations/tvtc-color.svg" },
      { key: "mnar", label: "منصة منار", nodeLabel: "منار", description: "بيانات البرامج والمتدربين", logo: "/integrations/mnar-color.svg" },
      { key: "nelc", label: "المركز الوطني للتعليم الإلكتروني", nodeLabel: "التعليم الإلكتروني", description: "ضوابط التعليم الإلكتروني", logo: "/integrations/nelc-color.svg" },
      { key: "zatca", label: "هيئة الزكاة والضريبة والجمارك (زاتكا)", nodeLabel: "زاتكا", description: "الفوترة والامتثال الضريبي", logo: "/integrations/zatca-color.svg" },
    ],
    notice: "عرض الجهات يوضح مواءمة مسارات التشغيل مع متطلباتها، ولا يعني شراكة أو اعتمادًا رسميًا.",
  },
  {
    key: "trainees",
    label: "تشغيل المتدربين",
    shortLabel: "تشغيل المتدربين",
    caption: "تعلم وتواصل",
    description: "الجلسة والحضور والمحتوى والمحاضر وتنبيه المتدرب تتحرك من خطة تشغيل واحدة.",
    coreKicker: "التشغيل متصل",
    coreTitle: "من أول محاضرة.",
    coreSecond: "كل خطوة محسوبة.",
    sources: [
      { key: "zoom", label: "Zoom", description: "جلسات مباشرة", logo: "/integrations/zoom-color.svg", logoClass: "is-wide" },
      { key: "google-meet", label: "Google Meet", description: "لقاءات افتراضية", logo: "/integrations/google-meet-color.svg" },
      { key: "whatsapp-business", label: "WhatsApp Business", description: "تنبيهات وتواصل", logo: "/integrations/whatsapp-color.svg" },
      { key: "lms", label: "نظام إدارة التعلم (LMS)", nodeLabel: "LMS", description: "محتوى وحضور", logo: "/integrations/lms.svg" },
      { key: "certified-instructors", label: "محاضرون معتمدون", description: "توزيع وجدولة", logo: "/integrations/certified-instructors.svg" },
    ],
  },
] as const;

const JOURNEY_PATHS = [
  "M100 78C210 78 232 172 292 214",
  "M660 78C550 78 528 172 468 214",
  "M86 234C177 234 215 257 246 278",
  "M674 234C583 234 545 257 514 278",
  "M120 406C202 406 220 365 252 350",
  "M640 406C558 406 540 365 508 350",
] as const;

function JourneyCategoryIcon({ type }: { type: JourneyCategoryKey }) {
  if (type === "commerce") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h2l2 10h10l2-7H7M9 19a1 1 0 1 0 0 .01M17 19a1 1 0 1 0 0 .01" /></svg>;
  if (type === "ads") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 13 12-5v9L4 13Zm0 0v4h4l2 3M19 9l2-2M20 13h3M19 17l2 2" /></svg>;
  if (type === "sales") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-6 9c.5-4 2.5-6 6-6s5.5 2 6 6M16 8h6M16 12h5M16 16h4" /></svg>;
  if (type === "admissions") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6V3Zm9 0v5h4M9 12h7M9 16h5" /><path d="m8 8 1 1 2-2" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m2 9 10-5 10 5-10 5L2 9Zm4 3v5c4 3 8 3 12 0v-5M22 9v7" /></svg>;
}

function StoryStrip() {
  const [activeCategoryKey, setActiveCategoryKey] = useState<JourneyCategoryKey>("commerce");
  const [activeNode, setActiveNode] = useState(0);
  const activeCategory = JOURNEY_CATEGORIES.find((category) => category.key === activeCategoryKey) ?? JOURNEY_CATEGORIES[0];

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => setActiveNode((value) => (value + 1) % activeCategory.sources.length), 2400);
    return () => window.clearInterval(timer);
  }, [activeCategory.key, activeCategory.sources.length]);

  function selectCategory(key: JourneyCategoryKey) {
    setActiveCategoryKey(key);
    setActiveNode(0);
  }

  return (
    <section className="story-section section" id="story">
      <div className="section-kicker" data-reveal><span>01</span> كل تكامل في مكانه</div>
      <div className="story-head" data-reveal><h2>خمس منظومات حول منشأتك.<br />أودير يجمعها في مسار واحد.</h2><p>اختر القسم، وشاهد كيف تتحول المنصات المتفرقة إلى رحلة تشغيل مفهومة للمدير والموظف—بدون شاشة إضافية تزيد التعقيد.</p></div>
      <div className="story-flow" data-reveal>
        <div className="journey-category-tabs" role="tablist" aria-label="أقسام التكامل">
          {JOURNEY_CATEGORIES.map((category, index) => (
            <button
              className={`journey-category-tab${activeCategory.key === category.key ? " is-active" : ""}`}
              type="button"
              role="tab"
              id={`journey-tab-${category.key}`}
              aria-controls="journey-category-panel"
              aria-selected={activeCategory.key === category.key}
              tabIndex={activeCategory.key === category.key ? 0 : -1}
              onClick={() => selectCategory(category.key)}
              key={category.key}
            >
              <span className="journey-category-icon"><JourneyCategoryIcon type={category.key} /></span>
              <span><b>{category.shortLabel}</b><small>{category.caption}</small></span>
              <em>{String(index + 1).padStart(2, "0")}</em>
            </button>
          ))}
        </div>
        <div
          className="journey-category-panel"
          id="journey-category-panel"
          role="tabpanel"
          aria-labelledby={`journey-tab-${activeCategory.key}`}
          aria-live="polite"
          key={`panel-${activeCategory.key}`}
        >
          <div className="journey-category-summary">
            <span><i /> المسار الحالي</span>
            <h3>{activeCategory.label}</h3>
            <p>{activeCategory.description}</p>
          </div>
          <div className="journey-platform-list" aria-label={`منصات ${activeCategory.shortLabel}`}>
            {activeCategory.sources.map((source) => <span dir="auto" key={`legend-${source.key}`}>{source.label}</span>)}
          </div>
          {activeCategory.notice ? <p className="journey-category-notice"><i aria-hidden="true">!</i>{activeCategory.notice}</p> : null}
        </div>
        <div className={`journey-network journey-network--${activeCategory.sources.length}`} aria-label={`ربط ${activeCategory.label} داخل أودير`}>
          <svg className="journey-network-map" viewBox="0 0 760 520" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="journey-line-gradient" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#9af8f4" stopOpacity=".15" /><stop offset=".52" stopColor="#22d9d0" stopOpacity=".95" /><stop offset="1" stopColor="#61e9ff" stopOpacity=".3" /></linearGradient>
              <filter id="journey-line-glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="4" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
            </defs>
            <path className="journey-spine" d="M380 48V168" />
            {activeCategory.sources.map((source, index) => <path className={`journey-line${activeNode === index ? " is-active" : ""}`} d={JOURNEY_PATHS[index]} key={`line-${activeCategory.key}-${source.key}`} />)}
            {activeCategory.sources.map((source, index) => <path className={`journey-line-trace${activeNode === index ? " is-active" : ""}`} d={JOURNEY_PATHS[index]} key={`trace-${activeCategory.key}-${source.key}`} />)}
          </svg>
          <span className="network-beacon" aria-hidden="true"><i /></span>
          {activeCategory.sources.map((source, index) => (
            <button
              className={`network-node network-node--position-${index + 1}${activeNode === index ? " is-active" : ""}`}
              type="button"
              aria-label={`${source.label}: ${source.description}`}
              aria-pressed={activeNode === index}
              onClick={() => setActiveNode(index)}
              onFocus={() => setActiveNode(index)}
              onPointerEnter={() => setActiveNode(index)}
              key={`node-${activeCategory.key}-${source.key}`}
            >
              <Image className={source.logoClass ?? ""} src={source.logo} width={70} height={70} alt="" />
              <span className="network-node-label" dir="auto"><b>{source.nodeLabel ?? source.label}</b><small>{source.description}</small></span>
            </button>
          ))}
          <div className="odeir-core">
            <span className="core-orbit core-orbit--outer" aria-hidden="true" />
            <span className="core-orbit core-orbit--inner" aria-hidden="true" />
            <Brand compact />
            <span className="core-message" key={`core-${activeCategory.key}`}>
              <small>{activeCategory.coreKicker}</small>
              <b>{activeCategory.coreTitle}<br />{activeCategory.coreSecond}</b>
            </span>
            <span className="core-pulse" aria-hidden="true" />
          </div>
          <span className="network-platform" aria-hidden="true" />
        </div>
        <p className="journey-trademark-note"><i /> أسماء وشعارات المنصات مملوكة لأصحابها. عرضها يشرح مسارات الربط ولا يعني شراكة رسمية؛ والتوفر يعتمد على الخطة وجاهزية واجهة المنصة.</p>
      </div>
    </section>
  );
}

function ProductDemo() {
  const [activeView, setActiveView] = useState<DemoViewKey>("overview");
  const view = demoViews[activeView];
  return (
    <section className="product-section section" id="product">
      <div className="section-kicker section-kicker--light" data-reveal><span>02</span> مو مجرد كلام</div>
      <div className="product-intro" data-reveal><div><h2>خذ جولة داخل أودير.<br /><span>وشوف كيف يصير الوضوح.</span></h2></div><p>بدّل بين الشاشات. الأرقام افتراضية، لكن المنطق هو نفس منطق يوم منشأتك: مسؤول، حالة، موعد، وقرار.</p></div>
      <div className="demo-tabs" role="tablist" aria-label="شاشات أودير" data-reveal>
        {(Object.entries(demoViews) as [DemoViewKey, typeof demoViews[DemoViewKey]][]).map(([key, item]) => <button key={key} type="button" role="tab" aria-selected={activeView === key} className={activeView === key ? "is-active" : ""} onClick={() => setActiveView(key)}><span>{item.label}</span><small>{item.eyebrow}</small></button>)}
      </div>
      <div className="product-stage" data-reveal>
        <div className="product-copy-card"><span className="step-number">{String((Object.keys(demoViews) as DemoViewKey[]).indexOf(activeView) + 1).padStart(2, "0")}</span><div><small>{view.eyebrow}</small><h3>{view.title}</h3><p>كل رقم قابل للتفصيل، وكل حالة مرتبطة بصاحبها وخطوتها التالية.</p></div></div>
        <DashboardWindow activeView={activeView} />
      </div>
    </section>
  );
}

const operationalStories = [
  {
    number: "01",
    tag: "المبيعات والعملاء",
    title: "العميل استفسر… وما عاد يضيع بين الموظفين.",
    copy: "كل عميل له مسؤول، نتيجة تواصل، موعد واضح وخطوة جاية. ولو تغيّر المسؤول، يبقى التاريخ كاملًا داخل المنشأة.",
    accent: "teal",
    visual: "client",
  },
  {
    number: "02",
    tag: "المهام والتقويم",
    title: "المهمة تتحرك مع الإجراء، والسجل يبقى محفوظًا.",
    copy: "ما تشوف المهمة مرتين ولا تحسب متابعة قديمة كأنها فائتة. الموعد النشط ينتقل، وكل حركة سابقة تظل في سجل العميل.",
    accent: "yellow",
    visual: "calendar",
  },
  {
    number: "03",
    tag: "التسجيل والقبول",
    title: "من الاهتمام إلى المقعد المسجّل، بدون انقطاع.",
    copy: "القبول والوثائق والسداد والدورة والدفعة في مسار واحد؛ حتى يعرف الموظف حالة الطلب وتعرف الإدارة أين يتعطل.",
    accent: "blue",
    visual: "admission",
  },
  {
    number: "04",
    tag: "التقارير والقرار",
    title: "نفس الرقم في كل شاشة. ونفس الحقيقة لكل إدارة.",
    copy: "فلترة بالتاريخ والموظف والمصدر والبرنامج، مع مؤشرات مفهومة تكشف الفرصة قبل ما تتحول إلى مشكلة.",
    accent: "mint",
    visual: "report",
  },
] as const;

function FeatureVisual({ type }: { type: string }) {
  if (type === "client") {
    return (
      <div className="feature-ui feature-ui--client">
        <div className="ui-toolbar"><span>سجل العميل</span><i /><i /></div>
        <div className="lead-profile"><span>ن م</span><div><b>نورة محمد</b><small>برنامج إدارة المشاريع</small></div><em>مهتم</em></div>
        <div className="lead-timeline">
          <p><i /><span><b>تم استلام العميل</b><small>من حملة Meta · 09:03</small></span></p>
          <p><i /><span><b>مكالمة ناجحة</b><small>مدة التحدث 04:22 · 09:08</small></span></p>
          <p className="is-current"><i /><span><b>متابعة اليوم</b><small>الساعة 01:30 · نورة</small></span></p>
        </div>
      </div>
    );
  }
  if (type === "calendar") {
    return (
      <div className="feature-ui feature-ui--calendar">
        <div className="calendar-head"><b>أغسطس 2026</b><span>اليوم</span></div>
        <div className="week-row"><span>الأحد<small>16</small></span><span>الإثنين<small>17</small></span><span className="is-today">الثلاثاء<small>18</small></span><span>الأربعاء<small>19</small></span><span>الخميس<small>20</small></span></div>
        <div className="calendar-task"><i /><span><b>متابعة طلب التسجيل</b><small>نورة محمد · 01:30 م</small></span><em>اليوم</em></div>
        <div className="calendar-history"><span /><p><b>الموعد السابق محفوظ في السجل</b><small>تم تغيير الموعد بعد التواصل</small></p></div>
      </div>
    );
  }
  if (type === "admission") {
    return (
      <div className="feature-ui feature-ui--admission">
        <div className="admission-head"><span>طلب #1048</span><em>قيد الإكمال</em></div>
        <div className="admission-person"><i>س</i><span><b>سارة أحمد</b><small>دبلوم الموارد البشرية</small></span></div>
        <div className="admission-steps"><span className="done"><i />الطلب</span><span className="done"><i />القبول</span><span className="active"><i />السداد</span><span><i />التسجيل</span></div>
        <div className="admission-footer"><span><small>القيمة</small><b>2,490 ر.س</b></span><button type="button">إكمال الطلب</button></div>
      </div>
    );
  }
  return (
    <div className="feature-ui feature-ui--report">
      <div className="report-filters"><span>هذا الشهر</span><span>كل الموظفين</span></div>
      <div className="report-metric"><span><small>معدل التحويل</small><b>18.7%</b><em>+2.4%</em></span><div className="donut"><i>19%</i></div></div>
      <div className="report-bars"><i style={{ height: "42%" }} /><i style={{ height: "63%" }} /><i style={{ height: "51%" }} /><i style={{ height: "78%" }} /><i style={{ height: "68%" }} /><i style={{ height: "91%" }} /></div>
    </div>
  );
}

function OperationalStories({ cms }: { cms: LandingCms }) {
  const stories = operationalStories.map((story, index) => {
    const item = cms.capabilities?.items?.[index];
    const legacy = LEGACY_CAPABILITIES[index];
    if (!legacy) return story;
    return {
      ...story,
      title: cmsText(item?.title, legacy[0], story.title),
      copy: cmsText(item?.description, legacy[1], story.copy),
    };
  });
  const kicker = cmsText(cms.capabilities?.eyebrow, "منصة واحدة", "حلول تشبه يومك");
  const title = cmsText(cms.capabilities?.title, "ما تحتاجه لتشغيل منشأتك — بلا تشتيت", "كل فقرة هنا تحل موقفًا مرّ عليك فعلًا.");
  const body = cmsText(cms.capabilities?.body, "وحدات مترابطة تعطي كل دور شاشته، وتُبقي الإدارة على صورة واحدة للعمل.", "أودير ما يبدأ من قائمة مميزات؛ يبدأ من اللحظة التي يقول فيها المدير: وين وصلنا؟ ومن المسؤول؟ وش الخطوة الجاية؟");
  return (
    <section className="features-section section" id="capabilities">
      <div className="section-kicker" data-reveal><span>03</span> {kicker}</div>
      <div className="features-heading" data-reveal><h2>{title}</h2><p>{body}</p></div>
      <div className="feature-stories">
        {stories.map((story, index) => (
          <article className={`feature-story feature-story--${story.accent}`} key={story.title} data-reveal>
            <div className="feature-copy"><span className="feature-number">{story.number}</span><small>{story.tag}</small><h3>{story.title}</h3><p>{story.copy}</p><span className="story-proof"><i /> واجهة توضيحية من منطق أودير</span></div>
            <div className="feature-visual"><FeatureVisual type={story.visual} /></div>
            <span className="feature-index">{String(index + 1).padStart(2, "0")}</span>
          </article>
        ))}
      </div>
    </section>
  );
}

const journeySources = [
  { key: "meta", label: "Meta", mark: "∞", status: "قيد التفعيل" },
  { key: "whatsapp", label: "WhatsApp", mark: "WA", status: "قيد التفعيل" },
  { key: "salla", label: "سلة", mark: "س", status: "قريبًا" },
  { key: "zid", label: "زد", mark: "زد", status: "قريبًا" },
  { key: "woo", label: "WooCommerce", mark: "Woo", status: "متاح" },
] as const;

const journeySteps = [
  ["وصل الطلب", "حُفظ المصدر والحملة"],
  ["دخل قائمة التوزيع", "بانتظار الموظف المناسب"],
  ["تم الإسناد", "إشعار مباشر للموظفة نورة"],
  ["تم التواصل", "مكالمة Yeastar محفوظة"],
  ["انتقل للتسجيل", "الخطوة التالية: السداد"],
] as const;

function JourneyLab() {
  const [source, setSource] = useState("meta");
  const [step, setStep] = useState(0);
  const [runId, setRunId] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (step >= journeySteps.length - 1) return;
    const timer = window.setTimeout(() => setStep((value) => value + 1), 1050);
    return () => window.clearTimeout(timer);
  }, [step, runId]);

  const currentSource = journeySources.find((item) => item.key === source) ?? journeySources[0];
  const restart = (nextSource = source) => {
    setSource(nextSource);
    setStep(0);
    setRunId((value) => value + 1);
  };

  return (
    <section className="journey-section" id="integrations">
      <div className="journey-inner section">
        <div className="section-kicker section-kicker--light" data-reveal><span>04</span> تكاملات تحرّك العمل</div>
        <div className="journey-heading" data-reveal><h2>الإشعار ما يكفي.<br /><span>خلّه يصير إجراء.</span></h2><p>اختر نقطة دخول تجريبية وشاهد كيف يتحول الطلب إلى عميل، ثم مهمة، ثم متابعة واضحة داخل أودير.</p></div>
        <div className="source-picker" role="tablist" aria-label="اختر مصدر العميل" data-reveal>
          {journeySources.map((item) => <button key={item.key} type="button" role="tab" aria-selected={source === item.key} className={source === item.key ? `source-choice source-choice--${item.key} is-active` : `source-choice source-choice--${item.key}`} onClick={() => restart(item.key)}><i>{item.mark}</i><span><b>{item.label}</b><small>{item.status}</small></span></button>)}
        </div>
        <div className="journey-console" data-reveal>
          <div className="journey-topbar"><span className="demo-label"><i /> تجربة توضيحية · بيانات افتراضية</span><button type="button" onClick={() => restart()}>أعد الرحلة</button></div>
          <div className="journey-lead">
            <div className={`journey-source-logo journey-source-logo--${currentSource.key}`}>{currentSource.mark}</div>
            <span><small>عميل تجريبي من {currentSource.label}</small><b>ريم عبدالله</b><em>برنامج تحليل البيانات</em></span>
            <strong>{step === 4 ? "بانتظار السداد" : step >= 2 ? "قيد المتابعة" : "جديد"}</strong>
          </div>
          <div className="journey-track">
            {journeySteps.map(([title, copy], index) => <button key={title} type="button" className={index < step ? "journey-step is-done" : index === step ? "journey-step is-active" : "journey-step"} onClick={() => setStep(index)}><i>{index < step ? "✓" : String(index + 1).padStart(2, "0")}</i><span><b>{title}</b><small>{copy}</small></span></button>)}
          </div>
          <div className="journey-metrics"><span><small>استفسارات اليوم</small><b>{47 + step}</b></span><span><small>بانتظار التوزيع</small><b>{Math.max(0, 3 - step)}</b></span><span><small>متوسط الاستجابة</small><b>{step >= 3 ? "04:18" : "05:02"}</b></span><span><small>تسجيلات جديدة</small><b>{17 + (step === 4 ? 1 : 0)}</b></span></div>
        </div>
        <div className="integration-rail" data-reveal>
          <span className="integration-wordmark integration-wordmark--yeastar"><i>Y</i> Yeastar <small>متاح</small></span>
          <span className="integration-wordmark integration-wordmark--google"><i>G</i> Google <small>قيد التفعيل</small></span>
          <span className="integration-wordmark integration-wordmark--meta"><i>∞</i> Meta <small>قيد التفعيل</small></span>
          <span className="integration-wordmark integration-wordmark--woo"><i>Woo</i> WooCommerce <small>متاح</small></span>
          <span className="integration-wordmark integration-wordmark--salla"><i>س</i> سلة <small>قريبًا</small></span>
          <span className="integration-wordmark integration-wordmark--zid"><i>ز</i> زد <small>قريبًا</small></span>
        </div>
        <p className="brand-disclaimer">أسماء وشعارات المنصات مملوكة لأصحابها، وعرضها يوضح مسار التكامل ولا يعني وجود شراكة رسمية.</p>
      </div>
    </section>
  );
}

const roleViews = {
  management: { label: "الإدارة", title: "الصورة كاملة، بدون انتظار تقرير.", stats: [["مبيعات الشهر", "126,450 ر.س"], ["نسبة التحويل", "18.7%"], ["مهام حرجة", "2"]], tasks: ["مراجعة تراجع برنامج Power BI", "اعتماد عرض سعر جديد", "متابعة أداء الحملة الحالية"] },
  sales: { label: "المبيعات", title: "أولوياتي واضحة، وعملائي قدامي.", stats: [["متابعات اليوم", "12"], ["فرص ساخنة", "7"], ["قيمة متوقعة", "32,800 ر.س"]], tasks: ["الاتصال بريم عبدالله", "إرسال رابط السداد لسارة", "متابعة 3 عملاء جدد"] },
  data: { label: "مسؤول البيانات", title: "التوزيع منظم، والجودة قابلة للقياس.", stats: [["بانتظار التوزيع", "3"], ["موزع اليوم", "47"], ["صفوف تحتاج مراجعة", "5"]], tasks: ["مراجعة أرقام غير صالحة", "توزيع طلبات المتجر", "تدقيق مصدر 8 عملاء"] },
  operations: { label: "التشغيل", title: "الدورات والدفعات والمواعيد في مسار واحد.", stats: [["دفعات نشطة", "6"], ["محاضرات اليوم", "9"], ["طلبات ناقصة", "4"]], tasks: ["تأكيد قاعة الدفعة 18", "استكمال وثائق 4 متدربين", "إرسال تذكير المحاضرة"] },
} as const;

type RoleKey = keyof typeof roleViews;

function RoleSwitcher() {
  const [role, setRole] = useState<RoleKey>("management");
  const view = roleViews[role];
  return (
    <section className="roles-section section">
      <div className="section-kicker" data-reveal><span>05</span> كل دور له وضوحه</div>
      <div className="roles-heading" data-reveal><h2>كل موظف يشوف اللي يحتاجه.<br /><span>والإدارة تشوف الصورة كلها.</span></h2><p>صلاحيات حسب الدور، وأولوية يومية واضحة، بدون ما تغرق الموظف في شاشات ما تخصّه.</p></div>
      <div className="role-switcher" data-reveal>
        <div className="role-tabs" role="tablist" aria-label="اختر دور الموظف">{(Object.entries(roleViews) as [RoleKey, typeof roleViews[RoleKey]][]).map(([key, item]) => <button key={key} type="button" role="tab" aria-selected={role === key} className={role === key ? "is-active" : ""} onClick={() => setRole(key)}><i /><span>{item.label}</span></button>)}</div>
        <div className="role-screen">
          <div className="role-screen-head"><span><small>مساحة العمل</small><h3>{view.title}</h3></span><em>عرض {view.label}</em></div>
          <div className="role-stats">{view.stats.map(([label, value]) => <article key={label}><small>{label}</small><b>{value}</b><i /></article>)}</div>
          <div className="priority-panel"><div className="card-title"><b>أولويات اليوم</b><span>مرتبة تلقائيًا</span></div>{view.tasks.map((task, index) => <p key={task}><i>{index + 1}</i><span><b>{task}</b><small>{index === 0 ? "تحتاج إجراء الآن" : "اليوم"}</small></span><button type="button">فتح</button></p>)}</div>
        </div>
      </div>
    </section>
  );
}

function SecuritySection({ cms }: { cms: LandingCms }) {
  const defaults = [
    ["عزل بيانات كل منشأة", "مساحة وسياق مستقلان يمنعان اختلاط بيانات منشأة بغيرها."],
    ["صلاحيات حسب الدور", "كل مستخدم يرى وينفذ ما يحتاجه لأداء عمله فقط."],
    ["سجل واضح للأنشطة", "أثر للإجراءات الحساسة يدعم المتابعة والمساءلة."],
    ["مراجعة مستمرة", "ضوابط وصول وتحديثات تتطور مع الخدمة ومتطلباتها."],
  ] as const;
  const cards = defaults.map(([title, description], index) => ({
    title: cmsText(cms.trust?.items?.[index]?.title, LEGACY_TRUST[index][0], title),
    description: cmsText(cms.trust?.items?.[index]?.description, LEGACY_TRUST[index][1], description),
  }));
  const kicker = cmsText(cms.trust?.eyebrow, "حماية ووضوح", "ثقة بدون شعارات مبهمة");
  const title = cmsText(cms.trust?.title, "بيانات منشأتك لا تختلط بغيرها", "بيانات منشأتك تبقى منشأتك.");
  const body = cmsText(cms.trust?.body, "ضوابط عملية للصلاحيات والوصول والمتابعة، دون ادعاءات أو شعارات أمنية مبهمة.", "أودير يضع الصلاحيات والعزل وسجل الأنشطة في صلب التشغيل؛ حتى يصل كل شخص لما يحتاجه فقط، وتبقى الحركة الحساسة قابلة للمراجعة.");
  return (
    <section className="security-section" id="security">
      <div className="security-inner section">
        <div className="security-copy" data-reveal><div className="section-kicker section-kicker--light"><span>06</span> {kicker}</div><h2>{title === "بيانات منشأتك تبقى منشأتك." ? <>بيانات منشأتك<br /><span>تبقى منشأتك.</span></> : title}</h2><p>{body}</p><a href={`${APP_ORIGIN}/p/information-security`}>اقرأ عن أمن المعلومات <ArrowMark /></a></div>
        <div className="security-grid" data-reveal>
          <article><span className="security-icon security-icon--layers"><i /><i /><i /></span><b>{cards[0].title}</b><p>{cards[0].description}</p></article>
          <article><span className="security-icon security-icon--key"><i /></span><b>{cards[1].title}</b><p>{cards[1].description}</p></article>
          <article><span className="security-icon security-icon--history"><i /></span><b>{cards[2].title}</b><p>{cards[2].description}</p></article>
          <article><span className="security-icon security-icon--shield"><i /></span><b>{cards[3].title}</b><p>{cards[3].description}</p></article>
        </div>
        <p className="independence-note">أودير منتج تقني مستقل مصمم لواقع المنشآت التدريبية الأهلية، ولا يمثل جهة اعتماد حكومية.</p>
      </div>
    </section>
  );
}

function FAQ({ cms }: { cms: LandingCms }) {
  const defaults = [
    ["هل أحتاج بطاقة بنكية للتسجيل؟", "لا. يمكنك بدء التسجيل المجاني دون إدخال بطاقة بنكية، ثم تهيئة بيانات المنشأة والفريق بخطوات واضحة."],
    ["هل لازم أنقل كل بياناتي من أول يوم؟", "لا. ابدأ بالمسار الأكثر إلحاحًا عندك، مثل العملاء والمتابعات، ثم وسّع الاستخدام تدريجيًا وفق احتياج منشأتك."],
    ["هل كل موظف يشوف كل شيء؟", "لا. الوصول يعتمد على الدور والصلاحيات التي تحددها المنشأة، ليشاهد كل مستخدم ما يحتاجه فقط."],
    ["هل التكاملات كلها متاحة الآن؟", "نعرض حالة كل تكامل بوضوح داخل الصفحة: متاح، قيد التفعيل، أو قريبًا. لن نصف تكاملًا بأنه متاح قبل جاهزيته للاستخدام."],
    ["هل أقدر أعدل موقع أودير من البيلدر؟", "صفحات الموقع الأساسية والسياسات محفوظة داخل نظام إدارة المحتوى، ويمكن تعديلها ونشرها من بيلدر الموقع حسب الصلاحيات."],
  ] as const;
  const cmsSlots = [0, 1, 2, -1, 3];
  const questions = defaults.map(([question, answer], index) => {
    const cmsIndex = cmsSlots[index];
    if (cmsIndex < 0) return [question, answer] as const;
    return [
      cmsText(cms.faq?.items?.[cmsIndex]?.title, LEGACY_FAQ[cmsIndex][0], question),
      cmsText(cms.faq?.items?.[cmsIndex]?.description, LEGACY_FAQ[cmsIndex][1], answer),
    ] as const;
  });
  const kicker = cmsText(cms.faq?.eyebrow, "أسئلة سريعة", "قبل ما تبدأ");
  const title = cmsText(cms.faq?.title, "قبل أن تبدأ", "أسئلة واضحة. إجابات أوضح.");
  const body = cmsText(cms.faq?.body, "إجابات مباشرة على أكثر الأسئلة شيوعًا.", "بدون شروط مخفية ولا وعود أكبر من المرحلة.");
  return (
    <section className="faq-section section">
      <div className="faq-heading" data-reveal><div className="section-kicker"><span>07</span> {kicker}</div><h2>{title === "أسئلة واضحة. إجابات أوضح." ? <>أسئلة واضحة.<br />إجابات أوضح.</> : title}</h2><p>{body}</p></div>
      <div className="faq-list" data-reveal>{questions.map(([question, answer], index) => <details key={question} open={index === 0}><summary><span>{question}</span><i /></summary><p>{answer}</p></details>)}</div>
    </section>
  );
}

function FinalCTA({ cms, onRegister }: { cms: LandingCms; onRegister: () => void }) {
  const eyebrow = cmsText(cms.cta?.eyebrow, "جاهز للبدء؟", "جاهز تشوف منشأتك بشكل أوضح؟");
  const title = cmsText(cms.cta?.title, "سجّل منشأتك، واترك الباقي لمسار واضح.", "خلّ منشأتك تمشي بنظام واضح من اليوم.");
  const body = cmsText(cms.cta?.body, "ابدأ بالحساب الأساسي، ثم وسّع أودير مع احتياج منشأتك.", "ابدأ مجانًا، أضف فريقك، وشاهد كيف تنتقل رحلة العميل من استفسار متفرق إلى عملية يمكن إدارتها وقياسها.");
  const buttonLabel = cms.cta?.buttonLabel || "سجّل منشأتك مجانًا";
  const buttonHref = cms.cta?.buttonHref || "/free-trial/apply";
  const loginLabel = cms.settings?.customerLoginLabel || "دخول المنشآت";
  const loginHref = cms.settings?.customerLoginUrl || "/login";
  return (
    <section className="final-cta">
      <div className="final-cta-orbit" aria-hidden="true" />
      <div className="final-cta-inner section" data-reveal><div className="eyebrow"><span /> {eyebrow}</div><h2>{title === "خلّ منشأتك تمشي بنظام واضح من اليوم." ? <>خلّ منشأتك تمشي<br /><span>بنظام واضح من اليوم.</span></> : title}</h2><p>{body}</p><div className="hero-actions"><a className="button button--primary" href={`${APP_ORIGIN}${buttonHref}`} onClick={(event) => openRegistrationFromLink(event, buttonHref, onRegister)}>{buttonLabel} <ArrowMark /></a><a className="button button--ghost" href={`${APP_ORIGIN}${loginHref}`}>{loginLabel}</a></div><ul className="hero-trust"><li><i /> بدون بطاقة بنكية</li><li><i /> تبدأ بخطوات بسيطة</li><li><i /> بيانات منشأتك مستقلة</li></ul></div>
    </section>
  );
}

export default function OdeirLandingExperience({ cms = {} }: { cms?: LandingCms }) {
  useReveal();
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [showMobileCta, setShowMobileCta] = useState(false);
  const heroShellRef = useRef<HTMLDivElement>(null);
  const openRegistration = useCallback(() => setRegistrationOpen(true), []);
  const closeRegistration = useCallback(() => setRegistrationOpen(false), []);
  useEffect(() => {
    const hero = heroShellRef.current;
    const finalCta = document.querySelector<HTMLElement>(".odeir-experience .final-cta");
    if (!hero || !("IntersectionObserver" in window)) return;
    let heroVisible = true;
    let finalVisible = false;
    const update = () => setShowMobileCta(!heroVisible && !finalVisible);
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.target === hero) heroVisible = entry.isIntersecting;
        if (entry.target === finalCta) finalVisible = entry.isIntersecting;
      });
      update();
    }, { threshold: 0.06, rootMargin: "-64px 0px 0px 0px" });
    observer.observe(hero);
    if (finalCta) observer.observe(finalCta);
    return () => observer.disconnect();
  }, []);
  return (
    <main className="odeir-experience" dir="rtl">
      <div className="hero-shell" ref={heroShellRef}><Header cms={cms} onRegister={openRegistration} /><Hero cms={cms} onRegister={openRegistration} /></div>
      <MorningBriefing articles={cms.articles} />
      <StoryStrip />
      <ProductDemo />
      <OperationalStories cms={cms} />
      <JourneyLab />
      <RoleSwitcher />
      <SecuritySection cms={cms} />
      <FAQ cms={cms} />
      <FinalCTA cms={cms} onRegister={openRegistration} />
      <footer className="site-footer">
        <div className="footer-brand"><Brand /><p>تشغيل أوضح وإدارة مترابطة للمنشآت التدريبية.</p></div>
        <nav aria-label="روابط السياسات والمحتوى"><a href={`${APP_ORIGIN}/articles`}>الأخبار والمعارف</a><a href={`${APP_ORIGIN}/p/privacy-policy`}>الخصوصية</a><a href={`${APP_ORIGIN}/p/information-security`}>أمن المعلومات</a><a href={`${APP_ORIGIN}/p/terms-of-use`}>شروط الاستخدام</a><a href={`${APP_ORIGIN}/p/data-rights`}>حقوق البيانات</a></nav>
        <span>© {new Date().getFullYear()} أودير. جميع الحقوق محفوظة.</span>
      </footer>
      <a className={showMobileCta ? "mobile-cta is-visible" : "mobile-cta"} href={`${APP_ORIGIN}${cms.hero?.primaryHref || "/free-trial/apply"}`} onClick={(event) => openRegistrationFromLink(event, cms.hero?.primaryHref || "/free-trial/apply", openRegistration)}>{cms.hero?.primaryLabel || "سجّل منشأتك مجانًا"} <ArrowMark /></a>
      <OdeirRegistrationModal open={registrationOpen} onClose={closeRegistration} />
    </main>
  );
}
