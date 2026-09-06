import "jsr:@supabase/functions-js/edge-runtime.d.ts";

import {
  type Item,
  type Source,
  reviewForAutoPublish,
  text,
} from "./review.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
};
import {sourceItems} from "./collector.ts";
import {normalizeUrl} from "./parsers.ts";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify({version:"knowledge-v2",...body as Record<string,unknown>}), { status, headers: JSON_HEADERS });
}

async function db(path: string, init: RequestInit = {}) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    signal: init.signal || AbortSignal.timeout(8_000),
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${SERVICE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {}),
    },
  });
  const raw = await result.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!result.ok) throw new Error(data?.message || data?.error || `database_${result.status}`);
  return data;
}

async function rpc(
  name: string,
  payload: Record<string, unknown>,
  token = SERVICE_KEY,
) {
  const result = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: {
      apikey: SERVICE_KEY,
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const raw = await result.text();
  let data: any = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }
  if (!result.ok) throw new Error(data?.message || data?.error || `rpc_${result.status}`);
  return data;
}

async function authorized(request: Request) {
  const secret = request.headers.get("x-marktone-knowledge-secret");
  if (
    secret &&
    await rpc("knowledge_ingestion_validate_secret", { p_secret: secret })
  ) return true;

  const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  for (const name of ["v2_current_user_context", "current_user_context"]) {
    try {
      const context = await rpc(name, {}, token);
      if (context?.platformAccess || context?.platform_access) return true;
    } catch {
      // Compatibility with installations that only expose one context RPC.
    }
  }
  return false;
}

function includesAny(haystack: string, needles: string[]) {
  return needles.some((word) => haystack.includes(text(word).toLocaleLowerCase("ar")));
}

function accepted(source: Source, item: Item) {
  const haystack = `${item.title} ${item.excerpt || ""} ${item.content || ""}`
    .toLocaleLowerCase("ar");
  const includes = (source.include_keywords || [])
    .map((value: any) => text(value).toLocaleLowerCase("ar"))
    .filter(Boolean);
  const excludes = (source.exclude_keywords || [])
    .map((value: any) => text(value).toLocaleLowerCase("ar"))
    .filter(Boolean);
  return (!includes.length || includesAny(haystack, includes)) &&
    !includesAny(haystack, excludes);
}

function classify(source: Source, item: Item) {
  const value = `${item.title} ${item.excerpt || ""} ${item.content || ""}`
    .toLocaleLowerCase("ar");
  const tender = source.default_content_type === "tender" || includesAny(value, [
    "منافسة",
    "كراسة شروط",
    "طلب عروض",
    "توريد",
    "مناقصة",
  ]);
  const regulation = includesAny(value, [
    "لائحة",
    "ضوابط",
    "قرار",
    "نظام",
    "اعتماد",
    "ترخيص",
    "تحديث تنظيمي",
  ]);
  const event = includesAny(value, [
    "ملتقى",
    "مؤتمر",
    "فعالية",
    "أسبوع",
    "معرض",
    "ورشة",
    "ندوة",
  ]);
  const type = tender
    ? "tender"
    : regulation
    ? "regulation"
    : event
    ? "event"
    : source.default_content_type || "news";

  let relevance = source.trust_level === "official" ? 65 : 50;
  const trainingMatches = [
    "تدريب",
    "تعليم",
    "مهارات",
    "معهد",
    "مركز",
    "موارد بشرية",
    "محتوى",
    "تحول رقمي",
    "ذكاء اصطناعي",
    "استشارات",
    "توعية",
    "سوق العمل",
  ].filter((keyword) => value.includes(keyword)).length;
  relevance = Math.min(
    98,
    relevance + trainingMatches * 5 + (tender ? 10 : 0) + (regulation ? 8 : 0),
  );
  const trust = source.trust_level === "official"
    ? 95
    : source.trust_level === "trusted"
    ? 80
    : 65;
  const why = type === "tender"
    ? "فرصة محتملة يمكن أن تتحول إلى مشروع أو شراكة لمركز التدريب."
    : type === "regulation"
    ? "قد يؤثر هذا التحديث على الامتثال أو الاعتماد أو طريقة تشغيل البرامج التدريبية."
    : type === "event"
    ? "قد تتيح الفعالية تعلّمًا أو شراكات أو ظهورًا تجاريًا للمنشأة."
    : "يوفر تحديثًا موثوقًا يساعد الإدارة على متابعة اتجاهات قطاع التدريب.";
  const action = type === "tender"
    ? "راجع الشروط والموعد النهائي وحدد قرار المشاركة خلال 48 ساعة."
    : type === "regulation"
    ? "كلّف المسؤول المختص بمراجعة الأثر وتحديث الإجراءات عند الحاجة."
    : type === "event"
    ? "تحقق من ملاءمة الحضور وأضف الموعد إلى التقويم إذا كان مناسبًا."
    : "احفظ الخبر وشاركه مع الدور الوظيفي الأكثر ارتباطًا به.";
  return { type, relevance, trust, why, action };
}

async function fingerprint(sourceId: string, item: Item) {
  const canonical = normalizeUrl(item.url || "");
  const input = `${sourceId}|${canonical || item.externalId || ""}|${item.title
    .toLocaleLowerCase("ar").replace(/\s+/g, " ")}`;
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(hash)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function slugify(title: string, hash: string) {
  const base = title.toLocaleLowerCase("ar")
    .replace(/[أإآ]/g, "ا")
    .replace(/[^\u0600-\u06ffa-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
  return `${base || "knowledge"}-${hash.slice(0, 8)}`;
}

function nextSync(frequency: string) {
  const now = new Date();
  if (frequency === "daily") {
    const next = new Date(now);
    next.setUTCHours(3, 15, 0, 0);
    if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }
  const milliseconds = frequency === "hourly"
    ? 3_600_000
    : frequency === "weekly"
    ? 604_800_000
    : 86_400_000;
  return new Date(now.getTime() + milliseconds).toISOString();
}

async function ingestSource(source:Source,trigger:string,stopAt:number){
 const claim=await rpc('knowledge_claim_source',{p_source_id:source.id,p_trigger:trigger});
 if(!claim)return {sourceId:source.id,status:'skipped',reason:'not_due_or_running'};
 source=claim.source;const runId=claim.runId;const lease=claim.token;
 let fetched=0,filteredOut=0,newCount=0,duplicates=0,review=0,published=0,errors=0;
 try{
  const batch=await sourceItems(source,{stopAt:Math.min(stopAt-25_000,Date.now()+45_000)});fetched=batch.items.length;
  if(!fetched&&!batch.complete)throw new Error('knowledge_no_items_check_parser');
  for(const item of batch.items){
   // Leave time to record progress; retain the cursor when the batch needs a retry.
   if(Date.now()>stopAt-8_000){errors++;break;}
   if(!accepted(source,item)){filteredOut++;continue;}
   try{
    const canonical=normalizeUrl(item.url||'',source.base_url);if(!canonical)continue;
    const hash=await fingerprint(source.id,{...item,url:canonical});
    const smart=classify(source,item);
    const decision=reviewForAutoPublish(source,item,smart,canonical);
    // Historical imports always stay in editorial review, including expired tenders.
    const historical=source.backfill_cursor?.enabled===true;
    const willPublish=decision.publish&&!historical;
    const postStatus=willPublish?'published':'review';
    const reviewNote=historical?'مادة من الأرشيف: راجع تاريخها ومصدرها قبل النشر.':decision.reasons.join('؛ ')||null;
    const sourcePublishedAt=decision.publishedAt||item.publishedAt||null;
    const tender=decision.tender;
    const raw={external_id:item.externalId||canonical,canonical_url:canonical,title:decision.title,excerpt:decision.summary||null,content:decision.content||null,cover_image_url:item.image||null,source_published_at:sourcePublishedAt,raw_payload:{...(item.payload||{}),auto_review:{passed:willPublish,reasons:decision.reasons,reviewed_at:new Date().toISOString()}},fingerprint:hash,detected_type:smart.type,detected_category_id:source.default_category_id||null,trust_score:smart.trust,relevance_score:smart.relevance,why_it_matters:smart.why,recommended_action:smart.action,status:postStatus,error_detail:reviewNote};
    const post={title:decision.title,slug:slugify(decision.title,hash),excerpt:decision.summary||smart.why,content:decision.content||decision.summary||null,cover_image_url:item.image||null,category_id:source.default_category_id||null,content_type:smart.type,status:postStatus,source_name:source.name,source_url:canonical,canonical_url:canonical,external_id:item.externalId||canonical,source_fingerprint:hash,trust_score:smart.trust,relevance_score:smart.relevance,importance_level:smart.relevance>=85?'high':'normal',why_it_matters:smart.why,recommended_action:tender&&['expired','cancelled'].includes(tender.status)?'احتفظ بالمنافسة مرجعًا لتخطيط الفرص المقبلة؛ التقديم عليها انتهى.':smart.action,smart_summary:(decision.summary||smart.why).slice(0,600),source_published_at:sourcePublishedAt,last_verified_at:new Date().toISOString(),tags:source.default_tags||[],published_at:willPublish?(sourcePublishedAt||new Date().toISOString()):null,review_notes:reviewNote,tender_authority:tender?.authority||null,tender_number:tender?.number||null,tender_deadline:tender?.deadline||null,tender_status:tender?.status||null,expires_at:tender?.deadline||null,application_url:tender?.applicationUrl||null,is_archived:historical};
    const stored=await rpc('knowledge_store_item',{p_source_id:source.id,p_lease:lease,p_run_id:runId,p_raw:raw,p_post:post});
    if(stored.duplicate){duplicates++;continue;}
    newCount++;if(willPublish)published++;else review++;
   }catch(error){errors++;console.error('knowledge_item_failed',source.source_key,error instanceof Error?error.message:'unknown');}
  }
  const status=errors?(newCount?'partial':'failed'):'success';
  let cursor=source.backfill_cursor||{};
  if(cursor.enabled){cursor={...(errors?cursor:batch.cursor),totalAdded:Number(cursor.totalAdded||0)+newCount};if(cursor.totalAdded>=Number(cursor.target||250))cursor={...cursor,enabled:false,completedAt:new Date().toISOString()};}
  const next=cursor.enabled?new Date(Date.now()+15*60_000).toISOString():source.sync_frequency==='manual'?null:nextSync(source.sync_frequency);
  await db(`knowledge_ingestion_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status,fetched_count:fetched,new_count:newCount,duplicate_count:duplicates,review_count:review,published_count:published,error_count:errors,finished_at:new Date().toISOString(),error_detail:errors?`${errors} item(s) failed`:null})});
  await db(`knowledge_sources?id=eq.${source.id}&sync_lease_token=eq.${lease}`,{method:'PATCH',body:JSON.stringify({last_status:status==='failed'?'error':status,last_synced_at:new Date().toISOString(),last_item_at:newCount?new Date().toISOString():source.last_item_at,next_sync_at:next,failure_count:errors?Number(source.failure_count||0)+1:0,last_error:errors?`${errors} مادة تحتاج إعادة المحاولة`:null,backfill_cursor:cursor,sync_lease_token:null,sync_lease_until:null})});
  return {sourceId:source.id,sourceKey:source.source_key,status,fetched,filteredOut,newCount,duplicates,review,published,errors,backfill:cursor};
 }catch(error){
  const message=error instanceof Error?error.message:String(error);
  const failures=Number(source.failure_count||0)+1;
  await db(`knowledge_ingestion_runs?id=eq.${runId}`,{method:'PATCH',body:JSON.stringify({status:'failed',error_count:errors+1,error_detail:message,new_count:newCount,published_count:published,review_count:review,fetched_count:fetched,duplicate_count:duplicates,finished_at:new Date().toISOString()})});
  await db(`knowledge_sources?id=eq.${source.id}&sync_lease_token=eq.${lease}`,{method:'PATCH',body:JSON.stringify({last_status:'error',last_error:message,failure_count:failures,next_sync_at:new Date(Date.now()+Math.min(24,2**Math.min(failures,5))*3_600_000).toISOString(),sync_lease_token:null,sync_lease_until:null})});
  return {sourceId:source.id,sourceKey:source.source_key,status:'failed',error:message};
 }
}

Deno.serve(async(request)=>{
 if(request.method!=='POST')return response({error:'method_not_allowed'},405);
 if(!SUPABASE_URL||!SERVICE_KEY)return response({error:'knowledge_runtime_not_configured'},500);
 try{
  if(!await authorized(request))return response({error:'unauthorized'},401);
  const body=await request.json().catch(()=>({}));
  if(body.dryRun===true){
   const source=body.source||{};
   const result=await sourceItems(source,{dryRun:true});
   const acceptedItems=result.items.filter(item=>accepted(source,item));
   return response({ok:acceptedItems.length>0,dryRun:true,discovered:result.discovered,accepted:acceptedItems.length,items:acceptedItems.map(item=>({title:item.title,url:item.url,image:item.image,publishedAt:item.publishedAt})),warning:acceptedItems.length?null:'لم تُعثر على مواد مطابقة؛ راجع رابط المصدر والكلمات المطلوبة.'});
  }
  const trigger=body.trigger==='manual'?'manual':body.trigger==='retry'?'retry':'scheduled';
  const sourceId=text(body.sourceId);
  let query='knowledge_sources?select=*&is_active=eq.true&source_type=neq.manual&order=next_sync_at.asc.nullsfirst,id.asc&limit=4';
  if(sourceId)query+=`&id=eq.${encodeURIComponent(sourceId)}`;
  else if(trigger==='scheduled')query+=`&sync_frequency=neq.manual&or=(next_sync_at.is.null,next_sync_at.lte.${encodeURIComponent(new Date().toISOString())})`;
  const sources=await db(query);const results=[];const stopAt=Date.now()+75_000;
  for(const source of sources){if(Date.now()>stopAt-40_000)break;results.push(await ingestSource(source,trigger,stopAt-5_000));}
  return response({ok:results.every(r=>r.status!=='failed'),trigger,processed:results.length,results,finishedAt:new Date().toISOString()});
 }catch(error){return response({error:error instanceof Error?error.message:'knowledge_ingestion_failed'},422);}
});
