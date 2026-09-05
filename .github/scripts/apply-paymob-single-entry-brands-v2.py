from pathlib import Path
import re
import textwrap


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    require(text.count(old) == 1, f"{label}: expected one exact anchor, found {text.count(old)}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str) -> str:
    updated, count = re.subn(pattern, lambda _match: replacement, text, count=1)
    require(count == 1, f"{label}: expected one regex match, found {count}")
    return updated


# Keep the mature SQL/Edge checkout contract intact, but stop collecting the
# same customer details twice. The browser route creates a deterministic,
# non-customer compatibility envelope used only for ODEIR's keyed attempt
# digest. QuickLink never forwards this envelope to Paymob.
route_path = Path("app/api/payments/paymob/checkout/route.js")
route = route_path.read_text(encoding="utf-8")
route = regex_once(
    route,
    r"\nconst BILLING_CONTACT_KEYS=new Set\(\[\n[\s\S]*?\n\]\);",
    "",
    "checkout billing-key allowlist",
)
route = replace_once(
    route,
    "return json({error:'تحقق من الاسم والبريد ورقم الجوال السعودي ثم أعد المحاولة'},{status:400});",
    "return json({error:'بيانات طلب الدفع غير صالحة'},{status:400});",
    "checkout validation message",
)
route = regex_once(
    route,
    r"function checkoutInput\(body\)\{[\s\S]*?\n\}\n\nfunction verifiedCheckoutUrl",
    r"""function checkoutInput(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return null;
  // billingContact stays in the outer allowlist during rolling deployment so
  // an older cached browser bundle remains safe. Any client-supplied contact
  // object is ignored and never becomes part of the provider request.
  if(Object.keys(body).some(key=>!CHECKOUT_INPUT_KEYS.has(key)))return null;
  const slug=String(body.slug||'').trim().toLowerCase();
  const orderId=String(body.orderId||'').trim();
  const idempotencyKey=String(body.idempotencyKey||'').trim();
  const paymentOption=String(body.paymentOption||'hosted').trim().toLowerCase();
  if(!SLUG.test(slug)||!UUID.test(orderId)
     ||!IDEMPOTENCY_KEY.test(idempotencyKey)
     ||!PAYMENT_OPTIONS.has(paymentOption))return null;

  return {
    slug,
    orderId,
    idempotencyKey,
    paymentOption,
    billingContact:checkoutCompatibilityContact(orderId)
  };
}

function checkoutCompatibilityContact(orderId){
  // The active provider route is QuickLink. Its outbound request contains only
  // amount, integration, reference, expiry and notification URL. These values
  // satisfy the existing keyed digest contract without collecting customer PII.
  const opaqueOrder=orderId.replaceAll('-','');
  return {
    firstName:'ODEIR',
    lastName:'Checkout',
    email:`paymob-${opaqueOrder}@checkout.odeir.invalid`,
    phoneNumber:'+966500000000'
  };
}

function verifiedCheckoutUrl""",
    "checkout input parser",
)
for forbidden in (
    "contact.firstName",
    "contact.lastName",
    "contact.email",
    "contact.phoneNumber",
    "function cleanText(",
    "function validEmail(",
    "function saudiPhone(",
):
    require(forbidden not in route, f"checkout route still contains {forbidden}")
require(
    "billingContact:checkoutCompatibilityContact(orderId)" in route,
    "checkout compatibility envelope was not installed",
)
route_path.write_text(route, encoding="utf-8")


def patch_store(path_name: str, old_copy: str, new_copy: str) -> None:
    path = Path(path_name)
    text = path.read_text(encoding="utf-8")

    text = regex_once(
        text,
        r"\n  const \[billingFirstName,setBillingFirstName\]=useState\(''\);\n"
        r"  const \[billingLastName,setBillingLastName\]=useState\(''\);\n"
        r"  const \[billingEmail,setBillingEmail\]=useState\(''\);\n"
        r"  const \[billingPhone,setBillingPhone\]=useState\(''\);",
        "",
        f"{path_name} billing state",
    )
    text = regex_once(
        text,
        r"\n  function resetBillingContact\(\)\{[\s\S]*?\n  \}\n\n  function choosePaymentProvider",
        "\n  function choosePaymentProvider",
        f"{path_name} billing helpers",
    )
    reset_calls = text.count("resetBillingContact();")
    require(reset_calls == 2, f"{path_name}: expected two reset calls, found {reset_calls}")
    text = text.replace("    resetBillingContact();", "")
    text = regex_once(
        text,
        r"          paymentOption,\n          billingContact:billingContact\(\)",
        "          paymentOption",
        f"{path_name} browser checkout payload",
    )

    text, field_count = re.subn(
        r"\n\s*(?:\{selectedMethod\?\.key==='paymob'&&)?<PaymobBillingFields[\s\S]*?/>(?:\})?",
        lambda _match: "",
        text,
    )
    require(field_count == 2, f"{path_name}: expected two billing forms, found {field_count}")
    text = regex_once(
        text,
        r"\nfunction PaymobBillingFields\([\s\S]*?\n\}\n\n(?=function )",
        "\n",
        f"{path_name} billing component",
    )
    text = replace_once(text, old_copy, new_copy, f"{path_name} payment guidance")

    for forbidden in (
        "billingFirstName",
        "billingLastName",
        "billingEmail",
        "billingPhone",
        "PaymobBillingFields",
        "billingContact:billingContact()",
        "resetBillingContact",
        'autoComplete="given-name"',
        'autoComplete="family-name"',
    ):
        require(forbidden not in text, f"{path_name}: obsolete UI remained: {forbidden}")
    require(
        "مرة واحدة فقط داخل صفحة Paymob" in text,
        f"{path_name}: single-entry guidance missing",
    )
    path.write_text(text, encoding="utf-8")


patch_store(
    "components/marketplace-addon-store-v2.js",
    "أدخل بيانات الفاتورة، ثم سننقلك إلى صفحة Paymob المشفّرة لإكمال الدفع. لا تُفعّل الإضافة إلا بعد وصول تأكيد الدفع الموثق إلى أودير.",
    "اختر وسيلة الدفع، ثم سننقلك مباشرة إلى Paymob. ستدخل بيانات الاتصال والبطاقة مرة واحدة فقط داخل صفحة Paymob الآمنة، ولا تُفعّل الإضافة إلا بعد وصول التأكيد الموثق إلى أودير.",
)
patch_store(
    "components/marketplace-store.js",
    "أدخل بيانات الفاتورة، ثم سننقلك إلى صفحة Paymob المشفّرة. لا يبدأ تنفيذ الخدمة إلا بعد وصول تأكيد الدفع الموثق إلى أودير.",
    "اختر وسيلة الدفع، ثم سننقلك مباشرة إلى Paymob. ستدخل بيانات الاتصال والبطاقة مرة واحدة فقط داخل صفحة Paymob الآمنة، ولا يبدأ تنفيذ الخدمة إلا بعد وصول التأكيد الموثق إلى أودير.",
)


picker = r"""'use client';
/* eslint-disable @next/next/no-img-element */

import styles from './marketplace-store.module.css';

const OPTION_KEYS=new Set(['hosted','card','apple_pay']);
const CARD_BRANDS=[
  {src:'/payment-brands/visa.svg',label:'Visa'},
  {src:'/payment-brands/mastercard.svg',label:'Mastercard'},
  {src:'/payment-brands/mada.svg',label:'مدى'},
  {src:'/payment-brands/amex.svg',label:'American Express'}
];
const APPLE_PAY={src:'/payment-brands/apple-pay.svg',label:'Apple Pay'};

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
          ?'Visa وMastercard ومدى وAmerican Express وApple Pay'
          :method.key==='bank_transfer'
            ?'إرسال بيانات التحويل ثم مراجعتها'
            :'إتمام الدفع بالطريقة المحددة';
        return <label key={method.key}
          className={selected?styles.paymentMethodSelected:styles.paymentMethodOption}>
          <input type="radio" name="paymentProvider" value={method.key}
            checked={selected} onChange={()=>onChange(method.key)} required/>
          <i className={method.key==='paymob'?styles.paymobProviderMark:''}
            aria-hidden="true">{method.key==='paymob'?'paymob':method.key==='bank_transfer'?'↔':'•'}</i>
          <span>
            <b>{method.name}</b>
            <small>{description}</small>
            {method.key==='paymob'&&<PaymentBrandStrip includeApple compact/>}
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
          ?'البطاقات البنكية المدعومة داخل صفحة Paymob'
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
"""
Path("components/payment-method-picker.js").write_text(
    textwrap.dedent(picker).lstrip(), encoding="utf-8"
)


css_path = Path("components/marketplace-store.module.css")
css = css_path.read_text(encoding="utf-8")
marker = "/* PAYMOB_SINGLE_ENTRY_BRANDS_V2 */"
require(marker not in css, "payment brand styles already exist")
css += r"""

/* PAYMOB_SINGLE_ENTRY_BRANDS_V2 */
.paymobProviderMark{width:68px!important;height:34px!important;border:1px solid #cddff1!important;background:#fff!important;color:#2367f2!important;padding:0 6px!important;font-family:Arial,sans-serif!important;font-size:13px!important;font-style:italic!important;font-weight:900!important;text-transform:lowercase}
.paymentBrandStrip{display:flex!important;width:max-content;max-width:100%;align-items:center;gap:7px;margin-top:4px;padding:6px 8px;border:1px solid #dce7ed;border-radius:9px;background:#fff}
.paymentBrandStripCompact{gap:5px;padding:4px 6px}
.paymentBrandStrip img{display:block;width:auto;height:17px;max-width:38px;object-fit:contain}
.paymentBrandStrip img[src$="mada.svg"]{height:19px;max-width:44px}
.paymentBrandStrip img[src$="apple-pay.svg"]{height:20px;max-width:52px}
.paymobOptionMark{display:flex!important;overflow:hidden;min-width:96px;height:46px;align-items:center;justify-content:center;border:1px solid #dce7ed;border-radius:10px;background:#fff!important;padding:0 9px!important;box-sizing:border-box}
.cardBrandStrip{min-width:194px!important;gap:8px}
.cardBrandStrip img{display:block;width:auto;height:21px;max-width:43px;object-fit:contain}
.cardBrandStrip img[src$="mada.svg"]{height:23px;max-width:49px}
.applePayBrand{min-width:110px!important}
.applePayBrand img{display:block;width:92px;height:auto;max-height:29px;object-fit:contain}
.hostedPaymobBrand{min-width:112px!important;color:#2367f2!important;font-family:Arial,sans-serif!important;font-size:17px!important;font-style:italic!important;font-weight:900!important;text-transform:lowercase}
.paymobOptionPicker>p{border-top:1px solid #dce8ee;padding-top:10px;color:#466b82;font-weight:800}
@media(max-width:760px){
  .paymobOptionGrid{grid-template-columns:1fr}
  .paymobOption,.paymobOptionSelected{grid-template-columns:minmax(118px,auto) minmax(0,1fr) auto;padding:11px}
  .cardBrandStrip{min-width:166px!important;gap:6px}
  .cardBrandStrip img{height:18px;max-width:36px}
  .cardBrandStrip img[src$="mada.svg"]{height:20px;max-width:42px}
  .applePayBrand{min-width:104px!important}
}
@media(max-width:430px){
  .paymentBrandStrip{width:100%;justify-content:space-around;box-sizing:border-box}
  .paymentBrandStrip img{height:15px;max-width:31px}
  .paymentBrandStrip img[src$="mada.svg"]{height:18px;max-width:38px}
  .paymentBrandStrip img[src$="apple-pay.svg"]{height:18px;max-width:44px}
  .paymobOption,.paymobOptionSelected{grid-template-columns:1fr auto;gap:8px}
  .paymobOptionMark{grid-column:1/-1;width:100%}
  .cardBrandStrip{min-width:0!important;justify-content:space-around}
  .paymobOption>span:not(.paymobOptionMark),.paymobOptionSelected>span:not(.paymobOptionMark){grid-column:1}
  .paymobOption>em,.paymobOptionSelected>em{grid-column:2;grid-row:2}
}
"""
css_path.write_text(css + "\n", encoding="utf-8")


assets = {
    "public/payment-brands/visa.svg": """<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 24 24"><title>Visa</title><path fill="#1434CB" d="M9.112 8.262 5.97 15.758H3.92L2.374 9.775c-.094-.368-.175-.503-.461-.658C1.447 8.864.677 8.627 0 8.479l.046-.217h3.3a.904.904 0 0 1 .894.764l.817 4.338 2.018-5.102zm8.033 5.049c.008-1.979-2.736-2.088-2.717-2.972.006-.269.262-.555.822-.628a3.66 3.66 0 0 1 1.913.336l.34-1.59a5.207 5.207 0 0 0-1.814-.333c-1.917 0-3.266 1.02-3.278 2.479-.012 1.079.963 1.68 1.698 2.04.756.367 1.01.603 1.006.931-.005.504-.602.725-1.16.734-.975.015-1.54-.263-1.992-.473l-.351 1.642c.453.208 1.289.39 2.156.398 2.037 0 3.37-1.006 3.377-2.564m5.061 2.447H24l-1.565-7.496h-1.656a.883.883 0 0 0-.826.55l-2.909 6.946h2.036l.405-1.12h2.488zm-2.163-2.656 1.02-2.815.588 2.815zm-8.16-4.84-1.603 7.496H8.34l1.605-7.496z"/></svg>""",
    "public/payment-brands/mastercard.svg": """<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 48 30"><title>Mastercard</title><defs><clipPath id="mc-left"><circle cx="20" cy="15" r="11"/></clipPath></defs><circle cx="20" cy="15" r="11" fill="#EB001B"/><circle cx="28" cy="15" r="11" fill="#F79E1B"/><circle cx="28" cy="15" r="11" fill="#FF5F00" clip-path="url(#mc-left)"/></svg>""",
    "public/payment-brands/mada.svg": """<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 151.61 50.54"><title>mada</title><path d="M0 29.15h64.14v21.39H0z" fill="#82bc00"/><path d="M0 0h64.14v21.38H0z" fill="#00a1df"/><path fill="#111" d="M128.27 46.17l-.28.06a9.71 9.71 0 0 1-2.08.26c-1.67 0-3.65-.85-3.65-4.9 0-2.08.36-4.83 3.46-4.83a8.9 8.9 0 0 1 2.29.42l.24.08Zm.52-20.13-.52.09v7.47l-.57-.17a10.59 10.59 0 0 0-2.84-.5c-6.25 0-7.57 4.73-7.57 8.69 0 5.43 3 8.55 8.36 8.55a17.17 17.17 0 0 0 5.6-.79c1.54-.49 2.1-1.2 2.1-2.7V25.26c-1.5.29-3 .53-4.56.78Zm18 20.27-.26.07-1 .25a9.44 9.44 0 0 1-2.3.37c-1.47 0-2.35-.73-2.35-2 0-.8.36-2.14 2.76-2.14h3.1Zm-2.18-13.47A21.14 21.14 0 0 0 138.3 34l-1.6.49.53 3.6 1.56-.51a18.33 18.33 0 0 1 5.19-.87c.7 0 2.8 0 2.8 2.27v1h-2.92c-5.3 0-7.77 1.69-7.77 5.32 0 3.11 2.26 4.95 6.08 4.95a18.81 18.81 0 0 0 4.23-.57h.15l.47.08c1.49.27 3 .53 4.53.84V38.64c0-3.85-2.32-5.8-6.89-5.8Zm-34.76 13.47-.26.07-1 .25a9.28 9.28 0 0 1-2.29.37c-1.47 0-2.35-.73-2.35-2 0-.8.36-2.14 2.76-2.14h3.1Zm-2.18-13.47A21.2 21.2 0 0 0 101.31 34l-1.6.49.54 3.6 1.55-.51a18.33 18.33 0 0 1 5.2-.87c.68 0 2.78 0 2.78 2.27v1h-2.91c-5.3 0-7.78 1.69-7.78 5.32 0 3.11 2.27 4.95 6.08 4.95a19 19 0 0 0 4.24-.57h.15l.47.08c1.49.27 3 .53 4.53.84V38.64c0-3.86-2.32-5.8-6.89-5.8Zm-17.89.04A12.77 12.77 0 0 0 84.62 34l-.19.09-.16-.09a7.82 7.82 0 0 0-4.64-1.12 18.71 18.71 0 0 0-5.46.81c-1.62.5-2.25 1.27-2.25 2.73V50H77V37.46l.24-.08a6.81 6.81 0 0 1 2.23-.4c1.47 0 2.2.77 2.2 2.3V50h5V39.06a2.89 2.89 0 0 0-.18-1.06l-.16-.33.34-.15A6 6 0 0 1 89.14 37a2 2 0 0 1 2.22 1.79v11.22h5V38.77c0-4-2.14-5.89-6.56-5.89Z"/></svg>""",
    "public/payment-brands/apple-pay.svg": """<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 24 24"><title>Apple Pay</title><path d="M2.15 4.318c-.151 0-.303.001-.454.003-.15.005-.303.013-.452.04a1.44 1.44 0 0 0-1.06.772c-.07.138-.114.278-.14.43-.028.148-.037.3-.04.45L0 6.222v11.557l.003.207c.004.15.013.303.04.452.027.15.072.291.142.429a1.436 1.436 0 0 0 .63.63c.138.07.278.115.43.142.148.027.3.036.45.04l.208.003h20.194l.207-.003c.15-.004.303-.013.452-.04.15-.027.291-.071.428-.141a1.432 1.432 0 0 0 .631-.631c.07-.138.115-.278.141-.43.027-.148.036-.3.04-.45l.003-.208V6.221l-.004-.207a2.995 2.995 0 0 0-.04-.452 1.446 1.446 0 0 0-1.2-1.201 3.022 3.022 0 0 0-.452-.04l-.453-.003Zm4.71 6.212c-.3.016-.668.199-.88.456-.191.22-.36.58-.316.918.338.03.675-.169.888-.418.205-.258.345-.603.308-.955Zm2.207-1.58v5.493h.852v-1.877h1.18c1.078 0 1.835-.739 1.835-1.812 0-1.07-.742-1.805-1.808-1.805Zm.852.719h.982c.739 0 1.161.396 1.161 1.089 0 .692-.422 1.092-1.164 1.092h-.979Zm-3.154.3c-.45.01-.83.28-1.05.28-.235 0-.593-.264-.981-.257a1.446 1.446 0 0 0-1.23.747c-.527.908-.139 2.255.374 2.995.249.366.549.769.944.754.373-.014.52-.242.973-.242.454 0 .586.242.98.235.41-.007.667-.366.915-.733.286-.417.403-.82.41-.841-.007-.008-.79-.308-.797-1.209-.008-.754.615-1.113.644-1.135-.352-.52-.9-.578-1.09-.593Zm8.204.397c-.99 0-1.606.533-1.652 1.256h.777c.072-.358.369-.586.845-.586.502 0 .803.266.803.711v.309l-1.097.064c-.951.054-1.488.484-1.488 1.184 0 .72.548 1.207 1.332 1.207.526 0 1.032-.281 1.264-.727h.019v.659h.788v-2.76c0-.803-.62-1.317-1.591-1.317Zm1.94.072 1.446 4.009-.073.247c-.125.41-.33.571-.711.571-.069 0-.206 0-.267-.015v.666c.06.011.267.019.335.019.83 0 1.226-.312 1.568-1.283l1.5-4.214h-.868l-1.012 3.259h-.015l-1.013-3.26Zm-1.167 2.189v.316c0 .521-.45.917-1.024.917-.442 0-.731-.228-.731-.579 0-.342.278-.56.769-.593Z"/></svg>""",
    "public/payment-brands/amex.svg": """<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 64 40"><title>American Express</title><rect width="64" height="40" rx="4" fill="#2E77BC"/><path fill="none" stroke="#fff" stroke-width="2" d="M7 11h50v18H7z"/><text x="32" y="25.5" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="900" fill="#fff">AMERICAN EXPRESS</text></svg>""",
}
for name, content in assets.items():
    destination = Path(name)
    require(not destination.exists(), f"asset already exists: {name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content + "\n", encoding="utf-8")


# Focused contract tests guard data minimisation, rolling compatibility,
# allowlisted redirects and local payment-brand rendering.
test_path = Path("tests/paymob-checkout-ui.test.mjs")
tests = test_path.read_text(encoding="utf-8")
tests = replace_once(
    tests,
    "  services:'components/marketplace-store.js',\n",
    "  services:'components/marketplace-store.js',\n"
    "  paymentPicker:'components/payment-method-picker.js',\n"
    "  paymentStyles:'components/marketplace-store.module.css',\n"
    "  visaLogo:'public/payment-brands/visa.svg',\n"
    "  mastercardLogo:'public/payment-brands/mastercard.svg',\n"
    "  madaLogo:'public/payment-brands/mada.svg',\n"
    "  applePayLogo:'public/payment-brands/apple-pay.svg',\n"
    "  amexLogo:'public/payment-brands/amex.svg',\n",
    "test path registry",
)
tests = replace_once(
    tests,
    "  assert.match(source.checkoutRoute,/billingContact:\\{firstName,lastName,email,phoneNumber\\}/);\n",
    "  assert.match(source.checkoutRoute,/billingContact:checkoutCompatibilityContact\\(orderId\\)/);\n"
    "  assert.match(source.checkoutRoute,/@checkout\\.odeir\\.invalid/);\n"
    "  assert.match(source.checkoutRoute,/phoneNumber:'\\+966500000000'/);\n",
    "checkout compatibility assertion",
)
tests = replace_once(
    tests,
    "  assert.match(source.checkoutRoute,/Object\\.keys\\(contact\\)\\.some\\(key=>!BILLING_CONTACT_KEYS\\.has\\(key\\)\\)/);\n",
    "  assert.doesNotMatch(source.checkoutRoute,/contact\\.(?:firstName|lastName|email|phoneNumber)/);\n",
    "removed browser contact assertion",
)
replacement_tests = r"""test('ODEIR asks for contact and card data once, inside Paymob only',()=>{
  for(const text of [source.addons,source.services]){
    assert.doesNotMatch(text,/PaymobBillingFields/);
    assert.doesNotMatch(text,/(?:given-name|family-name|billingFirstName|billingEmail|billingPhone)/);
    assert.doesNotMatch(text,/billingContact:billingContact\(\)/);
    assert.match(text,/مرة واحدة فقط داخل صفحة Paymob الآمنة/);
    assert.doesNotMatch(text,/name=["'](?:card|cardNumber|cvv|cvc|expiry)["']/i);
  }
  assert.match(source.checkoutRoute,/function checkoutCompatibilityContact\(orderId\)/);
  assert.match(source.checkoutRoute,/const opaqueOrder=orderId\.replaceAll\('-',''\)/);
  assert.match(source.checkoutRoute,/billingContact:checkoutCompatibilityContact\(orderId\)/);
  assert.doesNotMatch(source.checkoutRoute,/function (?:cleanText|validEmail|saudiPhone)\(/);
});

test('configured Paymob rails display local payment-brand marks',()=>{
  for(const asset of [
    source.visaLogo,source.mastercardLogo,source.madaLogo,
    source.applePayLogo,source.amexLogo
  ]){
    assert.match(asset,/^<svg[\s\S]*<\/svg>\s*$/);
    assert.doesNotMatch(asset,/<(?:script|foreignObject|iframe)\b/i);
  }
  for(const path of [
    'visa.svg','mastercard.svg','mada.svg','apple-pay.svg','amex.svg'
  ]){
    assert.match(source.paymentPicker,new RegExp(`/payment-brands/${path.replace('.', '\\.')}`));
  }
  assert.match(source.paymentPicker,/CARD_BRANDS/);
  assert.match(source.paymentPicker,/Visa وMastercard ومدى وAmerican Express وApple Pay/);
  assert.match(source.paymentPicker,/role="img"/);
  assert.match(source.paymentStyles,/PAYMOB_SINGLE_ENTRY_BRANDS_V2/);
  assert.match(source.paymentStyles,/cardBrandStrip/);
  assert.match(source.paymentStyles,/applePayBrand/);
  assert.match(source.paymentStyles,/paymentBrandStrip/);
});

"""
tests = regex_once(
    tests,
    r"test\('billing UI asks only for identity/contact data and validates Saudi mobile formats',[\s\S]*?\n\}\);\n\n",
    replacement_tests,
    "billing UI tests",
)
test_path.write_text(tests, encoding="utf-8")

print("Paymob single-entry checkout UX patch applied")
