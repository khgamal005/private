const WINDOW_KEY='__odeirPaymobCheckoutWindowV1';
const WINDOW_NAME='odeir_paymob_checkout_v1';
const PAYMOB_HOSTS=new Set([
  'ksa.paymob.com',
  'ksa.checkout.paymob.com'
]);

function browserWindow(){
  return typeof window==='undefined'?null:window;
}

export function openPaymobCheckoutWindow(){
  const current=browserWindow();
  if(!current)return null;
  try{
    const existing=current[WINDOW_KEY];
    if(existing&&!existing.closed){
      try{existing.focus();}catch{}
      return existing;
    }
    const checkoutWindow=current.open(
      'about:blank',
      WINDOW_NAME,
      'popup=yes,width=520,height=760,resizable=yes,scrollbars=yes'
    );
    if(!checkoutWindow)return null;
    current[WINDOW_KEY]=checkoutWindow;
    try{
      checkoutWindow.opener=null;
      const checkoutDocument=checkoutWindow.document;
      checkoutDocument.documentElement.lang='ar';
      checkoutDocument.documentElement.dir='rtl';
      checkoutDocument.title='جارٍ فتح بوابة الدفع';
      checkoutDocument.body.replaceChildren();
      Object.assign(checkoutDocument.body.style,{
        margin:'0',
        minHeight:'100vh',
        display:'grid',
        placeItems:'center',
        fontFamily:'system-ui,sans-serif',
        background:'#f4f8fb',
        color:'#0b3652'
      });
      const card=checkoutDocument.createElement('main');
      Object.assign(card.style,{
        width:'min(88vw,420px)',
        boxSizing:'border-box',
        padding:'32px',
        borderRadius:'24px',
        background:'#fff',
        boxShadow:'0 18px 55px rgba(7,45,68,.14)',
        textAlign:'center'
      });
      const title=checkoutDocument.createElement('h1');
      title.textContent='جارٍ فتح صفحة Paymob الآمنة';
      title.style.fontSize='22px';
      const description=checkoutDocument.createElement('p');
      description.textContent='لحظات وسيتم تحويلك إلى بوابة الدفع. أبقِ نافذة أودير الأصلية مفتوحة لمتابعة النتيجة.';
      description.style.lineHeight='1.8';
      card.append(title,description);
      checkoutDocument.body.append(card);
    }catch{}
    return checkoutWindow;
  }catch{return null;}
}

export function navigatePaymobCheckoutWindow(candidate,checkoutUrl){
  const current=browserWindow();
  if(!current||!candidate||candidate.closed)return false;
  try{
    const url=new URL(String(checkoutUrl||''));
    if(url.protocol!=='https:'||url.port||url.username||url.password
       ||!PAYMOB_HOSTS.has(url.hostname)||!validPaymobPath(url))return false;
    candidate.location.replace(url.toString());
    current[WINDOW_KEY]=candidate;
    try{candidate.focus();}catch{}
    return true;
  }catch{return false;}
}

export function closePaymobCheckoutWindow(candidate=null){
  const current=browserWindow();
  if(!current)return;
  const stored=current[WINDOW_KEY]||null;
  const checkoutWindow=candidate||stored;
  if(checkoutWindow&&!checkoutWindow.closed){
    try{checkoutWindow.close();}catch{}
  }
  if(!candidate||candidate===stored){
    try{delete current[WINDOW_KEY];}catch{current[WINDOW_KEY]=null;}
  }
  try{current.focus();}catch{}
}

function validPaymobPath(url){
  if(url.hostname==='ksa.checkout.paymob.com')return url.pathname==='/';
  return ['/flash','/flash/','/api/ecommerce/payment-links/unrestricted']
    .includes(url.pathname);
}
