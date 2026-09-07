import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeSocialReportQuery,socialReportHref} from '../lib/social-connect-report.mjs';

const now=new Date('2026-09-06T18:00:00Z');

test('report query defaults to 30 days and accepts a bounded custom range',()=>{
  assert.deepEqual(normalizeSocialReportQuery({},now),{
    dateFrom:'2026-08-08',dateTo:'2026-09-06',status:'all',campaign:'',
    search:'',page:1,pageSize:25,today:'2026-09-06'
  });
  const filters=normalizeSocialReportQuery({
    from:'2026-07-01',to:'2026-09-01',status:'paused',
    campaign:'61000000-0000-4000-8000-000000000001',q:'  إعلان صيفي  ',page:'3'
  },now);
  assert.equal(filters.dateFrom,'2026-07-01');
  assert.equal(filters.dateTo,'2026-09-01');
  assert.equal(filters.status,'paused');
  assert.equal(filters.search,'إعلان صيفي');
  assert.equal(filters.page,3);
});

test('report query rejects future, malformed, and overlong ranges safely',()=>{
  const future=normalizeSocialReportQuery({from:'2026-01-01',to:'2027-01-01'},now);
  assert.equal(future.dateTo,'2026-09-06');
  assert.equal(future.dateFrom,'2026-08-08');
  const invalid=normalizeSocialReportQuery({from:'2026-02-30',to:'2026-09-01',status:'deleted'},now);
  assert.equal(invalid.dateFrom,'2026-08-03');
  assert.equal(invalid.status,'all');
});

test('report links preserve filters and change only requested pagination',()=>{
  const href=socialReportHref('demo-center',{
    dateFrom:'2026-09-01',dateTo:'2026-09-06',search:'needle',
    campaign:'61000000-0000-4000-8000-000000000001',status:'active',page:1
  },{page:2});
  const url=new URL(href,'https://odeir.com');
  assert.equal(url.pathname,'/tenant/demo-center/reports/campaigns');
  assert.equal(url.searchParams.get('q'),'needle');
  assert.equal(url.searchParams.get('page'),'2');
  assert.equal(url.searchParams.get('status'),'active');
});
