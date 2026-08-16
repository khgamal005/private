import {unstable_rethrow} from 'next/navigation';

function safeError(error){
  return {
    name:error instanceof Error?error.name:'UnknownError',
    digest:error?.digest||null
  };
}

export async function optionalServerRead(label,read,fallback=null){
  try{
    return await read();
  }catch(error){
    unstable_rethrow(error);
    console.error('[optional-server-read-failed]',{
      label,
      ...safeError(error)
    });
    return typeof fallback==='function'?fallback():fallback;
  }
}
