import {
  isPlainObject,
  PaymobInputError,
  requiredBoolean,
  requiredSafeInteger,
  requiredText,
  type JsonObject,
} from "../_shared/paymob.ts";

const MAX_AMOUNT_MINOR = 100_000_000_000;

export type NormalizedInquiry = {
  providerTransactionId: string;
  providerOrderId: string;
  merchantOrderId: string;
  integrationId: string;
  owner: string;
  amountMinor: number;
  orderPaidAmountMinor: number;
  currency: string;
  state: string;
  success: boolean;
  pending: boolean;
  errorOccurred: boolean;
  isAuth: boolean;
  isCapture: boolean;
  isStandalonePayment: boolean;
  hasParentTransaction: boolean;
  isRefunded: boolean;
  isVoided: boolean;
  cumulativeRefundedMinor: number;
};

export function normalizePaymobInquiry(
  payload: JsonObject,
): NormalizedInquiry {
  const order = payload.order;
  if (!isPlainObject(order)) throw new PaymobInputError("invalid_inquiry_order");

  const amountMinor = requiredSafeInteger(
    payload.amount_cents,
    "amount_cents",
    1,
    MAX_AMOUNT_MINOR,
  );
  const orderPaidAmountMinor = requiredSafeInteger(
    order.paid_amount_cents,
    "order_paid_amount_cents",
    0,
    MAX_AMOUNT_MINOR,
  );
  const currency = requiredText(payload.currency, "currency", 3).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PaymobInputError("invalid_inquiry_currency");
  }

  const success = requiredBoolean(payload.success, "success");
  const pending = requiredBoolean(payload.pending, "pending");
  const errorOccurred = requiredBoolean(
    payload.error_occured,
    "error_occured",
  );
  const isAuth = requiredBoolean(payload.is_auth, "is_auth");
  const isCapture = requiredBoolean(payload.is_capture, "is_capture");
  const isStandalonePayment = requiredBoolean(
    payload.is_standalone_payment,
    "is_standalone_payment",
  );
  const hasParentTransaction = requiredBoolean(
    payload.has_parent_transaction,
    "has_parent_transaction",
  );
  const isRefunded = requiredBoolean(payload.is_refunded, "is_refunded");
  const isVoided = requiredBoolean(payload.is_voided, "is_voided");
  const cumulativeRefundedMinor = normalizedRefundedAmount(
    payload,
    isRefunded,
  );

  return {
    providerTransactionId: paymobProviderIdentifier(
      payload.id,
      "transaction_id",
    ),
    providerOrderId: paymobProviderIdentifier(order.id, "order_id"),
    merchantOrderId: requiredText(
      order.merchant_order_id,
      "merchant_order_id",
      200,
    ),
    integrationId: paymobProviderIdentifier(
      payload.integration_id,
      "integration_id",
    ),
    owner: paymobProviderIdentifier(payload.owner, "owner"),
    amountMinor,
    orderPaidAmountMinor,
    currency,
    state: normalizedState({
      amountMinor,
      cumulativeRefundedMinor,
      success,
      pending,
      errorOccurred,
      isAuth,
      isCapture,
      isStandalonePayment,
      hasParentTransaction,
      isRefunded,
      isVoided,
    }),
    success,
    pending,
    errorOccurred,
    isAuth,
    isCapture,
    isStandalonePayment,
    hasParentTransaction,
    isRefunded,
    isVoided,
    cumulativeRefundedMinor,
  };
}

export function paymobProviderIdentifier(
  value: unknown,
  field: string,
): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string" && /^[1-9]\d{0,29}$/.test(value)) return value;
  throw new PaymobInputError(`invalid_${field}`);
}

function normalizedRefundedAmount(
  payload: JsonObject,
  isRefunded: boolean,
): number {
  const primaryPresent = "refunded_amount_cents" in payload;
  const mirrorPresent = "refunded_amount_cents_int" in payload;
  const primary = optionalSafeInteger(
    payload.refunded_amount_cents,
    "refunded_amount_cents",
  );
  const integerMirror = optionalSafeInteger(
    payload.refunded_amount_cents_int,
    "refunded_amount_cents_int",
  );
  if (!primaryPresent && !mirrorPresent) {
    throw new PaymobInputError("missing_refunded_amount_cents");
  }
  if (
    primary !== null && integerMirror !== null && primary !== integerMirror
  ) throw new PaymobInputError("conflicting_refunded_amount_cents");
  // Paymob's official successful, non-refunded fixture returns null here.
  // Zero is safe only when the independent provider flag confirms no refund.
  if (primary === null && integerMirror === null && isRefunded) {
    throw new PaymobInputError("missing_refunded_amount_cents");
  }
  return primary ?? integerMirror ?? 0;
}

function normalizedState(input: {
  amountMinor: number;
  cumulativeRefundedMinor: number;
  success: boolean;
  pending: boolean;
  errorOccurred: boolean;
  isAuth: boolean;
  isCapture: boolean;
  isStandalonePayment: boolean;
  hasParentTransaction: boolean;
  isRefunded: boolean;
  isVoided: boolean;
}): string {
  if (input.cumulativeRefundedMinor >= input.amountMinor) return "refunded";
  if (input.cumulativeRefundedMinor > 0) return "partially_refunded";
  if (input.isRefunded) return "refund_flagged";
  if (input.isVoided) return "voided";
  if (input.pending) return "pending";
  if (
    input.success &&
    !input.errorOccurred &&
    !input.isAuth &&
    !input.isCapture &&
    input.isStandalonePayment &&
    !input.hasParentTransaction
  ) return "succeeded";
  if (input.errorOccurred) return "failed";
  return "not_successful";
}

function optionalSafeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredSafeInteger(value, field, 0, MAX_AMOUNT_MINOR);
}
