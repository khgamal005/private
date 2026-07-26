'use client';

import { useEffect, useState } from 'react';

const labels = { manual: 'يدوي فقط', daily: 'يومي', weekly: 'أسبوعي', monthly: 'شهري' };
const date = value => value ? new Date(value).toLocaleString('ar-SA', { dateStyle: 'medium', timeStyle: 'short' }) : 'لم تتم بعد';

async function call(action, body = {}) {
  const response = await fetch(`/api/platform/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'تعذر تنفيذ العملية');
  return payload.data;
}

export default function MarketMirrorControl() {
  const [snapshot, setSnapshot] = useState(null);
  const [frequency, setFrequency] = useState('weekly');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function load() {
    try {
      setError('');
      const data = await call('market-sync-snapshot');
      setSnapshot(data);
      setFrequency(data?.frequency || 'weekly');
    } catch (reason) {
      setError(reason.message);
    }
  }

  useEffect(() => { load(); }, []);

  async function saveSchedule() {
    try {
      setBusy(true); setError(''); setMessage('');
      const data = await call('market-sync-schedule', { p_frequency: frequency });
      setSnapshot(current => ({ ...current, ...data }));
      setMessage('تم حفظ جدول المزامنة وتفعيله.');
    } catch (reason) { setError(reason.message); } finally { setBusy(false); }
  }

  async function runNow() {
    try {
      setBusy(true); setError(''); setMessage('جارٍ مزامنة البيانات من Marktone Projects...');
      const data = await call('market-sync-run');
      setMessage(`اكتملت المزامنة: ${Number(data?.rowsRead || 0).toLocaleString('ar-SA')} سجل مقروء.`);
      await load();
    } catch (reason) { setMessage(''); setError(reason.message); } finally { setBusy(false); }
  }

  return <section className="market-mirror-card">
    <header>
      <div><small>MARKET MIRROR</small><h3>مزامنة Marktone Projects</h3><p>نسخة قراءة فقط داخل منصة التحكم؛ لا تُعدّل قاعدة المصدر.</p></div>
      <span className={snapshot?.status === 'active' ? 'mirror-status active' : 'mirror-status'}>
        {snapshot?.status === 'active' ? 'متصل' : snapshot?.status === 'running' ? 'جارٍ المزامنة' : 'يحتاج مراجعة'}
      </span>
    </header>
    <div className="mirror-stats">
      <div><b>{date(snapshot?.lastSuccessAt)}</b><span>آخر مزامنة ناجحة</span></div>
      <div><b>{Number(snapshot?.lastRowsRead || 0).toLocaleString('ar-SA')}</b><span>سجل في آخر تشغيل</span></div>
      <div><b>{labels[snapshot?.frequency] || 'أسبوعي'}</b><span>الجدول الحالي</span></div>
    </div>
    <div className="mirror-actions">
      <label>التكرار<select value={frequency} onChange={event => setFrequency(event.target.value)} disabled={busy}>
        {Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      <button className="ghost" type="button" onClick={saveSchedule} disabled={busy}>حفظ الجدول</button>
      <button type="button" onClick={runNow} disabled={busy}>{busy ? 'جارٍ التنفيذ...' : 'مزامنة الآن'}</button>
    </div>
    {message && <div className="form-success">{message}</div>}
    {error && <div className="form-error">{error}</div>}
    {snapshot?.lastError && <small className="mirror-last-error">آخر خطأ: {snapshot.lastError}</small>}
  </section>;
}
