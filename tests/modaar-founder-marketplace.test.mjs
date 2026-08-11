import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const files={
  core:resolve(ROOT,'supabase/migrations/20260811210000_modaar_founder_core.sql'),
  tenantFlow:resolve(ROOT,'supabase/migrations/20260811210100_marketplace_bank_transfer_v2.sql'),
  platformReview:resolve(ROOT,'supabase/migrations/20260811210200_platform_bank_transfer_review.sql'),
  prices:resolve(ROOT,'supabase/migrations/20260811210300_addon_launch_price_ladder.sql'),
  store:resolve(ROOT,'components/marketplace-addon-store-v2.js'),
  tenantRoute:resolve(ROOT,'app/api/tenant/marketplace-v2/route.js'),
  platformRoute:resolve(ROOT,'app/api/control/bank-transfers/route.js')
};
const source=Object.fromEntries(await Promise.all(Object.entries(files).map(async([key,path])=>[key,await readFile(path,'utf8')])));

function noDestructiveRows(sql){
  assert.doesNotMatch(sql,/\b(?:delete\s+from|truncate(?:\s+table)?|drop\s+(?:table|schema))\b/i);
}

test('founder center starts on the annual free core without add-ons',()=>{
  noDestructiveRows(source.core);
  assert.match(source.core,/plan_key='free'/);
  assert.match(source.core,/interval='year'/);
  assert.match(source.core,/period_end:=new\.period_start\+interval '1 year'/);
  assert.match(source.core,/slug='modaar-training-center'/);
  assert.match(source.core,/مركز مُدار النموذجي للتدريب/);
  assert.match(source.core,/modaar_founder_center_must_start_without_addons/);
  assert.match(source.core,/addonsInitiallyEnabled',false/);
  assert.match(source.core,/if v_owner_subject_id is not null then/);
  assert.doesNotMatch(source.core,/raise exception 'platform_owner_subject_not_found'/);
});

test('catalog supports a free add-on and paid annual range starting at SAR 400',()=>{
  assert.match(source.core,/product_key='templates'/);
  assert.match(source.core,/pricing_mode='free'/);
  assert.match(source.prices,/product_key='zoom'/);
  assert.match(source.prices,/40000/);
  assert.match(source.prices,/interval='year'/);
});

test('bank transfer is manual-review only and cannot directly activate an add-on',()=>{
  noDestructiveRows(source.tenantFlow);
  noDestructiveRows(source.platformReview);
  assert.match(source.core,/provider_key='bank_transfer'/);
  assert.match(source.core,/'manualReview',true/);
  assert.match(source.tenantFlow,/p_action='submit_bank_transfer'/);
  assert.match(source.tenantFlow,/status.*'pending'/s);
  assert.doesNotMatch(source.tenantFlow,/submit_bank_transfer[\s\S]*marketplace_record_payment/);
  assert.match(source.platformReview,/p_action='approve'/);
  assert.match(source.platformReview,/marketplace_record_payment/);
  assert.match(source.platformReview,/platform\.billing\.manage/);
});

test('tenant UI distinguishes free activation from paid bank transfer checkout',()=>{
  assert.match(source.store,/تفعيل مجانًا/);
  assert.match(source.store,/اشترك سنويًا/);
  assert.match(source.store,/submit_bank_transfer/);
  assert.match(source.store,/اسم المحوّل/);
  assert.match(source.store,/مرجع \/ رقم عملية التحويل/);
  assert.match(source.store,/لن تُفعّل الإضافة قبل مراجعته واعتماده/);
  assert.match(source.tenantRoute,/v2_tenant_marketplace_action/);
  assert.match(source.platformRoute,/v3_platform_bank_transfer_action/);
});
