import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL=Deno.env.get('SUPABASE_URL')??'';
const SERVICE_ROLE_KEY=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??'';
const RESEND_API_KEY=Deno.env.get('ODEIR_REGISTRATION_RESEND_API_KEY')?.trim()??'';
const FROM_EMAIL=Deno.env.get('ODEIR_REGISTRATION_FROM_EMAIL')?.trim()??'';
const DESTINATION='admin@marktone.sa';

Deno.serve(async(req:Request)=>{
  if(req.method!=='POST')return json({ok:false,error:'method_not_allowed'},405);
  if(!SUPABASE_URL||!SERVICE_ROLE_KEY||!RESEND_API_KEY||!FROM_EMAIL){
    return json({ok:false,error:'service_unavailable'},503);
  }
  let body:any={};
  try{body=await req.json();}catch{return json({ok:false,error:'invalid_json'},400);}
  const reference=clean(body?.reference,40);
  if(!/^MT-\d{8}-[A-F0-9]{8}$/.test(reference))return json({ok:false,error:'invalid_reference'},400);

  const row=await loadSubmission(reference);
  if(!row)return json({ok:false,error:'not_found'},404);
  if(row.email_sent_at)return json({ok:true,alreadySent:true});

  const subject=`[أودير] ${topicLabel(row.message)} — ${row.reference_key}`;
  const response=await fetch('https://api.resend.com/emails',{
    method:'POST',
    headers:{Authorization:`Bearer ${RESEND_API_KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({from:FROM_EMAIL,to:[DESTINATION],reply_to:row.email||undefined,subject,html:emailHtml(row)})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok){
    console.error('odeir_contact_email_failed',{status:response.status,reference});
    return json({ok:false,error:'delivery_failed'},502);
  }
  await markSent(reference,clean(result?.id,160));
  return json({ok:true});
});

async function loadSubmission(reference:string){
  const url=new URL(`${SUPABASE_URL}/rest/v1/contact_submissions`);
  url.searchParams.set('reference_key',`eq.${reference}`);
  url.searchParams.set('select','reference_key,name,email,phone,organization,message,source_page,created_at,email_sent_at');
  url.searchParams.set('limit','1');
  const response=await fetch(url,{headers:{...serviceHeaders(),'Accept-Profile':'website'}});
  if(!response.ok){
    console.error('odeir_contact_lookup_failed',{status:response.status,reference});
    return null;
  }
  const rows=await response.json();
  return Array.isArray(rows)?rows[0]||null:null;
}

async function markSent(reference:string,providerId:string){
  const url=new URL(`${SUPABASE_URL}/rest/v1/contact_submissions`);
  url.searchParams.set('reference_key',`eq.${reference}`);
  const response=await fetch(url,{
    method:'PATCH',
    headers:{...serviceHeaders(),'Content-Profile':'website','Content-Type':'application/json','Prefer':'return=minimal'},
    body:JSON.stringify({email_sent_at:new Date().toISOString(),email_provider_id:providerId||null})
  });
  if(!response.ok)console.error('odeir_contact_mark_sent_failed',{status:response.status,reference});
}

function emailHtml(row:any){
  const message=escapeHtml(String(row.message||''));
  const lines=[['المرجع',row.reference_key],['الاسم',row.name],['المنشأة',row.organization||'—'],['البريد',row.email||'—'],['الجوال',row.phone||'—'],['صفحة المصدر',row.source_page||'—'],['وقت الإرسال',row.created_at||'—']];
  return `<!doctype html><html lang="ar" dir="rtl"><body style="margin:0;background:#f4f7fa;font-family:Arial,sans-serif;color:#06182e"><div style="max-width:720px;margin:32px auto;background:white;border:1px solid #dfe7ed;border-radius:18px;overflow:hidden"><div style="background:#06182e;padding:26px 30px;color:white"><div style="color:#f0c534;font-size:13px;font-weight:700">رسالة جديدة من موقع أودير</div><h1 style="margin:8px 0 0;font-size:24px">طلب تواصل جديد</h1></div><div style="padding:28px 30px">${lines.map(([k,v])=>`<div style="display:grid;grid-template-columns:120px 1fr;gap:12px;padding:9px 0;border-bottom:1px solid #edf1f4"><strong>${escapeHtml(k)}</strong><span>${escapeHtml(String(v))}</span></div>`).join('')}<div style="margin-top:24px"><strong>الرسالة</strong><div style="margin-top:10px;padding:18px;background:#f7fafc;border-radius:12px;white-space:pre-wrap;line-height:1.8">${message}</div></div></div></div></body></html>`;
}
function topicLabel(message:string){const match=String(message||'').match(/^\[الموضوع:\s*([^\]]+)\]/);return match?.[1]||'طلب تواصل جديد';}
function serviceHeaders(){return {apikey:SERVICE_ROLE_KEY,Authorization:`Bearer ${SERVICE_ROLE_KEY}`};}
function clean(v:any,max:number){return String(v??'').trim().slice(0,max);}
function escapeHtml(v:string){return v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]||c));}
function json(data:any,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});}
