export default function TasksLoading(){
  return <main className="role-calendar-page is-embedded" dir="rtl" aria-busy="true">
    <header className="mt-page-head">
      <div>
        <small>V2 TASKS & CALENDAR</small>
        <h2>المهام والتقويم</h2>
        <p>جارٍ تجهيز مهام اليوم…</p>
      </div>
    </header>
    <div className="calendar-alert">جارٍ تحميل التقويم…</div>
    <section className="calendar-summary-grid">
      {Array.from({length:4},(_,index)=><button disabled key={index}>
        <span>جارٍ التحميل</span><b>—</b><small>لحظات قليلة</small>
      </button>)}
    </section>
  </main>;
}
