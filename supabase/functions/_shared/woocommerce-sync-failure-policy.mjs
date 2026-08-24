const SAFE_RPC_MESSAGE_CODES = new Set([
  'integration_connection_not_found',
  'sync_run_not_found',
  'sync_run_not_running',
  'contact_identity_required',
  'invalid_email',
  'invalid_phone',
  'invalid_whatsapp',
  'woocommerce_invalid_batch',
  'woocommerce_invalid_order_routing_batch',
  'woocommerce_order_routing_batch_failed',
  'woocommerce_sync_checkpoint_conflict',
  'woocommerce_sync_cursor_invalid',
  'woocommerce_sync_cursor_version_invalid',
  'woocommerce_sync_lease_expired',
  'woocommerce_sync_not_complete',
  'woocommerce_sync_not_resumable',
  'woocommerce_sync_worker_mismatch',
  'woocommerce_worker_id_invalid',
  'woocommerce_worker_lease_invalid'
]);

export const MAX_WOO_CHECKPOINT_RETRIES = 5;

export function safeWooRpcDiagnostic(payload) {
  let parsed;
  try {
    parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  } catch {
    return {databaseCode: '', messageCode: ''};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {databaseCode: '', messageCode: ''};
  }
  const rawDatabaseCode = typeof parsed.code === 'string'
    ? parsed.code.trim().toLowerCase()
    : '';
  const databaseCode = /^(?:[a-z0-9]{5}|pgrst[0-9]{3})$/.test(
    rawDatabaseCode
  )
    ? rawDatabaseCode
    : '';
  const rawMessageCode = typeof parsed.message === 'string'
    ? parsed.message.trim().toLowerCase()
    : '';
  const messageCode = databaseCode === 'p0001'
    && SAFE_RPC_MESSAGE_CODES.has(rawMessageCode)
    ? rawMessageCode
    : '';
  return {databaseCode, messageCode};
}

export function retryableWooRpcFailure({httpStatus, databaseCode}) {
  const status = Number(httpStatus);
  const code = typeof databaseCode === 'string'
    ? databaseCode.trim().toLowerCase()
    : '';
  if (status === 408 || status === 429) return true;
  if ([500, 502, 503, 504].includes(status) && !code) return true;
  return /^(?:08|53)/.test(code)
    || /^(?:40001|40p01|55p03|57014|57p0[123])$/.test(code)
    || /^pgrst00[0-3]$/.test(code);
}

export function wooCheckpointRetryPolicy(retryCount) {
  const parsed = Number(retryCount);
  const count = Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
  if (count >= MAX_WOO_CHECKPOINT_RETRIES) {
    return {retry: false, delaySeconds: null};
  }
  return {
    retry: true,
    delaySeconds: Math.min(60 * (2 ** count), 900)
  };
}
