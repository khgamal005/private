export type Source = Record<string, any>;

export type Item = {
  externalId?: string;
  url?: string;
  title: string;
  excerpt?: string;
  content?: string;
  image?: string;
  publishedAt?: string;
  payload?: Record<string, any>;
};

export type SmartClassification = {
  type: string;
  relevance: number;
  trust: number;
  why: string;
  action: string;
};

export type TenderDetails = {
  authority: string;
  number?: string;
  deadline?: string;
  status: "active" | "expired" | "cancelled" | "unknown";
  applicationUrl: string;
};

export type AutoReviewDecision = {
  publish: boolean;
  reasons: string[];
  title: string;
  summary: string;
  content: string;
  publishedAt?: string;
  tender?: TenderDetails;
};

const ARABIC_MONTHS: Record<string, number> = {
  يناير: 0,
  جانفي: 0,
  فبراير: 1,
  فيفري: 1,
  مارس: 2,
  أبريل: 3,
  ابريل: 3,
  أفريل: 3,
  افريل: 3,
  مايو: 4,
  ماي: 4,
  يونيو: 5,
  يونيه: 5,
  جوان: 5,
  يوليو: 6,
  يوليه: 6,
  جويلية: 6,
  أغسطس: 7,
  اغسطس: 7,
  غشت: 7,
  سبتمبر: 8,
  شتنبر: 8,
  أكتوبر: 9,
  اكتوبر: 9,
  نوفمبر: 10,
  دجنبر: 11,
  ديسمبر: 11,
};

const ENGLISH_MONTHS =
  "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const ARABIC_MONTH_PATTERN = Object.keys(ARABIC_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

export function text(value: unknown) {
  return String(value ?? "").trim();
}

export function compact(value: unknown) {
  return text(value).replace(/\s+/g, " ").trim();
}

export function normalizeDigits(value: string) {
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  return value.replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabicIndex = arabic.indexOf(digit);
    return String(arabicIndex >= 0 ? arabicIndex : persian.indexOf(digit));
  });
}

function validIso(value: string | undefined) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function saudiIso(
  year: number,
  month: number,
  day: number,
  hour = 23,
  minute = 59,
) {
  if (
    year < 2000 ||
    year > 2200 ||
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) return undefined;
  const date = new Date(Date.UTC(year, month, day, hour - 3, minute, 0, 0));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function hour24(rawHour: string | undefined, marker: string | undefined) {
  if (!rawHour) return 23;
  let hour = Number(rawHour);
  const normalizedMarker = compact(marker).toLowerCase();
  const isPm = normalizedMarker === "pm" || normalizedMarker === "م";
  const isAm = normalizedMarker === "am" || normalizedMarker === "ص";
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;
  return hour;
}

/** Parse Gregorian dates written for Saudi audiences and return UTC ISO. */
export function parseSaudiDate(value: string) {
  const normalized = normalizeDigits(compact(value))
    .replace(/[،,]/g, " ")
    .replace(/\s+/g, " ");

  const arabic = normalized.match(
    new RegExp(
      `(\\d{1,2})\\s*(?:[-/]\\s*)?(${ARABIC_MONTH_PATTERN})\\s*(?:[-/]\\s*)?(\\d{4})(?:\\s*(?:-|–|—|،)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM|am|pm|ص|م)?)?`,
      "i",
    ),
  );
  if (arabic) {
    const month = ARABIC_MONTHS[arabic[2]] ?? ARABIC_MONTHS[arabic[2].toLowerCase()];
    const hasTime = Boolean(arabic[4]);
    return saudiIso(
      Number(arabic[3]),
      month,
      Number(arabic[1]),
      hasTime ? hour24(arabic[4], arabic[6]) : 23,
      hasTime ? Number(arabic[5] || 0) : 59,
    );
  }

  const english = normalized.match(
    new RegExp(
      `(\\d{1,2})\\s+(${ENGLISH_MONTHS})\\s+(\\d{4})(?:\\s*(?:-|–|—|,)?\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(AM|PM|am|pm)?)?`,
      "i",
    ),
  );
  if (english) {
    const parsed = new Date(
      `${english[2]} ${english[1]}, ${english[3]} ${english[4] || "23"}:${english[5] || "59"} ${english[6] || ""} GMT+0300`,
    );
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const isoLike = normalized.match(/\b\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?/);
  return validIso(isoLike?.[0]);
}

function dateAfterLabels(value: string, labels: string[]) {
  const normalized = normalizeDigits(compact(value));
  const lowered = normalized.toLocaleLowerCase("ar");
  for (const label of labels) {
    const index = lowered.indexOf(label.toLocaleLowerCase("ar"));
    if (index < 0) continue;
    const parsed = parseSaudiDate(normalized.slice(index + label.length, index + label.length + 180));
    if (parsed) return parsed;
  }
  return undefined;
}

function titleSuffixes(source: Source) {
  return [
    compact(source.name),
    compact(source.name).replace(/\s*[—–-]\s*المنافسات.*$/i, ""),
    "HRSD",
    "المركز الوطني للتعليم الإلكتروني",
  ].filter(Boolean);
}

export function cleanTitle(value: string, source: Source) {
  let result = compact(value).replace(/\\["']/g, (match) => match.slice(1));
  for (const suffix of titleSuffixes(source)) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replace(new RegExp(`\\s*\\|\\s*${escaped}\\s*$`, "i"), "");
  }
  return result.replace(/\s+([،؛:,.!?])/g, "$1").slice(0, 180).trim();
}

function boilerplate(value: string) {
  const lowered = value.toLocaleLowerCase("ar");
  return [
    "موقع حكومي رسمي",
    "كيف تتحقق",
    "مركز مستقل تأسس بقرار",
    "ابق على اطلاع دائم",
    "انضم إلى قائمة نشرتنا",
    "جميع الحقوق محفوظة",
    "سياسة الخصوصية",
  ].some((phrase) => lowered.includes(phrase.toLocaleLowerCase("ar")));
}

function trimSummary(value: string, limit = 600) {
  const cleaned = compact(value)
    .replace(/تاريخ النشر[\s\S]*$/i, "")
    .replace(/اخبار ذات صلة[\s\S]*$/i, "")
    .trim();
  if (cleaned.length <= limit) return cleaned;
  const candidate = cleaned.slice(0, limit + 1);
  const sentence = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("؟ "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("، "),
  );
  const cut = sentence >= Math.floor(limit * 0.55) ? sentence + 1 : candidate.lastIndexOf(" ", limit);
  return `${candidate.slice(0, Math.max(1, cut)).trim()}…`;
}

export function buildSummary(item: Item, smart: SmartClassification) {
  const excerpt = compact(item.excerpt);
  const content = compact(item.content);
  const candidates = [excerpt, content]
    .filter((candidate) => candidate.length >= 80)
    .filter((candidate) => !boilerplate(candidate));
  return trimSummary(candidates[0] || excerpt || content || smart.why);
}

function sourceAuthority(source: Source) {
  return compact(source.name)
    .replace(/\s*[—–-]\s*المنافسات.*$/i, "")
    .replace(/\s*[—–-]\s*الأخبار.*$/i, "")
    .trim();
}

function tenderStatus(value: string) {
  const normalized = compact(value).toLocaleLowerCase("ar");
  const labeled = normalized.match(/الحالة\s*:?\s*(حالية|سارية|نشطة|مفتوحة|منتهي(?:ة)?|ملغية|ملغي)/i)?.[1];
  if (labeled && /ملغ/.test(labeled)) return "cancelled" as const;
  if (labeled && /منتهي/.test(labeled)) return "expired" as const;
  if (labeled && /حالية|سارية|نشطة|مفتوحة/.test(labeled)) return "active" as const;
  return "unknown" as const;
}

export function extractTenderDetails(
  source: Source,
  item: Item,
  canonicalUrl: string,
  now = new Date(),
): TenderDetails {
  const body = `${item.title} ${item.excerpt || ""} ${item.content || ""}`;
  const deadline =
    validIso(text(item.payload?.tenderDeadline)) ||
    dateAfterLabels(body, [
      "آخر موعد لاستلام العروض",
      "اخر موعد لاستلام العروض",
      "آخر موعد لتقديم العروض",
      "اخر موعد لتقديم العروض",
      "الموعد النهائي للتقديم",
      "موعد إغلاق المنافسة",
      "موعد اغلاق المنافسة",
      "تاريخ الإغلاق",
      "تاريخ الاغلاق",
      "closing date",
      "deadline",
    ]);
  const number = normalizeDigits(body).match(
    /(?:رقم\s*(?:المنافسة|المرجع)\s*:?\s*)?\b(PRCOMP\d{8,}|\d{10,15})\b/i,
  )?.[1];
  let status = tenderStatus(body);
  if (deadline && new Date(deadline).getTime() <= now.getTime()) status = "expired";
  return {
    authority: sourceAuthority(source),
    number,
    deadline,
    status,
    applicationUrl: canonicalUrl,
  };
}

function sourceOwnsUrl(source: Source, canonicalUrl: string) {
  try {
    const target = new URL(canonicalUrl);
    const base = new URL(text(source.base_url || source.feed_url));
    return target.protocol === "https:" &&
      (target.hostname === base.hostname || target.hostname.endsWith(`.${base.hostname}`));
  } catch {
    return false;
  }
}

function publicationDate(item: Item) {
  return validIso(item.publishedAt) ||
    dateAfterLabels(`${item.excerpt || ""} ${item.content || ""}`, [
      "تاريخ النشر",
      "نشر في",
      "published on",
    ]);
}

export function reviewForAutoPublish(
  source: Source,
  item: Item,
  smart: SmartClassification,
  canonicalUrl: string,
  now = new Date(),
): AutoReviewDecision {
  const reasons: string[] = [];
  const title = cleanTitle(item.title, source);
  const summary = buildSummary(item, smart);
  const content = compact(item.content || item.excerpt || summary);
  const publishedAt = publicationDate(item);

  if (!source.auto_publish || source.requires_review) reasons.push("المصدر مضبوط للمراجعة اليدوية");
  if (source.trust_level !== "official") reasons.push("المصدر غير مصنف رسميًا");
  if (!sourceOwnsUrl(source, canonicalUrl)) reasons.push("رابط المادة خارج النطاق الرسمي للمصدر");
  if (title.length < 12) reasons.push("العنوان غير مكتمل");
  if (summary.length < 80 || boilerplate(summary)) reasons.push("الملخص غير كافٍ أو يحتوي نصًا تعريفيًا عامًا");
  if (smart.relevance < 65) reasons.push("درجة الارتباط بنطاق ماركتون منخفضة");

  if (publishedAt) {
    const ageMs = now.getTime() - new Date(publishedAt).getTime();
    if (ageMs < -86_400_000) reasons.push("تاريخ النشر مستقبلي");
    if (ageMs > 90 * 86_400_000) reasons.push("المادة أقدم من نافذة النشر الآلي");
  }

  let tender: TenderDetails | undefined;
  if (smart.type === "tender") {
    tender = extractTenderDetails(source, item, canonicalUrl, now);
    if (tender.authority.length < 4) reasons.push("جهة المنافسة غير واضحة");
    if (!tender.deadline) reasons.push("موعد إغلاق المنافسة غير موجود أو غير قابل للتحقق");
    if (tender.status === "expired") reasons.push("المنافسة منتهية");
    if (tender.status === "cancelled") reasons.push("المنافسة ملغاة");
    if (!tender.applicationUrl) reasons.push("رابط التقديم غير موجود");
  }

  return {
    publish: reasons.length === 0,
    reasons,
    title,
    summary,
    content,
    publishedAt,
    tender,
  };
}

export function isInactiveTender(source: Source, item: Item, now = new Date()) {
  if (source.default_content_type !== "tender") return false;
  const canonical = text(item.url);
  const details = extractTenderDetails(source, item, canonical, now);
  return details.status === "expired" || details.status === "cancelled";
}
