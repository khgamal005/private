'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import Link from 'next/link';
import {addonHref} from '../lib/addons/placement-registry';

const EMPTY=[];
const LECTURE_SCHEDULE_VARIABLE={
  key:'lecture_schedule',
  label:'موعد المحاضرة/المحاضرات',
  sample:'من الأحد إلى الخميس، من 6:00 م إلى 10:00 م'
};

const CHANNELS={
  whatsapp:{label:'واتساب',description:'رسائل الانضمام والتذكيرات والقوالب المعتمدة'},
  email:{label:'البريد الإلكتروني',description:'Amazon SES أو Resend أو أي API بريد آخر'},
  api:{label:'API وWebhooks',description:'إرسال أحداث النظام إلى أي منصة خارجية'}
};

const STATUS={
  draft:'محفوظ ويحتاج اختبارًا',
  testing:'جارٍ اختبار الاتصال',
  active:'متصل وجاهز',
  degraded:'متصل مع ملاحظة',
  disabled:'غير مفعّل',
  error:'الاتصال يحتاج مراجعة'
};

const STATUS_TONE={
  active:'ready',
  degraded:'warning',
  draft:'draft',
  testing:'testing',
  error:'error',
  disabled:'disabled'
};

function configured(provider,key){
  return (provider.connection?.configuredSecrets||EMPTY).includes(key);
}

function renderTemplate(value,variables){
  let result=String(value||'');
  for(const variable of variables||EMPTY){
    result=result.replaceAll(
      `{{${variable.key}}}`,
      variable.sample||'—'
    );
  }
  return result.replace(/\{\{[a-z][a-z0-9_]*\}\}/g,'—');
}

export default function IntegrationHub({slug,initialData,mode='integrations',enabledProductKeys=EMPTY}){
  const router=useRouter();
  const data=initialData||{};
  const providers=data.providers||EMPTY;
  const templates=data.templates||EMPTY;
  const variables=useMemo(()=>{
    const current=data.variables||EMPTY;
    return current.some(variable=>variable.key==='lecture_schedule')
      ?current
      :[...current,LECTURE_SCHEDULE_VARIABLE];
  },[data.variables]);
  const summary=data.summary||{};
  const canManage=Boolean(data.viewer?.canManage);
  const [providerModal,setProviderModal]=useState(null);
  const [templateModal,setTemplateModal]=useState(null);
  const [templateDraft,setTemplateDraft]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const enabledChannels=useMemo(
    ()=>new Set(enabledProductKeys),
    [enabledProductKeys]
  );

  const grouped=useMemo(()=>Object.entries(CHANNELS)
    .filter(([key])=>enabledChannels.has(key))
    .map(([key,meta])=>({
      key,
      ...meta,
      providers:providers.filter(
        provider=>provider.channel===key&&provider.addonEnabled!==false
      )
    })
  ),[enabledChannels,providers]);

  async function action(name,payload){
    const response=await fetch('/api/tenant/integration-hub',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        p_tenant_slug:slug,
        p_action:name,
        p_payload:payload
      })
    });
    const result=await response.json();
    if(!response.ok)throw new Error(result.error||'تعذر تنفيذ العملية');
    return result.data;
  }

  async function saveProvider(event){
    event.preventDefault();
    const provider=providerModal;
    if(!provider)return;
    setBusy('save-provider');
    setError('');
    setNotice('');
    try{
      const values=Object.fromEntries(new FormData(event.currentTarget));
      const publicConfig={};
      const secrets={};
      for(const field of provider.setupFields||EMPTY){
        publicConfig[field.key]=String(values[`config_${field.key}`]||'').trim();
      }
      for(const field of provider.secretFields||EMPTY){
        const value=String(values[`secret_${field.key}`]||'').trim();
        if(value)secrets[field.key]=value;
      }
      await action('save_connection',{
        connectionId:provider.connection?.id||null,
        providerKey:provider.key,
        channel:provider.channel,
        displayName:String(values.displayName||provider.name).trim(),
        publicConfig,
        secrets,
        makeDefault:values.makeDefault==='on'
      });
      setNotice('تم حفظ الإعدادات وتشفير بيانات الدخول. اختبر الاتصال لتفعيله.');
      setProviderModal(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy('');
    }
  }

  async function testConnection(provider){
    if(!provider.connection?.id)return;
    setBusy(`test-${provider.key}`);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/tenant/integration-test',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          tenantSlug:slug,
          connectionId:provider.connection.id
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(
        connectionError(result.error||'connection_test_failed')
      );
      setNotice('نجح اختبار الاتصال وأصبح المزود جاهزًا للإرسال الفعلي.');
      router.refresh();
    }catch(err){
      setError(err.message);
      router.refresh();
    }finally{
      setBusy('');
    }
  }

  async function setDefault(provider){
    setBusy(`default-${provider.key}`);
    setError('');
    try{
      await action('set_default_connection',{
        connectionId:provider.connection.id
      });
      setNotice(`أصبح ${provider.name} المزود الافتراضي لهذه القناة.`);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy('');
    }
  }

  async function disable(provider){
    if(!window.confirm(`إيقاف ${provider.name}؟ لن تُحذف بياناته المشفّرة.`))return;
    setBusy(`disable-${provider.key}`);
    setError('');
    try{
      await action('disable_connection',{
        connectionId:provider.connection.id
      });
      setNotice('تم إيقاف الربط مع الاحتفاظ بإعداداته لإعادة التفعيل لاحقًا.');
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy('');
    }
  }

  function editTemplate(template){
    setTemplateModal(template);
    setTemplateDraft({
      subject:template.subject||'',
      body:template.body||'',
      providerTemplateName:template.providerTemplateName||'',
      locale:template.locale||'ar',
      status:template.status||'active'
    });
    setError('');
  }

  function appendVariable(key){
    setTemplateDraft(current=>({
      ...current,
      body:`${current.body}${current.body.endsWith('\n')?'':' '}{{${key}}}`
    }));
  }

  async function saveTemplate(event){
    event.preventDefault();
    if(!templateModal||!templateDraft)return;
    setBusy('save-template');
    setError('');
    try{
      await action('save_template',{
        templateId:templateModal.id,
        templateKey:templateModal.key,
        eventKey:templateModal.eventKey,
        channel:templateModal.channel,
        name:templateModal.name,
        description:templateModal.description,
        subject:templateDraft.subject,
        body:templateDraft.body,
        providerTemplateName:templateDraft.providerTemplateName,
        locale:templateDraft.locale,
        status:templateDraft.status
      });
      setNotice('تم حفظ القالب، وستستخدمه الرسائل الجديدة تلقائيًا.');
      setTemplateModal(null);
      setTemplateDraft(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy('');
    }
  }

  async function restoreTemplate(){
    if(!templateModal)return;
    setBusy('restore-template');
    setError('');
    try{
      await action('restore_template',{templateId:templateModal.id});
      setNotice('تمت استعادة النص الافتراضي للقالب.');
      setTemplateModal(null);
      setTemplateDraft(null);
      router.refresh();
    }catch(err){
      setError(err.message);
    }finally{
      setBusy('');
    }
  }

  if(mode==='templates')return <section className="mt-integration-hub">
    <IntegrationSummary summary={summary} templateMode/>
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&!templateModal&&<div className="mt-alert error">{error}</div>}
    <div className="mt-template-intro">
      <div>
        <small>SMART MESSAGE TEMPLATES</small>
        <h3>نماذج جاهزة بمتغيرات تخصيص ذكية</h3>
        <p>عدّل النص مرة واحدة؛ وسيضع النظام اسم المستفيد والدورة والموعد والرابط تلقائيًا عند كل إرسال.</p>
      </div>
      <div className="mt-variable-preview">
        {variables.slice(0,6).map(variable=><span key={variable.key}>
          {`{{${variable.key}}}`} <small>{variable.label}</small>
        </span>)}
      </div>
    </div>
    <div className="mt-template-grid">
      {templates.map(template=><article className="mt-template-card" key={template.id}>
        <header>
          <div><small>{template.eventKey}</small><h4>{template.name}</h4></div>
          <span className={template.isCustomized?'customized':'default'}>
            {template.isCustomized?'مخصص':'جاهز'}
          </span>
        </header>
        <p>{template.description}</p>
        <div className="mt-template-snippet">
          {renderTemplate(template.body,variables).slice(0,180)}
        </div>
        <footer>
          <div>{(template.variables||EMPTY).slice(0,4).map(key=>
            <code key={key}>{`{{${key}}}`}</code>
          )}</div>
          <button
            className="mt-button primary"
            onClick={()=>editTemplate(template)}
            disabled={!canManage}
          >تعديل ومعاينة</button>
        </footer>
      </article>)}
    </div>
    {templateModal&&templateDraft&&<TemplateModal
      template={templateModal}
      draft={templateDraft}
      variables={variables}
      busy={Boolean(busy)}
      error={error}
      onChange={setTemplateDraft}
      onAppend={appendVariable}
      onSave={saveTemplate}
      onRestore={restoreTemplate}
      onClose={()=>{if(!busy){setTemplateModal(null);setTemplateDraft(null)}}}
    />}
  </section>;

  return <section className="mt-integration-hub">
    <IntegrationSummary summary={summary}/>
    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&!providerModal&&<div className="mt-alert error">{error}</div>}
    <div className="mt-integration-guide">
      <span>1</span><div><b>اختر المزود</b><small>واتساب أو بريد أو API</small></div>
      <i>←</i>
      <span>2</span><div><b>أدخل البيانات المطلوبة فقط</b><small>الأسرار تُشفّر ولا تظهر مرة أخرى</small></div>
      <i>←</i>
      <span>3</span><div><b>اختبر ثم فعّل</b><small>لن يظهر «متصل» قبل نجاح اختبار حقيقي</small></div>
    </div>
    <section className="mt-provider-section" aria-label="Zoom">
      <header><div><h3>Zoom — المحاضرات المباشرة</h3><p>إدارة حسابات Zoom والمضيفين والمحاضرات من إعدادات الإضافة.</p></div></header>
      <div className="mt-integration-provider-grid">
        <article className="mt-integration-provider">
          <header><span className="mt-provider-symbol">Z</span><div><small>ZOOM</small><h4>حسابات Zoom وإعداداتها</h4></div></header>
          <p>{enabledChannels.has('zoom')?'افتح الإضافة لمراجعة تجهيزها وربط الحسابات. توفر الترخيص لا يعني أن الاتصال جاهز.':'تحتاج هذه المنشأة إلى ترخيص إضافة Zoom للوصول إلى إعداداتها.'}</p>
          <footer><Link className="mt-button primary" href={enabledChannels.has('zoom')?addonHref(slug,{key:'zoom'}):`/tenant/${encodeURIComponent(slug)}/addons-store`}>
            {enabledChannels.has('zoom')?'فتح إعدادات Zoom':'عرض متجر الإضافات'}
          </Link></footer>
        </article>
      </div>
    </section>
    {grouped.map(group=><section className="mt-provider-section" key={group.key}>
      <header><div><h3>{group.label}</h3><p>{group.description}</p></div><span>{group.providers.length} مزود</span></header>
      <div className="mt-integration-provider-grid">
        {group.providers.map(provider=><ProviderCard
          key={provider.key}
          provider={provider}
          busy={busy}
          canManage={canManage}
          onConfigure={()=>{setProviderModal(provider);setError('')}}
          onTest={()=>testConnection(provider)}
          onDefault={()=>setDefault(provider)}
          onDisable={()=>disable(provider)}
        />)}
      </div>
    </section>)}
    <div className="mt-security-note">
      <span>◆</span>
      <div><b>الأمان والعزل</b><p>كل منشأة لها إعداداتها وأسرارها المشفّرة منفصلة. الواجهة لا تسترجع مفاتيح API بعد حفظها، وسجل التدقيق يحفظ من غيّر الإعداد دون حفظ قيمة السر.</p></div>
    </div>
    {providerModal&&<ProviderModal
      provider={providerModal}
      busy={Boolean(busy)}
      error={error}
      onSave={saveProvider}
      onClose={()=>!busy&&setProviderModal(null)}
    />}
  </section>;
}

function IntegrationSummary({summary,templateMode=false}){
  return <section className="mt-kpis mt-integration-kpis">
    <article className="mt-kpi success"><span>اتصالات جاهزة</span><b>{summary.activeConnections||0}</b><small>نجح اختبارها فعليًا</small></article>
    <article className="mt-kpi"><span>إعدادات محفوظة</span><b>{summary.configuredConnections||0}</b><small>بيانات الدخول مشفّرة</small></article>
    <article className="mt-kpi"><span>قوالب نشطة</span><b>{summary.activeTemplates||0}</b><small>متاحة للرسائل التلقائية</small></article>
    <article className="mt-kpi"><span>{templateMode?'متغيرات ذكية':'تصميم قابل للإضافات'}</span><b>{templateMode?'13':'∞'}</b><small>{templateMode?'اسم ودورة وموعد ورابط':'كل مزود إضافة مستقلة'}</small></article>
  </section>;
}

function ProviderCard({
  provider,
  busy,
  canManage,
  onConfigure,
  onTest,
  onDefault,
  onDisable
}){
  const connection=provider.connection;
  const enabled=Boolean(provider.addonEnabled);
  const status=connection?.status||'disabled';
  return <article className={`mt-integration-provider ${connection?'configured':''} ${STATUS_TONE[status]||''}`}>
    <header>
      <span className="mt-provider-symbol">{providerSymbol(provider.key)}</span>
      <div><small>{provider.channel.toUpperCase()}</small><h4>{provider.name}</h4></div>
      <span className={`mt-provider-state ${STATUS_TONE[status]||''}`}>
        {enabled?(connection?STATUS[status]:'غير مهيأ'):'إضافة غير مفعلة'}
      </span>
    </header>
    <p>{provider.description}</p>
    <div className="mt-provider-meta">
      <span>{provider.status==='beta'?'تجريبي':'مدعوم'}</span>
      <span>إضافة مستقلة</span>
      {connection?.isDefault&&<span className="default">المزود الافتراضي</span>}
    </div>
    {connection&&<dl>
      <div><dt>الاسم</dt><dd>{connection.displayName}</dd></div>
      <div><dt>آخر اختبار</dt><dd>{connection.lastCheckedAt?new Date(connection.lastCheckedAt).toLocaleString('ar-SA'):'لم يُختبر'}</dd></div>
    </dl>}
    {connection?.lastError&&<small className="mt-provider-error">{connectionError(connection.lastError)}</small>}
    <footer>
      <button
        className="mt-button primary"
        onClick={onConfigure}
        disabled={!canManage||!enabled||Boolean(busy)}
      >{connection?'تعديل الإعداد':'تهيئة الآن'}</button>
      {connection&&<>
        <button
          className="mt-button"
          onClick={onTest}
          disabled={Boolean(busy)||connection.status==='disabled'}
        >{busy===`test-${provider.key}`?'جارٍ الاختبار…':'اختبار الاتصال'}</button>
        {!connection.isDefault&&connection.status!=='disabled'&&<button className="mt-link-button" onClick={onDefault} disabled={Boolean(busy)}>جعله افتراضيًا</button>}
        {connection.status!=='disabled'&&<button className="mt-link-button danger" onClick={onDisable} disabled={Boolean(busy)}>إيقاف</button>}
      </>}
    </footer>
  </article>;
}

function ProviderModal({provider,busy,error,onSave,onClose}){
  const config=provider.connection?.publicConfig||{};
  return <div className="mt-modal-layer">
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={onClose}/>
    <form className="mt-modal mt-integration-modal" onSubmit={onSave}>
      <header>
        <div><small>INTEGRATION SETUP</small><h3>تهيئة {provider.name}</h3><p>{provider.description}</p></div>
        <button type="button" onClick={onClose}>×</button>
      </header>
      <div className="mt-integration-modal-body">
        <div className="mt-setup-note"><span>1</span><p>أدخل البيانات كما تظهر في لوحة المزود. يمكنك حفظ المسودة ثم العودة لاستكمالها.</p></div>
        <div className="mt-form">
          <label className="mt-field wide">اسم الربط داخل ماركتون<input name="displayName" defaultValue={provider.connection?.displayName||provider.name} required/></label>
          {(provider.setupFields||EMPTY).map(field=><SetupField
            key={field.key}
            field={field}
            name={`config_${field.key}`}
            defaultValue={config[field.key]??field.defaultValue??''}
          />)}
          {(provider.secretFields||EMPTY).map(field=><label className="mt-field" key={field.key}>
            {field.label}
            <input
              name={`secret_${field.key}`}
              type="password"
              autoComplete="new-password"
              required={Boolean(field.required&&!configured(provider,field.key))}
              placeholder={configured(provider,field.key)?'•••••••• محفوظ ومشفّر':'أدخل القيمة من لوحة المزود'}
            />
            <small>{configured(provider,field.key)?'مضاف بالفعل — اتركه فارغًا للاحتفاظ به':'لن تظهر هذه القيمة بعد الحفظ'}</small>
          </label>)}
          <label className="mt-checkbox-card wide"><input type="checkbox" name="makeDefault" defaultChecked={provider.connection?.isDefault??true}/><span><b>استخدمه كمزود افتراضي</b><small>ستتجه إليه الرسائل الجديدة لهذه القناة بعد نجاح الاختبار.</small></span></label>
        </div>
        {error&&<div className="mt-alert error">{error}</div>}
        <div className="mt-secret-banner">بيانات API الحساسة تُرسل عبر اتصال آمن وتُحفظ مشفّرة. لن يعرضها النظام أو يضعها في سجل التعديلات.</div>
      </div>
      <footer>
        <button type="button" className="mt-button" onClick={onClose} disabled={busy}>إلغاء</button>
        <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ والتشفير…':'حفظ الإعداد'}</button>
      </footer>
    </form>
  </div>;
}

function SetupField({field,name,defaultValue}){
  if(field.type==='select')return <label className="mt-field">{field.label}<select name={name} defaultValue={defaultValue} required={Boolean(field.required)}>
    {(field.options||EMPTY).map(option=><option value={option} key={option}>{option}</option>)}
  </select></label>;
  return <label className="mt-field">{field.label}<input
    name={name}
    type={field.type||'text'}
    defaultValue={defaultValue}
    required={Boolean(field.required)}
    placeholder={field.placeholder||''}
    dir={['url','email'].includes(field.type)?'ltr':undefined}
  /></label>;
}

function TemplateModal({
  template,
  draft,
  variables,
  busy,
  error,
  onChange,
  onAppend,
  onSave,
  onRestore,
  onClose
}){
  const previewSubject=renderTemplate(draft.subject,variables);
  const previewBody=renderTemplate(draft.body,variables);
  return <div className="mt-modal-layer">
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={onClose}/>
    <form className="mt-modal mt-template-modal" onSubmit={onSave}>
      <header>
        <div><small>MESSAGE TEMPLATE</small><h3>{template.name}</h3><p>{template.description}</p></div>
        <button type="button" onClick={onClose}>×</button>
      </header>
      <div className="mt-template-editor">
        <section>
          <div className="mt-form">
            <label className="mt-field wide">عنوان البريد<input value={draft.subject} onChange={event=>onChange({...draft,subject:event.target.value})} placeholder="يُستخدم مع البريد الإلكتروني"/></label>
            <label className="mt-field wide">نص الرسالة<textarea rows="10" value={draft.body} onChange={event=>onChange({...draft,body:event.target.value})} required/></label>
            <label className="mt-field">اسم قالب واتساب المعتمد<input value={draft.providerTemplateName} onChange={event=>onChange({...draft,providerTemplateName:event.target.value})} placeholder="مثال: course_joining_ar" dir="ltr"/></label>
            <label className="mt-field">لغة القالب<input value={draft.locale} onChange={event=>onChange({...draft,locale:event.target.value})} placeholder="ar" dir="ltr" required/></label>
          </div>
          <div className="mt-variable-picker">
            <b>أضف متغيرًا إلى الرسالة</b>
            <div>{variables.map(variable=><button type="button" key={variable.key} onClick={()=>onAppend(variable.key)}>
              {variable.label}<code>{`{{${variable.key}}}`}</code>
            </button>)}</div>
          </div>
          {error&&<div className="mt-alert error">{error}</div>}
        </section>
        <aside className="mt-message-preview">
          <small>معاينة فورية</small>
          <div className="mt-preview-device">
            <header><span>م</span><div><b>ماركتون للتدريب</b><small>متصل الآن</small></div></header>
            <article><b>{previewSubject||template.name}</b><p>{previewBody}</p><time>الآن ✓✓</time></article>
          </div>
          <p>المعاينة تستخدم بيانات تجريبية فقط. عند الإرسال سيستبدل النظام المتغيرات ببيانات المتدرب الفعلية.</p>
        </aside>
      </div>
      <footer>
        <button type="button" className="mt-button" onClick={onClose} disabled={busy}>إغلاق</button>
        {template.isSystem&&template.isCustomized&&<button type="button" className="mt-button" onClick={onRestore} disabled={busy}>استعادة النص الجاهز</button>}
        <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':'حفظ القالب'}</button>
      </footer>
    </form>
  </div>;
}

function providerSymbol(key){
  return ({
    meta_whatsapp:'WA',
    webhook_whatsapp:'API',
    resend:'R',
    amazon_ses:'AWS',
    webhook_email:'API',
    custom_webhook:'{}'
  })[key]||'↗';
}

function connectionError(value){
  const errors={
    whatsapp_credentials_missing:'بيانات Meta غير مكتملة.',
    whatsapp_credentials_or_template_missing:'بيانات Meta أو اسم القالب المعتمد غير مكتملة.',
    resend_configuration_missing:'مفتاح Resend أو بريد الإرسال غير مكتمل.',
    amazon_ses_sender_missing:'حدد بريد إرسال موثّق في Amazon SES.',
    amazon_ses_not_configured:'بيانات AWS أو المنطقة غير مكتملة.',
    webhook_url_invalid:'رابط API غير صالح.',
    webhook_https_public_url_required:'يجب استخدام رابط HTTPS عام وآمن.',
    integration_configuration_missing:'احفظ إعدادات المزود أولًا.',
    connection_test_failed:'تعذر اختبار الاتصال.'
  };
  return errors[value]||String(value).replaceAll('_',' ');
}
