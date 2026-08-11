'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';

const LABELS={pending:'بانتظار المراجعة',reviewing:'قيد المراجعة',approved:'معتمد',rejected:'مرفوض',cancelled:'ملغي'};

function money(amountMinor,currency='SAR'){
  return new Intl.NumberFormat('ar-SA',{style:'currency',currency,maximumFractionDigits:2}).format((Number(amountMinor)||0)/100);
}
function date(value){
  if(!value)return '—';
  return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value));
}

export default function PlatformBankTransferReview({initialData}){
  const router=useRouter();
  const data=initialData||{};
  const transfers=data.transfers||[];
  const [busy,setBusy]=useState('');
  const [note,setNote]=useState({});
  const [reference,setReference]=useState({});
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');

  async function run(item,action){
    if(busy)return;
    setBusy(item.id+'-'+action);setMessage('');setError('');
    try{
      const response=await fetch('/api/control/bank-transfers',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_order_id:item.orderId,
          p_action:action,
          p_note:note[item.id]||null,
          p_payment_reference:reference[item.id]||item.reference||null
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
      setMessage(action==='approve'?'تم اعتماد التحويل وتفعيل الإضافة.':action==='reject'?'تم رفض التحويل.':'تم نقل التحويل إلى قيد المراجعة.');
      router.refresh();
    }catch(err){setError(err instanceof Error?err.message:'تعذر تنفيذ العملية');}
    finally{setBusy('');}
  }

  return <section style={{display:'grid',gap:20}}>
    <header style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:16,flexWrap:'wrap'}}>
      <div><small>المدفوعات اليدوية</small><h1 style={{margin:'4px 0'}}>مراجعة التحويلات البنكية</h1><p style={{margin:0,color:'#52606d'}}>لا يتم تفعيل أي إضافة قبل اعتماد التحويل من هذه الشاشة.</p></div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        <Stat label="بانتظار المراجعة" value={data.summary?.pending||0}/>
        <Stat label="معتمد" value={data.summary?.approved||0}/>
        <Stat label="مرفوض" value={data.summary?.rejected||0}/>
      </div>
    </header>
    {message&&<div style={{padding:12,borderRadius:10,background:'#eefbf3'}}>{message}</div>}
    {error&&<div style={{padding:12,borderRadius:10,background:'#fff1f1'}}>{error}</div>}
    <div style={{display:'grid',gap:12}}>
      {transfers.map(item=><article key={item.id} style={{border:'1px solid #dfe5eb',borderRadius:14,padding:16,background:'#fff',display:'grid',gap:12}}>
        <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap'}}>
          <div><b>{item.tenantName}</b><div style={{fontSize:13,color:'#667085'}}>{item.orderNumber} · {date(item.submittedAt)}</div></div>
          <div style={{textAlign:'left'}}><strong>{money(item.amountMinor,item.currency)}</strong><div style={{fontSize:13}}>{LABELS[item.status]||item.status}</div></div>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:10}}>
          <Field label="اسم المحوّل" value={item.senderName}/><Field label="مرجع التحويل" value={item.reference}/><Field label="تاريخ التحويل" value={item.transferDate}/>
        </div>
        {item.reviewNote&&<div style={{padding:10,background:'#f7f9fb',borderRadius:10}}><b>ملاحظة المراجعة:</b> {item.reviewNote}</div>}
        {['pending','reviewing'].includes(item.status)&&<>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <label style={{display:'grid',gap:5}}><span>مرجع الدفع المعتمد</span><input value={reference[item.id]??item.reference??''} onChange={e=>setReference(prev=>({...prev,[item.id]:e.target.value}))} style={inputStyle}/></label>
            <label style={{display:'grid',gap:5}}><span>ملاحظة المراجعة</span><input value={note[item.id]||''} onChange={e=>setNote(prev=>({...prev,[item.id]:e.target.value}))} style={inputStyle}/></label>
          </div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
            {item.status==='pending'&&<button disabled={Boolean(busy)} onClick={()=>run(item,'review')} style={buttonStyle}>بدء المراجعة</button>}
            <button disabled={Boolean(busy)} onClick={()=>run(item,'approve')} style={{...buttonStyle,background:'#0d6b45',color:'#fff'}}>اعتماد وتفعيل الإضافة</button>
            <button disabled={Boolean(busy)} onClick={()=>run(item,'reject')} style={{...buttonStyle,background:'#8b2c2c',color:'#fff'}}>رفض التحويل</button>
          </div>
        </>}
      </article>)}
      {!transfers.length&&<div style={{padding:30,textAlign:'center',border:'1px dashed #ccd5df',borderRadius:14}}>لا توجد تحويلات بنكية للمراجعة حتى الآن.</div>}
    </div>
  </section>;
}

function Stat({label,value}){return <div style={{padding:'10px 14px',border:'1px solid #dfe5eb',borderRadius:12,background:'#fff'}}><small>{label}</small><div style={{fontSize:22,fontWeight:800}}>{value}</div></div>}
function Field({label,value}){return <div style={{padding:10,background:'#f7f9fb',borderRadius:10}}><small>{label}</small><div style={{fontWeight:700,marginTop:4}}>{value||'—'}</div></div>}
const inputStyle={border:'1px solid #cfd8e3',borderRadius:9,padding:'10px 12px',font:'inherit'};
const buttonStyle={border:'1px solid #cfd8e3',borderRadius:9,padding:'9px 13px',background:'#fff',cursor:'pointer',font:'inherit',fontWeight:700};

