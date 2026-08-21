export const DEFAULT_APP_ORIGIN='https://odeir.com';

export function normalizeRecoveryEmail(value){
  if(typeof value!=='string')return null;
  const email=value.trim().toLowerCase();
  if(!email||email.length>254)return null;
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return null;
  return email;
}

export function recoveryRedirectUrl(configuredOrigin){
  const fallback=new URL(DEFAULT_APP_ORIGIN);
  let origin=fallback;
  try{
    const candidate=new URL(String(configuredOrigin||DEFAULT_APP_ORIGIN));
    if(candidate.protocol==='https:'||candidate.hostname==='localhost'){
      origin=candidate;
    }
  }catch{
    origin=fallback;
  }
  return new URL('/reset-password',origin.origin).toString();
}

export function validateRecoveryPassword(password,confirm){
  if(typeof password!=='string'||password.length<12){
    return 'كلمة المرور يجب ألا تقل عن 12 حرفًا';
  }
  if(password!==confirm){
    return 'كلمتا المرور غير متطابقتين';
  }
  return null;
}
