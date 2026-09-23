import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as views from '../lib/interactive-training-access.mjs';
import * as contract from '../lib/zoom-contract.mjs';

const require=createRequire(import.meta.url);
function load(path,dependency=require){
 const source=readFileSync(new URL(path,import.meta.url),'utf8');
 const output=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
 const mod={exports:{}};
 vm.runInThisContext(`(function(require,module,exports){${output}\n})`)(dependency,mod,mod.exports);
 return mod.exports;
}
const registry=load('../lib/addons/placement-registry.js',name=>name.endsWith('interactive-training-access.mjs')?views:require(name));
const Link=({children,...props})=>React.createElement('a',props,children);
const navigation={useRouter:()=>({refresh(){}})};
const Hub=load('../components/integration-hub.js',name=>name==='next/link'?{__esModule:true,default:Link}:name==='next/navigation'?navigation:name.endsWith('placement-registry')?registry:require(name)).default;

test('Zoom catalog fallback and legacy placements open tenant-scoped account settings',()=>{
 for(const extra of [{},{actions:{openPlacementKey:'tenant.settings.integrations'}},{openPlacementKey:'tenant.settings.integrations'},{primarySurfaceKey:'tenant.settings.integrations'},{surfaces:[{key:'legacy.zoom',location:'tenant.settings.integrations',visibility:'when_entitled',status:'active'}]}]){
  assert.equal(registry.addonHref('synthetic/a',{key:'zoom',...extra}),'/tenant/synthetic%2Fa/addons/zoom?view=accounts');
 }
 assert.equal(registry.addonHref('synthetic-b',{key:'zoom'}),'/tenant/synthetic-b/addons/zoom?view=accounts');
 assert.equal(registry.addonHref('synthetic-a',{key:'email'}),'/tenant/synthetic-a/settings?tab=integrations');
 assert.equal(registry.addonHref('synthetic-a',{key:'unknown',routeTemplate:'https://evil.example'}),null);
});

test('integration hub renders Zoom settings only for licensed tenants; others get store discovery',()=>{
 const render=keys=>renderToStaticMarkup(React.createElement(Hub,{slug:'synthetic/a',enabledProductKeys:keys}));
 assert.match(render(['zoom']),/href="\/tenant\/synthetic%2Fa\/addons\/zoom\?view=accounts"/);
 const unlicensed=render(['email']);
 assert.match(unlicensed,/href="\/tenant\/synthetic%2Fa\/addons-store"/);
 assert.doesNotMatch(unlicensed,/href="[^"]*\/addons\/zoom/);
 assert.match(unlicensed,/تحتاج هذه المنشأة إلى ترخيص/);
});

test('Zoom-only tenant can reach integration settings without legacy messaging entitlements',()=>{
 const Settings=load('../components/tenant-settings.js',name=>name==='next/navigation'?navigation:name==='./integration-hub'?{__esModule:true,default:Hub}:name.startsWith('./')?{__esModule:true,default:()=>null}:require(name)).default;
 const html=renderToStaticMarkup(React.createElement(Settings,{slug:'synthetic-a',initialTab:'integrations',initialData:{addonAccess:{enabledProductKeys:['zoom']}}}));
 assert.match(html,/فتح إعدادات Zoom/);
});

function page({deny=false,error=null}={}){
 const calls=[];
 const Page=load('../app/tenant/[slug]/addons/zoom/page.js',name=>{
  if(name.endsWith('server-auth'))return {requireTenantAddon:async(...args)=>{calls.push(['guard',...args]);if(deny)throw Error('redirect: addon_required');}};
  if(name.endsWith('training-server'))return {trainingRpc:async(...args)=>{calls.push(['rpc',...args]);if(error)throw error;return {synthetic:true};}};
  if(name.endsWith('zoom-workspace'))return {__esModule:true,default:()=>null};
  if(name.endsWith('zoom-contract.mjs'))return contract;
  return require(name);
 }).default;
 return {calls,run:()=>Page({params:Promise.resolve({slug:'synthetic-a'}),searchParams:Promise.resolve({view:'accounts'})})};
}
test('direct Zoom route checks canonical entitlement before snapshot and preserves tenant/view',async()=>{
 const denied=page({deny:true});await assert.rejects(denied.run,/addon_required/);assert.equal(denied.calls.length,1);
 const allowed=page();const result=await allowed.run();
 assert.deepEqual(allowed.calls,[['guard','synthetic-a','zoom'],['rpc','v1_zoom_snapshot',{p_slug:'synthetic-a',p_view:'accounts'}]]);
 assert.equal(result.props.initialView,'accounts');
});
test('missing deployed Zoom RPC has an honest setup state; permission failures remain permission failures',async()=>{
 const missing=page({error:{code:'Could not find the function public.v1_zoom_snapshot(p_slug, p_view) in the schema cache'}});
 const html=renderToStaticMarkup(await missing.run());assert.match(html,/بانتظار استكمال تجهيز الخادم/);assert.doesNotMatch(html,/schema cache|public\.v1_zoom_snapshot/);
 const forbidden=renderToStaticMarkup(await page({error:{code:'zoom_forbidden'}}).run());
 assert.match(forbidden,/ليست لديك صلاحية/);assert.doesNotMatch(forbidden,/بانتظار استكمال/);
});
