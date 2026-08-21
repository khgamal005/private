'use client';

import {
  reloadDocument,
  useNavigationRecovery
} from './use-navigation-recovery';

export default function RuntimeErrorRecovery({error,reset}){
  useNavigationRecovery(error);

  return <main dir="rtl" role="alert" style={styles.page}>
    <section style={styles.card}>
      <span aria-hidden="true" style={styles.icon}>!</span>
      <p style={styles.eyebrow}>استعادة آمنة للصفحة</p>
      <h1 style={styles.title}>تعذّر تحميل الصفحة بالكامل</h1>
      <p style={styles.copy}>
        لن نعيد إرسال تسجيل الدخول أو أي عملية سابقة تلقائيًا. أعد تحميل الصفحة كاملة لاستعادة الاتصال.
      </p>
      <div style={styles.actions}>
        <button type="button" onClick={reloadDocument} style={styles.primary}>
          إعادة تحميل كاملة
        </button>
        <button
          type="button"
          onClick={()=>typeof reset==='function'?reset():reloadDocument()}
          style={styles.secondary}
        >
          المحاولة مرة أخرى
        </button>
        <a href="/login" style={styles.link}>تسجيل الدخول</a>
      </div>
      {error?.digest&&<small style={styles.reference}>
        المرجع الفني: <bdi>{error.digest}</bdi>
      </small>}
    </section>
  </main>;
}

const styles={
  page:{
    alignItems:'center',
    background:'#f4f7f9',
    boxSizing:'border-box',
    display:'flex',
    fontFamily:'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    justifyContent:'center',
    minHeight:'100vh',
    padding:'24px'
  },
  card:{
    background:'#fff',
    border:'1px solid #dfe7ec',
    borderRadius:'20px',
    boxShadow:'0 20px 60px rgba(16, 36, 48, 0.09)',
    maxWidth:'560px',
    padding:'32px',
    width:'100%'
  },
  icon:{
    alignItems:'center',
    background:'#fff2dd',
    borderRadius:'50%',
    color:'#9a5b00',
    display:'inline-flex',
    fontSize:'24px',
    fontWeight:800,
    height:'48px',
    justifyContent:'center',
    width:'48px'
  },
  eyebrow:{
    color:'#527080',
    fontSize:'14px',
    fontWeight:700,
    margin:'20px 0 8px'
  },
  title:{
    color:'#102430',
    fontSize:'clamp(24px, 5vw, 34px)',
    lineHeight:1.3,
    margin:'0 0 12px'
  },
  copy:{
    color:'#527080',
    fontSize:'16px',
    lineHeight:1.8,
    margin:'0'
  },
  actions:{
    display:'flex',
    flexWrap:'wrap',
    gap:'10px',
    marginTop:'24px'
  },
  primary:{
    background:'#102430',
    border:'1px solid #102430',
    borderRadius:'10px',
    color:'#fff',
    cursor:'pointer',
    font:'inherit',
    fontWeight:700,
    padding:'11px 18px'
  },
  secondary:{
    background:'#fff',
    border:'1px solid #b9c8d0',
    borderRadius:'10px',
    color:'#102430',
    cursor:'pointer',
    font:'inherit',
    fontWeight:700,
    padding:'11px 18px'
  },
  link:{
    alignItems:'center',
    color:'#315769',
    display:'inline-flex',
    fontWeight:700,
    padding:'11px 8px',
    textDecoration:'none'
  },
  reference:{
    color:'#78909c',
    display:'block',
    marginTop:'20px'
  }
};
