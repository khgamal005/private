'use client';

import styles from './marketplace-store.module.css';

const OPTION_KEYS=new Set(['hosted','card','apple_pay']);

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
  return <fieldset className={styles.paymentMethodPicker}>
    <legend>وسيلة الدفع</legend>
    <div className={styles.paymentMethodGrid}>
      {(methods||[]).map(method=>{
        const selected=method.key===value;
        const description=method.key==='paymob'
          ?'صفحة دفع مشفّرة، والتفعيل بعد التأكيد الموثق'
          :method.key==='bank_transfer'
            ?'إرسال بيانات التحويل ثم مراجعتها'
            :'إتمام الدفع بالطريقة المحددة';
        return <label key={method.key}
          className={selected?styles.paymentMethodSelected:styles.paymentMethodOption}>
          <input type="radio" name="paymentProvider" value={method.key}
            checked={selected} onChange={()=>onChange(method.key)} required/>
          <i aria-hidden="true">{method.key==='paymob'?'P':method.key==='bank_transfer'?'↔':'•'}</i>
          <span><b>{method.name}</b><small>{description}</small></span>
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
          ?'بطاقات مدى، Visa وMastercard'
          :option.key==='apple_pay'
            ?'الدفع السريع من أجهزة Apple المدعومة'
            :'تختار وسيلة الدفع داخل صفحة Paymob';
        return <label key={option.key}
          className={selected?styles.paymobOptionSelected:styles.paymobOption}>
          <input type="radio" name="paymobPaymentOption" value={option.key}
            checked={selected} onChange={()=>onChange(option.key)} required/>
          <span className={styles.paymobOptionMark} aria-hidden="true">
            {option.key==='apple_pay'?'Apple Pay':option.key==='card'?'CARD':'PAY'}
          </span>
          <span><b>{option.name}</b><small>{description}</small></span>
          <em aria-hidden="true">{selected?'✓':''}</em>
        </label>;
      })}
    </div>
    <p>لن تُرسل بيانات البطاقة إلى أودير؛ تُدخل داخل صفحة Paymob فقط.</p>
  </fieldset>;
}
