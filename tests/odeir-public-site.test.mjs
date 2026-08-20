import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('ODEIR launch migration publishes the concise builder-managed public site',async()=>{
  const migration=await read('supabase/migrations/20260820183034_odeir_public_site_launch.sql');
  assert.match(migration,/name_ar='أودير',name_en='ODEIR'/);
  assert.match(migration,/primary_domain='odeir\.com'/);
  assert.match(migration,/سجّل منشأتك مجانًا/);
  assert.match(migration,/تسجيل دخول المنشآت/);
  assert.match(migration,/website\.content_documents/);
  assert.match(migration,/page_kind='legal'/);
  for(const slug of ['privacy-policy','information-security','terms-of-use','cookie-policy','data-rights']){
    assert.match(migration,new RegExp(`"slug":"${slug}"`));
  }
  assert.doesNotMatch(migration,/core\.tenants|reef_skills|شركة ريف/);
});

test('ODEIR registration and authentication entry points carry the new identity',async()=>{
  const [application,trial,login,brand]=await Promise.all([
    read('components/lifetime-free-application.js'),
    read('components/free-trial-landing.js'),
    read('app/login/page.js'),
    read('components/odeir-brand.js')
  ]);
  assert.match(application,/OdeirBrand/);
  assert.match(application,/مرحبًا بمنشأتك في أودير/);
  assert.match(trial,/aria-label="تسجيل منشأة في أودير"/);
  assert.match(login,/تسجيل دخول المنشآت \| أودير/);
  assert.match(brand,/inverse\?'\/odeir\/odeir-logo-dark\.png':'\/odeir\/odeir-logo-official\.png'/);
  assert.match(brand,/أودير ODEIR/);
});

test('ODEIR production homepage uses the interactive, builder-backed landing experience',async()=>{
  const [page,landing,styles]=await Promise.all([
    read('app/page.js'),
    read('components/odeir-landing-experience.tsx'),
    read('app/odeir-landing-experience.css')
  ]);
  assert.match(page,/OdeirLandingExperience/);
  assert.match(page,/landingCms\(snapshot,home\)/);
  for(const blockId of ['odeir-home-hero','odeir-capabilities','odeir-trust','odeir-faq','odeir-final-cta']){
    assert.match(page,new RegExp(blockId));
  }
  assert.match(landing,/تجربة توضيحية · بيانات افتراضية/);
  assert.match(landing,/سلة/);
  assert.match(landing,/زد/);
  assert.match(landing,/WooCommerce/);
  assert.match(landing,/بيانات منشأتك/);
  assert.match(styles,/\.odeir-experience \.hero-shell/);
  assert.doesNotMatch(styles,/@scope/);
  assert.doesNotMatch(landing,/ريف|reef/i);
});

test('builder runtime renders the ODEIR product preview without changing generic tenant heroes',async()=>{
  const renderer=await read('components/page-builder-module-view.js');
  assert.match(renderer,/includes\('odeir-product-hero'\)/);
  assert.match(renderer,/odeirProductShell/);
  assert.match(renderer,/بيانات توضيحية/);
  assert.match(renderer,/<ButtonRow p=\{p\} editor=\{editor\}/);
});

test('the isolated design preview is static, noindex, and includes all policy routes',async()=>{
  const [home,legal,content]=await Promise.all([
    read('app/odeir-preview/page.js'),
    read('app/odeir-preview/[slug]/page.js'),
    read('lib/odeir-preview-content.js')
  ]);
  assert.match(home,/BuiltPublicPage/);
  assert.match(home,/index:false/);
  assert.match(legal,/dynamicParams=false/);
  assert.match(content,/#06182e/);
  assert.match(content,/#13c7d1/);
  assert.match(content,/#f0c534/);
  for(const slug of ['privacy-policy','information-security','terms-of-use','cookie-policy','data-rights']){
    assert.match(content,new RegExp(`'${slug}'`));
  }
  assert.doesNotMatch(content,/supabase|TRIAL_API|core\.tenants/);
});
