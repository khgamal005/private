'use client';
/* eslint-disable @next/next/no-img-element */

import styles from './payment-method-picker.module.css';
import {useId} from 'react';

const OPTION_KEYS=new Set(['hosted','card','apple_pay']);
const CARD_BRANDS=[
  {src:'/payment-brands/visa.svg',label:'Visa'},
  {src:'/payment-brands/mastercard.svg',label:'Mastercard'},
  {src:'/payment-brands/mada.svg',label:'مدى'},
  {src:'/payment-brands/amex.svg',label:'American Express'}
];
const APPLE_PAY={src:'/payment-brands/apple-pay-v2.svg',label:'Apple Pay'};

export function paymobOptions(paymentMethods){
  const paymob=(paymentMethods||[]).find(method=>method?.key==='paymob');
  const configured=[];
  const seen=new Set();
  for(const option of Array.isArray(paymob?.paymentOptions)
    ?paymob.paymentOptions:[]){
    const key=String(option?.key||'').trim().toLowerCase();
    const name=String(option?.name||'').trim();
    const nameEn=String(option?.nameEn||'').trim();
    if(!OPTION_KEYS.has(key)||seen.has(key)||!name||name.length>80)continue;
    seen.add(key);configured.push({key,name,nameEn:nameEn.slice(0,80)});
  }
  return configured.length?configured:[{
    key:'hosted',
    name:'الدفع الإلكتروني الآمن',
    nameEn:'Secure online payment'
  }];
}

export function defaultPaymobOption(paymentMethods){
  return paymobOptions(paymentMethods)[0]?.key||'hosted';
}

export function PaymentMethodPicker({methods,value,onChange}){
  const group=useId();
  const appleEnabled=paymobOptions(methods).some(option=>option.key==='apple_pay');
  return <fieldset className={styles.paymentMethodPicker}>
    <legend>وسيلة الدفع</legend>
    <div className={styles.paymentMethodGrid}>
      {(methods||[]).map(method=>{
        const selected=method.key===value;
        const description=method.key==='paymob'
          ?'دفع آمن بالبطاقة أو المحفظة المتاحة'
          :method.key==='tamara'
            ?'قسّم دفعتك حسب الخيارات المتاحة لدى تمارا'
          :method.key==='bank_transfer'
            ?'إرسال بيانات التحويل ثم مراجعتها'
            :'إتمام الدفع بالطريقة المحددة';
        return <label key={method.key}
          className={selected?styles.paymentMethodSelected:styles.paymentMethodOption}>
          <input type="radio" name={group} value={method.key}
            checked={selected} onChange={()=>onChange(method.key)} required/>
          {method.key==='tamara'?<img className={styles.tamaraLogo} src="/payment-brands/tamara-ar.svg" alt="" width="100" height="44"/>:<i className={method.key==='paymob'?styles.paymobProviderMark:''}
            aria-hidden="true">{method.key==='paymob'?'paymob':method.key==='bank_transfer'?'↔':'•'}</i>}
          <span>
            <b>{method.name}</b>
            <small>{description}</small>
            {method.key==='paymob'&&<PaymentBrandStrip includeApple={appleEnabled} compact/>}
          </span>
          <em aria-hidden="true">{selected?'✓':''}</em>
        </label>;
      })}
    </div>
  </fieldset>;
}

export function PaymobOptionPicker({
  paymentMethods,value,onChange,compact=false
}){
  const options=paymobOptions(paymentMethods);
  return <fieldset className={[
    styles.paymobOptionPicker,
    compact?styles.paymobOptionPickerCompact:''
  ].filter(Boolean).join(' ')}>
    <legend>اختر طريقة الدفع عبر Paymob</legend>
    <div className={styles.paymobOptionGrid}>
      {options.map(option=>{
        const selected=option.key===value;
        const description=option.key==='card'
          ?'بطاقات مدى، Visa وMastercard وAmerican Express'
          :option.key==='apple_pay'
            ?'الدفع السريع من أجهزة Apple المدعومة'
            :'تختار وسيلة الدفع داخل صفحة Paymob';
        return <label key={option.key}
          className={selected?styles.paymobOptionSelected:styles.paymobOption}>
          <input type="radio" name="paymobPaymentOption" value={option.key}
            checked={selected} onChange={()=>onChange(option.key)} required/>
          <PaymobBrandMark optionKey={option.key}/>
          <span><b>{option.name}</b><small>{description}</small></span>
          <em aria-hidden="true">{selected?'✓':''}</em>
        </label>;
      })}
    </div>
    <p>ستدخل بيانات الاتصال والبطاقة مرة واحدة فقط داخل صفحة Paymob الآمنة؛ أودير لا يطلب بيانات البطاقة ولا يخزنها.</p>
  </fieldset>;
}

function PaymentBrandStrip({includeApple=false,compact=false}){
  const brands=includeApple?[...CARD_BRANDS,APPLE_PAY]:CARD_BRANDS;
  return <span className={[
    styles.paymentBrandStrip,
    compact?styles.paymentBrandStripCompact:''
  ].filter(Boolean).join(' ')} role="img"
    aria-label={brands.map(brand=>brand.label).join('، ')}>
    {brands.map(brand=><img key={brand.src} src={brand.src} alt="" aria-hidden="true"/>)}
  </span>;
}

function PaymobBrandMark({optionKey}){
  if(optionKey==='card'){
    return <span className={[styles.paymobOptionMark,styles.cardBrandStrip].join(' ')}
      role="img" aria-label="Visa، Mastercard، مدى، American Express">
      {CARD_BRANDS.map(brand=><img key={brand.src} src={brand.src} alt="" aria-hidden="true"/>)}
    </span>;
  }
  if(optionKey==='apple_pay'){
    return <span className={[styles.paymobOptionMark,styles.applePayBrand].join(' ')}
      role="img" aria-label="Apple Pay">
      <img src={APPLE_PAY.src} alt="" aria-hidden="true"/>
    </span>;
  }
  return <span className={[styles.paymobOptionMark,styles.hostedPaymobBrand].join(' ')}
    role="img" aria-label="Paymob">paymob</span>;
}

