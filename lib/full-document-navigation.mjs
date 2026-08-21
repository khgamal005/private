const APP_ORIGIN='https://app.marktone.sa';

function internalDocumentPath(value){
  if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')){
    return null;
  }
  try{
    const parsed=new URL(value,APP_ORIGIN);
    if(parsed.origin!==APP_ORIGIN)return null;
    const destination=parsed.pathname+parsed.search+parsed.hash;
    if(destination.startsWith('//'))return null;
    return destination;
  }catch{
    return null;
  }
}

export function safeDocumentPath(value,fallback='/'){
  return internalDocumentPath(value)||internalDocumentPath(fallback)||'/';
}

export function replaceDocument(value,{
  fallback='/',
  location=globalThis.location
}={}){
  if(!location||typeof location.replace!=='function'){
    throw new Error('Document navigation is not available');
  }
  const destination=safeDocumentPath(value,fallback);
  // Auth/session boundaries bypass Next RSC until vercel/next.js#97337 is fixed.
  location.replace(destination);
  return destination;
}
