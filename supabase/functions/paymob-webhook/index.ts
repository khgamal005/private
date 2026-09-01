import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  BodyTooLargeError,
  fetchTextWithTimeout,
  isJsonContentType,
  isPlainObject,
  jsonResponse,
  normalizePaymobTransaction,
  parseJsonObject,
  paymobTransactionHmacInput,
  PaymobInputError,
  readTextLimited,
  requiredSafeInteger,
  requiredText,
  sha256Hex,
  verifyPaymobTransactionHmac,
  type JsonObject,
} from "../_shared/paymob.ts";

const MAX_CALLBACK_BYTES = 128 * 1024;
const MAX_RPC_BYTES = 64 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const MAX_HMAC_CANDIDATES = 2;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type WebhookHmacCandidate = {
  credentialVersionId: string;
  environment: "sandbox" | "live";
  hmacSecret: string;
  integrationId: string;
  owner: string;
};

type WebhookRuntime = {
  hmacCandidates: WebhookHmacCandidate[];
};

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false }, { allow: "POST" });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonResponse(415, { ok: false });
  }

  const suppliedHmac = new URL(request.url).searchParams.getAll("hmac");
  if (suppliedHmac.length !== 1 || !/^[0-9a-fA-F]{128}$/.test(suppliedHmac[0])) {
    return jsonResponse(401, { ok: false });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse(503, { ok: false });

  try {
    // Keep the untouched callback only in request-scoped memory. It is never
    // forwarded, persisted, or logged; only its SHA-256 digest crosses the RPC.
    const rawBody = await readTextLimited(request, MAX_CALLBACK_BYTES);
    const payload = parseJsonObject(rawBody);
    if (payload.type !== "TRANSACTION" || !isPlainObject(payload.obj)) {
      return jsonResponse(400, { ok: false });
    }

    // Reject malformed callback structures before any Vault-backed runtime
    // lookup. This normalization is validation only and cannot mutate payment
    // state; HMAC verification remains mandatory before the ingest RPC.
    const transaction = normalizePaymobTransaction(payload.obj);
    paymobTransactionHmacInput(payload.obj);

    const runtime = await getWebhookRuntime(supabaseUrl, serviceRoleKey);
    // Always evaluate every bounded current/retiring candidate before
    // branching. The signed account identifiers must select exactly one
    // cryptographically valid credential version; ambiguity is rejected.
    const verificationResults = await Promise.all(
      runtime.hmacCandidates.map((candidate) =>
        verifyPaymobTransactionHmac(
          payload.obj as JsonObject,
          suppliedHmac[0],
          candidate.hmacSecret,
        )
      ),
    );
    const matches = runtime.hmacCandidates.filter((candidate, index) =>
      verificationResults[index] &&
      candidate.integrationId === transaction.integrationId &&
      candidate.owner === transaction.owner
    );
    if (matches.length !== 1) return jsonResponse(401, { ok: false });
    const matchedCandidate = matches[0];

    const payloadHash = await sha256Hex(rawBody);

    // PAN is used transiently by the HMAC recipe inside the verifier only. It
    // is deliberately absent from this normalized persistence contract.
    await ingestVerifiedTransaction(supabaseUrl, serviceRoleKey, {
      p_environment: matchedCandidate.environment,
      p_credential_version_id: matchedCandidate.credentialVersionId,
      p_provider_transaction_id: transaction.providerTransactionId,
      p_provider_order_id: transaction.providerOrderId,
      p_special_reference: transaction.specialReference,
      p_integration_id: transaction.integrationId,
      p_owner: transaction.owner,
      p_amount_minor: transaction.amountMinor,
      p_currency: transaction.currency,
      p_provider_created_at: transaction.createdAt,
      p_success: transaction.success,
      p_pending: transaction.pending,
      p_error_occured: transaction.errorOccurred,
      p_has_parent_transaction: transaction.hasParentTransaction,
      p_is_3d_secure: transaction.is3dSecure,
      p_is_auth: transaction.isAuth,
      p_is_capture: transaction.isCapture,
      p_is_refunded: transaction.isRefunded,
      p_is_standalone_payment: transaction.isStandalonePayment,
      p_is_voided: transaction.isVoided,
      p_payload_sha256: payloadHash,
      p_hmac_verified: true,
    });

    // Minimal acknowledgement: never disclose order, tenant, matching, or
    // processing details to the unauthenticated provider endpoint.
    return jsonResponse(200, { ok: true });
  } catch (error) {
    if (error instanceof BodyTooLargeError) return jsonResponse(413, { ok: false });
    if (error instanceof PaymobInputError) return jsonResponse(400, { ok: false });
    return jsonResponse(503, { ok: false });
  }
});

async function getWebhookRuntime(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<WebhookRuntime> {
  const result = await serviceRpc(
    supabaseUrl,
    serviceRoleKey,
    "v1_service_paymob_runtime_config",
    { p_attempt_id: null, p_purpose: "verify_webhook" },
  );
  const allowedRuntimeKeys = new Set([
    "schemaVersion",
    "purpose",
    "providerKey",
    "region",
    "apiBaseUrl",
    "hmacCandidates",
  ]);
  if (
    result.schemaVersion !== 1 ||
    result.purpose !== "verify_webhook" ||
    result.providerKey !== "paymob" ||
    Object.keys(result).some((key) => !allowedRuntimeKeys.has(key))
  ) throw new PaymobInputError("invalid_runtime_config");
  const region = requiredText(result.region, "region", 16);
  const apiBase = requiredText(result.apiBaseUrl, "api_base_url", 120).replace(/\/$/, "");
  if (
    region !== "ksa" ||
    apiBase !== "https://ksa.paymob.com"
  ) throw new PaymobInputError("invalid_runtime_config");

  if (
    !Array.isArray(result.hmacCandidates) ||
    result.hmacCandidates.length < 1 ||
    result.hmacCandidates.length > MAX_HMAC_CANDIDATES
  ) throw new PaymobInputError("invalid_runtime_config");

  const hmacCandidates = result.hmacCandidates.map((value) => {
    if (!isPlainObject(value)) throw new PaymobInputError("invalid_runtime_config");
    const allowedCandidateKeys = new Set([
      "credentialVersionId",
      "environment",
      "integrationId",
      "owner",
      "hmacSecret",
    ]);
    if (Object.keys(value).some((key) => !allowedCandidateKeys.has(key))) {
      throw new PaymobInputError("invalid_runtime_config");
    }
    const credentialVersionId = requiredText(
      value.credentialVersionId,
      "credential_version_id",
      36,
    );
    const environment = requiredText(value.environment, "environment", 16);
    if (!UUID.test(credentialVersionId) || !["sandbox", "live"].includes(environment)) {
      throw new PaymobInputError("invalid_runtime_config");
    }
    const integrationId = providerIdentifier(value.integrationId, "integration_id");
    const owner = providerIdentifier(value.owner, "owner");
    // The database repeats these signed account comparisons atomically against
    // the stored attempt and the matched credential version.
    requiredSafeInteger(integrationId, "integration_id", 1);
    requiredSafeInteger(owner, "owner", 1);
    return {
      credentialVersionId,
      environment: environment as WebhookHmacCandidate["environment"],
      hmacSecret: requiredText(value.hmacSecret, "hmac_secret", 8192),
      integrationId,
      owner,
    };
  });
  if (new Set(hmacCandidates.map((candidate) => candidate.credentialVersionId)).size !==
    hmacCandidates.length) {
    throw new PaymobInputError("invalid_runtime_config");
  }
  return { hmacCandidates };
}

async function ingestVerifiedTransaction(
  supabaseUrl: string,
  serviceRoleKey: string,
  body: JsonObject,
): Promise<void> {
  await serviceRpc(
    supabaseUrl,
    serviceRoleKey,
    "v1_service_paymob_ingest_verified_transaction",
    body,
  );
}

async function serviceRpc(
  supabaseUrl: string,
  serviceRoleKey: string,
  name: string,
  body: JsonObject,
): Promise<JsonObject> {
  const result = await fetchTextWithTimeout(
    `${supabaseUrl}/rest/v1/rpc/${name}`,
    {
      method: "POST",
      redirect: "error",
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    },
    RPC_TIMEOUT_MS,
    MAX_RPC_BYTES,
  );
  const response = result.response;
  const raw = result.text;
  if (!response.ok) throw new Error("rpc_failed");
  if (!raw) return {};
  return parseJsonObject(raw);
}

function providerIdentifier(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  throw new PaymobInputError(`invalid_${field}`);
}
