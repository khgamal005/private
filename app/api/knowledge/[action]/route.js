import {NextResponse} from 'next/server';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {parseKnowledgeQuery} from '../../../../lib/knowledge-query.mjs';
import {KNOWLEDGE_SOURCES} from '../../../../lib/knowledge-sources.mjs';
import {isTrustedSupportRequestOrigin as isTrustedRequestOrigin} from '../../../../lib/support-request-origin.mjs';
import {
  ACCESS_COOKIE,
  SUPABASE_KEY,
  SUPABASE_URL
} from '../../../../lib/config';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const USER_AGENT='Marktone-Knowledge-Preview/1.0 (+https://marktone.org)';

function json(body,status=200){
  return NextResponse.json(body,{
    status,
    headers:{'cache-control':'no-store'}
  });
}

function tokenFromValue(input){
  if(!input)return null;
  let value=input;
  try{value=decodeURIComponent(value);}catch{}
  try{
    const parsed=JSON.parse(value);
    const token=Array.isArray(parsed)
      ?parsed[0]
      :parsed?.access_token||parsed?.currentSession?.access_token;
    if(typeof token==='string')return token;
  }catch{}
  return value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/)?.[0]||null;
}

function accessToken(request){
  const direct=request.cookies.get(ACCESS_COOKIE)?.value;
  if(direct)return direct;
  for(const cookie of request.cookies.getAll()){
    const token=tokenFromValue(cookie.value);
    if(token)return token;
  }
  return null;
}

async function requirePlatformAccess(request){
  const token=accessToken(request);
  if(!token){
    const error=new Error('غير مصرح');
    error.status=401;
    throw error;
  }
  let lastError=null;
  for(const name of ['v2_current_user_context','current_user_context']){
    try{
      const context=await rpc(request,name,{});
      if(context?.platformAccess||context?.platform_access)return context;
    }catch(error){lastError=error;}
  }
  const error=new Error(lastError?.message||'هذه العملية متاحة لمدير المنصة فقط');
  error.status=403;
  throw error;
}

async function rest(request,table,{method='GET',query='',body,prefer='return=representation',requireAuth=false}={}){
  if(!SUPABASE_URL||!SUPABASE_KEY){
    const error=new Error('إعدادات قاعدة البيانات غير مكتملة');
    error.status=503;
    throw error;
  }
  const token=accessToken(request);
  if(requireAuth&&!token){
    const error=new Error('غير مصرح');
    error.status=401;
    throw error;
  }
  const response=await fetch(`${SUPABASE_URL}/rest/v1/${table}${query?`?${query}`:''}`,{
    method,
    headers:{
      apikey:SUPABASE_KEY,
      authorization:`Bearer ${token||SUPABASE_KEY}`,
      'content-type':'application/json',
      prefer
    },
    body:body===undefined?undefined:JSON.stringify(body),
    cache:'no-store'
  });
  const raw=await response.text();
  let data=null;
  try{data=raw?JSON.parse(raw):null;}catch{data=raw;}
  if(!response.ok){
    const error=new Error(data?.message||data?.error||'تعذر تنفيذ الطلب');
    error.status=response.status;
    throw error;
  }
  return data;
}

async function rpc(request,name,payload){
  return rest(request,`rpc/${name}`,{method:'POST',body:payload,requireAuth:true});
}

async function safeRest(request,table,options,fallback=[]){
  try{return await rest(request,table,options);}catch{return fallback;}
}

function slugify(value){
  return String(value||'').trim().toLowerCase()
    .replace(/[أإآ]/g,'ا')
    .replace(/[^\u0600-\u06ffa-z0-9]+/g,'-')
    .replace(/^-|-$/g,'')
    .slice(0,90)||`post-${Date.now()}`;
}

function list(value){
  if(Array.isArray(value))return value.map(item=>String(item).trim()).filter(Boolean);
  return String(value||'').split(/[,،\n]/).map(item=>item.trim()).filter(Boolean);
}

function parseJsonObject(value){
  if(value&&typeof value==='object'&&!Array.isArray(value))return value;
  if(!String(value||'').trim())return {};
  try{
    const parsed=JSON.parse(value);
    return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};
  }catch{
    const error=new Error('إعدادات المحلل يجب أن تكون JSON صالحًا');
    error.status=400;
    throw error;
  }
}

function queryString(values){
  const search=new URLSearchParams();
  for(const [key,value] of Object.entries(values)){
    if(value!==undefined&&value!==null&&value!=='')search.set(key,String(value));
  }
  return search.toString();
}

function privateAddress(address){
  if(address==='::1'||address==='0:0:0:0:0:0:0:1')return true;
  if(address.startsWith('fc')||address.startsWith('fd')||address.startsWith('fe80:'))return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(address)
    ||/^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

async function validatePublicUrl(raw){
  let url;
  try{url=new URL(String(raw||'').trim());}
  catch{
    const error=new Error('أدخل رابطًا صحيحًا يبدأ بـ https://');
    error.status=400;
    throw error;
  }
  if(url.protocol!=='https:'||url.username||url.password){
    const error=new Error('يجب استخدام رابط HTTPS عام وآمن');
    error.status=400;
    throw error;
  }
  const host=url.hostname.toLowerCase();
  if(host==='localhost'||host.endsWith('.local')||privateAddress(host)){
    const error=new Error('روابط الشبكات الداخلية غير مسموحة');
    error.status=400;
    throw error;
  }
  if(!isIP(host)){
    const addresses=await lookup(host,{all:true,verbatim:true});
    if(!addresses.length||addresses.some(item=>privateAddress(item.address))){
      const error=new Error('تعذر اعتماد عنوان المصدر بصورة آمنة');
      error.status=400;
      throw error;
    }
  }
  return url;
}

async function fetchPreview(rawUrl){
  let url=await validatePublicUrl(rawUrl);
  for(let redirect=0;redirect<4;redirect+=1){
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),15000);
    try{
      const response=await fetch(url,{
        headers:{'user-agent':USER_AGENT,accept:'text/html,application/xhtml+xml'},
        redirect:'manual',signal:controller.signal,cache:'no-store'
      });
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');
        if(!location)throw new Error('تحويل المصدر غير صالح');
        url=await validatePublicUrl(new URL(location,url).toString());
        continue;
      }
      if(!response.ok){
        const error=new Error(`تعذر قراءة الرابط (${response.status})`);
        error.status=422;
        throw error;
      }
      if(!/html|xhtml/i.test(response.headers.get('content-type')||'')){
        const error=new Error('الرابط لا يشير إلى صفحة ويب قابلة للقراءة');
        error.status=422;
        throw error;
      }
      return smartPreview((await response.text()).slice(0,2_000_000),url.toString());
    }finally{clearTimeout(timer);}
  }
  const error=new Error('تجاوز الرابط عدد التحويلات الآمنة');
  error.status=422;
  throw error;
}

function decode(value){
  const map={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  return String(value||'').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi,(_,code)=>{
    if(code[0]==='#'){
      const hex=code[1]?.toLowerCase()==='x';
      const number=parseInt(code.slice(hex?2:1),hex?16:10);
      return Number.isFinite(number)?String.fromCodePoint(number):' ';
    }
    return map[code.toLowerCase()]||' ';
  });
}

function strip(value){
  return decode(String(value||'').replace(/<script[\s\S]*?<\/script>/gi,' ')
    .replace(/<style[\s\S]*?<\/style>/gi,' ')
    .replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim());
}

function metadata(html,name){
  const safe=name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const patterns=[
    new RegExp(`<meta[^>]+(?:property|name)=["']${safe}["'][^>]+content=["']([^"']+)["'][^>]*>`,'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${safe}["'][^>]*>`,'i')
  ];
  for(const pattern of patterns){const match=html.match(pattern);if(match)return decode(match[1]);}
  return '';
}

function classifyDraft(title,description){
  const value=`${title} ${description}`.toLowerCase();
  const tender=['منافسة','مناقصة','طلب عروض','كراسة شروط','تأهيل'].some(term=>value.includes(term));
  const regulation=['لائحة','ضوابط','قرار','نظام','اعتماد','ترخيص'].some(term=>value.includes(term));
  const event=['ملتقى','مؤتمر','فعالية','معرض','ورشة','ندوة'].some(term=>value.includes(term));
  const contentType=tender?'tender':regulation?'regulation':event?'event':'news';
  const whyItMatters=tender?'فرصة محتملة يمكن أن تتحول إلى مشروع أو شراكة لمركز التدريب.':regulation?'قد يؤثر هذا التحديث على الامتثال أو الاعتماد أو إجراءات التشغيل.':event?'قد تتيح هذه الفعالية تعلّمًا أو شراكات أو ظهورًا تجاريًا للمنشأة.':'تحديث يساعد الإدارة على متابعة ما يتغير في قطاع التدريب.';
  const recommendedAction=tender?'راجع الشروط والموعد النهائي وحدد قرار المشاركة خلال 48 ساعة.':regulation?'كلّف المسؤول المختص بمراجعة الأثر وتحديث الإجراءات عند الحاجة.':event?'راجع ملاءمة الحضور وأضف الموعد إلى التقويم عند اعتماده.':'احفظ المادة وشاركها مع الدور الوظيفي الأكثر ارتباطًا بها.';
  return {contentType,whyItMatters,recommendedAction};
}

function smartPreview(html,url){
  const title=metadata(html,'og:title')||metadata(html,'twitter:title')||strip(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const description=metadata(html,'og:description')||metadata(html,'description')||metadata(html,'twitter:description');
  const image=metadata(html,'og:image')||metadata(html,'twitter:image');
  const sourceName=metadata(html,'og:site_name')||new URL(url).hostname.replace(/^www\./,'');
  const publishedAt=metadata(html,'article:published_time')||metadata(html,'datePublished')||metadata(html,'date');
  return {url,title,excerpt:strip(description).slice(0,800),coverImageUrl:image?new URL(image,url).toString():'',sourceName,publishedAt:publishedAt||'',...classifyDraft(title,description)};
}

function postPayload(body){
  const now=new Date().toISOString();
  const status=body.status||'draft';
  return {
    title:String(body.title||'').trim(),slug:body.slug||slugify(body.title),excerpt:body.excerpt||null,content:body.content||null,
    cover_image_url:body.coverImageUrl||null,category_id:body.categoryId||null,content_type:body.contentType||'news',status,
    ...(Object.hasOwn(body,'sourceId')?{source_id:body.sourceId||null}:{}),source_name:body.sourceName||null,source_url:body.sourceUrl||null,canonical_url:body.canonicalUrl||body.sourceUrl||null,external_id:body.externalId||null,
    is_featured:Boolean(body.isFeatured),is_breaking:Boolean(body.isBreaking),importance_level:body.importanceLevel||'normal',trust_score:Number(body.trustScore??70),relevance_score:Number(body.relevanceScore??65),
    why_it_matters:body.whyItMatters||null,recommended_action:body.recommendedAction||null,smart_summary:body.smartSummary||body.excerpt||null,review_notes:body.reviewNotes||null,
    ...(Object.hasOwn(body,'isArchived')?{is_archived:Boolean(body.isArchived)}:{}),
    published_at:status==='published'?body.publishedAt||now:body.publishedAt||null,source_published_at:body.sourcePublishedAt||body.publishedAt||null,last_verified_at:body.lastVerifiedAt||now,expires_at:body.expiresAt||null,
    tender_authority:body.tenderAuthority||null,tender_number:body.tenderNumber||null,tender_deadline:body.tenderDeadline||null,tender_region:body.tenderRegion||null,tender_value:body.tenderValue||null,tender_status:body.tenderStatus||null,
    event_starts_at:body.eventStartsAt||null,event_ends_at:body.eventEndsAt||null,event_location:body.eventLocation||null,application_url:body.applicationUrl||null,
    tags:list(body.tags),target_roles:list(body.targetRoles),target_tenants:list(body.targetTenants),updated_at:now
  };
}

export async function GET(request,{params}){
  try{
    const {action}=await params;
    const searchParams=new URL(request.url).searchParams;
    if(action==='feed'){
      const tenant=searchParams.get('tenant')||'';
      if(!tenant)return json({error:'المنشأة غير محددة'},400);
      const query=parseKnowledgeQuery(searchParams);
      if(!query)return json({error:'فلاتر البحث غير صالحة'},400);
      return json(await rpc(request,'v3_tenant_knowledge_snapshot',query));
    }
    if(action==='post')return json({post:await rpc(request,'v3_tenant_knowledge_post',{p_slug:searchParams.get('tenant')||'',p_post_id:searchParams.get('id')})});
    if(action==='source-catalog'){await requirePlatformAccess(request);return json({sources:KNOWLEDGE_SOURCES});}
    if(action==='categories')return json(await safeRest(request,'knowledge_categories',{query:'select=*&is_active=eq.true&order=sort_order.asc,name.asc'},[]));
    if(action==='admin'){
      await requirePlatformAccess(request);
      return json(await rpc(request,'v3_knowledge_admin_snapshot',{p_filter:searchParams.get('filter')||'all',p_search:searchParams.get('search')||'',p_offset:Math.max(0,Number(searchParams.get('offset')||0)),p_review_offset:Math.max(0,Number(searchParams.get('reviewOffset')||0))}));
    }
    if(action==='admin-post'){await requirePlatformAccess(request);return json({post:(await rest(request,'knowledge_posts',{query:queryString({id:`eq.${searchParams.get('id')}`,limit:1}),requireAuth:true}))?.[0]});}
    return json({error:'الإجراء غير موجود'},404);
  }catch(error){return json({error:error.message||'حدث خطأ'},error.status||500);}
}

async function verifySource(request,source){
 const response=await fetch(`${SUPABASE_URL}/functions/v1/knowledge-ingest`,{method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${accessToken(request)}`,'content-type':'application/json'},body:JSON.stringify({dryRun:true,source}),cache:'no-store'});
 const result=await response.json().catch(()=>({}));
 if(!response.ok||!result.ok){const error=new Error(result.error||result.warning||'فشل اختبار المصدر؛ احفظه متوقفًا وراجع رابط الأخبار.');error.status=422;throw error;}
 return result;
}

export async function POST(request,{params}){
  try{
    const {action}=await params;
    if(!isTrustedRequestOrigin(request))return json({error:'مصدر الطلب غير مسموح'},403);
    const body=await request.json().catch(()=>({}));
    if(action==='bookmark')return json(await rpc(request,'v2_tenant_knowledge_action',{p_slug:String(body.tenant||''),p_action:body.saved?'unsave':'save',p_post_id:body.postId}));
    if(action==='read')return json(await rpc(request,'v2_tenant_knowledge_action',{p_slug:String(body.tenant||''),p_action:'read',p_post_id:body.postId}));
    await requirePlatformAccess(request);
    if(action==='preview-link')return json({preview:await fetchPreview(body.url)});
    if(action==='ingest'){
      const token=accessToken(request);
      const response=await fetch(`${SUPABASE_URL}/functions/v1/knowledge-ingest`,{method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({trigger:'manual',sourceId:body.sourceId||null}),cache:'no-store'});
      const result=await response.json().catch(()=>({}));
      if(!response.ok){const error=new Error(result.error||'تعذر تشغيل جلب المصادر');error.status=response.status;throw error;}
      return json(result);
    }
    if(action==='source-check'){
      const source=body.source||{};
      await validatePublicUrl(source.feed_url||source.base_url);
      const response=await fetch(`${SUPABASE_URL}/functions/v1/knowledge-ingest`,{method:'POST',headers:{apikey:SUPABASE_KEY,authorization:`Bearer ${accessToken(request)}`,'content-type':'application/json'},body:JSON.stringify({dryRun:true,source}),cache:'no-store'});
      const result=await response.json().catch(()=>({}));return json(result,response.status);
    }
    if(action==='backfill'){
      const rows=await rest(request,'knowledge_sources',{query:queryString({id:`eq.${body.id}`,select:'id,is_active,source_type,backfill_cursor',limit:1}),requireAuth:true});
      const source=rows?.[0];
      if(!source?.is_active||source.source_type==='manual')return json({error:'فعّل مصدرًا آليًا تم فحصه أولًا.'},400);
      const cursor=body.stop?{...source.backfill_cursor,enabled:false}:{...source.backfill_cursor,enabled:true,target:250,totalAdded:source.backfill_cursor?.totalAdded||0,startedAt:new Date().toISOString()};
      await rest(request,'knowledge_sources',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:{backfill_cursor:cursor,next_sync_at:new Date().toISOString()},requireAuth:true});
      return json({ok:true,cursor});
    }
    if(action==='save'){
      const payload=postPayload(body);
      if(!payload.title)return json({error:'عنوان المادة مطلوب'},400);
      const rows=body.id?await rest(request,'knowledge_posts',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:payload,requireAuth:true}):await rest(request,'knowledge_posts',{method:'POST',body:payload,requireAuth:true});
      return json({post:Array.isArray(rows)?rows[0]:rows});
    }
    if(action==='delete'||action==='archive'){
      if(!body.id)return json({error:'المادة غير محددة'},400);
      await rest(request,'knowledge_posts',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:{is_archived:body.archived!==false,updated_at:new Date().toISOString()},requireAuth:true});
      return json({ok:true});
    }
    if(action==='category'){
      const name=String(body.name||'').trim();
      if(!name)return json({error:'اسم القسم مطلوب'},400);
      const rows=await rest(request,'knowledge_categories',{method:'POST',body:{name,slug:body.slug||slugify(name),description:body.description||null,sort_order:Number(body.sortOrder||0),is_active:true},requireAuth:true});
      return json({category:rows?.[0]});
    }
    if(action==='source'){
      await validatePublicUrl(body.baseUrl);
      if(body.feedUrl)await validatePublicUrl(body.feedUrl);
      if(body.logoUrl)await validatePublicUrl(body.logoUrl);
      const name=String(body.name||'').trim();
      if(!name)return json({error:'اسم المصدر مطلوب'},400);
      const payload={source_key:body.sourceKey||slugify(name),name,logo_url:body.logoUrl||null,base_url:body.baseUrl||null,feed_url:body.feedUrl||body.baseUrl||null,source_type:body.sourceType||'rss',trust_level:body.trustLevel||'official',is_active:Boolean(body.isActive),requires_review:body.requiresReview!==false,auto_publish:Boolean(body.autoPublish),sync_frequency:body.syncFrequency||'daily',next_sync_at:body.isActive&&body.syncFrequency!=='manual'?new Date().toISOString():null,parser_config:parseJsonObject(body.parserConfig),include_keywords:list(body.includeKeywords),exclude_keywords:list(body.excludeKeywords),default_category_id:body.defaultCategoryId||null,default_content_type:body.defaultContentType||'news',default_tags:list(body.defaultTags),...(!body.id?{last_status:body.isActive?'never':'paused'}:{}),updated_at:new Date().toISOString()};
      if(payload.is_active&&payload.source_type!=='manual')await verifySource(request,payload);
      const rows=body.id?await rest(request,'knowledge_sources',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:payload,requireAuth:true}):await rest(request,'knowledge_sources',{method:'POST',body:payload,requireAuth:true});
      return json({source:rows?.[0]});
    }
    if(action==='source-toggle'){
      if(body.isActive){const source=(await rest(request,'knowledge_sources',{query:queryString({id:`eq.${body.id}`,limit:1}),requireAuth:true}))?.[0];if(!source)return json({error:'المصدر غير موجود'},404);if(source.source_type!=='manual')await verifySource(request,source);}
      const rows=await rest(request,'knowledge_sources',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:{is_active:Boolean(body.isActive),last_status:body.isActive?'never':'paused',next_sync_at:body.isActive?new Date().toISOString():null,updated_at:new Date().toISOString()},requireAuth:true});
      return json({source:rows?.[0]});
    }
    if(action==='raw-action'){
      if(!['publish','reject'].includes(body.decision))return json({error:'قرار المراجعة غير صالح'},400);
      const itemRows=await rest(request,'knowledge_raw_items',{query:queryString({select:'id,post_id',id:`eq.${body.id}`,limit:1}),requireAuth:true});
      const item=itemRows?.[0];
      if(!item)return json({error:'المادة الخام غير موجودة'},404);
      if(body.decision==='publish'){
        if(!item.post_id)return json({error:'المادة غير مكتملة؛ أعد مزامنة المصدر أولًا.'},409);
        if(item.post_id)await rest(request,'knowledge_posts',{method:'PATCH',query:queryString({id:`eq.${item.post_id}`}),body:{status:'published',published_at:new Date().toISOString(),updated_at:new Date().toISOString()},requireAuth:true});
        await rest(request,'knowledge_raw_items',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:{status:'published'},requireAuth:true});
      }else{
        if(item.post_id)await rest(request,'knowledge_posts',{method:'PATCH',query:queryString({id:`eq.${item.post_id}`}),body:{status:'rejected',review_notes:body.notes||'مرفوض من غرفة الأخبار',updated_at:new Date().toISOString()},requireAuth:true});
        await rest(request,'knowledge_raw_items',{method:'PATCH',query:queryString({id:`eq.${body.id}`}),body:{status:'rejected',error_detail:body.notes||null},requireAuth:true});
      }
      return json({ok:true});
    }
    return json({error:'الإجراء غير موجود'},404);
  }catch(error){return json({error:error.message||'حدث خطأ'},error.status||500);}
}
