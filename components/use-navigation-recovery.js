'use client';

import {useEffect} from 'react';
import {
  NAVIGATION_RECOVERY_KEY,
  shouldAutoReloadNavigation
} from '../lib/navigation-recovery.mjs';

function recoveryTimestamp(){
  try{
    return Number(globalThis.sessionStorage?.getItem(NAVIGATION_RECOVERY_KEY)||0);
  }catch{
    return 0;
  }
}

function markRecovery(){
  try{
    const storage=globalThis.sessionStorage;
    if(!storage||typeof storage.setItem!=='function')return false;
    storage.setItem(
      NAVIGATION_RECOVERY_KEY,
      String(Date.now())
    );
    return true;
  }catch{
    return false;
  }
}

export function reloadDocument(){
  markRecovery();
  globalThis.location.reload();
}

export function useNavigationRecovery(error,{
  logLabel='application-render-failure'
}={}){
  useEffect(()=>{
    console.error('['+logLabel+']',{
      digest:error?.digest||null,
      name:error?.name||'Error'
    });
    const now=Date.now();
    if(!shouldAutoReloadNavigation({
      error,
      previousRecoveryAt:recoveryTimestamp(),
      now
    }))return;
    if(!markRecovery())return;
    globalThis.location.reload();
  },[error,logLabel]);
}
