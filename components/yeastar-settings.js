'use client';

import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';

const DEFAULT={
  displayName:'Yeastar P550',
  publicConfig:{
    baseUrl:'https://reef.ras.yeastar.com',
    extensions:'105',
    timezone:'Asia/Riyadh',
    syncIntervalMinutes:60,
    initialHistoryDays:30,
    apiMode:'auto'
  },
  configuredSecrets:[],
  staffOptions:[]
};

export default function YeastarSettings({slug}){
  const router=useRouter();
  const [data,setData]=useState(DEFAULT);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [extensionsText,setExtensionsText]=useState(
    DEFAULT.publicConfig.extensions
  );

  useEffect(()=>{
    let alive=true;
    fetchSettings(slug)
      .then(next=>{
        if(alive){
          setData(next);
          setExtensionsText(
            next.publicConfig.extensions
              ||DEFAULT.publicConfig.extensions
          );
        }
      })
      .catch(err=>alive&&setError(err.message))
      .finally(()=>alive&&setLoading(false));
    return ()=>{alive=false};
  },[slug]);

  async function post(action,payload={}){
    const response=await fetch(`/api/yeastar/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({tenantSlug:slug,payload})
    });
    const result=await response.json().catch(()=>({}));
    if(!response.ok){
      throw new Error(errorMessage(result.error,'تعذر تنفيذ العملية'));
    }
    return result;
  }

  async function save(event){
    event.preventDefault();
    setBusy('save');setError('');setNotice('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      const extensions=parseExtensions(values.extensions);
      const extensionAssignments=Object.fromEntries(
        extensions
          .map(extension=>[
            extension,
            String(values[`extensionAssignment:${extension}`]||'').trim()
          ])
          .filter(([,staffId])=>Boolean(staffId))
      );
      await post('save',{
        displayName:String(values.displayName||'Yeastar P550').trim(),
        publicConfig:{
          baseUrl:String(values.baseUrl||'').trim(),
          extensions:extensions.join(', '),
          extensionAssignments,
          timezone:values.timezone,
          syncIntervalMinutes:Number(values.syncIntervalMinutes),
          initialHistoryDays:Number(values.initialHistoryDays),
          apiMode:values.apiMode
        },
        secrets:{
          clientId:String(values.clientId||'').trim(),
          clientSecret:String(values.clientSecret||'').trim()
        }
      });
      const refreshed=await fetchSettings(slug);
      setData(refreshed);
      setExtensionsText(
        refreshed.publicConfig.extensions
          ||DEFAULT.publicConfig.extensions
      );
      setNotice('تم حفظ الإعدادات وتشفير بيانات API. نفّذ اختبار الاتصال الآن.');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  async function run(action){
    setBusy(action);setError('');setNotice('');
    try{
      const result=await post(action);
      if(action==='test'){
        setNotice(
          `نجح الاتصال: ${result.device?.modelName||'Yeastar'} · ${result.device?.firmwareVersion||''} · API ${result.recommendedApiVersion||''}`
        );
      }else{
        setNotice(
          `اكتملت المزامنة: ${result.fetchedCount||0} سجل، جديد ${result.insertedCount||0}، محدث ${result.updatedCount||0}.`
        );
      }
      const refreshed=await fetchSettings(slug);
      setData(refreshed);
      setExtensionsText(
        refreshed.publicConfig.extensions
          ||DEFAULT.publicConfig.extensions
      );
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy('')}
  }

  if(loading)return <section className="mt-panel"><div className="mt-empty">جارٍ تحميل إعدادات Yeastar…</div></section>;
  const config=data.publicConfig||DEFAULT.publicConfig;
  const configured=new Set(data.configuredSecrets||[]);
  const extensions=parseExtensions(extensionsText);
  const assignments=config.extensionAssignments||{};
  const staffOptions=data.staffOptions||[];

  return <section className="mt-yeastar-settings">
    <section className="mt-kpis">
      <article className={`mt-kpi ${data.status==='active'?'success':''}`}>
        <span>حالة الاتصال</span>
        <b className="mt-kpi-domain">{statusLabel(data.status)}</b>
        <small>{data.lastCheckedAt?new Date(data.lastCheckedAt).toLocaleString('ar-SA'):'لم يُختبر بعد'}</small>
      </article>
      <article className="mt-kpi">
        <span>التحويلات</span>
        <b>{String(config.extensions||'').split(',').filter(Boolean).length}</b>
        <small>{config.extensions||'غير محددة'}</small>
      </article>
      <article className="mt-kpi">
        <span>المزامنة</span>
        <b>{intervalLabel(config.syncIntervalMinutes)}</b>
        <small>مع مزامنة فورية عند الطلب</small>
      </article>
      <article className="mt-kpi">
        <span>آخر سحب</span>
        <b className="mt-kpi-domain">{data.lastSync?.status==='success'?'ناجح':data.lastSync?'يحتاج مراجعة':'—'}</b>
        <small>{data.lastSync?.finishedAt?new Date(data.lastSync.finishedAt).toLocaleString('ar-SA'):'لا توجد مزامنة بعد'}</small>
      </article>
    </section>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}
    {data.lastError&&!error&&<div className="mt-alert error">{data.lastError}</div>}

    <form className="mt-panel" onSubmit={save}>
      <div className="mt-toolbar">
        <div>
          <small>YEASTAR P-SERIES API</small>
          <h3>ربط السنترال وتقارير المكالمات</h3>
          <p>اربط كل تحويلة بالموظف الصحيح لتظهر مكالماته داخل لوحة أدائه دون خلط بيانات الفريق.</p>
        </div>
        <div className="mt-page-actions">
          <button type="button" className="mt-button" disabled={!data.configured||Boolean(busy)} onClick={()=>run('test')}>
            {busy==='test'?'جارٍ اختبار الجهاز…':'اختبار الاتصال'}
          </button>
          <button type="button" className="mt-button primary" disabled={data.status!=='active'||Boolean(busy)} onClick={()=>run('sync')}>
            {busy==='sync'?'جارٍ جلب المكالمات…':'مزامنة الآن'}
          </button>
        </div>
      </div>

      <div className="mt-form">
        <label className="mt-field">اسم الربط
          <input name="displayName" defaultValue={data.displayName||'Yeastar P550'} required/>
        </label>
        <label className="mt-field">رابط الجهاز الآمن
          <input name="baseUrl" type="url" dir="ltr" defaultValue={config.baseUrl} placeholder="https://reef.ras.yeastar.com" required/>
          <small>استخدم رابط Remote Access العام، وليس عنوان IP داخليًا.</small>
        </label>
        <label className="mt-field">Client ID
          <input name="clientId" type="password" autoComplete="new-password" required={!configured.has('clientId')} placeholder={configured.has('clientId')?'•••••••• محفوظ ومشفّر':'من Integrations → API في Yeastar'}/>
          <small>{configured.has('clientId')?'اتركه فارغًا للاحتفاظ بالقيمة الحالية':'لن يظهر بعد الحفظ'}</small>
        </label>
        <label className="mt-field">Client Secret
          <input name="clientSecret" type="password" autoComplete="new-password" required={!configured.has('clientSecret')} placeholder={configured.has('clientSecret')?'•••••••• محفوظ ومشفّر':'أدخل Client Secret'}/>
          <small>{configured.has('clientSecret')?'اتركه فارغًا للاحتفاظ بالقيمة الحالية':'يُحفظ داخل Supabase Vault'}</small>
        </label>
        <label className="mt-field">التحويلات المراد متابعتها
          <input
            name="extensions"
            dir="ltr"
            value={extensionsText}
            onChange={event=>setExtensionsText(event.target.value)}
            placeholder="105, 106, 107"
            required
          />
          <small>افصل بين التحويلات بفاصلة، ثم اختر الموظف المقابل لكل تحويلة أدناه.</small>
        </label>
        <label className="mt-field">المنطقة الزمنية
          <select name="timezone" defaultValue={config.timezone||'Asia/Riyadh'}>
            <option value="Asia/Riyadh">السعودية — Asia/Riyadh</option>
            <option value="Africa/Cairo">مصر — Africa/Cairo</option>
            <option value="UTC">UTC</option>
          </select>
        </label>
        <fieldset className="mt-field" style={{gridColumn:'1 / -1'}}>
          <legend>ربط التحويلات بالموظفين</legend>
          <small>هذا الربط هو أساس إحصاءات المكالمات الشخصية ولوحة أداء الفريق.</small>
          <div className="mt-form">
            {extensions.map(extension=><label
              className="mt-field"
              key={extension}
            >
              التحويلة {extension}
              <select
                name={`extensionAssignment:${extension}`}
                defaultValue={assignments[extension]||''}
              >
                <option value="">غير مرتبطة بموظف</option>
                {staffOptions.map(staff=><option
                  key={staff.id}
                  value={staff.id}
                >
                  {staff.name} — {staff.jobTitle||staff.roleKey}
                </option>)}
              </select>
            </label>)}
            {!extensions.length&&<div className="mt-empty">
              أدخل تحويلة صحيحة أولًا.
            </div>}
            {extensions.length>0&&!staffOptions.length&&<div className="mt-empty">
              لا يوجد موظفون نشطون متاحون للربط.
            </div>}
          </div>
        </fieldset>
        <label className="mt-field">تكرار المزامنة
          <select name="syncIntervalMinutes" defaultValue={String(config.syncIntervalMinutes||60)}>
            <option value="15">كل 15 دقيقة</option>
            <option value="30">كل 30 دقيقة</option>
            <option value="60">كل ساعة</option>
            <option value="360">كل 6 ساعات</option>
            <option value="1440">يوميًا</option>
          </select>
        </label>
        <label className="mt-field">أيام السحب الأول
          <select name="initialHistoryDays" defaultValue={String(config.initialHistoryDays||30)}>
            <option value="7">آخر 7 أيام</option>
            <option value="14">آخر 14 يومًا</option>
            <option value="30">آخر 30 يومًا</option>
            <option value="60">آخر 60 يومًا</option>
            <option value="90">آخر 90 يومًا</option>
          </select>
        </label>
        <label className="mt-field">إصدار CDR
          <select name="apiMode" defaultValue={config.apiMode||'auto'}>
            <option value="auto">تلقائي حسب Firmware</option>
            <option value="v1.0">v1.0 — متوافق مع 37.22</option>
            <option value="v2.0">v2.0 — بعد ترقية 37.23+</option>
          </select>
        </label>
      </div>
      <div className="mt-secret-banner">
        لا تُعرض بيانات الدخول بعد حفظها، ولا تُرسل إلى المتصفح في التقارير. يحصل الموصل على Access Token مؤقت ثم يلغيه بعد كل اختبار أو مزامنة حتى لا يصل الجهاز إلى حد الرموز الثمانية.
      </div>
      <footer className="mt-page-actions">
        <button className="mt-button primary" disabled={Boolean(busy)}>
          {busy==='save'?'جارٍ الحفظ والتشفير…':'حفظ إعدادات Yeastar'}
        </button>
      </footer>
    </form>
  </section>;
}

async function fetchSettings(slug){
  const response=await fetch(
    `/api/yeastar/settings?tenantSlug=${encodeURIComponent(slug)}`,
    {cache:'no-store'}
  );
  const payload=await response.json().catch(()=>({}));
  if(!response.ok){
    throw new Error(errorMessage(payload.error,'تعذر تحميل الإعدادات'));
  }
  return {
    ...DEFAULT,
    ...payload,
    publicConfig:{
      ...DEFAULT.publicConfig,
      ...(payload.publicConfig||{})
    }
  };
}

function errorMessage(value,fallback){
  if(typeof value==='string'&&value.trim())return value;
  if(value&&typeof value==='object'){
    return value.message||value.error_description||value.code||fallback;
  }
  return fallback;
}

function statusLabel(value){
  return ({
    active:'متصل',
    draft:'محفوظ',
    testing:'جارٍ الاختبار',
    error:'يحتاج مراجعة',
    degraded:'متصل بملاحظة',
    disabled:'غير مفعّل'
  })[value]||'غير مفعّل';
}

function intervalLabel(value){
  return ({15:'15 د',30:'30 د',60:'ساعة',360:'6 ساعات',1440:'يومي'})[Number(value)]||'ساعة';
}

function parseExtensions(value){
  return [...new Set(
    String(value||'')
      .split(/[\s,;]+/)
      .map(item=>item.trim())
      .filter(item=>/^\d{1,10}$/.test(item))
  )].slice(0,100);
}
