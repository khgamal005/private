// Provider protocol only. No credentials, database access or browser input here.
export const TAMARA_API = Object.freeze({
  live: 'https://api.tamara.co',
  sandbox: 'https://api-sandbox.tamara.co'
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES = new Set(['new','approved','authorised','fully_captured',
  'partially_captured','fully_refunded','partially_refunded','canceled',
  'cancelled','declined','expired','on_hold']);
const fail = () => { throw new Error('tamara_evidence_invalid'); };

export function minorUnits(value) {
  // Parse decimal text, never round an imprecise provider amount into a match.
  if (typeof value !== 'string' && typeof value !== 'number') return fail();
  const text = String(value);
  if (!/^(0|[1-9][0-9]{0,10})(\.[0-9]{1,2})?$/.test(text)) return fail();
  const [whole, fraction = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) return fail();
  return result;
}
export function money(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) return fail();
  return {amount: `${Math.floor(amount / 100)}.${String(amount % 100).padStart(2,'0')}`, currency: 'SAR'};
}
function amount(value) {
  if (!value || value.currency !== 'SAR') return fail();
  return minorUnits(value.amount);
}
export function checkoutUrl(value, environment) {
  try {
    const url = new URL(value);
    const host = environment === 'live' ? 'checkout.tamara.co'
      : environment === 'sandbox' ? 'checkout-sandbox.tamara.co' : '';
    if (url.protocol !== 'https:' || url.hostname !== host || url.port
        || url.username || url.password || url.hash || value.length > 2048) return null;
    return url.href;
  } catch { return null; }
}
export function verifiedOrder(body, snapshot) {
  if (!body || !UUID.test(body.order_id) || !UUID.test(snapshot.id)
      || body.order_reference_id !== snapshot.id
      || (snapshot.provider_order_id && body.order_id !== snapshot.provider_order_id)
      || amount(body.total_amount) !== snapshot.amount_minor
      || !STATES.has(body.status)) return fail();
  if (!Array.isArray(body.items) || body.items.length !== 1 || !Array.isArray(snapshot.items)
      || snapshot.items.length !== 1 || body.items[0].reference_id !== snapshot.items[0].id
      || body.items[0].sku !== snapshot.items[0].product_key || body.items[0].quantity !== snapshot.items[0].quantity
      || amount(body.items[0].total_amount) !== snapshot.amount_minor) return fail();
  const captured = amount(body.captured_amount);
  const refunded = amount(body.refunded_amount);
  const canceled = amount(body.canceled_amount);
  if (refunded > captured || captured + canceled > snapshot.amount_minor) return fail();
  if (body.status === 'fully_captured' && (captured !== snapshot.amount_minor || refunded !== 0)) return fail();
  if (body.status === 'fully_refunded' && (captured !== snapshot.amount_minor || refunded !== captured)) return fail();
  if (['new','approved','authorised','on_hold','declined','expired','canceled','cancelled'].includes(body.status)
      && (captured !== 0 || refunded !== 0)) return fail();
  return {providerOrderId: body.order_id, status: body.status,
    capturedMinor: captured, refundedMinor: refunded, canceledMinor: canceled};
}
export function checkoutPayload(snapshot, contact, paymentType) {
  if (!UUID.test(snapshot.id) || snapshot.currency !== 'SAR'
      || snapshot.amount_minor !== snapshot.subtotal_minor + snapshot.tax_minor
      || !Array.isArray(snapshot.items) || snapshot.items.length !== 1
      || (!Number.isInteger(snapshot.items[0].quantity) || snapshot.items[0].quantity < 1 || snapshot.items[0].quantity > 100) || !paymentType?.name) return fail();
  const item = snapshot.items[0];
  if (item.line_total_minor - snapshot.discount_minor !== snapshot.subtotal_minor) return fail();
  const address = {first_name: contact.firstName, last_name: contact.lastName,
    phone_number: contact.phone, line1: contact.address, city: contact.city, country_code: 'SA'};
  const returnUrl = `https://odeir.com/tenant/${encodeURIComponent(snapshot.slug)}/payments/tamara/return?attempt=${snapshot.id}`;
  return {
    order_reference_id: snapshot.id, order_number: snapshot.order_number,
    total_amount: money(snapshot.amount_minor), description: item.product_name_ar,
    country_code: 'SA', payment_type: paymentType.name, locale: 'ar_SA',
    ...(paymentType.instalments ? {instalments: paymentType.instalments} : {}),
    items: [{reference_id: item.id, type: 'Digital', name: item.product_name_ar,
      sku: item.product_key, quantity: item.quantity, unit_price: money(item.unit_amount_minor),
      total_amount: money(snapshot.amount_minor), tax_amount: money(snapshot.tax_minor),
      discount_amount: money(snapshot.discount_minor)}],
    consumer: {first_name: contact.firstName, last_name: contact.lastName,
      phone_number: contact.phone, email: contact.email},
    billing_address: address, shipping_address: address,
    tax_amount: money(snapshot.tax_minor), shipping_amount: money(0),
    discount: {name: snapshot.promotion_code || 'Discount', amount: money(snapshot.discount_minor)},
    merchant_url: {success: returnUrl, failure: returnUrl, cancel: returnUrl,
      notification: 'https://gswpbwdactcstkasddta.supabase.co/functions/v1/tamara-webhook'},
    platform: 'ODEIR', expires_in_minutes: 30
  };
}
export function capturePayload(snapshot, checkout) {
  // A persisted entitlement grant is required before confirming digital delivery.
  if (!snapshot.provisioned_at || !Number.isFinite(Date.parse(snapshot.provisioned_at))
      || !UUID.test(snapshot.provider_order_id)) return fail();
  return {order_id: snapshot.provider_order_id, total_amount: money(snapshot.amount_minor),
    items: checkout.items, shipping_amount: money(0), tax_amount: money(snapshot.tax_minor),
    discount_amount: money(snapshot.discount_minor),
    shipping_info: {shipped_at: snapshot.provisioned_at, shipping_company: 'ODEIR digital delivery'}};
}
export async function verifiedNotification(token, secret, now = Date.now()) {
  try {
    if (typeof token !== 'string' || token.length > 4096 || typeof secret !== 'string' || !secret) return false;
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const decode = part => Uint8Array.from(atob(part.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    if (header.alg !== 'HS256' || header.crit || (header.typ && header.typ !== 'JWT')
        || claims.iss !== 'Tamara' || !Number.isFinite(claims.exp) || claims.exp <= now / 1000
        || (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now / 1000))
        || (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now / 1000 + 30))) return false;
    const key = await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),
      {name:'HMAC',hash:'SHA-256'},false,['verify']);
    return crypto.subtle.verify('HMAC',key,decode(parts[2]),new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch { return false; }
}

export async function boundedJson(source, limit = 65536, timeoutMs = 10000) {
  if (!source.body || Number(source.headers.get('content-length')) > limit) throw new Error('tamara_body_invalid');
  const reader = source.body.getReader();
  let timer;
  try {
    return await Promise.race([
      (async () => {
        let size = 0, text = '';
        const decoder = new TextDecoder('utf-8',{fatal:true});
        while (true) {
          const {done,value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error('tamara_body_invalid');
          text += decoder.decode(value,{stream:true});
        }
        return JSON.parse(text + decoder.decode());
      })(),
      new Promise((_,reject) => { timer = setTimeout(() => reject(new Error('tamara_body_timeout')),timeoutMs); })
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
