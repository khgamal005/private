const ARABIC_DIGITS='٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
const ASCII_DIGITS='01234567890123456789';

function asciiPhone(value){
  return Array.from(String(value??''),character=>{
    const index=ARABIC_DIGITS.indexOf(character);
    return index===-1?character:ASCII_DIGITS[index];
  }).join('');
}

export function phoneDigits(value){
  return asciiPhone(value).replace(/[^0-9]/g,'');
}

export function normalizeCustomerPhoneIdentity(value){
  let digits=phoneDigits(value);
  if(digits.startsWith('00'))digits=digits.slice(2);

  if(/^(?:9660?|996)5[0-9]{8}$/.test(digits)){
    return `966${digits.slice(-9)}`;
  }
  if(/^05[0-9]{8}$/.test(digits))return `966${digits.slice(1)}`;
  if(/^5[0-9]{8}$/.test(digits))return `966${digits}`;
  if(digits.length===10&&digits.startsWith('0')){
    return `966${digits.slice(1)}`;
  }
  if(digits.length>=8&&digits.length<=15)return digits;
  return '';
}

export function formatCustomerPhone(value){
  const original=asciiPhone(value).trim();
  if(!original)return '';
  const identity=normalizeCustomerPhoneIdentity(original);
  if(/^9665[0-9]{8}$/.test(identity)){
    return `0${identity.slice(-9)}`;
  }
  return original;
}

export function toCustomerDialNumber(value){
  const formatted=formatCustomerPhone(value);
  if(/^05[0-9]{8}$/.test(formatted))return formatted;

  const identity=normalizeCustomerPhoneIdentity(value);
  if(!identity)return '';
  const original=asciiPhone(value).trim();
  if(original.startsWith('+')||original.startsWith('00')){
    return `+${identity}`;
  }
  return identity;
}

export function toWhatsAppNumber(value){
  return normalizeCustomerPhoneIdentity(value);
}
