import {writeFile,mkdir,rm} from 'node:fs/promises';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE));
const output=process.env.TENANT_UI_EVIDENCE||'/tmp/tenant-controls-evidence';
const qa='app/tenant-controls-ui-qa';
const origin='http://127.0.0.1:4720';
const A='10000000-0000-4000-8000-000000000001',R='10000000-0000-4000-8000-000000000003';
const keys=['core_free','core_basic','core_professional','core_diamond','full'];
const plans=keys.map((key,i)=>({id:`20000000-0000-4000-8000-00000000000${i+1}`,key,name:['المجانية','الأساسية','الاحترافية','الماسية','النسخة الكاملة'][i],staffLimit:[3,5,10,20,null][i],monthlyAmountMinor:[0,7900,19900,49900,null][i],annualAmountMinor:[0,79000,199000,499000,null][i],internalOnly:i===4}));
const tenants=[{id:A,name:'منشأة التدريب التجريبية',slug:'demo-a',tenantKey:'fixture-a',status:'active',employees:2,members:2,planKey:'core_basic',planName:'الأساسية',ownerName:'مالك تجريبي',ownerEmail:'owner@example.invalid',odeiryManager:{enabled:false,effectiveEnabled:false,version:0}},{id:R,name:'ريف — بيانات اختبار فقط',slug:'reef-skills',tenantKey:'fixture-reef',status:'active',employees:26,members:26,planKey:'full',planName:'النسخة الكاملة',odeiryManager:{enabled:false,effectiveEnabled:false,version:0}}];
await mkdir(output,{recursive:true});await mkdir(qa,{recursive:true});
await writeFile(qa+'/page.js',`'use client';
import {useEffect,useState} from 'react';
import Tenants from '../../components/platform-tenants';
const initial=${JSON.stringify({tenants,plans:plans.map(p=>({...p,nameAr:p.name,status:'active'})),adminPermissions:{canDelete:true},odeiryManager:{globalEnabled:true,canManage:false}})};
const plans=${JSON.stringify(plans)};
export default function Page(){const [ready,setReady]=useState(false);useEffect(()=>{
const original=window.fetch;window.__tenantControlRequests=[];const states={};let version=0;
for(const t of initial.tenants){const p=plans.find(p=>p.key===t.planKey);states[t.id]={version:'a'.repeat(64),tenant:{...t,reefProtected:t.slug==='reef-skills'},subscription:{id:t.id,planId:p.id,planKey:p.key,planName:p.name,periodStart:'2026-09-07T00:00:00Z',periodEnd:null,billingInterval:'month'},plans,actions:{canSetPlan:t.slug!=='reef-skills',canSetStatus:t.slug!=='reef-skills',canDelete:t.slug!=='reef-skills'}};}
window.fetch=async(url,options={})=>{const u=new URL(String(url),location.origin);const json=data=>new Response(JSON.stringify({success:true,data}),{headers:{'Content-Type':'application/json'}});
if(u.pathname==='/api/platform/tenant-controls'){
if(options.method==='POST'){const b=JSON.parse(options.body);window.__tenantControlRequests.push(b);const s=states[b.tenantId];if(b.action==='set_status')s.tenant.status=b.payload.status;else {const p=plans.find(p=>p.id===b.payload.planId);s.subscription={...s.subscription,planId:p.id,planKey:p.key,planName:p.name,billingInterval:b.payload.billingInterval};}s.version=(++version).toString(16).padStart(64,'0');s.changed=true;s.paymentCollected=false;return json(s);}return json(states[u.searchParams.get('tenantId')]);}
if(u.pathname==='/api/platform/tenant-deletion'){
if(options.method==='POST'){const b=JSON.parse(options.body);window.__tenantControlRequests.push(b);return json({deleted:true,tenantId:b.tenantId,receiptId:'30000000-0000-4000-8000-000000000001',registrationReleased:true,authUserDeleted:false});}
const s=states[u.searchParams.get('tenantId')];return json({previewVersion:1,tenant:s.tenant,previewDigest:'c'.repeat(64),canDelete:!s.tenant.reefProtected,blockers:s.tenant.reefProtected?[{code:'protected',message:'منشأة محمية'}]:[],counts:{members:2,contacts:0,coreTransitionRecords:1,coreSubscriptionTerms:1},confirmationPhrase:'حذف '+s.tenant.slug});}
return original(url,options);};setReady(true);return()=>{window.fetch=original;};},[]);
return <main style={{padding:24}}><p>واجهة اختبار معزولة — لا بيانات أو عمليات حقيقية</p>{ready&&<Tenants initialData={initial}/>}</main>;}
`);
const server=spawn('node',['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','4720'],{env:{...process.env,SUPABASE_URL:'http://127.0.0.1:4799',SUPABASE_PUBLISHABLE_KEY:'fixture-not-a-secret'},stdio:'ignore'});
let browser;
const cli=(...args)=>{const r=spawnSync(process.env.AGENT_BROWSER_BIN||'agent-browser',['--session','tenant-controls-qa',...args],{encoding:'utf8',timeout:60000,env:{...process.env,AGENT_BROWSER_EXECUTABLE_PATH:chromium.executablePath()}});assert.equal(r.status,0,`agent-browser ${args[0]}: ${r.stderr||r.error}`);return r.stdout;};
try{
  let ready=false;for(let n=0;n<90;n++){try{if((await fetch(origin+'/tenant-controls-ui-qa')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}assert(ready,'dev server unavailable');
  // Mandatory agent-browser verification immediately after server startup.
  cli('open',origin+'/tenant-controls-ui-qa');
  cli('wait','--load','networkidle');
  await writeFile(output+'/agent-browser-snapshot.txt',cli('snapshot','-i'));
  cli('screenshot',output+'/tenant-list.png');
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050},locale:'ar-SA'});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/tenant-controls-ui-qa',{waitUntil:'networkidle'});
  await page.getByRole('button',{name:'إدارة منشأة التدريب التجريبية',exact:true}).click();
  await page.getByLabel('الباقة الجديدة').waitFor();
  assert.equal(await page.getByLabel('الباقة الجديدة').locator('option').count(),5);
  await page.screenshot({path:output+'/management-desktop.png',fullPage:true});
  await page.getByLabel('الباقة الجديدة').selectOption(plans[4].id);
  assert.equal(await page.evaluate(()=>window.__tenantControlRequests.length),0);
  await page.getByRole('button',{name:'مراجعة تغيير الباقة',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__tenantControlRequests.length),0);
  await page.getByRole('button',{name:'تأكيد التنفيذ',exact:true}).click();
  await page.getByText('تم تغيير الباقة إداريًا، دون تحصيل مبلغ أو تغيير إضافات المنشأة.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'إيقاف المنشأة',exact:true}).click();await page.getByRole('button',{name:'تأكيد التنفيذ',exact:true}).click();
  await page.getByRole('button',{name:'تفعيل المنشأة',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const bounds=await page.getByRole('dialog').boundingBox();assert(bounds&&bounds.width<=390);
  await page.screenshot({path:output+'/management-mobile.png',fullPage:true});
  await page.getByRole('button',{name:'تفعيل المنشأة',exact:true}).click();await page.getByRole('button',{name:'تأكيد التنفيذ',exact:true}).click();
  await page.getByRole('button',{name:'فتح معاينة الحذف',exact:true}).click();
  await page.getByRole('alertdialog').waitFor();await page.getByText('معاينة البيانات',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'حذف المنشأة نهائيًا',exact:true}).isDisabled(),true);
  await page.getByLabel('سبب الحذف').fill('منشأة وهمية لاختبار الواجهة فقط');
  await page.getByLabel(/اكتب العبارة التالية للتأكيد/).fill('حذف demo-a');
  await page.getByRole('checkbox').check();
  await page.screenshot({path:output+'/deletion-confirmation.png',fullPage:true});
  await page.getByRole('button',{name:'حذف المنشأة نهائيًا',exact:true}).click();
  await page.getByText('تم حذف المنشأة نهائيًا وتحرير بياناتها لإعادة التسجيل من الصفر.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'إدارة منشأة التدريب التجريبية',exact:true}).count(),0);
  await page.setViewportSize({width:1440,height:1050});await page.getByRole('button',{name:'إدارة ريف — بيانات اختبار فقط',exact:true}).click();
  await page.getByText('ريف على النسخة الكاملة المحفوظة',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'إيقاف المنشأة',exact:true}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'فتح معاينة الحذف',exact:true}).isDisabled(),true);
  await page.screenshot({path:output+'/protected-reef-fixture.png',fullPage:true});
  const requests=await page.evaluate(()=>window.__tenantControlRequests);assert(requests.every(r=>r.tenantId===A));assert.equal(requests.length,4);assert.deepEqual(errors,[]);
  await writeFile(output+'/browser.json',JSON.stringify({syntheticOnly:true,realTenantMutations:0,planChoices:5,confirmationBeforeWrite:true,suspendAndResume:true,typedDeletion:true,reefProtected:true,mobileOverflow:false,pageErrors:errors,requests},null,2));
  console.log('Tenant manual controls browser verification passed with synthetic data only.');
}finally{if(browser)await browser.close();try{cli('close');}catch{}server.kill('SIGTERM');await rm(qa,{recursive:true,force:true});}
