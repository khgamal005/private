"use client";
import { useEffect, useMemo, useRef, useState } from "react";
const TRIAL_API = "https://jultamrxwrgzohoktbgr.supabase.co/functions/v1/marktone-free-trial";
const REGISTRATION_API = "/api/public/registration";
const LEGAL_POLICY = Object.freeze({
  policySetVersion: "odeir-legal-2026-08-28-v1",
  termsVersion: "terms-of-use-2026-08-28",
  privacyVersion: "privacy-policy-2026-08-28",
  fairUseVersion: "free-plan-fair-use-2026-08-28",
  presentationVersion: "registration-clickwrap-v1",
  summaryTextHash: "7a911bf6b72684c66cb89a8810e5c3985e8cf0e721d8ed08a37376408e3bc9a8",
  consentTextHash: "b901d6e3b7c00c3c9d4b6af77465d3ffae24de19bb296824cf80339ecb2aa0c4"
});
const LEGAL_CONSENT_TEXT = "أقر بأنني مخوّل بإنشاء حساب هذه المنشأة، وأنني قرأت وأوافق على شروط الاستخدام والاشتراك وسياسة الاستخدام العادل وحدود الخطة المجانية، وأقر بأنني اطلعت على سياسة الخصوصية، بما يشمل مسؤولية إدارة المنشأة، وتعديل حدود الخطة المجانية، وتعليق الخدمة أو إنهاءها، وخيارات تصدير البيانات أو حذفها وفق الوثائق المعتمدة.";
const LEGAL_SUMMARY = [
  ["صلاحية إنشاء الحساب", "أقر بأنني مخوّل بالتصرف باسم المنشأة، وأن بيانات المنشأة ومسؤول الطلب صحيحة ومحدثة."],
  ["مسؤولية مدير المنشأة", "مدير المنشأة مسؤول عن المستخدمين والصلاحيات والمحتوى والبيانات والعمليات والخدمات التي تقدمها المنشأة عبر الحساب."],
  ["بيانات المنشأة", "تحتفظ المنشأة بحقوقها في بياناتها ومحتواها، وتعالجها أودير بالقدر اللازم لتشغيل الخدمة وحمايتها وتطويرها ووفق سياسة الخصوصية."],
  ["الخطة المجانية والاستخدام العادل", "يجوز تحديد أو تعديل عدد المستخدمين أو المساحة أو المزايا أو العمليات أو مدة الاحتفاظ، كما يجوز استبدال الخطة المجانية أو إيقافها وفق الشروط والإشعارات المطبقة."],
  ["الاستخدام المقبول", "يُمنع النشاط غير المشروع أو التحايل على الحدود أو الإضرار بأمن المنصة أو مستخدميها أو إعادة بيع الخدمة دون تصريح."],
  ["التكاملات الخارجية", "تخضع خدمات الأطراف الثالثة لشروط مزوديها وتوافرها، ولا تضمن أودير استمرار ما يخرج عن سيطرتها المعقولة."],
  ["التعليق أو الإنهاء", "يجوز تقييد الخدمة أو تعليقها أو إنهاؤها عند المخالفة أو الخطر الأمني أو عدم السداد أو لأسباب نظامية أو تقنية أو تجارية وفق الشروط والأنظمة."],
  ["الإلغاء وخروج البيانات", "يمكن لمدير المنشأة طلب الإلغاء أو الحذف، وعند الإنهاء يطبق مسار التصدير الآمن أو الحذف النهائي وسياسة الاحتفاظ والنسخ الاحتياطية والالتزامات النظامية."],
  ["توافر الخدمة وحدود المسؤولية", "تقدم الخدمة وفق الإمكانات المتاحة ولا تضمن نتيجة تجارية أو تشغيلية محددة، وتطبق حدود الضمان والمسؤولية الواردة في الشروط بالقدر الذي يسمح به النظام."]
];
const initialForm = {
  institutionName: "",
  commercialRegistration: "",
  nationalRegistration: "",
  tvtcLicenseNumber: "",
  contactName: "",
  contactJobTitle: "",
  contactEmail: "",
  contactPhone: "",
  tvtcAcknowledged: false,
  privacyConsent: false,
  privacyAcknowledged: false,
  termsConsent: false,
  legalConsent: false,
  legalPolicySetVersion: LEGAL_POLICY.policySetVersion,
  termsVersion: LEGAL_POLICY.termsVersion,
  privacyVersion: LEGAL_POLICY.privacyVersion,
  fairUseVersion: LEGAL_POLICY.fairUseVersion,
  legalPresentationVersion: LEGAL_POLICY.presentationVersion,
  legalSummaryTextHash: LEGAL_POLICY.summaryTextHash,
  legalConsentTextHash: LEGAL_POLICY.consentTextHash,
  website: ""
};
const ERROR_COPY = {
  query_too_short: "اكتب 3 أحرف على الأقل أو 5 أرقام من رقم السجل.",
  institution_not_found: "تعذر العثور على هذه المنشأة. جرّب البحث مرة أخرى.",
  rate_limited: "تمت محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.",
  consent_required: "يلزم إكمال الإقرار التنظيمي والموافقة الصريحة على الشروط.",
  legal_consent_required: "راجع البنود حتى النهاية ثم وافق عليها لإتمام إنشاء المنشأة.",
  legal_policy_version_stale: "تغيرت نسخة الشروط أثناء التسجيل. أعد مراجعتها ثم وافق على النسخة الحالية.",
  legal_policy_unavailable: "تعذر تحميل النسخة القانونية المعتمدة لحظيًا. لم تُفقد بياناتك؛ حاول مرة أخرى بعد قليل.",
  invalid_email: "راجع صيغة البريد الإلكتروني.",
  invalid_phone: "راجع رقم الجوال وأدخله بصيغة صحيحة.",
  registration_identifier_invalid: "راجع الرقم الرسمي: السجل التجاري 10 أرقام، والرقم الوطني 10 أرقام يبدأ بـ7.",
  email_configuration_unavailable: "تعذر إرسال رسالة التأكيد الآن. بياناتك لم تُفقد؛ حاول بعد قليل.",
  confirmation_email_failed: "تعذر إرسال رسالة التأكيد الآن. حاول مرة أخرى بعد قليل.",
  confirmation_email_in_progress: "رسالة التأكيد قيد المعالجة. انتظر قليلًا ثم افحص صندوق الوارد، ويمكنك إعادة المحاولة إذا لم تصل.",
  confirmation_email_state_unavailable: "تعذر التحقق من حالة إرسال رسالة التأكيد مؤقتًا. لم تُفقد بياناتك؛ حاول بعد قليل.",
  registration_challenge_invalid: "انتهت مهلة الحماية. أعد إرسال الطلب مرة أخرى.",
  registration_challenge_unavailable: "تعذر تأمين الطلب لحظيًا. حاول مرة أخرى بعد قليل.",
  service_unavailable: "الخدمة غير متاحة لحظيًا. حاول مرة أخرى بعد قليل."
};
function FreeTrialLanding({ registrationOnly = false } = {}) {
  const startedAt = useRef(0);
  const submitLockRef = useRef(false);
  const legalPanelRef = useRef(null);
  const trialCardRef = useRef(null);
  const previousStepRef = useRef("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [isNew, setIsNew] = useState(false);
  const [step, setStep] = useState(
    "search"
  );
  const [form, setForm] = useState(initialForm);
  const [reference, setReference] = useState("");
  const [confirmationRequired, setConfirmationRequired] = useState(false);
  const [confirmationAlreadySent, setConfirmationAlreadySent] = useState(false);
  const [confirmationQueued, setConfirmationQueued] = useState(false);
  const [reviewReceiptQueued, setReviewReceiptQueued] = useState(false);
  const [reviewReceiptAlreadySent, setReviewReceiptAlreadySent] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [searched, setSearched] = useState(false);
  const [legalReviewed, setLegalReviewed] = useState(false);
  const [guideRole, setGuideRole] = useState(0);
  useEffect(() => {
    startedAt.current = Date.now();
  }, []);
  const activeStep = useMemo(() => {
    if (step === "success" || step === "agreement") return 5;
    if (step === "regulatory") return 4;
    if (step === "form") return 3;
    if (step === "details") return 2;
    return 1;
  }, [step]);
  useEffect(() => {
    if (step !== "agreement") return;
    setLegalReviewed(false);
    setForm((current) => ({
      ...current,
      privacyConsent: false,
      privacyAcknowledged: false,
      termsConsent: false,
      legalConsent: false
    }));
    const frame = window.requestAnimationFrame(() => {
      const panel = legalPanelRef.current;
      if (!panel) return;
      panel.scrollTop = 0;
      if (panel.scrollHeight <= panel.clientHeight + 12) setLegalReviewed(true);
    });
    const reviewWhenEverythingFits = () => {
      const panel = legalPanelRef.current;
      if (panel && panel.scrollHeight <= panel.clientHeight + 12) setLegalReviewed(true);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(reviewWhenEverythingFits);
    if (legalPanelRef.current) observer?.observe(legalPanelRef.current);
    window.addEventListener("resize", reviewWhenEverythingFits);
    document.fonts?.ready.then(reviewWhenEverythingFits).catch(() => {});
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", reviewWhenEverythingFits);
    };
  }, [step]);
  useEffect(() => {
    if (previousStepRef.current === step) return;
    previousStepRef.current = step;
    const heading = trialCardRef.current?.querySelector(".trial-body h2");
    if (!(heading instanceof HTMLElement)) return;
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }, [step]);
  const manualExisting = step === "success" && !confirmationRequired && !isNew;
  async function callApi(payload) {
    const response = await fetch(payload.action === "submit" ? REGISTRATION_API : TRIAL_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, startedAt: startedAt.current })
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || !value.ok) {
      throw new Error(value.error || "service_unavailable");
    }
    return value;
  }
  async function requestRegistrationChallenge() {
    const bootstrapResponse = await fetch(REGISTRATION_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "challenge_bootstrap" }),
      credentials: "same-origin",
      cache: "no-store"
    });
    const bootstrap = await bootstrapResponse.json().catch(() => ({}));
    if (!bootstrapResponse.ok || bootstrap.ok !== true || typeof bootstrap.endpoint !== "string" || typeof bootstrap.publishableKey !== "string") {
      throw new Error("registration_challenge_unavailable");
    }
    let endpoint;
    try {
      endpoint = new URL(bootstrap.endpoint);
    } catch {
      throw new Error("registration_challenge_unavailable");
    }
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".supabase.co") || !endpoint.pathname.endsWith("/odeir-registration-intake")) {
      throw new Error("registration_challenge_unavailable");
    }
    const challengeResponse = await fetch(endpoint.toString(), {
      method: "POST",
      headers: {
        apikey: bootstrap.publishableKey,
        "content-type": "application/json"
      },
      body: JSON.stringify({ action: "challenge" }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer"
    });
    const challengeResult = await challengeResponse.json().catch(() => ({}));
    if (!challengeResponse.ok || challengeResult.ok !== true || typeof challengeResult.challenge !== "string" || challengeResult.challenge.length < 120) {
      throw new Error(challengeResult.error || "registration_challenge_unavailable");
    }
    return challengeResult.challenge;
  }
  async function search(event) {
    event.preventDefault();
    setBusy("search");
    setError("");
    setSelected(null);
    try {
      const value = await callApi({ action: "search", query });
      setResults(value.results || []);
      setSearched(true);
    } catch (caught) {
      setResults([]);
      setSearched(true);
      setError(messageFor(caught));
    } finally {
      setBusy("");
    }
  }
  async function choose(result) {
    setBusy("details");
    setError("");
    try {
      const value = await callApi({ action: "details", accountId: result.id });
      const institution = value.institution;
      setSelected(institution);
      setIsNew(false);
      setForm((current) => ({
        ...current,
        institutionName: institution.name || "",
        tvtcAcknowledged: false,
        privacyConsent: false,
        privacyAcknowledged: false,
        termsConsent: false,
        legalConsent: false
      }));
      setLegalReviewed(false);
      setStep("details");
      document.getElementById("trial-card")?.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy("");
    }
  }
  function startNew() {
    setSelected(null);
    setIsNew(true);
    setForm(initialForm);
    setStep("form");
    setError("");
    document.getElementById("trial-card")?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
  function continueToRegulatory(event) {
    event.preventDefault();
    setError("");
    setStep("regulatory");
    document.getElementById("trial-card")?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
  function continueToAgreement() {
    if (!form.tvtcAcknowledged) {
      setError("يلزم قراءة الإقرار التنظيمي وتأكيد صحة حالة المنشأة.");
      return;
    }
    setError("");
    setLegalReviewed(false);
    setForm((current) => ({
      ...current,
      privacyConsent: false,
      privacyAcknowledged: false,
      termsConsent: false,
      legalConsent: false
    }));
    setStep("agreement");
    document.getElementById("trial-card")?.scrollIntoView({
      behavior: "smooth",
      block: "center"
    });
  }
  function reviewLegalScroll(event) {
    const panel = event.currentTarget;
    if (panel.scrollHeight - panel.scrollTop - panel.clientHeight <= 12) {
      setLegalReviewed(true);
    }
  }
  function updateLegalConsent(value) {
    setForm((current) => ({
      ...current,
      privacyConsent: value,
      privacyAcknowledged: value,
      termsConsent: value,
      legalConsent: value
    }));
  }
  async function submit(event) {
    event.preventDefault();
    if (submitLockRef.current) return;
    if (!legalReviewed || !form.legalConsent || !form.termsConsent || !form.privacyConsent || !form.privacyAcknowledged) {
      setError(ERROR_COPY.legal_consent_required);
      return;
    }
    submitLockRef.current = true;
    setBusy("submit");
    setError("");
    try {
      const challenge = await requestRegistrationChallenge();
      const value = await callApi({
        action: "submit",
        challenge,
        institutionState: isNew ? "new" : "existing",
        accountId: selected?.id || null,
        legalSummaryReviewed: legalReviewed,
        ...form
      });
      setReference(value.reference || "");
      setConfirmationRequired(value.confirmationRequired === true);
      setConfirmationAlreadySent(value.confirmationAlreadySent === true);
      setConfirmationQueued(value.confirmationQueued === true);
      setReviewReceiptQueued(value.reviewReceiptQueued === true);
      setReviewReceiptAlreadySent(value.reviewReceiptAlreadySent === true);
      setStep("success");
    } catch (caught) {
      if (caught instanceof Error && caught.message === "legal_policy_version_stale") {
        setLegalReviewed(false);
        updateLegalConsent(false);
      }
      setError(messageFor(caught));
    } finally {
      submitLockRef.current = false;
      setBusy("");
    }
  }
  function update(key, value) {
    const materialRegistrationFields = new Set([
      "institutionName", "commercialRegistration", "nationalRegistration",
      "tvtcLicenseNumber", "contactName", "contactJobTitle", "contactEmail",
      "contactPhone"
    ]);
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(materialRegistrationFields.has(key) ? { tvtcAcknowledged: false } : {})
    }));
  }
  return <main dir="rtl" className={registrationOnly ? "free-trial-route site-shell registration-only" : "free-trial-route site-shell"}>
      {!registrationOnly && <header className="site-header">
        <a className="brand" href="/" aria-label="أودير - الصفحة الرئيسية">
          <span className="brand-mark">O</span>
          <span>
            <b>أودير <em className="flow-name">ODEIR</em></b>
            <small>منصة إدارة المنشآت</small>
          </span>
        </a>
        <nav aria-label="التنقل الرئيسي">
          <a href="/">الرئيسية</a>
          <a href="#platform">لماذا أودير؟</a>
          <a href="#journey">رحلة العمل</a>
          <a href="#modules">المزايا</a>
          <a href="#guide">دليل وظيفتي</a>
          <a className="login-link" href="/login">
            تسجيل الدخول
          </a>
        </nav>
      </header>}

      <section id="top" className={registrationOnly ? "hero registration-only-hero" : "hero"}>
        {!registrationOnly && <div className="hero-copy">
          <span className="eyebrow"><SparkIcon /> صُمم خصيصًا لمنشآت التدريب في السعودية</span>
          <div className="product-name" aria-label="منصة أودير">
            <span>ODEIR</span><b>ONE</b><i>منصة التشغيل والإدارة</i>
          </div>
          <h1>
            من أول إعلان إلى متدرب مسجّل.
            <span>كل الرحلة في مسار واحد.</span>
          </h1>
          <p className="hero-lead">
            أودير يوحّد التسويق والمبيعات والتسجيل والدورات والفوترة والتقارير،
            ويجعل كل موظف يعرف مهمته التالية دون أن يضيع عميل أو تتكرر البيانات.
          </p>
          <div className="trust-row">
            <span><ShieldIcon /> تجربة آمنة ببيانات مقنّعة</span>
            <span><UsersIcon /> صلاحيات حسب كل دور</span>
            <span><ClockIcon /> تجهيز خلال يوم عمل</span>
          </div>
          <div className="hero-note">
            <span>14</span>
            <div><b>يومًا للتجربة</b><small>بدون بطاقة بنكية أو التزام</small></div>
          </div>
        </div>}

        <section ref={trialCardRef} id="trial-card" className="trial-card" aria-label="تسجيل منشأة في أودير">
          <div className="stepper" aria-label={`الخطوة ${activeStep} من 5`}>
            {["ابحث", "تأكد", "بياناتك", "الإقرار", "الموافقة"].map((label, index) => <div key={label} aria-current={step !== "success" && activeStep === index + 1 ? "step" : undefined} className={activeStep >= index + 1 ? "step active" : "step"}>
                <i>{step === "success" || activeStep > index + 1 ? "✓" : index + 1}</i>
                <span>{label}</span>
              </div>)}
          </div>

          {step === "search" && <div className="trial-body">
              <div className="card-heading">
                <span className="heading-icon"><SearchIcon /></span>
                <div><small>الخطوة الأولى</small><h2>اعثر على منشأتك</h2></div>
              </div>
              <p className="card-subtitle">
                اكتب الرقم الوطني الموحد، رقم السجل التجاري، أو اسم المركز أو المعهد.
              </p>
              <form className="search-form" onSubmit={search}>
                <label htmlFor="institution-search">بيانات المنشأة</label>
                <div className="search-control">
                  <SearchIcon />
                  <input
    id="institution-search"
    value={query}
    onChange={(event) => setQuery(event.target.value)}
    placeholder="مثال: مركز الأفق للتدريب"
    autoComplete="organization"
  />
                  <button disabled={busy === "search"}>
                    {busy === "search" ? <Spinner /> : "بحث"}
                  </button>
                </div>
              </form>

              {error && <div className="alert error" role="alert">{error}</div>}

              {results.length > 0 && <div className="results" aria-live="polite">
                  <div className="results-head">
                    <b>النتائج الأقرب</b>
                    <span>{results.length.toLocaleString("ar-SA")} منشآت</span>
                  </div>
                  {results.map((result) => <button
    type="button"
    key={result.id}
    className="result-item"
    onClick={() => choose(result)}
    disabled={busy === "details"}
  >
                      <span className="result-avatar">{result.name?.trim().charAt(0)}</span>
                      <span className="result-copy">
                        <b>{result.name}</b>
                        <small>{[result.type, result.city].filter(Boolean).join(" • ")}</small>
                        <em>{result.regulatoryStatus || "سجل منشأة متاح"}</em>
                      </span>
                      <span className="result-action">
                        {busy === "details" ? "جارٍ الفتح…" : "اختيار"}<ArrowIcon />
                      </span>
                    </button>)}
                </div>}

              {searched && !results.length && !error && <div className="empty-result">
                  <span>لم نجد منشأة مطابقة</span>
                  <p>راجع الاسم أو الرقم، أو أرسل طلب إضافة منشأة جديدة.</p>
                </div>}

              <button type="button" className="new-institution" onClick={startNew}>
                <span><PlusIcon /></span>
                <span><b>منشأتك جديدة أو غير موجودة؟</b><small>أضفها للمراجعة وابدأ التسجيل المجاني</small></span>
                <ArrowIcon />
              </button>
              <p className="privacy-line"><LockIcon /> لا نعرض بيانات اتصال كاملة قبل التحقق من ملكية المنشأة.</p>
            </div>}

          {step === "details" && selected && <div className="trial-body">
              <div className="card-heading">
                <span className="heading-icon success"><CheckIcon /></span>
                <div><small>تم العثور على المنشأة</small><h2>تأكد من بياناتها</h2></div>
              </div>
              <article className="institution-card">
                <header>
                  <span className="institution-logo">{selected.name?.trim().charAt(0)}</span>
                  <div><h3>{selected.name}</h3><p>{[selected.type, selected.city].filter(Boolean).join(" • ")}</p></div>
                  <em>{selected.regulatoryStatus || "بيانات رسمية"}</em>
                </header>
                <dl>
                  <ReadOnlyField label="البريد الرسمي" value={selected.officialEmail} />
                  <ReadOnlyField label="هاتف المنشأة" value={selected.officialPhone} />
                  <ReadOnlyField label="السجل التجاري" value={selected.commercialRegistration} />
                  <ReadOnlyField label="الرقم الوطني" value={selected.nationalRegistration} />
                </dl>
                {selected.responsible ? <div className="responsible-card">
                    <span><UserIcon /></span>
                    <div><small>المسؤول المسجل</small><b>{selected.responsible.name}</b><p>{selected.responsible.jobTitle}</p></div>
                    <div className="responsible-contact"><span>{selected.responsible.email || "غير متاح"}</span><span>{selected.responsible.phone || "غير متاح"}</span></div>
                  </div> : <div className="responsible-missing">
                    <InfoIcon /> لا يوجد مسؤول معتمد في السجل بعد؛ سنأخذ بياناتك للمراجعة.
                  </div>}
                <footer><DatabaseIcon /><span>سجل المنشآت في أودير</span><i>قراءة فقط</i></footer>
              </article>
              <div className="alert info"><ShieldIcon /> البيانات الحساسة مقنّعة لحماية المنشأة، وسيتم التحقق منها عند مراجعة الطلب.</div>
              <div className="form-actions">
                <button className="secondary-button" onClick={() => setStep("search")}>ليست منشأتي</button>
                <button className="primary-button" onClick={() => setStep("form")}>هذه منشأتي — متابعة <ArrowIcon /></button>
              </div>
            </div>}

          {step === "form" && <form className="trial-body contact-form" onSubmit={continueToRegulatory}>
              <div className="card-heading">
                <span className="heading-icon"><UserIcon /></span>
                <div><small>بيانات مسؤول الطلب</small><h2>{isNew ? "أضف منشأة جديدة" : "جهّز حساب منشأتك"}</h2></div>
              </div>
              {isNew && <div className="field-grid">
                  <Field label="اسم المنشأة الرسمي" required value={form.institutionName} onChange={(value) => update("institutionName", value)} placeholder="اسم المركز أو المعهد" />
                  <Field label="رقم ترخيص التدريب إن وجد" value={form.tvtcLicenseNumber} onChange={(value) => update("tvtcLicenseNumber", value)} placeholder="رقم ترخيص TVTC" />
                  <Field label="السجل التجاري" value={form.commercialRegistration} onChange={(value) => update("commercialRegistration", value)} placeholder="10 أرقام" inputMode="numeric" />
                  <Field label="الرقم الوطني الموحد" value={form.nationalRegistration} onChange={(value) => update("nationalRegistration", value)} placeholder="رقم المنشأة" inputMode="numeric" />
                </div>}
              {!isNew && selected && <div className="selected-strip">
                  <span>{selected.name?.charAt(0)}</span><div><small>المنشأة المختارة</small><b>{selected.name}</b></div>
                  <button type="button" onClick={() => setStep("search")}>تغيير</button>
                </div>}
              <div className="field-grid">
                <Field label="اسم المسؤول" required value={form.contactName} onChange={(value) => update("contactName", value)} placeholder="الاسم الثلاثي" autoComplete="name" />
                <Field label="المسمى الوظيفي" required value={form.contactJobTitle} onChange={(value) => update("contactJobTitle", value)} placeholder="مثال: مدير المركز" autoComplete="organization-title" />
                <Field label="البريد المهني" required type="email" value={form.contactEmail} onChange={(value) => update("contactEmail", value)} placeholder="name@company.sa" autoComplete="email" />
                <Field label="رقم الجوال" required value={form.contactPhone} onChange={(value) => update("contactPhone", value)} placeholder="05XXXXXXXX" inputMode="tel" autoComplete="tel" />
              </div>
              <label className="honeypot" aria-hidden="true">الموقع<input tabIndex={-1} autoComplete="off" value={form.website} onChange={(event) => update("website", event.target.value)} /></label>
              {error && <div className="alert error" role="alert">{error}</div>}
              <div className="form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep(isNew ? "search" : "details")}>رجوع</button>
                <button className="primary-button">مراجعة الإقرار التنظيمي <ArrowIcon /></button>
              </div>
            </form>}

          {step === "regulatory" && <div className="trial-body regulatory-stage">
              <div className="card-heading">
                <span className="heading-icon"><BuildingIcon /></span>
                <div><small>الخطوة الرابعة</small><h2>الإقرار التنظيمي</h2></div>
              </div>
              <p className="card-subtitle">راجع المنشأة ومسؤول الطلب، ثم أكد صحة حالتها قبل الانتقال إلى الشروط.</p>
              <dl className="request-review-card">
                <div><dt>المنشأة</dt><dd>{form.institutionName || selected?.name}</dd></div>
                <div><dt>مسؤول الطلب</dt><dd>{form.contactName}</dd></div>
                <div><dt>المسمى الوظيفي</dt><dd>{form.contactJobTitle}</dd></div>
                <div><dt>البريد المهني</dt><dd dir="ltr">{form.contactEmail}</dd></div>
              </dl>
              <div className="tvtc-notice">
                <span className="notice-icon"><BuildingIcon /></span>
                <div>
                  <b>تنبيه تنظيمي مهم</b>
                  <p>لمزاولة نشاط التدريب في المملكة العربية السعودية يجب أن تكون المنشأة مرخصة ومسجلة لدى المؤسسة العامة للتدريب التقني والمهني متى كان ذلك منطبقًا على نشاطها.</p>
                  <label><input type="checkbox" checked={form.tvtcAcknowledged} onChange={(event) => update("tvtcAcknowledged", event.target.checked)} /><span>قرأت التنبيه، وأقر بصحة حالة المنشأة والبيانات المقدمة.</span></label>
                </div>
              </div>
              {error && <div className="alert error" role="alert">{error}</div>}
              <div className="form-actions">
                <button type="button" className="secondary-button" onClick={() => setStep("form")}>تعديل البيانات</button>
                <button type="button" className="primary-button" disabled={!form.tvtcAcknowledged} onClick={continueToAgreement}>متابعة إلى الموافقة <ArrowIcon /></button>
              </div>
            </div>}

          {step === "agreement" && <form className="trial-body legal-stage" onSubmit={submit} aria-busy={busy === "submit"}>
              <div className="card-heading">
                <span className="heading-icon"><ShieldIcon /></span>
                <div><small>الخطوة الخامسة والأخيرة</small><h2>راجع الشروط وأنشئ منشأتك</h2></div>
              </div>
              <div className="legal-intro">
                <LockIcon />
                <p><b>إنشاء المنشأة لا يرتب اشتراكًا مدفوعًا تلقائيًا.</b><span>الخطة المجانية تخضع لضوابط وحدود الاستخدام المعتمدة، وقد تتغير وفق الإشعارات والشروط.</span></p>
              </div>
              <section
                ref={legalPanelRef}
                className="legal-scroll"
                tabIndex={0}
                aria-label="ملخص شروط استخدام أودير"
                onScroll={reviewLegalScroll}
              >
                <header>
                  <span><small>نسخة السياسات</small><b>28 أغسطس 2026</b></span>
                  <em>ملخص واجب المراجعة</em>
                </header>
                <ol className="legal-points">
                  {LEGAL_SUMMARY.map(([title, description], index) => <li key={title}>
                      <i>{index + 1}</i>
                      <span><b>{title}</b><p>{description}</p></span>
                    </li>)}
                </ol>
                <div className="legal-summary-note">
                  <ShieldIcon />
                  <p><b>هذا ملخص لأهم البنود ولا يستبدل الوثائق الكاملة.</b><span>عند وجود تعارض، تسري النسخة المنشورة من الوثائق التي وافقت عليها.</span></p>
                </div>
              </section>
              <div className="legal-links" aria-label="الوثائق القانونية الكاملة">
                <a href="/p/terms-of-use" target="_blank" rel="noreferrer">شروط الاستخدام والاشتراك</a>
                <a href="/p/privacy-policy" target="_blank" rel="noreferrer">سياسة الخصوصية</a>
                <a href="/p/terms-of-use#free-plan" target="_blank" rel="noreferrer">حدود الخطة المجانية</a>
              </div>
              <p className={`legal-review-hint${legalReviewed ? " is-complete" : ""}`} role="status">
                {legalReviewed ? "وصلت إلى نهاية الملخص؛ يمكنك الآن تحديد الموافقة." : "انتقل إلى نهاية البنود لتفعيل الموافقة."}
              </p>
              <label className={`legal-consent${legalReviewed ? " is-ready" : ""}`}>
                <input
                  type="checkbox"
                  required
                  aria-describedby="legal-evidence"
                  disabled={!legalReviewed || busy === "submit"}
                  checked={form.legalConsent}
                  onChange={(event) => updateLegalConsent(event.target.checked)}
                />
                <span>{LEGAL_CONSENT_TEXT}</span>
              </label>
              <p id="legal-evidence" className="legal-evidence-note"><LockIcon /> بالضغط على الزر، تُسجّل موافقتك إلكترونيًا مع وقت الخادم ونسخة الوثائق المعتمدة وقت الإنشاء.</p>
              {error && <div className="alert error policy-error" role="alert">
                  <span>{error}</span>
                  {error === ERROR_COPY.legal_policy_version_stale && <button type="button" className="policy-refresh" onClick={() => window.location.reload()}>تحميل النسخة الحالية</button>}
                </div>}
              <div className="form-actions legal-actions">
                <button type="button" className="secondary-button" disabled={busy === "submit"} onClick={() => setStep("regulatory")}>العودة</button>
                <button type="submit" className="primary-button" disabled={busy === "submit" || !legalReviewed || !form.legalConsent}>
                  {busy === "submit" ? <><Spinner /> جاري إرسال طلبك بأمان…</> : <>أوافق وأرسل طلب إنشاء منشأتي <ArrowIcon /></>}
                </button>
              </div>
            </form>}

          {step === "success" && <div className={`trial-body success-state${confirmationRequired ? " email-confirmation" : ""}`} role="status" aria-live="polite">
              <span className="success-orbit"><CheckIcon /></span>
              <small>{confirmationRequired
                ? confirmationAlreadySent
                  ? "تم حفظ طلبك ورسالة التأكيد مقبولة للإرسال"
                  : "تم حفظ طلبك ووضع رسالة التأكيد في مسار الإرسال"
                :isNew
                  ?"تم استلام طلبك بنجاح"
                  :reviewReceiptAlreadySent
                    ?"تم حفظ الطلب وإرسال إشعار الاستلام"
                    :reviewReceiptQueued
                      ?"تم حفظ الطلب ووضع إشعار الاستلام في طابور البريد"
                      :"تم حفظ طلب المنشأة للمراجعة"}</small>
              <h2>{manualExisting?'طلبك محفوظ ومسار التفعيل محمي':'تم استلام طلب إنشاء منشأتك'}</h2>
              <p>{confirmationRequired
                ? `${confirmationAlreadySent ? "افحص بريدك؛ مزود البريد قبل الرسالة للإرسال." : confirmationQueued ? "ستُرسل رسالة التأكيد تلقائيًا، ويمكن للنظام استكمالها بعد أي انقطاع مؤقت." : "افحص بريدك خلال دقائق قليلة."} بعد التأكيد تتفعّل مساحة مستقلة وفق الباقة المحددة، وتعمل بصورة طبيعية بينما نراجع موثوقية المنشأة.`
                :!manualExisting
                  ?"ظهر طلبك مباشرة لفريق المراجعة. سنراجع هوية المنشأة ثم نعتمد الطلب ونجهز مساحتها دون وعد برسالة تفعيل تلقائية."
                  :`${reviewReceiptAlreadySent?"أرسلنا":"سنرسل"} إلى بريدك إشعار استلام بلا رابط تفعيل. يراجع الفريق المطابقة، وبعد الاعتماد والتفعيل يرسل النظام دعوة المالك الآمنة تلقائيًا.`}</p>
              <div className="reference-box"><span>رقم الطلب</span><b>{reference}</b><small>احتفظ به للمتابعة</small></div>
              <div className="next-steps">
                {confirmationRequired ? <>
                  <span><i>1</i><b>أكد البريد</b><small>من الرسالة فور وصولها</small></span>
                  <span><i>2</i><b>تفعيل فوري</b><small>مساحة مستقلة تعمل مباشرة</small></span>
                  <span><i>3</i><b>مراجعة الموثوقية</b><small>دون تعطيل وظائف الباقة</small></span>
                </> :manualExisting ? <>
                  <span><i>1</i><b>إشعار الاستلام</b><small>بريد بلا رابط تفعيل</small></span>
                  <span><i>2</i><b>مطابقة واعتماد</b><small>التحقق من السجل والهوية</small></span>
                  <span><i>3</i><b>دعوة المالك</b><small>تُرسل تلقائيًا بعد التفعيل</small></span>
                </> : <>
                  <span><i>1</i><b>مراجعة المنشأة</b><small>مطابقة البيانات الرسمية</small></span>
                  <span><i>2</i><b>اعتماد الطلب</b><small>قرار موثّق من الفريق</small></span>
                  <span><i>3</i><b>تجهيز المساحة</b><small>أدوار ودليل تفاعلي</small></span>
                </>}
              </div>
              <button className="secondary-button" onClick={() => {
    setStep("search");
    setResults([]);
    setSelected(null);
    setReference("");
    setConfirmationRequired(false);
    setConfirmationAlreadySent(false);
    setConfirmationQueued(false);
    setReviewReceiptQueued(false);
    setReviewReceiptAlreadySent(false);
    setLegalReviewed(false);
    setForm(initialForm);
  }}>طلب آخر</button>
            </div>}
        </section>
      </section>

      {!registrationOnly && <>
      <section className="fit-strip" aria-label="مزايا أساسية">
        <div><span><LanguageIcon /></span><b>عربي من الأساس</b><small>واجهة واتجاه عمل يناسب فريقك</small></div>
        <div><span><BuildingIcon /></span><b>متخصص في التدريب</b><small>ليس CRM عامًا يحتاج إعادة اختراع</small></div>
        <div><span><FlowIcon /></span><b>رحلة واحدة مترابطة</b><small>من الإعلان حتى تشغيل الدفعة</small></div>
        <div><span><ShieldIcon /></span><b>صلاحيات دقيقة</b><small>كل موظف يرى ما يخص دوره</small></div>
      </section>

      <section id="platform" className="platform-section">
        <div className="platform-copy">
          <span className="section-kicker">لماذا أودير؟</span>
          <h2>المشكلة ليست في نقص التطبيقات.<br />المشكلة أن رحلة العميل مقطّعة.</h2>
          <p>
            إعلان في منصة، عميل في ملف، متابعة في واتساب، فاتورة في نظام آخر،
            وتقرير يُجمع آخر الشهر. النتيجة: فرص تضيع وإدارة لا ترى الصورة كاملة.
          </p>
          <div className="friction-list">
            <span><i>01</i><b>لا عميل بلا مسؤول</b><small>إسناد واضح وموعد متابعة إلزامي</small></span>
            <span><i>02</i><b>لا مهمة بلا نتيجة</b><small>كل تسليم موثق بين الأدوار</small></span>
            <span><i>03</i><b>لا قرار بلا رقم</b><small>مصدر موحد للمبيعات والأداء</small></span>
          </div>
        </div>
        <div className="flow-map" aria-label="رحلة البيانات الموحدة">
          <div className="flow-map-head">
            <span className="live-dot" />
            <div><small>ODEIR</small><b>مركز تشغيل المنشأة</b></div>
            <em>متصل</em>
          </div>
          <div className="flow-lanes">
            <span><i><MegaphoneIcon /></i><b>الحملات</b><small>المصدر والتكلفة</small></span>
            <span><i><UsersIcon /></i><b>المبيعات</b><small>التوزيع والمتابعة</small></span>
            <span><i><WalletIcon /></i><b>التحصيل</b><small>الدفع والفاتورة</small></span>
            <span><i><GraduationIcon /></i><b>التدريب</b><small>التسجيل والدفعة</small></span>
          </div>
          <div className="flow-map-result">
            <span><ChartIcon /></span>
            <div><small>صورة لحظية موحّدة</small><b>من أين جاء العميل؟ ومن حوّله؟ وماذا حدث بعد الدفع؟</b></div>
          </div>
        </div>
      </section>

      <section className="product-section">
        <div className="section-heading wide-heading">
          <span>ترى العمل كما يحدث</span>
          <h2>لوحة قيادة لا تكتفي بعرض الأرقام؛ بل تقود الإجراء التالي</h2>
          <p>كل بطاقة قابلة للفتح، وكل مؤشر يقود لتفاصيله، وكل رقم مرتبط بسجل حقيقي داخل رحلة العمل.</p>
        </div>
        <div className="product-window" aria-label="معاينة توضيحية للوحة أودير">
          <aside className="preview-sidebar">
            <div className="preview-brand"><span>O</span><b>ODEIR</b></div>
            {[
    ["لوحة القيادة", "active"],
    ["تقويم المهام", ""],
    ["المبيعات والعملاء", ""],
    ["التسجيل والقبول", ""],
    ["البرامج والدورات", ""],
    ["التقارير والتحليل", ""]
  ].map(([label, className]) => <span key={label} className={className}><i />{label}</span>)}
            <small>بيانات توضيحية</small>
          </aside>
          <div className="preview-main">
            <header className="preview-header">
              <div><small>الثلاثاء، 4 أغسطس</small><b>صباح الخير، ياسمين</b></div>
              <div className="preview-profile"><span>3</span><i>ي</i></div>
            </header>
            <div className="preview-title"><div><small>نظرة تشغيلية موحدة</small><h3>لوحة قيادة المبيعات</h3></div><button>آخر 30 يومًا</button></div>
            <div className="preview-kpis">
              <span><small>عملاء جدد</small><b>186</b><em>↑ 12%</em></span>
              <span><small>مهتم جدًا</small><b>42</b><em>22.5%</em></span>
              <span><small>بانتظار الدفع</small><b>19</b><em>جاهزون للمتابعة</em></span>
              <span><small>مبيعات محققة</small><b>78,430 <i>ر.س</i></b><em>↑ 8.4%</em></span>
            </div>
            <div className="preview-panels">
              <article className="pipeline-panel">
                <header><div><small>مسار التحويل</small><b>من العميل إلى التسجيل</b></div><span>تفاصيل</span></header>
                <div className="pipeline-bars">
                  <span style={{ "--bar": "92%" }}><i>186</i><b>جديد</b></span>
                  <span style={{ "--bar": "67%" }}><i>124</i><b>تم التواصل</b></span>
                  <span style={{ "--bar": "38%" }}><i>42</i><b>مهتم جدًا</b></span>
                  <span style={{ "--bar": "21%" }}><i>19</i><b>بانتظار الدفع</b></span>
                  <span style={{ "--bar": "14%" }}><i>13</i><b>مسجّل</b></span>
                </div>
              </article>
              <article className="today-panel">
                <header><div><small>يتطلب إجراء</small><b>مهام اليوم</b></div><em>7 مهام</em></header>
                <span><i className="urgent" /><div><b>متابعة دفعة PMP</b><small>3 عملاء بانتظار رابط الدفع</small></div><em>10:30</em></span>
                <span><i /><div><b>اعتماد توزيع العملاء</b><small>حملة Google — الرياض</small></div><em>12:00</em></span>
                <span><i /><div><b>مراجعة ملفات التسجيل</b><small>دفعة Power BI المسائية</small></div><em>14:15</em></span>
              </article>
            </div>
          </div>
        </div>
        <p className="preview-disclaimer"><InfoIcon /> الأرقام والبيانات في المعاينة توضيحية؛ تجربتك تُجهز وفق هيكل منشأتك وصلاحيات فريقك.</p>
      </section>

      <section id="journey" className="journey-section">
        <div className="section-heading">
          <span>رحلة لا تنقطع</span>
          <h2>ست محطات. سجل واحد للعميل. مسؤول واضح في كل خطوة.</h2>
          <p>بدل أن يبدأ كل قسم من الصفر، تنتقل المعلومة والمهمة والسياق تلقائيًا إلى الدور التالي.</p>
        </div>
        <div className="journey-track">
          {[
    ["01", "جذب العميل", "توثيق الحملة والمصدر والدورة المطلوبة", <MegaphoneIcon key="campaign" />],
    ["02", "التوزيع", "إسناد عادل أو مخصص مع موعد إنجاز", <UsersIcon key="distribution" />],
    ["03", "المتابعة", "مكالمات وملاحظات ونتيجة وخطوة تالية", <ClockIcon key="follow-up" />],
    ["04", "الدفع", "تأكيد التحصيل وإنشاء مستند مالي", <WalletIcon key="payment" />],
    ["05", "التسجيل", "استكمال الملف وربط البرنامج والدفعة", <FlowIcon key="registration" />],
    ["06", "القياس", "أداء الفريق والتحويل والعائد في تقرير واحد", <ChartIcon key="analytics" />]
  ].map(([number, title, text, icon]) => <article key={number}>
              <header><span>{icon}</span><i>{number}</i></header>
              <h3>{title}</h3><p>{text}</p>
            </article>)}
        </div>
      </section>

      <section id="modules" className="modules-section">
        <div className="section-heading light-heading">
          <span>منظومة واحدة بدل جزر منفصلة</span>
          <h2>كل ما يحتاجه المركز لينمو ويعمل بانضباط</h2>
          <p>تبدأ بما تحتاجه اليوم، وتفعّل بقية الوحدات عندما يتوسع فريقك أو تتغير رحلة العمل.</p>
        </div>
        <div className="module-grid">
          <ModuleCard className="module-sales" eyebrow="CRM متخصص" title="المبيعات والعملاء" text="توزيع العملاء، لوحة كانبان، المتابعات، جودة العميل، الأهداف والحوافز." icon={<UsersIcon />} tags={["توزيع ذكي", "متابعة إلزامية", "أهداف الفريق"]} />
          <ModuleCard eyebrow="كل يوم واضح" title="المهام والتقويم" text="تقويم موحد، مواعيد نهائية، تنبيهات، وتسليم موثق بين الموظفين." icon={<ClockIcon />} tags={["مهام اليوم", "تنبيهات", "قياس الالتزام"]} />
          <ModuleCard eyebrow="من الدفع للدفعة" title="التسجيل والقبول" text="نقل العميل المدفوع، استكمال المستندات، وربطه بالدورة والمجموعة الصحيحة." icon={<GraduationIcon />} tags={["ملف المتدرب", "حالة التسجيل"]} />
          <ModuleCard className="module-marketing" eyebrow="قرار مبني على العائد" title="الحملات والتسويق" text="ربط المصدر بالحملة والعميل والمبيعات لمعرفة التكلفة والعائد الفعلي، لا عدد النقرات فقط." icon={<MegaphoneIcon />} tags={["UTM", "ROAS", "تحويلات فعلية"]} />
          <ModuleCard eyebrow="إدارة المحتوى والبيع" title="البرامج والموقع" text="إدارة الدورات والأسعار والعروض وصفحات الموقع من مصدر موحد قابل للتكامل." icon={<StoreIcon />} tags={["دورات", "صفحات", "عروض"]} />
          <ModuleCard eyebrow="رؤية الإدارة" title="التقارير والتحليل" text="مؤشرات حسب الدور والفترة والفرع، مع الانتقال من الرقم إلى تفاصيله." icon={<ChartIcon />} tags={["أداء الموظف", "التحويل", "المصادر"]} />
          <ModuleCard eyebrow="ضبط وحوكمة" title="الفريق والصلاحيات" text="أدوار مفهومة بالمسميات الوظيفية، وبيانات لا تظهر إلا لمن يحتاجها." icon={<ShieldIcon />} tags={["أدوار", "فرق", "سجل نشاط"]} />
          <ModuleCard eyebrow="مستندات مالية" title="العروض والفوترة" text="عروض مالية وفواتير منظمة مع تهيئة لرحلة الضريبة والفوترة الإلكترونية." icon={<WalletIcon />} tags={["عروض سعر", "فواتير", "تحصيل"]} />
        </div>
      </section>

      <section id="guide" className="guide-section">
        <div className="guide-copy">
          <span className="eyebrow dark"><GuideIcon /> دليل تفاعلي حسب الدور</span>
          <h2>«وظيفتي» يظهر للموظف من أول دخول</h2>
          <p>لا يترك الموظف أمام قوائم كثيرة. يشرح له شاشاته، مهام يومه، وما الذي يستلمه ومن يسلّمه بعد اكتمال عمله.</p>
          <ul>
            <li><CheckIcon /> جولة مرئية داخل الشاشة الحالية</li>
            <li><CheckIcon /> قائمة يومية تحفظ التقدم تلقائيًا</li>
            <li><CheckIcon /> خطوات واضحة لتسليم المهام بين الأدوار</li>
            <li><CheckIcon /> شرح مختلف للمالك والمشرف وكل موظف</li>
          </ul>
        </div>
        <div className="guide-demo" aria-label="معاينة دليل وظيفتي">
          <header><span><GuideIcon /></span><div><small>ODEIR ROLE GUIDE</small><b>وظيفتي</b><p>رحلة تسليم المهام</p></div><i>×</i></header>
          <div className="guide-tabs"><button>دوري</button><button>مهام اليوم</button><button className="active">تسليم المهام</button></div>
          <div className="handoff-flow">
            {[
    ["مسؤول البيانات", "ينظف الدفعة ويعتمد المصدر", "قائمة التوزيع"],
    ["مشرف المبيعات", "يوزع العملاء ويحدد الموعد", "مسؤول المبيعات"],
    ["مسؤول المبيعات", "يؤكد الدفع ويسجل النتيجة", "التسجيل والقبول"],
    ["مسؤول التسجيل", "يكمل الملف ويربط الدفعة", "مدير التدريب"]
  ].map((item, index) => <button key={item[0]} className={guideRole === index ? "handoff active" : "handoff"} onClick={() => setGuideRole(index)}>
                <i>{index + 1}</i><span><b>{item[0]}</b><small>{item[1]}</small></span><em>يسلّم إلى: {item[2]}</em>
              </button>)}
          </div>
          <div className="golden-rule"><small>قاعدة الإغلاق</small><b>لا تكتمل المهمة قبل تحديد النتيجة، المستلم، والموعد التالي.</b></div>
        </div>
      </section>

      <section className="saudi-section">
        <div className="saudi-copy">
          <span className="section-kicker">مبني لواقع منشأة التدريب السعودية</span>
          <h2>لا تبدأ من قالب أجنبي ثم تحاول تطويعه.</h2>
          <p>لغة الواجهة، أدوار الفريق، رحلة الترخيص والتسجيل، وحاجة الإدارة لربط الحملة بالمبيع؛ كلها حاضرة في تصميم فلو من البداية.</p>
          <ul>
            <li><CheckIcon /><span><b>عربي وإنجليزي</b><small>واجهة واضحة تناسب الإدارة والفريق التشغيلي</small></span></li>
            <li><CheckIcon /><span><b>فروع وفرق متعددة</b><small>صلاحيات وتقارير حسب المنشأة والفرع والدور</small></span></li>
            <li><CheckIcon /><span><b>تهيئة محلية</b><small>سجلات المنشأة، الضريبة، والفوترة ضمن رحلة منظمة</small></span></li>
            <li><CheckIcon /><span><b>تطبيق تدريجي</b><small>نبدأ بالمسار الأهم ثم نتوسع دون تعطيل العمل</small></span></li>
          </ul>
        </div>
        <div className="integration-card">
          <header><span><LinkIcon /></span><div><small>تكاملات مرنة</small><b>يتصل بأدواتك بدل أن يعزلك عنها</b></div></header>
          <p>تهيئة للربط عبر الواجهات الرسمية حسب مزود الخدمة وخطة التفعيل.</p>
          <div className="integration-grid">
            {["WooCommerce", "سلة", "زد", "Shopify", "Meta", "Google Ads", "WhatsApp", "Yeastar"].map((name) => <span key={name}>{name}</span>)}
          </div>
          <small className="integration-note"><InfoIcon /> توفر كل تكامل يعتمد على واجهة المزود وإعداد حساب المنشأة.</small>
        </div>
      </section>

      <section className="faq-section">
        <div className="faq-intro">
          <span className="section-kicker">أسئلة قبل أن تبدأ</span>
          <h2>تجربة واضحة بلا مفاجآت.</h2>
          <p>نجهز مساحة تناسب عملك فعلًا، لا حسابًا فارغًا يتركك وحدك أمام القوائم.</p>
          <a href="#trial-card">سجّل منشأتك <ArrowIcon /></a>
        </div>
        <div className="faq-list">
          <details open><summary>هل التسجيل المجاني يحتاج بطاقة بنكية؟<PlusIcon /></summary><p>لا. الحساب الأساسي لا يتطلب بطاقة أو التزامًا بالشراء، وقد تُتاح إضافات اختيارية عند الحاجة.</p></details>
          <details><summary>هل يجب نقل بياناتنا الحالية عند التسجيل؟<PlusIcon /></summary><p>لا. تبدأ بمساحة منظمتك، ثم تحدد خطة النقل والربط فقط عندما تكون جاهزًا.</p></details>
          <details><summary>هل يناسب مركزًا صغيرًا ومعهدًا متعدد الفروع؟<PlusIcon /></summary><p>نعم. الوحدات والصلاحيات ومسارات الاعتماد قابلة للتهيئة حسب حجم المنشأة وهيكل الفريق.</p></details>
          <details><summary>ماذا يحدث بعد إرسال الطلب؟<PlusIcon /></summary><p>نراجع صفة المنشأة وبيانات المسؤول، ثم نتواصل خلال يوم عمل لتجهيز المساحة والأدوار المناسبة.</p></details>
          <details><summary>هل يمكن ربط المتجر والإعلانات والاتصالات؟<PlusIcon /></summary><p>فلو مهيأ للتكامل عبر الواجهات الرسمية، ويُحدد الربط المتاح بعد مراجعة مزودي حسابات منشأتك.</p></details>
        </div>
      </section>

      <section className="closing-cta">
        <div className="cta-orbit"><span>O</span><i /><i /><i /></div>
        <div><small>حساب أساسي — دون بطاقة بنكية</small><h2>اجعل منشأتك تتحرك في مسار واحد.</h2><p>ابحث عن منشأتك، وسنجهز أودير وفق أدوار فريقك.</p></div>
        <a href="#trial-card">سجّل منشأتك مجانًا <ArrowIcon /></a>
      </section>

      <footer className="site-footer">
        <div className="brand"><span className="brand-mark">O</span><span><b>أودير <em className="flow-name">ODEIR</em></b><small>منصة إدارة المنشآت</small></span></div>
        <p>بيانات المنشآت محمية، وتُعرض تفاصيل الاتصال بصيغة مقنّعة حتى التحقق.</p>
        <span>© 2026 ODEIR</span>
      </footer>
      </>}
    </main>;
}
function Field({ label, value, onChange, required, type = "text", placeholder, ...props }) {
  return <label className="field"><span>{label}{required && <em>*</em>}</span><input type={type} required={required} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} {...props} /></label>;
}
function ReadOnlyField({ label, value }) {
  return <div><dt>{label}</dt><dd>{value || "غير متاح"}<LockIcon /></dd></div>;
}
function ModuleCard({ eyebrow, title, text, icon, tags, className = "" }) {
  return <article className={`module-card ${className}`}>
    <header><span>{icon}</span><small>{eyebrow}</small></header>
    <h3>{title}</h3><p>{text}</p>
    <div>{tags.map((tag) => <em key={tag}>{tag}</em>)}</div>
  </article>;
}
function messageFor(error) {
  const code = error instanceof Error ? error.message : "service_unavailable";
  return ERROR_COPY[code] || ERROR_COPY.service_unavailable;
}
function Svg({ children, viewBox = "0 0 24 24" }) {
  return <svg aria-hidden="true" viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
}
const SearchIcon = () => <Svg><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></Svg>;
const ShieldIcon = () => <Svg><path d="M12 3 5 6v5c0 4.6 2.8 8.1 7 10 4.2-1.9 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-4" /></Svg>;
const DatabaseIcon = () => <Svg><ellipse cx="12" cy="5" rx="7" ry="3" /><path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" /></Svg>;
const ClockIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>;
const SparkIcon = () => <Svg><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3Z" /><path d="m18.5 14 .7 2.3 2.3.7-2.3.7-.7 2.3-.7-2.3-2.3-.7 2.3-.7.7-2.3Z" /></Svg>;
const ArrowIcon = () => <Svg><path d="M5 12h14M12 5l7 7-7 7" /></Svg>;
const PlusIcon = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
const LockIcon = () => <Svg><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></Svg>;
const CheckIcon = () => <Svg><path d="m5 12 4 4L19 6" /></Svg>;
const UserIcon = () => <Svg><circle cx="12" cy="8" r="4" /><path d="M4 21c.8-4.3 3.5-6.5 8-6.5s7.2 2.2 8 6.5" /></Svg>;
const InfoIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>;
const BuildingIcon = () => <Svg><path d="M4 21V7l8-4 8 4v14M8 10h1M15 10h1M8 14h1M15 14h1M10 21v-4h4v4" /></Svg>;
const UsersIcon = () => <Svg><circle cx="9" cy="8" r="3" /><path d="M3 19c.6-3.6 2.6-5.5 6-5.5s5.4 1.9 6 5.5M16 5.5a3 3 0 0 1 0 5.8M17 14c2.2.4 3.5 2 4 4.5" /></Svg>;
const FlowIcon = () => <Svg><rect x="3" y="4" width="6" height="5" rx="1" /><rect x="15" y="15" width="6" height="5" rx="1" /><path d="M9 6.5h4a4 4 0 0 1 4 4V15M15 17.5h-4a4 4 0 0 1-4-4V9" /></Svg>;
const ChartIcon = () => <Svg><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>;
const GuideIcon = () => <Svg><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5ZM20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z" /></Svg>;
const MegaphoneIcon = () => <Svg><path d="m4 13 13-5v10L4 13Z" /><path d="M4 13v5h4l2 4M17 10c2 1 2 5 0 6" /></Svg>;
const WalletIcon = () => <Svg><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H19v16H6.5A2.5 2.5 0 0 1 4 17.5v-11Z" /><path d="M4 8h15M15 12h6v4h-6a2 2 0 0 1 0-4Z" /></Svg>;
const GraduationIcon = () => <Svg><path d="m3 9 9-5 9 5-9 5-9-5Z" /><path d="M7 12v5c3 2 7 2 10 0v-5M21 9v6" /></Svg>;
const StoreIcon = () => <Svg><path d="M4 10v10h16V10M3 10l2-6h14l2 6" /><path d="M3 10c1 2 3 2 4 0 1 2 3 2 5 0 1 2 3 2 5 0 1 2 3 2 4 0M9 20v-5h6v5" /></Svg>;
const LanguageIcon = () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" /></Svg>;
const LinkIcon = () => <Svg><path d="m9.5 14.5 5-5M7.5 17.5l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16.5 6.5l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0" /></Svg>;
const Spinner = () => <span className="spinner" aria-label="جارٍ التحميل" />;
export {
  FreeTrialLanding as default
};
