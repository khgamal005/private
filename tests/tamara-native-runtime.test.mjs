import assert from 'node:assert/strict';
import test from 'node:test';
import {minorUnits,money,verifiedOrder,checkoutUrl,verifiedNotification,boundedJson} from '../supabase/functions/_shared/tamara-protocol.mjs';
import {processClaim,makeProvider,validContact,selectPaymentType} from '../supabase/functions/_shared/tamara-runtime.mjs';
import {tamaraGateway} from '../lib/tamara-gateway.mjs';
const id='10000000-0000-4000-8000-000000000001',orderId='20000000-0000-4000-8000-000000000001';
const snapshot={id,amount_minor:11500,subtotal_minor:10000,tax_minor:1500,discount_minor:0,currency:'SAR',slug:'fixture',order_number:'TEST-1',items:[{id:orderId,quantity:1,line_total_minor:10000,product_name_ar:'إضافة',product_key:'fixture'}]};
const contact={firstName:'Test',lastName:'Buyer',phone:'+966500000000',email:'test@example.test',city:'Riyadh',address:'Fixture address'};
const body=status=>({order_id:orderId,order_reference_id:id,status,items:[{reference_id:orderId,sku:'fixture',quantity:1,total_amount:money(11500)}],total_amount:money(11500),captured_amount:money(status==='fully_captured'?11500:0),refunded_amount:money(0),canceled_amount:money(0)});
const baseClaim={id,claim_token:orderId,environment:'sandbox',apiToken:'fixture-token',status:'prepared',snapshot};

test('money parser refuses rounding, exponent, negative and invalid currencies',()=>{
 assert.equal(minorUnits('115.00'),11500);assert.deepEqual(money(11500),{amount:'115.00',currency:'SAR'});
 for(const value of ['1.001','1e2',NaN,-1,{},null,' 1','01'])assert.throws(()=>minorUnits(value));
 for(const bad of [{...body('approved'),total_amount:money(11499)},{...body('approved'),order_reference_id:orderId},{...body('approved'),items:[]},{...body('approved'),captured_amount:{amount:0,currency:'USD'}},{...body('fully_captured'),captured_amount:money(0)}])assert.throws(()=>verifiedOrder(bad,snapshot));
 assert.equal(verifiedOrder(body('authorised'),snapshot).capturedMinor,0);
});
test('checkout redirect pins environment and rejects credentials, ports and lookalikes',()=>{
 assert.ok(checkoutUrl('https://checkout-sandbox.tamara.co/checkout/test','sandbox'));
 for(const url of ['https://checkout.tamara.co.evil.test/x','http://checkout.tamara.co/x','https://attacker@checkout.tamara.co/x','https://checkout.tamara.co:444/x','javascript:alert(1)','https://checkout-sandbox.tamara.co/x'])assert.equal(checkoutUrl(url,'live'),null);
});
test('contact and merchant payment limits are verified before a checkout mutation',()=>{
 assert.deepEqual(validContact(contact),contact);assert.equal(validContact({...contact,phone:'500000000'}),null);
 assert.throws(()=>selectPaymentType([{name:'PAY_BY_INSTALMENTS',min_limit:200,max_limit:500}],11500));
 assert.deepEqual(selectPaymentType({payment_types:[{name:'PAY_BY_INSTALMENTS',min_limit:100,max_limit:500}]},11500),{name:'PAY_BY_INSTALMENTS'});
});
test('ambiguous create POST is never replayed on worker restart',async()=>{
 const mutations=[],paths=[];let saved;
 const rpc=async(name,args)=>{mutations.push([name,args]);if(name==='v1_service_tamara_mutation')return true;if(name==='v1_service_tamara_release')saved=args;};
 const provider=async(c,path)=>{paths.push(path);if(path.includes('payment-types'))return [{name:'PAY_BY_INSTALMENTS',min_limit:1,max_limit:1000}];throw new Error('connection_lost_after_acceptance');};
 await processClaim(baseClaim,{rpc,provider,contact});
 assert.equal(paths.filter(x=>x==='/checkout').length,1);assert.equal(saved.p_error_code,'tamara_reconciliation_pending');
 await processClaim({...baseClaim,status:'creating',create_started_at:'2026-01-01'},{rpc,provider});
 assert.equal(paths.filter(x=>x==='/checkout').length,1);assert.ok(paths.includes(`/merchants/orders/reference-id/${id}`));
 assert.equal(mutations.filter(([n])=>n==='v1_service_tamara_mutation').length,1);
});
test('capture requires persisted delivery and its mutation claim',async()=>{
 let posts=0;const rpc=async name=>name==='v1_service_tamara_observe'?{status:'provisioned',provisioned_at:'2026-01-01T00:00:00Z'}:name==='v1_service_tamara_mutation'?false:true;
 await processClaim({...baseClaim,status:'provisioned',provider_order_id:orderId,checkout_payload:{items:[]}},{rpc,provider:async(c,path,payload)=>{if(payload)posts++;return body('authorised');}});
 assert.equal(posts,0);
});
test('approved return or notification never directly marks an order paid',async()=>{
 const calls=[];await processClaim({...baseClaim,status:'pending',provider_order_id:orderId},{rpc:async(name,args)=>{calls.push([name,args]);return name==='v1_service_tamara_observe'?{status:'approved'}:true;},provider:async(c,path)=>path.includes('authorise')?{}:body('approved')});
 assert.equal(calls.find(([n])=>n==='v1_service_tamara_observe')[1].p_evidence.status,'approved');
 assert.equal(calls.find(([n])=>n==='v1_service_tamara_mutation')[1].p_operation,'authorise');
});
test('webhook JWT rejects forgery, wrong key, expiry and algorithm confusion',async()=>{
 const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
 const sign=async(header,claims)=>{const text=`${encode(header)}.${encode(claims)}`;const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('fixture-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);return `${text}.${Buffer.from(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(text))).toString('base64url')}`;};
 const now=Date.now(),claims={iss:'Tamara',exp:Math.floor(now/1000)+300};
 const token=await sign({alg:'HS256',typ:'JWT'},claims);assert.equal(await verifiedNotification(token,'fixture-secret',now),true);
 assert.equal(await verifiedNotification(token,'wrong',now),false);
 assert.equal(await verifiedNotification(token,'fixture-secret',now+600000),false);
 assert.equal(await verifiedNotification(await sign({alg:'none'},claims),'fixture-secret',now),false);
 assert.equal(await verifiedNotification(await sign({alg:'HS256'},{...claims,nbf:claims.exp}),'fixture-secret',now),false);
});
test('bounded reads reject oversized and stalled bodies',async()=>{
 await assert.rejects(boundedJson(new Response('x'.repeat(100)),20));
 const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}});
 await assert.rejects(boundedJson(new Response(stream),100,20),/timeout/);
});
test('provider requests use a fixed host and never forward notification keys',async()=>{
 let request;
 const provider=makeProvider(async(url,options)=>{request={url,options};return Response.json([]);});
 await provider({...baseClaim,notificationToken:'DO-NOT-SEND'},'/checkout/payment-types?country=SA&currency=SAR');
 assert.equal(request.url,'https://api-sandbox.tamara.co/checkout/payment-types?country=SA&currency=SAR');
 assert.equal(request.options.redirect,'error');assert.ok(!JSON.stringify(request).includes('DO-NOT-SEND'));
});
test('server gateway rejects cross-origin, strips upstream secrets and verifies redirect',async()=>{
 let calls=0;const gateway=tamaraGateway({getToken:async()=>'fixture-jwt',url:'https://fixture.supabase.co',key:'public',fetcher:async()=>{calls++;return Response.json({attemptId:id,orderId,status:'pending',environment:'live',apiToken:'DO-NOT-LEAK',checkoutUrl:'https://evil.test'});}});
 const req=origin=>new Request('https://odeir.com/api/payments/tamara/checkout',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify({slug:'fixture',orderId,contact})});
 assert.equal((await gateway(req('https://evil.test'),'checkout')).status,403);assert.equal(calls,0);
 const response=await gateway(req('https://odeir.com'),'checkout');const result=await response.json();assert.equal(result.checkoutUrl,null);assert.equal(result.apiToken,undefined);
});
