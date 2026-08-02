import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('customer search uses real tenant data and optional Arabic filters',async()=>{
  const [
    component,
    page,
    route,
    migration,
    shell,
    api,
    salesPage,
    salesWorkspace
  ]=await Promise.all([
    read('components/customer-search.js'),
    read('app/tenant/[slug]/customer-search/page.js'),
    read('app/api/tenant/customer-search/route.js'),
    read('supabase/migrations/20260803010000_tenant_customer_search_v1.sql'),
    read('components/workspace-shell.js'),
    read('lib/api.js'),
    read('app/tenant/[slug]/sales/page.js'),
    read('components/sales-workspace.js')
  ]);

  assert.match(component,/البحث عن عميل/);
  assert.match(component,/رقم الجوال/);
  assert.match(component,/كل الحقول التالية اختيارية/);
  assert.match(component,/name="courseId"/);
  assert.match(component,/name="ownerStaffId"/);
  assert.match(component,/العميل موجود بالفعل/);
  assert.match(page,/requireTenantPermission\(slug,'tenant\.crm\.read'\)/);
  assert.match(route,/v2_tenant_customer_search/);
  assert.match(route,/p_phone/);
  assert.match(migration,/v2_tenant_customer_search/);
  assert.match(migration,/v_exact_phone_lookup/);
  assert.match(migration,/right\(v_phone_digits, 9\)/);
  assert.match(migration,/'restricted', not page\.can_open/);
  assert.match(migration,/private_app\.has_tenant_permission/);
  assert.match(migration,/revoke all on function public\.v2_tenant_customer_search/);
  assert.match(migration,/grant execute on function public\.v2_tenant_customer_search/);
  assert.match(shell,/label:'البحث عن عميل'/);
  assert.match(shell,/href:`\$\{base\}\/customer-search`/);
  assert.match(api,/getTenantCustomerSearch/);
  assert.match(api,/v2_tenant_customer_search/);
  assert.match(salesPage,/focusContactId/);
  assert.match(salesWorkspace,/contact=>contact\.id===focusContactId/);
});
