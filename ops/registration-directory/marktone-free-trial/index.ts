import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Deployment target: existing directory project jultamrxwrgzohoktbgr only.
// See ../README.md. This is NOT an ODEIR tenant-database function.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const RATE_SALT = Deno.env.get("TRIAL_RATE_LIMIT_SALT") ?? (SUPABASE_URL + ":marktone-trial-v1");

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store, max-age=0",
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, x-client-info",
  "access-control-allow-methods": "POST, OPTIONS",
  "vary": "origin",
};

type JsonRecord = Record<string, unknown>;

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  if (request.method !== "POST") {
    return json({ ok: false, error: "method_not_allowed" }, 405);
  }
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json({ ok: false, error: "service_unavailable" }, 503);
  }

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 16_384) {
    return json({ ok: false, error: "request_too_large" }, 413);
  }

  let body: JsonRecord;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  // Quietly accept bot-filled honeypots without storing anything.
  if (clean(body.website, 120)) {
    return json({ ok: true, ignored: true });
  }

  const action = clean(body.action, 24);
  const startedAt = Number(body.startedAt ?? 0);
  if (startedAt && (Date.now() - startedAt < 700 || Date.now() - startedAt > 7_200_000)) {
    return json({ ok: false, error: "invalid_session" }, 400);
  }

  const ip = clientIp(request);
  const ipHash = await sha256(ip + "|" + RATE_SALT);
  const userAgent = clean(request.headers.get("user-agent"), 300);

  try {
    if (action === "search") {
      const allowed = await consumeRateLimit("search:" + ipHash, 30, 15 * 60);
      if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);
      return json({ ok: true, results: await searchInstitutions(body.query) });
    }

    if (action === "details") {
      const allowed = await consumeRateLimit("details:" + ipHash, 24, 15 * 60);
      if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);
      const details = await institutionDetails(clean(body.accountId, 48));
      if (!details) return json({ ok: false, error: "institution_not_found" }, 404);
      return json({ ok: true, institution: details });
    }

    if (action === "submit") {
      const allowed = await consumeRateLimit("submit:" + ipHash, 3, 24 * 60 * 60);
      if (!allowed) return json({ ok: false, error: "rate_limited" }, 429);
      const result = await submitTrialRequest(body, ipHash, userAgent);
      return json({ ok: true, ...result }, result.duplicate ? 200 : 201);
    }

    return json({ ok: false, error: "invalid_action" }, 400);
  } catch (error) {
    if (error instanceof PublicError) {
      return json({ ok: false, error: error.code }, error.status);
    }
    console.error("marktone-free-trial", error instanceof Error ? error.message : String(error));
    return json({ ok: false, error: "service_unavailable" }, 503);
  }
});

async function searchInstitutions(rawQuery: unknown) {
  const query = normalizedQuery(rawQuery);
  const digits = /^[0-9\s-]+$/.test(query) ? query.replace(/\D/g, "") : "";
  if ((!digits && query.length < 3) || (digits && digits.length < 5)) {
    throw new PublicError("query_too_short", 400);
  }

  const organizationId = await crmOrganizationId();
  const fields = [
    "id", "legal_name", "account_type", "region", "city", "regulatory_status",
    "email", "phone", "mobile", "commercial_registration",
    "national_registration", "updated_at"
  ].join(",");

  const base: Record<string, string> = {
    select: fields,
    organization_id: "eq." + organizationId,
    archived_at: "is.null",
    merged_into_account_id: "is.null",
    limit: "12",
    order: "legal_name.asc,id.asc",
  };

  const requests: Promise<JsonRecord[]>[] = [];
  if (digits) {
    requests.push(restList("accounts", { ...base, commercial_registration: "eq." + digits }));
    requests.push(restList("accounts", { ...base, national_registration: "eq." + digits }));
    requests.push(restList("accounts", { ...base, external_ref: "eq." + digits }));
  } else {
    const patterns = institutionNamePatterns(query);
    if (!patterns.length) throw new PublicError("query_too_short", 400);
    // Each token must match the same name column; token order is irrelevant.
    // Patterns are generated only from letters/numbers, never raw filter syntax.
    for (const column of ["legal_name", "english_name"]) {
      requests.push(restList("accounts", {
        ...base,
        and: "(" + patterns.map((pattern) => column + '.imatch."' + pattern + '"').join(",") + ")",
      }));
    }
  }

  const groups = await Promise.all(requests);
  const unique = new Map<string, JsonRecord>();
  for (const row of groups.flat()) {
    const id = String(row.id ?? "");
    if (id) unique.set(id, row);
  }

  return [...unique.values()]
    .sort((a, b) => scoreResult(b, query, digits) - scoreResult(a, query, digits))
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      name: row.legal_name,
      type: row.account_type,
      city: row.city,
      region: row.region,
      regulatoryStatus: row.regulatory_status,
      officialEmail: maskEmail(row.email),
      officialPhone: maskPhone(row.mobile ?? row.phone),
      registrationHint: maskRegistration(row.national_registration ?? row.commercial_registration),
      exactRegistrationMatch: Boolean(
        digits && [row.national_registration, row.commercial_registration]
          .some((value) => digits === String(value ?? "").replace(/\D/g, ""))
      ),
      updatedAt: row.updated_at,
    }));
}

async function institutionDetails(accountId: string) {
  if (!isUuid(accountId)) return null;
  const organizationId = await crmOrganizationId();
  const accounts = await restList("accounts", {
    select: [
      "id", "legal_name", "account_type", "region", "city", "regulatory_status",
      "email", "phone", "mobile", "commercial_registration",
      "national_registration", "updated_at"
    ].join(","),
    id: "eq." + accountId,
    organization_id: "eq." + organizationId,
    archived_at: "is.null",
    merged_into_account_id: "is.null",
    limit: "1",
  });
  const account = accounts[0];
  if (!account) return null;

  let contact: JsonRecord | null = null;
  const links = await restList("account_contacts", {
    select: "contact_id,is_primary,relationship_type",
    organization_id: "eq." + organizationId,
    account_id: "eq." + accountId,
    is_current: "eq.true",
    order: "is_primary.desc,created_at.asc",
    limit: "1",
  });

  const contactId = clean(links[0]?.contact_id, 48);
  if (isUuid(contactId)) {
    const contacts = await restList("contacts", {
      select: "id,full_name,job_title,department,updated_at",
      id: "eq." + contactId,
      organization_id: "eq." + organizationId,
      limit: "1",
    });
    contact = contacts[0] ?? null;

    if (contact) {
      const channels = await restList("contact_channels", {
        select: "channel_type,channel_value,is_primary,is_verified",
        contact_id: "eq." + contactId,
        organization_id: "eq." + organizationId,
        order: "is_primary.desc,is_verified.desc,created_at.asc",
        limit: "10",
      });
      const email = channels.find((item) => item.channel_type === "email");
      const phone = channels.find((item) =>
        ["mobile", "phone", "whatsapp"].includes(String(item.channel_type ?? ""))
      );
      contact = {
        ...contact,
        email: email?.channel_value ?? null,
        phone: phone?.channel_value ?? null,
      };
    }
  }

  return {
    id: account.id,
    name: account.legal_name,
    type: account.account_type,
    city: account.city,
    region: account.region,
    regulatoryStatus: account.regulatory_status,
    officialEmail: maskEmail(account.email),
    officialPhone: maskPhone(account.mobile ?? account.phone),
    commercialRegistration: maskRegistration(account.commercial_registration),
    nationalRegistration: maskRegistration(account.national_registration),
    responsible: contact ? {
      name: maskPersonName(contact.full_name),
      jobTitle: contact.job_title ?? contact.department ?? "مسؤول المنشأة",
      email: maskEmail(contact.email),
      phone: maskPhone(contact.phone),
    } : null,
    readOnly: true,
    source: "Marktone CRM",
    updatedAt: account.updated_at,
  };
}

async function submitTrialRequest(body: JsonRecord, ipHash: string, userAgent: string) {
  const institutionState = clean(body.institutionState, 20);
  if (!["existing", "new"].includes(institutionState)) {
    throw new PublicError("invalid_institution_state", 400);
  }
  if (body.tvtcAcknowledged !== true || body.privacyConsent !== true) {
    throw new PublicError("consent_required", 400);
  }

  const organizationId = await crmOrganizationId();
  let accountId: string | null = clean(body.accountId, 48) || null;
  let institutionName = clean(body.institutionName, 240);
  let commercialRegistration = digitsOnly(body.commercialRegistration, 24);
  let nationalRegistration = digitsOnly(body.nationalRegistration, 24);

  if (institutionState === "existing") {
    if (!accountId || !isUuid(accountId)) throw new PublicError("institution_required", 400);
    const rows = await restList("accounts", {
      select: "id,legal_name,commercial_registration,national_registration",
      id: "eq." + accountId,
      organization_id: "eq." + organizationId,
      archived_at: "is.null",
      merged_into_account_id: "is.null",
      limit: "1",
    });
    const account = rows[0];
    if (!account) throw new PublicError("institution_not_found", 404);
    institutionName = clean(account.legal_name, 240);
    commercialRegistration = digitsOnly(account.commercial_registration, 24);
    nationalRegistration = digitsOnly(account.national_registration, 24);
  } else {
    accountId = null;
    if (institutionName.length < 2) throw new PublicError("institution_name_required", 400);
  }

  const contactName = clean(body.contactName, 160);
  const contactJobTitle = clean(body.contactJobTitle, 160);
  const contactEmail = clean(body.contactEmail, 240).toLowerCase();
  const contactPhone = normalizedPhone(body.contactPhone);
  const tvtcLicenseNumber = clean(body.tvtcLicenseNumber, 80);

  if (contactName.length < 2) throw new PublicError("contact_name_required", 400);
  if (contactJobTitle.length < 2) throw new PublicError("job_title_required", 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(contactEmail)) {
    throw new PublicError("invalid_email", 400);
  }
  if (contactPhone.replace(/\D/g, "").length < 8) {
    throw new PublicError("invalid_phone", 400);
  }

  const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const duplicateQuery: Record<string, string> = {
    select: "id,request_reference,status,created_at",
    organization_id: "eq." + organizationId,
    contact_email: "eq." + contactEmail,
    created_at: "gte." + recentSince,
    order: "created_at.desc",
    limit: "1",
  };
  if (accountId) duplicateQuery.account_id = "eq." + accountId;
  const duplicates = await restList("marktone_trial_requests", duplicateQuery);
  if (duplicates[0]) {
    return {
      duplicate: true,
      reference: duplicates[0].request_reference,
      status: duplicates[0].status,
      message: "request_already_received",
    };
  }

  const reference = "MT-" + new Date().toISOString().slice(0, 10).replaceAll("-", "")
    + "-" + crypto.randomUUID().slice(0, 6).toUpperCase();

  const insertPayload = {
    request_reference: reference,
    organization_id: organizationId,
    account_id: accountId,
    institution_state: institutionState,
    institution_name: institutionName,
    commercial_registration: commercialRegistration || null,
    national_registration: nationalRegistration || null,
    tvtc_license_number: tvtcLicenseNumber || null,
    contact_name: contactName,
    contact_job_title: contactJobTitle,
    contact_email: contactEmail,
    contact_phone: contactPhone,
    tvtc_notice_acknowledged: true,
    privacy_consent_at: new Date().toISOString(),
    request_ip_hash: ipHash,
    user_agent: userAgent || null,
    metadata: {
      page: "try-free",
      locale: "ar-SA",
      submittedAt: new Date().toISOString(),
    },
  };

  const inserted = await restWrite("marktone_trial_requests", "POST", insertPayload, {
    prefer: "return=representation",
  });
  const requestRow = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!requestRow?.id) throw new Error("trial_request_insert_failed");

  let reviewTaskId: string | null = null;
  try {
    reviewTaskId = await createReviewTask({
      organizationId,
      accountId,
      institutionName,
      reference,
      contactName,
      contactEmail,
      contactPhone,
    });
  } catch (taskError) {
    console.error(
      "marktone-free-trial-review-task",
      taskError instanceof Error ? taskError.message : String(taskError),
    );
  }

  if (reviewTaskId) {
    await restWrite(
      "marktone_trial_requests?request_reference=eq." + encodeURIComponent(reference),
      "PATCH",
      { review_task_id: reviewTaskId, updated_at: new Date().toISOString() },
      { prefer: "return=minimal" },
    );
  }

  return {
    duplicate: false,
    reference,
    status: "pending_review",
    reviewTaskCreated: Boolean(reviewTaskId),
    expectedResponse: "one_business_day",
  };
}

async function createReviewTask(input: {
  organizationId: string;
  accountId: string | null;
  institutionName: string;
  reference: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}) {
  const reviewers = await restList("profiles", {
    select: "id,role",
    organization_id: "eq." + input.organizationId,
    is_active: "eq.true",
    role: "in.(admin,data_steward)",
    order: "role.asc,created_at.asc",
    limit: "1",
  });
  const assignedTo = clean(reviewers[0]?.id, 48);
  if (!isUuid(assignedTo)) return null;

  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    organization_id: input.organizationId,
    account_id: input.accountId,
    assigned_to: assignedTo,
    title: "مراجعة طلب تجربة مجانية — " + input.institutionName,
    description: [
      "مرجع الطلب: " + input.reference,
      "المسؤول: " + input.contactName,
      "البريد: " + input.contactEmail,
      "الجوال: " + input.contactPhone,
      "المصدر: صفحة جرّب الآن مجانًا",
    ].join("\n"),
    priority: "high",
    status: "pending",
    due_at: dueAt,
  };
  const result = await restWrite("tasks", "POST", payload, { prefer: "return=representation" });
  const row = Array.isArray(result) ? result[0] : result;
  return isUuid(clean(row?.id, 48)) ? String(row.id) : null;
}

async function consumeRateLimit(rateKey: string, limit: number, windowSeconds: number) {
  const now = new Date();
  const rows = await restList("marktone_trial_rate_limits", {
    select: "rate_key,window_started_at,hit_count,expires_at",
    rate_key: "eq." + rateKey,
    limit: "1",
  });
  const current = rows[0];
  const expired = !current || new Date(String(current.expires_at)).getTime() <= now.getTime();

  if (expired) {
    const payload = {
      rate_key: rateKey,
      window_started_at: now.toISOString(),
      hit_count: 1,
      expires_at: new Date(now.getTime() + windowSeconds * 1000).toISOString(),
      updated_at: now.toISOString(),
    };
    await restWrite(
      "marktone_trial_rate_limits?on_conflict=rate_key",
      "POST",
      payload,
      { prefer: "resolution=merge-duplicates,return=minimal" },
    );
    return true;
  }

  const hits = Number(current.hit_count ?? 0);
  if (hits >= limit) return false;
  await restWrite(
    "marktone_trial_rate_limits?rate_key=eq." + encodeURIComponent(rateKey),
    "PATCH",
    { hit_count: hits + 1, updated_at: now.toISOString() },
    { prefer: "return=minimal" },
  );
  return true;
}

let cachedOrganizationId: string | null = null;
async function crmOrganizationId() {
  if (cachedOrganizationId) return cachedOrganizationId;
  const configured = clean(Deno.env.get("MARKTONE_CRM_ORGANIZATION_ID"), 48);
  if (isUuid(configured)) {
    cachedOrganizationId = configured;
    return configured;
  }
  const rows = await restList("organizations", {
    select: "id",
    slug: "eq.marktone",
    limit: "1",
  });
  const fallback = rows[0] ?? (await restList("organizations", {
    select: "id",
    order: "created_at.asc",
    limit: "1",
  }))[0];
  const id = clean(fallback?.id, 48);
  if (!isUuid(id)) throw new Error("crm_organization_missing");
  cachedOrganizationId = id;
  return id;
}

async function restList(table: string, params: Record<string, string>) {
  const url = new URL(SUPABASE_URL + "/rest/v1/" + table);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: serviceHeaders(),
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    throw new Error("rest_read_failed:" + table + ":" + response.status + ":" + await response.text());
  }
  const value = await response.json();
  if (!Array.isArray(value)) throw new Error("rest_read_invalid:" + table);
  return value as JsonRecord[];
}

async function restWrite(
  path: string,
  method: "POST" | "PATCH",
  payload: unknown,
  options: { prefer: string },
) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + path, {
    method,
    headers: { ...serviceHeaders(), "content-type": "application/json", prefer: options.prefer },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error("rest_write_failed:" + path + ":" + response.status + ":" + await response.text());
  }
  if (response.status === 204 || options.prefer.includes("return=minimal")) return null;
  return response.json();
}

function serviceHeaders() {
  return {
    apikey: SERVICE_ROLE_KEY,
    authorization: "Bearer " + SERVICE_ROLE_KEY,
  };
}

function scoreResult(row: JsonRecord, query: string, digits: string) {
  if (digits) {
    const exact = [row.national_registration, row.commercial_registration]
      .some((value) => digits === String(value ?? "").replace(/\D/g, ""));
    return exact ? 100 : 60;
  }
  const name = normalizeArabic(String(row.legal_name ?? "")).toLowerCase();
  const needle = normalizeArabic(query).toLowerCase();
  if (name === needle) return 100;
  if (name.startsWith(needle)) return 90;
  return name.includes(needle) ? 75 : 40;
}

function normalizedQuery(value: unknown) {
  return normalizeArabic(clean(value, 80))
    .replace(/[<>{}[\]\\|^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeArabic(value: string) {
  return value.normalize("NFKC")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[ـ\u064B-\u065F\u0670]/g, "")
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0));
}

// Normalize both sides through a bounded, generated PostgreSQL regex. Keep
// all organization/archive/merge predicates and existing masked response fields.
function institutionNamePatterns(query: string) {
  const tokens = query.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/).filter(Boolean);
  if (tokens.join("").length < 3) return [];
  const variants: Record<string, string> = {
    "ا": "[اأإآٱ]", "ي": "[يىئ]", "و": "[وؤ]", "ه": "[هة]", "ة": "[هة]",
  };
  const trainingWords = new Set(["التدريب", "للتدريب", "تدريب", "التدريبي", "التدريبية", "التدريبيه", "تدريبي", "تدريبية", "تدريبيه"]);
  return [...new Set(tokens.map((token) => trainingWords.has(token) ? "تدريب" : token))]
    .map((token) => [...token].map((character) => {
      if (/^[0-9]$/.test(character)) {
        const digit = Number(character);
        return "[" + character + String.fromCharCode(0x0660 + digit) + String.fromCharCode(0x06F0 + digit) + "]";
      }
      return variants[character] || character;
    }).join("[ـً-ٰٟ]*"));
}

function clean(value: unknown, max: number) {
  return String(value ?? "").normalize("NFKC").replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

function digitsOnly(value: unknown, max: number) {
  return clean(value, max * 2).replace(/\D/g, "").slice(0, max);
}

function normalizedPhone(value: unknown) {
  const raw = clean(value, 40);
  const digits = raw.replace(/\D/g, "").slice(0, 15);
  return raw.startsWith("+") ? "+" + digits : digits;
}

function maskEmail(value: unknown) {
  const email = clean(value, 240).toLowerCase();
  const [local, domain] = email.split("@");
  if (!local || !domain) return null;
  const head = local.slice(0, Math.min(2, local.length));
  return head + "***@" + domain;
}

function maskPhone(value: unknown) {
  const raw = clean(value, 40);
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 5) return null;
  const prefix = raw.startsWith("+") ? "+" + digits.slice(0, 3) : digits.slice(0, 2);
  return prefix + " •• ••• " + digits.slice(-2);
}

function maskRegistration(value: unknown) {
  const digits = clean(value, 40).replace(/\D/g, "");
  if (digits.length < 4) return null;
  return "••••••" + digits.slice(-4);
}

function maskPersonName(value: unknown) {
  const words = clean(value, 160).split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  return words.map((word) => word.slice(0, 1) + "••").join(" ");
}

function clientIp(request: Request) {
  return clean(
    request.headers.get("cf-connecting-ip")
      ?? request.headers.get("x-real-ip")
      ?? request.headers.get("x-forwarded-for")?.split(",")[0]
      ?? "unknown",
    80,
  );
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function json(payload: unknown, status = 200) {
  if (payload instanceof PublicError) {
    return new Response(JSON.stringify({ ok: false, error: payload.code }), {
      status: payload.status,
      headers: JSON_HEADERS,
    });
  }
  return new Response(JSON.stringify(payload), { status, headers: JSON_HEADERS });
}

class PublicError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

