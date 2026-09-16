import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import {
  INTERACTIVE_TRAINING_PILOT,
  INTERACTIVE_TRAINING_VIEWS,
  interactiveTrainingAccess,
  interactiveTrainingHref,
  isInteractiveTrainingView
} from '../lib/interactive-training-access.mjs';

const tenantId='3d185482-b916-49cc-b868-b6dfdb93eba8';
const subjectId='1a795753-f2a7-44ed-a0db-7f85b1f6fbef';
const otherTenantId='ca4d407c-b088-4231-afd6-8ea7795c492c';
const denied={enabled:false,canPreviewRoles:false,tenantId:null,subjectId:null};
function fixture(){
  return {
    slug:'marktone',
    context:{subject:{id:subjectId},platformAccess:false,memberships:[{
      tenantId,tenantSlug:'marktone',status:'active',roles:['tenant_owner'],
      permissions:['tenant.academy.read','tenant.academy.write']
    }]},
    addonAccess:{tenantId,tenantSlug:'marktone',enabledProductKeys:['lms']}
  };
}

test('the pilot requires the verified Marktone identity, authenticated authority and its LMS entitlement',()=>{
  assert.deepEqual(INTERACTIVE_TRAINING_PILOT,{tenantId,slug:'marktone',productKey:'lms'});
  assert.ok(Object.isFrozen(INTERACTIVE_TRAINING_PILOT));
  assert.deepEqual(interactiveTrainingAccess(fixture()),{enabled:true,canPreviewRoles:true,tenantId,subjectId});
  const operator=fixture();operator.context.platformAccess=true;operator.context.memberships=[];
  assert.deepEqual(interactiveTrainingAccess(operator),{enabled:true,canPreviewRoles:true,tenantId,subjectId});
  operator.addonAccess.enabledProductKeys=[];
  assert.deepEqual(interactiveTrainingAccess(operator),denied,'platform access must not bypass the add-on entitlement');
});

test('other tenants, recreated slugs and conflicting authenticated metadata cannot enter the pilot',()=>{
  const variants=[
    ['different tenant URL',x=>{x.slug='reefskills';}],
    ['same slug, different tenant ID',x=>{x.addonAccess.tenantId=otherTenantId;x.context.memberships[0].tenantId=otherTenantId;}],
    ['membership contradicts resolved tenant',x=>{x.context.memberships[0].tenantId=otherTenantId;}],
    ['missing membership identity',x=>{delete x.context.memberships[0].tenantId;}],
    ['invalid membership identity',x=>{x.context.memberships[0].tenantId='marktone';}],
    ['snapshot slug contradicts route',x=>{x.addonAccess.tenantSlug='reefskills';}],
    ['unrelated membership',x=>{x.context.memberships[0].tenantSlug='reefskills';}],
    ['missing authoritative tenant ID',x=>{delete x.addonAccess.tenantId;}],
    ['invalid authoritative tenant ID',x=>{x.addonAccess.tenantId='marktone';}],
    ['missing authoritative slug',x=>{delete x.addonAccess.tenantSlug;}],
    ['case-changed route slug',x=>{x.slug='Marktone';}],
    ['cross-tenant operator snapshot',x=>{x.context.platformAccess=true;x.addonAccess.tenantId=otherTenantId;}]
  ];
  for(const [label,mutate] of variants){const input=fixture();mutate(input);assert.deepEqual(interactiveTrainingAccess(input),denied,label);}
});

test('missing authentication, inactive membership, missing entitlements or insufficient permissions fail closed',()=>{
  const variants=[
    ['missing context',x=>{delete x.context;}],
    ['anonymous subject',x=>{delete x.context.subject;}],
    ['invalid subject UUID',x=>{x.context.subject.id='anonymous';}],
    ['no membership',x=>{x.context.memberships=[];}],
    ['inactive membership',x=>{x.context.memberships[0].status='inactive';}],
    ['missing membership status',x=>{delete x.context.memberships[0].status;}],
    ['read-only employee',x=>{x.context.memberships[0].permissions=['tenant.academy.read'];}],
    ['write without read',x=>{x.context.memberships[0].permissions=['tenant.academy.write'];}],
    ['no academy authority',x=>{x.context.memberships[0].permissions=['tenant.clients.write'];}],
    ['role name alone',x=>{x.context.memberships[0].permissions=[];}],
    ['disabled LMS',x=>{x.addonAccess.enabledProductKeys=[];}],
    ['another add-on only',x=>{x.addonAccess.enabledProductKeys=['cms_pro'];}],
    ['missing add-on snapshot',x=>{delete x.addonAccess;}],
    ['malformed entitlement',x=>{x.addonAccess.enabledProductKeys='lms';}],
    ['nonboolean platform flag',x=>{x.context.platformAccess='true';x.context.memberships=[];}]
  ];
  assert.deepEqual(interactiveTrainingAccess(),denied);
  for(const [label,mutate] of variants){const input=fixture();mutate(input);assert.deepEqual(interactiveTrainingAccess(input),denied,label);}
});

test('preview roles are presentation capability and never replace authenticated academy authority',()=>{
  for(const role of ['tenant_owner','tenant_admin','training_manager']){
    const input=fixture();input.context.memberships[0].roles=[role];
    assert.equal(interactiveTrainingAccess(input).canPreviewRoles,true,role);
  }
  const employee=fixture();employee.context.memberships[0].roles=['instructor'];
  assert.equal(interactiveTrainingAccess(employee).enabled,true);
  assert.equal(interactiveTrainingAccess(employee).canPreviewRoles,false);
  for(const previewRole of ['admin','instructor','student']){
    const input=fixture();input.context.memberships[0].permissions=['tenant.academy.read'];
    input.previewRole=previewRole;input.context.previewRole=previewRole;input.canPreviewRoles=true;
    assert.deepEqual(interactiveTrainingAccess(input),denied,previewRole);
  }
});

test('direct child routes accept exactly the registered views and build tenant-local navigation',()=>{
  const expected=['dashboard','courses','paths','learners','calendar','assessments','placement','waitlist','surveys','categories','compliance','settings','support'];
  assert.deepEqual(INTERACTIVE_TRAINING_VIEWS.map(view=>view.key).sort(),expected.sort());
  assert.equal(new Set(INTERACTIVE_TRAINING_VIEWS.map(view=>view.key)).size,expected.length);
  for(const view of INTERACTIVE_TRAINING_VIEWS){
    assert.equal(isInteractiveTrainingView(view.key),true);
    assert.equal(interactiveTrainingHref('marktone',view.key),'/tenant/marktone/lms'+(view.key==='dashboard'?'':'/'+view.key));
    assert.equal(view.surfaceKey,'tenant.lms.'+view.key);
  }
  for(const view of ['../settings','studio','course','learning','unknown','courses/other','%2e%2e','',null,undefined,{},['courses']]){
    assert.equal(isInteractiveTrainingView(view),false,String(view));
    if(view!==undefined)assert.equal(interactiveTrainingHref('marktone',view),null,String(view));
  }
  assert.equal(interactiveTrainingHref('a/b','courses'),'/tenant/a%2Fb/lms/courses');
});

const require=createRequire(import.meta.url);
function routeHarness(path,input,{addonError,journeyEnabled=false}={}){
  const context={...input.context,addonAccess:input.addonAccess};
  const calls=[],Native=()=>null,Legacy=()=>null,Journey=()=>null;
  const exports={};
  const source=readFileSync(new URL('../'+path,import.meta.url),'utf8');
  const output=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const localRequire=name=>{
    if(name==='next/navigation')return {notFound(){throw new Error('not-found');}};
    if(name.endsWith('/interactive-training-workspace'))return {__esModule:true,default:Native};
    if(name.endsWith('/training-journey-workspace'))return {__esModule:true,default:Journey};
    if(name.endsWith('/training-snapshot'))return {getTrainingSnapshot:async()=>({operations:{enabled:journeyEnabled}})};
    if(name.endsWith('/lms-workspace'))return {__esModule:true,default:Legacy};
    if(name.endsWith('/interactive-training-access.mjs'))return {INTERACTIVE_TRAINING_PILOT,interactiveTrainingAccess,isInteractiveTrainingView};
    if(name.endsWith('/server-auth'))return {requireTenantAddon:async(...args)=>{calls.push(['requireTenantAddon',...args]);if(addonError)throw addonError;return context;}};
    if(name.endsWith('/api'))return {getTenantLms:async slug=>{calls.push(['getTenantLms',slug]);return {legacyFixture:true};}};
    return require(name);
  };
  vm.runInThisContext(`(function(require,module,exports){${output}\n})`,{filename:path})(localRequire,{exports},exports);
  return {page:exports.default,calls,Native,Legacy,Journey};
}

test('direct server routes reject unknown paths and other tenants before add-on data is accessed',async()=>{
  for(const params of [{slug:'reefskills',view:'courses'},{slug:'marktone',view:'studio'},{slug:'marktone',view:'unknown'}]){
    const route=routeHarness('app/tenant/[slug]/lms/[view]/page.js',fixture());
    await assert.rejects(route.page({params:Promise.resolve(params)}),/not-found/);
    assert.equal(route.calls.length,0);
  }
  for(const view of INTERACTIVE_TRAINING_VIEWS){
    const route=routeHarness('app/tenant/[slug]/lms/[view]/page.js',fixture());
    const result=await route.page({params:Promise.resolve({slug:'marktone',view:view.key})});
    assert.equal(result.type,route.Native);
    assert.deepEqual(result.props,{slug:'marktone',tenantId,subjectId,initialView:view.key,canPreviewRoles:true});
    assert.deepEqual(route.calls,[['requireTenantAddon','marktone','lms',{permission:'tenant.academy.read'}]]);
  }
});

test('server routes enforce the authenticated pilot and preserve the existing licensed LMS for other tenants',async()=>{
  const unauthorized=fixture();unauthorized.context.memberships[0].permissions=['tenant.academy.read'];
  const child=routeHarness('app/tenant/[slug]/lms/[view]/page.js',unauthorized);
  await assert.rejects(child.page({params:Promise.resolve({slug:'marktone',view:'courses'})}),/not-found/);
  const native=routeHarness('app/tenant/[slug]/lms/page.js',fixture());
  assert.equal((await native.page({params:Promise.resolve({slug:'marktone'})})).type,native.Native);
  assert.equal(native.calls.some(call=>call[0]==='getTenantLms'),false);
  const other=fixture();other.slug='reefskills';other.context.memberships[0].tenantSlug='reefskills';other.context.memberships[0].tenantId=otherTenantId;other.addonAccess.tenantSlug='reefskills';other.addonAccess.tenantId=otherTenantId;
  const legacy=routeHarness('app/tenant/[slug]/lms/page.js',other);
  const result=await legacy.page({params:Promise.resolve({slug:'reefskills'})});
  assert.equal(result.type,legacy.Legacy);
  assert.deepEqual(result.props,{slug:'reefskills',initialData:{legacyFixture:true}});
  for(const path of ['app/tenant/[slug]/lms/page.js','app/tenant/[slug]/lms/[view]/page.js']){
    const route=routeHarness(path,fixture(),{addonError:new Error('addon_required')});
    await assert.rejects(route.page({params:Promise.resolve({slug:'marktone',view:'courses'})}),/addon_required/);
    assert.equal(route.calls.some(call=>call[0]==='getTenantLms'),false,'entitlement denial cannot fall back to another workspace');
  }
});

test('enabled persistent journey replaces demo screens only after authenticated pilot and server rollout checks',async()=>{
  for(const view of INTERACTIVE_TRAINING_VIEWS){
    const route=routeHarness('app/tenant/[slug]/lms/[view]/page.js',fixture(),{journeyEnabled:true});
    const result=await route.page({params:Promise.resolve({slug:'marktone',view:view.key})});
    assert.equal(result.type,route.Journey);
    assert.equal(result.props.initialView,view.key);
    assert.equal(result.props.initialData.operations.enabled,true);
  }
  const root=routeHarness('app/tenant/[slug]/lms/page.js',fixture(),{journeyEnabled:true});
  assert.equal((await root.page({params:Promise.resolve({slug:'marktone'})})).type,root.Journey);
});
