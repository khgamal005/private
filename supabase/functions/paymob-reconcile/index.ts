import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  BodyTooLargeError,
  fetchTextWithTimeout,
  isJsonContentType,
  jsonResponse,
  parseJsonObject,
  PaymobInputError,
  readTextLimited,
  requiredSafeInteger,
  requiredText,
  sha256Hex,
  UpstreamTimeoutError,
  type JsonObject,
} from "../_shared/paymob.ts";
import {
  normalizePaymobInquiry,
  paymobProviderIdentifier,
  type NormalizedInquiry,
} from "./normalize.ts";

const PAYMOB_API_BASE_URL = "https://ksa.paymob.com";
const PAYMOB_AUTH_URL = `${PAYMOB_API_BASE_URL}/api/auth/tokens`;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RPC_BYTES = 64 * 1024;
const MAX_PROVIDER_BYTES = 128 * 1024;
const RPC_TIMEOUT_MS = 8_000;
const PAYMOB_TIMEOUT_MS = 12_000;
const LEASE_SECONDS = 90;
const CHECKOUT_SECRET_CLEANUP_LIMIT = 25;
const DEFAULT_MAX_JOBS = 3;
const MAX_JOBS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECONCILIATION_RUNTIME_KEYS = new Set([
  "schemaVersion",
  "purpose",
  "jobId",
  "providerKey",
  "apiBaseUrl",
  "apiKey",
  "environment",
  "credentialVersionId",
  "attemptCredentialVersionId",
  "inquiryCredentialVersionId",
  "integrationId",
  "owner",
  "attemptId",
  "specialReference",
  "providerTransactionId",
  "inquiryMode",
  "merchantOrderId",
  "inquiryMethod",
  "inquiryPath",
]);

type ReconciliationOutcome =
  | "retry"
  | "ambiguous"
  | "failed"
  | "review_required";

type ReconciliationJob = {
  jobId: string;
  leaseToken: string;
  attemptId: string;
  environment: "sandbox" | "live";
  type:
    | "intention_unknown"
    | "transaction_inquiry"
    | "binding_mismatch"
    | "refund_inquiry";
  providerTransactionId: string | null;
  providerOrderId: string | null;
  attemptNumber: number;
  leaseExpiresAt: string;
};

type ClaimResult = ReconciliationJob | "maintenance" | null;

type ReconciliationRuntime = {
  apiKey: string;
  apiBaseUrl: typeof PAYMOB_API_BASE_URL;
  attemptId: string;
  credentialVersionId: string;
  attemptCredentialVersionId: string;
  inquiryCredentialVersionId: string;
  inquiryMode: "transaction_id" | "merchant_order_id";
  inquiryMethod: "GET" | "POST";
  inquiryPath: string;
  providerTransactionId: string | null;
  merchantOrderId: string;
  environment: "sandbox" | "live";
};

type CheckoutSecretCleanupCounts = {
  scanned: number;
  deleted: number;
  failed: number;
  expiredQueued: number;
};

class ProviderFailure extends Error {
  readonly outcome: ReconciliationOutcome;
  readonly code: string;
  readonly stopBatch: boolean;

  constructor(
    outcome: ReconciliationOutcome,
    code: string,
    stopBatch = false,
  ) {
    super(code);
    this.name = "ProviderFailure";
    this.outcome = outcome;
    this.code = code;
    this.stopBatch = stopBatch;
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return jsonResponse(
      405,
      { ok: false, error: "method_not_allowed" },
      { allow: "POST" },
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(503, { ok: false, error: "service_unavailable" });
  }

  try {
    const authorized = await authorizeDispatcher(
      request,
      supabaseUrl,
      anonKey,
    );
    if (!authorized) {
      return jsonResponse(401, { ok: false, error: "unauthorized" });
    }

    const maxJobs = await readMaxJobs(request);
    let cleanupUnavailable = false;
    let checkoutSecretCleanup: CheckoutSecretCleanupCounts = {
      scanned: 0,
      deleted: 0,
      failed: 0,
      expiredQueued: 0,
    };
    try {
      checkoutSecretCleanup = normalizeCheckoutSecretCleanup(
        await serviceRpc(
          supabaseUrl,
          serviceRoleKey,
          "v1_service_paymob_cleanup_checkout_secrets",
          { p_limit: CHECKOUT_SECRET_CLEANUP_LIMIT },
        ),
      );
    } catch {
      // Secret deletion is an isolated maintenance concern. Never guess at a
      // Vault mutation or hide the independent reconciliation queue health.
      cleanupUnavailable = true;
    }
    const workerId = crypto.randomUUID();
    // This Map is constructed inside one Deno.serve invocation and is never
    // copied to module/global state, storage, logs, or a response.
    const tokenCache = new Map<string, string>();
    let claimed = 0;
    let processed = 0;
    let rescheduled = 0;
    let reviewRequired = 0;
    let maintenanceProcessed = 0;
    let queueUnavailable = false;

    for (let index = 0; index < maxJobs; index += 1) {
      let claim: ClaimResult;
      try {
        claim = await claimJob(supabaseUrl, serviceRoleKey, workerId);
      } catch {
        queueUnavailable = true;
        break;
      }
      if (claim === "maintenance") {
        maintenanceProcessed += 1;
        continue;
      }
      if (!claim) break;
      const job = claim;
      claimed += 1;

      let stopBatch = false;
      try {
        let runtimePayload: JsonObject;
        try {
          runtimePayload = await serviceRpc(
            supabaseUrl,
            serviceRoleKey,
            "v1_service_paymob_reconciliation_runtime",
            {
              p_job_id: job.jobId,
              p_lease_token: job.leaseToken,
              p_worker_id: workerId,
            },
          );
        } catch {
          throw new ProviderFailure(
            "ambiguous",
            "reconciliation_runtime_unavailable",
            true,
          );
        }
        let runtime: ReconciliationRuntime;
        try {
          runtime = normalizeRuntime(runtimePayload, job);
        } catch {
          throw new ProviderFailure(
            "review_required",
            "invalid_reconciliation_runtime",
            true,
          );
        }
        const fingerprint = await sha256Hex(
          `${runtime.environment}\u0000${runtime.apiKey}`,
        );
        let authToken: string;
        const cachedToken = tokenCache.get(fingerprint);
        if (cachedToken) {
          authToken = cachedToken;
        } else {
          authToken = await generateAuthToken(runtime.apiKey);
          tokenCache.set(fingerprint, authToken);
        }

        // A known provider transaction always takes the most specific GET.
        // For an ambiguous Intention create, the official Paymob collection
        // documents special_reference as merchant_order_id, so the immutable
        // attempt UUID safely recovers the last transaction without creating
        // another Intention.
        const providerResult = runtime.inquiryMode === "transaction_id"
          ? await inquireByTransactionId(
            runtime.providerTransactionId as string,
            authToken,
          )
          : await inquireByMerchantOrderId(runtime.merchantOrderId, authToken);
        const responseSha256 = await sha256Hex(providerResult.raw);
        let inquiry: NormalizedInquiry;
        try {
          inquiry = normalizePaymobInquiry(parseJsonObject(providerResult.raw));
        } catch {
          throw new ProviderFailure(
            "ambiguous",
            "provider_invalid_inquiry_response",
            true,
          );
        }

        // This applicator is the only component allowed to interpret an
        // authoritative inquiry against immutable attempt bindings. The Edge
        // worker never updates an order, refund, subscription, or entitlement.
        let applicationResult: JsonObject;
        try {
          applicationResult = await serviceRpc(
            supabaseUrl,
            serviceRoleKey,
            "v1_service_paymob_reconciliation_apply",
            {
              p_job_id: job.jobId,
              p_lease_token: job.leaseToken,
              p_worker_id: workerId,
              p_inquiry_mode: providerResult.mode,
              p_inquiry_credential_version_id:
                runtime.inquiryCredentialVersionId,
              p_provider_transaction_id: inquiry.providerTransactionId,
              p_provider_order_id: inquiry.providerOrderId,
              p_merchant_order_id: inquiry.merchantOrderId,
              p_integration_id: inquiry.integrationId,
              p_owner: inquiry.owner,
              p_amount_minor: inquiry.amountMinor,
              p_currency: inquiry.currency,
              p_order_paid_amount_minor: inquiry.orderPaidAmountMinor,
              p_success: inquiry.success,
              p_pending: inquiry.pending,
              p_error_occured: inquiry.errorOccurred,
              p_is_auth: inquiry.isAuth,
              p_is_capture: inquiry.isCapture,
              p_is_standalone_payment: inquiry.isStandalonePayment,
              p_has_parent_transaction: inquiry.hasParentTransaction,
              p_is_refunded: inquiry.isRefunded,
              p_is_voided: inquiry.isVoided,
              p_cumulative_refunded_minor: inquiry.cumulativeRefundedMinor,
              p_response_sha256: responseSha256,
            },
          );
        } catch {
          throw new ProviderFailure(
            "ambiguous",
            "reconciliation_applicator_unavailable",
            true,
          );
        }
        // This means the database applicator accepted and classified the
        // authoritative evidence. It does not imply the order was paid.
        processed += 1;
        const disposition = applicationDisposition(applicationResult);
        if (disposition === "review_required") reviewRequired += 1;
        if (disposition === "rescheduled") rescheduled += 1;
      } catch (error) {
        const failure = error instanceof ProviderFailure
          ? error
          : new ProviderFailure(
            "ambiguous",
            "reconciliation_applicator_unavailable",
            true,
          );
        await rescheduleBestEffort(
          supabaseUrl,
          serviceRoleKey,
          workerId,
          job,
          failure.outcome,
          failure.code,
        );
        if (failure.outcome === "review_required") reviewRequired += 1;
        else rescheduled += 1;
        stopBatch = failure.stopBatch;
      }
      if (stopBatch) break;
    }

    if (queueUnavailable) {
      return jsonResponse(503, {
        ok: false,
        error: "reconciliation_queue_unavailable",
        claimed,
        processed,
        rescheduled,
        reviewRequired,
        maintenanceProcessed,
        cleanupUnavailable,
        checkoutSecretsScanned: checkoutSecretCleanup.scanned,
        checkoutSecretsDeleted: checkoutSecretCleanup.deleted,
        checkoutSecretsFailed: checkoutSecretCleanup.failed,
        expiredCheckoutsQueued: checkoutSecretCleanup.expiredQueued,
      });
    }
    return jsonResponse(200, {
      ok: true,
      claimed,
      processed,
      rescheduled,
      reviewRequired,
      maintenanceProcessed,
      cleanupUnavailable,
      checkoutSecretsScanned: checkoutSecretCleanup.scanned,
      checkoutSecretsDeleted: checkoutSecretCleanup.deleted,
      checkoutSecretsFailed: checkoutSecretCleanup.failed,
      expiredCheckoutsQueued: checkoutSecretCleanup.expiredQueued,
    });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse(413, { ok: false, error: "payload_too_large" });
    }
    if (error instanceof PaymobInputError) {
      return jsonResponse(
        error.code === "unsupported_media_type" ? 415 : 400,
        { ok: false, error: error.code },
      );
    }
    return jsonResponse(503, { ok: false, error: "service_unavailable" });
  }
});

async function authorizeDispatcher(
  request: Request,
  supabaseUrl: string,
  anonKey: string,
): Promise<boolean> {
  const configuredSecret = Deno.env.get(
    "PAYMOB_RECONCILE_DISPATCHER_SECRET",
  )?.trim() ?? "";
  const suppliedSecret = request.headers.get(
    "x-odeir-paymob-reconcile-secret",
  )?.trim() ?? "";

  if (
    configuredSecret.length >= 32 &&
    configuredSecret.length <= 1024 &&
    suppliedSecret.length >= 32 &&
    suppliedSecret.length <= 1024 &&
    await secretEqual(configuredSecret, suppliedSecret)
  ) return true;

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!/^Bearer\s+\S{20,8192}$/.test(authorization)) return false;

  try {
    const result = await fetchTextWithTimeout(
      `${supabaseUrl}/rest/v1/rpc/v3_platform_payment_provider_admin_snapshot`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          apikey: anonKey,
          authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: "{}",
      },
      RPC_TIMEOUT_MS,
      MAX_RPC_BYTES,
    );
    if (!result.response.ok) return false;
    const snapshot = parseJsonObject(result.text);
    const actorSubjectId = requiredText(
      snapshot.actorSubjectId,
      "actor_subject_id",
      36,
    );
    return UUID.test(actorSubjectId);
  } catch {
    return false;
  }
}

async function readMaxJobs(request: Request): Promise<number> {
  const raw = await readTextLimited(request, MAX_REQUEST_BYTES);
  if (!raw.trim()) return DEFAULT_MAX_JOBS;
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new PaymobInputError("unsupported_media_type");
  }
  const input = parseJsonObject(raw);
  if (Object.keys(input).some((key) => key !== "maxJobs")) {
    throw new PaymobInputError("invalid_request");
  }
  if (input.maxJobs === undefined) return DEFAULT_MAX_JOBS;
  return requiredSafeInteger(input.maxJobs, "max_jobs", 1, MAX_JOBS);
}

function normalizeCheckoutSecretCleanup(
  payload: JsonObject,
): CheckoutSecretCleanupCounts {
  if (requiredSafeInteger(payload.schemaVersion, "schema_version", 1, 1) !== 1) {
    throw new PaymobInputError("invalid_checkout_secret_cleanup");
  }
  const scanned = requiredSafeInteger(
    payload.scanned,
    "cleanup_scanned",
    0,
    CHECKOUT_SECRET_CLEANUP_LIMIT,
  );
  const deleted = requiredSafeInteger(
    payload.deleted,
    "cleanup_deleted",
    0,
    CHECKOUT_SECRET_CLEANUP_LIMIT,
  );
  const failed = requiredSafeInteger(
    payload.failed,
    "cleanup_failed",
    0,
    CHECKOUT_SECRET_CLEANUP_LIMIT,
  );
  const expiredQueued = requiredSafeInteger(
    payload.expiredQueued,
    "cleanup_expired_queued",
    0,
    CHECKOUT_SECRET_CLEANUP_LIMIT,
  );
  if (deleted + failed !== scanned) {
    throw new PaymobInputError("invalid_checkout_secret_cleanup");
  }
  return { scanned, deleted, failed, expiredQueued };
}

function applicationDisposition(
  payload: JsonObject,
): "matched" | "rescheduled" | "review_required" | null {
  // Direct applicator results carry outcome. A branch delegated to the
  // bounded rescheduler carries status instead. Full-refund results may also
  // contain an unrelated refund status, so a recognized outcome wins.
  if (payload.outcome === "matched") return "matched";
  if (payload.outcome === "pending") return "rescheduled";
  if (payload.outcome === "review_required") return "review_required";
  if (payload.outcome !== undefined) return null;
  if (payload.status === "queued" || payload.status === "failed") {
    return "rescheduled";
  }
  if (payload.status === "review_required") return "review_required";
  return null;
}

async function claimJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  workerId: string,
): Promise<ClaimResult> {
  const payload = await serviceRpc(
    supabaseUrl,
    serviceRoleKey,
    "v1_service_paymob_reconciliation_claim",
    { p_worker_id: workerId, p_lease_seconds: LEASE_SECONDS },
  );
  if (payload.claimed === false) {
    if (payload.maintenanceProcessed === true) {
      if (
        requiredSafeInteger(payload.schemaVersion, "schema_version", 1, 1) !== 1
        || Object.keys(payload).some((key) => ![
          "schemaVersion",
          "claimed",
          "maintenanceProcessed",
        ].includes(key))
      ) throw new PaymobInputError("invalid_reconciliation_claim");
      return "maintenance";
    }
    return null;
  }
  if (payload.jobId === null) return null;

  if (requiredSafeInteger(payload.schemaVersion, "schema_version", 1, 1) !== 1) {
    throw new PaymobInputError("invalid_reconciliation_claim");
  }
  const environment = requiredText(payload.environment, "environment", 16);
  const type = requiredText(
    payload.reconciliationType,
    "reconciliation_type",
    40,
  );
  if (
    !["sandbox", "live"].includes(environment) ||
    ![
      "intention_unknown",
      "transaction_inquiry",
      "binding_mismatch",
      "refund_inquiry",
    ].includes(type)
  ) throw new PaymobInputError("invalid_reconciliation_claim");

  const leaseExpiresAt = requiredText(
    payload.leaseExpiresAt,
    "lease_expires_at",
    80,
  );
  if (!Number.isFinite(Date.parse(leaseExpiresAt))) {
    throw new PaymobInputError("invalid_reconciliation_claim");
  }

  const attemptId = requiredUuid(payload.attemptId, "attempt_id");
  const specialReference = requiredUuid(
    payload.specialReference,
    "special_reference",
  );
  const returnedWorkerId = requiredText(payload.workerId, "worker_id", 80);
  if (specialReference !== attemptId || returnedWorkerId !== workerId) {
    throw new PaymobInputError("invalid_reconciliation_claim");
  }
  const attemptNumber = requiredSafeInteger(
    payload.attemptNumber,
    "attempt_number",
    1,
    100,
  );
  const maxAttempts = requiredSafeInteger(
    payload.maxAttempts,
    "max_attempts",
    1,
    100,
  );
  if (attemptNumber > maxAttempts) {
    throw new PaymobInputError("invalid_reconciliation_claim");
  }
  const job: ReconciliationJob = {
    jobId: requiredUuid(payload.jobId, "job_id"),
    leaseToken: requiredUuid(payload.leaseToken, "lease_token"),
    attemptId,
    environment: environment as ReconciliationJob["environment"],
    type: type as ReconciliationJob["type"],
    providerTransactionId: optionalProviderIdentifier(
      payload.providerTransactionId,
      "provider_transaction_id",
    ),
    providerOrderId: optionalProviderIdentifier(
      payload.providerOrderId,
      "provider_order_id",
    ),
    attemptNumber,
    leaseExpiresAt,
  };
  return job;
}

function normalizeRuntime(
  payload: JsonObject,
  job: ReconciliationJob,
): ReconciliationRuntime {
  if (
    Object.keys(payload).some((key) => !RECONCILIATION_RUNTIME_KEYS.has(key))
  ) throw new PaymobInputError("invalid_reconciliation_runtime");
  const apiBaseUrl = requiredText(payload.apiBaseUrl, "api_base_url", 120)
    .replace(/\/$/, "");
  const schemaVersion = requiredSafeInteger(
    payload.schemaVersion,
    "schema_version",
    1,
    1,
  );
  const purpose = requiredText(payload.purpose, "purpose", 40);
  const jobId = requiredUuid(payload.jobId, "job_id");
  const providerKey = requiredText(payload.providerKey, "provider_key", 20);
  const environment = requiredText(payload.environment, "environment", 16);
  const attemptId = requiredUuid(payload.attemptId, "attempt_id");
  const specialReference = requiredUuid(
    payload.specialReference,
    "special_reference",
  );
  const credentialVersionId = requiredUuid(
    payload.credentialVersionId,
    "credential_version_id",
  );
  const attemptCredentialVersionId = requiredUuid(
    payload.attemptCredentialVersionId,
    "attempt_credential_version_id",
  );
  const inquiryCredentialVersionId = requiredUuid(
    payload.inquiryCredentialVersionId,
    "inquiry_credential_version_id",
  );
  paymobProviderIdentifier(payload.integrationId, "integration_id");
  paymobProviderIdentifier(payload.owner, "owner");
  const inquiryMode = requiredText(payload.inquiryMode, "inquiry_mode", 40);
  const inquiryMethod = requiredText(
    payload.inquiryMethod,
    "inquiry_method",
    8,
  ).toUpperCase();
  const providerTransactionId = optionalProviderIdentifier(
    payload.providerTransactionId,
    "provider_transaction_id",
  );
  const merchantOrderId = requiredUuid(
    payload.merchantOrderId,
    "merchant_order_id",
  );
  const inquiryPath = requiredText(payload.inquiryPath, "inquiry_path", 200);
  const expectedMode = job.providerTransactionId
    ? "transaction_id"
    : "merchant_order_id";
  const expectedMethod = job.providerTransactionId ? "GET" : "POST";
  const expectedPath = job.providerTransactionId
    ? `/api/acceptance/transactions/${job.providerTransactionId}`
    : "/api/ecommerce/orders/transaction_inquiry";
  if (
    schemaVersion !== 1 ||
    purpose !== "reconciliation_inquiry" ||
    jobId !== job.jobId ||
    providerKey !== "paymob" ||
    apiBaseUrl !== PAYMOB_API_BASE_URL ||
    environment !== job.environment ||
    attemptId !== job.attemptId ||
    specialReference !== job.attemptId ||
    merchantOrderId !== job.attemptId ||
    credentialVersionId !== inquiryCredentialVersionId ||
    inquiryMode !== expectedMode ||
    inquiryMethod !== expectedMethod ||
    inquiryPath !== expectedPath ||
    providerTransactionId !== job.providerTransactionId
  ) throw new PaymobInputError("invalid_reconciliation_runtime");

  const apiKey = requiredText(payload.apiKey, "api_key", 8192);
  if (apiKey.length < 20) {
    throw new PaymobInputError("invalid_reconciliation_runtime");
  }
  return {
    apiKey,
    apiBaseUrl: PAYMOB_API_BASE_URL,
    attemptId,
    credentialVersionId,
    attemptCredentialVersionId,
    inquiryCredentialVersionId,
    inquiryMode: inquiryMode as ReconciliationRuntime["inquiryMode"],
    inquiryMethod: inquiryMethod as ReconciliationRuntime["inquiryMethod"],
    inquiryPath,
    providerTransactionId,
    merchantOrderId,
    environment: environment as ReconciliationRuntime["environment"],
  };
}

async function generateAuthToken(apiKey: string): Promise<string> {
  let result: Awaited<ReturnType<typeof fetchTextWithTimeout>>;
  try {
    result = await fetchTextWithTimeout(
      PAYMOB_AUTH_URL,
      {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ api_key: apiKey }),
      },
      PAYMOB_TIMEOUT_MS,
      MAX_PROVIDER_BYTES,
    );
  } catch (error) {
    if (error instanceof UpstreamTimeoutError) {
      throw new ProviderFailure("ambiguous", "provider_auth_timeout", true);
    }
    if (error instanceof BodyTooLargeError) {
      throw new ProviderFailure(
        "ambiguous",
        "provider_auth_response_too_large",
        true,
      );
    }
    throw new ProviderFailure("ambiguous", "provider_auth_network_error", true);
  }
  if (!result.response.ok) {
    throw classifyProviderStatus(result.response.status, "provider_auth", true);
  }
  try {
    const payload = parseJsonObject(result.text);
    const token = requiredText(payload.token, "auth_token", 8192);
    if (token.length < 16) throw new PaymobInputError("invalid_auth_token");
    return token;
  } catch {
    throw new ProviderFailure("ambiguous", "provider_invalid_auth_response", true);
  }
}

async function inquireByTransactionId(
  transactionId: string,
  authToken: string,
): Promise<{ raw: string; mode: "transaction_id" }> {
  let result: Awaited<ReturnType<typeof fetchTextWithTimeout>>;
  try {
    result = await fetchTextWithTimeout(
      `${PAYMOB_API_BASE_URL}/api/acceptance/transactions/${transactionId}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          authorization: `Bearer ${authToken}`,
          accept: "application/json",
        },
      },
      PAYMOB_TIMEOUT_MS,
      MAX_PROVIDER_BYTES,
    );
  } catch (error) {
    if (error instanceof UpstreamTimeoutError) {
      throw new ProviderFailure("ambiguous", "provider_inquiry_timeout", true);
    }
    if (error instanceof BodyTooLargeError) {
      throw new ProviderFailure(
        "ambiguous",
        "provider_inquiry_response_too_large",
        true,
      );
    }
    throw new ProviderFailure(
      "ambiguous",
      "provider_inquiry_network_error",
      true,
    );
  }
  if (!result.response.ok) {
    throw classifyProviderStatus(
      result.response.status,
      "provider_inquiry",
      result.response.status !== 404,
    );
  }
  return { raw: result.text, mode: "transaction_id" };
}

async function inquireByMerchantOrderId(
  attemptId: string,
  authToken: string,
): Promise<{ raw: string; mode: "merchant_order_id" }> {
  let result: Awaited<ReturnType<typeof fetchTextWithTimeout>>;
  try {
    result = await fetchTextWithTimeout(
      `${PAYMOB_API_BASE_URL}/api/ecommerce/orders/transaction_inquiry`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ merchant_order_id: attemptId }),
      },
      PAYMOB_TIMEOUT_MS,
      MAX_PROVIDER_BYTES,
    );
  } catch (error) {
    if (error instanceof UpstreamTimeoutError) {
      throw new ProviderFailure("ambiguous", "provider_inquiry_timeout", true);
    }
    if (error instanceof BodyTooLargeError) {
      throw new ProviderFailure(
        "ambiguous",
        "provider_inquiry_response_too_large",
        true,
      );
    }
    throw new ProviderFailure(
      "ambiguous",
      "provider_inquiry_network_error",
      true,
    );
  }
  if (!result.response.ok) {
    // A create timeout can race provider indexing. The database bounds this
    // retry with its lease counter/backoff; this invocation performs one read.
    if (result.response.status === 404) {
      throw new ProviderFailure(
        "retry",
        "provider_merchant_reference_not_found",
        false,
      );
    }
    throw classifyProviderStatus(
      result.response.status,
      "provider_inquiry",
      true,
    );
  }
  return { raw: result.text, mode: "merchant_order_id" };
}

function classifyProviderStatus(
  status: number,
  prefix: string,
  stopBatch: boolean,
): ProviderFailure {
  if ([408, 425, 429].includes(status) || status >= 500) {
    return new ProviderFailure("retry", `${prefix}_temporarily_unavailable`, true);
  }
  if (status === 404) {
    return new ProviderFailure("failed", `${prefix}_not_found`, stopBatch);
  }
  return new ProviderFailure("failed", `${prefix}_rejected`, stopBatch);
}

async function rescheduleBestEffort(
  supabaseUrl: string,
  serviceRoleKey: string,
  workerId: string,
  job: ReconciliationJob,
  outcome: ReconciliationOutcome,
  errorCode: string,
): Promise<void> {
  try {
    await serviceRpc(
      supabaseUrl,
      serviceRoleKey,
      "v1_service_paymob_reconciliation_reschedule",
      {
        p_job_id: job.jobId,
        p_lease_token: job.leaseToken,
        p_worker_id: workerId,
        p_outcome: outcome,
        p_error_code: errorCode,
      },
    );
  } catch {
    // The lease expires and becomes reclaimable. No provider call is repeated
    // inside this invocation when persistence is unavailable.
  }
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
  if (!result.response.ok) throw new Error("rpc_failed");
  if (!result.text.trim()) return {};
  return parseJsonObject(result.text);
}

async function secretEqual(expected: string, actual: string): Promise<boolean> {
  const [expectedDigest, actualDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
  ]);
  const left = new Uint8Array(expectedDigest);
  const right = new Uint8Array(actualDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

function requiredUuid(value: unknown, field: string): string {
  const result = requiredText(value, field, 36);
  if (!UUID.test(result)) throw new PaymobInputError(`invalid_${field}`);
  return result;
}

function optionalProviderIdentifier(
  value: unknown,
  field: string,
): string | null {
  if (value === null || value === undefined || value === "") return null;
  return paymobProviderIdentifier(value, field);
}
