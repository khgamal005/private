'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];

const TABS=[
  ['queue','صف الانتظار'],
  ['batches','دفعات الرفع'],
  ['assignments','سجل التوزيع'],
  ['analytics','المصادر والحملات'],
  ['team','فريق التوزيع']
];

const VALIDATION_LABELS={
  valid:'صالح',
  duplicate:'مكرر',
  invalid:'غير صالح'
};

const BATCH_STATUS={
  ready:'جاهزة للتوزيع',
  partially_distributed:'موزعة جزئيًا',
  distributed:'موزعة بالكامل',
  cancelled:'ملغاة',
  failed:'فشلت'
};

const STRATEGIES={
  fair:'توزيع عادل على الفريق المتاح',
  online_only:'مسؤولو المبيعات الأونلاين فقط',
  selected:'موظفون محددون'
};

const CHANNELS={
  online:'أونلاين',
  field:'ميداني',
  hybrid:'هجين'
};

const ALIASES={
  name:[
    'name','fullname','customername','leadname','studentname',
    'الاسم','اسمالعميل','اسمالطالب','اسمالمتدرب','العميل','الاسمالكامل'
  ],
  phone:[
    'phone','mobile','phonenumber','mobilenumber',
    'الهاتف','الجوال','رقمالهاتف','رقمالجوال','الموبايل'
  ],
  whatsapp:[
    'whatsapp','whatsappnumber','واتساب','رقمالواتساب'
  ],
  email:[
    'email','emailaddress','البريد','البريدالالكتروني','الايميل'
  ],
  organization:[
    'organization','company','center','institute',
    'المنشاه','الشركه','المركز','المعهد'
  ],
  program:[
    'program','course','programname','coursename',
    'البرنامج','الدوره','اسمالبرنامج','اسمالدوره'
  ],
  source:[
    'source','leadsource','utm_source','المصدر','مصدرالعميل'
  ],
  campaignName:[
    'campaign','campaignname','utm_campaign',
    'الحمله','اسمالحمله'
  ],
  adSetName:[
    'adset','adsetname','adgroup','مجموعهالاعلان','مجموعهالاعلانات'
  ],
  adName:[
    'ad','adname','creative','الاعلان','اسمالاعلان'
  ],
  notes:[
    'notes','comment','comments','ملاحظات','تعليق','التعليق'
  ]
};

function normalizeHeader(value){
  return String(value||'')
    .trim()
    .toLowerCase()
    .replace(/[أإآ]/g,'ا')
    .replace(/ة/g,'ه')
    .replace(/[^\p{L}\p{N}]+/gu,'');
}

const NORMALIZED_ALIASES=Object.fromEntries(
  Object.entries(ALIASES).map(([field,aliases])=>[
    field,
    new Set(aliases.map(normalizeHeader))
  ])
);

function cleanCell(value){
  if(value===null||value===undefined)return '';
  return String(value).trim();
}

function normalizeSheetRow(row){
  const normalized={};
  for(const [header,value] of Object.entries(row)){
    const key=normalizeHeader(header);
    for(const [field,aliases] of Object.entries(NORMALIZED_ALIASES)){
      if(aliases.has(key)&&!normalized[field]){
        normalized[field]=cleanCell(value);
        break;
      }
    }
  }
  return {
    name:normalized.name||'',
    phone:normalized.phone||'',
    whatsapp:normalized.whatsapp||'',
    email:normalized.email||'',
    organization:normalized.organization||'',
    program:normalized.program||'',
    source:normalized.source||'',
    campaignName:normalized.campaignName||'',
    adSetName:normalized.adSetName||'',
    adName:normalized.adName||'',
    notes:normalized.notes||''
  };
}

function localDateTime(hours=24){
  const date=new Date(Date.now()+hours*60*60*1000);
  const offset=date.getTimezoneOffset()*60*1000;
  return new Date(date.getTime()-offset).toISOString().slice(0,16);
}

function formatDate(value){
  if(!value)return '—';
  return new Date(value).toLocaleString('ar-SA',{
    day:'numeric',
    month:'short',
    hour:'2-digit',
    minute:'2-digit'
  });
}

function percent(value){
  return `${Number(value||0).toLocaleString('ar-SA',{maximumFractionDigits:1})}%`;
}

function number(value){
  return Number(value||0).toLocaleString('ar-SA');
}

function validationClass(value){
  if(value==='valid')return 'good';
  if(value==='duplicate')return 'warning';
  return 'danger';
}

function batchClass(value){
  if(value==='distributed')return 'good';
  if(value==='ready'||value==='partially_distributed')return 'warning';
  return value==='cancelled'?'muted':'danger';
}

async function readWorkbook(file){
  const imported=await import('xlsx');
  const XLSX=imported.default||imported;
  const buffer=await file.arrayBuffer();
  const workbook=XLSX.read(buffer,{type:'array',cellDates:true});
  const firstSheet=workbook.SheetNames[0];
  if(!firstSheet)throw new Error('ملف الشيت لا يحتوي على صفحة بيانات');
  const records=XLSX.utils.sheet_to_json(workbook.Sheets[firstSheet],{
    defval:'',
    raw:false
  });
  if(!records.length)throw new Error('لم يتم العثور على صفوف داخل الملف');
  if(records.length>5000)throw new Error('الحد الأقصى للملف الواحد 5000 صف');
  return records.map(normalizeSheetRow);
}

export default function LeadIntakeWorkspace({slug,initialData}){
  const router=useRouter();
  const [data,setData]=useState(initialData);
  const [tab,setTab]=useState('queue');
  const [batchFilter,setBatchFilter]=useState('all');
  const [validationFilter,setValidationFilter]=useState('all');
  const [query,setQuery]=useState('');
  const [selectedRows,setSelectedRows]=useState([]);
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState(false);
  const [parseBusy,setParseBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [upload,setUpload]=useState({
    file:null,
    rows:[],
    source:'meta',
    campaignName:'',
    adSetName:'',
    adName:''
  });
  const [distribution,setDistribution]=useState({
    batchId:'',
    rowIds:[],
    strategy:'fair',
    deadlineAt:localDateTime(),
    staffIds:[]
  });
  const [teamDrafts,setTeamDrafts]=useState({});

  useEffect(()=>{
    setData(initialData);
    setTeamDrafts(Object.fromEntries(
      (initialData.staff||EMPTY).map(staff=>[
        staff.id,
        {
          eligible:Boolean(staff.eligible),
          salesChannel:staff.salesChannel||'online',
          dailyCapacity:Number(staff.dailyCapacity)||50,
          weight:Number(staff.weight)||1
        }
      ])
    ));
  },[initialData]);

  const viewer=data.viewer||{};
  const batches=data.batches||EMPTY;
  const rows=data.rows||EMPTY;
  const assignments=data.assignments||EMPTY;
  const campaigns=data.campaigns||EMPTY;
  const staff=data.staff||EMPTY;
  const summary=data.summary||{};

  const awaitingRows=useMemo(
    ()=>rows.filter(row=>row.validationStatus==='valid'
      &&row.queueStatus==='awaiting_distribution'),
    [rows]
  );

  const shownRows=useMemo(()=>rows.filter(row=>{
    if(batchFilter!=='all'&&row.batchId!==batchFilter)return false;
    if(validationFilter==='awaiting'){
      if(row.queueStatus!=='awaiting_distribution')return false;
    }else if(validationFilter!=='all'
      &&row.validationStatus!==validationFilter){
      return false;
    }
    const haystack=[
      row.name,row.phone,row.whatsapp,row.email,row.programName,
      row.source,row.campaignName,row.adName,row.batchFileName
    ].join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }),[rows,batchFilter,validationFilter,query]);

  const selectableRows=shownRows.filter(
    row=>row.validationStatus==='valid'
      &&row.queueStatus==='awaiting_distribution'
  );

  async function call(action,payload){
    const response=await fetch('/api/tenant/lead-intake',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        p_tenant_slug:slug,
        p_action:action,
        p_payload:payload
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data;
  }

  function resetFeedback(){
    setMessage('');
    setError('');
  }

  function closeModal(){
    if(busy||parseBusy)return;
    setModal(null);
    setError('');
  }

  async function chooseFile(event){
    const file=event.target.files?.[0];
    if(!file)return;
    resetFeedback();
    setParseBusy(true);
    try{
      const parsedRows=await readWorkbook(file);
      setUpload(current=>({...current,file,rows:parsedRows}));
    }catch(fileError){
      setUpload(current=>({...current,file:null,rows:[]}));
      setError(fileError.message);
    }finally{
      setParseBusy(false);
    }
  }

  async function submitUpload(event){
    event.preventDefault();
    if(!upload.file||!upload.rows.length){
      setError('اختر ملف Excel أو CSV صالحًا أولًا');
      return;
    }
    setBusy(true);
    resetFeedback();
    try{
      const result=await call('import',{
        fileName:upload.file.name,
        rows:upload.rows,
        source:upload.source,
        campaignName:upload.campaignName,
        adSetName:upload.adSetName,
        adName:upload.adName
      });
      setMessage(
        `تم فحص ${number(result.totalRows)} صف: `
        +`${number(result.validRows)} صالح، `
        +`${number(result.duplicateRows)} مكرر، `
        +`${number(result.invalidRows)} غير صالح.`
      );
      setUpload({
        file:null,
        rows:[],
        source:'meta',
        campaignName:'',
        adSetName:'',
        adName:''
      });
      setModal(null);
      setTab('queue');
      setBatchFilter(result.batchId);
      router.refresh();
    }catch(submitError){
      setError(submitError.message);
    }finally{
      setBusy(false);
    }
  }

  function openDistribution(batchId,rowIds=[]){
    resetFeedback();
    setDistribution({
      batchId,
      rowIds,
      strategy:'fair',
      deadlineAt:localDateTime(),
      staffIds:[]
    });
    setModal('distribute');
  }

  async function submitDistribution(event){
    event.preventDefault();
    if(distribution.strategy==='selected'
      &&!distribution.staffIds.length){
      setError('اختر مسؤول مبيعات واحدًا على الأقل');
      return;
    }
    setBusy(true);
    resetFeedback();
    try{
      const result=await call('distribute',{
        batchId:distribution.batchId,
        rowIds:distribution.rowIds,
        strategy:distribution.strategy,
        deadlineAt:new Date(distribution.deadlineAt).toISOString(),
        staffIds:distribution.staffIds
      });
      const distributedCount=Number(result.distributed)||0;
      const duplicateCount=Number(result.duplicatesSkipped)||0;
      setMessage(
        distributedCount&&duplicateCount
          ?`تم توزيع ${number(distributedCount)} عميل جديد على ${number(result.teamSize)} من فريق المبيعات، ومنع إنشاء سجل مكرر لـ ${number(duplicateCount)} عميل موجود مسبقًا.`
          :distributedCount
            ?`تم توزيع ${number(distributedCount)} عميل على ${number(result.teamSize)} من فريق المبيعات.`
            :duplicateCount
              ?`لم يُنشأ أي عميل جديد؛ وُجد ${number(duplicateCount)} عميل مسبقًا وأُبقي كل سجل على مسؤول المبيعات الحالي.`
              :'لم يتم توزيع صفوف؛ راجع الطاقة اليومية أو حالة الدفعة.'
      );
      setSelectedRows([]);
      setModal(null);
      setTab('assignments');
      router.refresh();
    }catch(distributionError){
      setError(distributionError.message);
    }finally{
      setBusy(false);
    }
  }

  async function cancelBatch(batchId){
    if(!window.confirm('هل تريد إلغاء هذه الدفعة قبل توزيعها؟'))return;
    setBusy(true);
    resetFeedback();
    try{
      await call('cancel_batch',{batchId});
      setMessage('تم إلغاء الدفعة وإزالتها من صف التوزيع.');
      router.refresh();
    }catch(cancelError){
      setError(cancelError.message);
    }finally{
      setBusy(false);
    }
  }

  async function saveProfile(staffId){
    const draft=teamDrafts[staffId];
    if(!draft)return;
    setBusy(true);
    resetFeedback();
    try{
      await call('save_profile',{staffId,...draft});
      setMessage('تم تحديث إعدادات فريق التوزيع.');
      router.refresh();
    }catch(profileError){
      setError(profileError.message);
    }finally{
      setBusy(false);
    }
  }

  function toggleRow(row){
    setSelectedRows(current=>{
      if(current.includes(row.id)){
        return current.filter(id=>id!==row.id);
      }
      const selectedBatch=rows.find(item=>current.includes(item.id))?.batchId;
      if(selectedBatch&&selectedBatch!==row.batchId)return [row.id];
      return [...current,row.id];
    });
  }

  function toggleVisibleRows(){
    const ids=selectableRows.map(row=>row.id);
    const allSelected=ids.length&&ids.every(id=>selectedRows.includes(id));
    if(allSelected){
      setSelectedRows(current=>current.filter(id=>!ids.includes(id)));
      return;
    }
    const firstBatch=selectableRows[0]?.batchId;
    setSelectedRows(selectableRows
      .filter(row=>row.batchId===firstBatch)
      .map(row=>row.id));
  }

  const selectedBatchId=rows.find(
    row=>selectedRows.includes(row.id)
  )?.batchId;

  return <>
    <header className="mt-page-head">
      <div>
        <small>LEAD INTAKE & DISTRIBUTION</small>
        <h2>استقبال وتوزيع العملاء</h2>
        <p>من ملف الإعلان إلى مسؤول المبيعات، مع جودة البيانات وموعد متابعة قابل للقياس.</p>
      </div>
      <div className="mt-page-actions">
        {viewer.canImport&&<a
          className="mt-button"
          href="/templates/marktone-lead-intake-template.xlsx"
          download
        >تحميل ملف مثال</a>}
        {viewer.canImport&&<button
          className="mt-button soft"
          onClick={()=>{resetFeedback();setModal('upload')}}
        >رفع ملف عملاء</button>}
        {viewer.canDistribute&&selectedRows.length>0&&<button
          className="mt-button primary"
          onClick={()=>openDistribution(selectedBatchId,selectedRows)}
        >توزيع المحدد ({number(selectedRows.length)})</button>}
      </div>
    </header>

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}

    <section className="mt-kpis mt-lead-intake-kpis">
      <article className="mt-kpi">
        <span>في انتظار التوزيع</span>
        <b>{number(summary.awaitingDistribution)}</b>
        <small>بيانات صالحة لم تتحول إلى CRM بعد</small>
      </article>
      <article className="mt-kpi">
        <span>وُزّع اليوم</span>
        <b>{number(summary.distributedToday)}</b>
        <small>تم إنشاء مهمة وموعد لكل عميل</small>
      </article>
      <article className="mt-kpi warning">
        <span>بيانات مكررة</span>
        <b>{number(summary.duplicateRows)}</b>
        <small>داخل الملفات أو موجودة مسبقًا</small>
      </article>
      <article className="mt-kpi danger">
        <span>بيانات غير صالحة</span>
        <b>{number(summary.invalidRows)}</b>
        <small>اسم أو رقم أو بريد يحتاج تصحيحًا</small>
      </article>
      <article className="mt-kpi danger">
        <span>متابعة أولى متأخرة</span>
        <b>{number(summary.overdueFirstActions)}</b>
        <small>تجاوزت الموعد دون نشاط فعلي</small>
      </article>
      <article className="mt-kpi">
        <span>متوسط أول استجابة</span>
        <b>{number(summary.averageFirstResponseMinutes)} د</b>
        <small>من لحظة التوزيع لأول تواصل</small>
      </article>
    </section>

    <nav className="mt-section-tabs mt-lead-intake-tabs">
      {TABS.filter(([key])=>key!=='analytics'||viewer.canAnalytics)
        .filter(([key])=>key!=='team'||viewer.canDistribute)
        .map(([key,label])=><button
          key={key}
          className={tab===key?'active':''}
          onClick={()=>setTab(key)}
        >{label}</button>)}
    </nav>

    {tab==='queue'&&<section className="mt-panel">
      <div className="mt-toolbar mt-lead-queue-toolbar">
        <input
          className="mt-search"
          placeholder="ابحث بالاسم أو الرقم أو الحملة..."
          value={query}
          onChange={event=>setQuery(event.target.value)}
        />
        <select
          value={batchFilter}
          onChange={event=>{
            setBatchFilter(event.target.value);
            setSelectedRows([]);
          }}
        >
          <option value="all">كل دفعات الرفع</option>
          {batches.map(batch=><option key={batch.id} value={batch.id}>
            {batch.fileName} — {batch.campaignName||batch.source}
          </option>)}
        </select>
        <select
          value={validationFilter}
          onChange={event=>{
            setValidationFilter(event.target.value);
            setSelectedRows([]);
          }}
        >
          <option value="all">كل حالات الجودة</option>
          <option value="awaiting">جاهز للتوزيع فقط</option>
          <option value="valid">صالح</option>
          <option value="duplicate">مكرر</option>
          <option value="invalid">غير صالح</option>
        </select>
      </div>
      <div className="mt-table-wrap">
        <table className="mt-table mt-lead-queue-table">
          <thead><tr>
            <th>
              {viewer.canDistribute&&<input
                type="checkbox"
                aria-label="تحديد الصفوف الظاهرة"
                checked={Boolean(selectableRows.length)
                  &&selectableRows.every(row=>selectedRows.includes(row.id))}
                onChange={toggleVisibleRows}
              />}
            </th>
            <th>العميل</th>
            <th>التواصل</th>
            <th>المصدر والحملة</th>
            <th>البرنامج</th>
            <th>جودة الصف</th>
            <th>الحالة</th>
          </tr></thead>
          <tbody>
            {shownRows.map(row=><tr key={row.id}>
              <td>
                {viewer.canDistribute
                  &&row.validationStatus==='valid'
                  &&row.queueStatus==='awaiting_distribution'
                  ?<input
                    type="checkbox"
                    checked={selectedRows.includes(row.id)}
                    onChange={()=>toggleRow(row)}
                    aria-label={`تحديد ${row.name}`}
                  />
                  :<span>—</span>}
              </td>
              <td>
                <b>{row.name||'اسم غير موجود'}</b>
                <small>{row.organizationName||row.batchFileName}</small>
              </td>
              <td>
                <b dir="ltr">{row.phone||row.whatsapp||'—'}</b>
                <small>{row.email||'لا يوجد بريد'}</small>
              </td>
              <td>
                <b>{row.campaignName||row.source||'غير محدد'}</b>
                <small>{row.adSetName||row.adName||'بدون إعلان محدد'}</small>
              </td>
              <td>{row.programName||'—'}</td>
              <td>
                <span className={`mt-status ${validationClass(row.validationStatus)}`}>
                  {VALIDATION_LABELS[row.validationStatus]}
                </span>
                <small>{row.validationErrors?.join('، ')||'اجتاز الفحص'}</small>
              </td>
              <td>
                {row.queueStatus==='awaiting_distribution'
                  ?<span className="mt-status warning">في الانتظار</span>
                  :row.queueStatus==='assigned'
                    ?<span className="mt-status good">تم التوزيع</span>
                    :<span className="mt-status">مستبعد</span>}
              </td>
            </tr>)}
          </tbody>
        </table>
        {!shownRows.length&&<div className="mt-empty">لا توجد صفوف مطابقة للفلاتر الحالية.</div>}
      </div>
    </section>}

    {tab==='batches'&&<section className="mt-lead-batch-grid">
      {batches.map(batch=><article key={batch.id} className="mt-lead-batch-card">
        <header>
          <div>
            <small>{batch.source}</small>
            <h3>{batch.fileName}</h3>
            <p>{batch.campaignName||'بدون اسم حملة'} · {formatDate(batch.createdAt)}</p>
          </div>
          <span className={`mt-status ${batchClass(batch.status)}`}>
            {BATCH_STATUS[batch.status]||batch.status}
          </span>
        </header>
        <dl>
          <div><dt>إجمالي الصفوف</dt><dd>{number(batch.totalRows)}</dd></div>
          <div><dt>صالح</dt><dd>{number(batch.validRows)}</dd></div>
          <div><dt>مكرر</dt><dd>{number(batch.duplicateRows)}</dd></div>
          <div><dt>غير صالح</dt><dd>{number(batch.invalidRows)}</dd></div>
          <div><dt>تم توزيعه</dt><dd>{number(batch.distributedRows)}</dd></div>
          <div><dt>في الانتظار</dt><dd>{number(batch.awaitingRows)}</dd></div>
        </dl>
        <div className="mt-batch-progress">
          <div><span>نسبة التوزيع</span><b>
            {batch.validRows
              ?percent((batch.distributedRows/batch.validRows)*100)
              :'0%'}
          </b></div>
          <progress
            value={batch.distributedRows}
            max={Math.max(batch.validRows,1)}
          />
        </div>
        <footer>
          <small>رفعها: {batch.importerName||'مستخدم النظام'}</small>
          <div>
            {viewer.canDistribute&&batch.awaitingRows>0&&<button
              className="mt-button primary"
              onClick={()=>openDistribution(batch.id)}
            >توزيع الدفعة</button>}
            {viewer.canImport&&batch.distributedRows===0
              &&!['cancelled','distributed'].includes(batch.status)
              &&<button
                className="mt-button"
                disabled={busy}
                onClick={()=>cancelBatch(batch.id)}
              >إلغاء</button>}
          </div>
        </footer>
      </article>)}
      {!batches.length&&<div className="mt-empty">لم يتم رفع أي ملفات عملاء بعد.</div>}
    </section>}

    {tab==='assignments'&&<section className="mt-panel">
      <div className="mt-panel-head">
        <div>
          <h3>سجل توزيع العملاء</h3>
          <p>دليل الإسناد والموعد وأول استجابة لكل عميل.</p>
        </div>
      </div>
      <div className="mt-table-wrap">
        <table className="mt-table">
          <thead><tr>
            <th>العميل</th>
            <th>المسؤول</th>
            <th>طريقة التوزيع</th>
            <th>موعد أول متابعة</th>
            <th>أول استجابة</th>
            <th>نتيجة العميل</th>
          </tr></thead>
          <tbody>
            {assignments.map(assignment=><tr key={assignment.id}>
              <td>
                <b>{assignment.contactName}</b>
                <small dir="ltr">{assignment.phone||'—'}</small>
              </td>
              <td>
                <b>{assignment.assignedStaffName}</b>
                <small>بواسطة {assignment.assignedByName||'إدارة المنشأة'}</small>
              </td>
              <td>{STRATEGIES[assignment.strategy]||assignment.strategy}</td>
              <td>
                <b>{formatDate(assignment.deadlineAt)}</b>
                {assignment.overdue&&<small className="mt-text-danger">متأخر دون تواصل</small>}
              </td>
              <td>
                {assignment.firstActionAt
                  ?<><b>{formatDate(assignment.firstActionAt)}</b>
                    <small>{number(assignment.responseMinutes)} دقيقة</small></>
                  :<span className={`mt-status ${assignment.overdue?'danger':'warning'}`}>
                    لم يبدأ
                  </span>}
              </td>
              <td>
                <b>{assignment.leadStatus}</b>
                <small>{assignment.leadQuality}</small>
              </td>
            </tr>)}
          </tbody>
        </table>
        {!assignments.length&&<div className="mt-empty">لا يوجد توزيع مسجل بعد.</div>}
      </div>
    </section>}

    {tab==='analytics'&&viewer.canAnalytics&&<section className="mt-panel">
      <div className="mt-panel-head">
        <div>
          <h3>جودة المصادر والحملات</h3>
          <p>التحليل مبني على الصفوف المستوردة والنتيجة الفعلية الحالية داخل CRM.</p>
        </div>
      </div>
      <div className="mt-table-wrap">
        <table className="mt-table mt-campaign-table">
          <thead><tr>
            <th>المصدر / الحملة</th>
            <th>الإعلان</th>
            <th>الإجمالي</th>
            <th>مكرر / غير صالح</th>
            <th>تم التواصل</th>
            <th>مؤهل</th>
            <th>مدفوع</th>
            <th>جودة سيئة</th>
            <th>التحويل</th>
            <th>سرعة الاستجابة</th>
          </tr></thead>
          <tbody>
            {campaigns.map((campaign,index)=><tr key={`${campaign.source}-${campaign.campaignName}-${campaign.adName}-${index}`}>
              <td>
                <b>{campaign.campaignName}</b>
                <small>{campaign.source}</small>
              </td>
              <td>
                <b>{campaign.adName}</b>
                <small>{campaign.adSetName}</small>
              </td>
              <td>{number(campaign.totalRows)}</td>
              <td>
                <b>{number(campaign.duplicateRows+campaign.invalidRows)}</b>
                <small>{number(campaign.wrongNumberRows)} رقم خاطئ بعد التواصل</small>
              </td>
              <td>{number(campaign.contactedRows)}</td>
              <td>
                <b>{number(campaign.qualifiedRows)}</b>
                <small>{percent(campaign.qualificationRate)}</small>
              </td>
              <td>{number(campaign.paidRows)}</td>
              <td><span className={`mt-status ${Number(campaign.badDataRate)>30?'danger':'warning'}`}>
                {percent(campaign.badDataRate)}
              </span></td>
              <td><span className="mt-status good">{percent(campaign.conversionRate)}</span></td>
              <td>{campaign.averageFirstResponseMinutes===null
                ?'—'
                :`${number(campaign.averageFirstResponseMinutes)} د`}</td>
            </tr>)}
          </tbody>
        </table>
        {!campaigns.length&&<div className="mt-empty">ستظهر التحليلات بعد أول دفعة رفع.</div>}
      </div>
    </section>}

    {tab==='team'&&viewer.canDistribute&&<section className="mt-distribution-team-grid">
      {staff.map(member=>{
        const draft=teamDrafts[member.id]||{};
        return <article key={member.id}>
          <header>
            <div>
              <h3>{member.name}</h3>
              <p>{member.jobTitle||'فريق المبيعات'}</p>
            </div>
            <span className={`mt-status ${draft.eligible?'good':'muted'}`}>
              {draft.eligible?'متاح للتوزيع':'موقوف'}
            </span>
          </header>
          <div className="mt-team-load">
            <div><span>بانتظار أول تواصل</span><b>{number(member.activeAssignments)}</b></div>
            <div><span>متأخر</span><b>{number(member.overdueAssignments)}</b></div>
          </div>
          <label className="mt-check">
            <input
              type="checkbox"
              checked={Boolean(draft.eligible)}
              onChange={event=>setTeamDrafts(current=>({
                ...current,
                [member.id]:{...draft,eligible:event.target.checked}
              }))}
            />
            يدخل في التوزيع العادل
          </label>
          <div className="mt-team-profile-fields">
            <label>نوع المبيعات
              <select
                value={draft.salesChannel||'online'}
                onChange={event=>setTeamDrafts(current=>({
                  ...current,
                  [member.id]:{...draft,salesChannel:event.target.value}
                }))}
              >
                {Object.entries(CHANNELS).map(([value,label])=>
                  <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>الطاقة اليومية
              <input
                type="number"
                min="1"
                max="1000"
                value={draft.dailyCapacity||50}
                onChange={event=>setTeamDrafts(current=>({
                  ...current,
                  [member.id]:{
                    ...draft,
                    dailyCapacity:Number(event.target.value)
                  }
                }))}
              />
            </label>
            <label>وزن التوزيع
              <input
                type="number"
                min="1"
                max="10"
                value={draft.weight||1}
                onChange={event=>setTeamDrafts(current=>({
                  ...current,
                  [member.id]:{...draft,weight:Number(event.target.value)}
                }))}
              />
            </label>
          </div>
          <button
            className="mt-button primary"
            disabled={busy}
            onClick={()=>saveProfile(member.id)}
          >حفظ إعدادات الموظف</button>
        </article>;
      })}
      {!staff.length&&<div className="mt-empty">أضف مسؤولي المبيعات إلى فريق المنشأة أولًا.</div>}
    </section>}

    {modal==='upload'&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" onClick={closeModal} aria-label="إغلاق"/>
      <form className="mt-modal mt-lead-upload-modal" onSubmit={submitUpload}>
        <header>
          <div><small>DATA OFFICER</small><h3>رفع ملف العملاء المهتمين</h3></div>
          <button type="button" onClick={closeModal}>×</button>
        </header>
        <div className="mt-form">
          <div className="mt-template-download">
            <div>
              <b>ابدأ من ملف مثال جاهز</b>
              <small>
                يحتوي على اسم الدورة والإعلان والحملة وبيانات الطالب بالأعمدة التي يقرأها النظام تلقائيًا.
              </small>
            </div>
            <a
              className="mt-button soft"
              href="/templates/marktone-lead-intake-template.xlsx"
              download
            >تحميل قالب Excel</a>
          </div>
          <label className="mt-field wide mt-file-drop">
            <span>{parseBusy?'جارٍ قراءة الملف...':'اختر Excel أو CSV'}</span>
            <input
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={chooseFile}
              disabled={parseBusy||busy}
            />
            <small>
              يتعرف تلقائيًا على الاسم، الجوال، واتساب، البريد، البرنامج، المصدر والحملة.
            </small>
          </label>
          <label className="mt-field">المصدر الافتراضي
            <select
              value={upload.source}
              onChange={event=>setUpload(current=>({
                ...current,source:event.target.value
              }))}
            >
              <option value="meta">Meta</option>
              <option value="google">Google</option>
              <option value="tiktok">TikTok</option>
              <option value="snapchat">Snapchat</option>
              <option value="website">الموقع</option>
              <option value="whatsapp">واتساب</option>
              <option value="referral">ترشيحات</option>
              <option value="sheet_import">ملف خارجي</option>
            </select>
          </label>
          <label className="mt-field">اسم الحملة
            <input
              value={upload.campaignName}
              onChange={event=>setUpload(current=>({
                ...current,campaignName:event.target.value
              }))}
              placeholder="مثال: حملة PMP أغسطس"
            />
          </label>
          <label className="mt-field">مجموعة الإعلانات
            <input
              value={upload.adSetName}
              onChange={event=>setUpload(current=>({
                ...current,adSetName:event.target.value
              }))}
              placeholder="مثال: المهتمون بإدارة المشاريع"
            />
          </label>
          <label className="mt-field">اسم الإعلان
            <input
              value={upload.adName}
              onChange={event=>setUpload(current=>({
                ...current,adName:event.target.value
              }))}
              placeholder="مثال: طوّر مسارك المهني"
            />
          </label>
        </div>
        {upload.rows.length>0&&<section className="mt-upload-preview">
          <header>
            <b>معاينة القراءة</b>
            <span>{number(upload.rows.length)} صف</span>
          </header>
          <div className="mt-table-wrap">
            <table className="mt-table">
              <thead><tr><th>الاسم</th><th>الجوال</th><th>البرنامج</th><th>الحملة</th></tr></thead>
              <tbody>{upload.rows.slice(0,6).map((row,index)=><tr key={index}>
                <td>{row.name||'—'}</td>
                <td dir="ltr">{row.phone||row.whatsapp||'—'}</td>
                <td>{row.program||'—'}</td>
                <td>{row.campaignName||upload.campaignName||'—'}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>}
        {error&&<div className="mt-alert error mt-modal-alert">{error}</div>}
        <footer>
          <button className="mt-button primary" disabled={busy||parseBusy||!upload.rows.length}>
            {busy?'جارٍ الفحص والرفع...':'فحص وإضافة إلى Queue'}
          </button>
          <button className="mt-button" type="button" onClick={closeModal}>إلغاء</button>
        </footer>
      </form>
    </div>}

    {modal==='distribute'&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" onClick={closeModal} aria-label="إغلاق"/>
      <form className="mt-modal" onSubmit={submitDistribution}>
        <header>
          <div><small>SALES SUPERVISION</small><h3>توزيع العملاء على فريق المبيعات</h3></div>
          <button type="button" onClick={closeModal}>×</button>
        </header>
        <div className="mt-form">
          <label className="mt-field wide">طريقة التوزيع
            <select
              value={distribution.strategy}
              onChange={event=>setDistribution(current=>({
                ...current,
                strategy:event.target.value,
                staffIds:[]
              }))}
            >
              {Object.entries(STRATEGIES).map(([value,label])=>
                <option key={value} value={value}>{label}</option>)}
            </select>
            <small>
              العادل يوازن الحمل الحالي ووزن الموظف وطاقة اليوم. الأونلاين يستبعد الفريق الميداني.
            </small>
          </label>
          <label className="mt-field wide">آخر موعد لأول متابعة
            <input
              required
              type="datetime-local"
              min={localDateTime(0.1)}
              value={distribution.deadlineAt}
              onChange={event=>setDistribution(current=>({
                ...current,deadlineAt:event.target.value
              }))}
            />
            <small>سيُنشأ موعد ومهمة مستقلة لكل عميل، ويُقاس التأخير حتى أول نشاط فعلي.</small>
          </label>
          {distribution.strategy==='selected'&&<fieldset className="mt-field wide mt-employee-picker">
            <legend>اختر الموظفين</legend>
            {staff.map(member=><label key={member.id}>
              <input
                type="checkbox"
                checked={distribution.staffIds.includes(member.id)}
                onChange={event=>setDistribution(current=>({
                  ...current,
                  staffIds:event.target.checked
                    ?[...current.staffIds,member.id]
                    :current.staffIds.filter(id=>id!==member.id)
                }))}
              />
              <span>
                <b>{member.name}</b>
                <small>
                  {CHANNELS[member.salesChannel]} · {number(member.activeAssignments)} بانتظار التواصل
                </small>
              </span>
            </label>)}
          </fieldset>}
          <section className="mt-distribution-summary">
            <div><span>نطاق التوزيع</span><b>
              {distribution.rowIds.length
                ?`${number(distribution.rowIds.length)} عميل محدد`
                :'كل العملاء الجاهزين في الدفعة'}
            </b></div>
            <div><span>الفريق المتاح</span><b>{number(staff.filter(member=>member.eligible).length)}</b></div>
          </section>
        </div>
        {error&&<div className="mt-alert error mt-modal-alert">{error}</div>}
        <footer>
          <button className="mt-button primary" disabled={busy}>
            {busy?'جارٍ التوزيع...':'تأكيد التوزيع والموعد'}
          </button>
          <button className="mt-button" type="button" onClick={closeModal}>إلغاء</button>
        </footer>
      </form>
    </div>}
  </>;
}
