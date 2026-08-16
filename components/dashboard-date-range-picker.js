'use client';

import {useId,useState} from 'react';
import styles from './role-dashboard.module.css';

const DATE_FORMATTER=new Intl.DateTimeFormat('ar-EG-u-ca-gregory',{
  day:'numeric',
  month:'long',
  year:'numeric'
});

function formattedDate(value){
  if(!value)return 'اختر من التقويم';
  const date=new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime())
    ?'اختر من التقويم'
    :DATE_FORMATTER.format(date);
}

function openPicker(input){
  if(typeof input?.showPicker!=='function')return;
  try{
    input.showPicker();
  }catch{
    input.focus();
  }
}

function preventManualEntry(event){
  if(event.key==='Tab'||event.key==='Escape')return;
  event.preventDefault();
  if(event.key==='Enter'||event.key===' ')openPicker(event.currentTarget);
}

function CalendarIcon(){
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z"/>
  </svg>;
}

export default function DashboardDateRangePicker({from:initialFrom,to:initialTo,maxDate}){
  const id=useId();
  const [from,setFrom]=useState(initialFrom||'');
  const [to,setTo]=useState(initialTo||'');

  const changeFrom=event=>{
    const next=event.target.value;
    setFrom(next);
    if(next&&to&&next>to)setTo(next);
  };
  const changeTo=event=>{
    const next=event.target.value;
    setTo(next);
    if(next&&from&&next<from)setFrom(next);
  };

  return <>
    <div className={styles.calendarField}>
      <label htmlFor={`${id}-from`}>من تاريخ</label>
      <div className={styles.calendarControl}>
        <CalendarIcon/>
        <bdi>{formattedDate(from)}</bdi>
        <small>اختيار من التقويم</small>
        <input
          id={`${id}-from`}
          type="date"
          name="from"
          value={from}
          max={maxDate}
          required
          aria-label="اختر تاريخ البداية من التقويم"
          onChange={changeFrom}
          onClick={event=>openPicker(event.currentTarget)}
          onKeyDown={preventManualEntry}
          onPaste={event=>event.preventDefault()}
          onDrop={event=>event.preventDefault()}
        />
      </div>
    </div>
    <span className={styles.dateArrow} aria-hidden="true">←</span>
    <div className={styles.calendarField}>
      <label htmlFor={`${id}-to`}>إلى تاريخ</label>
      <div className={styles.calendarControl}>
        <CalendarIcon/>
        <bdi>{formattedDate(to)}</bdi>
        <small>اختيار من التقويم</small>
        <input
          id={`${id}-to`}
          type="date"
          name="to"
          value={to}
          min={from}
          max={maxDate}
          required
          aria-label="اختر تاريخ النهاية من التقويم"
          onChange={changeTo}
          onClick={event=>openPicker(event.currentTarget)}
          onKeyDown={preventManualEntry}
          onPaste={event=>event.preventDefault()}
          onDrop={event=>event.preventDefault()}
        />
      </div>
    </div>
  </>;
}
