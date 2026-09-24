import test from 'node:test';
import assert from 'node:assert/strict';
import React,{act} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
import {moduleLoader} from './fixtures/zoom-module-loader.mjs';
import {zoomViewOptions,zoomLegacyMeetingVisible} from '../lib/zoom-setup.mjs';
const load=moduleLoader();
const Accounts=load('components/zoom-accounts.jsx').default;
const Workspace=load('components/zoom-workspace.jsx').default;
const base=()=>({enabled:false,permissions:{accounts:true,retention:true,hosts:true,sessions:true},staff:[{id:'staff-1',name:'مسؤول تجريبي'}],settings:null,accounts:[],hosts:[],setup:{available:true,initialized:false,entitled:true,canConfigure:true,environment:'test',ownerReady:false,accounts:0,hosts:0,connectedAccounts:0,eligibleHosts:0,runtime:{canConnect:false,canSchedule:false,environment:'test',checks:{}}}});
const props=data=>({data,slug:'synthetic',busy:false,action:async()=>{},filters:{},setFilters(){},setOffset(){},onSessions(){}});

test('learner operations retains eligible legacy history without a second create control for new or managed Zoom sessions',()=>{
 const historical={provider:'zoom',externalMeetingId:'synthetic-old',createdAt:'2026-09-10T12:00:00Z',joinUrl:'https://zoom.us/j/12345678901'};
 const empty={status:'not_created'};
 assert.equal(zoomLegacyMeetingVisible(empty,[]),false);
 assert.equal(zoomLegacyMeetingVisible(historical,[historical]),true);
 assert.equal(zoomLegacyMeetingVisible(empty,[historical]),true);
 assert.equal(zoomLegacyMeetingVisible(historical,[historical],true),false);
 assert.equal(zoomLegacyMeetingVisible({...empty,joinUrl:'/training/synthetic/sessions/one'},[historical]),false);
});

test('first visit shows setup ownership, excludes empty operational filters and deletion/AI tools',()=>{
 const html=renderToStaticMarkup(React.createElement(Workspace,{slug:'synthetic',initialData:base(),initialView:'accounts'}));
 assert.match(html,/بانتظار تجهيز الربط في أودير/);assert.match(html,/مسؤول أودير/);assert.match(html,/حفظ إعداد المنشأة/);
 for(const text of ['مراجعة حذف المشتقات التعليمية','اعتماد السياسة','حالة المضيف','datetime-local','الصفحة 1','اسم المحاضرة أو المضيف','ربط أول حساب Zoom'])assert.ok(!html.includes(text),text);
 assert.match(html,/tenant\/synthetic\/support/);assert.doesNotMatch(html,/control\/addons\/zoom/);
 const platform=renderToStaticMarkup(React.createElement(Accounts,{...props(base()),canManagePlatform:true}));assert.match(platform,/control\/addons\/zoom/);
});

test('unavailable readiness fails closed with a visible next step, including existing accounts',()=>{
 const data=base();data.enabled=true;data.setup={available:false};data.accounts=[{id:'a',label:'حساب اصطناعي',status:'connected'}];
 const html=renderToStaticMarkup(React.createElement(Accounts,props(data)));
 assert.match(html,/تعذر التحقق من جاهزية الربط/);assert.match(html,/data-block-reason="حدّث الجاهزية/);
 assert.match(html,/حساب اصطناعي/);assert.doesNotMatch(html,/مراجعة حذف المشتقات التعليمية/);
});

test('actual rendered form sends initialization separately from confirmed activation; basic policy does not require recordings',async t=>{
 const dom=new JSDOM('<div id="root"></div>',{url:'https://odeir.example.test/tenant/synthetic/addons/zoom?view=accounts'});
 const previous={window:global.window,document:global.document,FormData:global.FormData,IS_REACT_ACT_ENVIRONMENT:global.IS_REACT_ACT_ENVIRONMENT};
 Object.assign(global,{window:dom.window,document:dom.window.document,FormData:dom.window.FormData,IS_REACT_ACT_ENVIRONMENT:true});
 const root=createRoot(document.getElementById('root'));t.after(async()=>{await act(async()=>root.unmount());Object.assign(global,previous);dom.window.close();});
 const data=base();data.setup.runtime.canConnect=true;const calls=[];
 const render=()=>act(async()=>root.render(React.createElement(Accounts,{...props(data),action:async(...args)=>{calls.push(args);return {};}})));
 await render();const select=document.querySelector('select[name="ownerStaffId"]');
 await act(async()=>{select.value='staff-1';select.dispatchEvent(new dom.window.Event('change',{bubbles:true}));});
 await act(async()=>document.querySelector('form').requestSubmit());
 assert.deepEqual(calls[0].slice(0,2),['initialize',{ownerStaffId:'staff-1',environment:'test'}]);
 assert.equal(calls.some(x=>x[0]==='activate'),false);
 data.setup.initialized=true;data.setup.ownerReady=true;data.setup.revision=1;
 data.settings={revision:1,owner_staff_id:'staff-1',join_before_minutes:15,recording_policy:'off'};
 await render();const activation=document.querySelector('form');
 await act(async()=>activation.requestSubmit());assert.equal(calls.length,1); // Browser form validation requires explicit consent.
 await act(async()=>{activation.querySelector('input[type="checkbox"]').click();activation.requestSubmit();});
 assert.deepEqual(calls[1].slice(0,2),['activate',{expectedVersion:1,confirmed:true}]);
 assert.equal(document.querySelector('input[name="days"]'),null);
});

test('filters belong to the selected view and do not leak host status into session/report queries',()=>{
 const common={query:'synthetic',offset:0,filters:{status:'allowed',connectionId:'a',quality:'complete'},from:'2030-01-01T10:00',to:'2030-01-02T10:00',sessionId:'session'};
 const accounts=zoomViewOptions({...common,view:'accounts'});assert.equal(accounts.from,undefined);assert.equal(accounts.quality,undefined);assert.equal(accounts.sessionId,undefined);assert.equal(accounts.status,'allowed');
 const sessions=zoomViewOptions({...common,view:'sessions'});assert.equal(sessions.status,undefined);assert.equal(sessions.connectionId,undefined);assert.equal(sessions.sessionId,'session');assert.ok(sessions.from);
 const reports=zoomViewOptions({...common,view:'reports'});assert.equal(reports.status,undefined);assert.equal(reports.quality,'complete');
});
