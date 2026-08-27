import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('ODEIR homepage reads header and footer menus from the CMS snapshot',async()=>{
  const [page,landing,chrome]=await Promise.all([
    read('app/page.js'),
    read('components/odeir-landing-experience.tsx'),
    read('components/odeir-site-chrome.tsx')
  ]);
  assert.match(page,/menu:Array\.isArray\(snapshot\?\.menu\)\?snapshot\.menu:\[\]/);
  assert.match(page,/footerMenu:Array\.isArray\(snapshot\?\.footerMenu\)\?snapshot\.footerMenu:\[\]/);
  assert.match(landing,/<OdeirSiteHeader menu=\{cms\.menu\} settings=\{cms\.settings\} hero=\{cms\.hero\}/);
  assert.doesNotMatch(landing,/<OdeirSiteHeader[^>]+variant="manager"/);
  assert.match(landing,/<OdeirSiteFooter footerMenu=\{cms\.footerMenu\} settings=\{cms\.settings\} \/>/);
  assert.doesNotMatch(landing,/<footer className="site-footer">/);
  assert.match(chrome,/buildMenuTree\(source\)/);
  assert.match(chrome,/data-managed-chrome="header"/);
  assert.match(chrome,/data-managed-chrome="footer"/);
  assert.doesNotMatch(chrome,/MANAGER_PRIMARY_MENU/);
  for(const label of ['أول فنجان','التكاملات','جولة داخل أودير','رحلة العميل','متاجر أودير','الحماية']){
    assert.match(chrome,new RegExp(label));
  }
});

test('builder pages, legal pages, articles and legacy content share the ODEIR chrome without changing tenant chrome',async()=>{
  const [built,legacy,pageRoute,articleRoute,trialRoute]=await Promise.all([
    read('components/built-public-page.js'),
    read('components/public-site.js'),
    read('app/p/[slug]/page.js'),
    read('app/articles/[slug]/page.js'),
    read('app/free-trial/page.js')
  ]);
  for(const source of [built,legacy]){
    assert.match(source,/site\?\.key==='marktone-main'/);
    assert.match(source,/OdeirSiteHeader/);
    assert.match(source,/OdeirSiteFooter/);
    assert.match(source,/odeir-managed-header-shell/);
    assert.match(source,/data-site-chrome=\{managed\?'odeir-managed':'tenant-managed'\}/);
  }
  assert.match(built,/:<Header menu=\{menu\} settings=\{settings\} site=\{site\}\/?>/);
  assert.match(built,/:<Footer menu=\{footerMenu\} settings=\{settings\} site=\{site\}\/?>/);
  for(const route of [pageRoute,articleRoute,trialRoute]) assert.match(route,/BuiltPublicPage/);
});

test('CMS navigation reconciliation is platform-scoped, reversible and content-preserving',async()=>{
  const migration=await read('supabase/migrations/20260827223000_odeir_cms_managed_site_chrome_v1.sql');
  assert.match(migration,/site\.site_key='marktone-main' and site\.site_scope='platform'/);
  assert.match(migration,/order by menu\.id\s+for update/);
  assert.match(migration,/order by item\.id\s+for update/);
  assert.match(migration,/insert into website\.content_revisions/);
  assert.match(migration,/'managedChromeVersion',1/);
  assert.match(migration,/header_count_invalid/);
  assert.match(migration,/footer_count_invalid/);
  assert.match(migration,/content_changed/);
  assert.doesNotMatch(migration,/delete\s+from\s+website\.(?:pages|content_documents|menu_items)/i);
  assert.doesNotMatch(migration,/update\s+website\.(?:pages|content_documents)/i);
  for(const href of ['\/#morning-brief','\/#story','\/#product','\/#journey','\/#marketplace','\/#security']){
    assert.match(migration,new RegExp(href));
  }
});

test('site administration explains the shared chrome while every page remains builder-editable',async()=>{
  const pages=await read('components/cms-studio-pages.js');
  assert.match(pages,/كل صفحة ترث تلقائيًا هيدر وفوتر وقوائم موقع المنشأة/);
  assert.match(pages,/محتوى كل صفحة مستقل في البيلدر/);
  assert.match(pages,/تخطيط الموقع موحّد/);
  assert.match(pages,/cmsBuilderPath\(context,'page',page\.id\)/);
  assert.match(pages,/معاينة المسودة/);
  assert.match(pages,/فتح المنشور/);
});
