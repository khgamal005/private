import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {parseKnowledgeQuery} from '../lib/knowledge-query.mjs';
import {normalizeUrl,pageItem,parseRss,listingLinks,parseJson,nextListing} from '../supabase/functions/knowledge-ingest/parsers.ts';
import {publicHttps,privateAddress,fetchText} from '../supabase/functions/knowledge-ingest/network.ts';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
const TENANT='10000000-0000-4000-8000-000000000001',OTHER='10000000-0000-4000-8000-000000000002',USER='20000000-0000-4000-8000-000000000001';

test('archive query rejects invalid dates, bounds, identifiers and unsafe filter input',()=>{
 assert.equal(parseKnowledgeQuery(new URLSearchParams({tenant:'demo',offset:'240'})).p_offset,240);
 for(const invalid of [{limit:'200'},{offset:'-1'},{offset:'NaN'},{source:'not-uuid'},{from:'2026-02-30'},{from:'2026-09-02',to:'2026-09-01'},{sort:'random'},{view:'draft'},{search:'x'.repeat(201)}])assert.equal(parseKnowledgeQuery(new URLSearchParams({tenant:'demo',...invalid})),null);
});
test('missing images stay empty; HTML, RSS and JSON preserve real cover URLs',()=>{
 assert.equal(normalizeUrl('','https://example.gov.sa/news/1'),'');
 assert.equal(pageItem('<title>خبر تدريبي جديد</title><main><p>ملخص</p></main>','https://example.gov.sa/news/1').image,'');
 assert.equal(pageItem('<title>خبر</title><meta content="/cover.jpg" property="og:image">','https://example.gov.sa/news/1').image,'https://example.gov.sa/cover.jpg');
 const rss='<rss><item><title>خبر تدريب</title><link>https://example.gov.sa/news/2?utm_campaign=x</link><description><![CDATA[<p>تعليم</p><img src="/a.jpg">]]></description><enclosure type="audio/mpeg" url="/a.mp3"/></item></rss>';
 assert.equal(parseRss(rss)[0].image,'https://example.gov.sa/a.jpg');
 assert.equal(parseRss(rss)[0].url,'https://example.gov.sa/news/2');
 assert.equal(parseJson({base_url:'https://example.gov.sa'},JSON.stringify([{url:'/a',title:'خبر',description:'<b>وصف</b>'}]))[0].image,'');
 assert.equal(nextListing('<a rel="next" href="?page=2">التالي</a>','https://example.gov.sa/news'),'https://example.gov.sa/news?page=2');
 const links=listingLinks({base_url:'https://example.gov.sa',parser_config:{linkPattern:'^/news/[^/]+$'}},'<a href="/news/1">1</a><a href="/news/1">كرر</a><a href="https://evil.test/news/2">آخر</a>','https://example.gov.sa/news');
 assert.deepEqual(links,['https://example.gov.sa/news/1']);
});
test('HTTPS boundary rejects credentials, private literals and private DNS answers',()=>{
 for(const url of ['http://example.gov.sa','https://127.0.0.1','https://[::1]','https://u:p@example.gov.sa','https://example.local','https://example.gov.sa:444'])assert.throws(()=>publicHttps(url));
 for(const ip of ['127.0.0.1','169.254.169.254','10.1.2.3','100.64.2.3','172.16.0.1','192.168.0.1','::1','fd00::1','fe80::1','::ffff:127.0.0.1'])assert.equal(privateAddress(ip),true,ip);
 assert.equal(privateAddress('8.8.8.8'),false);
});

test('source fetch times out during DNS lookup and rechecks redirect destinations',async()=>{
 const originalDeno=globalThis.Deno,originalFetch=globalThis.fetch;
 try{
  globalThis.Deno={resolveDns:()=>new Promise(()=>{})};
  globalThis.fetch=async()=>assert.fail('unresolved DNS must not reach fetch');
  await assert.rejects(fetchText('https://example.gov.sa',20),/abort/i);
  globalThis.Deno={resolveDns:async host=>host==='example.gov.sa'?['8.8.8.8']:['127.0.0.1']};
  let calls=0;globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{location:'https://redirect.example.gov.sa/private'}});};
  await assert.rejects(fetchText('https://example.gov.sa'),/knowledge_source_dns_rejected/);
  assert.equal(calls,1);
 }finally{globalThis.Deno=originalDeno;globalThis.fetch=originalFetch;}
});

async function setup(){
 const db=new PGlite();
 await db.exec(`create schema auth;create schema core;create schema access_control;create schema private_app;create schema platform;
 create role anon;create role authenticated;create role service_role;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create table core.tenants(id uuid primary key,slug text,status text);
 create table access_control.subjects(id uuid primary key,auth_user_id uuid,status text,must_change_password boolean default false);
 create table access_control.memberships(id uuid primary key,subject_id uuid,tenant_id uuid,scope text,status text);
 create table access_control.membership_roles(membership_id uuid,role_id uuid);
 create table access_control.roles(id uuid primary key,scope text,role_key text);
 create function private_app.has_tenant_permission(t uuid,p text) returns boolean language sql stable as $$select auth.uid() is not null and exists(select 1 from access_control.subjects s join access_control.memberships m on m.subject_id=s.id where s.auth_user_id=auth.uid() and m.tenant_id=t and m.status='active')$$;
 create function platform.is_platform_content_admin() returns boolean language sql stable as $$select coalesce(current_setting('test.admin',true),'false')='true'$$;
 create function private_app.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
 insert into core.tenants values('${TENANT}','demo','active'),('${OTHER}','other','active');
 insert into access_control.subjects(id,auth_user_id,status) values('${USER}','${USER}','active');
 insert into access_control.memberships values('${USER}','${USER}','${TENANT}','tenant','active');
 select set_config('test.user','${USER}',false);`);
 const foundation=await read('supabase/migrations/20260801005000_knowledge_content_foundation_v1.sql');
 for(const match of foundation.matchAll(/create table if not exists public\.knowledge_(?:categories|sources|posts) \([\s\S]*?\n\);/g))await db.exec(match[0]);
 const hub=await read('supabase/migrations/20260801010000_knowledge_intelligence_hub_v1.sql');
 await db.exec(hub.slice(hub.indexOf('alter table public.knowledge_sources'),hub.indexOf('alter table public.knowledge_ingestion_runs enable')));
 await db.exec('alter table public.knowledge_posts enable row level security;grant usage on schema public,auth,platform to anon,authenticated;grant select on public.knowledge_posts to anon,authenticated;');
 await db.exec(await read('supabase/changes/knowledge-archive-v2.sql'));
 await db.exec(await read('supabase/changes/knowledge-source-catalog-v2.sql'));
 await db.exec(await read('supabase/changes/knowledge-source-catalog-v2.sql'));
 const candidates=(await db.query('select is_active,requires_review,auto_publish from public.knowledge_sources')).rows;
 assert.equal(candidates.length,2);
 for(const candidate of candidates)assert.deepEqual(candidate,{is_active:false,requires_review:true,auto_publish:false});
 return db;
}

test('real SQL paginates 267 visible materials and reconciles audience, archive, bookmark, detail and permissions',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.exec(`insert into public.knowledge_posts(title,slug,status,source_published_at,content,created_at)
 select 'خبر تدريب '||i,'post-'||i,'published','2026-01-01',repeat('تفاصيل ',2000),'2026-01-01' from generate_series(1,260)i;
 insert into public.knowledge_posts(title,slug,status,content_type,tender_deadline,expires_at,created_at)
 select 'منافسة قديمة '||i,'tender-'||i,'published','tender',now()-interval '1 day',now()-interval '1 day','2026-01-01' from generate_series(1,5)i;
 insert into public.knowledge_posts(title,slug,status,is_archived,created_at) values('مرجع مؤرشف','archive','published',true,'2026-01-01');
 insert into public.knowledge_posts(title,slug,status,target_tenants,created_at) values('خاص بالمنشأة','target','published','{demo}','2026-01-01'),('منشأة أخرى','other','published','{other}','2026-01-01');
 insert into public.knowledge_posts(title,slug,status,target_roles,created_at) values('مدير فقط','role-target','published','{manager}','2026-01-01');
 insert into public.knowledge_posts(title,slug,status,created_at) values('مرفوض','rejected','rejected','2026-01-01'),('مسودة','draft','draft','2026-01-01'),('أرشيف تحريري مخفي','old-archive','archived','2026-01-01');`);
 const snapshot=async params=>(await db.query(`select public.v3_tenant_knowledge_snapshot(p_slug:='demo'${params?','+params:''}) as data`)).rows[0].data;
 const first=await snapshot();assert.equal(first.stats.total,267);assert.equal(first.stats.expiredTenders,5);assert.equal(first.stats.archived,6);assert.equal(first.posts.length,24);assert.equal(first.pagination.hasMore,true);
 assert.equal('content' in first.posts[0],false);assert.equal('target_tenants' in first.posts[0],false);
 const seen=new Set();for(let offset=0;offset<267;offset+=24){const page=await snapshot(`p_offset:=${offset},p_as_of:='${first.pagination.asOf}'`);for(const post of page.posts){assert.equal(seen.has(post.id),false);seen.add(post.id);}}assert.equal(seen.size,267);
 const archive=await snapshot("p_view:='expired'");assert.equal(archive.pagination.total,5);assert.equal(archive.stats.total,267);
 const id=archive.posts[0].id;const detail=(await db.query('select public.v3_tenant_knowledge_post($1,$2) as data',['demo',id])).rows[0].data;assert.equal(detail.lifecycle,'expired');
 await db.query('select public.v2_tenant_knowledge_action($1,$2,$3)',['demo','save',id]);await db.query('select public.v2_tenant_knowledge_action($1,$2,$3)',['demo','save',id]);
 assert.equal((await snapshot("p_view:='saved'")).pagination.total,1);
 await assert.rejects(db.query("select public.v3_tenant_knowledge_snapshot('other')"),/forbidden/);
 const denied=(await db.query("select id from public.knowledge_posts where slug='other'")).rows[0].id;
 await assert.rejects(db.query('select public.v3_tenant_knowledge_post($1,$2)',['demo',denied]),/forbidden/);
 await assert.rejects(db.query('select public.v2_tenant_knowledge_action($1,$2,$3)',['demo','save',denied]),/forbidden/);
 await db.exec(`insert into access_control.roles values('${USER}','tenant','manager');insert into access_control.membership_roles values('${USER}','${USER}');`);
 assert.equal((await snapshot()).stats.total,268);
 await db.exec("select set_config('test.user','',false)");await assert.rejects(snapshot(),/forbidden/);
 await db.exec('set role anon');assert.equal(Number((await db.query('select count(*) n from public.knowledge_posts')).rows[0].n),260);await assert.rejects(db.query("select public.v3_tenant_knowledge_snapshot('demo')"),/permission denied/);await db.exec('reset role');
 await db.exec(`select set_config('test.user','${USER}',false)`);
 await assert.rejects(db.query('delete from public.knowledge_posts where id=$1',[id]),/knowledge_history_preserved/);
 await db.query('update public.knowledge_posts set is_archived=false where id=$1',[id]);assert.equal((await snapshot("p_view:='expired'")).pagination.total,5);
 await db.exec("insert into public.knowledge_posts(title,slug,status) values('وصل الآن','new','published')");
 assert.equal((await snapshot(`p_as_of:='${first.pagination.asOf}'`)).stats.total,268);
 const search=await snapshot("p_search:='خبر تدريب 260'");assert.equal(search.pagination.total,1);
 const plan=await db.query("explain (analyze,format json) select id from public.knowledge_posts where status='published' order by coalesce(source_published_at,published_at,created_at) desc,id desc limit 24");
 t.diagnostic('267+ records, stable pages, payload '+JSON.stringify(first).length+' bytes; plan '+plan.rows[0]['QUERY PLAN'][0]['Plan']['Node Type']);
});

test('source lease, atomic retry recovery, canonical duplicate guard and protected raw history',async t=>{
 const db=await setup();t.after(()=>db.close());
 await db.exec("insert into public.knowledge_sources(source_key,name,source_type,base_url) values('fixture','مصدر تجريبي','html','https://example.gov.sa')");
 const source=(await db.query("select id from public.knowledge_sources where source_key='fixture'")).rows[0].id;
 const claim=async()=>(await db.query("select public.knowledge_claim_source($1,'manual') as data",[source])).rows[0].data;
 const first=await claim();assert.ok(first.token);assert.equal(await claim(),null);
 const raw={external_id:'1',canonical_url:'https://example.gov.sa/1',title:'خبر تدريب اختبار',fingerprint:'hash-1',status:'review',raw_payload:{},detected_type:'news',trust_score:95,relevance_score:85};
 const post={title:raw.title,slug:'test-item',canonical_url:raw.canonical_url,content_type:'news',status:'review',trust_score:95,relevance_score:85,importance_level:'normal'};
 const store=async(r=raw,p=post)=>(await db.query('select public.knowledge_store_item($1,$2,$3,$4,$5) as data',[source,first.token,first.runId,JSON.stringify(r),JSON.stringify(p)])).rows[0].data;
 const result=await store();assert.equal(result.duplicate,false);assert.equal((await store()).duplicate,true);
 await assert.rejects(store({...raw,fingerprint:'invalid',canonical_url:'https://example.gov.sa/2'},{...post,slug:'test-bad',canonical_url:'https://example.gov.sa/2',status:'bad'}),/check constraint/);
 assert.equal(Number((await db.query('select count(*) n from public.knowledge_raw_items')).rows[0].n),1);
 await db.exec(`insert into public.knowledge_raw_items(source_id,title,fingerprint,canonical_url) values('${source}','مادة متقطعة','orphan','https://example.gov.sa/3')`);
 await store({...raw,fingerprint:'orphan',canonical_url:'https://example.gov.sa/3'},{...post,slug:'recover',canonical_url:'https://example.gov.sa/3'});
 assert.equal(Number((await db.query('select count(*) n from public.knowledge_raw_items where post_id is null')).rows[0].n),0);
 await assert.rejects(db.exec('delete from public.knowledge_raw_items'),/knowledge_history_preserved/);
 await db.exec("update public.knowledge_sources set sync_lease_until=now()-interval '1 minute'");
 const second=await claim();assert.notEqual(first.token,second.token);
 await assert.rejects(store(),/knowledge_lease_lost/);
 assert.equal((await db.query('select status from public.knowledge_ingestion_runs where id=$1',[first.runId])).rows[0].status,'failed');
 await db.exec(`select set_config('test.user','${USER}',false);set role authenticated`);await assert.rejects(db.query("select public.knowledge_claim_source($1,'manual')",[source]),/permission denied/);
});

test('bounded backfill advances beyond 200 items and detects repeated/empty pages',async()=>{
 const {sourceItems}=await import('../supabase/functions/knowledge-ingest/collector.ts');
 const source={source_type:'html',base_url:'https://example.gov.sa',feed_url:'https://example.gov.sa/news',parser_config:{linkPattern:'^/news/\\d+$',paginationParam:'page',maxItems:12,maxPages:25},backfill_cursor:{enabled:true,target:250}};
 let requests=0;
 const fetcher=async raw=>{requests++;const u=new URL(raw);let body;if(u.pathname==='/news'){const page=Number(u.searchParams.get('page')||0);body=page>=18?'':Array.from({length:15},(_,i)=>`<a href="/news/${page*15+i}">خبر</a>`).join('');}else body=`<title>خبر تعليمي ${u.pathname}</title><main><p>تفاصيل تعليمية موثوقة عن تطوير مهارات التدريب</p></main>`;return {body,type:'text/html',url:raw};};
 const seen=new Set();let loops=0;while(source.backfill_cursor.enabled&&loops++<60){const batch=await sourceItems(source,{fetcher});for(const item of batch.items){assert.equal(seen.has(item.url),false);seen.add(item.url);}source.backfill_cursor=batch.cursor;}
 assert.equal(seen.size,270);assert.ok(loops<60);assert.ok(requests<320);
 const repeated={...source,backfill_cursor:{enabled:true,page:1,offset:0,previousSignature:'15|https://example.gov.sa/news/0|https://example.gov.sa/news/14'}};
 const result=await sourceItems(repeated,{fetcher:raw=>fetcher(raw.replace('?page=1',''))});assert.equal(result.cursor.enabled,false);assert.equal(result.complete,true);
 const dry=await sourceItems({...source,backfill_cursor:{}},{dryRun:true,fetcher});assert.equal(dry.items.length,3);assert.equal(dry.cursor.enabled,false);
});
