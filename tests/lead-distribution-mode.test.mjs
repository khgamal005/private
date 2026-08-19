import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);

async function source(path){
  return readFile(new URL(path,root),'utf8');
}

test('lead assignment strategies expose explicit automatic and manual modes',async()=>{
  const {
    leadDistributionMode,
    presentLeadAssignment
  }=await import('../lib/lead-distribution-mode.mjs');

  assert.deepEqual(leadDistributionMode('fair'),{
    key:'fair',
    mode:'auto',
    label:'تلقائي Auto',
    detail:'توزيع عادل على الفريق المتاح'
  });
  assert.equal(leadDistributionMode('online_only').mode,'auto');
  assert.equal(leadDistributionMode('selected').mode,'manual');
  assert.equal(leadDistributionMode('selected').label,'يدوي Manual');

  const presented=presentLeadAssignment({
    id:'assignment-1',
    strategy:'selected'
  });
  assert.equal(presented.id,'assignment-1');
  assert.equal(presented.strategyKey,'selected');
  assert.equal(presented.distributionMode,'manual');
  assert.equal(
    presented.strategy,
    '[يدوي Manual] — اختيار أو إعادة إسناد بواسطة المشرف'
  );
});

test('initial distribution log and full-record search use the same labels',async()=>{
  const [page,route]=await Promise.all([
    source('app/tenant/[slug]/lead-queue/page.js'),
    source('app/api/tenant/lead-assignment-search/route.js')
  ]);

  assert.match(page,/presentLeadAssignments\(initialData\.assignments\)/);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.leads\.read'\)/);
  assert.match(route,/v1_tenant_lead_assignment_search/);
  assert.match(route,/presentLeadAssignments\(data\?\.assignments\)/);
  assert.match(route,/cache:'no-store'/);
});
