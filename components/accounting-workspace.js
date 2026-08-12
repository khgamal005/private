'use client';

import Link from 'next/link';
import {useState} from 'react';
import styles from './accounting-workspace.module.css';

const SECTION_META={
  overview:['مركز الحسابات','صورة تنفيذية للمفوتر والمحصل والمستحق وما يحتاج قرارًا.'],
  receivables:['حسابات العملاء والمستحقات','كشف موحد للرصيد وأعمار الدين ووعود السداد.'],
  quotes:['عروض الأسعار','أنشئ وأرسل واعتمد ثم حوّل العرض المقبول إلى فاتورة.'],
  invoices:['الفواتير والأقساط','فواتير تشغيلية مستقلة عن زاتكا مع تحصيل جزئي وجدولة.'],
  payments:['المدفوعات والإيصالات','سجل الدفعة، تحقق منها، وزعها، ثم أصدر إيصال قبض.'],
  adjustments:['المرتجعات والتسويات','طلبات الاسترداد والإشعارات الدائنة والمدينة دون محو التاريخ.'],
  incentives:['الحوافز والعمولات','الرؤية المالية لنفس دفتر الحوافز التشغيلي، بلا نسخ مكرر.'],
  reports:['التقارير المالية','المفوتر مقابل المحصل، أعمار الدين، الضرائب ووسائل الدفع.'],
  settings:['إعدادات الحسابات','الملف المالي والترقيم والضريبة وشروط السداد الافتراضية.'],
  zatca:['زاتكا والفوترة الإلكترونية','تهيئة الملف ومتابعة الربط؛ لا توجد شارة امتثال قبل اتصال الموصل وقبول المستند.']
};

const STATUS_LABELS={
  draft:'مسودة',sent:'مرسل',accepted:'مقبول',rejected:'مرفوض',expired:'منتهي',
  converted:'محوّل',issued:'صادر',cancelled:'ملغي',unpaid:'غير مدفوع',
  partially_paid:'مدفوع جزئيًا',paid:'مدفوع',overdue:'متأخر',
  pending_verification:'بانتظار التحقق',verified:'متحقق منه',refunded:'مسترد',
  requested:'مطلوب',approved:'معتمد',completed:'مكتمل',profile_ready:'الملف جاهز للربط'
};
const METHOD_LABELS={bank_transfer:'تحويل بنكي',cash:'نقدي',mada:'مدى',tamara:'تمارا',paymob:'Paymob',paypal:'PayPal',store:'متجر',other:'أخرى'};
const today=()=>new Date().toISOString().slice(0,10);
const commandId=()=>globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`;
const array=value=>Array.isArray(value)?value:[];
const minor=value=>Math.round((Number(value)||0)*100);
const money=(value,currency='SAR')=>new Intl.NumberFormat('ar-SA',{style:'currency',currency,maximumFractionDigits:2}).format((Number(value)||0)/100);
const date=value=>value?new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(value)):'—';
const decimal=value=>(Number(value||0)/100).toFixed(2);

function csvCell(value){
  return `"${String(value??'').replace(/"/g,'""')}"`;
}
function downloadCsv(filename,headers,rows){
  const content=[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n');
  const blob=new Blob([`\uFEFF${content}`],{type:'text/csv;charset=utf-8'});
  const href=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=href;
  anchor.download=filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
function exportDocuments(items,filename='مستندات-الحسابات.csv'){
  downloadCsv(filename,
    ['رقم المستند','النوع','العميل','تاريخ الإصدار','الاستحقاق أو الصلاحية','العملة','قبل الضريبة','الخصم','الضريبة','الإجمالي','الحالة','حالة السداد'],
    items.map(item=>[
      item.number||'',item.type==='quote'?'عرض سعر':item.type==='invoice'?'فاتورة':item.type==='credit_note'?'إشعار دائن':'إشعار مدين',
      item.customerName||'',item.issueDate||'',item.dueDate||item.validUntil||'',item.currency||'SAR',
      decimal(item.subtotalMinor),decimal(item.discountMinor),decimal(item.taxMinor),decimal(item.totalMinor),
      STATUS_LABELS[item.status]||item.status||'',STATUS_LABELS[item.paymentStatus]||item.paymentStatus||''
    ])
  );
}
function exportPayments(items,filename='مدفوعات-الحسابات.csv'){
  downloadCsv(filename,
    ['رقم الدفعة','العميل','تاريخ الاستلام','وسيلة الدفع','العملة','المبلغ','غير الموزع','الحالة','المرجع'],
    items.map(item=>[
      item.number||'',item.customerName||'',item.receivedAt||item.paymentDate||'',METHOD_LABELS[item.method]||item.method||'',
      item.currency||'SAR',decimal(item.amountMinor),decimal(item.unallocatedMinor),STATUS_LABELS[item.status]||item.status||'',item.externalReference||item.reference||''
    ])
  );
}

function Status({value}){
  return <span className={`${styles.status} ${styles[`status_${value}`]||''}`}>{STATUS_LABELS[value]||value||'—'}</span>;
}
function Empty({title='لا توجد بيانات بعد',copy='ابدأ بأول عملية وسيظهر السجل هنا.'}){
  return <div className={styles.empty}><span>◎</span><b>{title}</b><p>{copy}</p></div>;
}
function Metric({label,value,copy,tone='blue'}){
  return <article className={`${styles.metric} ${styles[tone]}`}><small>{label}</small><strong>{value}</strong><p>{copy}</p></article>;
}
function Field({label,children,wide=false}){
  return <label className={wide?styles.wide:''}><span>{label}</span>{children}</label>;
}
function Modal({title,copy,onClose,children}){
  return <div className={styles.backdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}><section className={styles.modal} role="dialog" aria-modal="true"><header><div><small>الحسابات والفوترة</small><h2>{title}</h2>{copy&&<p>{copy}</p>}</div><button type="button" onClick={onClose} aria-label="إغلاق">×</button></header>{children}</section></div>;
}

export default function AccountingWorkspace({slug,initialData={},initialSection='overview'}){
  const [data,setData]=useState(initialData||{});
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState(null);
  const [printDocument,setPrintDocument]=useState(null);
  const section=SECTION_META[initialSection]?initialSection:'overview';
  const accounts=array(data.accounts),documents=array(data.documents),payments=array(data.payments);
  const refunds=array(data.refunds),inbox=array(data.admissionPaymentInbox);
  const quotes=documents.filter(item=>item.type==='quote');
  const invoices=documents.filter(item=>['invoice','credit_note','debit_note'].includes(item.type));
  const summary=data.summary||{},viewer=data.viewer||{},profile=data.profile||{};

  async function refresh(){
    const response=await fetch(`/api/accounting/snapshot?tenantSlug=${encodeURIComponent(slug)}`,{cache:'no-store'});
    const next=await response.json();
    if(!response.ok)throw new Error(next.error||'تعذر تحديث البيانات');
    setData(next);
  }
  async function act(action,payload={},success='تم حفظ العملية بنجاح'){
    setBusy(action);setNotice(null);
    try{
      const response=await fetch(`/api/accounting/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantSlug:slug,payload:{...payload,commandId:commandId()}})});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
      await refresh();setModal(null);setNotice({tone:'success',text:success});return result;
    }catch(error){setNotice({tone:'error',text:error.message||'تعذر تنفيذ العملية'});return null;
    }finally{setBusy('');}
  }
  function print(item){setPrintDocument(item);setTimeout(()=>window.print(),80);}

  const base=`/tenant/${encodeURIComponent(slug)}/accounting`;
  const header=SECTION_META[section];
  return <div className={styles.workspace} dir="rtl">
    <header className={styles.hero}>
      <div><span className={styles.eyebrow}>تشغيل الإيرادات وحسابات العملاء</span><h1>{header[0]}</h1><p>{header[1]}</p></div>
      <div className={styles.heroActions}>
        {section==='quotes'&&quotes.length>0&&<button className={styles.secondary} onClick={()=>exportDocuments(quotes,'عروض-الأسعار.csv')}>تصدير العروض CSV</button>}
        {section==='invoices'&&invoices.length>0&&<button className={styles.secondary} onClick={()=>exportDocuments(invoices,'الفواتير-والإشعارات.csv')}>تصدير الفواتير CSV</button>}
        {section==='reports'&&documents.length>0&&<button className={styles.secondary} onClick={()=>exportDocuments(documents,'تقرير-المستندات.csv')}>تصدير المستندات</button>}
        {section==='reports'&&payments.length>0&&<button className={styles.secondary} onClick={()=>exportPayments(payments,'تقرير-المدفوعات.csv')}>تصدير المدفوعات</button>}
        {viewer.canWriteQuotes&&<button className={styles.secondary} onClick={()=>setModal({type:'document',documentType:'quote'})}>+ عرض سعر</button>}
        {viewer.canWriteInvoices&&<button className={styles.primary} onClick={()=>setModal({type:'document',documentType:'invoice'})}>+ فاتورة</button>}
      </div>
    </header>
    <div className={styles.foundation}><span>الأساسي دائمًا</span><b>عروض + فواتير + أقساط + تحصيل + إيصالات + كشف حساب + حوافز</b><i>زاتكا طبقة اختيارية منفصلة</i></div>
    {notice&&<div className={`${styles.notice} ${styles[notice.tone]}`}>{notice.text}<button onClick={()=>setNotice(null)}>×</button></div>}
    <nav className={styles.localNav} aria-label="أقسام الحسابات">
      {[['overview','نظرة عامة'],['receivables','العملاء'],['quotes','العروض'],['invoices','الفواتير'],['payments','المدفوعات'],['adjustments','التسويات'],['incentives','الحوافز'],['reports','التقارير'],['settings','الإعدادات']].map(([key,label])=><Link key={key} href={key==='overview'?base:`${base}/${key}`} className={section===key?styles.active:''}>{label}</Link>)}
      {data.zatca?.addonEnabled&&<Link href={`${base}/zatca`} className={section==='zatca'?styles.active:''}>زاتكا</Link>}
    </nav>

    {section==='overview'&&<Overview summary={summary} aging={data.aging||{}} accounts={accounts} payments={payments} refunds={refunds} inbox={inbox} onModal={setModal}/>} 
    {section==='receivables'&&<Receivables accounts={accounts} collections={array(data.collections)} candidates={array(data.customerCandidates)} viewer={viewer} onModal={setModal}/>} 
    {section==='quotes'&&<Documents title="عروض الأسعار" items={quotes} schedules={array(data.paymentSchedules)} viewer={viewer} onModal={setModal} onAct={act} onPrint={print}/>} 
    {section==='invoices'&&<Documents title="الفواتير والإشعارات" items={invoices} schedules={array(data.paymentSchedules)} viewer={viewer} onModal={setModal} onAct={act} onPrint={print}/>} 
    {section==='payments'&&<Payments payments={payments} inbox={inbox} viewer={viewer} onModal={setModal} onAct={act}/>} 
    {section==='adjustments'&&<Adjustments refunds={refunds} payments={payments} viewer={viewer} onModal={setModal} onAct={act}/>} 
    {section==='incentives'&&<Incentives value={data.incentives||{}} slug={slug}/>} 
    {section==='reports'&&<Reports summary={summary} documents={documents} payments={payments}/>} 
    {section==='settings'&&<Settings profile={profile} viewer={viewer} busy={busy} onSave={payload=>act('save-settings',payload,'تم حفظ إعدادات الحسابات')}/>} 
    {section==='zatca'&&<Zatca value={data.zatca||{}} busy={busy} onSave={payload=>act('save-zatca-config',payload,'تم حفظ ملف التهيئة؛ الربط الفني لم يُفعّل بعد')}/>} 

    {modal?.type==='account'&&<AccountForm modal={modal} candidates={array(data.customerCandidates)} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('create-customer-account',payload,'تم إنشاء حساب العميل')}/>} 
    {modal?.type==='document'&&<DocumentForm modal={modal} accounts={accounts} profile={profile} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('create-document',payload,'تم إنشاء المستند كمسودة')}/>} 
    {modal?.type==='payment'&&<PaymentForm accounts={accounts} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('record-payment',payload,'تم تسجيل الدفعة')}/>} 
    {modal?.type==='allocation'&&<AllocationForm payment={modal.payment} invoices={invoices} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('allocate-payment',payload,'تم توزيع الدفعة')}/>} 
    {modal?.type==='schedule'&&<ScheduleForm document={modal.document} schedules={array(data.paymentSchedules)} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('create-schedule',payload,'تمت إضافة القسط')}/>} 
    {modal?.type==='collection'&&<CollectionForm accounts={accounts} invoices={invoices} account={modal.account} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('record-collection-action',payload,'تم تسجيل متابعة التحصيل')}/>} 
    {modal?.type==='refund'&&<RefundForm payment={modal.payment} invoices={invoices} busy={busy} onClose={()=>setModal(null)} onSave={payload=>act('request-refund',payload,'تم إرسال طلب الاسترداد للمراجعة')}/>} 
    {printDocument&&<PrintSheet document={printDocument} profile={profile} onClose={()=>setPrintDocument(null)}/>} 
  </div>;
}

function Overview({summary,aging,accounts,payments,refunds,inbox,onModal}){
  const urgent=[
    ...payments.filter(item=>item.status==='pending_verification').slice(0,4).map(item=>({title:`دفعة ${item.number}`,copy:`${item.customerName} · ${money(item.amountMinor)}`,tone:'amber'})),
    ...refunds.filter(item=>['requested','approved'].includes(item.status)).slice(0,3).map(item=>({title:'استرداد يحتاج قرارًا',copy:money(item.amountMinor),tone:'red'})),
    ...inbox.filter(item=>item.canImport).slice(0,3).map(item=>({title:'دفع تسجيل جاهز للاستيراد',copy:`${money(item.amountMinor)} · ${item.reference||'بلا مرجع'}`,tone:'blue'}))
  ];
  return <>
    <section className={styles.metrics}>
      <Metric label="صافي المفوتر" value={money(summary.netInvoicedMinor)} copy="صادر خلال الفترة، بعد الإشعارات الدائنة"/>
      <Metric label="المحصل فعليًا" value={money(summary.collectedMinor)} copy="دفعات متحقق منها بعد الاسترداد" tone="green"/>
      <Metric label="الرصيد المستحق" value={money(summary.outstandingMinor)} copy="على الفواتير الصادرة" tone="purple"/>
      <Metric label="المتأخر" value={money(summary.overdueMinor)} copy="تجاوز تاريخ الاستحقاق" tone="red"/>
    </section>
    <section className={styles.twoColumns}>
      <article className={styles.panel}><header><div><small>أعمار الديون</small><h2>أين يتركز الرصيد؟</h2></div></header><div className={styles.aging}>{[['حالي',aging.current],['1–30 يوم',aging.days1to30],['31–60 يوم',aging.days31to60],['61–90 يوم',aging.days61to90],['أكثر من 90',aging.over90]].map(([label,value])=><div key={label}><span>{label}</span><b>{money(value)}</b><i style={{'--w':`${Math.min(100,(Number(value)||0)/(Math.max(1,Number(summary.outstandingMinor)||1))*100)}%`}}/></div>)}</div></article>
      <article className={styles.panel}><header><div><small>قائمة تنفيذية</small><h2>ما يحتاج تدخلًا الآن</h2></div></header>{urgent.length?<div className={styles.urgent}>{urgent.map((item,index)=><div key={`${item.title}-${index}`}><i className={styles[item.tone]}/><span><b>{item.title}</b><small>{item.copy}</small></span></div>)}</div>:<Empty title="لا توجد عناصر عاجلة" copy="الدفعات والاستردادات ووعود السداد تحت السيطرة."/>}</article>
    </section>
    <section className={styles.quickGrid}>
      <button onClick={()=>onModal({type:'payment'})}><span>＋</span><b>تسجيل دفعة</b><small>ثم التحقق والتوزيع</small></button>
      <button onClick={()=>onModal({type:'collection'})}><span>◷</span><b>وعد أو متابعة سداد</b><small>على حساب العميل</small></button>
      <button onClick={()=>onModal({type:'account'})}><span>◎</span><b>إنشاء حساب عميل</b><small>من CRM أو يدويًا</small></button>
      <div><span>Σ</span><b>{accounts.length} حساب عميل</b><small>{summary.pendingPayments||0} دفعة تنتظر التحقق</small></div>
    </section>
  </>;
}

function Receivables({accounts,collections,candidates,viewer,onModal}){
  return <section className={styles.panel}><header><div><small>دفتر العملاء</small><h2>الأرصدة والمتابعة</h2></div>{viewer.canManageCustomers&&<button className={styles.primary} onClick={()=>onModal({type:'account'})}>+ حساب عميل</button>}</header>{accounts.length?<div className={styles.tableWrap}><table><thead><tr><th>الحساب</th><th>المفوتر</th><th>المحصل</th><th>الرصيد</th><th>الحالة</th><th/></tr></thead><tbody>{accounts.map(account=><tr key={account.id}><td><b>{account.displayName}</b><small>{account.accountNumber} · {account.billingPhone||account.billingEmail||'لا توجد وسيلة اتصال'}</small></td><td>{money(account.invoicedMinor)}</td><td>{money(account.collectedMinor)}</td><td><strong className={Number(account.balanceMinor)>0?styles.due:''}>{money(account.balanceMinor)}</strong></td><td><Status value={account.status}/></td><td><button className={styles.linkButton} onClick={()=>onModal({type:'collection',account})}>متابعة التحصيل</button></td></tr>)}</tbody></table></div>:<Empty title="لم تُنشأ حسابات عملاء" copy={candidates.length?`يوجد ${candidates.length} عميلًا في CRM جاهزين للربط.`:'أنشئ حسابًا يدويًا أو أضف عميلًا من CRM.'}/>} {collections.length>0&&<div className={styles.timeline}><h3>آخر متابعات التحصيل</h3>{collections.slice(0,8).map(item=><div key={item.id}><i/><span><b>{item.summary}</b><small>{STATUS_LABELS[item.type]||item.type} · {date(item.createdAt)}{item.promisedDate?` · وعد في ${date(item.promisedDate)}`:''}</small></span></div>)}</div>}</section>;
}

function Documents({title,items,schedules,viewer,onModal,onAct,onPrint}){
  async function transition(item,status){await onAct('issue-document',{documentId:item.id,status},status==='sent'?'تم إرسال العرض':'تم تحديث حالة المستند');}
  async function convert(item){await onAct('create-document',{documentType:'invoice',parentDocumentId:item.id,customerAccountId:item.customerAccountId,issueDate:today(),lines:array(item.lines).map(line=>({description:line.description,quantity:line.quantity,unitAmountMinor:line.unitAmountMinor,discountMinor:line.discountMinor,taxCategory:line.taxCategory,taxRateBps:line.taxRateBps}))},'تم تحويل العرض إلى فاتورة مسودة');}
  return <section className={styles.panel}><header><div><small>سجل المستندات</small><h2>{title}</h2></div><div>{title.includes('عروض')&&viewer.canWriteQuotes&&<button className={styles.primary} onClick={()=>onModal({type:'document',documentType:'quote'})}>+ عرض سعر</button>}{title.includes('فواتير')&&viewer.canWriteInvoices&&<button className={styles.primary} onClick={()=>onModal({type:'document',documentType:'invoice'})}>+ فاتورة</button>}</div></header>{items.length?<div className={styles.tableWrap}><table><thead><tr><th>المستند</th><th>العميل</th><th>التاريخ</th><th>الإجمالي</th><th>الحالة</th><th>السداد</th><th/></tr></thead><tbody>{items.map(item=>{const installmentCount=schedules.filter(entry=>entry.invoiceId===item.id).length;return <tr key={item.id}><td><b>{item.number}</b><small>{item.type==='quote'?'عرض سعر':item.type==='credit_note'?'إشعار دائن':item.type==='debit_note'?'إشعار مدين':'فاتورة'}{installmentCount?` · ${installmentCount} أقساط`:''}</small></td><td>{item.customerName}</td><td>{date(item.issueDate)}<small>{item.dueDate?`استحقاق ${date(item.dueDate)}`:''}</small></td><td><b>{money(item.totalMinor,item.currency)}</b><small>ضريبة {money(item.taxMinor,item.currency)}</small></td><td><Status value={item.status}/></td><td>{item.paymentStatus?<Status value={item.paymentStatus}/>:<span>—</span>}</td><td><div className={styles.rowActions}><button onClick={()=>onPrint(item)}>طباعة</button>{item.type==='quote'&&item.status==='draft'&&viewer.canWriteQuotes&&<button onClick={()=>transition(item,'sent')}>إرسال</button>}{item.type==='quote'&&item.status==='sent'&&viewer.canWriteQuotes&&<><button onClick={()=>transition(item,'accepted')}>قبول</button><button onClick={()=>transition(item,'rejected')}>رفض</button></>}{item.type==='quote'&&item.status==='accepted'&&viewer.canWriteInvoices&&<button onClick={()=>convert(item)}>تحويل لفاتورة</button>}{item.type==='invoice'&&item.status==='draft'&&viewer.canWriteInvoices&&<button onClick={()=>onModal({type:'schedule',document:item})}>+ قسط</button>}{item.type!=='quote'&&item.status==='draft'&&viewer.canIssueInvoices&&<button className={styles.issue} onClick={()=>transition(item,'issued')}>إصدار وتثبيت</button>}</div></td></tr>})}</tbody></table></div>:<Empty title={`لا توجد ${title} بعد`} copy="أنشئ أول مسودة، راجع البنود والضريبة، ثم ثبّت المستند في الوقت المناسب."/>}</section>;
}

function Payments({payments,inbox,viewer,onModal,onAct}){
  return <div className={styles.stack}><section className={styles.panel}><header><div><small>دورة القبض</small><h2>المدفوعات والإيصالات</h2></div>{viewer.canRecordPayments&&<button className={styles.primary} onClick={()=>onModal({type:'payment'})}>+ تسجيل دفعة</button>}</header>{payments.length?<div className={styles.tableWrap}><table><thead><tr><th>الدفعة</th><th>العميل</th><th>المبلغ</th><th>غير موزع</th><th>الحالة</th><th>الإيصال</th><th/></tr></thead><tbody>{payments.map(payment=><tr key={payment.id}><td><b>{payment.number}</b><small>{METHOD_LABELS[payment.method]||payment.method} · {date(payment.receivedAt)}</small></td><td>{payment.customerName}</td><td>{money(payment.amountMinor,payment.currency)}</td><td>{money(payment.unallocatedMinor,payment.currency)}</td><td><Status value={payment.status}/></td><td>{payment.receipt?.number||'—'}</td><td><div className={styles.rowActions}>{payment.status==='pending_verification'&&viewer.canApprovePayments&&<button className={styles.issue} onClick={()=>onAct('verify-payment',{paymentId:payment.id},'تم التحقق من الدفعة')}>تحقق</button>}{payment.status==='verified'&&Number(payment.unallocatedMinor)>0&&viewer.canApprovePayments&&<button onClick={()=>onModal({type:'allocation',payment})}>توزيع</button>}{payment.status==='verified'&&!payment.receipt&&viewer.canApprovePayments&&<button onClick={()=>onAct('issue-receipt',{paymentId:payment.id},'تم إصدار إيصال القبض')}>إيصال</button>}{payment.status==='verified'&&viewer.canRequestRefunds&&<button onClick={()=>onModal({type:'refund',payment})}>استرداد</button>}</div></td></tr>)}</tbody></table></div>:<Empty title="لا توجد دفعات" copy="تسجيل الدفعة لا يعني اعتمادها؛ المالية تتحقق منها أولًا."/>}</section>{inbox.length>0&&<section className={styles.panel}><header><div><small>ربط اختياري وآمن</small><h2>دفعات التسجيل غير المستوردة</h2><p>لن يتم استيراد أي سجل تلقائيًا. المقبول فقط هو الدفع المتحقق منه.</p></div></header><div className={styles.inbox}>{inbox.map(item=><div key={item.id}><span><b>{money(item.amountMinor)}</b><small>{item.reference||'لا يوجد مرجع'} · <Status value={item.status}/></small></span>{item.canImport&&viewer.canApprovePayments?<button onClick={()=>onAct('import-handoff-payment',{handoffId:item.id},'تم استيراد الدفع المتحقق منه مرة واحدة')}>استيراد صريح</button>:<i>بانتظار التحقق</i>}</div>)}</div></section>}</div>;
}

function Adjustments({refunds,payments,viewer,onModal,onAct}){
  return <section className={styles.panel}><header><div><small>لا حذف ولا كتابة فوق التاريخ</small><h2>الاستردادات والتسويات</h2><p>الاسترداد النقدي مستقل عن الإشعار الدائن، ويمكن ربطهما للمراجعة.</p></div>{viewer.canRequestRefunds&&payments.some(item=>item.status==='verified')&&<button className={styles.primary} onClick={()=>onModal({type:'refund',payment:payments.find(item=>item.status==='verified')})}>+ طلب استرداد</button>}</header>{refunds.length?<div className={styles.tableWrap}><table><thead><tr><th>الطلب</th><th>المبلغ</th><th>السبب</th><th>الحالة</th><th>التاريخ</th><th/></tr></thead><tbody>{refunds.map(refund=><tr key={refund.id}><td><b>{String(refund.id).slice(0,8)}</b><small>{refund.creditNoteId?'مرتبط بإشعار دائن':'يحتاج مراجعة الإشعار الدائن'}</small></td><td>{money(refund.amountMinor)}</td><td>{refund.reason}</td><td><Status value={refund.status}/></td><td>{date(refund.createdAt)}</td><td><div className={styles.rowActions}>{refund.status==='requested'&&viewer.canApproveRefunds&&<><button className={styles.issue} onClick={()=>onAct('approve-refund',{refundId:refund.id},'تم اعتماد الاسترداد')}>اعتماد</button><button onClick={()=>onAct('reject-refund',{refundId:refund.id},'تم رفض الاسترداد')}>رفض</button></>}{refund.status==='approved'&&viewer.canApproveRefunds&&<button onClick={()=>onAct('complete-refund',{refundId:refund.id},'تم إثبات تنفيذ الاسترداد')}>إثبات التنفيذ</button>}</div></td></tr>)}</tbody></table></div>:<Empty title="لا توجد استردادات أو تسويات" copy="عند الحاجة، يبدأ المسار بطلب ثم اعتماد ثم إثبات التنفيذ."/>}</section>;
}

function Incentives({value,slug}){
  return <><section className={styles.metrics}><Metric label="متوقع" value={money(value.expectedMinor)} copy="قبل تحقق شروط الاستحقاق"/><Metric label="معلق" value={money(value.pendingMinor)} copy="بانتظار اكتمال الشرط" tone="amber"/><Metric label="مستحق ومعتمد" value={money((Number(value.dueMinor)||0)+(Number(value.approvedMinor)||0))} copy="يحتاج مراجعة أو صرف" tone="purple"/><Metric label="مصروف" value={money(value.paidMinor)} copy="وفق دفتر الحوافز الحالي" tone="green"/></section><section className={styles.panel}><header><div><small>مصدر حقيقة واحد</small><h2>الحوافز لا تُنسخ داخل الحسابات</h2></div><Link className={styles.primary} href={`/tenant/${encodeURIComponent(slug)}/incentives`}>فتح إدارة الحوافز</Link></header><div className={styles.policy}><div><b>الأساس المقترح</b><p>صافي التحصيل المتحقق منه، بعد الخصم، وبدون ضريبة.</p></div><div><b>الاستحقاق</b><p>لا عمولة بمجرد إصدار فاتورة؛ تبدأ بعد تحقق الدفع.</p></div><div><b>الاسترداد</b><p>ينشئ عكسًا أو Clawback ولا يحذف سجل الحافز الأصلي.</p></div></div><p className={styles.footnote}>القيم أعلاه حُولت من وحدة الريال في دفتر الحوافز إلى الهللات في العرض المالي.</p></section></>;
}

function Reports({summary,documents,payments}){
  const issued=documents.filter(item=>item.status==='issued');
  const byMethod=Object.entries(payments.filter(item=>['verified','refunded'].includes(item.status)).reduce((result,item)=>({...result,[item.method]:(result[item.method]||0)+Number(item.amountMinor||0)}),{}));
  return <div className={styles.stack}><section className={styles.metrics}><Metric label="صافي المفوتر" value={money(summary.netInvoicedMinor)} copy="ليس اعترافًا محاسبيًا بالإيراد"/><Metric label="المحصل" value={money(summary.collectedMinor)} copy="بعد الاستردادات" tone="green"/><Metric label="ضريبة مخرجات تشغيلية" value={money(summary.taxInvoicedMinor)} copy="ملخص المستندات الصادرة" tone="purple"/><Metric label="الاسترداد" value={money(summary.refundedMinor)} copy="منفذ خلال الفترة" tone="red"/></section><section className={styles.twoColumns}><article className={styles.panel}><header><div><small>وسائل الدفع</small><h2>التحصيل حسب الوسيلة</h2></div></header>{byMethod.length?<div className={styles.breakdown}>{byMethod.map(([method,value])=><div key={method}><span>{METHOD_LABELS[method]||method}</span><b>{money(value)}</b></div>)}</div>:<Empty/>}</article><article className={styles.panel}><header><div><small>المستندات</small><h2>المستندات الصادرة</h2></div></header><div className={styles.breakdown}><div><span>فواتير</span><b>{issued.filter(item=>item.type==='invoice').length}</b></div><div><span>إشعارات دائنة</span><b>{issued.filter(item=>item.type==='credit_note').length}</b></div><div><span>إشعارات مدينة</span><b>{issued.filter(item=>item.type==='debit_note').length}</b></div><div><span>متأخر</span><b>{money(summary.overdueMinor)}</b></div></div></article></section><section className={styles.panel}><header><div><small>تنبيه منهجي</small><h2>نستخدم «المفوتر» و«المحصل» بدقة</h2></div></header><p className={styles.explainer}>هذه تقارير تشغيلية لحسابات العملاء، وليست ميزان مراجعة أو قائمة دخل قانونية. إضافة دفتر الأستاذ والمصروفات والموردين مرحلة مستقلة إذا رغبت في محاسبة مالية كاملة.</p></section></div>;
}

function Settings({profile,viewer,busy,onSave}){
  const [form,setForm]=useState(profile);
  const change=event=>{const {name,value,type,checked}=event.target;setForm(current=>({...current,[name]:type==='checkbox'?checked:value}));};
  return <section className={styles.panel}><header><div><small>سياسة موحدة</small><h2>الملف المالي الافتراضي</h2></div></header><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave(form).catch(()=>{});}}><Field label="الاسم القانوني" wide><input name="legalNameAr" value={form.legalNameAr||''} onChange={change}/></Field><Field label="السجل التجاري"><input name="commercialRegistrationNumber" value={form.commercialRegistrationNumber||''} onChange={change}/></Field><Field label="الرقم الضريبي"><input name="vatNumber" value={form.vatNumber||''} onChange={change}/></Field><Field label="العملة"><select name="baseCurrency" value={form.baseCurrency||'SAR'} onChange={change}><option value="SAR">SAR — ريال سعودي</option><option value="EGP">EGP — جنيه مصري</option><option value="USD">USD — دولار</option></select></Field><Field label="شروط السداد بالأيام"><input type="number" min="0" max="3650" name="defaultPaymentTermsDays" value={form.defaultPaymentTermsDays??0} onChange={change}/></Field><Field label="الضريبة الافتراضية %"><input type="number" min="0" max="100" step="0.01" value={(Number(form.defaultTaxRateBps)||0)/100} onChange={event=>setForm(current=>({...current,defaultTaxRateBps:Math.round(Number(event.target.value)*100)}))}/></Field><Field label="بادئة العرض"><input name="quotePrefix" value={form.quotePrefix||'Q'} onChange={change}/></Field><Field label="بادئة الفاتورة"><input name="invoicePrefix" value={form.invoicePrefix||'INV'} onChange={change}/></Field><Field label="بادئة الإيصال"><input name="receiptPrefix" value={form.receiptPrefix||'REC'} onChange={change}/></Field><Field label="المنطقة الزمنية"><input name="timezone" value={form.timezone||'Asia/Riyadh'} onChange={change}/></Field><label className={`${styles.check} ${styles.wide}`}><input type="checkbox" name="taxRegistered" checked={Boolean(form.taxRegistered)} onChange={change}/><span><b>المنشأة مسجلة ضريبيًا</b><small>هذا الإعداد يحسب الضريبة فقط؛ لا يعني توافق زاتكا.</small></span></label><label className={`${styles.check} ${styles.wide}`}><input type="checkbox" name="autoImportVerifiedAdmissions" checked={Boolean(form.autoImportVerifiedAdmissions)} onChange={change}/><span><b>السماح لاحقًا باستيراد دفعات التسجيل المتحققة</b><small>يظل مغلقًا افتراضيًا، ولا يوجد Trigger أو ترحيل تلقائي في هذا الإصدار.</small></span></label><footer className={styles.wide}><button className={styles.primary} disabled={!viewer.canManageSettings||Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ الإعدادات'}</button></footer></form></section>;
}

function Zatca({value,busy,onSave}){
  const config=value.configuration||{};const [form,setForm]=useState(config);const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));
  return <div className={styles.stack}><section className={`${styles.zatcaBanner} ${value.addonEnabled?styles.enabled:''}`}><div><span>{value.addonEnabled?'الإضافة مفعّلة':'الإضافة غير مفعّلة'}</span><h2>{value.addonEnabled?'جهّز الملف ثم اربط الموصل':'الحسابات الأساسية تعمل بدون زاتكا'}</h2><p>لن نصف أي فاتورة بأنها ضريبية إلكترونية متوافقة قبل وجود موصل فعلي وشهادة صالحة وقبول الاستجابة.</p></div><Status value={config.status||'not_connected'}/></section>{value.addonEnabled&&<section className={styles.panel}><header><div><small>بيانات تهيئة غير حساسة</small><h2>ملف المنشأة والفرع</h2></div></header><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave(form).catch(()=>{});}}><Field label="البيئة"><select name="environment" value={form.environment||'simulation'} onChange={change}><option value="simulation">محاكاة</option><option value="production">إنتاج — بعد الاعتماد</option></select></Field><Field label="الاسم القانوني"><input name="legalName" value={form.legalName||''} onChange={change} required/></Field><Field label="الرقم الضريبي"><input name="vatNumber" value={form.vatNumber||''} onChange={change} placeholder="15 رقمًا يبدأ وينتهي بـ3" required/></Field><Field label="اسم الفرع"><input name="branchName" value={form.branchName||''} onChange={change}/></Field><Field label="عنوان الفرع" wide><input name="branchAddress" value={form.branchAddress||''} onChange={change}/></Field><Field label="تصنيف النشاط"><input name="businessCategory" value={form.businessCategory||''} onChange={change}/></Field><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ ملف التهيئة'}</button></footer></form></section>}<section className={styles.panel}><header><div><small>سجل الاتصال</small><h2>آخر محاولات الإرسال</h2></div></header>{array(value.recentSubmissions).length?<div className={styles.tableWrap}><table><thead><tr><th>المستند</th><th>النوع</th><th>البيئة</th><th>الحالة</th><th>التاريخ</th></tr></thead><tbody>{value.recentSubmissions.map(item=><tr key={item.id}><td>{String(item.documentId).slice(0,8)}</td><td>{item.submissionKind}</td><td>{item.environment}</td><td><Status value={item.status}/></td><td>{date(item.createdAt)}</td></tr>)}</tbody></table></div>:<Empty title="لا توجد محاولات إرسال" copy="هذا طبيعي: موصل زاتكا غير مضمن في النواة، وسيضاف خلف نفس المستندات بعد الاختبار والاعتماد."/>}</section></div>;
}

function AccountForm({modal,candidates,busy,onClose,onSave}){
  const [form,setForm]=useState({contactId:modal.contactId||'',displayName:'',paymentTermsDays:0});const candidate=candidates.find(item=>item.id===form.contactId);const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));
  return <Modal title="حساب عميل جديد" copy="اربطه بعميل CRM أو أنشئ ملفًا يدويًا." onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({...form,displayName:form.displayName||candidate?.name}).catch(()=>{});}}><Field label="عميل CRM" wide><select name="contactId" value={form.contactId} onChange={change}><option value="">حساب يدوي</option>{candidates.map(item=><option key={item.id} value={item.id}>{item.name} {item.phone?`— ${item.phone}`:''}</option>)}</select></Field><Field label="اسم العميل" wide><input name="displayName" value={form.displayName} onChange={change} placeholder={candidate?.name||''} required={!candidate}/></Field><Field label="البريد"><input name="billingEmail" value={form.billingEmail||''} onChange={change}/></Field><Field label="الجوال"><input name="billingPhone" value={form.billingPhone||''} onChange={change}/></Field><Field label="الرقم الضريبي"><input name="taxNumber" value={form.taxNumber||''} onChange={change}/></Field><Field label="شروط السداد"><input type="number" name="paymentTermsDays" min="0" value={form.paymentTermsDays} onChange={change}/></Field><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>{busy?'جارٍ الحفظ…':'إنشاء الحساب'}</button></footer></form></Modal>;
}

function DocumentForm({modal,accounts,profile,busy,onClose,onSave}){
  const defaultTaxRate=(Number(profile.defaultTaxRateBps)||1500)/100;
  const newLine=()=>({id:commandId(),description:'',quantity:1,unitAmount:'',discount:'',taxCategory:'standard',taxRate:defaultTaxRate});
  const [form,setForm]=useState({customerAccountId:modal.customerAccountId||'',documentType:modal.documentType||'invoice',issueDate:today(),dueDate:'',validUntil:'',notes:''});
  const [lines,setLines]=useState(()=>[newLine()]);
  const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));
  const updateLine=(id,key,value)=>setLines(current=>current.map(line=>line.id===id?{...line,[key]:value}:line));
  const removeLine=id=>setLines(current=>current.length===1?current:current.filter(line=>line.id!==id));
  const isQuote=form.documentType==='quote';
  const totals=lines.reduce((result,line)=>{
    const base=Math.max(0,Number(line.quantity||0)*Number(line.unitAmount||0)-Number(line.discount||0));
    const tax=line.taxCategory==='standard'?base*Number(line.taxRate||0)/100:0;
    return {subtotal:result.subtotal+base,tax:result.tax+tax,total:result.total+base+tax};
  },{subtotal:0,tax:0,total:0});
  const save=event=>{
    event.preventDefault();
    onSave({
      documentType:form.documentType,
      customerAccountId:form.customerAccountId,
      issueDate:form.issueDate,
      dueDate:form.dueDate||null,
      validUntil:form.validUntil||null,
      notes:form.notes,
      lines:lines.map(line=>({
        description:line.description,
        quantity:Number(line.quantity),
        unitAmountMinor:minor(line.unitAmount),
        discountMinor:minor(line.discount),
        taxCategory:line.taxCategory,
        taxRateBps:line.taxCategory==='standard'?Math.round(Number(line.taxRate)*100):0
      }))
    }).catch(()=>{});
  };
  return <Modal title={isQuote?'عرض سعر جديد':'مستند مبيعات جديد'} copy="أضف كل البنود ثم راجع الإجمالي قبل حفظ المسودة." onClose={onClose}>
    <form className={styles.form} onSubmit={save}>
      <Field label="نوع المستند"><select name="documentType" value={form.documentType} onChange={change}><option value="quote">عرض سعر</option><option value="invoice">فاتورة</option><option value="credit_note">إشعار دائن</option><option value="debit_note">إشعار مدين</option></select></Field>
      <Field label="حساب العميل"><select name="customerAccountId" value={form.customerAccountId} onChange={change} required><option value="">اختر العميل</option>{accounts.filter(item=>item.status!=='closed').map(item=><option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field>
      <Field label="تاريخ المستند"><input type="date" name="issueDate" value={form.issueDate} onChange={change}/></Field>
      <Field label={isQuote?'صالح حتى':'تاريخ الاستحقاق'}><input type="date" name={isQuote?'validUntil':'dueDate'} value={isQuote?form.validUntil:form.dueDate} onChange={change}/></Field>
      <div className={`${styles.lineItems} ${styles.wide}`}>
        <header><div><b>بنود المستند</b><small>{lines.length} {lines.length===1?'بند':'بنود'}</small></div><button type="button" className={styles.secondary} onClick={()=>setLines(current=>[...current,newLine()])}>+ إضافة بند</button></header>
        {lines.map((line,index)=><article className={styles.lineCard} key={line.id}>
          <div className={styles.lineNumber}><span>{index+1}</span><button type="button" onClick={()=>removeLine(line.id)} disabled={lines.length===1} aria-label={`حذف البند ${index+1}`}>حذف</button></div>
          <label className={styles.lineDescription}><span>وصف البند</span><input value={line.description} onChange={event=>updateLine(line.id,'description',event.target.value)} required/></label>
          <label><span>الكمية</span><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={event=>updateLine(line.id,'quantity',event.target.value)} required/></label>
          <label><span>سعر الوحدة</span><input type="number" min="0" step="0.01" value={line.unitAmount} onChange={event=>updateLine(line.id,'unitAmount',event.target.value)} required/></label>
          <label><span>الخصم</span><input type="number" min="0" step="0.01" value={line.discount} onChange={event=>updateLine(line.id,'discount',event.target.value)}/></label>
          <label><span>التصنيف الضريبي</span><select value={line.taxCategory} onChange={event=>updateLine(line.id,'taxCategory',event.target.value)}><option value="standard">قياسي</option><option value="zero">صفري</option><option value="exempt">معفى</option><option value="out_of_scope">خارج النطاق</option></select></label>
          <label><span>الضريبة %</span><input type="number" min="0" max="100" step="0.01" value={line.taxRate} onChange={event=>updateLine(line.id,'taxRate',event.target.value)} disabled={line.taxCategory!=='standard'}/></label>
        </article>)}
      </div>
      <div className={`${styles.draftTotals} ${styles.wide}`}><span>قبل الضريبة <b>{money(minor(totals.subtotal))}</b></span><span>الضريبة <b>{money(minor(totals.tax))}</b></span><span>الإجمالي <strong>{money(minor(totals.total))}</strong></span></div>
      <Field label="ملاحظات" wide><textarea name="notes" value={form.notes} onChange={change}/></Field>
      <footer className={styles.wide}><button className={styles.primary} disabled={!accounts.length||Boolean(busy)}>{busy?'جارٍ الحفظ…':'حفظ المسودة'}</button></footer>
    </form>
  </Modal>;
}

function PaymentForm({accounts,busy,onClose,onSave}){const [form,setForm]=useState({customerAccountId:'',amount:'',method:'bank_transfer',receivedAt:today(),externalReference:'',verifyNow:false});const change=event=>setForm(current=>({...current,[event.target.name]:event.target.type==='checkbox'?event.target.checked:event.target.value}));return <Modal title="تسجيل دفعة" copy="تبدأ قيد التحقق ما لم تكن مخولًا واخترت الاعتماد الآن." onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({...form,amountMinor:minor(form.amount),receivedAt:new Date(`${form.receivedAt}T12:00:00`).toISOString()}).catch(()=>{});}}><Field label="العميل" wide><select name="customerAccountId" value={form.customerAccountId} onChange={change} required><option value="">اختر الحساب</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field><Field label="المبلغ (ريال)"><input type="number" min="0.01" step="0.01" name="amount" value={form.amount} onChange={change} required/></Field><Field label="الوسيلة"><select name="method" value={form.method} onChange={change}>{Object.entries(METHOD_LABELS).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></Field><Field label="تاريخ الاستلام"><input type="date" name="receivedAt" value={form.receivedAt} onChange={change}/></Field><Field label="المرجع"><input name="externalReference" value={form.externalReference} onChange={change}/></Field><label className={`${styles.check} ${styles.wide}`}><input type="checkbox" name="verifyNow" checked={form.verifyNow} onChange={change}/><span><b>اعتماد الدفعة الآن إن كانت صلاحياتي تسمح</b><small>وإلا ستظل بانتظار تحقق المالية.</small></span></label><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>{busy?'جارٍ التسجيل…':'تسجيل الدفعة'}</button></footer></form></Modal>}

function AllocationForm({payment,invoices,busy,onClose,onSave}){const eligible=invoices.filter(item=>item.status==='issued'&&item.customerAccountId===payment.customerAccountId&&Number(item.outstandingMinor)>0);const [form,setForm]=useState({invoiceId:eligible[0]?.id||'',amount:Math.max(0,Number(payment.unallocatedMinor||0)/100)});return <Modal title="توزيع الدفعة" copy={`المتاح ${money(payment.unallocatedMinor)}`} onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({paymentId:payment.id,invoiceId:form.invoiceId,amountMinor:minor(form.amount)}).catch(()=>{});}}><Field label="الفاتورة" wide><select value={form.invoiceId} onChange={event=>setForm(current=>({...current,invoiceId:event.target.value}))} required>{eligible.map(item=><option key={item.id} value={item.id}>{item.number} — متبقي {money(item.outstandingMinor)}</option>)}</select></Field><Field label="المبلغ (ريال)"><input type="number" min="0.01" step="0.01" value={form.amount} onChange={event=>setForm(current=>({...current,amount:event.target.value}))}/></Field><footer className={styles.wide}><button className={styles.primary} disabled={!eligible.length||Boolean(busy)}>تأكيد التوزيع</button></footer></form></Modal>}

function ScheduleForm({document,schedules,busy,onClose,onSave}){const existing=schedules.filter(item=>item.invoiceId===document.id);const used=existing.reduce((sum,item)=>sum+Number(item.amountMinor||0),0);const [form,setForm]=useState({installmentNumber:existing.length+1,dueDate:document.dueDate||today(),amount:Math.max(0,(Number(document.totalMinor)-used)/100),label:''});const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));return <Modal title="إضافة قسط" copy={`المتبقي للجدولة ${money(Number(document.totalMinor)-used)}`} onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({invoiceId:document.id,installmentNumber:Number(form.installmentNumber),dueDate:form.dueDate,amountMinor:minor(form.amount),label:form.label}).catch(()=>{});}}><Field label="رقم القسط"><input type="number" min="1" name="installmentNumber" value={form.installmentNumber} onChange={change}/></Field><Field label="تاريخ الاستحقاق"><input type="date" name="dueDate" value={form.dueDate} onChange={change} required/></Field><Field label="المبلغ (ريال)"><input type="number" min="0.01" step="0.01" name="amount" value={form.amount} onChange={change} required/></Field><Field label="الوصف"><input name="label" value={form.label} onChange={change} placeholder="دفعة أولى، قسط نهائي…"/></Field><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>حفظ القسط</button></footer></form></Modal>}

function CollectionForm({accounts,invoices,account,busy,onClose,onSave}){const [form,setForm]=useState({customerAccountId:account?.id||'',invoiceId:'',type:'note',summary:'',promisedDate:'',promisedAmount:'',nextActionAt:''});const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));return <Modal title="متابعة تحصيل" copy="سجل الاتصال أو وعد الدفع والإجراء التالي." onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({...form,invoiceId:form.invoiceId||null,promisedDate:form.promisedDate||null,promisedAmountMinor:form.promisedAmount?minor(form.promisedAmount):null,nextActionAt:form.nextActionAt?new Date(form.nextActionAt).toISOString():null}).catch(()=>{});}}><Field label="العميل"><select name="customerAccountId" value={form.customerAccountId} onChange={change} required><option value="">اختر</option>{accounts.map(item=><option key={item.id} value={item.id}>{item.displayName}</option>)}</select></Field><Field label="الفاتورة"><select name="invoiceId" value={form.invoiceId} onChange={change}><option value="">بدون فاتورة محددة</option>{invoices.filter(item=>!form.customerAccountId||item.customerAccountId===form.customerAccountId).map(item=><option key={item.id} value={item.id}>{item.number}</option>)}</select></Field><Field label="نوع المتابعة"><select name="type" value={form.type} onChange={change}><option value="note">ملاحظة</option><option value="call">مكالمة</option><option value="whatsapp">واتساب</option><option value="email">بريد</option><option value="payment_promise">وعد دفع</option></select></Field><Field label="ملخص" wide><textarea name="summary" value={form.summary} onChange={change} required/></Field>{form.type==='payment_promise'&&<><Field label="تاريخ الوعد"><input type="date" name="promisedDate" value={form.promisedDate} onChange={change} required/></Field><Field label="المبلغ"><input type="number" step="0.01" name="promisedAmount" value={form.promisedAmount} onChange={change}/></Field></>}<Field label="الإجراء التالي"><input type="datetime-local" name="nextActionAt" value={form.nextActionAt} onChange={change}/></Field><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>حفظ المتابعة</button></footer></form></Modal>}

function RefundForm({payment,invoices,busy,onClose,onSave}){const eligible=invoices.filter(item=>item.customerAccountId===payment.customerAccountId);const [form,setForm]=useState({amount:'',invoiceId:'',creditNoteId:'',reason:''});const change=event=>setForm(current=>({...current,[event.target.name]:event.target.value}));return <Modal title="طلب استرداد" copy={`من الدفعة ${payment.number} بقيمة ${money(payment.amountMinor)}`} onClose={onClose}><form className={styles.form} onSubmit={event=>{event.preventDefault();onSave({paymentId:payment.id,amountMinor:minor(form.amount),invoiceId:form.invoiceId||null,creditNoteId:form.creditNoteId||null,reason:form.reason}).catch(()=>{});}}><Field label="المبلغ (ريال)"><input type="number" min="0.01" step="0.01" max={Number(payment.amountMinor)/100} name="amount" value={form.amount} onChange={change} required/></Field><Field label="الفاتورة"><select name="invoiceId" value={form.invoiceId} onChange={change}><option value="">بدون ربط</option>{eligible.filter(item=>item.type==='invoice').map(item=><option key={item.id} value={item.id}>{item.number}</option>)}</select></Field><Field label="الإشعار الدائن"><select name="creditNoteId" value={form.creditNoteId} onChange={change}><option value="">لم يصدر بعد</option>{eligible.filter(item=>item.type==='credit_note'&&item.status==='issued').map(item=><option key={item.id} value={item.id}>{item.number}</option>)}</select></Field><Field label="السبب" wide><textarea name="reason" value={form.reason} onChange={change} required/></Field><footer className={styles.wide}><button className={styles.primary} disabled={Boolean(busy)}>إرسال للمراجعة</button></footer></form></Modal>}

function PrintSheet({document,profile,onClose}){return <div className={styles.printOverlay}><button onClick={onClose}>إغلاق المعاينة</button><article className={styles.printSheet}><header><div><small>{document.type==='quote'?'عرض سعر':'مستند مبيعات'}</small><h1>{document.number}</h1></div><div><b>{profile.legalNameAr||'المنشأة'}</b><span>{profile.vatNumber?`الرقم الضريبي: ${profile.vatNumber}`:''}</span></div></header><section><div><small>العميل</small><b>{document.customerName}</b></div><div><small>التاريخ</small><b>{date(document.issueDate)}</b></div><div><small>الاستحقاق / الصلاحية</small><b>{date(document.dueDate||document.validUntil)}</b></div></section><table><thead><tr><th>البند</th><th>الكمية</th><th>السعر</th><th>الضريبة</th><th>الإجمالي</th></tr></thead><tbody>{array(document.lines).map(line=><tr key={line.id||line.position}><td>{line.description}</td><td>{line.quantity}</td><td>{money(line.unitAmountMinor,document.currency)}</td><td>{money(line.taxMinor,document.currency)}</td><td>{money(line.totalMinor,document.currency)}</td></tr>)}</tbody></table><footer><div><span>قبل الضريبة</span><b>{money(Number(document.subtotalMinor)-Number(document.discountMinor),document.currency)}</b></div><div><span>الضريبة</span><b>{money(document.taxMinor,document.currency)}</b></div><div><span>الإجمالي</span><strong>{money(document.totalMinor,document.currency)}</strong></div></footer><p>مستند تشغيلي صادر من نظام الحسابات. لا يُعد متوافقًا مع زاتكا إلا إذا ظهرت حالة قبول رسمية من الموصل.</p></article></div>}
