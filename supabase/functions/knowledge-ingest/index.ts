import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  type Item,
  type Source,
  isInactiveTender,
  reviewForAutoPublish,
  text,
} from "./review.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};
const USER_AGENT = "Marktone-Knowledge-Intelligence/1.1 (+https://marktone.org)";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function decodeEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, code) => {
    if (code[0] === "#") {
      const hex = code[1]?.toLowerCase() === "x";
      const number = parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : " ";
    }
    return named[code.toLowerCase()] || " ";
  });
}

function stripHtml(value: string) {
  return decodeEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function tag(block: string, name: string) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = block.match(
    new RegExp(`<${safe}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${safe}>`, "i"),
  );
  return stripHtml((match?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

function attr(block: string, tagName: string, attribute: string) {
  const match = block.match(
    new RegExp(`<${tagName}\\b[^>]*\\b${attribute}=["']([^"']+)["'][^>]*>`, "i"),
  );
  return match?.[1] || "";
}

function dateValue(value: string) {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function normalizeUrl(value: string, base?: string) {
  try {
    const url = new URL(value, base);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function assertPublicHttps(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("knowledge_https_required");
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host === "0.0.0.0" ||
    host === "::1" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) throw new Error("knowledge_private_url_rejected");
  return url;
}

async function fetchText(url: string, timeout = 20_000) {
  assertPublicHttps(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const result = await fetch(url, {
      headers: {
        "user-agent": USER_AGENT,
        accept:
          "application/rss+xml, application/atom+xml, application/xml, text/html, application/json;q=0.9, */*;q=0.5",
        "accept-language": "ar-SA,ar;q=0.9,en;q=0.5",
        cookie: "frontend_lang=ar_001",
      },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!result.ok) throw new Error(`remote_http_${result.status}`);
    const type = result.headers.get("content-type") || "";
    const body = await result.text();
    if (body.length > 4_000_000) throw new Error("knowledge_source_too_large");
    return { body, type, url: result.url };
  } finally {
    clearTimeout(timer);
  }
}

async function db(path: string, init: RequestInit = {}) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const raw = await result.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!result.ok) throw new Error(data?.message || data?.error || `database_${result.status}`);
  return data;
}

async function rpc(
  name: string,
  payload: Record<string, unknown>,
  token = SERVICE_KEY,
) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await result.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!result.ok) throw new Error(data?.message || data?.error || `rpc_${result.status}`);
  return data;
}

async function authorized(request: Request) {
  const secret = request.headers.get("x-marktone-knowledge-secret");
  if (
    secret &&
    await rpc("knowledge_ingestion_validate_secret", { p_secret: secret })
  ) return true;

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  for (const name of ["v2_current_user_context", "current_user_context"]) {
    try {
      const context = await rpc(name, {}, token);
      if (context?.platformAccess || context?.platform_access) return true;
    } catch {
      // Compatibility with installations that only expose one context RPC.
    }
  }
  return false;
}

function parseRss(xml: string, maxItems: number): Item[] {
  const blocks = [...xml.matchAll(/<(?:item|entry)\b[\s\S]*?<\/(?:item|entry)>/gi)]
    .map((match) => match[0]);
  return blocks.slice(0, maxItems).map((block) => {
    const rawLink = tag(block, "link") || attr(block, "link", "href");
    const description = tag(block, "description") || tag(block, "summary");
    const content = tag(block, "content:encoded") || tag(block, "content");
    return {
      externalId: tag(block, "guid") || tag(block, "id") || rawLink,
      url: rawLink,
      title: tag(block, "title"),
      excerpt: stripHtml(description || content).slice(0, 800),
      content: stripHtml(content || description).slice(0, 12_000),
      image: attr(block, "media:content", "url") || attr(block, "enclosure", "url"),
      publishedAt: dateValue(
        tag(block, "pubDate") || tag(block, "published") || tag(block, "updated"),
      ),
      payload: { format: "rss" },
    };
  }).filter((item) => item.title && item.url);
}

function meta(html: string, property: string) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
      "i",
    ),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeEntities(match[1]);
  }
  return "";
}

function pageItem(html: string, url: string): Item {
  const title = meta(html, "og:title") ||
    meta(html, "twitter:title") ||
    stripHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "");
  const excerpt = meta(html, "og:description") ||
    meta(html, "description") ||
    meta(html, "twitter:description");
  const image = meta(html, "og:image") || meta(html, "twitter:image");
  const published = meta(html, "article:published_time") ||
    meta(html, "date") ||
    meta(html, "datePublished");
  const main = html.match(/<main\b[\s\S]*?<\/main>/i)?.[0] || html;
  return {
    externalId: url,
    url,
    title,
    excerpt: stripHtml(excerpt).slice(0, 800),
    content: stripHtml(main).slice(0, 12_000),
    image: normalizeUrl(image, url),
    publishedAt: dateValue(published),
    payload: { format: "html" },
  };
}

async function parseHtml(source: Source, html: string, listingUrl: string): Promise<Item[]> {
  const config = source.parser_config || {};
  const maxItems = Math.max(1, Math.min(Number(config.maxItems || 10), 40));
  const pattern = text(config.linkPattern);
  const matcher = pattern ? new RegExp(pattern, "i") : null;
  const origin = new URL(source.base_url || listingUrl);
  const links: string[] = [];

  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const url = normalizeUrl(match[1], listingUrl);
    if (!url) continue;
    const parsed = new URL(url);
    if (
      parsed.hostname !== origin.hostname &&
      !parsed.hostname.endsWith(`.${origin.hostname}`)
    ) continue;
    if (matcher && !matcher.test(parsed.pathname)) continue;
    if (!links.includes(url)) links.push(url);
    if (links.length >= maxItems) break;
  }

  const items: Item[] = [];
  for (const url of links) {
    try {
      const page = await fetchText(url, 15_000);
      const item = pageItem(page.body, page.url);
      if (item.title) items.push(item);
    } catch (error) {
      console.error("knowledge_page_failed", source.source_key, url, error);
    }
  }
  return items;
}

function getPath(value: any, path: string) {
  return path.split(".").filter(Boolean).reduce((current, key) => current?.[key], value);
}

function parseJson(source: Source, body: string): Item[] {
  const config = source.parser_config || {};
  const parsed = JSON.parse(body);
  const rows = getPath(parsed, text(config.itemsPath)) || parsed;
  if (!Array.isArray(rows)) throw new Error("knowledge_json_items_missing");
  const maxItems = Math.max(1, Math.min(Number(config.maxItems || 30), 100));
  return rows.slice(0, maxItems).map((row: any) => ({
    externalId: text(getPath(row, config.idPath || "id")),
    url: text(getPath(row, config.urlPath || "url")),
    title: text(getPath(row, config.titlePath || "title")),
    excerpt: text(getPath(row, config.excerptPath || "description")),
    content: text(getPath(row, config.contentPath || "content")),
    image: text(getPath(row, config.imagePath || "image")),
    publishedAt: dateValue(text(getPath(row, config.datePath || "published_at"))),
    payload: row,
  })).filter((item) => item.title && item.url);
}

function includesAny(haystack: string, needles: string[]) {
  return needles.some((word) => haystack.includes(text(word).toLocaleLowerCase("ar")));
}

function accepted(source: Source, item: Item) {
  const haystack = `${item.title} ${item.excerpt || ""} ${item.content || ""}`
    .toLocaleLowerCase("ar");
  const includes = (source.include_keywords || [])
    .map((value: any) => text(value).toLocaleLowerCase("ar"))
    .filter(Boolean);
  const excludes = (source.exclude_keywords || [])
    .map((value: any) => text(value).toLocaleLowerCase("ar"))
    .filter(Boolean);
  return !isInactiveTender(source, item) &&
    (!includes.length || includesAny(haystack, includes)) &&
    !includesAny(haystack, excludes);
}

function classify(source: Source, item: Item) {
  const value = `${item.title} ${item.excerpt || ""} ${item.content || ""}`
    .toLocaleLowerCase("ar");
  const tender = source.default_content_type === "tender" || includesAny(value, [
    "منافسة",
    "كراسة شروط",
    "طلب عروض",
    "تأهيل",
    "توريد",
    "مناقصة",
  ]);
  const regulation = includesAny(value, [
    "لائحة",
    "ضوابط",
    "قرار",
    "نظام",
    "اعتماد",
    "ترخيص",
    "تحديث تنظيمي",
  ]);
  const event = includesAny(value, [
    "ملتقى",
    "مؤتمر",
    "فعالية",
    "أسبوع",
    "معرض",
    "ورشة",
    "ندوة",
  ]);
  const type = tender
    ? "tender"
    : regulation
    ? "regulation"
    : event
    ? "event"
    : source.default_content_type || "news";

  let relevance = source.trust_level === "official" ? 65 : 50;
  const trainingMatches = [
    "تدريب",
    "تعليم",
    "مهارات",
    "معهد",
    "مركز",
    "موارد بشرية",
    "محتوى",
    "تحول رقمي",
    "ذكاء اصطناعي",
    "استشارات",
    "توعية",
    "سوق العمل",
  ].filter((keyword) => value.includes(keyword)).length;
  relevance = Math.min(
    98,
    relevance + trainingMatches * 5 + (tender ? 10 : 0) + (regulation ? 8 : 0),
  );
  const trust = source.trust_level === "official"
    ? 95
    : source.trust_level === "trusted"
    ? 80
    : 65;
  const why = type === "tender"
    ? "فرصة محتملة يمكن أن تتحول إلى مشروع أو شراكة لمركز التدريب."
    : type === "regulation"
    ? "قد يؤثر هذا التحديث على الامتثال أو الاعتماد أو طريقة تشغيل البرامج التدريبية."
    : type === "event"
    ? "قد تتيح الفعالية تعلّمًا أو شراكات أو ظهورًا تجاريًا للمنشأة."
    : "يوفر تحديثًا موثوقًا يساعد الإدارة على متابعة اتجاهات قطاع التدريب.";
  const action = type === "tender"
    ? "راجع الشروط والموعد النهائي وحدد قرار المشاركة خلال 48 ساعة."
    : type === "regulation"
    ? "كلّف المسؤول المختص بمراجعة الأثر وتحديث الإجراءات عند الحاجة."
    : type === "event"
    ? "تحقق من ملاءمة الحضور وأضف الموعد إلى التقويم إذا كان مناسبًا."
    : "احفظ الخبر وشاركه مع الدور الوظيفي الأكثر ارتباطًا به.";
  return { type, relevance, trust, why, action };
}

async function fingerprint(sourceId: string, item: Item) {
  const canonical = normalizeUrl(item.url || "");
  const input = `${sourceId}|${canonical || item.externalId || ""}|${item.title
    .toLocaleLowerCase("ar").replace(/\s+/g, " ")}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function slugify(title: string, hash: string) {
  const base = title.toLocaleLowerCase("ar")
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\u0600-\u06ffa-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return `${base || "knowledge"}-${hash.slice(0, 8)}`;
}

function nextSync(frequency: string) {
  const now = new Date();
  if (frequency === "daily") {
    const next = new Date(now);
    next.setUTCHours(3, 15, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  const milliseconds = frequency === "hourly"
    ? 3_600_000
    : frequency === "weekly"
    ? 604_800_000
    : 86_400_000;
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function sourceItems(source: Source): Promise<Item[]> {
  if (source.source_type === "manual") return [];
  const target = text(source.feed_url || source.base_url);
  if (!target) throw new Error("knowledge_source_url_missing");
  const remote = await fetchText(target);
  const maxItems = Math.max(1, Math.min(Number(source.parser_config?.maxItems || 30), 100));
  if (
    source.source_type === "rss" ||
    source.source_type === "atom" ||
    /xml|rss|atom/i.test(remote.type)
  ) {
    return parseRss(remote.body, maxItems).map((item) => ({
      ...item,
      url: normalizeUrl(item.url || "", remote.url),
      image: normalizeUrl(item.image || "", remote.url),
    }));
  }
  if (source.source_type === "json" || /json/i.test(remote.type)) {
    return parseJson(source, remote.body).map((item) => ({
      ...item,
      url: normalizeUrl(item.url || "", remote.url),
      image: normalizeUrl(item.image || "", remote.url),
    }));
  }
  return parseHtml(source, remote.body, remote.url);
}

async function ingestSource(source: Source, trigger: string) {
  const runRows = await db("knowledge_ingestion_runs", {
    method: "POST",
    body: JSON.stringify({
      source_id: source.id,
      trigger_type: trigger,
      status: "running",
    }),
  });
  const run = runRows[0];
  let fetched = 0;
  let filteredOut = 0;
  let newCount = 0;
  let duplicates = 0;
  let review = 0;
  let published = 0;
  let errors = 0;

  await db(`knowledge_sources?id=eq.${source.id}`, {
    method: "PATCH",
    body: JSON.stringify({ last_status: "running", last_error: null }),
  });

  try {
    const fetchedItems = await sourceItems(source);
    fetched = fetchedItems.length;
    const items = fetchedItems.filter((item) => accepted(source, item));
    filteredOut = fetched - items.length;

    for (const item of items) {
      try {
        const canonical = normalizeUrl(item.url || "", source.base_url);
        if (!canonical || !item.title) continue;
        const hash = await fingerprint(source.id, { ...item, url: canonical });
        const existing = await db(
          `knowledge_raw_items?select=id,post_id,status&source_id=eq.${source.id}&fingerprint=eq.${hash}&limit=1`,
        );
        if (existing.length) {
          duplicates++;
          continue;
        }
        const existingPost = await db(
          `knowledge_posts?select=id,status&canonical_url=eq.${encodeURIComponent(canonical)}&limit=1`,
        );
        if (existingPost.length) {
          duplicates++;
          continue;
        }

        const smart = classify(source, item);
        const decision = reviewForAutoPublish(source, item, smart, canonical);
        const willPublish = decision.publish;
        const postStatus = willPublish ? "published" : "review";
        const reviewNote = decision.reasons.length
          ? `المراجعة الآلية: ${decision.reasons.join("؛ ")}`
          : null;
        const sourcePublishedAt = decision.publishedAt || item.publishedAt || null;
        const tender = decision.tender;

        const rawRows = await db("knowledge_raw_items", {
          method: "POST",
          body: JSON.stringify({
            source_id: source.id,
            run_id: run.id,
            external_id: item.externalId || canonical,
            canonical_url: canonical,
            title: decision.title,
            excerpt: decision.summary || null,
            content: decision.content || null,
            cover_image_url: item.image || null,
            source_published_at: sourcePublishedAt,
            raw_payload: {
              ...(item.payload || {}),
              auto_review: {
                passed: willPublish,
                reasons: decision.reasons,
                reviewed_at: new Date().toISOString(),
              },
            },
            fingerprint: hash,
            detected_type: smart.type,
            detected_category_id: source.default_category_id || null,
            trust_score: smart.trust,
            relevance_score: smart.relevance,
            why_it_matters: smart.why,
            recommended_action: smart.action,
            status: postStatus,
            error_detail: reviewNote,
          }),
        });

        const postRows = await db("knowledge_posts", {
          method: "POST",
          body: JSON.stringify({
            title: decision.title,
            slug: slugify(decision.title, hash),
            excerpt: decision.summary || smart.why,
            content: decision.content || decision.summary || null,
            cover_image_url: item.image || null,
            category_id: source.default_category_id || null,
            content_type: smart.type,
            status: postStatus,
            source_id: source.id,
            source_name: source.name,
            source_url: canonical,
            canonical_url: canonical,
            external_id: item.externalId || canonical,
            source_fingerprint: hash,
            trust_score: smart.trust,
            relevance_score: smart.relevance,
            importance_level: smart.relevance >= 85 ? "high" : "normal",
            why_it_matters: smart.why,
            recommended_action: smart.action,
            smart_summary: (decision.summary || smart.why).slice(0, 600),
            source_published_at: sourcePublishedAt,
            last_verified_at: new Date().toISOString(),
            is_automated: true,
            tags: [...(source.default_tags || [])],
            published_at: willPublish
              ? (sourcePublishedAt || new Date().toISOString())
              : null,
            review_notes: reviewNote,
            tender_authority: tender?.authority || null,
            tender_number: tender?.number || null,
            tender_deadline: tender?.deadline || null,
            tender_status: tender?.status === "active" ? "active" : null,
            expires_at: tender?.deadline || null,
            application_url: tender?.applicationUrl || null,
          }),
        });

        await db(`knowledge_raw_items?id=eq.${rawRows[0].id}`, {
          method: "PATCH",
          body: JSON.stringify({ post_id: postRows[0].id }),
        });
        newCount++;
        if (willPublish) published++;
        else review++;
      } catch (error) {
        errors++;
        console.error("knowledge_item_failed", source.source_key, error);
      }
    }

    const status = errors ? (newCount ? "partial" : "failed") : "success";
    await db(`knowledge_ingestion_runs?id=eq.${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status,
        fetched_count: fetched,
        new_count: newCount,
        duplicate_count: duplicates,
        review_count: review,
        published_count: published,
        error_count: errors,
        finished_at: new Date().toISOString(),
        error_detail: errors ? `${errors} item(s) failed` : null,
      }),
    });
    await db(`knowledge_sources?id=eq.${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        last_status: status === "failed" ? "error" : status,
        last_synced_at: new Date().toISOString(),
        last_item_at: newCount ? new Date().toISOString() : source.last_item_at,
        next_sync_at: source.sync_frequency === "manual"
          ? null
          : nextSync(source.sync_frequency),
        failure_count: status === "failed" ? Number(source.failure_count || 0) + 1 : 0,
        last_error: status === "failed" ? "لم يتم استيراد أي مادة من المصدر." : null,
      }),
    });
    return {
      sourceId: source.id,
      sourceKey: source.source_key,
      status,
      fetched,
      filteredOut,
      newCount,
      duplicates,
      review,
      published,
      errors,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db(`knowledge_ingestion_runs?id=eq.${run.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "failed",
        error_count: 1,
        error_detail: message,
        finished_at: new Date().toISOString(),
      }),
    });
    await db(`knowledge_sources?id=eq.${source.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        last_status: "error",
        last_error: message,
        failure_count: Number(source.failure_count || 0) + 1,
        next_sync_at: source.sync_frequency === "manual"
          ? null
          : nextSync(source.sync_frequency),
      }),
    });
    return {
      sourceId: source.id,
      sourceKey: source.source_key,
      status: "failed",
      error: message,
    };
  }
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-headers":
          "authorization, content-type, x-marktone-knowledge-secret",
      },
    });
  }
  if (request.method !== "POST") return response({ error: "method_not_allowed" }, 405);
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return response({ error: "knowledge_runtime_not_configured" }, 500);
  }
  if (!await authorized(request)) return response({ error: "unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));
  const trigger = body.trigger === "manual"
    ? "manual"
    : body.trigger === "retry"
    ? "retry"
    : "scheduled";
  const sourceId = text(body.sourceId);
  let query = "knowledge_sources?select=*&is_active=eq.true&order=updated_at.asc";
  if (sourceId) {
    query += `&id=eq.${encodeURIComponent(sourceId)}`;
  } else if (trigger === "scheduled") {
    // The cron itself runs once daily. Do not gate daily sources by a drifting
    // next_sync_at timestamp, otherwise a slightly late run can skip a full day.
    query += "&sync_frequency=neq.manual";
  } else {
    query += `&or=(next_sync_at.is.null,next_sync_at.lte.${
      encodeURIComponent(new Date().toISOString())
    })`;
  }

  const sources = await db(query);
  const results = [];
  for (const source of sources) {
    if (source.sync_frequency === "manual" && !sourceId) continue;
    results.push(await ingestSource(source, trigger));
  }
  return response({
    ok: true,
    trigger,
    processed: results.length,
    results,
    finishedAt: new Date().toISOString(),
  });
});
