'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {connectionNeedsReauthorization,runConnectionAction} from '../lib/social-connect-v2.mjs';

const STATUS={
  connected:{label:'تم التفويض',tone:'ready'},
  reauth_required:{label:'يحتاج إعادة ربط',tone:'warning'},
  deauthorized:{label:'تم إلغاء التفويض',tone:'warning'},
  deletion_requested:{label:'حُذفت بيانات الربط',tone:'muted'},
  disabled:{label:'غير متصل',tone:'muted'},
  error:{label:'يحتاج مراجعة',tone:'error'}
};

const ERRORS={
  authentication_required:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مجددًا.',
  session_expired:'انتهت جلسة الدخول. سجّل الدخول ثم حاول مجددًا.',
  forbidden:'ليست لديك صلاحية إدارة الربط. تواصل مع مدير المنشأة.',
  addon_not_enabled:'الإضافة غير مفعلة لهذه المنشأة.',
  meta_connect_v2_not_in_rollout:'الربط غير متاح لهذه المنشأة بعد. تواصل مع الدعم.',
  meta_connect_v2_oauth_disabled:'الربط غير متاح حاليًا. حاول لاحقًا.',
  legacy_meta_connection_present:'منشأتك لديها ربط قائم. يمكنك متابعته من مركز التسويق.',
  required_scopes_missing:'لم تُمنح صلاحية قراءة الإعلانات. أعد الربط ووافق على الصلاحية المطلوبة.',
  oauth_state_invalid:'انتهت محاولة الربط أو لم تعد صالحة. ابدأ محاولة جديدة.',
  oauth_state_invalid_or_used:'انتهت محاولة الربط أو استُخدمت بالفعل. ابدأ محاولة جديدة.',
  oauth_exchange_failed:'لم يكتمل الربط مع Meta. حاول مرة أخرى.',
  oauth_token_invalid:'تعذر التحقق من التفويض. أعد الربط من حساب Meta الصحيح.',
  excessive_scopes_granted:'إعداد الربط يمنح صلاحيات إضافية. تواصل مع الدعم لضبطه على قراءة الإعلانات فقط.',
  oauth_session_mismatch:'انتهت جلسة الربط أو تغيّر حساب الدخول. سجّل الدخول ثم ابدأ محاولة جديدة.',
  request_rejected:'لم يكتمل الطلب. حاول مجددًا أو تواصل مع الدعم.',
  service_unavailable:'خدمة الربط غير متاحة مؤقتًا. حاول مجددًا.'
};

function initialFeedback(outcome,reason){
  if(outcome==='connected')return {tone:'success',message:'اكتمل تفويض الحساب. اختيار الحسابات والتقارير قيد التجهيز.'};
  if(outcome==='cancelled')return {tone:'neutral',message:'ألغيت محاولة الربط. لم نغيّر أي اتصال محفوظ.'};
  if(outcome==='error')return {tone:'error',message:ERRORS[reason]||'لم يكتمل التفويض. يمكنك إعادة المحاولة.'};
  return null;
}

export default function SocialConnectV2({slug,initialData,canManage,outcome,reason}){
  const router=useRouter();
  const data=initialData||{};
  const [checkedAt]=useState(()=>Date.now());
  const needsReauthorization=connectionNeedsReauthorization(data,checkedAt);
  const state=STATUS[needsReauthorization?'reauth_required':data.status]||STATUS.disabled;
  const [busy,setBusy]=useState('');
  const [feedback,setFeedback]=useState(()=>initialFeedback(outcome,reason));
  const readyToStart=Boolean(canManage&&data.addonEnabled&&data.rolloutEnabled&&data.oauthEnabled&&!data.legacyProtected);
  const canDisconnect=Boolean(canManage&&!data.legacyProtected&&['connected','reauth_required','error'].includes(data.status));

  async function action(name){
    await runConnectionAction({
      name,slug,fetcher:fetch,navigate:url=>window.location.assign(url),
      onStart(){setBusy(name);setFeedback(null);},
      onDisconnected(){
        setFeedback({tone:'success',message:'تم فصل الربط. أزلنا صلاحية وصول أودير المحفوظة لهذا الاتصال.'});
        router.refresh();
      },
      onError(code){setFeedback({tone:'error',message:ERRORS[code]||ERRORS.request_rejected});},
      onSettled(){setBusy('');}
    });
  }

  function disconnect(){
    if(!window.confirm('هل تريد فصل الربط؟ سيحتاج أودير إلى موافقتك من جديد للوصول إلى الحساب.'))return;
    action('disconnect');
  }

  return <main className="scv2-page">
    <header className="scv2-topbar">
      <div>
        <small>إعلانات Meta</small>
        <h1>ربط حساب الإعلانات</h1>
        <p>امنح أودير صلاحية مشاهدة بيانات إعلاناتك من صفحة Meta الرسمية.</p>
      </div>
      <Link href={`/tenant/${encodeURIComponent(slug)}/marketing`}>العودة إلى مركز التسويق</Link>
    </header>

    <div className="scv2-alert neutral" role="note">
      <b>المرحلة المتاحة: تفويض الحساب</b>
      <p>اختيار الحسابات وعرض الحملات والنتائج والتحليلات قيد التجهيز. اكتمال الربط هنا لا يعني بدء المزامنة أو توفر التقارير.</p>
    </div>
    {data.legacyProtected?<div className="scv2-legacy-guard">
      <span aria-hidden="true">✓</span>
      <div><b>منشأتك لديها ربط قائم</b><p>تابع اتصالك الحالي من مركز التسويق. هذه الصفحة لا تستبدله.</p></div>
    </div>:null}
    {feedback?<div className={`scv2-alert ${feedback.tone}`} role={feedback.tone==='error'?'alert':'status'}>{feedback.message}</div>:null}

    <section className="scv2-grid">
      <article className="scv2-connection-card" aria-busy={Boolean(busy)}>
        <header>
          <span className="scv2-provider-mark" aria-hidden="true">Meta</span>
          <div><small>حساب الإعلانات</small><h2>تفويض المشاهدة</h2></div>
          <em className={state.tone}>{state.label}</em>
        </header>
        <p>سجّل الدخول إلى Meta ووافق على قراءة بيانات الإعلانات. لن تحتاج إلى نسخ مفاتيح أو رموز، ولا يطلب أودير صلاحية تعديل الحملات أو الميزانيات.</p>
        <dl>
          <div><dt>الصلاحية المطلوبة</dt><dd>قراءة بيانات الإعلانات فقط</dd></div>
          <div><dt>الحملات والنتائج والتحليلات</dt><dd>قيد التجهيز</dd></div>
          <div><dt>آخر تفويض</dt><dd>{formatDate(data.lastAuthorizedAt)}</dd></div>
          <div><dt>صلاحية الاتصال حتى</dt><dd>{formatDate(data.tokenExpiresAt)}</dd></div>
          <div><dt>صلاحية الوصول للبيانات حتى</dt><dd>{formatDate(data.dataAccessExpiresAt)}</dd></div>
        </dl>
        {needsReauthorization?<p className="scv2-gate-note">يحتاج الاتصال إلى موافقتك من جديد. استخدم «إعادة ربط الحساب» للمتابعة.</p>:null}
        <footer>
          <button className="scv2-primary" disabled={!readyToStart||Boolean(busy)} onClick={()=>action('start')}>
            {busy==='start'?'جارٍ فتح Meta…':data.status==='connected'||needsReauthorization?'إعادة ربط الحساب':'ربط حساب Meta'}
          </button>
          {canDisconnect?<button className="scv2-danger" disabled={Boolean(busy)} onClick={disconnect}>
            {busy==='disconnect'?'جارٍ فصل الربط…':'فصل الربط'}
          </button>:null}
        </footer>
        {!canManage?<small className="scv2-gate-note">يمكنك مشاهدة الحالة. يتولى مدير المنشأة إدارة الربط.</small>
          :!data.legacyProtected&&!data.rolloutEnabled?<small className="scv2-gate-note">الربط غير متاح لهذه المنشأة بعد. تواصل مع الدعم.</small>
            :!data.legacyProtected&&!data.oauthEnabled?<small className="scv2-gate-note">الربط غير متاح حاليًا. حاول لاحقًا.</small>:null}
      </article>

      <aside className="scv2-security-card">
        <small>خطوات الربط</small>
        <h2>موافقتك هي البداية</h2>
        <ul>
          <li><span>01</span><div><b>سجّل الدخول إلى Meta</b><p>استخدم حسابًا لديه صلاحية الوصول إلى إعلانات منشأتك.</p></div></li>
          <li><span>02</span><div><b>وافق على المشاهدة</b><p>المطلوب قراءة بيانات الإعلانات، دون تغيير الحملات أو الإنفاق.</p></div></li>
          <li><span>03</span><div><b>عُد إلى أودير</b><p>سترى حالة التفويض هنا. اختيار الحسابات والتقارير لم يتاحا بعد.</p></div></li>
        </ul>
      </aside>
    </section>
  </main>;
}

function formatDate(value){
  if(!value)return '—';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA-u-ca-gregory',{
    dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Riyadh'
  }).format(date);
}
