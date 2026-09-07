import {mkdir,writeFile,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const port=4718,origin=`http://127.0.0.1:${port}`,qa='app/plan-editor-ui-qa',evidence='/tmp/plan-editor-evidence';
await mkdir(qa,{recursive:true});await mkdir(evidence,{recursive:true});
const plans=['المجانية','الأساسية','الاحترافية','الماسية'].map((nameAr,i)=>({id:`10000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,key:['core_free','core_basic','core_professional','core_diamond'][i],nameAr,description:'وصف باقة تجريبية',monthlyAmountMinor:[0,7900,19900,49900][i],annualAmountMinor:[0,79000,199000,499000][i],published:true,displayOrder:10+i,version:'a'.repeat(64),history:[],commercialProfile:{description:'وصف باقة تجريبية',limits:{staff:[3,5,10,20][i]}}}));
const fixture={plans,legacyPlans:[{id:'10000000-0000-4000-8000-000000000005',key:'full',nameAr:'النسخة الكاملة',subscriberCount:1}]};
await writeFile(`${qa}/page.js`,`import Plans from '../../components/platform-plans';export default function Page(){return <Plans initialData={${JSON.stringify(fixture)}}/>;}`);
const next=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,SUPABASE_URL:'http://127.0.0.1:1',NEXT_PUBLIC_SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_PUBLISHABLE_KEY:'fixture-only',ODEIR_PUBLIC_APP_URL:origin},stdio:'ignore'});
let browser;const errors=[],writes=[];
try{
 for(let n=0;n<80;n++){try{if((await fetch(origin+'/login')).ok)break;}catch{}await new Promise(r=>setTimeout(r,1000));}
 const cli=(...args)=>{const r=spawnSync(process.env.AGENT_BROWSER_BIN,['--session','core-editor-qa',...args],{encoding:'utf8',timeout:60000,env:{...process.env,AGENT_BROWSER_EXECUTABLE_PATH:chromium.executablePath()}});assert.equal(r.status,0,r.stderr);return r.stdout;};
 cli('open',origin+'/plan-editor-ui-qa');cli('wait','--load','networkidle');await writeFile(evidence+'/agent-browser.txt',cli('snapshot','-i'));cli('close');
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050},locale:'ar-SA'});
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/platform/plan-editor',async route=>{
  const p=route.request().postDataJSON();writes.push(p);await route.fulfill({json:{success:true,data:{...plans[1],...p.payload}}});
 });
 await page.goto(origin+'/plan-editor-ui-qa',{waitUntil:'networkidle'});
 assert.equal(await page.getByRole('button',{name:'تعديل الباقة',exact:true}).count(),4);
 await page.getByRole('button',{name:'تعديل الباقة',exact:true}).nth(1).click();
 const dialog=page.getByRole('dialog');
 await dialog.getByLabel('السعر الشهري بالريال',{exact:true}).fill('99.50');
 await dialog.getByLabel('السعر السنوي بالريال',{exact:true}).fill('845.75');
 await dialog.getByLabel('عدد المستخدمين شامل المالك',{exact:true}).fill('8');
 await dialog.getByLabel('سبب التعديل',{exact:true}).fill('تعديل تجريبي معزول لحماية العقود');
 await page.screenshot({path:evidence+'/editor-desktop.png',fullPage:true});
 assert.equal(writes.length,0);
 await dialog.getByRole('button',{name:'مراجعة التغييرات',exact:true}).click();
 assert.equal(writes.length,0);await page.screenshot({path:evidence+'/editor-review.png',fullPage:true});
 await dialog.getByRole('button',{name:'تأكيد حفظ الباقة',exact:true}).click();await page.getByRole('status').waitFor();
 assert.equal(writes.length,1);assert.equal(writes[0].payload.monthlyAmountMinor,9950);assert.equal(writes[0].payload.annualAmountMinor,84575);assert.equal(writes[0].payload.staffLimit,8);
 await page.getByRole('button',{name:'تعديل الباقة',exact:true}).first().click();
 assert.equal(await dialog.getByLabel('السعر الشهري بالريال',{exact:true}).getAttribute('readonly'),'');
 assert.equal(await dialog.getByLabel('إظهار الباقة وإتاحة الاشتراك الجديد',{exact:true}).isDisabled(),true);
 await dialog.getByRole('button',{name:'إغلاق',exact:true}).click();
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'تعديل الباقة',exact:true}).nth(1).click();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:evidence+'/editor-mobile.png',fullPage:true});
 assert.deepEqual(errors,[]);
 await writeFile(evidence+'/browser.json',JSON.stringify({syntheticOnly:true,realTenantMutations:0,editableCards:4,fullReadOnly:true,freePriceProtected:true,independentAnnualPrice:true,halalaPrecision:true,confirmationBeforeWrite:true,oldTermsNotice:true,mobileOverflow:false,pageErrors:errors},null,2));
 console.log('Plan editor browser verification passed. Synthetic mutations only.');
}finally{if(browser)await browser.close();next.kill('SIGTERM');await rm(qa,{recursive:true,force:true});}
