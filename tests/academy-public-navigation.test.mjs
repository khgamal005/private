import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import {academyPublicLinks,academyPublicMenu,withAcademyPublicNavigation} from '../lib/academy-public-navigation.mjs';

const config={enabled:true,tenant:{slug:'marktone',name:'مركز ماركتون'},components:{website:true,lms:true,store:true}};
const snapshot={available:true,site:{key:'tenant:marktone',nameAr:'مركز ماركتون',settings:{}}};

test('public academy navigation links storefront and learner roles without exposing private workspace fields',()=>{
  const decorated=withAcademyPublicNavigation(snapshot,{...config,memberships:[{email:'private@example.test'}],permissions:{manageStore:true},billing:{amount:100}});
  assert.deepEqual(decorated.site.academyNavigation,{slug:'marktone',lms:true,store:true});
  assert.equal(JSON.stringify(decorated).includes('private@example.test'),false);
  assert.deepEqual(academyPublicLinks(decorated.site),{
    catalog:'/site/marktone/courses',learner:'/training/login?tenant=marktone&workspace=academy',
    instructor:'/training/login?tenant=marktone&workspace=academy&role=instructor',manager:'/academy/login?tenant=marktone'
  });
  assert.equal(snapshot.site.academyNavigation,undefined);
});

test('disabled or unrelated academy metadata leaves existing tenant and Odeir sites unchanged',()=>{
  for(const value of [null,{...config,enabled:false},{...config,tenant:{slug:'other'}},{...config,components:{website:false,lms:true,store:true}},{...config,tenant:{slug:'../evil'}}]){
    assert.equal(withAcademyPublicNavigation(snapshot,value),snapshot);
  }
  const main={...snapshot,site:{key:'marktone-main'}};
  assert.equal(withAcademyPublicNavigation(main,config),main);
  assert.equal(academyPublicLinks({key:'tenant:other',academyNavigation:{slug:'marktone',lms:true}}),null);
});

test('disabled store and learning components have no public links and explicit login menus follow academy entry',()=>{
  const site=withAcademyPublicNavigation(snapshot,{...config,components:{website:true}}).site;
  const links=academyPublicLinks(site);
  assert.equal(links.catalog,null);assert.equal(links.learner,null);assert.equal(links.instructor,null);
  const menu=[{id:'one',href:'/login',label:'دخول المنشآت'},{id:'two',href:'/p/about',label:'عن المركز'}];
  assert.deepEqual(academyPublicMenu(menu,links),[{id:'one',href:'/academy/login?tenant=marktone',label:'إدارة المنصة'},menu[1]]);
  assert.equal(academyPublicMenu(menu,null),menu);
  assert.equal(menu[0].href,'/login');
});

function previewHarness(access){
  const calls=[];
  const source=readFileSync(new URL('../app/cms-preview/[siteKey]/[entityType]/[entityId]/page.js',import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
  const require=createRequire(import.meta.url),loadedModule={exports:{}};
  const localRequire=name=>{
    if(name==='next/navigation')return {notFound(){throw Error('not_found');}};
    if(name.endsWith('/built-public-page'))return {__esModule:true,default:'BuiltPublicPage'};
    if(name.endsWith('/academy-server'))return {readAcademyAccess:async()=>access};
    if(name.endsWith('/cms-public'))return {getCmsPublicSnapshot:async()=>snapshot};
    if(name.endsWith('/training-server'))return {trainingRpc:async()=>{calls.push('academy-builder');return {entity:{id:'page'},document:{draftDocument:{version:1}}};}};
    if(name.endsWith('/server-auth'))return {requireTenantPermission:async()=>{calls.push('tenant-permission');},requirePlatform:async()=>{calls.push('platform-permission');},authRpc:async()=>{calls.push('legacy-builder');return {entity:{id:'page'}};}};
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(localRequire,loadedModule,loadedModule.exports);
  return {run:siteKey=>loadedModule.exports.default({params:Promise.resolve({siteKey,entityType:'page',entityId:'page'})}),calls};
}

test('standalone CMS preview uses academy authorization without tenant or platform membership redirect',async()=>{
  const h=previewHarness({...config,permissions:{manageWebsite:true}});
  const rendered=await h.run('tenant:marktone');
  assert.deepEqual(h.calls,['academy-builder']);
  assert.equal(rendered.props.preview,true);
});

test('legacy CMS preview retains tenant/platform authorization and never trusts absent academy permission',async()=>{
  const legacy=previewHarness({...config,permissions:{manageWebsite:false}});
  await legacy.run('tenant:marktone');assert.deepEqual(legacy.calls,['tenant-permission','legacy-builder']);
  const main=previewHarness(null);await main.run('marktone-main');assert.deepEqual(main.calls,['platform-permission','legacy-builder']);
});
