import 'server-only';
import {authRpc} from './server-auth';
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
  const ingressToken=(process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'').trim();
  if(ingressToken.length<32)return unavailableEmailReadiness();
  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'content-type':'application/json',
          'x-odeir-intake-token':ingressToken
        },
        body:JSON.stringify({action:'health'}),
        cache:'no-store',
        signal:AbortSignal.timeout(6_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    const healthy=response.ok&&result.ok===true;
    const sendReady=healthy&&result.sendReady===true;
    const telemetryReady=healthy&&result.telemetryReady===true;
    const canaryReady=healthy&&result.canaryReady===true;
    const activationReady=healthy&&(
      result.activationReady===true
      ||(
        result.activationReady===undefined
        &&sendReady&&telemetryReady&&canaryReady
      )
    );
    return {
      activationReady,
      sendReady,
      telemetryReady,
      telemetryDegraded:sendReady&&!telemetryReady,
      canaryReady,
      canaryState:healthy?String(result.canaryState||'not_run'):'unavailable',
      canaryDeliveredAt:healthy&&result.canaryDeliveredAt
        ?String(result.canaryDeliveredAt):null,
      domainAttestationReady:healthy&&result.domainAttestationReady===true,
      workerHealthy:healthy&&result.workerHealthy===true
    };
  }catch{
    return unavailableEmailReadiness();
  }
}

export async function registrationEmailActivationGrant(){
  const ingressToken=(process.env.ODEIR_REGISTRATION_INGRESS_TOKEN||'').trim();
  if(ingressToken.length<32){
    throw new Error('registration_email_activation_grant_unavailable');
  }
  try{
    const response=await fetch(
      `${SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`,
      {
        method:'POST',
        headers:{
          apikey:SUPABASE_KEY,
          'content-type':'application/json',
          'x-odeir-intake-token':ingressToken
        },
        body:JSON.stringify({action:'activation_grant'}),
        cache:'no-store',
        signal:AbortSignal.timeout(8_000)
      }
    );
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok!==true){
      throw new Error(String(
        result.error||'registration_email_activation_grant_unavailable'
      ));
    }
    const activationGrant=String(result.activationGrant||'');
    if(!/^[a-f0-9]{64}$/.test(activationGrant)){
      throw new Error('registration_email_activation_grant_unavailable');
    }
    return {
      activationGrant,
      readiness:readinessFromResult(result,true)
    };
  }catch(reason){
    const source=reason instanceof Error?reason.message:String(reason||'');
    if(source.includes('registration_email_activation_not_ready'))throw reason;
    throw new Error('registration_email_activation_grant_unavailable');
  }
}

export async function registrationEmailReady(){
  return (await registrationEmailReadiness()).activationReady;
}

export function failClosedRegistrationEmailReadiness(){
  return unavailableEmailReadiness();
}

export function withEmailReadiness(policy,emailReadiness){
  return {
    ...policy,
    emailReady:emailReadiness.activationReady,
    emailActivationReady:emailReadiness.activationReady,
    emailSendReady:emailReadiness.sendReady,
    emailTelemetryReady:emailReadiness.telemetryReady,
    emailTelemetryDegraded:emailReadiness.telemetryDegraded,
    emailCanaryReady:emailReadiness.canaryReady,
    emailCanaryState:emailReadiness.canaryState,
    emailCanaryDeliveredAt:emailReadiness.canaryDeliveredAt,
    emailDomainAttestationReady:emailReadiness.domainAttestationReady,
    emailWorkerHealthy:emailReadiness.workerHealthy
  };
}

function unavailableEmailReadiness(){
  return {
    activationReady:false,
    sendReady:false,
    telemetryReady:false,
    telemetryDegraded:false,
    canaryReady:false,
    canaryState:'unavailable',
    canaryDeliveredAt:null,
    domainAttestationReady:false,
    workerHealthy:false
  };
}

function readinessFromResult(result,healthy){
  const sendReady=healthy&&result.sendReady===true;
  const telemetryReady=healthy&&result.telemetryReady===true;
  const canaryReady=healthy&&result.canaryReady===true;
  const activationReady=healthy&&result.activationReady===true;
  return {
    activationReady,
    sendReady,
    telemetryReady,
    telemetryDegraded:sendReady&&!telemetryReady,
    canaryReady,
    canaryState:healthy?String(result.canaryState||'not_run'):'unavailable',
    canaryDeliveredAt:healthy&&result.canaryDeliveredAt
      ?String(result.canaryDeliveredAt):null,
    domainAttestationReady:healthy&&result.domainAttestationReady===true,
    workerHealthy:healthy&&result.workerHealthy===true
  };
}
