'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

const EMPTY=[];
const STATUS={active:'مفعّلة',paused:'متوقفة مؤقتًا',draft:'مسودة'};
const RUN_STATUS={
  processing:'قيد المعالجة',
  previewed:'معاينة فقط',
  queued:'أُضيف للطابور',
  skipped:'تخطّاها النظام',
  completed:'اكتملت',
  failed:'فشلت'
};
const CHANNEL={
  auto:'تلقائي',
  whatsapp:'واتساب',
  email:'البريد',
  none:'بلا قناة بديلة'
};

export default function AutomationStudio({slug,initialData}){
  const router=useRouter();
  const data=initialData||{};
  const rules=data.rules||EMPTY;
  const runs=data.recentRuns||EMPTY;
  const summary=data.summary||{};
  const [editing,setEditing]=useState(null);
  const [preview,setPreview]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  if(data.locked)return <section className="mt-addon-locked">
    <span>◇</span><div><h3>إضافة الأتمتة غير مفعّلة</h3><p>فعّلها من «الإضافات والاشتراك» أو اطلب تجربة؛ لا توجد قواعد تعمل في الخلفية حاليًا.</p></div>
  </section>;

  async function action(name,payload={}){
    const response=await fetch('/api/tenant/automation-studio',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        p_slug:slug,
        p_action:name,
        p_payload:payload
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ الأتمتة');
    return result.data;
  }

  async function toggle(rule){
    setBusy(`toggle-${rule.id}`);setError('');setNotice('');
    try{
      await action('toggle_rule',{
        ruleId:rule.id,
        enabled:rule.status!=='active'
      });
      setNotice(rule.status==='active'
        ?'تم إيقاف القاعدة دون حذف إعداداتها.'
        :'تم تفعيل القاعدة وأصبحت تستقبل الأحداث الجديدة.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function save(event){
    event.preventDefault();
    if(!editing)return;
    setBusy('save');setError('');setNotice('');
    const values=Object.fromEntries(new FormData(event.currentTarget));
    try{
      await action('save_rule',{
        ruleId:editing.id,
        executionMode:values.executionMode,
        primaryChannel:values.primaryChannel,
        fallbackChannel:values.fallbackChannel,
        delayMinutes:Number(values.delayMinutes||0)
      });
      setEditing(null);
      setNotice('تم حفظ مسار التنفيذ والقناة البديلة.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function runPreview(rule){
    setBusy(`preview-${rule.id}`);setError('');setNotice('');
    try{
      const result=await action('preview_rule',{ruleId:rule.id});
      setPreview({...result,ruleName:rule.name});
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function processNow(){
    setBusy('process');setError('');setNotice('');
    try{
      const result=await action('process_now');
      const processed=result.processed||{};
      setNotice(
        `عولج ${processed.events||0} حدث، وجُهزت `
        +`${processed.jobs||0} رسالة دون تجاوز منع التكرار.`
      );
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  return <section className="mt-automation-studio">
    <section className="mt-kpis mt-automation-studio-kpis">
      <article className="mt-kpi success"><span>القواعد المفعلة</span><b>{summary.activeRules||0}</b><small>تعمل على أحداث النظام الحقيقية</small></article>
      <article className="mt-kpi"><span>قيد المعالجة</span><b>{summary.pendingEvents||0}</b><small>أحداث محمية من التكرار</small></article>
      <article className="mt-kpi"><span>رسائل الطابور</span><b>{summary.queuedMessages||0}</b><small>تشمل انتظار إعداد المزود</small></article>
      <article className="mt-kpi"><span>وضع المعاينة</span><b>{summary.previewRules||0}</b><small>لا يرسل إلى أي مستفيد</small></article>
    </section>

    <section className="mt-automation-explainer">
      <div><span>1</span><b>عند حدوث</b><small>دفع، تسجيل، غياب أو شهادة</small></div>
      <i>←</i>
      <div><span>2</span><b>نفّذ القاعدة</b><small>فورًا أو بعد مدة محددة</small></div>
      <i>←</i>
      <div><span>3</span><b>أرسل بأمان</b><small>مع قناة بديلة ومنع التكرار</small></div>
      <button className="mt-button primary" onClick={processNow} disabled={Boolean(busy)}>
        {busy==='process'?'جارٍ المعالجة…':'معالجة الطابور الآن'}
      </button>
    </section>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&!editing&&<div className="mt-alert error">{error}</div>}

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented"><span>قواعد دورة المتدرب</span></div>
        <small>كل قاعدة مستقلة وقابلة للتحويل إلى إضافة منفصلة لاحقًا</small>
      </div>
      <div className="mt-automation-rule-grid">
        {rules.map(rule=><article className={`mt-automation-rule ${rule.status}`} key={rule.id}>
          <header>
            <div><small>{rule.triggerKey}</small><h4>{rule.name}</h4></div>
            <button
              className={`mt-rule-switch ${rule.status==='active'?'on':''}`}
              onClick={()=>toggle(rule)}
              disabled={Boolean(busy)}
              aria-label={rule.status==='active'?'إيقاف القاعدة':'تفعيل القاعدة'}
              aria-pressed={rule.status==='active'}
            ><span/></button>
          </header>
          <p>{rule.description}</p>
          <dl>
            <div><dt>الحالة</dt><dd>{STATUS[rule.status]||rule.status}</dd></div>
            <div><dt>التنفيذ</dt><dd>{rule.executionMode==='preview'?'معاينة آمنة':'تشغيل فعلي'}</dd></div>
            <div><dt>القناة</dt><dd>{CHANNEL[rule.primaryChannel]||rule.primaryChannel}</dd></div>
            <div><dt>البديل</dt><dd>{CHANNEL[rule.fallbackChannel]||rule.fallbackChannel}</dd></div>
          </dl>
          <footer>
            <button className="mt-link-button" onClick={()=>runPreview(rule)} disabled={Boolean(busy)}>
              {busy===`preview-${rule.id}`?'جارٍ تجهيز المعاينة…':'معاينة الرسالة'}
            </button>
            <button className="mt-button primary" onClick={()=>setEditing(rule)} disabled={Boolean(busy)}>
              ضبط القاعدة
            </button>
          </footer>
        </article>)}
      </div>
    </section>

    <section className="mt-panel mt-automation-runs">
      <div className="mt-toolbar">
        <div className="mt-segmented"><span>آخر عمليات المحرك</span></div>
        <small>الحالة هنا من قاعدة البيانات، وليست عرضًا تجميليًا</small>
      </div>
      <div className="mt-table-wrap"><table className="mt-table">
        <thead><tr><th>القاعدة</th><th>الحدث</th><th>الإجراء</th><th>الحالة</th><th>الوقت</th></tr></thead>
        <tbody>{runs.map(run=><tr key={run.id}>
          <td><b>{run.ruleName}</b></td>
          <td><small>{run.eventKey}</small></td>
          <td>{run.actionCount||0}</td>
          <td><span className={`mt-status ${run.status==='completed'?'active':''}`}>{RUN_STATUS[run.status]||run.status}</span></td>
          <td>{new Date(run.createdAt).toLocaleString('ar-EG')}</td>
        </tr>)}</tbody>
      </table>{!runs.length&&<div className="mt-empty">لم تُنفّذ قواعد بعد. استخدم المعاينة للتحقق الآمن.</div>}</div>
    </section>

    {editing&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>!busy&&setEditing(null)}/>
      <form className="mt-modal mt-automation-rule-modal" onSubmit={save}>
        <header><div><small>AUTOMATION RULE</small><h3>{editing.name}</h3><p>{editing.description}</p></div><button type="button" onClick={()=>setEditing(null)}>×</button></header>
        <div className="mt-form">
          <label className="mt-field">وضع التنفيذ<select name="executionMode" defaultValue={editing.executionMode}>
            <option value="live">فعلي — يضيف الرسالة للطابور</option>
            <option value="preview">معاينة — يسجل النتيجة دون إرسال</option>
          </select></label>
          <label className="mt-field">القناة الأساسية<select name="primaryChannel" defaultValue={editing.primaryChannel}>
            <option value="auto">تلقائي حسب إعداد المنشأة</option>
            <option value="whatsapp">واتساب</option>
            <option value="email">البريد الإلكتروني</option>
          </select></label>
          <label className="mt-field">عند الفشل استخدم<select name="fallbackChannel" defaultValue={editing.fallbackChannel}>
            <option value="email">البريد الإلكتروني</option>
            <option value="whatsapp">واتساب</option>
            <option value="none">لا تستخدم قناة بديلة</option>
          </select></label>
          <label className="mt-field">التأخير بالدقائق<input name="delayMinutes" type="number" min="0" max="43200" defaultValue={editing.delayMinutes}/></label>
          <div className="mt-setup-note mt-field wide"><span>✓</span><p>يحمي المحرك كل حدث بمفتاح منع تكرار، ولن ينشئ رسالتين للقاعدة نفسها ولو تكرر الاستدعاء.</p></div>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={()=>setEditing(null)}>إلغاء</button><button className="mt-button primary" disabled={Boolean(busy)}>{busy==='save'?'جارٍ الحفظ…':'حفظ القاعدة'}</button></footer>
      </form>
    </div>}

    {preview&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={()=>setPreview(null)}/>
      <section className="mt-modal mt-automation-preview-modal">
        <header><div><small>SAFE PREVIEW · لم تُرسل</small><h3>{preview.ruleName}</h3></div><button onClick={()=>setPreview(null)}>×</button></header>
        <div className="mt-automation-preview-body">
          {preview.subject&&<b>{preview.subject}</b>}
          <p>{preview.body||'لا يوجد نص للقالب في هذه القناة.'}</p>
          <small>هذه معاينة مسجلة للتدقيق، ولم تُضف إلى طابور الإرسال.</small>
        </div>
        <footer><button className="mt-button primary" onClick={()=>setPreview(null)}>تم</button></footer>
      </section>
    </div>}
  </section>;
}
