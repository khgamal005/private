import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {billingCycle,pricedAddon,quotedTotals,assertIndependentOrderPayload} from '../lib/commerce/independent-pricing.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
const catalog=JSON.parse(await read('../lib/commerce/approved-catalog.json'));
const sql=await read('../supabase/migrations/20260906232948_odeir_independent_commerce_v1.sql');
const T='10000000-0000-4000-8000-000000000001',O='10000000-0000-4000-8000-000000000002',R='10000000-0000-4000-8000-000000000003';
const keyFeature=key=>({whatsapp:'addon.integration.whatsapp',email:'addon.integration.email',templates:'addon.communication.templates',delivery_analytics:'addon.communication.delivery_analytics',social_connect:'addon.integrations.social_connect',marketing_attribution:'addon.marketing_attribution',cms_pro:'module.website_cms'}[key]||'addon.'+key);
async function database(){
 const db=new PGlite();
 await db.exec(await read('./fixtures/tamara-schema.sql'));
 await db.exec(await read('./fixtures/independent-commerce-schema.sql'));
 await db.query(`insert into core.tenants(id,organization_id,tenant_key,slug,name) values($1,$1,'test','test-center','Test'),($2,$2,'other','other-center','Other'),($3,$3,'reef','reef-skills','Protected fixture')`,[T,O,R]);
 await db.exec(`insert into catalog.plans(plan_key,name_ar) values('free','Legacy free'),('full','Legacy full');insert into catalog.subscriptions(tenant_id,plan_id,status) select '${R}',id,'active' from catalog.plans where plan_key='full';`);
 for(const key of [...catalog.addons.map(a=>a.key),'delivery_analytics','social_connect']){
  const f=(await db.query(`insert into catalog.features(feature_key,name_ar) values($1,$1) returning id`,[keyFeature(key)])).rows[0].id;
  await db.query(`insert into catalog.addon_products(product_key,feature_id,name_ar,description_ar,usage_metric,interval,amount_minor,status,pricing_mode) values($1,$2,$1,'old description','none','year',90000,'active','fixed')`,[key,f]);
  await db.query(`insert into catalog.plan_features(plan_id,feature_id,value) select id,$1,'true'::jsonb from catalog.plans where plan_key='full'`,[f]);
 }
 await db.exec(`insert into catalog.features(feature_key,name_ar) values('module.crm','CRM'),('limit.users','users'),('limit.courses','courses');`);
 await db.query(`select set_config('fixture.tenant',$1,false),set_config('fixture.admin','true',false)`,[T]);
 await db.exec(`insert into marketplace.payment_provider_configs(provider_key,name_ar,status,last_verified_at) values('bank_transfer','Bank','active',now()),('paymob','Paymob','active',now()),('tamara','Tamara','active',now());`);
 try{await db.exec(sql);}catch(error){console.error({message:error.message,position:error.position,internalPosition:error.internalPosition,internalQuery:error.internalQuery,where:error.where,context:sql.slice(Math.max(0,Number(error.position)-200),Number(error.position)+200)});await db.close();throw error;}
 return db;
}
async function fixture(fn){const db=await database();try{await fn(db);}finally{await db.close();}}
const payload=(key='salla',cycle='month',provider='bank_transfer',id=crypto.randomUUID())=>({itemType:'addon',productKey:key,quantity:1,billingInterval:cycle,paymentProvider:provider,idempotencyKey:id});
const create=async(db,p=payload(),slug='test-center')=>(await db.query(`select public.v4_tenant_independent_addon_order($1,$2) r`,[slug,p])).rows[0].r;
test('approved flat catalog has four independent core editions and sixteen individually priced products',()=>{
 assert.deepEqual(catalog.plans.map(x=>x.monthlyMinor),[0,7900,19900,49900]);
 assert.equal(catalog.addons.length,16);
 for(const x of [...catalog.plans,...catalog.addons])assert.equal(x.annualMinor,x.monthlyMinor*10);
 assert.equal(catalog.addons.find(x=>x.key==='templates').monthlyMinor,0);
 assert.throws(()=>billingCycle('weekly'));
 assert.equal(pricedAddon({amountMinor:29000},'month').quoteAvailable,false);
 assert.deepEqual(quotedTotals({amountMinor:3900}),{subtotal:3900,tax:585,total:4485});
 assert.throws(()=>assertIndependentOrderPayload({...payload(),promotionCode:'DISCOUNT'}));
});
test('migration executes in PostgreSQL, preserves legacy full/reef rights and has no bundled core add-ons',()=>fixture(async db=>{
 assert.equal((await db.query(`select count(*)::int n from catalog.independent_commercial_catalog_v1 where kind='core'`)).rows[0].n,4);
 assert.equal((await db.query(`select count(*)::int n from catalog.plan_features f join catalog.addon_products a on a.feature_id=f.feature_id join catalog.independent_commercial_catalog_v1 c on c.plan_id=f.plan_id`)).rows[0].n,0);
 const r=(await db.query(`select private_app.addon_entitlement_v3($1,'addon.integration.whatsapp') e`,[R])).rows[0].e;
 assert.equal(r.enabled,true);assert.equal(r.source,'plan');assert.equal(r.status,'included');
 assert.equal((await db.query(`select p.plan_key from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id where s.tenant_id=$1`,[R])).rows[0].plan_key,'full');
 const c=(await db.query(`select public.v1_public_independent_commercial_catalog() r`)).rows[0].r;
 assert.deepEqual(c.plans.map(x=>x.monthlyAmountMinor),[0,7900,19900,49900]);
}));
test('monthly and annual prices are server-calculated; every provider receives the chosen frozen term',()=>fixture(async db=>{
 for(const [key,cycle,provider] of [['salla','month','bank_transfer'],['zid','year','paymob'],['shopify','month','tamara']]){
  const o=await create(db,{...payload(key,cycle,provider),amountMinor:1,taxRateBps:0,planKey:'core_diamond'});
  assert.equal(o.totalMinor,cycle==='month'?3335:33350);
  const pm=(await db.query(`select public.v1_tenant_paymob_prepare_checkout('test-center',$1,'fixture','{}') r`,[o.id])).rows[0].r;
  const tm=(await db.query(`select public.v1_tenant_tamara_prepare('test-center',$1) r`,[o.id])).rows[0].r;
  const bank=(await db.query(`select private_app.marketplace_record_payment($1,'bank_transfer','evt','ref','paid',$2,'SAR',true,'hash',null) r`,[o.id,o.totalMinor])).rows[0].r;
  assert.equal(pm.billingInterval,cycle);assert.equal(tm.billing_interval,cycle);assert.equal(bank.months,cycle==='month'?1:12);
 }
}));
test('idempotency cannot change a quote cycle, product or payment provider and never reprices an old order',()=>fixture(async db=>{
 const p=payload(),first=await create(db,p);assert.equal((await create(db,p)).id,first.id);
 await assert.rejects(create(db,{...p,billingInterval:'year'}),/idempotency_conflict/);
 await assert.rejects(create(db,{...p,productKey:'zid'}),/idempotency_conflict/);
 await assert.rejects(create(db,{...p,paymentProvider:'tamara'}),/idempotency_conflict/);
 await db.exec(`update catalog.independent_commercial_catalog_v1 set monthly_amount_minor=5900,annual_amount_minor=59000 where kind='addon' and product_key='salla';`);
 assert.equal((await create(db,p)).totalMinor,3335);
 await assert.rejects(create(db,payload('salla','year')),/existing_addon_order_requires_resolution/);
 assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,1);
}));
test('unauthorized tenant, hidden product, invalid cycle, promotions and blocked providers cannot create orders',()=>fixture(async db=>{
 await assert.rejects(create(db,payload(),'other-center'),/forbidden/);
 await assert.rejects(create(db,{...payload(),billingInterval:'week'}),/invalid_billing_interval/);
 await assert.rejects(create(db,{...payload(),promotionCode:'FREE'}),/addon_promotions_not_available/);
 await assert.rejects(create(db,{...payload(),quantity:2}),/marketplace_quantity_invalid/);
 await db.exec(`update catalog.addon_products set is_marketplace_visible=false where product_key='salla';`);
 await assert.rejects(create(db,payload()),/marketplace_product_not_found/);
 await db.exec(`select set_config('fixture.provider','blocked',false);`);
 await assert.rejects(create(db,payload('zid','month','paymob')),/paymob_tenant_rollout_required/);
 assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,0);
}));
test('all old public creator entrypoints route new offers consistently; services remain on their legacy path',()=>fixture(async db=>{
 const p=payload('salla','month','tamara');
 const o=(await db.query(`select public.v1_tenant_tamara_create_order('test-center',$1) r`,[p])).rows[0].r;assert.equal(o.totalMinor,3335);
 for(const [fn,key] of [['v1_tenant_marketplace_action','zid'],['v2_tenant_marketplace_action','shopify']]){
  const r=(await db.query(`select public.${fn}('test-center','create_order',$1) r`,[payload(key)])).rows[0].r;assert.equal(r.totalMinor,3335);
 }
 assert.equal((await db.query(`select public.v2_tenant_marketplace_action('test-center','create_order','{"itemType":"service"}') r`)).rows[0].r.legacy,true);
 await assert.rejects(db.query(`select private_app.marketplace_apply_promotion_v1($1,$2,'DISCOUNT',null)`,[T,o.id]),/addon_promotions_not_available/);
}));
test('core edition assignment refuses Reef and never rewrites add-on licenses',()=>fixture(async db=>{
 const plan=(await db.query(`select id from catalog.plans where plan_key='core_basic'`)).rows[0].id;
 await assert.rejects(db.query(`select public.v5_platform_commerce_action('set_subscription',$1)`,[{tenantId:R,planId:plan,status:'active',billingInterval:'month'}]),/reef_contract_protected/);
 const p=(await db.query(`select id from catalog.addon_products where product_key='whatsapp'`)).rows[0].id;
 await db.query(`insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status,source,period_start,period_end) values($1,$2,'active','billing',now(),now()+interval '1 month')`,[T,p]);
 const before=(await db.query(`select to_jsonb(s) v from catalog.tenant_addon_subscriptions s where tenant_id=$1`,[T])).rows[0].v;
 await db.query(`select public.v5_platform_commerce_action('set_subscription',$1)`,[{tenantId:T,planId:plan,status:'active',billingInterval:'year'}]);
 assert.deepEqual((await db.query(`select to_jsonb(s) v from catalog.tenant_addon_subscriptions s where tenant_id=$1`,[T])).rows[0].v,before);
 assert.equal((await db.query(`select private_app.addon_entitlement_v3($1,'addon.communication.delivery_analytics') e`,[T])).rows[0].e.enabled,true);
 assert.equal((await db.query(`select private_app.addon_entitlement_v3($1,'addon.communication.templates') e`,[T])).rows[0].e.enabled,true);
}));
test('new free registrations target the new edition and old free/full catalog rows remain intact',()=>fixture(async db=>{
 const r=(await db.query(`select private_app.provision_tenant_core('n','n','new','SA','Asia/Riyadh','free','owner','fixture@example.invalid',null,'verified_email',null,'{}') r`)).rows[0].r;
 assert.equal(r.planKey,'core_free');
 assert.equal((await db.query(`select name_ar from catalog.plans where plan_key='free'`)).rows[0].name_ar,'Legacy free');
 await db.exec(`set role anon`);
 const c=(await db.query(`select public.v1_public_independent_commercial_catalog() r`)).rows[0].r;assert.equal(c.plans.length,4);
 await assert.rejects(db.query(`select * from catalog.independent_commerce_rollback_v1`),/permission denied/);
 await assert.rejects(db.query(`select public.v4_tenant_independent_addon_order('test-center','{}')`),/permission denied/);
}));

test('disabling sale cannot fall back to obsolete prices through old entrypoints',()=>fixture(async db=>{
 await db.exec(`update catalog.independent_commercial_catalog_v1 set published=false where kind='addon' and product_key='salla';`);
 for(const fn of ['v1_tenant_marketplace_action','v2_tenant_marketplace_action']){
  await assert.rejects(db.query(`select public.${fn}('test-center','create_order',$1)`,[payload()]),/marketplace_product_not_found/);
 }
 await assert.rejects(db.query(`select public.v1_tenant_tamara_create_order('test-center',$1)`,[payload('salla','month','tamara')]),/marketplace_product_not_found/);
 assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,0);
}));
test('legacy admin endpoint also protects Reef; Tamara does not sell over an unresolved old license',()=>fixture(async db=>{
 const plan=(await db.query(`select id from catalog.plans where plan_key='core_basic'`)).rows[0].id;
 await assert.rejects(db.query(`select public.v4_platform_commerce_action('set_subscription',$1)`,[{tenantId:R,planId:plan,status:'active',billingInterval:'year'}]),/reef_contract_protected/);
 await db.exec(`insert into catalog.tenant_addon_subscriptions(tenant_id,product_id,status,source,period_start,period_end) select '${T}',id,'active','billing',now()-interval '2 years',now()-interval '1 year' from catalog.addon_products where product_key='zid'`);
 await assert.rejects(create(db,payload('zid','month','tamara')),/tamara_existing_license_requires_resolution/);
 assert.equal((await db.query('select count(*)::int n from marketplace.orders')).rows[0].n,0);
}));

async function transitionFixture(fn){
 const db=await database();
 try{
  await db.exec(await read('./fixtures/core-transition-schema.sql'));
  await db.exec(`insert into platform.tenant_deletion_protections values('${R}','reef_live_tenant');
    insert into core.fixture_staff(tenant_id) select '${O}' from generate_series(1,7);
    insert into core.fixture_staff(tenant_id) select '${T}' from generate_series(1,2);
    insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
    select '${T}',id,'trialing','2026-08-01','2027-08-01' from catalog.plans where plan_key='free';
    insert into catalog.subscriptions(tenant_id,plan_id,status,period_start,period_end)
    select '${O}',id,'active','2026-08-01',null from catalog.plans where plan_key='full';`);
  const before=(await db.query(`select to_jsonb(s) row from catalog.subscriptions s where tenant_id=$1`,[R])).rows[0].row;
  await db.exec(await read('../supabase/migrations/20260907104357_odeir_core_transition_simplified_v1.sql'));
  assert.deepEqual((await db.query(`select to_jsonb(s) row from catalog.subscriptions s where tenant_id=$1`,[R])).rows[0].row,before);
  await fn(db);
 }finally{await db.close();}
}
test('current non-Reef tenants transition to BASIC without payments or period reset',()=>transitionFixture(async db=>{
 const rows=(await db.query(`select s.tenant_id,p.plan_key,s.period_end from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id order by tenant_id`)).rows;
 assert.deepEqual(rows.map(x=>x.plan_key),['core_basic','core_basic','full']);
 assert.match(new Date(rows[0].period_end).toISOString(),/2027-08-01/);assert.equal(rows[1].period_end,null);
 assert.equal((await db.query(`select count(*)::int n from marketplace.orders`)).rows[0].n,0);
 assert.equal((await db.query(`select sum(quoted_amount_minor)::int n from catalog.independent_core_subscription_terms_v1`)).rows[0].n,0);
 assert.equal((await db.query(`select count(*)::int n from catalog.core_transition_v1 where tenant_id=$1`,[R])).rows[0].n,0);
}));
test('existing seven-seat team and plan-derived add-ons survive BASIC while new tenants gain no bundled rights',()=>transitionFixture(async db=>{
 const limit=(await db.query(`select private_app.current_plan_limit($1,'max_employees') r`,[O])).rows[0].r;
 assert.equal(limit.limitValue,7);assert.equal(limit.preservedExistingStaff,true);
 assert.equal((await db.query(`select private_app.addon_entitlement_v3($1,'addon.integration.whatsapp') r`,[O])).rows[0].r.enabled,true);
 assert.equal((await db.query(`select private_app.addon_entitlement_v3($1,'addon.integration.whatsapp') r`,[T])).rows[0].r.enabled,false);
 assert.equal((await db.query(`select private_app.current_plan_limit($1,'max_employees') r`,[T])).rows[0].r.limitValue,5);
}));
test('FULL is absent from public offers, visible to admins, and Reef is protected through every core mutation',()=>transitionFixture(async db=>{
 const pub=(await db.query(`select public.v1_public_independent_commercial_catalog() r`)).rows[0].r;
 assert.equal(pub.plans.length,4);assert(!pub.plans.some(p=>p.key==='full'));
 const admin=(await db.query(`select public.v5_platform_commerce_snapshot() r`)).rows[0].r;
 assert.equal(admin.adminOnlyPlans[0].key,'full');assert.equal(admin.adminOnlyPlans[0].isPublic,false);
 const plan=(await db.query(`select id from catalog.plans where plan_key='core_basic'`)).rows[0].id;
 await assert.rejects(db.query(`select public.v2_platform_set_subscription($1,'core_basic')`,[R]),/reef_contract_protected/);
 await assert.rejects(db.query(`select public.v4_platform_commerce_action('set_subscription',$1)`,[{tenantId:R,planId:plan,status:'active'}]),/reef_contract_protected/);
 await assert.rejects(db.query(`update catalog.subscriptions set plan_id=$1 where tenant_id=$2`,[plan,R]),/reef_contract_protected/);
 await assert.rejects(db.query(`delete from catalog.subscriptions where tenant_id=$1`,[R]),/reef_contract_protected/);
 await assert.rejects(db.query(`update catalog.plans set amount_minor=10 where plan_key='full'`),/legacy_plan_contract_protected/);
 await assert.rejects(db.query(`update catalog.plan_features set value='false' where plan_id=(select id from catalog.plans where plan_key='full')`),/legacy_plan_contract_protected/);
}));
test('only an authorized administrator can assign internal FULL and public registration always starts FREE',()=>transitionFixture(async db=>{
 await db.exec(`select set_config('fixture.admin','false',false)`);
 await assert.rejects(db.query(`select public.v2_platform_set_subscription($1,'full')`,[T]),/forbidden/);
 const reg=(await db.query(`select private_app.provision_tenant_core('n','n','new','SA','Asia/Riyadh','full','owner','fixture@example.invalid',null,'verified_email',null,'{}') r`)).rows[0].r;
 assert.equal(reg.planKey,'core_free');
 await db.exec(`select set_config('fixture.admin','true',false)`);
 const full=(await db.query(`select public.v2_platform_set_subscription($1,'full') r`,[T])).rows[0].r;
 assert.equal(full.internalOnly,true);
 assert.equal((await db.query(`select p.plan_key from catalog.subscriptions s join catalog.plans p on p.id=s.plan_id where s.tenant_id=$1 and s.status='active'`,[T])).rows[0].plan_key,'full');
}));
