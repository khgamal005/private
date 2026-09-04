'use client';

import {useEffect,useState} from 'react';
import styles from './marketplace-store.module.css';

function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{
    style:'currency',currency,maximumFractionDigits:2
  }).format((Number(amountMinor)||0)/100);
}

export default function MarketplacePromoCode({
  order,
  busy,
  canManage=true,
  onApply,
  onRemove
}){
  const promotion=order?.promotion||null;
  const [code,setCode]=useState(promotion?.code||'');
  useEffect(()=>{setCode(promotion?.code||'');},[promotion?.code]);

  const locked=Boolean(busy)
    ||order?.status!=='pending_payment'
    ||!['pending','failed'].includes(order?.paymentStatus||'pending');
  const discount=Math.max(0,Number(order?.discountMinor)||0);
  const listSubtotal=Math.max(
    Number(order?.listSubtotalMinor)||0,
    (Number(order?.subtotalMinor)||0)+discount
  );

  async function submit(event){
    event.preventDefault();
    const normalized=code.trim().toUpperCase();
    if(!normalized||locked||!canManage)return;
    await onApply(order,normalized);
  }

  return <section className={styles.promoControl} aria-label="رمز الخصم">
    <div className={styles.promoHeading}>
      <div><small>العروض</small><b>{promotion?'تم تطبيق رمز الخصم':'هل لديك برومو كود؟'}</b></div>
      {promotion&&<span>{promotion.code}</span>}
    </div>
    {promotion?<>
      <dl className={styles.promoTotals}>
        <div><dt>السعر قبل الخصم</dt><dd>{money(listSubtotal,order.currency)}</dd></div>
        <div className={styles.promoDiscount}><dt>الخصم</dt><dd>- {money(discount,order.currency)}</dd></div>
        <div><dt>بعد الخصم</dt><dd>{money(order.subtotalMinor,order.currency)}</dd></div>
        <div><dt>الضريبة</dt><dd>{money(order.taxMinor,order.currency)}</dd></div>
        <div className={styles.promoGrandTotal}><dt>الإجمالي المستحق</dt><dd>{money(order.totalMinor,order.currency)}</dd></div>
      </dl>
      {promotion.status==='reserved'&&canManage&&<button
        type="button"
        className={styles.promoRemove}
        disabled={locked}
        onClick={()=>void onRemove(order)}
      >{busy==='promo-remove-'+order.id?'جارٍ الإزالة…':'إزالة الرمز'}</button>}
      {promotion.status==='redeemed'&&<small className={styles.promoHint}>تم تثبيت الخصم على عملية الدفع الناجحة.</small>}
    </>:<form className={styles.promoForm} onSubmit={submit}>
      <input
        value={code}
        onChange={event=>setCode(event.target.value.toUpperCase())}
        minLength="3"
        maxLength="32"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck="false"
        dir="ltr"
        placeholder="PROMO2026"
        pattern="[A-Za-z0-9][A-Za-z0-9_-]{2,31}"
        aria-label="اكتب البرومو كود"
        disabled={locked||!canManage}
      />
      <button type="submit" disabled={locked||!canManage||!code.trim()}>
        {busy==='promo-apply-'+order.id?'جارٍ التطبيق…':'تطبيق'}
      </button>
      <small>يُفحص الرمز ويُحسب السعر داخل أودير قبل إنشاء رابط الدفع.</small>
    </form>}
  </section>;
}
