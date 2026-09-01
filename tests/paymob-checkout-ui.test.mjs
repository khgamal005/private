import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const paths={
  checkoutRoute:'app/api/payments/paymob/checkout/route.js',
  statusRoute:'app/api/payments/paymob/status/route.js',
  returnPage:'app/tenant/[slug]/payments/paymob/return/page.js',
  returnClient:'components/paymob-return-status.js',
  addons:'components/marketplace-addon-store-v2.js',
  services:'components/marketplace-store.js',
  tenantRoute:'app/api/tenant/[action]/route.js',
  marketplaceV2Route:'app/api/tenant/marketplace-v2/route.js',
  workspaceShell:'components/workspace-shell.js',
  addonsPage:'app/tenant/[slug]/addons-store/page.js',
  servicesPage:'app/tenant/[slug]/services-store/page.js'
};

const entries=await Promise.all(Object.entries(paths).map(async([key,path])=>[
  key,
  await readFile(new URL(path,root),'utf8')
]));
const source=Object.fromEntries(entries);

test('Paymob checkout stays server-authenticated and only returns an allowlisted redirect',()=>{
  assert.match(source.checkoutRoute,/cookies\(\)[\s\S]*?ACCESS_COOKIE/);
  assert.match(source.checkoutRoute,/\/functions\/v1\/paymob-checkout/);
  assert.match(source.checkoutRoute,/Authorization:`Bearer \$\{token\}`/);
  assert.match(source.checkoutRoute,/billingContact:\{firstName,lastName,email,phoneNumber\}/);
  assert.match(source.checkoutRoute,/PAYMOB_CHECKOUT_HOST='ksa\.checkout\.paymob\.com'/);
  assert.match(source.checkoutRoute,/url\.protocol!==['"]https:['"]/);
  assert.match(source.checkoutRoute,/url\.hostname!==PAYMOB_CHECKOUT_HOST/);
  assert.match(source.checkoutRoute,/url\.port/);
  assert.match(source.checkoutRoute,/safeErrorCode\(/);
  assert.match(source.checkoutRoute,/Cache-Control['"]?:['"]private, no-store/);
  assert.doesNotMatch(source.checkoutRoute,/SUPABASE_(?:SERVICE_ROLE|SECRET)_KEY/);
  assert.doesNotMatch(source.checkoutRoute,/NEXT_PUBLIC_[A-Z0-9_]*(?:SECRET|PRIVATE)/);
  assert.doesNotMatch(source.checkoutRoute,/activation|activate_addon|record_payment/i);
  for(const text of [source.checkoutRoute,source.statusRoute]){
    assert.match(text,/request\.body\.getReader\(\)/);
    assert.match(text,/bytes\+=value\.byteLength/);
    assert.match(text,/bytes>maxBytes[\s\S]*?reader\.cancel/);
    assert.doesNotMatch(text,/request\.(?:text|json)\(\)/);
  }
});

test('both stores create an order once, initialize Paymob, and preserve unknown outcomes',()=>{
  for(const [name,text] of [['addons',source.addons],['services',source.services]]){
    assert.match(text,/paymentRequestKey:(?:requestKey|idempotencyKey)\(\)/,`${name} needs a stable checkout key`);
    assert.match(text,/if\(!checkout\|\|busy/,`${name} must reject double submit`);
    assert.match(text,/paymentProvider===['"]paymob['"][\s\S]*?redirectToPaymob\(/,`${name} must initialize Paymob after order creation`);
    assert.match(text,/fetch\(['"]\/api\/payments\/paymob\/checkout['"]/,`${name} must use the server checkout route`);
    assert.match(text,/window\.location\.assign\(checkoutUrl\)/,`${name} must only leave for the returned checkout URL`);
    assert.match(text,/response\.status===202&&result\.attemptId[\s\S]*?payments\/paymob\/return/,`${name} must poll an ambiguous existing attempt`);
    assert.match(text,/paymentProvider===['"]paymob['"][\s\S]*?استكمال الدفع/,`${name} must expose pending Paymob orders`);
    assert.match(text,/disabled=\{Boolean\(busy\)\}/,`${name} must disable retry while busy`);
    assert.match(text,/order\?\.paymentProvider===['"]paymob['"][\s\S]*?لا يمكن إلغاء طلب Paymob/,`${name} must guard its cancel handler`);
    assert.match(text,/order\.status===['"]pending_payment['"]&&order\.paymentProvider!==['"]paymob['"]&&<button/,`${name} must hide generic cancellation for Paymob`);
    assert.match(text,/لا تبدأ دفعة أخرى[\s\S]*?تواصل مع الدعم برقم الطلب/,`${name} must explain reconciliation and support`);
  }
});

test('billing UI asks only for identity/contact data and validates Saudi mobile formats',()=>{
  for(const text of [source.addons,source.services]){
    for(const field of ['given-name','family-name','email','tel']){
      assert.match(text,new RegExp(`(?:autoComplete|type)=["']${field}["']`));
    }
    assert.match(text,/pattern="\(\?:\[\+\]9665\[0-9\]\{8\}\|05\[0-9\]\{8\}\)"/);
    assert.match(text,/type="checkbox" required/);
    assert.match(text,/إرسال بيانات الفاتورة أعلاه إلى Paymob/);
    assert.match(text,/تُدخل بيانات البطاقة داخل صفحة Paymob فقط/);
    assert.doesNotMatch(text,/name=["'](?:card|cardNumber|cvv|cvc|expiry)["']/i);
  }
  assert.match(source.checkoutRoute,/^\s*if\(\/\^05\[0-9\]\{8\}\$\/\.test\(normalized\)\)/m);
  assert.match(source.checkoutRoute,/return `\+966\$\{normalized\.slice\(1\)\}`/);
});

test('return page is display-only and trusts server status rather than redirect query flags',()=>{
  assert.match(source.returnPage,/requireTenantPermission\(slug,'tenant\.settings\.manage'\)/);
  assert.match(source.returnClient,/fetch\(['"]\/api\/payments\/paymob\/status['"]/);
  assert.match(source.returnClient,/result\.paymentStatus===['"]paid['"]/);
  assert.doesNotMatch(source.returnClient,/paymentStatus===['"]paid['"]\s*\|\|/);
  assert.match(source.returnClient,/result\.attemptStatus===['"]quarantined['"][\s\S]*?setPhase\(['"]review['"]\)/);
  assert.match(source.returnClient,/result\.terminal===true/);
  assert.match(source.returnClient,/MAX_AUTOMATIC_CHECKS/);
  assert.match(source.returnClient,/boundedFetchSignal\(controller\.signal,10000\)/);
  assert.match(source.returnClient,/new AbortController\(\)[\s\S]*?setTimeout\([\s\S]*?controller\.abort/);
  assert.match(source.returnClient,/العودة وحدها لا تعني نجاح الدفع/);
  assert.match(source.returnClient,/صفحة العودة لا تعتمد الدفع ولا تفعّل إضافة أو خدمة/);
  assert.doesNotMatch(source.returnClient,/searchParams|success=true|pending=false/);
  assert.doesNotMatch(source.returnClient,/activate|record_payment|create_order|create_service_order/i);
  assert.doesNotMatch(source.returnClient,/v1_(?:service_)?paymob_(?:ingest|settle|record)|marketplace_record_payment/i);
  assert.match(source.statusRoute,/v1_tenant_paymob_checkout_status/);
  assert.match(source.statusRoute,/p_slug:slug,p_attempt_id:attemptId/);
  assert.match(source.statusRoute,/safeErrorCode\(/);
  const attemptStatuses=/const ATTEMPT_STATUSES=new Set\(\[([\s\S]*?)\]\);/.exec(source.statusRoute)?.[1]||'';
  for(const status of ['prepared','creating_intention','intention_created','pending','paid','failed','unknown','quarantined','refunded','cancelled']){
    assert.match(attemptStatuses,new RegExp(`['"]${status}['"]`));
  }
  assert.doesNotMatch(attemptStatuses,/['"](?:preparing|ready)['"]/);
  assert.doesNotMatch(source.statusRoute,/service_role|activation|activate_addon/i);
  assert.doesNotMatch(source.statusRoute,/v1_(?:service_)?paymob_(?:ingest|settle|record)|marketplace_record_payment/i);
});

test('service orders expose their payment method and complete bank-transfer evidence',()=>{
  assert.match(source.services,/طريقة الدفع/);
  assert.match(source.services,/paymentProviderName\(order\.paymentProvider,paymentMethods\)/);
  assert.match(source.services,/p_action:'submit_bank_transfer'/);
  assert.match(source.services,/senderName[\s\S]*?transferReference[\s\S]*?transferDate/);
  assert.match(source.services,/إثبات التحويل البنكي للخدمة/);
  assert.match(source.tenantRoute,/action===['"]service-marketplace['"][\s\S]*?body\?\.p_action===['"]submit_bank_transfer['"][\s\S]*?rpc=['"]v2_tenant_marketplace_action['"]/);
  assert.match(source.tenantRoute,/paymob_order_cancel_requires_payment_resolution/);
  assert.match(source.marketplaceV2Route,/paymob_order_cancel_requires_payment_resolution/);
  assert.match(source.services,/pricingMode===['"]from['"]&&!packageId/);
  assert.match(source.services,/needsQuote=isQuote\|\|\(item\.pricingMode===['"]from['"]&&!featuredPackage\)/);
  assert.match(source.services,/لن يُنشأ طلب دفع إلكتروني قبل تثبيت السعر/);
});

test('store, checkout status, and return access share the canonical purchase permission',()=>{
  for(const text of [source.addonsPage,source.servicesPage,source.returnPage]){
    assert.match(text,/requireTenantPermission\(slug,'tenant\.settings\.manage'\)/);
    assert.doesNotMatch(text,/tenant\.users\.manage/);
  }
  assert.match(source.workspaceShell,/key:'addonsStore'[\s\S]{0,160}?permission:'tenant\.settings\.manage'/);
  assert.match(source.workspaceShell,/key:'servicesStore'[\s\S]{0,160}?permission:'tenant\.settings\.manage'/);
  assert.doesNotMatch(source.workspaceShell,/key:'(?:addonsStore|servicesStore)'[\s\S]{0,160}?permission:'tenant\.users\.manage'/);
});
