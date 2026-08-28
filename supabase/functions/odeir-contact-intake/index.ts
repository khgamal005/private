import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get('SUPABASE_URL')??'';
const SERVICE_ROLE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
const RESEND_API_KEY=Deno.env.get('ODEIR_REGISTRATION_RESEND_API_KEY')?.trim()??'';
const FROM_EMAIL=Deno.env.get('ODEIR_REGISTRATION_FROM_EMAIL')?.trim()??'';
const RATE_SALT=Deno.env.get('ODEIR_REGISTRATION_RATE_SALT')?.trim()??'';
const DESTINATION='admin@marktone.sa';

Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405);
  if(!SUPABASE_URL||!SERVICE_ROLE_KEY||!RESEND_API_KEY||!FROM_EMAIL||RATE_SALT.length<32){return json({ok:false,error:'service_unavailable'},503);}
  let body:any={};
  try{body=await req.json();}catch{return json({ok:false,error:'invalid_json'},400);}

  const reference=clean(body?.reference,40);
  const name=clean(body?.name,120);
  const email=clean(body?.email,254).toLowerCase();
  const phone=clean(body?.phone,40);
  const organization=clean(body?.organization,160);
  const topic=clean(body?.topic,80)||'طلب تواصل';
  const message=clean(body?.message,5000);
  const sourcePage=clean(body?.sourcePage,300)||'/contact';
  if(!/^MT-\d{8}-[A-F0-9]{8}$/.test(reference)||name.length<2||message.length<10||(!email&&!phone))return json({ok:false,error:'invalid_payload'},400);
  if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({ok:false,error:'invalid_email'},400);

  const globalAllowed=await rateLimit('contact-email:global',60,3600);
  const channelHash=await sha256(`${email||phone}|${RATE_SALT}`);
  const channelAllowed=await rateLimit(`contact-email:${channelHash}`,6,86400);
  if(!globalAllowed||!channelAllowed)return json({ok:false,error:'rate_limited'},429);

  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:FROM_EMAIL,to:[DESTINATION],reply_to:email||undefined,subject:`[أودير] ${topic} — ${reference}`,html:emailHtml({reference,name,email,phone,organization,topic,message,sourcePage})})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok){console.error('odeir_contact_email_failed',{status:response.status,reference});return json({ok:false,error:'delivery_failed'},502);}
  return json({ok:true,providerId:clean(result?.id,160)});
});

async function rateLimit(key:string,limit:number,windowSeconds:number){
  const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/v1_registration_rate_limit_consume`,{
    method:'POST',headers:{apikey:SERVICE_ROLE_KEY,Authorization:`Bearer ${SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({p_rate_key:key,p_limit:limit,p_window_seconds:windowSeconds})
  });
  if(!response.ok)return false;
  return (await response.json())===true;
}
function emailHtml(row:any){const lines=[['المرجع',row.reference],['الاسم',row.name],['المنشأة',row.organization||'—'],['البريد',row.email||'—'],['الجوال',row.phone||'—'],['الموضوع',row.topic],['صفحة المصدر',row.sourcePage]];return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f7fa;font-family:Arial,sans-serif;color:#06182e"><div style="max-width:720px;margin:32px auto;background:white;border:1px solid #dfe7ed;border-radius:18px;overflow:hidden"><div style="background:#06182e;padding:26px 30px;color:white"><div style="color:#f0c534;font-size:13px;font-weight:700">رسالة جديدة من موقع أودير</div><h1 style="margin:8px 0 0;font-size:24px">طلب تواصل جديد</h1></div><div style="padding:28px 30px">${lines.map(([k,v])=>`<div style="display:grid;grid-template-columns:120px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid #edf1f4"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(String(v))}</span></div>`).join('')}<div style="margin-top:24px"><strong>الرسالة</strong><div style="margin-top:10px;padding:18px;background:#f7fafc;border-radius:12px;white-space:pre-wrap;line-height:1.8">${escapeHtml(row.message)}</div></div></div></div></body></html>`;}
async function sha256(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return Array.from(new Uint8Array(bytes)).map(b=>b.toString(16).padStart(2,'0')).join('');}
function clean(v:any,max:number){return String(v??'').trim().slice(0,max);}
function escapeHtml(v:string){return v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]||c));}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
