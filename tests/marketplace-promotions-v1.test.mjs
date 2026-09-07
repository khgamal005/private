import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=path=>readFileSync(join(root,path),'utf8');
const migration=read(
  'supabase/migrations/20260905001500_marketplace_promotions_v1.sql'
);
const addonRoute=read('app/api/tenant/marketplace-v2/route.js');
const serviceRoute=read('app/api/tenant/service-marketplace/route.js');
const addonStore=read('components/marketplace-addon-store-v2.js');
const serviceStore=read('components/marketplace-store.js');
const promoControl=read('components/marketplace-promo-code.js');
const platformUi=read('components/platform-promotions.js');
const platformRoute=read('app/api/platform/promotions/route.js');
const platformPage=read('app/control/promotions/page.js');
const shell=read('components/workspace-shell.js');

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function sqlFunction(text,qualifiedName){
  const start=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i'
  ).exec(text);
  assert.ok(start,`Missing SQL function ${qualifiedName}`);
  const tail=text.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated SQL function ${qualifiedName}`);
  return tail.slice(0,body.index+body[0].length);
}

test('promotion ledger is RPC-only and money-bound to marketplace orders',()=>{
  assert.match(migration,/create table if not exists marketplace\.promotions/i);
  assert.match(migration,/create table if not exists marketplace\.promotion_redemptions/i);
  assert.match(migration,/add column if not exists list_subtotal_minor bigint/i);
  assert.match(migration,/add column if not exists discount_minor bigint not null default 0/i);
  assert.match(migration,/orders_promotion_pricing_integrity_v1/i);
  assert.match(migration,/discount_minor = list_subtotal_minor - subtotal_minor/i);
  assert.match(migration,/alter table marketplace\.promotions force row level security/i);
  assert.match(migration,/alter table marketplace\.promotion_redemptions force row level security/i);
  assert.match(migration,/revoke all on marketplace\.promotions from public,anon,authenticated/i);
  assert.match(migration,/revoke all on marketplace\.promotion_redemptions from public,anon,authenticated/i);
  assert.match(migration,/promotion_redemptions_one_open_per_order_idx/i);
  assert.match(migration,/where status in \('reserved','redeemed'\)/i);
  assert.match(migration,/discount_minor > 0 and discount_minor < base_subtotal_minor/i);
  assert.match(migration,/total_minor_after bigint not null check \(total_minor_after > 0\)/i);
});

test('promotion calculation, limits and reservation are server-side and atomic',()=>{
  const apply=sqlFunction(migration,'private_app.marketplace_apply_promotion_v1');
  assert.match(apply,/pg_advisory_xact_lock\(hashtextextended\('promotion:order:'/i);
  assert.match(apply,/pg_advisory_xact_lock\(hashtextextended\('promotion:code:'/i);
  assert.match(apply,/for update/i);
  assert.match(apply,/marketplace_promotion_attempt_active/i);
  assert.match(apply,/marketplace_promotion_transfer_active/i);
  assert.match(apply,/total_redemption_limit/i);
  assert.match(apply,/per_tenant_limit/i);
  assert.match(apply,/budget_minor/i);
  assert.match(apply,/first_purchase_only/i);
  assert.match(apply,/applicable_order_kinds/i);
  assert.match(apply,/applicable_product_keys/i);
  assert.match(apply,/applicable_tenant_ids/i);
  assert.match(apply,/applicable_payment_providers/i);
  assert.match(apply,/v_discount := least\(v_discount,v_base_subtotal - 1\)/i);
  assert.match(apply,/v_tax := round\(v_net_subtotal \* v_order\.tax_rate_bps \/ 10000\.0\)/i);
  assert.match(apply,/insert into marketplace\.promotion_redemptions/i);
  assert.match(apply,/marketplace\.promotion\.reserved/i);
  assert.doesNotMatch(apply,/p_payload[^\n]*(?:discount|subtotal|total|tax)/i);
});

test('Paymob gets a net provider item while list-price snapshots remain auditable',()=>{
  assert.match(migration,/ODEIR_PROMOTION_NET_PROVIDER_ITEMS_V1/);
  assert.match(migration,/'amount',v_order\.subtotal_minor/i);
  assert.match(migration,/'description','ODEIR_PROMOTION_NET_SUBTOTAL'/i);
  assert.equal(
    [...migration.matchAll(/\) <> v_attempt\.subtotal_minor \+ v_order\.discount_minor then/g)].length,
    4
  );
  assert.match(migration,/promotion_paymob_items_patch_target_/i);
  assert.match(migration,/promotion_paymob_prepare_snapshot_patch_target_/i);
  assert.match(migration,/promotion_paymob_settlement_snapshot_patch_target_/i);
  assert.match(migration,/promotion_paymob_compatibility_postcondition_failed/i);
});

test('Paymob attempt and signed order settlement bind the promotion exactly once',()=>{
  const guard=sqlFunction(
    migration,'private_app.marketplace_promotion_payment_attempt_guard_v1'
  );
  const settle=sqlFunction(
    migration,'private_app.marketplace_promotion_payment_settlement_v1'
  );
  assert.match(guard,/new\.amount_minor <> v_order\.total_minor/i);
  assert.match(guard,/redemption\.status in \('reserved','redeemed'\)/i);
  assert.match(guard,/v_order\.payment_status not in \('paid','refunded'\)/i);
  assert.match(guard,/new\.status not in \('paid','refunded'\)/i);
  assert.match(guard,/marketplace_promotion_attempt_active\(v_order\.id\)/i);
  assert.match(settle,/new\.payment_status = 'paid'/i);
  assert.match(settle,/v_redemption\.status <> 'reserved'/i);
  assert.match(settle,/status = 'redeemed',redeemed_at = now\(\)/i);
  assert.match(settle,/promotion_payment_binding_mismatch/i);
  assert.match(migration,/before insert or update of status,amount_minor,currency/i);
  assert.match(migration,/before update of payment_status on marketplace\.orders/i);
});

test('bank transfer, expiry and cancellation release or consume one active reservation safely',()=>{
  const release=sqlFunction(
    migration,'private_app.marketplace_release_expired_promotions_v1'
  );
  const transfer=sqlFunction(
    migration,'private_app.marketplace_promotion_transfer_guard_v1'
  );
  const payload=sqlFunction(migration,'private_app.marketplace_order_payload');
  assert.match(release,/for update of redemption,orders skip locked/i);
  assert.match(release,/not private_app\.marketplace_promotion_attempt_active/i);
  assert.match(release,/not private_app\.marketplace_promotion_transfer_active/i);
  assert.match(release,/release_reason = 'reservation_expired'/i);
  assert.match(transfer,/redemption\.status = 'reserved'/i);
  assert.match(transfer,/order by redemption\.created_at desc/i);
  assert.match(transfer,/limit 1/i);
  assert.match(transfer,/payment_provider_snapshot is distinct from 'bank_transfer'/i);
  assert.match(payload,/redemption\.status in \('reserved','redeemed'\)/i);
  assert.match(payload,/order by redemption\.created_at desc/i);
  assert.match(payload,/limit 1/i);
  assert.match(migration,/release_reason = 'order_cancelled'/i);
});

test('existing order/payment functions are patched additively, not renamed or replaced by client money',()=>{
  assert.match(migration,/pg_get_functiondef\(\s*'public\.v1_tenant_paymob_prepare_checkout/i);
  assert.match(migration,/pg_get_functiondef\(\s*'private_app\.paymob_apply_paid_attempt_v1/i);
  assert.doesNotMatch(migration,/rename to .*promotion_legacy/i);
  assert.match(migration,/public\.v1_tenant_marketplace_create_order_with_promotion/i);
  assert.match(migration,/public\.v1_tenant_service_marketplace_create_order_with_promotion/i);
  assert.match(migration,/public\.v1_tenant_marketplace_promotion_action/i);
  assert.match(migration,/p_payload - 'promotionCode'/i);
});

test('one authorized platform operator manages campaigns without a second approver',()=>{
  const manage=sqlFunction(
    migration,'public.v1_platform_marketplace_promotion_action'
  );
  assert.match(manage,/private_app\.has_platform_permission\('platform\.billing\.manage'\)/i);
  assert.match(manage,/private_app\.current_subject_id\(\)/i);
  assert.match(manage,/marketplace\.promotion\.saved/i);
  assert.match(manage,/marketplace\.promotion\.status_changed/i);
  assert.match(manage,/'singleAuthorizedOperator',true/i);
  assert.doesNotMatch(manage,/checker|required[^\n]*approv|second[^\n]*operator/i);
  assert.match(platformUi,/تنفيذ مباشر للمستخدم المخوّل/);
  assert.doesNotMatch(platformUi,/طلب اعتماد|اعتماد مسؤول آخر|مراجع مختلف/);
});

test('tenant API routes select only the additive promotion RPCs',()=>{
  assert.match(addonRoute,/function promotionRpc\(body\)/);
  assert.match(addonRoute,/v1_tenant_marketplace_promotion_action/);
  assert.match(addonRoute,/v1_tenant_marketplace_create_order_with_promotion/);
  assert.match(addonRoute,/body:JSON\.stringify\(rpcRequest\.body\)/);
  assert.match(serviceRoute,/function promotionRpc\(body\)/);
  assert.match(serviceRoute,/v1_tenant_marketplace_promotion_action/);
  assert.match(serviceRoute,/v1_tenant_service_marketplace_create_order_with_promotion/);
  assert.match(serviceRoute,/body:JSON\.stringify\(rpcRequest\.body\)/);
  assert.match(serviceRoute,/submit_bank_transfer/);
});

test('service checkout keeps promotions while independent add-ons reject them',()=>{
  assert.match(addonStore,/promotionsEnabled=false/);
  assert.match(addonStore,/billingInterval:checkout.item.selectedCycle/);
  assert.doesNotMatch(addonStore,/promotionCode:checkoutPromotionCode/);
  for(const source of [serviceStore]){
    assert.match(source,/promotionCode:checkoutPromotionCode\.trim\(\)\|\|undefined/);
    assert.match(source,/MarketplacePromoCode/);
    assert.match(source,/apply_promotion/);
    assert.match(source,/remove_promotion/);
    assert.match(source,/promotionsEnabled=slug!=='reef-skills'/);
    assert.doesNotMatch(source,/promotionCode[^\n]*(?:discountMinor|totalMinor|subtotalMinor)/i);
  }
  assert.match(promoControl,/السعر قبل الخصم/);
  assert.match(promoControl,/الإجمالي المستحق/);
  assert.match(promoControl,/يُفحص الرمز ويُحسب السعر داخل أودير/);
});

test('platform promotion API binds CSRF validation to the canonical public origin',()=>{
  assert.match(platformRoute,/sameOrigin\(request\)/);
  assert.match(platformRoute,/publicAppOrigin/);
  assert.match(platformRoute,/if\(!origin\)return false/);
  assert.match(platformRoute,/site&&site!=='same-origin'/);
  assert.match(platformRoute,/source\.origin===publicAppOrigin\(\)/);
  assert.doesNotMatch(platformRoute,/x-forwarded-host|x-forwarded-proto/);
  assert.doesNotMatch(platformRoute,/function requestOrigin\(request\)/);
  assert.doesNotMatch(
    platformRoute,
    /new URL\(origin\)\.origin\s*===\s*new URL\(request\.url\)\.origin/
  );
  assert.match(platformRoute,/MAX_REQUEST_BYTES=48\*1024/);
  assert.match(platformRoute,/readTextLimited/);
  assert.match(platformRoute,/AbortSignal\.timeout\(RPC_TIMEOUT_MS\)/);
  assert.match(platformRoute,/v1_platform_marketplace_promotion_action/);
  assert.match(platformRoute,/Cache-Control':'private, no-store, no-cache/i);
  assert.doesNotMatch(platformRoute,/service_role|SUPABASE_SERVICE_ROLE/i);
  assert.match(platformPage,/requirePlatformPermission\('platform\.billing\.manage'\)/);
});

test('promotion management is visible in platform navigation and scheduled for cleanup',()=>{
  assert.match(shell,/key:'promotions',label:'العروض والبرومو كود',href:'\/control\/promotions'/);
  assert.match(shell,/catalog:\['\/plans','\/addons','\/services','\/promotions'\]/);
  assert.match(platformPage,/PlatformPromotions/);
  assert.match(migration,/marketplace-promotion-reservation-cleanup-v1/);
  assert.match(migration,/'\*\/5 \* \* \* \*'/);
  assert.match(migration,/marketplace_release_expired_promotions_v1\(200\)/);
});
