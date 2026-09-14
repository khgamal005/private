import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {
  finiteMetric,formatGoogleMetric,googleCampaignEconomics,googleReportFilters,googleReportHref,
  groupGoogleSources,googleSourcePreview,requestGoogleAction,safeGoogleAuthorizeUrl
} from '../lib/google-ads/ui.mjs';

test('missing metrics remain unavailable while confirmed zero stays a number',()=>{
  for(const value of [null,undefined,'',' ',false,NaN,Infinity,{},[]]){
    assert.equal(finiteMetric(value),null);
    assert.equal(formatGoogleMetric(value),'غير متاح');
  }
  assert.equal(finiteMetric(0),0);
  assert.equal(finiteMetric('0'),0);
  assert.notEqual(formatGoogleMetric(0),'غير متاح');
  assert.equal(formatGoogleMetric(100,{money:true,currency:''}),'غير متاح');
});

test('minor-unit currencies display correct SAR, JPY and KWD values',()=>{
  for(const [currency,value] of [['SAR',12345],['JPY',123],['KWD',12345]]){
    const formatter=new Intl.NumberFormat('ar-SA',{style:'currency',currency});
    const divisor=currency==='JPY'?1:currency==='KWD'?1000:100;
    assert.equal(formatGoogleMetric(value,{money:true,currency}),formatter.format(value/divisor));
  }
});

test('financial ratios require complete spend and valid currency, timezone and origin dates',()=>{
  const row={spendMinor:10000,verifiedPayers:2,manualCostPerPayerMinor:5000,manualCollectionRoas:3};
  assert.equal(googleCampaignEconomics(row,{spendComplete:true,currencyMatches:true,timeBasisMatches:true,sourceDatesReliable:true}).collectionRoas,3);
  for(const coverage of [{},{spendComplete:false},{spendComplete:true,currencyMatches:false},{spendComplete:true,timeBasisMatches:false},{spendComplete:true,sourceDatesReliable:false}]){
    const result=googleCampaignEconomics(row,coverage);
    assert.equal(result.costPerPayerMinor,null);
    assert.equal(result.collectionRoas,null);
  }
  assert.equal(googleCampaignEconomics({...row,spendMinor:0},{spendComplete:true}).collectionRoas,null);
  assert.equal(googleCampaignEconomics({...row,verifiedPayers:0},{spendComplete:true}).costPerPayerMinor,null);
  assert.equal(googleCampaignEconomics({...row,manualCostPerPayerMinor:null,manualCollectionRoas:null},{spendComplete:true}).collectionRoas,null);
});

test('report filters use account calendar, reject invalid dates and preserve encoded searches',()=>{
  const now=new Date('2026-09-09T22:30:00Z');
  const range=googleReportFilters({},now,'Asia/Riyadh');
  assert.deepEqual(range,{dateFrom:'2026-08-12',dateTo:'2026-09-10',asOf:'2026-09-10',today:'2026-09-10',search:'',page:1});
  const invalid=googleReportFilters({from:'2026-02-30',to:'2099-01-01',asOf:'wrong',page:'-2'},now,'UTC');
  assert.equal(invalid.dateTo,'2026-09-09');
  assert.equal(invalid.page,1);
  const limited=googleReportFilters({from:'2026-01-01',to:'2026-09-09'},now,'UTC');
  assert.equal(limited.rangeLimited,true);
  assert.equal(limited.dateFrom,'2026-08-10');
  const crossZone=googleReportFilters({to:'2026-09-10'},now,'Asia/Riyadh','America/Los_Angeles');
  assert.equal(crossZone.dateTo,'2026-09-09');
  assert.equal(crossZone.asOf,'2026-09-10');
  const reverse=googleReportFilters({to:'2026-09-10'},now,'America/Los_Angeles','Asia/Riyadh');
  assert.equal(reverse.dateTo,'2026-09-09');
  assert.equal(reverse.asOf,'2026-09-09');
  const href=googleReportHref('demo',range,{search:'Excel & Power BI',page:2});
  const url=new URL(href,'https://odeir.com');
  assert.equal(url.searchParams.get('q'),'Excel & Power BI');
  assert.equal(url.searchParams.get('page'),'2');
  assert.ok(!href.includes('/campaigns'));
});

test('manual preview groups only explicit rows, preserves tokens and never sends names',()=>{
  const rows=[
    {originKey:'lead-1',previewToken:'a',contactId:'c1',name:'Private A',source:'google',campaignName:'PMP'},
    {originKey:'lead-2',previewToken:'b',contactId:'c2',name:'Private B',source:'google',campaignName:'PMP'},
    {originKey:'lead-3',previewToken:'c',source:'other',campaignName:'PMP'},
    {originKey:'lead-1',previewToken:'a'},
    {originKey:'no-preview',source:'google'}
  ];
  const groups=groupGoogleSources(rows);
  assert.equal(groups.length,2);
  assert.equal(groups[0].rows.length,2);
  const campaigns=[{campaignId:'123',name:'PMP Search'}];
  assert.equal(googleSourcePreview(groups,[],'123',campaigns),null);
  assert.equal(googleSourcePreview(groups,[groups[0].key],'unknown',campaigns),null);
  const preview=googleSourcePreview(groups,[groups[0].key],'123',campaigns);
  assert.equal(preview.rowCount,2);
  assert.deepEqual(preview.rows,[{originKey:'lead-1',previewToken:'a'},{originKey:'lead-2',previewToken:'b'}]);
  assert.ok(!JSON.stringify(preview).includes('Private'));
});

test('OAuth redirect validation permits only the Google authorization endpoint',()=>{
  assert.ok(safeGoogleAuthorizeUrl('https://accounts.google.com/o/oauth2/v2/auth?state=test'));
  for(const value of ['https://evil.test/o/oauth2/v2/auth','https://accounts.google.com.evil.test/o/oauth2/v2/auth','https://user@accounts.google.com/o/oauth2/v2/auth','http://accounts.google.com/o/oauth2/v2/auth','https://accounts.google.com/redirect','javascript:alert(1)'])assert.equal(safeGoogleAuthorizeUrl(value),null);
});

test('actions preserve tenant boundary, reject Reef before fetch and use same-origin JSON',async()=>{
  let called=0;
  const fetcher=async(url,options)=>{
    called++;
    assert.equal(url,'/api/tenant/google-ads/select');
    assert.equal(options.credentials,'same-origin');
    assert.deepEqual(JSON.parse(options.body),{tenantSlug:'demo',accountId:'123'});
    return new Response(JSON.stringify({ok:true}));
  };
  await requestGoogleAction({name:'select',slug:'demo',payload:{tenantSlug:'other',accountId:'123'},fetcher});
  await assert.rejects(requestGoogleAction({name:'select',slug:'reefskills',fetcher}),/protected_tenant/);
  await assert.rejects(requestGoogleAction({name:'select',slug:'reefskills',fetcher}),/protected_tenant/);
  assert.equal(called,1);
});

test('provider errors propagate safe codes and invalid authorization URLs fail closed',async()=>{
  await assert.rejects(requestGoogleAction({name:'sync',slug:'demo',fetcher:async()=>new Response(JSON.stringify({error:'reauth_required'}),{status:401})}),/reauth_required/);
  await assert.rejects(requestGoogleAction({name:'start',slug:'demo',fetcher:async()=>new Response(JSON.stringify({authorizeUrl:'https://evil.test/'}))}),/request_rejected/);
});

test('the separate Google page protects Reef before Google reads and has no Meta dependencies',()=>{
  const page=readFileSync(new URL('../app/tenant/[slug]/reports/google-ads/page.js',import.meta.url),'utf8');
  const component=readFileSync(new URL('../components/google-ads-connect.js',import.meta.url),'utf8');
  assert.ok(page.indexOf("['reefskills','reefskills'].includes(slug.toLowerCase())")<page.indexOf("authRpc('v1_tenant_google_ads_snapshot'"));
  assert.doesNotMatch(page+component,/lib\/social|components\/social|api\/tenant\/social/);
});
