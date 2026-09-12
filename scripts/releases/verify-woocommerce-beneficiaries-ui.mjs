import {mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Browser-only fixture, not a production authentication/payment test.
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const qa='app/woocommerce-beneficiaries-qa',output='/tmp/woocommerce-beneficiaries-evidence',origin='http://127.0.0.1:4723';
await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(qa+'/page.js',`'use client';
import {useState} from 'react';
import Modal from '../../components/woocommerce-admission-modal';
import Registration from '../../components/woocommerce-beneficiary-admissions';
const task={id:'synthetic-task'};
const item={id:'h1',courseId:'c1',paymentStatus:'verified',status:'in_review',beneficiaryRevision:'enroll1',beneficiaries:[
 {id:'seat1',seatNumber:1,contactId:'buyer',name:'صاحب الطلب التجريبي',phone:'0501111111',allocatedMinor:69930,enrollmentId:null},
 {id:'seat2',seatNumber:2,contactId:'new-person',name:'المستفيد الجديد',phone:'0502222222',allocatedMinor:69930,enrollmentId:null}]};
const runs=[{id:'run1',courseId:'c1',title:'الدفعة الأولى',registrationOpen:true,availableSeats:10}];
export default function Page(){const [stage,setStage]=useState('order'),[busy,setBusy]=useState(false);return <main dir='rtl' style={{maxWidth:1000,margin:'auto',padding:12}}>
 <h1>اختبار مستفيدين معزول</h1>{stage==='order'?<Modal slug='fixture' task={task} onClose={()=>setStage('closed')} onSaved={()=>setStage('registration')}/>
 :stage==='registration'?<Registration slug='fixture' item={item} courseRuns={runs} canManage busy={busy} onBusyChange={setBusy} onSaved={()=>setStage('done')}/>:<p>اكتمل الاختبار</p>}</main>}
`);
let log='';const server=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','4723'],{
 env:{...process.env,SUPABASE_URL:'http://127.0.0.1:4799',SUPABASE_PUBLISHABLE_KEY:'synthetic-only'},stdio:['ignore','pipe','pipe']});
server.stdout.on('data',chunk=>{log+=chunk;});server.stderr.on('data',chunk=>{log+=chunk;});
let browser,page;
try{
 let ready=false;for(let n=0;n<90;n++){
  if(server.exitCode!==null)throw new Error(log);
  try{if((await fetch(origin+'/woocommerce-beneficiaries-qa',{signal:AbortSignal.timeout(2000)})).ok){ready=true;break;}}catch{}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert(ready,'test server unavailable');browser=await chromium.launch({headless:true});
 const browserContext=await browser.newContext({viewport:{width:1440,height:1050},locale:'ar-SA',timezoneId:'Asia/Riyadh'});
 const base={enabled:true,revision:'r1',orderNumber:'9001',contactId:'buyer',contactName:'صاحب الطلب التجريبي',amountMinor:139860,
  paidAt:'2026-09-01T21:30:00Z',timeZone:'Asia/Riyadh',canReview:true,canComplete:true,reviewRequired:true,reviewValid:false,
  beneficiaryEditorEnabled:true,beneficiariesValid:false,beneficiaries:[],blockers:['woocommerce_beneficiaries_required'],receipt:null,
  courses:[{id:'c1',name:'التهيئة لشهادة المساعد المعتمد في إدارة المشاريع CAPM — عن بعد'}],
  items:[{lineId:'101',title:'التهيئة لشهادة المساعد المعتمد في إدارة المشاريع CAPM — عن بعد',quantity:2,amountMinor:139860,suggestedCourseId:'c1'}],
  candidates:[{id:'h1',courseId:'c1',courseName:'CAPM',reference:'9001',amountMinor:139860,status:'accepted'}]};
 let saved=false,review=null,failSave=true,failEnroll=true;const saveWrites=[],enrollWrites=[],actions=[],errors=[],searches=[];
 await browserContext.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());if(url.origin!==origin)return route.abort();
  if(!url.pathname.startsWith('/api/'))return route.continue();
  const body=request.postDataJSON();let data;
  if(url.pathname==='/api/tenant/woocommerce-admission-context'){
   data=saved?{...base,revision:review?'r3':'r2',blockers:[],beneficiariesValid:true,beneficiaries:[
    {id:'seat1',lineId:'101',seatNumber:1,contactId:'buyer',name:base.contactName,phone:'0501111111'},
    {id:'seat2',lineId:'101',seatNumber:2,contactId:'new-person',name:'المستفيد الجديد',phone:'0502222222'}],
    reviewValid:Boolean(review),reviewLines:review?.p_lines,reviewReason:review?.p_reason}:base;
  }else if(url.pathname==='/api/tenant/woocommerce-beneficiaries'){
   if(body.action==='search'){searches.push(body);data=[{id:'existing',name:'عميل موجود تجريبي',phone:'0503333333'}];}
   else if(body.action==='save'){
    saveWrites.push(body);if(failSave){failSave=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'انقطاع تجريبي؛ أعد المحاولة'})});}
    saved=true;data={saved:true,count:2};
   }else if(body.action==='enroll'){
    enrollWrites.push(body);if(failEnroll){failEnroll=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'انقطاع تجريبي؛ أعد المحاولة'})});}
    data={saved:true,enrolled:2,remaining:0};
   }else throw new Error('unexpected beneficiary action');
  }else if(url.pathname==='/api/tenant/woocommerce-admission-action'){
   actions.push(body);if(body.p_action==='review'){review=body;data={reviewed:true};}else data={completed:true};
  }else throw new Error('unexpected API');
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
 });
 page=await browserContext.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(origin+'/woocommerce-beneficiaries-qa');
 const complete=page.getByRole('button',{name:'إتمام وإرسال للتسجيل',exact:true});await complete.waitFor();assert(await complete.isDisabled());
 const first=page.getByRole('group',{name:'المستفيد 1',exact:true}),second=page.getByRole('group',{name:'المستفيد 2',exact:true});
 assert.equal(await first.getByRole('searchbox').inputValue(),'');assert.equal(await second.getByRole('searchbox').inputValue(),'');
 await first.getByRole('button',{name:'صاحب الطلب',exact:true}).click();
 await second.getByRole('searchbox').fill('050333');await second.getByRole('button',{name:/عميل موجود تجريبي/}).click();
 assert.equal(searches.length,1);
 await second.getByRole('button',{name:'مستفيد جديد',exact:true}).click();
 await second.getByRole('textbox',{name:'اسم المستفيد 2',exact:true}).fill('المستفيد الجديد');
 await second.getByRole('textbox',{name:'جوال المستفيد 2',exact:true}).fill('+966 50 222 2222');
 const save=page.getByRole('button',{name:'حفظ المستفيدين',exact:true});await save.click();await page.getByRole('dialog').getByRole('alert').filter({hasText:'انقطاع تجريبي'}).waitFor();
 await save.click();await page.getByText('المستفيدون محفوظون.',{exact:true}).waitFor();
 assert.equal(saveWrites.length,2);assert.equal(saveWrites[0].p_command_id,saveWrites[1].p_command_id);
 assert.deepEqual(saveWrites[1].p_lines,[{lineId:'101',beneficiaries:[{contactId:'buyer'},{name:'المستفيد الجديد',phone:'0502222222'}]}]);
 assert.equal(await page.getByRole('combobox',{name:'التسجيل المرتبط بالبند 1',exact:true}).inputValue(),'h1');assert(await complete.isDisabled());
 await page.getByRole('textbox',{name:'نتيجة المراجعة',exact:true}).fill('مطابقة المستفيدين مع التسجيل السابق والإبقاء على إجمالي الدفع');
 await page.getByRole('button',{name:'اعتماد المراجعة والربط',exact:true}).click();await page.getByText('الربط والدورات معتمدة.',{exact:true}).waitFor();assert(await complete.isEnabled());
 const layouts=[];
 for(const width of [1440,390,360]){
  await page.setViewportSize({width,height:1050});const box=await page.getByRole('dialog').boundingBox();assert(box&&box.x>=-1&&box.width<=width);
  const overflow=await page.getByRole('dialog').evaluate(el=>el.scrollWidth-el.clientWidth);assert(overflow<=1,'order dialog horizontal overflow');
  await page.screenshot({path:output+'/beneficiaries-'+width+'.png',fullPage:true});layouts.push({screen:'order',width,overflow});
 }
 await complete.click();await page.getByRole('region',{name:'تسجيل المستفيدين',exact:true}).waitFor();
 await page.getByRole('combobox',{name:'دفعة واحدة لجميع غير المسجلين',exact:true}).selectOption('run1');
 for(const width of [1440,390,360]){
  await page.setViewportSize({width,height:1050});const overflow=await page.locator('body').evaluate(el=>el.scrollWidth-document.documentElement.clientWidth);
  assert(overflow<=1,'registration horizontal overflow');await page.screenshot({path:output+'/registration-'+width+'.png',fullPage:true});layouts.push({screen:'registration',width,overflow});
 }
 const register=page.getByRole('button',{name:'تسجيل المستفيدين المحددين (2)',exact:true});await register.click();await page.getByRole('region',{name:'تسجيل المستفيدين',exact:true}).getByRole('alert').waitFor();await register.click();await page.getByText('اكتمل الاختبار',{exact:true}).waitFor();
 assert.equal(enrollWrites.length,2);assert.equal(enrollWrites[0].p_command_id,enrollWrites[1].p_command_id);assert.equal(enrollWrites[1].p_seats.length,2);
 assert.equal(actions.length,2);assert.deepEqual(actions[1].p_lines,[{lineId:'101',courseId:'c1',handoffId:'h1'}]);assert.deepEqual(errors,[]);
 await writeFile(output+'/browser.json',JSON.stringify({syntheticOnly:true,productionRequests:0,layouts,buyerNotAssumed:true,existingSearch:true,newBeneficiary:true,
  saveRetryIdPreserved:true,previousPaymentReused:true,registrationRetryIdPreserved:true,sharedBatchShortcut:true,pageErrors:errors},null,2));
 console.log('WooCommerce beneficiary browser checks passed; no production requests.');
}catch(error){if(page){await writeFile(output+'/failure-dom.txt',await page.locator('body').ariaSnapshot());await page.screenshot({path:output+'/failure.png',fullPage:true});}throw error;}
finally{if(browser)await browser.close();server.kill('SIGTERM');await writeFile(output+'/server.log',log);await rm(qa,{recursive:true,force:true});}
