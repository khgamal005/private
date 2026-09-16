import 'server-only';
import {getTenantOdeirySnapshot} from './odeiry-api';
export async function campaignAiAvailable(slug){
 if(process.env.ODEIRY_AI_ENABLED!=='true'||process.env.ODEIRY_MANAGER_ENABLED!=='true')return false;
 try{const data=await getTenantOdeirySnapshot(slug);return data.available&&data.enabled&&data.mode==='tenant_member'&&data.manager.available;}catch{return false;}
}
