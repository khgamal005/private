import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  BodyTooLargeError,
  fetchTextWithTimeout,
  isJsonContentType,
  isPlainObject,
  jsonResponse,
  normalizeKsaPhone,
  parseJsonObject,
  PAYMOB_CHECKOUT_URL,
  PAYMOB_INTENTION_URL,
  PaymobInputError,
  readTextLimited,
  requiredSafeInteger,
  requiredText,
  sha256Hex,
  UpstreamTimeoutError,
  type JsonObject,
} from "../_shared/paymob.ts";

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_UPSTREAM_BYTES = 128 * 1024;
const RPC_TIMEOUT_MS = 5_000;
const PAYMOB_TIMEOUT_MS = 10_000;
const MAX_PROVIDER_EXPIRATION_SECONDS = 3_600;
const MIN_PROVIDER_EXPIRATION_SECONDS = 60;
// Leave a full claim horizon between the Paymob payment-link deadline and the
// immutable local attempt deadline. This absorbs request/clock latency and
// guarantees the provider window is intentionally shorter than ODEIR's.
const PROVIDER_EXPIRATION_SAFETY_MS = 2 * 60 * 1_000;
const MAX_AMOUNT_MINOR = 100_000_000_000;
const MAX_INTENTION_ITEMS = 50;
const MAX_ITEM_QUANTITY = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,120}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CHECKOUT_REQUEST_KEYS = new Set([
  "slug",
  "orderId",
  "idempotencyKey",
  "billingContact",
]);
const BILLING_CONTACT_KEYS = new Set([
  "firstName",
  "lastName",
  "email",
  "phoneNumber",
]);
const PREPARED_CHECKOUT_KEYS = new Set([
  "schemaVersion",
  "createAllowed",
  "attemptId",
  "attemptStatus",
  "expiresAt",
  "billingDataValidated",
  "order",
  "provider",
  "items",
]);
const PREPARED_ORDER_KEYS = new Set([
  "id",
  "number",
  "kind",
  "status",
  "paymentStatus",
  "amountMinor",
  "currency",
]);
const PREPARED_PROVIDER_KEYS = new Set([
  "key",
  "region",
  "environment",
  "checkoutMode",
]);
const CHECKOUT_RUNTIME_KEYS = new Set([
  "schemaVersion",
  "purpose",
  "providerKey",
  "region",
  "environment",
  "checkoutMode",
  "apiBaseUrl",
  "createAllowed",
  "claimToken",
  "attemptId",
  "credentialVersionId",
  "expiresAt",
  "integrationId",
  "owner",
  "apiKeyConfigured",
  "secretKey",
  "publicKey",
]);
const RESUME_RUNTIME_KEYS = new Set([
  "schemaVersion",
  "attemptId",
  "attemptStatus",
  "resumeAllowed",
  "environment",
  "region",
  "checkoutMode",
  "publicKey",
  "clientSecret",
  "expiresAt",
  "providerExpiresAt",
]);
const RECORD_INTENTION_KEYS = new Set([
  "schemaVersion",
  "attemptId",
  "attemptStatus",
  "orderId",
  "environment",
  "expiresAt",
  "providerExpiresAt",
  "resumeAllowed",
  "lastErrorCode",
]);

type RuntimeConfig = {
  createAllowed: true;
  claimToken: string;
  credentialVersionId: string;
  environment: "sandbox" | "live";
  region: "ksa";
  checkoutMode: "redirect";
  publicKey: string;
  secretKey: string;
  integrationId: number;
  owner: string;
};

type PreparedCheckout = {
  attemptId: string;
  orderId: string;
  orderNumber: string;
  amountMinor: number;
  currency: "SAR";
  environment: "sandbox" | "live";
  attemptStatus: string;
  expiresAt: string;
  items: PaymobIntentionItem[];
};

type PaymobIntentionItem = {
  name: string;
  amount: number;
  description: string;
  quantity: number;
};

class RpcError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("rpc_failed");
    this.status = status;
    this.name = "RpcError";
  }
}

Deno.serve(async (request: Request) => {
  if (request.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "method_not_allowed" }, { allow: "POST" });
  }
  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonResponse(415, { ok: false, error: "unsupported_media_type" });
  }

  const authorization = request.headers.get("authorization")?.trim() ?? "";
  if (!/^Bearer\s+\S{20,8192}$/.test(authorization)) {
    return jsonResponse(401, { ok: false, error: "unauthorized" });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() ?? "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() ?? "";
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(503, { ok: false, error: "service_unavailable" });
  }

  let prepared: PreparedCheckout | null = null;
  let claimToken: string | null = null;
  let providerMutationStarted = false;
  try {
    const rawBody = await readTextLimited(request, MAX_REQUEST_BYTES);
    const input = normalizeCheckoutRequest(parseJsonObject(rawBody));

    const preparedPayload = await postRpc(
      supabaseUrl,
      anonKey,
      authorization,
      "v1_tenant_paymob_prepare_checkout",
      {
        p_slug: input.slug,
        p_order_id: input.orderId,
        p_idempotency_key: input.idempotencyKey,
        p_billing_contact: input.billingContact,
      },
    );
    prepared = normalizePreparedCheckout(preparedPayload, input.orderId);

    const runtimePayload = await postRpc(
      supabaseUrl,
      serviceRoleKey,
      `Bearer ${serviceRoleKey}`,
      "v1_service_paymob_runtime_config",
      { p_attempt_id: prepared.attemptId, p_purpose: "create_intention" },
    );
    if (runtimePayload.createAllowed !== true) {
      // The service RPC is the atomic outbound-call claim. Concurrent or
      // repeated requests never create a second Paymob intention. A created,
      // unexpired intention can be resumed from its Vault-only client secret.
      const resumed = await resumeCheckout(
        supabaseUrl,
        serviceRoleKey,
        prepared,
      );
      if (resumed) return resumed;
      return jsonResponse(202, {
        ok: false,
        status: requiredText(
          runtimePayload.attemptStatus ?? prepared.attemptStatus,
          "attempt_status",
          40,
        ),
        attemptId: prepared.attemptId,
        orderId: prepared.orderId,
        expiresAt: prepared.expiresAt,
        retryAllowed: false,
      });
    }
    claimToken = requiredText(runtimePayload.claimToken, "claim_token", 36);
    if (!UUID.test(claimToken)) throw new PaymobInputError("invalid_runtime_config");
    const runtime = normalizeRuntimeConfig(runtimePayload, prepared);

    const notificationUrl = buildNotificationUrl(supabaseUrl);
    const redirectionUrl = buildRedirectionUrl(input.slug, prepared.attemptId);
    // Capture one wall clock for both Paymob's relative TTL and the durable
    // upper bound recorded in SQL. The 120-second safety window also absorbs
    // request latency, so Paymob cannot outlive the local attempt deadline.
    const providerRequestStartedAt = Date.now();
    const providerExpiration = providerExpirationSeconds(
      prepared.expiresAt,
      providerRequestStartedAt,
    );
    const providerExpiresAt = new Date(
      providerRequestStartedAt + providerExpiration * 1_000,
    ).toISOString();
    const intentionRequest = {
      amount: prepared.amountMinor,
      currency: "SAR",
      payment_methods: [runtime.integrationId],
      // This immutable item/VAT snapshot is computed and authorized by SQL.
      // Browser-provided item data is never accepted by this endpoint.
      items: prepared.items,
      billing_data: {
        first_name: input.billingContact.firstName,
        last_name: input.billingContact.lastName,
        email: input.billingContact.email,
        phone_number: input.billingContact.phoneNumber,
      },
      special_reference: prepared.attemptId,
      expiration: providerExpiration,
      notification_url: notificationUrl,
      redirection_url: redirectionUrl,
    };

    let providerResponse: Response;
    let providerRaw: string;
    try {
      providerMutationStarted = true;
      const providerResult = await fetchTextWithTimeout(
        PAYMOB_INTENTION_URL,
        {
          method: "POST",
          redirect: "error",
          headers: {
            authorization: `Token ${runtime.secretKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(intentionRequest),
        },
        PAYMOB_TIMEOUT_MS,
        MAX_UPSTREAM_BYTES,
      );
      providerResponse = providerResult.response;
      providerRaw = providerResult.text;
    } catch (error) {
      const code = error instanceof UpstreamTimeoutError
        ? "provider_timeout_unknown"
        : "provider_network_unknown";
      await recordIntentionBestEffort(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        runtime.claimToken,
        "unknown",
        { errorCode: code },
      );
      return ambiguousResponse(prepared, code);
    }
    const responseHash = await sha256Hex(providerRaw);
    const requestId = providerRequestId(providerResponse);

    if (providerResponse.status !== 201) {
      const outcome = providerResponse.status >= 400 && providerResponse.status < 500 &&
          ![408, 409, 425, 429].includes(providerResponse.status)
        ? "failed"
        : "unknown";
      const errorCode = outcome === "failed"
        ? "provider_request_rejected"
        : "provider_response_unknown";
      const recorded = await recordIntentionBestEffort(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        runtime.claimToken,
        outcome,
        { requestId, errorCode, responseHash },
      );
      if (outcome === "unknown") return ambiguousResponse(prepared, errorCode);
      if (!recorded) {
        return ambiguousResponse(prepared, "intention_persistence_unknown");
      }
      return jsonResponse(502, {
        ok: false,
        status: "failed",
        attemptId: prepared.attemptId,
        orderId: prepared.orderId,
        error: "payment_initialization_failed",
        retryAllowed: false,
      });
    }

    let intention: JsonObject;
    try {
      intention = parseJsonObject(providerRaw);
    } catch {
      await recordIntentionBestEffort(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        runtime.claimToken,
        "unknown",
        { requestId, errorCode: "provider_invalid_response", responseHash },
      );
      return ambiguousResponse(prepared, "provider_invalid_response");
    }

    let providerIntentionId: string;
    let providerOrderId: string;
    let clientSecret: string;
    try {
      providerIntentionId = requiredText(intention.id, "intention_id", 200);
      providerOrderId = providerIdentifier(intention.intention_order_id, "intention_order_id");
      clientSecret = requiredText(intention.client_secret, "client_secret", 8192);
      if (intention.status !== "intended" || intention.confirmed !== false) {
        throw new PaymobInputError("provider_state_mismatch");
      }
      if (!isPlainObject(intention.intention_detail)) {
        throw new PaymobInputError("provider_binding_mismatch");
      }
      const returnedAmount = requiredSafeInteger(
        intention.intention_detail.amount,
        "intention_amount",
        1,
        MAX_AMOUNT_MINOR,
      );
      const returnedCurrency = requiredText(
        intention.intention_detail.currency,
        "intention_currency",
        3,
      ).toUpperCase();
      if (returnedAmount !== prepared.amountMinor || returnedCurrency !== "SAR") {
        throw new PaymobInputError("provider_binding_mismatch");
      }
      const returnedReference = requiredText(
        intention.special_reference,
        "special_reference",
        36,
      );
      if (returnedReference !== prepared.attemptId) {
        throw new PaymobInputError("provider_binding_mismatch");
      }
      if (!Array.isArray(intention.payment_methods)
          || intention.payment_methods.length !== 1
          || !isPlainObject(intention.payment_methods[0])) {
        throw new PaymobInputError("provider_binding_mismatch");
      }
      const returnedMethod = intention.payment_methods[0];
      const returnedIntegrationId = providerIdentifier(
        returnedMethod.integration_id,
        "payment_method_integration_id",
      );
      const returnedMethodCurrency = requiredText(
        returnedMethod.currency,
        "payment_method_currency",
        3,
      ).toUpperCase();
      const returnedMethodType = requiredText(
        returnedMethod.method_type,
        "payment_method_type",
        40,
      ).toLowerCase();
      if (returnedIntegrationId !== String(runtime.integrationId)
          || returnedMethodCurrency !== "SAR"
          || returnedMethod.live !== (runtime.environment === "live")
          || returnedMethodType !== "online") {
        throw new PaymobInputError("provider_binding_mismatch");
      }
    } catch {
      await recordIntentionBestEffort(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        runtime.claimToken,
        "unknown",
        { requestId, errorCode: "provider_invalid_response", responseHash },
      );
      return ambiguousResponse(prepared, "provider_invalid_response");
    }

    let recordedIntention: JsonObject;
    try {
      recordedIntention = await recordIntention(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        runtime.claimToken,
        "created",
        {
          providerIntentionId,
          providerOrderId,
          clientSecret,
          providerExpiresAt,
          requestId,
          responseHash,
        },
      );
    } catch {
      // The provider may have created the intention while persistence is
      // unavailable. Never repeat the provider mutation from this path.
      return ambiguousResponse(prepared, "intention_persistence_unknown");
    }
    let recordOutcome: { checkoutReady: boolean; reason: string };
    try {
      recordOutcome = normalizeRecordedIntention(
        recordedIntention,
        prepared,
        providerExpiresAt,
      );
    } catch {
      return ambiguousResponse(prepared, "intention_persistence_unknown");
    }
    if (!recordOutcome.checkoutReady) {
      // SQL rechecks the order under its canonical order lock. A concurrent
      // paid/review state can intentionally downgrade the just-created
      // provider intention to unknown. Never expose its Checkout URL.
      return ambiguousResponse(prepared, recordOutcome.reason);
    }

    return jsonResponse(201, {
      ok: true,
      status: "checkout_ready",
      attemptId: prepared.attemptId,
      orderId: prepared.orderId,
      orderNumber: prepared.orderNumber,
      expiresAt: providerExpiresAt,
      checkoutUrl: buildCheckoutUrl(runtime.publicKey, clientSecret),
    });
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      return jsonResponse(413, { ok: false, error: "payload_too_large" });
    }
    if (error instanceof PaymobInputError) {
      if (!prepared) {
        return jsonResponse(400, { ok: false, error: "invalid_checkout_request" });
      }
      if (claimToken) {
        await recordIntentionBestEffort(
          supabaseUrl,
          serviceRoleKey,
          prepared.attemptId,
          claimToken,
          providerMutationStarted ? "unknown" : "failed",
          {
            errorCode: providerMutationStarted
              ? "checkout_processing_unknown"
              : "invalid_checkout_contract",
          },
        );
      }
      if (providerMutationStarted) {
        return ambiguousResponse(prepared, "checkout_processing_unknown");
      }
      return jsonResponse(503, { ok: false, error: "checkout_not_available" });
    }
    if (error instanceof RpcError) {
      if (error.status === 401) return jsonResponse(401, { ok: false, error: "unauthorized" });
      if (error.status === 403) return jsonResponse(403, { ok: false, error: "forbidden" });
      if (error.status >= 400 && error.status < 500) {
        return jsonResponse(409, { ok: false, error: "checkout_not_available" });
      }
    }
    if (prepared && claimToken) {
      await recordIntentionBestEffort(
        supabaseUrl,
        serviceRoleKey,
        prepared.attemptId,
        claimToken,
        providerMutationStarted ? "unknown" : "failed",
        {
          errorCode: providerMutationStarted
            ? "checkout_processing_unknown"
            : "checkout_service_unavailable",
        },
      );
    }
    if (prepared && providerMutationStarted) {
      return ambiguousResponse(prepared, "checkout_processing_unknown");
    }
    return jsonResponse(503, { ok: false, error: "service_unavailable" });
  }
});

function normalizeCheckoutRequest(payload: JsonObject) {
  if (Object.keys(payload).some((key) => !CHECKOUT_REQUEST_KEYS.has(key))) {
    throw new PaymobInputError("invalid_checkout_request");
  }
  const slug = requiredText(payload.slug, "slug", 120);
  const orderId = requiredText(payload.orderId, "order_id", 36);
  const idempotencyKey = requiredText(payload.idempotencyKey, "idempotency_key", 120);
  if (!UUID.test(orderId) || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new PaymobInputError("invalid_checkout_request");
  }
  if (!isPlainObject(payload.billingContact)) {
    throw new PaymobInputError("invalid_billing_contact");
  }
  if (
    Object.keys(payload.billingContact).some((key) =>
      !BILLING_CONTACT_KEYS.has(key)
    )
  ) throw new PaymobInputError("invalid_billing_contact");
  const firstName = requiredText(payload.billingContact.firstName, "first_name", 100);
  const lastName = requiredText(payload.billingContact.lastName, "last_name", 100);
  const email = requiredText(payload.billingContact.email, "email", 254).toLowerCase();
  if (!EMAIL.test(email)) throw new PaymobInputError("invalid_billing_contact");
  return {
    slug,
    orderId,
    idempotencyKey,
    billingContact: {
      firstName,
      lastName,
      email,
      phoneNumber: normalizeKsaPhone(payload.billingContact.phoneNumber),
    },
  };
}

function normalizePreparedCheckout(
  payload: JsonObject,
  expectedOrderId: string,
): PreparedCheckout {
  if (
    payload.schemaVersion !== 1 ||
    typeof payload.createAllowed !== "boolean" ||
    typeof payload.billingDataValidated !== "boolean" ||
    Object.keys(payload).some((key) => !PREPARED_CHECKOUT_KEYS.has(key))
  ) throw new PaymobInputError("invalid_checkout_contract");
  const attemptId = requiredText(payload.attemptId, "attempt_id", 36);
  if (!isPlainObject(payload.order) || !isPlainObject(payload.provider)) {
    throw new PaymobInputError("invalid_checkout_contract");
  }
  if (
    Object.keys(payload.order).some((key) => !PREPARED_ORDER_KEYS.has(key)) ||
    Object.keys(payload.provider).some((key) => !PREPARED_PROVIDER_KEYS.has(key))
  ) throw new PaymobInputError("invalid_checkout_contract");
  const orderId = requiredText(payload.order.id, "order_id", 36);
  if (!UUID.test(attemptId) || !UUID.test(orderId) || orderId !== expectedOrderId) {
    throw new PaymobInputError("invalid_checkout_contract");
  }
  const orderNumber = String(payload.order.number ?? "").trim();
  if (!orderNumber || orderNumber.length > 80 || /[\u0000-\u001f\u007f]/.test(orderNumber)) {
    throw new PaymobInputError("invalid_checkout_contract");
  }
  const currency = requiredText(payload.order.currency, "currency", 3).toUpperCase();
  if (currency !== "SAR") throw new PaymobInputError("invalid_checkout_contract");
  const amountMinor = requiredSafeInteger(
    payload.order.amountMinor,
    "amount_minor",
    1,
    MAX_AMOUNT_MINOR,
  );
  const providerKey = requiredText(payload.provider.key, "provider_key", 20);
  const region = requiredText(payload.provider.region, "region", 16);
  const environment = requiredText(payload.provider.environment, "environment", 16);
  const checkoutMode = requiredText(payload.provider.checkoutMode, "checkout_mode", 16);
  if (
    providerKey !== "paymob" ||
    region !== "ksa" ||
    !["sandbox", "live"].includes(environment) ||
    checkoutMode !== "redirect"
  ) {
    throw new PaymobInputError("invalid_checkout_contract");
  }
  return {
    attemptId,
    orderId,
    orderNumber,
    amountMinor,
    currency: "SAR",
    environment: environment as PreparedCheckout["environment"],
    attemptStatus: requiredText(payload.attemptStatus, "attempt_status", 40),
    expiresAt: validDateText(payload.expiresAt, "expires_at"),
    items: normalizePreparedItems(payload.items, amountMinor),
  };
}

function normalizePreparedItems(
  value: unknown,
  expectedAmountMinor: number,
): PaymobIntentionItem[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > MAX_INTENTION_ITEMS
  ) throw new PaymobInputError("invalid_checkout_items");

  let total = 0;
  const items = value.map((entry) => {
    if (!isPlainObject(entry)) throw new PaymobInputError("invalid_checkout_items");
    const allowedKeys = new Set(["name", "amount", "description", "quantity"]);
    if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw new PaymobInputError("invalid_checkout_items");
    }
    const amount = requiredSafeInteger(
      entry.amount,
      "item_amount",
      0,
      MAX_AMOUNT_MINOR,
    );
    const quantity = requiredSafeInteger(
      entry.quantity,
      "item_quantity",
      1,
      MAX_ITEM_QUANTITY,
    );
    // Paymob's Intention contract treats each items[].amount as the complete
    // line amount. quantity is descriptive metadata and is not multiplied
    // again when checking the request total.
    total += amount;
    if (!Number.isSafeInteger(total) || total > MAX_AMOUNT_MINOR) {
      throw new PaymobInputError("invalid_checkout_items");
    }
    return {
      name: requiredText(entry.name, "item_name", 160),
      amount,
      description: requiredText(entry.description, "item_description", 160),
      quantity,
    };
  });
  if (total !== expectedAmountMinor) {
    throw new PaymobInputError("invalid_checkout_items");
  }
  return items;
}

function normalizeRuntimeConfig(
  payload: JsonObject,
  prepared: PreparedCheckout,
): RuntimeConfig {
  if (
    payload.schemaVersion !== 1 ||
    payload.providerKey !== "paymob" ||
    (payload.purpose !== undefined && payload.purpose !== "create_intention") ||
    Object.keys(payload).some((key) => !CHECKOUT_RUNTIME_KEYS.has(key))
  ) throw new PaymobInputError("invalid_runtime_config");
  const claimToken = requiredText(payload.claimToken, "claim_token", 36);
  if (payload.createAllowed !== true || !UUID.test(claimToken)) {
    throw new PaymobInputError("invalid_runtime_config");
  }
  const environment = requiredText(payload.environment, "environment", 16);
  const region = requiredText(payload.region, "region", 16);
  const checkoutMode = requiredText(payload.checkoutMode, "checkout_mode", 16);
  const apiBase = requiredText(payload.apiBaseUrl, "api_base_url", 120).replace(/\/$/, "");
  const attemptId = requiredText(payload.attemptId, "attempt_id", 36);
  const credentialVersionId = requiredText(
    payload.credentialVersionId,
    "credential_version_id",
    36,
  );
  const expiresAt = validDateText(payload.expiresAt, "expires_at");
  if (
    !["sandbox", "live"].includes(environment) ||
    environment !== prepared.environment ||
    region !== "ksa" ||
    checkoutMode !== "redirect" ||
    apiBase !== "https://ksa.paymob.com" ||
    attemptId !== prepared.attemptId ||
    !UUID.test(credentialVersionId) ||
    Date.parse(expiresAt) !== Date.parse(prepared.expiresAt)
  ) {
    throw new PaymobInputError("invalid_runtime_config");
  }
  const publicKey = requiredText(payload.publicKey, "public_key", 4096);
  const secretKey = requiredText(payload.secretKey, "secret_key", 8192);
  // The API key is part of the complete KSA credential bundle. The database
  // proves it is configured without decrypting it for this intention call.
  if (payload.apiKeyConfigured !== true) {
    throw new PaymobInputError("invalid_runtime_config");
  }
  const integrationId = requiredSafeInteger(
    payload.integrationId,
    "integration_id",
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const owner = providerIdentifier(payload.owner, "owner");
  return {
    createAllowed: true,
    claimToken,
    credentialVersionId,
    environment: environment as RuntimeConfig["environment"],
    region: "ksa",
    checkoutMode: "redirect",
    publicKey,
    secretKey,
    integrationId,
    owner,
  };
}

function normalizeRecordedIntention(
  payload: JsonObject,
  prepared: PreparedCheckout,
  expectedProviderExpiresAt: string,
): { checkoutReady: boolean; reason: string } {
  if (
    payload.schemaVersion !== 1 ||
    Object.keys(payload).some((key) => !RECORD_INTENTION_KEYS.has(key))
  ) throw new PaymobInputError("invalid_record_intention_contract");
  const attemptId = requiredText(payload.attemptId, "attempt_id", 36);
  const orderId = requiredText(payload.orderId, "order_id", 36);
  const attemptStatus = requiredText(payload.attemptStatus, "attempt_status", 40);
  if (
    attemptId !== prepared.attemptId ||
    orderId !== prepared.orderId ||
    typeof payload.resumeAllowed !== "boolean"
  ) throw new PaymobInputError("invalid_record_intention_contract");

  if (attemptStatus === "intention_created" && payload.resumeAllowed === true) {
    const environment = requiredText(payload.environment, "environment", 16);
    const expiresAt = validDateText(payload.expiresAt, "expires_at");
    const providerExpiresAt = validDateText(
      payload.providerExpiresAt,
      "provider_expires_at",
    );
    if (
      environment !== prepared.environment ||
      Date.parse(expiresAt) !== Date.parse(prepared.expiresAt) ||
      Date.parse(providerExpiresAt) !== Date.parse(expectedProviderExpiresAt) ||
      payload.lastErrorCode !== undefined && payload.lastErrorCode !== null
    ) throw new PaymobInputError("invalid_record_intention_contract");
    return { checkoutReady: true, reason: "checkout_ready" };
  }

  if (attemptStatus !== "unknown" || payload.resumeAllowed !== false) {
    throw new PaymobInputError("invalid_record_intention_contract");
  }
  const errorCode = payload.lastErrorCode === undefined
    ? "order_payment_review_hold"
    : requiredText(payload.lastErrorCode, "last_error_code", 80);
  if (!/^[a-z][a-z0-9_]{1,80}$/.test(errorCode)) {
    throw new PaymobInputError("invalid_record_intention_contract");
  }
  return { checkoutReady: false, reason: errorCode };
}

async function postRpc(
  supabaseUrl: string,
  apikey: string,
  authorization: string,
  name: string,
  body: JsonObject,
): Promise<JsonObject> {
  let result: { response: Response; text: string };
  try {
    result = await fetchTextWithTimeout(
      `${supabaseUrl}/rest/v1/rpc/${name}`,
      {
        method: "POST",
        redirect: "error",
        headers: {
          apikey,
          authorization,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      },
      RPC_TIMEOUT_MS,
      MAX_UPSTREAM_BYTES,
    );
  } catch {
    throw new RpcError(503);
  }
  if (!result.response.ok) throw new RpcError(result.response.status);
  try {
    return parseJsonObject(result.text);
  } catch {
    throw new RpcError(502);
  }
}

async function recordIntention(
  supabaseUrl: string,
  serviceRoleKey: string,
  attemptId: string,
  claimToken: string,
  outcome: "created" | "failed" | "unknown",
  details: {
    providerIntentionId?: string;
    providerOrderId?: string;
    clientSecret?: string;
    providerExpiresAt?: string;
    requestId?: string | null;
    errorCode?: string;
    responseHash?: string;
  },
): Promise<JsonObject> {
  return postRpc(
    supabaseUrl,
    serviceRoleKey,
    `Bearer ${serviceRoleKey}`,
    "v1_service_paymob_record_intention",
    {
      p_attempt_id: attemptId,
      p_claim_token: claimToken,
      p_outcome: outcome,
      p_provider_intention_id: details.providerIntentionId ?? null,
      p_provider_order_id: details.providerOrderId ?? null,
      p_client_secret: details.clientSecret ?? null,
      p_provider_expires_at: details.providerExpiresAt ?? null,
      p_provider_request_id: details.requestId ?? null,
      p_error_code: details.errorCode ?? null,
      p_response_sha256: details.responseHash ?? null,
    },
  );
}

async function resumeCheckout(
  supabaseUrl: string,
  serviceRoleKey: string,
  prepared: PreparedCheckout,
): Promise<Response | null> {
  const result = await postRpc(
    supabaseUrl,
    serviceRoleKey,
    `Bearer ${serviceRoleKey}`,
    "v1_service_paymob_resume_checkout",
    { p_attempt_id: prepared.attemptId },
  );
  if (result.resumeAllowed !== true) return null;
  if (
    result.schemaVersion !== 1 ||
    !["intention_created", "pending"].includes(String(result.attemptStatus)) ||
    Object.keys(result).some((key) => !RESUME_RUNTIME_KEYS.has(key))
  ) throw new PaymobInputError("invalid_resume_contract");
  const attemptId = requiredText(result.attemptId, "attempt_id", 36);
  const environment = requiredText(result.environment, "environment", 16);
  const region = requiredText(result.region, "region", 16);
  const checkoutMode = requiredText(result.checkoutMode, "checkout_mode", 16);
  const expiresAt = requiredText(result.expiresAt, "expires_at", 80);
  const providerExpiresAt = requiredText(
    result.providerExpiresAt,
    "provider_expires_at",
    80,
  );
  if (
    attemptId !== prepared.attemptId ||
    !["sandbox", "live"].includes(environment) ||
    environment !== prepared.environment ||
    region !== "ksa" ||
    checkoutMode !== "redirect" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    !Number.isFinite(Date.parse(providerExpiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    Date.parse(expiresAt) !== Date.parse(prepared.expiresAt) ||
    Date.parse(providerExpiresAt) <= Date.now() ||
    Date.parse(providerExpiresAt) > Date.parse(expiresAt) - 30_000
  ) {
    throw new PaymobInputError("invalid_resume_contract");
  }
  const publicKey = requiredText(result.publicKey, "public_key", 4096);
  const clientSecret = requiredText(result.clientSecret, "client_secret", 8192);
  return jsonResponse(200, {
    ok: true,
    status: "checkout_ready",
    resumed: true,
    attemptId: prepared.attemptId,
    orderId: prepared.orderId,
    orderNumber: prepared.orderNumber,
    expiresAt: providerExpiresAt,
    checkoutUrl: buildCheckoutUrl(publicKey, clientSecret),
  });
}

async function recordIntentionBestEffort(
  supabaseUrl: string,
  serviceRoleKey: string,
  attemptId: string,
  claimToken: string,
  outcome: "failed" | "unknown",
  details: {
    requestId?: string | null;
    errorCode: string;
    responseHash?: string;
  },
): Promise<boolean> {
  try {
    await recordIntention(
      supabaseUrl,
      serviceRoleKey,
      attemptId,
      claimToken,
      outcome,
      details,
    );
    return true;
  } catch {
    // Do not retry a state transition automatically. Reconciliation owns
    // ambiguous attempts and can resolve them without a second provider call.
    return false;
  }
}

function ambiguousResponse(prepared: PreparedCheckout, reason: string): Response {
  return jsonResponse(202, {
    ok: false,
    status: "unknown",
    attemptId: prepared.attemptId,
    orderId: prepared.orderId,
    expiresAt: prepared.expiresAt,
    error: "payment_initialization_unknown",
    reason,
    retryAllowed: false,
  });
}

function buildNotificationUrl(supabaseUrl: string): string {
  const url = new URL("/functions/v1/paymob-webhook", supabaseUrl);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PaymobInputError("invalid_notification_url");
  }
  return url.toString();
}

function buildCheckoutUrl(publicKey: string, clientSecret: string): string {
  const checkoutUrl = new URL(PAYMOB_CHECKOUT_URL);
  checkoutUrl.searchParams.set("publicKey", publicKey);
  checkoutUrl.searchParams.set("clientSecret", clientSecret);
  return checkoutUrl.toString();
}

function buildRedirectionUrl(slug: string, attemptId: string): string {
  const publicAppUrl = Deno.env.get("ODEIR_PUBLIC_APP_URL")?.trim() ?? "";
  const base = new URL(publicAppUrl);
  if (base.protocol !== "https:" || base.username || base.password) {
    throw new PaymobInputError("invalid_redirection_url");
  }
  // Paymob appends transaction fields to redirection_url. Land on a minimal
  // no-referrer handler first so the rendered tenant page only ever sees the
  // opaque attempt identifier and cannot propagate provider query fields.
  const url = new URL("/api/payments/paymob/return", base);
  url.searchParams.set("slug", slug);
  url.searchParams.set("attempt", attemptId);
  return url.toString();
}

function providerIdentifier(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^\d{1,30}$/.test(value)) return value;
  throw new PaymobInputError(`invalid_${field}`);
}

function validDateText(value: unknown, field: string): string {
  const result = requiredText(value, field, 80);
  if (!Number.isFinite(Date.parse(result))) throw new PaymobInputError(`invalid_${field}`);
  return result;
}

function providerExpirationSeconds(expiresAt: string, nowMs: number): number {
  const remainingAfterSafety = Date.parse(expiresAt) - nowMs -
    PROVIDER_EXPIRATION_SAFETY_MS;
  const expiration = Math.min(
    MAX_PROVIDER_EXPIRATION_SECONDS,
    Math.floor(remainingAfterSafety / 1_000),
  );
  if (
    !Number.isSafeInteger(expiration) ||
    expiration < MIN_PROVIDER_EXPIRATION_SECONDS
  ) throw new PaymobInputError("checkout_window_too_short");
  return expiration;
}

function providerRequestId(response: Response): string | null {
  for (const header of ["x-request-id", "x-correlation-id", "cf-ray"]) {
    const value = response.headers.get(header)?.trim();
    if (value && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value)) return value;
  }
  return null;
}
