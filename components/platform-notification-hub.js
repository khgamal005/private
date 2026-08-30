'use client';

import Link from 'next/link';
import {useMemo,useState} from 'react';
import styles from './platform-notification-hub.module.css';

const FILTERS=[
  {key:'all',label:'الكل'},
  {key:'unread',label:'غير المقروءة'},
  {key:'action',label:'تحتاج إجراء'},
  {key:'danger',label:'حرجة'}
];

function count(value){return Math.max(0,Number(value)||0);}
function time(value){
  if(!value)return '—';
  return new Date(value).toLocaleString('ar-SA',{
    dateStyle:'medium',timeStyle:'short'
  });
}
function tone(severity){return styles[severity]||styles.info;}

async function notificationRequest(body){
  const response=await fetch('/api/platform/notifications',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body)
  });
  const payload=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(payload.error||'تعذر تحديث مركز الإشعارات');
  return payload.data;
}

export default function PlatformNotificationHub({initialData}){
  const [data,setData]=useState(initialData||{});
  const [filter,setFilter]=useState('all');
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState(null);
  const [settings,setSettings]=useState(()=>({...initialData?.settings}));
  const items=useMemo(()=>{
    const notifications=data.notifications||[];
    if(filter==='unread')return notifications.filter(item=>!item.readAt);
    if(filter==='action')return notifications.filter(item=>item.actionRequired);
    if(filter==='danger')return notifications.filter(item=>item.severity==='danger');
    return notifications;
  },[data.notifications,filter]);

  async function mark(action,notificationId=null){
    setBusy(true);setNotice(null);
    try{
      setData(await notificationRequest({action,notificationId}));
    }catch(error){setNotice({tone:'error',text:error.message});}
    finally{setBusy(false);}
  }

  function updateSetting(key,value){
    setSettings(current=>{
      const next={...current,[key]:value};
      if(key==='captureEnabled'&&!value){
        next.tenantEmailEnabled=false;
        next.platformEmailEnabled=false;
        next.operationalMonitorEnabled=false;
      }
      return next;
    });
  }

  async function saveSettings(){
    setBusy(true);setNotice(null);
    try{
      const saved=await notificationRequest({
        action:'update_settings',settings:{
          captureEnabled:Boolean(settings.captureEnabled),
          tenantEmailEnabled:Boolean(settings.tenantEmailEnabled),
          platformEmailEnabled:Boolean(settings.platformEmailEnabled),
          operationalMonitorEnabled:Boolean(settings.operationalMonitorEnabled),
          platformDefaultLocale:settings.platformDefaultLocale==='en'?'en':'ar'
        }
      });
      setSettings(saved);
      setData(current=>({...current,settings:saved}));
      setNotice({tone:'success',text:'حُفظت إعدادات التشغيل بنجاح.'});
    }catch(error){setNotice({tone:'error',text:error.message});}
    finally{setBusy(false);}
  }

  const health=data.health||{};
  return <section className={styles.page}>
    <header className={styles.hero}>
      <div><span>ODEIR NOTIFICATION HUB</span><h1>مركز الإشعارات والتشغيل</h1>
        <p>متابعة موحّدة لطلبات التسجيل والإضافات والمشتريات وحالة تسليم البريد.</p></div>
      {count(data.unreadCount)>0&&<button disabled={busy}
        onClick={()=>mark('mark_all_read')}>تحديد الكل كمقروء</button>}
    </header>

    {notice&&<div className={`${styles.notice} ${styles[notice.tone]}`}>{notice.text}</div>}

    <div className={`${styles.metrics} ${!data.health?styles.metricsCompact:''}`}>
      <article><small>غير المقروءة</small><strong>{count(data.unreadCount)}</strong><span>إشعار</span></article>
      <article><small>تحتاج إجراء</small><strong>{count(data.actionRequiredCount)}</strong><span>مهمة تشغيلية</span></article>
      {data.health&&<><article className={health.registrationWorkerHealthy?styles.healthy:styles.unhealthy}>
        <small>عامل بريد التسجيل</small><strong>{health.registrationWorkerHealthy?'سليم':'يحتاج فحصًا'}</strong>
        <span>آخر نبض: {time(health.registrationWorkerHeartbeatAt)}</span></article>
      <article className={health.lifecycleWorkerHealthy?styles.healthy:styles.unhealthy}>
        <small>عامل دورة الحياة</small><strong>{health.lifecycleWorkerHealthy?'سليم':'يحتاج فحصًا'}</strong>
        <span>{count(health.failedEmailCount)} رسالة متعثرة</span></article></>}
    </div>

    <div className={styles.layout}>
      <div className={styles.feed}>
        <div className={styles.feedHeader}><div><h2>سجل المتابعة</h2><p>يعرض آخر 30 يومًا مع إبقاء غير المقروء ظاهرًا.</p></div>
          <nav>{FILTERS.map(item=><button key={item.key}
            className={filter===item.key?styles.active:''}
            onClick={()=>setFilter(item.key)}>{item.label}</button>)}</nav></div>
        <div className={styles.list}>
          {items.map(item=><article key={item.id} className={item.readAt?styles.read:''}>
            <i className={tone(item.severity)}/><div><div className={styles.itemTitle}>
              <h3>{item.title}</h3>{item.actionRequired&&<b>يتطلب إجراء</b>}</div>
              <p>{item.message}</p><footer><time>{time(item.createdAt)}</time>
                <span>{item.sourceType}</span></footer></div>
            <Link href={item.actionUrl||'/control/notifications'}
              onClick={()=>!item.readAt&&mark('mark_read',item.id)}>فتح</Link>
          </article>)}
          {!items.length&&<div className={styles.empty}><strong>لا توجد عناصر ضمن هذا الفلتر</strong>
            <span>ستظهر الأحداث الجديدة هنا فور التقاطها.</span></div>}
        </div>
      </div>

      {data.canManageSettings&&settings&&<aside className={styles.settings}>
        <span>إطلاق مضبوط</span><h2>إعدادات التشغيل</h2>
        <p>كل القنوات مغلقة افتراضيًا. التفعيل هنا قرار صريح ولا يغيّر أي اشتراك أو حالة طلب.</p>
        <label><input type="checkbox" checked={Boolean(settings.captureEnabled)}
          onChange={event=>updateSetting('captureEnabled',event.target.checked)}/><span><b>التقاط الأحداث</b><small>ينشئ سجلًا وصندوق وارد فقط.</small></span></label>
        <label><input type="checkbox" checked={Boolean(settings.tenantEmailEnabled)}
          disabled={!settings.captureEnabled}
          onChange={event=>updateSetting('tenantEmailEnabled',event.target.checked)}/><span><b>بريد المنشآت</b><small>يرسل لمالك المنشأة أو طالب الإجراء.</small></span></label>
        <label><input type="checkbox" checked={Boolean(settings.platformEmailEnabled)}
          disabled={!settings.captureEnabled}
          onChange={event=>updateSetting('platformEmailEnabled',event.target.checked)}/><span><b>بريد مشرفي المنصة</b><small>مخصص للأحداث الحرجة التي تتطلب إجراء.</small></span></label>
        <label><input type="checkbox" checked={Boolean(settings.operationalMonitorEnabled)}
          disabled={!settings.captureEnabled}
          onChange={event=>updateSetting('operationalMonitorEnabled',event.target.checked)}/><span><b>المراقب الاستباقي</b><small>يفحص النبض والتفعيل كل خمس دقائق عند توفر pg_cron.</small></span></label>
        <label className={styles.locale}><span><b>لغة بريد المنصة</b><small>لا تؤثر في لغة المنشآت.</small></span>
          <select value={settings.platformDefaultLocale||'ar'}
            onChange={event=>updateSetting('platformDefaultLocale',event.target.value)}>
            <option value="ar">العربية</option><option value="en">English</option>
          </select></label>
        <div className={styles.schedule}>المراقب المستقل: <b>{settings.operationalMonitorScheduled?'مجدول':'غير مجدول'}</b></div>
        <button className={styles.save} disabled={busy} onClick={saveSettings}>
          {busy?'جارٍ الحفظ…':'حفظ إعدادات التشغيل'}</button>
      </aside>}
    </div>
  </section>;
}
