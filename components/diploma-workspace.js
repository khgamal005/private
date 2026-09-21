'use client';

import {useRef, useState} from 'react';
import Link from 'next/link';
import {monthlyInstallments} from '../lib/diploma-contracts.mjs';
import styles from './diploma-workspace.module.css';

const money = (value, currency) => value == null ? '—' : new Intl.NumberFormat('ar-SA', {style: 'currency', currency: currency || 'SAR'}).format(Number(value || 0) / 100);
const amount = value => Math.round(Number(value) * 100);
const statusLabel = value => ({draft: 'مسودة', active: 'معتمد', settlement_review: 'مراجعة تسوية', collections_only: 'تحصيل الفواتير السابقة', closed: 'مغلق'}[value] || value);

export default function DiplomaWorkspace({slug, initialData}) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [form, setForm] = useState({handoffId: '', payerAccountId: '', collectionOwnerId: '', startsOn: '', total: '', count: 1, currency: initialData.currency || 'SAR'});
  const [plan, setPlan] = useState(null);
  const [reason, setReason] = useState('');
  const [invoiceSelection, setInvoiceSelection] = useState({});
  const [automationConfirmed, setAutomationConfirmed] = useState(false);
  const [settlementConfirmed, setSettlementConfirmed] = useState(false);
  const [resolution, setResolution] = useState('collections_only');
  const [editingDraft, setEditingDraft] = useState(false);
  const pendingCommand = useRef(null);
  const selected = data.selected;
  const viewer = data.viewer || {};
  const change = event => setForm(current => ({...current, [event.target.name]: event.target.value}));
  async function load(id) {
    const response = await fetch(`/api/diplomas?tenantSlug=${encodeURIComponent(slug)}${id ? `&contractId=${encodeURIComponent(id)}` : ''}`, {cache: 'no-store'});
    const next = await response.json();
    if (!response.ok) throw new Error(next.error);
    setData(next); setEditingDraft(false);
  }
  async function act(action, payload) {
    setBusy(true); setError(''); setNotice('');
    const signature = JSON.stringify({action, payload});
    if (pendingCommand.current?.signature !== signature) pendingCommand.current = {signature, id: crypto.randomUUID()};
    try {
      const response = await fetch('/api/diplomas', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({tenantSlug: slug, action, commandId: pendingCommand.current.id, payload})});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      await load(result.contractId || selected?.id);
      pendingCommand.current = null;
      setPlan(null); setReason(''); setEditingDraft(false); setAutomationConfirmed(false); setSettlementConfirmed(false); setNotice('تم حفظ العملية وتحديث حالة العقد.');
    } catch (failure) { setError(failure.message || 'تعذر الحفظ.'); }
    finally { setBusy(false); }
  }
  const contractPayload = extra => ({contractId: selected.id, expectedVersion: selected.currentVersion, ...extra});
  function previewCreate(event) {
    event.preventDefault(); setError('');
    try { setPlan(monthlyInstallments(amount(form.total), Number(form.count), form.startsOn)); }
    catch { setError('راجع إجمالي العقد وعدد الأقساط وتاريخ البداية.'); }
  }
  function editDraft() {
    setEditingDraft(true); setPlan(null); setReason('');
    setForm({handoffId: '', payerAccountId: selected.payerAccountId, collectionOwnerId: selected.collectionOwnerId, startsOn: selected.startsOn,
      total: selected.totalMinor / 100, count: selected.installments.length, currency: selected.currency});
  }
  if (!data.enabled) return <main className={styles.root} dir="rtl"><h1>عقود الدبلومات</h1><p>هذه الميزة غير مفعلة للمنشأة بعد. تفعيلها يتم بعد مراجعة الإعدادات واختبار المسار.</p></main>;
  return <main className={styles.root} dir="rtl">
    <header><h1>عقود الدبلومات والأقساط</h1><p>العقد مع المنشأة مباشرة. المدفوعات والفواتير والإيصالات تُدار في الحسابات. مهلة التحصيل 7 أيام تقويمية بتوقيت {data.timezone}، ولا توقف الدراسة تلقائيًا.</p><Link href={`/tenant/${encodeURIComponent(slug)}/accounting`}>فتح الحسابات والفواتير والإيصالات</Link></header>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className={styles.panel}><h2>العقود</h2><div className={styles.list}>{(data.contracts || []).map(item => <button key={item.id} disabled={busy} onClick={() => {setPlan(null); setReason(''); setSettlementConfirmed(false); load(item.id).catch(failure => setError(failure.message));}}>{item.learnerName} — {item.courseTitle} — {statusLabel(item.status)}</button>)}</div>{!data.contracts?.length && <p>لا توجد عقود بعد.</p>}<small>يعرض أحدث 50 عقدًا. افتح العقد المطلوب لمراجعة أقساطه.</small></section>
    {selected && <section className={styles.panel}><h2>{selected.learnerName} — {selected.courseTitle}</h2><p>القيمة: {money(selected.totalMinor, selected.currency)} · الإصدار {selected.currentVersion} · {statusLabel(selected.status)}</p><p>أهلية التسجيل: {selected.eligibility.eligible ? 'مستوفٍ للشرط المالي' : 'غير مستوفٍ للشرط المالي'}{selected.eligibility.waiverApproved ? ' — السماح بالقبول دون دفعة أولى مع بقاء المديونية' : ''}</p>
      <div className={styles.actions}>{viewer.canApprove && selected.status === 'draft' && <button disabled={busy} onClick={() => act('approve', contractPayload({}))}>اعتماد العقد والجدول</button>}{viewer.canApprove && selected.status === 'active' && <button disabled={busy} onClick={() => {setPlan(selected.installments.map(item => ({id: item.id, dueOn: item.dueOn, amountMinor: item.amountMinor}))); setReason('');}}>إعادة جدولة مع الاحتفاظ بالتاريخ</button>}{viewer.canWrite && <button disabled={busy} onClick={() => act('refresh_collection', contractPayload({}))}>تحديث مهمة التحصيل</button>}</div>
      {viewer.canWrite && selected.status === 'draft' && <button disabled={busy} onClick={editDraft}>مراجعة بيانات المسودة</button>}
      <div className={styles.table}><table><thead><tr><th>القسط</th><th>الاستحقاق</th><th>المبلغ</th><th>المتحقق</th><th>الحالة</th><th>الفاتورة</th></tr></thead><tbody>{selected.installments.map((item, index) => <tr key={item.id}><td>{index + 1}</td><td>{item.dueOn}</td><td>{money(item.amountMinor, selected.currency)}</td><td>{money(item.paidMinor, selected.currency)}</td><td>{{scheduled: 'قادم', due: 'مستحق', grace: 'داخل المهلة', overdue: 'تجاوز المهلة', settled: 'مسدد', paused: 'موقوف للمراجعة', financial_review: 'تحتاج مطابقة مالية'}[item.state]}</td><td>{item.invoiceNumber || (viewer.canWrite && selected.status === 'active' ? <div><select aria-label={`فاتورة القسط ${index + 1}`} value={invoiceSelection[item.id] || ''} onChange={event => setInvoiceSelection(current => ({...current, [item.id]: event.target.value}))}><option value="">فاتورة صادرة من الحسابات</option>{(data.invoices || []).filter(invoice => Number(invoice.totalMinor) === Number(item.amountMinor)).map(invoice => <option key={invoice.id} value={invoice.id}>{invoice.number}</option>)}</select><button disabled={busy || !invoiceSelection[item.id]} onClick={() => act('link_invoice', contractPayload({installmentId: item.id, invoiceId: invoiceSelection[item.id]}))}>ربط</button></div> : selected.status === 'active' ? 'بانتظار إصدار فاتورة' : 'لم تصدر فاتورة')}</td></tr>)}</tbody></table></div>
      {selected.status === 'active' && viewer.canWaive && !selected.eligibility.waiverApproved && <form className={styles.actions} onSubmit={event => {event.preventDefault(); act('waive_first_installment', contractPayload({reason}));}}><label>سبب السماح بالقبول دون دفعة أولى مع بقاء المديونية<input value={reason} minLength={3} maxLength={1000} required onChange={event => setReason(event.target.value)}/></label><button disabled={busy}>اعتماد استثناء القبول</button></form>}
      {['settlement_review', 'collections_only'].includes(selected.status) && <section><h3>معاينة التسوية المالية</h3>{selected.settlementPreview.requiresReview && <p role="status">توجد حركة مالية سابقة تحتاج مطابقة قبل تحديد الرصيد أو إغلاق العقد.</p>}<p>متبقي الفواتير الصادرة: {money(selected.settlementPreview.issuedOutstandingMinor, selected.currency)}. الالتزامات غير المفوترة الموقوفة: {money(selected.settlementPreview.unbilledMinor, selected.currency)}. إلغاء التسجيل لا يحذف الفواتير أو المديونية.</p>{viewer.canWaive && <form className={styles.grid} onSubmit={event => {event.preventDefault(); act('resolve_settlement', contractPayload({reason, resolution, confirmed: settlementConfirmed, previewRevision: selected.settlementPreview.revision}));}}><label>القرار<select value={resolution} onChange={event => {setResolution(event.target.value); setSettlementConfirmed(false);}}><option value="collections_only">استمرار تحصيل الفواتير السابقة فقط</option><option value="closed" disabled={!selected.settlementPreview.canClose}>إغلاق بعد تسوية الفواتير وإلغاء غير المفوتر</option></select></label><label>سبب القرار<input minLength={3} required value={reason} onChange={event => setReason(event.target.value)}/></label><label className={styles.check}><input type="checkbox" checked={settlementConfirmed} onChange={event => setSettlementConfirmed(event.target.checked)}/>راجعت الأرصدة وأؤكد القرار مع حفظ السجل</label><button disabled={busy || !settlementConfirmed}>تأكيد التسوية</button></form>}</section>}
      <details><summary>سجل الإصدارات والقرارات</summary>{selected.history.map(item => <p key={item.id}>{item.kind} — {item.reason || 'اعتماد أولي'} — {new Date(item.createdAt).toLocaleString('ar-SA', {timeZone: data.timezone})}</p>)}</details>
    </section>}
    {(!selected || editingDraft) && viewer.canWrite && <section className={styles.panel}><h2>{editingDraft ? 'مراجعة بيانات المسودة' : 'إنشاء عقد'}</h2><form className={styles.grid} onSubmit={previewCreate}>
      {!editingDraft && <label>التسجيل<select name="handoffId" value={form.handoffId} onChange={change} required><option value="">اختر المتدرب والبرنامج</option>{data.handoffs.map(item => <option key={item.id} value={item.id}>{item.learnerName} — {item.courseTitle}</option>)}</select></label>}
      <label>حساب الدافع<select name="payerAccountId" value={form.payerAccountId} onChange={change} required><option value="">اختر حسابًا من الحسابات</option>{data.accounts.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>مسؤول التحصيل<select name="collectionOwnerId" value={form.collectionOwnerId} onChange={change} required><option value="">اختر الموظف</option>{data.staff.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <label>بداية العقد<input type="date" name="startsOn" value={form.startsOn} onChange={change} required/></label><label>إجمالي العقد<input type="number" step="0.01" min="0.01" name="total" value={form.total} onChange={change} required/></label><label>العملة<input name="currency" pattern="[A-Z]{3}" maxLength={3} value={form.currency} onChange={change} required/></label><label>الأقساط الشهرية<input type="number" name="count" min="1" max="30" value={form.count} onChange={change} required/></label><button disabled={busy}>معاينة الجدول</button>
    </form><p>يظهر هنا فقط تسجيل مرتبط ببرنامج مصنف دبلوم. الدافع يمكن أن يختلف عن المتدرب.</p></section>}
    {selected && viewer.canWrite && <button onClick={() => {setData(current => ({...current, selected: null})); setEditingDraft(false); setPlan(null);}}>عقد جديد</button>}
    {plan && <section className={styles.panel}><h2>{selected ? 'معاينة الإصدار الجديد' : 'معاينة الأقساط'}</h2><p>لا يتغير تاريخ الاستحقاق بسبب مهلة السماح. مجموع الأقساط يجب أن يساوي قيمة العقد.</p><div className={styles.grid}>{plan.map((item, index) => <div key={item.id}><label>تاريخ القسط {index + 1}<input type="date" value={item.dueOn} onChange={event => setPlan(current => current.map((row, i) => i === index ? {...row, dueOn: event.target.value} : row))}/></label><label>المبلغ<input type="number" min="0.01" step="0.01" value={item.amountMinor / 100} onChange={event => setPlan(current => current.map((row, i) => i === index ? {...row, amountMinor: amount(event.target.value)} : row))}/></label></div>)}</div>{selected && <label>سبب التعديل<input value={reason} minLength={3} onChange={event => setReason(event.target.value)}/></label>}<button disabled={busy || (selected && reason.trim().length < 3)} onClick={() => act(editingDraft ? 'revise_draft' : selected ? 'reschedule' : 'create', editingDraft ? contractPayload({...form, totalMinor: amount(form.total), installments: plan, reason}) : selected ? contractPayload({installments: plan, reason}) : {...form, totalMinor: amount(form.total), installments: plan})}>{selected ? 'تأكيد إصدار جديد للجدول' : 'حفظ مسودة العقد'}</button></section>}
    {viewer.canClassify && <section className={styles.panel}><h2>تصنيف البرامج</h2><p>البرامج القديمة تظل غير مصنفة حتى مراجعتها.</p>{data.courses.map(course => <div className={styles.actions} key={course.id}><span>{course.title} — {course.kind === 'diploma' ? 'دبلوم' : course.kind === 'short_course' ? 'دورة قصيرة' : 'غير مصنف'}</span><button disabled={busy || course.kind === 'diploma'} onClick={() => act('classify_program', {courseId: course.id, kind: 'diploma', expectedKind: course.kind})}>دبلوم</button><button disabled={busy || course.kind === 'short_course'} onClick={() => act('classify_program', {courseId: course.id, kind: 'short_course', expectedKind: course.kind})}>دورة قصيرة</button></div>)}</section>}
    {viewer.canWaive && <section className={styles.panel}><h2>المتابعة التلقائية للتحصيل</h2><p>الحالة: {data.collectionAutomationEnabled ? 'مفعلة' : 'غير مفعلة'}. تشمل المراجعة {data.automationContractCount} عقدًا، وتُنشئ أو تحدث مهام التحصيل المستحقة فقط.</p><label className={styles.check}><input type="checkbox" checked={automationConfirmed} onChange={event => setAutomationConfirmed(event.target.checked)}/>راجعت عدد العقود وأؤكد {data.collectionAutomationEnabled ? 'إيقاف' : 'تفعيل'} المتابعة التلقائية</label><button disabled={busy || !automationConfirmed || (!data.collectionAutomationEnabled && !data.schedulerAvailable)} onClick={() => act('set_collection_automation', {enabled: !data.collectionAutomationEnabled, confirmed: automationConfirmed, expectedContractCount: data.automationContractCount})}>{data.collectionAutomationEnabled ? 'إيقاف المتابعة التلقائية' : 'تفعيل المتابعة التلقائية'}</button>{!data.schedulerAvailable && <p>الجدولة غير جاهزة بعد. يمكنك تحديث مهمة التحصيل يدويًا من العقد.</p>}</section>}
  </main>;
}
