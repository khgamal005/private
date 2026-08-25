function cleanLabel(value,maxLength=240){
  return String(value??'')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g,' ')
    .replace(/\s+/g,' ')
    .trim()
    .slice(0,maxLength);
}

function safeHttpUrl(value){
  try{
    const url=new URL(String(value??'').trim());
    if(!['https:','http:'].includes(url.protocol)||url.username||url.password){
      return '';
    }
    return url.toString();
  }catch{
    return '';
  }
}

const PRODUCTION_APP_HOSTS=new Set(['odeir.com','www.odeir.com']);

function isLocalHostname(value){
  return value==='localhost'||value==='127.0.0.1';
}

export function normalizeRegistrationInvitationUrl(value,currentOrigin){
  try{
    const current=new URL(String(currentOrigin??'').trim());
    const url=new URL(String(value??'').trim(),current.origin);
    const sameOrigin=url.origin===current.origin;
    const productionPair=current.protocol==='https:'
      &&url.protocol==='https:'
      &&!current.port
      &&!url.port
      &&PRODUCTION_APP_HOSTS.has(current.hostname)
      &&PRODUCTION_APP_HOSTS.has(url.hostname);
    const localHttp=sameOrigin
      &&current.protocol==='http:'
      &&url.protocol==='http:'
      &&isLocalHostname(current.hostname);
    const parameters=[...url.searchParams.entries()];

    if((!sameOrigin&&!productionPair)
      ||(url.protocol!=='https:'&&!localHttp)
      ||url.username
      ||url.password
      ||url.hash
      ||url.pathname!=='/accept-invite'
      ||parameters.length!==1
      ||parameters[0][0]!=='token'
      ||!/^[0-9a-f]{64}$/i.test(parameters[0][1])){
      return '';
    }
    return url.toString();
  }catch{
    return '';
  }
}

function greeting(ownerName){
  const name=cleanLabel(ownerName,160);
  return name?`مرحبًا أ/ ${name} 👋`:'مرحبًا 👋';
}

export function buildRegistrationOwnerWhatsAppMessage({
  mode,
  institutionName,
  ownerName,
  ownerEmail,
  activationUrl,
  loginUrl
}){
  const institution=cleanLabel(institutionName,240)||'منشأتك';
  const salutation=greeting(ownerName);

  if(mode==='invited'){
    const url=safeHttpUrl(activationUrl);
    if(!url)return '';
    return [
      salutation,
      '',
      `يسعدنا إبلاغك بالموافقة على تسجيل منشأة «${institution}» في منصة أودير، وأصبحت مساحة المنشأة جاهزة.`,
      '',
      'لاستكمال تفعيل حساب مالك المنشأة وإنشاء كلمة المرور، افتح الرابط الآمن التالي:',
      url,
      '',
      '🔒 الرابط مخصص لك ويُستخدم مرة واحدة. حفاظًا على حسابك، لا تشاركه مع أي شخص، ولن نطلب منك كلمة المرور أو رمز التحقق عبر واتساب.',
      '',
      'أهلًا بك في أودير 🌟'
    ].join('\n');
  }

  if(mode==='linked'){
    const url=safeHttpUrl(loginUrl);
    if(!url)return '';
    const email=cleanLabel(ownerEmail,240);
    return [
      salutation,
      '',
      `تمت الموافقة على تسجيل منشأة «${institution}»، وأصبحت جاهزة للاستخدام على منصة أودير.`,
      '',
      'حسابك مرتبط بالفعل، ويمكنك تسجيل الدخول من هنا:',
      url,
      ...(email?['',`البريد المسجل: ${email}`]:[]),
      '',
      '🔒 حفاظًا على حسابك، لن نطلب منك كلمة المرور أو رمز التحقق عبر واتساب.',
      '',
      'أهلًا بك في أودير 🌟'
    ].join('\n');
  }

  return '';
}
