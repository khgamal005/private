import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  academyBasePath,academyNavigation,academyTrainingHref,academyTrainingViews,canManageAcademy
} from '../lib/academy-navigation.mjs';

const access={
  enabled:true,tenant:{id:'tenant-1',slug:'training-center',name:'مركز التدريب'},
  mode:'standalone',odeirAccess:false,
  components:{website:true,lms:true,store:true},
  permissions:{manageLearning:true,manageWebsite:true,manageStore:true,manageAdmissions:true,verifyPayments:true}
};

test('standalone academy has its own website, store and teaching navigation without operations links',()=>{
  const items=academyNavigation(access);
  assert.ok(items.some(item=>item.href==='/academy/training-center/website'));
  assert.ok(items.some(item=>item.href==='/academy/training-center/store'));
  assert.ok(items.some(item=>item.href==='/academy/training-center/lms/courses'));
  assert.ok(items.every(item=>!item.href.startsWith('/tenant/')));
  assert.ok(!items.some(item=>['training-admissions','training-tasks'].includes(item.key)));
});

test('academy navigation intersects product entitlements with explicit staff capabilities',()=>{
  const websiteOnly={...access,components:{website:true,lms:false,store:false},permissions:{manageWebsite:true}};
  assert.deepEqual(academyNavigation(websiteOnly).map(item=>item.key),['home','website']);
  assert.equal(canManageAcademy(websiteOnly),true);
  for(const value of [undefined,{...access,enabled:false},{...access,components:{}},{...access,permissions:{}},{...access,permissions:{manageLearning:'true',manageWebsite:1}}]){
    assert.equal(canManageAcademy(value),false);
    assert.deepEqual(academyTrainingViews(value),[]);
  }
});

test('admissions and payment staff get orders without CMS editing or learning authoring',()=>{
  const value={...access,permissions:{verifyPayments:true}};
  assert.equal(canManageAcademy(value),true);
  assert.deepEqual(academyNavigation(value).map(item=>item.key),['home','store']);
});

test('connected finance staff can open their scoped training operations without learning permissions',()=>{
  const value={...access,mode:'connected',odeirAccess:true,permissions:{verifyPayments:true}};
  assert.deepEqual(academyTrainingViews(value).map(item=>item.key),['dashboard','admissions','tasks']);
  assert.equal(canManageAcademy(value),true);
});

test('standalone admissions staff review requests without Odeir operational links or learning editor',()=>{
  const value={...access,odeirAccess:true,permissions:{manageAdmissions:true}};
  assert.deepEqual(academyTrainingViews(value).map(item=>item.key),['dashboard','requests']);
  assert.equal(canManageAcademy(value),true);
});

test('training links stay inside the tenant academy and reject arbitrary view names',()=>{
  assert.equal(academyBasePath('a/b'),'/academy/a%2Fb');
  assert.equal(academyTrainingHref('a/b','courses'),'/academy/a%2Fb/lms/courses');
  assert.equal(academyTrainingHref('training-center'),'/academy/training-center/lms');
  for(const view of ['../../control','javascript:alert(1)','paths','',null]){
    assert.equal(academyTrainingHref('training-center',view),null);
  }
});
test('learning paths appear only for the pilot learning manager and legacy links resolve inside academy',()=>{
 const pilot={...access,tenant:{...access.tenant,slug:'marktone'}};
 assert.equal(academyNavigation(pilot).find(item=>item.key==='training-paths').href,'/academy/marktone/lms/paths');
 assert.ok(!academyNavigation(access).some(item=>item.key==='training-paths'));
 assert.ok(!academyNavigation({...pilot,permissions:{verifyPayments:true}}).some(item=>item.key==='training-paths'));
});

test('CMS academy workspace keeps studio and builder links in the academy without changing the site identity',async()=>{
  const source=await readFile(new URL('../lib/cms.js',import.meta.url),'utf8');
  const cms=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const context={scope:'tenant',tenantSlug:'training-center',siteKey:'tenant:training-center',workspace:'academy'};
  assert.equal(cms.cmsBasePath(context),'/academy/training-center/website');
  assert.equal(cms.cmsBuilderPath(context,'page','page-1'),'/academy/training-center/website/builder/page/page-1');
  assert.equal(cms.cmsPublicPath(context,'page',{isHome:true}),'/site/training-center');
  assert.equal(cms.cmsPreviewPath(context,'page','page-1'),'/cms-preview/tenant%3Atraining-center/page/page-1?workspace=academy');
  assert.equal(cms.cmsBasePath({...context,workspace:undefined}),'/tenant/training-center/website');
  assert.equal(cms.cmsBasePath({scope:'platform',workspace:'academy'}),'/control/website');
});
