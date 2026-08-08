import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  extractTenderDetails,
  isInactiveTender,
  parseSaudiDate,
  reviewForAutoPublish,
} from "../supabase/functions/knowledge-ingest/review.ts";

const NOW = new Date("2026-08-08T12:00:00.000Z");
const smartNews = {
  type: "news",
  relevance: 85,
  trust: 95,
  why: "تحديث موثوق ومهم لقطاع التدريب.",
  action: "شارك المادة مع الفريق المختص.",
};

test("parses Arabic Saudi tender deadlines into UTC", () => {
  assert.equal(
    parseSaudiDate("11 أغسطس 2026 - 12:00 PM"),
    "2026-08-11T09:00:00.000Z",
  );
  assert.equal(
    parseSaudiDate("05-يوليو-2026"),
    "2026-07-05T20:59:00.000Z",
  );
});

test("publishes a relevant official news item after automated review", () => {
  const source = {
    name: "وزارة الموارد البشرية والتنمية الاجتماعية",
    base_url: "https://www.hrsd.gov.sa",
    trust_level: "official",
    auto_publish: true,
    requires_review: false,
  };
  const item = {
    url: "https://www.hrsd.gov.sa/media-center/news/skills-accelerator",
    title: "الوزارة تطلق برنامجًا جديدًا لتطوير المهارات | HRSD",
    excerpt:
      "أطلقت الوزارة برنامجًا وطنيًا متكاملًا لتطوير مهارات العاملين ورفع جاهزيتهم المهنية بما يلبي احتياجات سوق العمل.",
    content:
      "أطلقت الوزارة برنامجًا وطنيًا متكاملًا لتطوير مهارات العاملين ورفع جاهزيتهم المهنية بما يلبي احتياجات سوق العمل والقطاعات ذات الأولوية.",
    publishedAt: "2026-08-08T08:00:00.000Z",
  };
  const decision = reviewForAutoPublish(source, item, smartNews, item.url, NOW);
  assert.equal(decision.publish, true);
  assert.equal(decision.title, "الوزارة تطلق برنامجًا جديدًا لتطوير المهارات");
  assert.deepEqual(decision.reasons, []);
});

test("routes generic boilerplate summaries to human review", () => {
  const source = {
    name: "المركز الوطني للتعليم الإلكتروني",
    base_url: "https://nelc.gov.sa",
    trust_level: "official",
    auto_publish: true,
    requires_review: false,
  };
  const item = {
    url: "https://nelc.gov.sa/media-center/news/example",
    title: "المركز يطلق مبادرة جديدة للتعليم الرقمي | المركز الوطني للتعليم الإلكتروني",
    excerpt:
      "المركز الوطني للتعليم الإلكتروني مركز مستقل تأسس بقرار من مجلس الوزراء بهدف تعزيز الثقة في التعليم الإلكتروني.",
    content: "موقع حكومي رسمي مسجل لدى هيئة الحكومة الرقمية كيف تتحقق؟",
  };
  const decision = reviewForAutoPublish(source, item, smartNews, item.url, NOW);
  assert.equal(decision.publish, false);
  assert.match(decision.reasons.join(" "), /الملخص غير كافٍ/);
});

test("publishes only an active official tender with a future deadline", () => {
  const source = {
    name: "الهيئة السعودية للمقيّمين المعتمدين — المنافسات",
    base_url: "https://taqeem.gov.sa",
    default_content_type: "tender",
    trust_level: "official",
    auto_publish: true,
    requires_review: false,
  };
  const item = {
    url: "https://taqeem.gov.sa/tenders/data-project-164",
    title: "مشروع الامتثال لمعايير مكتب إدارة البيانات الوطنية",
    excerpt:
      "منافسة رسمية لتنفيذ مشروع امتثال وتطوير منظومة إدارة البيانات لدى الهيئة ورفع جاهزية العمليات الرقمية.",
    content:
      "الحالة: حالية. رقم المنافسة PRCOMP20260600028. آخر موعد لاستلام العروض: 11 أغسطس 2026 - 12:00 PM.",
  };
  const smartTender = { ...smartNews, type: "tender", relevance: 90 };
  const details = extractTenderDetails(source, item, item.url, NOW);
  assert.equal(details.authority, "الهيئة السعودية للمقيّمين المعتمدين");
  assert.equal(details.number, "PRCOMP20260600028");
  assert.equal(details.deadline, "2026-08-11T09:00:00.000Z");
  assert.equal(details.status, "active");

  const decision = reviewForAutoPublish(source, item, smartTender, item.url, NOW);
  assert.equal(decision.publish, true);
  assert.equal(decision.tender?.deadline, "2026-08-11T09:00:00.000Z");
});

test("filters expired tenders before ingestion", () => {
  const source = {
    name: "جهة حكومية — المنافسات",
    base_url: "https://example.gov.sa",
    default_content_type: "tender",
  };
  const item = {
    url: "https://example.gov.sa/tenders/1",
    title: "منافسة تدريبية",
    excerpt: "الحالة: منتهية",
    content: "آخر موعد لاستلام العروض: 1 أغسطس 2026 - 12:00 PM",
  };
  assert.equal(isInactiveTender(source, item, NOW), true);
});

test("daily scheduled runs do not drift behind next_sync_at", async () => {
  const source = await readFile(
    new URL("../supabase/functions/knowledge-ingest/index.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /trigger === "scheduled"/);
  assert.match(source, /sync_frequency=neq\.manual/);
  assert.match(source, /setUTCHours\(3, 15, 0, 0\)/);
});
