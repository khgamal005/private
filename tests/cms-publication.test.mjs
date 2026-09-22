import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pagePublication,sitePublication} from '../lib/cms-publication.mjs';
import {academySetup,configure,platformAction,login,call,id,SITE,T,EDITOR_AUTH,ADMIN_AUTH} from './fixtures/academy-platform-database.mjs';

test('publication state distinguishes saved, published, publicly visible and unpublished changes',()=>{
 const page={status:'published',visibility:'public',builder:{hasPublished:true}};
 assert.equal(pagePublication({status:'draft'},page).visible,false);
 assert.match(pagePublication({status:'draft'},page).label,/الموقع غير منشور/);
 assert.equal(sitePublication({status:'published'},page).live,true);
 assert.equal(sitePublication({status:'published'},null).live,false);
 assert.equal(sitePublication({status:'maintenance'},page).live,false);
 assert.equal(pagePublication({status:'published'},{...page,status:'draft'}).visible,false);
 assert.equal(pagePublication({status:'published'},{...page,visibility:'private'}).visible,false);
 assert.match(pagePublication({status:'published'},{...page,builder:{hasUnpublishedChanges:true}}).label,/تعديلات غير منشورة/);
});

test('stored page publishing and site publication preserve isolation, permissions and stale-draft protection',async t=>{
 const db=await academySetup();t.after(()=>db.close());await configure(db);
 // Use real academy ACLs. Model only unrelated CMS bootstrap/version recording.
 await db.exec(`
 create table website.pages(id uuid primary key,site_id uuid,is_home boolean,status text,visibility text,content jsonb);
 alter table website.content_documents add column site_id uuid,add column entity_type text,add column entity_id uuid,
  add column draft_document jsonb,add column published_document jsonb,add column draft_updated_at timestamptz;
 create function private_app.cms_bootstrap_site(uuid,uuid) returns void language sql as $$ select $$;
 create function private_app.cms_resolve_site(p_site_key text,p_tenant_slug text,p_permission text,p_create boolean)
 returns website.sites language plpgsql as $$ declare s website.sites%rowtype;begin
 select * into s from website.sites where site_key='tenant:'||p_tenant_slug;
 if s.id is null then raise exception 'cms_site_not_found';end if;
 perform private_app.cms_access_subject(s.id,p_permission);return s;end $$;
 create or replace function public.v3_cms_builder_action(p_site_key text,p_tenant_slug text,p_entity_type text,p_entity_id uuid,p_action text,p_payload jsonb default '{}')
 returns jsonb language plpgsql as $$ begin
 update website.content_documents set published_document=p_payload->'document' where entity_id=p_entity_id;
 update website.pages set status='published',content=p_payload->'document' where id=p_entity_id;
 return jsonb_build_object('published',p_payload->'document');end $$;
 `);
 const pageId=id(9400),stamp='2026-09-22T12:00:00.123456Z',document={schemaVersion:1,blocks:[]};
 await db.query("insert into website.pages values($1,$2,true,'draft','public',null)",[pageId,SITE]);
 await db.query("insert into website.content_documents(id,site_id,entity_type,entity_id,draft_document,draft_updated_at) values($1,$2,'page',$3,$4,$5)",[id(9401),SITE,pageId,JSON.stringify(document),stamp]);
 await db.exec(await readFile(new URL('../supabase/migrations/20260922163848_cms_publication_controls.sql',import.meta.url),'utf8'));
 const publish=(action,payload,slug='marktone')=>call(db,'public.v3_cms_publication_action',{p_site_key:'tenant:'+slug,p_tenant_slug:slug,p_action:action,p_payload:payload});
 await assert.rejects(publish('publish-site',{expectedStatus:'draft'}),/cms_home_publish_required/);
 await assert.rejects(publish('publish-saved-page',{id:pageId}),/cms_publication_conflict/);
 await assert.rejects(publish('publish-saved-page',{id:pageId,expectedDraftUpdatedAt:'2026-09-21'}),/cms_publication_conflict/);
 await assert.rejects(publish('publish-saved-page',{id:id(9402),expectedDraftUpdatedAt:stamp}),/cms_entity_not_found/);
 await assert.rejects(publish('publish-site',{expectedStatus:'draft'},'reef'),/cms_site_not_found/);
 await platformAction(db,'set_member',{email:'editor@example.test',role:'website_editor',status:'active'});
 await login(db,EDITOR_AUTH);
 await assert.rejects(publish('publish-saved-page',{id:pageId,expectedDraftUpdatedAt:stamp}),/forbidden/);
 await assert.rejects(call(db,'public.v3_cms_action',{p_site_key:'tenant:marktone',p_tenant_slug:'marktone',p_action:'save-site',p_payload:{status:'published'}}),/publish_forbidden/);
 await login(db,ADMIN_AUTH);
 const result=await publish('publish-saved-page',{id:pageId,expectedDraftUpdatedAt:stamp});
 assert.deepEqual(result.result.published,document);
 assert.equal((await db.query('select status from website.sites where id=$1',[SITE])).rows[0].status,'draft');
 await db.query("update website.sites set primary_domain='learn.example.test',name_en='Keep me' where id=$1",[SITE]);
 await publish('publish-site',{expectedStatus:'draft'});
 assert.deepEqual((await db.query('select status,primary_domain,name_en from website.sites where id=$1',[SITE])).rows[0],{status:'published',primary_domain:'learn.example.test',name_en:'Keep me'});
 await assert.rejects(publish('publish-site',{expectedStatus:'draft'}),/cms_publication_conflict/);
 assert.equal((await db.query('select count(*)::int n from website.sites where tenant_id<>$1 and status=$2',[T,'published'])).rows[0].n,0);
 await login(db,null);await assert.rejects(publish('publish-site',{expectedStatus:'published'}),/authentication_required/);
});
