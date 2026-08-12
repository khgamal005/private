'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect,useRef,useState} from 'react';

const POLL_INTERVAL_MS=4000;
const EMPTY_DATA={notifications:[],unreadCount:0};

function safeCount(value){
  return Math.max(0,Number(value)||0);
}

function notificationTone(severity){
  return ({success:'green',warning:'amber',danger:'danger'})[severity]||'blue';
}

function notificationTime(value){
  if(!value)return '';
  return new Date(value).toLocaleString('ar-SA',{
    day:'numeric',
    month:'short',
    hour:'2-digit',
    minute:'2-digit'
  });
}

async function requestNotifications(slug,action='list',notificationId=null){
  const options=action==='list'
    ?{cache:'no-store'}
    :{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({slug,action,notificationId}),
      keepalive:true
    };
  const endpoint=action==='list'
    ?`/api/tenant/notifications?slug=${encodeURIComponent(slug)}`
    :'/api/tenant/notifications';
  const response=await fetch(endpoint,options);
  const payload=await response.json();
  if(!response.ok)throw new Error(payload.error||'تعذر تحميل الإشعارات');
  return payload.data||EMPTY_DATA;
}

export default function NotificationCenter({
  slug,
  className='mt-notification-menu',
  operationalItems=[],
  operationalCount=0,
  icon,
  emptyMessage='لا توجد تنبيهات عاجلة الآن.'
}){
  const router=useRouter();
  const [data,setData]=useState(EMPTY_DATA);
  const [toast,setToast]=useState(null);
  const initializedRef=useRef(false);
  const latestIdRef=useRef(null);
  const busyRef=useRef(false);

  useEffect(()=>{
    let cancelled=false;

    async function poll(){
      if(cancelled||busyRef.current||document.visibilityState==='hidden')return;
      busyRef.current=true;
      try{
        const next=await requestNotifications(slug);
        if(cancelled)return;
        const newest=next.notifications?.[0]||null;
        if(
          initializedRef.current
          &&newest
          &&newest.id!==latestIdRef.current
          &&!newest.readAt
        ){
          setToast(newest);
          router.refresh();
          if('Notification' in window&&window.Notification.permission==='granted'){
            try{
              new window.Notification(newest.title,{body:newest.message});
            }catch{
              // The in-app toast remains the reliable notification channel.
            }
          }
        }
        latestIdRef.current=newest?.id||latestIdRef.current;
        initializedRef.current=true;
        setData(next);
      }catch{
        // Keep the last valid notification state and retry on the next poll.
      }finally{
        busyRef.current=false;
      }
    }

    poll();
    const timer=window.setInterval(poll,POLL_INTERVAL_MS);
    const handleFocus=()=>poll();
    const handleVisibility=()=>{
      if(document.visibilityState==='visible')poll();
    };
    window.addEventListener('focus',handleFocus);
    document.addEventListener('visibilitychange',handleVisibility);
    return ()=>{
      cancelled=true;
      window.clearInterval(timer);
      window.removeEventListener('focus',handleFocus);
      document.removeEventListener('visibilitychange',handleVisibility);
    };
  },[router,slug]);

  useEffect(()=>{
    if(!toast)return undefined;
    const timer=window.setTimeout(()=>setToast(null),7000);
    return ()=>window.clearTimeout(timer);
  },[toast]);

  async function updateReadState(action,notificationId=null){
    setData(current=>({
      ...current,
      unreadCount:action==='mark_all_read'
        ?0
        :Math.max(0,safeCount(current.unreadCount)-1),
      notifications:(current.notifications||[]).map(item=>
        action==='mark_all_read'||item.id===notificationId
          ?{...item,readAt:item.readAt||new Date().toISOString()}
          :item
      )
    }));
    try{
      const next=await requestNotifications(slug,action,notificationId);
      setData(next);
    }catch{
      // The next poll reconciles optimistic read state with the server.
    }
  }

  const systemItems=data.notifications||[];
  const totalCount=safeCount(data.unreadCount)+safeCount(operationalCount);
  const notificationLabel=totalCount>99?'99+':totalCount;
  const hasItems=systemItems.length>0||operationalItems.length>0;

  return <>
    <details className={`mt-toolbar-menu ${className}`}>
      <summary aria-label="فتح التنبيهات">
        <span className="mt-toolbar-icon">{icon}</span>
        {totalCount>0&&<b>{notificationLabel}</b>}
      </summary>
      <div className="mt-toolbar-popover">
        <header>
          <div><small>مركز المتابعة</small><h2>التنبيهات والمهام</h2></div>
          <span>{totalCount?`${notificationLabel} تحتاج متابعة`:'لا توجد عناصر عاجلة'}</span>
        </header>
        {safeCount(data.unreadCount)>0&&<button
          type="button"
          className="mt-notification-read-all"
          onClick={()=>updateReadState('mark_all_read')}
        >تحديد إشعارات النظام كمقروءة</button>}
        <div className="mt-notification-list">
          {systemItems.map(item=><Link
            key={item.id}
            href={item.actionUrl||`/tenant/${encodeURIComponent(slug)}/sales`}
            className={item.readAt?'':'is-unread'}
            onClick={()=>!item.readAt&&updateReadState('mark_read',item.id)}
          >
            <i className={notificationTone(item.severity)}/>
            <span>
              <b>{item.title}</b>
              <small>{item.message}</small>
              <time>{notificationTime(item.createdAt)}</time>
            </span>
          </Link>)}
          {operationalItems.map(item=><Link
            key={`${item.href}-${item.title}`}
            href={item.href}
          >
            <i className={item.tone}/>
            <span><b>{item.title}</b><small>{item.description}</small></span>
          </Link>)}
          {!hasItems&&<div className="mt-notification-empty">
            <span>✓</span><b>كل شيء تحت السيطرة</b><small>{emptyMessage}</small>
          </div>}
        </div>
        <footer><Link href={`/tenant/${encodeURIComponent(slug)}/tasks`}>فتح مركز المهام</Link></footer>
      </div>
    </details>
    {toast&&<div className="mt-notification-toast" role="status" aria-live="polite">
      <i className={notificationTone(toast.severity)}/>
      <div><b>{toast.title}</b><span>{toast.message}</span></div>
      <button type="button" onClick={()=>setToast(null)} aria-label="إغلاق الإشعار">×</button>
    </div>}
  </>;
}
