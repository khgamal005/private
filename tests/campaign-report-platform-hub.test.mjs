import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const ROOT=process.cwd();
const read=path=>readFileSync(resolve(ROOT,path),'utf8');
const nav=read('components/campaign-report-platform-nav.js');
const campaignPage=read('app/tenant/[slug]/reports/campaigns/page.js');
const reportingCenter=read('components/reporting-center.js');
const revenueReport=read('components/campaign-revenue-report.js');
const googleReport=read('components/google-ads-connect.js');

test('campaign report hub exposes one overview and expandable platform destinations',()=>{
  for(const key of ['overview','meta','google','snapchat','tiktok']){
    assert.match(nav,new RegExp(`key:'${key}'`));
  }
  assert.match(nav,/route:'google-ads'/);
  assert.match(nav,/platform:'meta'/);
  assert.match(nav,/upcoming:true/);
  assert.match(nav,/aria-current=/);
  assert.match(nav,/aria-disabled="true"/);
});

test('overview and Meta views stay separate while preserving tenant permissions',()=>{
  assert.match(campaignPage,/if\(!canReports&&!canMeta\)/);
  assert.match(campaignPage,/const platform=canReports&&query\.platform!=='meta'\?'overview':'meta'/);
  assert.match(campaignPage,/if\(platform==='meta'\)/);
  assert.match(campaignPage,/navigation=\{navigation\}/);
  assert.match(campaignPage,/campaignNavigation=\{navigation\}/);
  assert.doesNotMatch(campaignPage,/<ReportingCenter[^;]+\/>\}\{social\}/);
});

test('both unified report variants and Google Kit render the shared navigation',()=>{
  assert.match(reportingCenter,/view==='campaigns'\?campaignNavigation:null/);
  assert.match(revenueReport,/\{navigation\}\s*<form/);
  assert.match(googleReport,/CampaignReportPlatformNav/);
  assert.match(googleReport,/active="google"/);
});

test('report hub is display-only and introduces no tenant data mutations',()=>{
  assert.doesNotMatch(nav,/reef-skills/i);
  assert.doesNotMatch(nav,/fetch\(|authRpc|supabase|insert\(|update\(|delete\(/i);
});
