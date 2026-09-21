import {mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// This runner is used by isolated CI only. All business requests are synthetic.
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const qa='app/followup-ui-qa';
const output='/tmp/followup-ui-evidence';
const origin='http://127.0.0.1:4721';
await mkdir(qa,{recursive:true});
await mkdir(output,{recursive:true});
await writeFile(qa+'/page.js',`'use client';
import {useState} from 'react';
import Followup from '../../components/sales-followup-modal';
const contact={id:'10000000-0000-4000-8000-000000000005',name:'عميل اختبار معزول',phone:'0501111111',leadStatus:'interested',leadQuality:'good',interestCourseId:'c1'};
const courses=[{id:'c1',nameAr:'إدارة المشاريع الاحترافية PMP — عن بعد'},{id:'c2',nameAr:'تحليل البيانات باستخدام Power BI — عن بعد'},{id:'c3',nameAr:'مهارات الذكاء الاصطناعي AI — حضوري'}];
export default function Page(){const [open,setOpen]=useState(true);return <main><h1>اختبار متابعة معزول</h1><button onClick={()=>setOpen(true)}>فتح المتابعة</button>{open&&<Followup slug='fixture' contact={contact} courses={courses} timeZone='Asia/Riyadh' onClose={()=>setOpen(false)} onSaved={()=>setOpen(false)}/>}</main>}
`);
let serverLog='';
const server=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','4721'],{
  env:{...process.env,SUPABASE_URL:'http://127.0.0.1:4799',SUPABASE_PUBLISHABLE_KEY:'synthetic-only'},stdio:['ignore','pipe','pipe']
});
server.stdout.on('data',chunk=>{serverLog+=chunk;});
server.stderr.on('data',chunk=>{serverLog+=chunk;});
let browser,page;
try{
  let ready=false;
  for(let attempt=0;attempt<90;attempt++){
    if(server.exitCode!==null)throw new Error(serverLog);
    try{if((await fetch(origin+'/followup-ui-qa',{signal:AbortSignal.timeout(2000)})).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert(ready,'test server unavailable');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ar-SA',timezoneId:'Asia/Riyadh'});
  let saved=null;
  const writes=[],errors=[];
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON()||{};
    let data;
    if(url.pathname==='/api/tenant/sales-followup-context')data={revision:'synthetic-revision',primaryPhone:'0501111111',timezone:'Asia/Riyadh',openOpportunities:[{id:'opp-c1',title:'فرصة PMP',courseId:'c1'},{id:'opp-c2',title:'فرصة Power BI',courseId:'c2'}],baseContact:{name:'عميل اختبار معزول',leadStatus:'interested',leadQuality:'good'},courseInterests:saved?.p_course_interests||[{courseId:'c1'}],additionalPhones:saved?.p_additional_phones||[]};
    else if(url.pathname==='/api/tenant/sales-followup-options'){
      const c=body.p_course_id;
      data={courseId:c,runs:[{id:c+'-run',courseId:c,title:'دفعة اختبار '+c,startsAt:'2026-10-01T15:00:00Z',status:'open',sessions:[{id:c+'-s1',title:'محاضرة أولى',startsAt:'2026-10-01T15:00:00Z'},{id:c+'-s2',title:'محاضرة ثانية',startsAt:'2026-10-03T15:00:00Z'}]}]};
    }else if(url.pathname==='/api/tenant/record-sales-followup'){
      writes.push(body);saved=body;data={taskUpdated:true};
    }else throw new Error('Unexpected API request: '+url.pathname);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
  });
  page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/followup-ui-qa');
  await page.getByRole('button',{name:'إضافة دورة',exact:true}).waitFor();
  await writeFile(output+'/initial-dom.txt',await page.locator('body').ariaSnapshot());
  await page.screenshot({path:output+'/initial.png',fullPage:true});
  await page.getByRole('button',{name:'حفظ النتيجة',exact:true}).waitFor();
  await page.getByRole('combobox',{name:'الفرصة التي تخصها المتابعة',exact:true}).selectOption('opp-c1');
  await page.getByLabel(/^الدفعة/).selectOption('c1-run');
  await page.getByLabel(/^موعد حضور الدورة/).selectOption('c1-s2');
  await page.getByRole('button',{name:'إضافة دورة',exact:true}).click();
  await page.getByLabel(/^الدورة المهتم بها/).nth(1).selectOption('c2');
  await page.getByLabel(/^الدفعة/).nth(1).selectOption('c2-run');
  await page.getByLabel(/^موعد حضور الدورة/).nth(1).selectOption('c2-s1');
  assert.equal(await page.getByLabel(/^موعد حضور الدورة/).nth(0).inputValue(),'c1-s2');
  for(let i=1;i<=2;i++){
    await page.getByRole('button',{name:'إضافة رقم',exact:true}).click();
    await page.getByLabel('رقم إضافي '+i,{exact:true}).fill(i===1?'0551111111':'0562222222');
  }
  await page.getByLabel('ما الذي حدث؟',{exact:true}).fill('اختبار المتابعة');
  await page.locator('input[name="next_action_at"]').fill('2026-10-01T12:00');
  const layouts=[];
  for(const width of [1440,390,360]){
    await page.setViewportSize({width,height:1050});
    const box=await page.getByRole('dialog').boundingBox();
    assert(box&&box.width<=width&&box.x>=-1,'dialog exceeds viewport');
    const overflow=await page.getByRole('dialog').evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth}));
    assert(overflow.scroll<=overflow.client+1,'dialog has horizontal overflow');
    layouts.push({width,dialogWidth:box.width,horizontalOverflow:false});
    await page.screenshot({path:output+'/followup-'+width+'.png',fullPage:true});
  }
  await page.getByRole('button',{name:'حفظ النتيجة',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(writes.length,1);
  assert.deepEqual(writes[0].p_course_interests,[{courseId:'c1',courseRunId:'c1-run',attendanceSessionId:'c1-s2'},{courseId:'c2',courseRunId:'c2-run',attendanceSessionId:'c2-s1'}]);
  assert.equal(writes[0].p_additional_phones.length,2);
  assert.equal(writes[0].p_opportunity_id,'opp-c1');
  assert.equal(writes[0].p_next_action_at,'2026-10-01T09:00:00.000Z');
  assert(writes[0].p_command_id);
  await page.getByRole('button',{name:'فتح المتابعة',exact:true}).click();
  await page.getByLabel('رقم إضافي 2',{exact:true}).waitFor();
  assert.equal(await page.getByLabel(/^الدورة المهتم بها/).count(),2);
  await page.getByRole('combobox',{name:'الفرصة التي تخصها المتابعة',exact:true}).selectOption('opp-c2');
  await page.getByRole('combobox',{name:'حالة متابعة الفرصة',exact:true}).selectOption('payment_submitted');
  await page.getByLabel(/الدورة التي يخصها بلاغ الدفع/).selectOption('c2');
  await page.getByLabel('ما الذي حدث؟',{exact:true}).fill('اختبار بلاغ دفع تجريبي');
  await page.getByRole('button',{name:'إرسال للتحقق من الدفع',exact:true}).click();
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(writes.length,2);
  assert.equal(writes[1].p_payment_course_id,'c2');
  assert.equal(writes[1].p_opportunity_id,'opp-c2');
  assert.equal(writes[1].p_course_interests.length,2);
  assert.deepEqual(errors,[]);
  await writeFile(output+'/browser.json',JSON.stringify({syntheticOnly:true,productionRequests:0,layouts,independentAttendance:true,saveReload:true,paymentCourseSelection:true,pageErrors:errors},null,2));
  console.log('Follow-up browser checks passed; no production requests.');
}catch(error){
  if(page){
    const snapshot=await page.locator('body').ariaSnapshot();
    console.error(snapshot);
    await writeFile(output+'/failure-dom.txt',snapshot);
    await page.screenshot({path:output+'/failure.png',fullPage:true});
  }
  throw error;
}finally{
  if(browser)await browser.close();
  server.kill('SIGTERM');
  await writeFile(output+'/server.log',serverLog);
  await rm(qa,{recursive:true,force:true});
}
