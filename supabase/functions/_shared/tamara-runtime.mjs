import {TAMARA_API,boundedJson,checkoutUrl,checkoutPayload,capturePayload,verifiedOrder,minorUnits} from './tamara-protocol.mjs';

export function validContact(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const key of ['firstName','lastName','phone','email','address','city']) {
    if (typeof value[key] !== 'string') return null;
    const text = value[key].trim();
    if (!text || text.length > (key === 'address' ? 200 : 100) || /[\u0000-\u001f\u007f]/.test(text)) return null;
    result[key] = text;
  }
  if (!/^\+9665[0-9]{8}$/.test(result.phone) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) return null;
  return result;
}
export function selectPaymentType(body,total) {
  const list = Array.isArray(body) ? body : body?.payment_types;
  if (!Array.isArray(list)) throw new Error('tamara_payment_type_unavailable');
  for (const type of list) {
    if (type?.name !== 'PAY_BY_INSTALMENTS') continue;
    // Limits are verified with provider data, never inferred from a logo or plan.
    if ((type.min_limit?.currency && type.min_limit.currency !== 'SAR')
        || (type.max_limit?.currency && type.max_limit.currency !== 'SAR')) continue;
    const min = type.min_limit?.amount ?? type.min_limit;
    const max = type.max_limit?.amount ?? type.max_limit;
    if (min === undefined || max === undefined || total < minorUnits(min) || total > minorUnits(max)) continue;
    return {name:type.name};
  }
  throw new Error('tamara_payment_type_unavailable');
}
export function makeProvider(fetcher = fetch) {
  return async (claim,path,body) => {
    const base = TAMARA_API[claim.environment];
    if (!base || !path.startsWith('/') || path.startsWith('//')) throw new Error('tamara_environment_invalid');
    const response = await fetcher(`${base}${path}`,{
      method:body === undefined ? 'GET' : 'POST',redirect:'error',
      headers:{Authorization:`Bearer ${claim.apiToken}`,'Content-Type':'application/json',Accept:'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)}),
      signal:AbortSignal.timeout(15000)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 404 ? 'tamara_not_found' : 'tamara_provider_unavailable');
    }
    return boundedJson(response,262144,10000);
  };
}
const digest = async body => [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))))]
  .map(x=>x.toString(16).padStart(2,'0')).join('');

// rpc and provider are injectable: tests exercise crash/retry behavior without money.
export async function processClaim(claim,{rpc,provider,contact}) {
  const args = {p_attempt_id:claim.id,p_claim:claim.claim_token};
  let release = {...args};
  try {
    if (claim.status === 'prepared' && !claim.create_started_at) {
      if (!contact) return {status:'prepared'};
      const paymentType = selectPaymentType(await provider(claim,'/checkout/payment-types?country=SA&currency=SAR'),claim.snapshot.amount_minor);
      const payload = checkoutPayload(claim.snapshot,contact,paymentType);
      const owns = await rpc('v1_service_tamara_mutation',{...args,p_operation:'create',p_payload:payload});
      if (!owns) return {status:'pending'};
      const response = await provider(claim,'/checkout',payload);
      const url = checkoutUrl(response?.checkout_url,claim.environment);
      if (!url || !/^[0-9a-f-]{36}$/i.test(response?.order_id || '')) throw new Error('tamara_checkout_response_invalid');
      release = {...release,p_provider_order_id:response.order_id,p_checkout_url:url};
      return {status:'pending'};
    }
    // An ambiguous POST is reconciled by the stable reference, never replayed.
    const path = claim.provider_order_id
      ? `/merchants/orders/${encodeURIComponent(claim.provider_order_id)}`
      : `/merchants/orders/reference-id/${encodeURIComponent(claim.id)}`;
    const order = await provider(claim,path);
    const evidence = verifiedOrder(order,claim.snapshot);
    const observed = await rpc('v1_service_tamara_observe',{
      ...args,p_evidence:evidence,p_sha256:await digest(order)
    });
    if (observed.stale) return observed;
    if (observed.status === 'approved' && !claim.authorise_started_at) {
      const owns = await rpc('v1_service_tamara_mutation',{...args,p_operation:'authorise'});
      if (owns) await provider(claim,`/orders/${evidence.providerOrderId}/authorise`,{order_id:evidence.providerOrderId});
    } else if (observed.status === 'provisioned' && !claim.capture_started_at) {
      const snapshot = {...claim.snapshot,provider_order_id:evidence.providerOrderId,provisioned_at:observed.provisioned_at};
      const payload = capturePayload(snapshot,claim.checkout_payload);
      const owns = await rpc('v1_service_tamara_mutation',{...args,p_operation:'capture'});
      if (owns) await provider(claim,'/payments/capture',payload);
    }
    return observed;
  } catch (error) {
    const allowed = new Set(['tamara_not_found','tamara_provider_unavailable','tamara_payment_type_unavailable',
      'tamara_checkout_response_invalid','tamara_evidence_invalid']);
    release.p_error_code = allowed.has(error?.message) ? error.message : 'tamara_reconciliation_pending';
    return {status:'pending'};
  } finally {
    // If saving fails, a later leased GET recovers the operation by reference.
    await rpc('v1_service_tamara_release',release);
  }
}
