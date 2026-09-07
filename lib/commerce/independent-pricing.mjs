/** Presentation helpers only. The database always prices the final order. */
export function billingCycle(value){
  if(value!=='month'&&value!=='year')throw new Error('invalid_billing_interval');
  return value;
}
export function addonPrice(item,cycle){
  billingCycle(cycle);
  const amount=cycle==='month'?item.monthlyAmountMinor:item.annualAmountMinor;
  if(Number.isSafeInteger(amount)&&amount>=0)return amount;
  // Legacy contracts remain annual. Never invent a monthly quote from annual / 10.
  if(cycle==='year'&&Number.isSafeInteger(item.amountMinor)&&item.amountMinor>=0)return item.amountMinor;
  return null;
}
export function pricedAddon(item,cycle){
  const amountMinor=addonPrice(item,cycle);
  return {...item,amountMinor,selectedCycle:cycle,quoteAvailable:amountMinor!==null};
}
export function quotedTotals(item){
  const amount=Number(item?.amountMinor);
  if(!Number.isSafeInteger(amount)||amount<0)throw new Error('invalid_price');
  const rate=Number.isSafeInteger(item.taxRateBps)?item.taxRateBps:1500;
  if(rate<0||rate>10000)throw new Error('invalid_tax_rate');
  const included=item.taxInclusive===true;
  const tax=included?amount-Math.round(amount/(1+rate/10000)):Math.round(amount*rate/10000);
  return {subtotal:included?amount-tax:amount,tax,total:included?amount:amount+tax};
}
export function assertIndependentOrderPayload(payload){
  if(payload?.itemType!=='addon')return;
  if(payload.promotionCode)throw new Error('addon_promotions_not_available');
  billingCycle(payload.billingInterval);
  if(payload.quantity!==1)throw new Error('marketplace_quantity_invalid');
}
