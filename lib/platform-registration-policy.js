import 'server-only';
import {authRpc} from './server-auth';
import {SUPABASE_SECRET_KEY} from './admin-config';
import {SUPABASE_KEY,SUPABASE_URL} from './config';

const EDGE_FUNCTION='odeir-registration-intake';

export async function getPlatformRegistrationPolicy(){
  const [policy,emailReadiness]=await Promise.all([
    authRpc('v1_platform_registration_policy_snapshot'),
    registrationEmailReadiness()
  ]);
  return withEmailReadiness(policy,emailReadiness);
}

export async function registrationEmailReadiness(){
  const ingressToken=process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'';
  const serverKey=SUPABASE_SECRET_KEY||'';
  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:ingressToken?SUPABASE_KEY:(serverKey||SUPABASE_KEY),
          'content-type':'application/json',
          ...(ingressToken?{'x-odeir-intake-token':ingressToken}:{})
        },
        body:JSON.stringify({action:'health'}),
        cache:'no-store',
        signal:AbortSignal.timeout(6_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    const healthy=response.ok&&result.ok===true;
    // During a rolling deploy, an older Edge may expose only `emailReady`.
    // Once `sendReady` exists it is authoritative and webhook telemetry is
    // deliberately not allowed to block the sending policy.
    const sendReady=healthy&&(
      result.sendReady===true
      ||(result.sendReady===undefined&&result.emailReady===true)
    );
    const telemetryReady=healthy&&result.telemetryReady===true;
    return {
      sendReady,
      telemetryReady,
      telemetryDegraded:sendReady&&!telemetryReady,
      domainAttestationReady:healthy&&result.domainAttestationReady===true,
      workerHealthy:healthy&&result.workerHealthy===true
    };
  }catch{
    return unavailableEmailReadiness();
  }
}

export async function registrationEmailReady(){
  return (await registrationEmailReadiness()).sendReady;
}

export function withEmailReadiness(policy,emailReadiness){
  return {
    ...policy,
    emailReady:emailReadiness.sendReady,
    emailSendReady:emailReadiness.sendReady,
    emailTelemetryReady:emailReadiness.telemetryReady,
    emailTelemetryDegraded:emailReadiness.telemetryDegraded,
    emailDomainAttestationReady:emailReadiness.domainAttestationReady,
    emailWorkerHealthy:emailReadiness.workerHealthy
  };
}

function unavailableEmailReadiness(){
  return {
    sendReady:false,
    telemetryReady:false,
    telemetryDegraded:false,
    domainAttestationReady:false,
    workerHealthy:false
  };
}
