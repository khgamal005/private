import {createHash} from 'node:crypto';
import {Agent,run} from '@openai/agents';
import {cookies} from 'next/headers';
import {NextResponse} from 'next/server';
import {ACCESS_COOKIE,SUPABASE_KEY,SUPABASE_URL} from '../../../../../lib/config';
import {compactCmsDocument} from '../../../../../lib/cms-assistant-operations.mjs';
import {buildCmsAssistantInput,CMS_ASSISTANT_INSTRUCTIONS} from '../../../../../lib/cms-assistant-prompt';
import {CMS_ASSISTANT_PROPOSAL_SCHEMA} from '../../../../../lib/cms-assistant-schema';
import {BLOCK_CATALOG,ROW_LAYOUTS} from '../../../../../lib/website-builder';

export const runtime='nodejs';
export const maxDuration=45;

const assistant=new Agent({
  name:'Marktone CMS Design Assistant',
  instructions:CMS_ASSISTANT_INSTRUCTIONS,
  model:process.env.OPENAI_CMS_MODEL||'gpt-5-mini',
  outputType:CMS_ASSISTANT_PROPOSAL_SCHEMA
});
const rateBuckets=new Map();

export async function POST(request){
  try{
    if(!process.env.OPENAI_API_KEY){
      return NextResponse.json({error:'مساعد Marktone CMS غير مفعّل في بيئة التشغيل.'},{status:503});
    }
    if(!sameOrigin(request))return NextResponse.json({error:'تعذر التحقق من مصدر الطلب.'},{status:403});
    const declaredBytes=Number(request.headers.get('content-length')||0);
    if(declaredBytes>180000)return NextResponse.json({error:'حجم سياق الصفحة أكبر من الحد المسموح.'},{status:413});
    const token=(await cookies()).get(ACCESS_COOKIE)?.value;
    if(!token)return NextResponse.json({error:'انتهت جلسة الدخول.'},{status:401});
    const body=await request.json();
    const userRequest=String(body?.request||'').trim().slice(0,2400);
    if(userRequest.length<3)return NextResponse.json({error:'اكتب التعديل الذي تريد تنفيذه.'},{status:400});
    const siteKey=validKey(body?.siteKey,'marktone-main');
    const tenantSlug=body?.tenantSlug?validKey(body.tenantSlug,''):null;
    const context=await loadContext(token);
    if(!canUseCmsAssistant(context,tenantSlug,siteKey)){
      return NextResponse.json({error:'لا تملك صلاحية استخدام مساعد هذا الموقع.'},{status:403});
    }
    if(!consumeRate(context,token)){
      return NextResponse.json({error:'تم إرسال طلبات كثيرة في وقت قصير. انتظر دقيقة ثم أعد المحاولة.'},{status:429});
    }
    const document=compactCmsDocument(body?.document||{});
    const moduleCatalog=Object.entries(BLOCK_CATALOG).map(([type,item])=>({type,label:item.label,description:item.description}));
    const input=buildCmsAssistantInput({
      request:userRequest,
      entity:compactCmsDocument(body?.entity||{}, {maxDepth:3,maxArray:12,maxString:240}),
      device:['desktop','tablet','mobile'].includes(body?.device)?body.device:'desktop',
      selection:compactCmsDocument(body?.selection||null,{maxDepth:3,maxArray:8,maxString:160}),
      document,
      moduleCatalog:{modules:moduleCatalog,layouts:Object.keys(ROW_LAYOUTS)}
    });
    const result=await run(assistant,input,{maxTurns:2});
    const proposal=CMS_ASSISTANT_PROPOSAL_SCHEMA.parse(result.finalOutput);
    return NextResponse.json({proposal},{headers:{'Cache-Control':'no-store, private'}});
  }catch(error){
    console.error('cms_assistant_plan_failed',safeError(error));
    if(error?.status===401)return NextResponse.json({error:'انتهت جلسة الدخول.'},{status:401});
    const message=String(error?.message||'');
    const overloaded=/rate|quota|429/i.test(message);
    return NextResponse.json({
      error:overloaded?'المساعد مشغول الآن. أعد المحاولة بعد لحظات.':'تعذر تجهيز التعديل الآن. لم يتم تغيير الصفحة.'
    },{status:overloaded?429:500});
  }
}

async function loadContext(token){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v2_current_user_context`,{
    method:'POST',headers:{apikey:SUPABASE_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:'{}',cache:'no-store'
  });
  if(response.status===401)throw Object.assign(new Error('session_expired'),{status:401});
  if(!response.ok)throw new Error(`context_failed_${response.status}`);
  return response.json();
}
function canUseCmsAssistant(context,tenantSlug,siteKey){
  if(context?.platformAccess||context?.platformControlAccess)return true;
  if(!tenantSlug||siteKey==='marktone-main')return false;
  return Boolean(context?.memberships?.some(item=>item.tenantSlug===tenantSlug));
}
function sameOrigin(request){
  const origin=request.headers.get('origin');
  if(!origin)return request.headers.get('sec-fetch-site')!=='cross-site';
  try{return new URL(origin).host===request.headers.get('host');}catch{return false}
}
function validKey(value,fallback){
  const key=String(value||fallback||'').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,79}$/.test(key)?key:fallback;
}
function consumeRate(context,token){
  const subject=String(context?.subject?.id||createHash('sha256').update(token).digest('hex').slice(0,24));
  const now=Date.now();
  const bucket=rateBuckets.get(subject)||[];
  const recent=bucket.filter(timestamp=>now-timestamp<60000);
  if(recent.length>=12)return false;
  recent.push(now);rateBuckets.set(subject,recent);
  if(rateBuckets.size>1000){for(const [key,value] of rateBuckets){if(!value.some(timestamp=>now-timestamp<60000))rateBuckets.delete(key)}}
  return true;
}
function safeError(error){return {name:error?.name||'Error',message:String(error?.message||error).slice(0,500)}}
