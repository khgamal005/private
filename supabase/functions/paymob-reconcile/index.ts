import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return respond(
      405,
      { ok: false, error: "method_not_allowed" },
      { allow: "POST" },
    );
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  if (!/^Bearer\s+\S{20,8192}$/.test(authorization)) {
    return respond(401, { ok: false, error: "unauthorized" });
  }
  if (!supabaseUrl || !anonKey) {
    return respond(503, { ok: false, error: "service_unavailable" });
  }

  try {
    const raw = await readLimited(request, MAX_REQUEST_BYTES);
    let maxJobs = 3;
    if (raw.trim()) {
      if (!isJson(request.headers.get("content-type"))) {
        return respond(415, { ok: false, error: "unsupported_media_type" });
      }
      const input: unknown = JSON.parse(raw);
      if (
        !input ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((key) => key !== "maxJobs")
      ) {
        return respond(400, { ok: false, error: "invalid_request" });
      }
      const requested = (input as Record<string, unknown>).maxJobs;
      if (requested !== undefined) {
        if (
!Number.isSafeInteger(requested) ||
Number(requested) < 1 ||
Number(requested) > 10
        ) {
return respond(400, { ok: false, error: "invalid_max_jobs" });
        }
        maxJobs = Number(requested);
      }
    }

    const upstream = await fetch(
      `${supabaseUrl}/rest/v1/rpc/v2_platform_paymob_reconcile_now`,
      {
        method: "POST",
        redirect: "error",
        headers: {
apikey: anonKey,
authorization,
"content-type": "application/json",
accept: "application/json",
        },
        body: JSON.stringify({ p_max_jobs: maxJobs }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const body = await readLimited(upstream, MAX_RESPONSE_BYTES);
    let payload: unknown = { ok: false, error: "invalid_upstream_response" };
    if (body.trim()) {
      try {
        payload = JSON.parse(body);
      } catch {
        payload = { ok: false, error: "invalid_upstream_response" };
      }
    }
    return respond(upstream.status, payload);
  } catch (error) {
    const name = error instanceof Error ? error.name : "UnknownError";
    if (name === "BodyTooLargeError") {
      return respond(413, { ok: false, error: "payload_too_large" });
    }
    if (name === "AbortError" || name === "TimeoutError") {
      return respond(504, { ok: false, error: "reconciliation_timeout" });
    }
    return respond(503, { ok: false, error: "service_unavailable" });
  }
});

function isJson(value: string | null): boolean {
  return Boolean(value) &&
    value!.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

async function readLimited(
  source: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maximum: number,
): Promise<string> {
  const declared = source.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maximum) {
    await source.body?.cancel("body_too_large").catch(() => {});
    throw Object.assign(new Error("body_too_large"), {
      name: "BodyTooLargeError",
    });
  }
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel("body_too_large").catch(() => {});
        throw Object.assign(new Error("body_too_large"), {
name: "BodyTooLargeError",
        });
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function respond(
  status: number,
  payload: unknown,
  extra: HeadersInit = {},
): Response {
  const headers = new Headers(extra);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=()",
  );
  return new Response(JSON.stringify(payload), { status, headers });
}
