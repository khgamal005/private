import assert from 'node:assert/strict';
import test from 'node:test';
import {campaignFilters,campaignHref,campaignEconomics,campaignCsv,sourceGroups,suggestCampaign} from '../lib/campaign-revenue.mjs';
test('filters survive links and reject ambiguous/future dates and IDs',()=>{
 const f=campaignFilters({from:'2026-08-01',to:'2026-08-31',asOf:'2026-02-30',staff:'anything',mode:'cash'},new Date('2026-09-06T12:00:00Z'));
 assert.equal(f.asOf,'2026-09-06');assert.equal(f.staff,'');assert.match(campaignHref('fixture',f,{offset:50}),/reports\/campaigns\?.*mode=cash&offset=50/);
});
test('tenant midnight and independent Meta filters survive navigation',()=>{
 const f=campaignFilters({metaQ:'PMP',status:'paused'},new Date('2026-09-06T22:30:00Z'),'Asia/Riyadh');
 assert.equal(f.today,'2026-09-07');assert.equal(f.asOf,'2026-09-07');assert.match(campaignHref('fixture',f),/metaQ=PMP&status=paused/);
});
test('matching same-name campaigns across accounts requires selection and never upgrades evidence',()=>{
 const g={campaignName:'Training'};
 assert.equal(suggestCampaign(g,[{id:'a',name:'Training'},{id:'b',name:'Training'}]),'');
 assert.equal(sourceGroups([{...g,key:'1',batchId:'a'},{...g,key:'2',batchId:'b'}]).length,2);
});
test('missing spend, partial CRM scopes and currency mismatch cannot generate ROAS',()=>{
 const g={leads:10,payers:2,money:[{currency:'SAR',netMinor:10000}]},f={mode:'cohort'};
 assert.equal(campaignEconomics(g,{metricRows:0,spendMinor:0,currency:'SAR'},f).roas,null);
 assert.equal(campaignEconomics(g,{metricRows:1,coverageConfirmed:true,spendMinor:5000,currency:'EGP'},f).roas,null);
 assert.equal(campaignEconomics(g,{metricRows:1,coverageConfirmed:true,spendMinor:5000,currency:'SAR'},f).roas,2);
 assert.equal(campaignEconomics(g,{metricRows:1,coverageConfirmed:true,spendMinor:5000,currency:'SAR'},{...f,staff:'staff'}).roas,null);
});
test('CSV exports all filtered groups, currency and date basis and escapes formula injection',()=>{
 const csv=campaignCsv({groups:[{name:'=SUM(A1)',leads:2,payers:1,money:[{currency:'SAR',grossMinor:10000,refundMinor:2000,netMinor:8000}]}],range:{from:'2026-08-01',to:'2026-08-31',asOf:'2026-09-05',mode:'cohort'}});
 assert.match(csv,/'=SUM\(A1\)/);assert.match(csv,/"100","20","80"/);assert.match(csv,/2026-09-05/);
});
