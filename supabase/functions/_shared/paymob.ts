export const PAYMOB_INTENTION_URL = "https://ksa.paymob.com/v1/intention/";
export const PAYMOB_CHECKOUT_URL = "https://ksa.checkout.paymob.com/";
export const PAYMOB_AUTH_URL = "https://ksa.paymob.com/api/auth/tokens";
export const PAYMOB_QUICKLINK_URL =
  "https://ksa.paymob.com/api/ecommerce/payment-links";
export const PAYMOB_QUICKLINK_CHECKOUT_PATH =
  "/api/ecommerce/payment-links/unrestricted";

export const PAYMOB_TRANSACTION_HMAC_FIELDS = [
  "amount_cents",
  "created_at",
  "currency",
  "error_occured",
  "has_parent_transaction",
  "id",
  "integration_id",
  "is_3d_secure",
  "is_auth",
  "is_capture",
  "is_refunded",
  "is_standalone_payment",
  "is_voided",
  "order.id",
  "owner",
  "pending",
  "source_data.pan",
  "source_data.sub_type",
  "source_data.type",
  "success",
] as const;

const encoder = new TextEncoder();

export class PaymobInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "PaymobInputError";
  }
}

export class BodyTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "BodyTooLargeError";
  }
}

export class UpstreamTimeoutError extends Error {
  constructor() {
    super("upstream_timeout");
    this.name = "UpstreamTimeoutError";
  }
}

export type JsonObject = Record<string, unknown>;

export type NormalizedPaymobTransaction = {
  amountMinor: number;
  createdAt: string;
  currency: string;
  errorOccurred: boolean;
  hasParentTransaction: boolean;
  providerTransactionId: string;
  integrationId: string;
  is3dSecure: boolean;
  isAuth: boolean;
  isCapture: boolean;
  isRefunded: boolean;
  isStandalonePayment: boolean;
  isVoided: boolean;
  providerOrderId: string;
  owner: string;
  pending: boolean;
  sourceDataSubtype: string;
  sourceDataType: string;
  success: boolean;
  specialReference: string | null;
};

export function jsonResponse(
  status: number,
  body: JsonObject,
  extraHeaders: HeadersInit = {},
): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store, max-age=0");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return new Response(JSON.stringify(body), { status, headers });
}

export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

export function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function parseJsonObject(raw: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PaymobInputError("invalid_json");
  }
  if (!isPlainObject(value)) throw new PaymobInputError("invalid_json");
  return value;
}

export async function readTextLimited(
  source: { body: ReadableStream<Uint8Array> | null; headers: Headers },
  maxBytes: number,
): Promise<string> {
  const declared = source.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > maxBytes) {
    await source.body?.cancel("body_too_large").catch(() => {});
    throw new BodyTooLargeError();
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
      if (total > maxBytes) {
        await reader.cancel("body_too_large").catch(() => {});
        throw new BodyTooLargeError();
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PaymobInputError("invalid_utf8");
  }
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha512Hex(
  secret: string,
  value: string,
): Promise<string> {
  const key = await importHmacKey(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(value),
  );
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyPaymobTransactionHmac(
  transaction: JsonObject,
  providedHmac: string,
  secret: string,
): Promise<boolean> {
  const signature = hexToBytes(providedHmac, 64);
  if (!signature || secret.length < 16 || secret.length > 8192) return false;
  const key = await importHmacKey(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    encoder.encode(paymobTransactionHmacInput(transaction)),
  );
}

export function paymobTransactionHmacInput(transaction: JsonObject): string {
  return PAYMOB_TRANSACTION_HMAC_FIELDS.map((field) => {
    const value = scalarAtPath(transaction, field.split("."));
    // Paymob's recipe concatenates the canonical JSON scalar representation
    // without separators: false -> "false", numbers -> base-10 strings.
    return String(value);
  }).join("");
}

export function normalizePaymobTransaction(
  transaction: JsonObject,
): NormalizedPaymobTransaction {
  const order = objectAt(transaction, "order");
  const sourceData = objectAt(transaction, "source_data");
  const currency = requiredText(transaction.currency, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PaymobInputError("invalid_transaction");
  }

  const createdAt = requiredText(transaction.created_at, "created_at", 80);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new PaymobInputError("invalid_transaction");
  }

  return {
    amountMinor: requiredSafeInteger(transaction.amount_cents, "amount_cents", 1),
    createdAt,
    currency,
    errorOccurred: requiredBoolean(transaction.error_occured, "error_occured"),
    hasParentTransaction: requiredBoolean(
      transaction.has_parent_transaction,
      "has_parent_transaction",
    ),
    providerTransactionId: requiredIdentifier(transaction.id, "id"),
    integrationId: requiredIdentifier(transaction.integration_id, "integration_id"),
    is3dSecure: requiredBoolean(transaction.is_3d_secure, "is_3d_secure"),
    isAuth: requiredBoolean(transaction.is_auth, "is_auth"),
    isCapture: requiredBoolean(transaction.is_capture, "is_capture"),
    isRefunded: requiredBoolean(transaction.is_refunded, "is_refunded"),
    isStandalonePayment: requiredBoolean(
      transaction.is_standalone_payment,
      "is_standalone_payment",
    ),
    isVoided: requiredBoolean(transaction.is_voided, "is_voided"),
    providerOrderId: requiredIdentifier(order.id, "order.id"),
    owner: requiredIdentifier(transaction.owner, "owner"),
    pending: requiredBoolean(transaction.pending, "pending"),
    sourceDataSubtype: requiredText(
      sourceData.sub_type,
      "source_data.sub_type",
      80,
    ),
    sourceDataType: requiredText(sourceData.type, "source_data.type", 80),
    success: requiredBoolean(transaction.success, "success"),
    specialReference: optionalText(order.merchant_order_id, 200),
  };
}

export function normalizeKsaPhone(value: unknown): string {
  let phone = requiredText(value, "phone_number", 40).replace(/[\s()-]/g, "");
  if (phone.startsWith("00966")) phone = `+${phone.slice(2)}`;
  else if (phone.startsWith("966")) phone = `+${phone}`;
  else if (/^05\d{8}$/.test(phone)) phone = `+966${phone.slice(1)}`;
  else if (/^5\d{8}$/.test(phone)) phone = `+966${phone}`;
  if (!/^\+9665\d{8}$/.test(phone)) {
    throw new PaymobInputError("invalid_billing_contact");
  }
  return phone;
}

export function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string") throw new PaymobInputError(`invalid_${field}`);
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new PaymobInputError(`invalid_${field}`);
  }
  return result;
}

export function requiredSafeInteger(
  value: unknown,
  field: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const numberValue = typeof value === "string" && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (
    typeof numberValue !== "number" ||
    !Number.isSafeInteger(numberValue) ||
    numberValue < minimum ||
    numberValue > maximum
  ) {
    throw new PaymobInputError(`invalid_${field}`);
  }
  return numberValue;
}

export function requiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new PaymobInputError(`invalid_${field}`);
  return value;
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchTextWithTimeout(
  input: string | URL | Request,
  init: RequestInit,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await readTextLimited(response, maxResponseBytes);
    return { response, text };
  } catch (error) {
    if (controller.signal.aborted) throw new UpstreamTimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function scalarAtPath(object: JsonObject, path: ReadonlyArray<string>): string | number | boolean {
  let value: unknown = object;
  for (const segment of path) {
    if (!isPlainObject(value) || !(segment in value)) {
      throw new PaymobInputError("invalid_transaction_hmac_fields");
    }
    value = value[segment];
  }
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
    throw new PaymobInputError("invalid_transaction_hmac_fields");
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new PaymobInputError("invalid_transaction_hmac_fields");
  }
  return value;
}

function objectAt(object: JsonObject, key: string): JsonObject {
  const value = object[key];
  if (!isPlainObject(value)) throw new PaymobInputError("invalid_transaction");
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d{0,29}$/.test(value)) return value;
  throw new PaymobInputError(`invalid_${field}`);
}

function optionalText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return null;
  const result = value.trim();
  if (!result || result.length > maxLength || /[\u0000-\u001f\u007f]/.test(result)) {
    return null;
  }
  return result;
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(value: string, expectedLength: number): Uint8Array | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length !== expectedLength * 2 ||
    !/^[0-9a-f]+$/.test(normalized)
  ) return null;
  const bytes = new Uint8Array(expectedLength);
  for (let index = 0; index < expectedLength; index += 1) {
    bytes[index] = Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
