'use client';

import {useState} from 'react';

export default function ReportExcelButton({payload,label='تصدير إلى إكسيل',compact=false}){
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');

  async function exportReport(){
    if(busy)return;
    setBusy(true);
    setError('');
    try{
      const response=await fetch('/api/tenant/report-export',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(payload)
      });
      if(!response.ok){
        const detail=await response.json().catch(()=>({}));
        throw new Error(detail?.error||'تعذر إنشاء ملف إكسيل');
      }
      const blob=await response.blob();
      const disposition=response.headers.get('content-disposition')||'';
      const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const filename=encoded
        ?decodeURIComponent(encoded)
        :`report-${new Date().toISOString().slice(0,10)}.xlsx`;
      const url=URL.createObjectURL(blob);
      const anchor=document.createElement('a');
      anchor.href=url;
      anchor.download=filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }catch(err){
      setError(err instanceof Error?err.message:'تعذر إنشاء ملف إكسيل');
    }finally{
      setBusy(false);
    }
  }

  return <span style={{display:'inline-flex',flexDirection:'column',alignItems:'flex-start',gap:4}}>
    <button
      type="button"
      onClick={exportReport}
      disabled={busy}
      title="يتم تصدير البيانات المطابقة للفلاتر الحالية فقط"
      style={{
        minHeight:compact?32:38,
        padding:compact?'0 10px':'0 14px',
        border:'1px solid #b9d8e9',
        borderRadius:compact?9:10,
        background:'#f4fbff',
        color:'#176b98',
        font:'inherit',
        fontSize:compact?'.62rem':'.68rem',
        fontWeight:900,
        cursor:busy?'wait':'pointer',
        opacity:busy?0.65:1,
        whiteSpace:'nowrap'
      }}
    >{busy?'جارٍ إنشاء الملف…':label}</button>
    {error&&<small style={{maxWidth:220,color:'#b44551',fontSize:'.58rem',lineHeight:1.5}}>{error}</small>}
  </span>;
}
