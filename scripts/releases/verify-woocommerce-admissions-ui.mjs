import {mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';

// Isolated CI fixture: no real tenant, authentication or payment requests.
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const qa='app/woocommerce-ui-qa',output='/tmp/woocommerce-ui-evidence',origin='http://127.0.0.1:4721';
await mkdir(qa,{recursive:true});await mkdir(output,{recursive:true});
await writeFile(qa+'/page.js',`'use client';
import {useState} from 'react';
import Modal from '../../components/woocommerce-admission-modal';
const task={id:'synthetic-task'};
export default function Page(){const [open,setOpen]=useState(true);return <main><h1>اختبار طلب متجر معزول</h1><button onClick={()=>setOpen(true)}>فتح الطلب</button>{open&&<Modal slug='fixture' task={task} onClose={()=>setOpen(false)} onSaved={()=>setOpen(false)}/>}</main>}
`);
let serverLog='';
const server=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','4721'],{
  env:{...process.env,SUPABASE_URL:'http://127.0.0.1:4799',SUPABASE_PUBLISHABLE_KEY:'synthetic-only'},stdio:['ignore','pipe','pipe']
});
server.stdout.on('data',chunk=>{serverLog+=chunk;});server.stderr.on('data',chunk=>{serverLog+=chunk;});
let browser,page;
try{
  let ready=false;
  for(let attempt=0;attempt<90;attempt++){
    if(server.exitCode!==null)throw new Error(serverLog);
    try{if((await fetch(origin+'/woocommerce-ui-qa',{signal:AbortSignal.timeout(2000)})).ok){ready=true;break;}}catch{}
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert(ready,'test server unavailable');
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},locale:'ar-SA',timezoneId:'Asia/Riyadh'});
  const base={enabled:true,revision:'r1',orderNumber:'9001',contactName:'عميل اختبار معزول',amountMinor:15001,
    paidAt:'2026-09-01T21:30:00Z',timeZone:'Asia/Riyadh',canReview:true,canComplete:true,reviewRequired:true,
    reviewValid:false,blockers:[],receipt:null,courses:[{id:'c1',name:'إدارة المشاريع الاحترافية PMP — عن بعد'},
      {id:'c2',name:'تحليل البيانات باستخدام Power BI — عن بعد'}],
    items:[{lineId:'101',title:'إدارة المشاريع الاحترافية PMP — عن بعد',quantity:1,amountMinor:10001,suggestedCourseId:'c1'},
      {lineId:'102',title:'تحليل البيانات باستخدام Power BI — عن بعد',quantity:1,amountMinor:5000,suggestedCourseId:'c2'}],
    candidates:[{id:'h1',courseId:'c1',courseName:'إدارة المشاريع',reference:'9001',amountMinor:10001,status:'accepted'}]};
  const writes=[],errors=[];let review=null,failReview=true;
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin!==origin)return route.abort();
    if(!url.pathname.startsWith('/api/'))return route.continue();
    const body=request.postDataJSON()||{};let data;
    if(url.pathname==='/api/tenant/woocommerce-admission-context')data=review
      ?{...base,revision:'r2',reviewValid:true,reviewLines:review.p_lines,reviewReason:review.p_reason}:base;
    else if(url.pathname==='/api/tenant/woocommerce-admission-action'){
      writes.push(body);
      if(body.p_action==='review'){
        if(failReview){failReview=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'تعذر الاتصال التجريبي'})});}
        review=body;data={reviewed:true};
      }else data={completed:true};
    }else throw new Error('Unexpected API request: '+url.pathname);
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
  });
  page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  await page.goto(origin+'/woocommerce-ui-qa');
  const complete=page.getByRole('button',{name:'إتمام وإرسال للتسجيل',exact:true});
  const approve=page.getByRole('button',{name:'اعتماد المراجعة والربط',exact:true});
  await complete.waitFor();assert(await complete.isDisabled());
  assert.equal(await page.getByRole('combobox',{name:'التسجيل المرتبط بالبند 1',exact:true}).inputValue(),'h1');
  assert.equal(await page.getByRole('combobox',{name:'الدورة للبند 2',exact:true}).inputValue(),'c2');
  assert.equal(await page.getByRole('dialog').getAttribute('dir'),'rtl');
  await page.getByRole('textbox',{name:'نتيجة المراجعة',exact:true}).fill('مطابقة المرجع والمبلغ للبند الأول؛ البند الثاني تسجيل جديد');
  await approve.click();await page.getByRole('dialog').getByRole('alert').waitFor();
  assert.equal(writes.length,1);await approve.click();
  await page.getByText('الربط والدورات معتمدة.',{exact:true}).waitFor();
  assert.equal(writes[0].p_command_id,writes[1].p_command_id);assert(await complete.isEnabled());
  await page.getByRole('combobox',{name:'الدورة للبند 2',exact:true}).selectOption('c1');assert(await complete.isDisabled());
  await page.getByRole('combobox',{name:'الدورة للبند 2',exact:true}).selectOption('c2');assert(await complete.isEnabled());
  const layouts=[];
  for(const width of [1440,390,360]){
    await page.setViewportSize({width,height:1050});
    const box=await page.getByRole('dialog').boundingBox();
    assert(box&&box.x>=-1&&box.width<=width,'dialog exceeds viewport');
    const overflow=await page.getByRole('dialog').evaluate(el=>({scroll:el.scrollWidth,client:el.clientWidth}));
    assert(overflow.scroll<=overflow.client+1,'horizontal overflow');
    layouts.push({width,dialogWidth:box.width,horizontalOverflow:false});
    await page.screenshot({path:output+'/woocommerce-'+width+'.png',fullPage:true});
  }
  await writeFile(output+'/reviewed-dom.txt',await page.locator('body').ariaSnapshot());
  await complete.click();await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(writes.length,3);assert.equal(writes[2].p_expected_revision,'r2');
  assert.deepEqual(writes[2].p_lines,[{lineId:'101',courseId:'c1',handoffId:'h1'},{lineId:'102',courseId:'c2',handoffId:null}]);
  assert.deepEqual(errors,[]);
  await writeFile(output+'/browser.json',JSON.stringify({syntheticOnly:true,productionRequests:0,layouts,
    priorAdmissionSelected:true,reviewRequired:true,retryIdPreserved:true,changedCourseRequiresReview:true,
    approvedSubmission:true,pageErrors:errors},null,2));
  console.log('WooCommerce admissions browser checks passed; no production requests.');
}catch(error){
  if(page){const snapshot=await page.locator('body').ariaSnapshot();console.error(snapshot);
    await writeFile(output+'/failure-dom.txt',snapshot);await page.screenshot({path:output+'/failure.png',fullPage:true});}
  throw error;
}finally{
  if(browser)await browser.close();server.kill('SIGTERM');
  await writeFile(output+'/server.log',serverLog);await rm(qa,{recursive:true,force:true});
}
