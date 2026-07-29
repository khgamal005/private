'use client';

import {useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';

const accountLabels={
  profile_only:'ملف وظيفي فقط',
  invited:'دعوة معلقة',
  active:'حساب نشط',
  suspended:'حساب موقوف'
};

const employmentLabels={
  active:'نشط',
  leave:'في إجازة',
  inactive:'غير نشط'
};

const reefDemoAliases={
  نور:'noor.demo',
  مي:'mai.demo',
  ليلى:'layla.demo',
  روان:'rawan.demo',
  عبدالجليل:'abdeljalil.demo',
  عمر:'omar.demo',
  رزان:'razan.demo',
  ياسمين:'yasmin.demo',
  داليا:'dalia.demo',
  وعد:'waad.demo',
  ياسر:'yasser.demo'
};

export default function TeamDirectory({
  slug,
  initialData,
  canManage,
  canInvite,
  canResetPasswords,
  platformAccess,
  viewerMembershipId,
  viewerRoleKeys
}){
  const router=useRouter();
  const [query,setQuery]=useState('');
  const [department,setDepartment]=useState('all');
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [error,setError]=useState('');
  const [invitationUrl,setInvitationUrl]=useState('');
  const [resetResult,setResetResult]=useState(null);
  const staff=useMemo(()=>initialData.employees||[],[initialData.employees]);
  const departments=initialData.departments||[];
  const roles=initialData.roles||[];
  const shown=useMemo(()=>staff.filter(item=>{
    const matchesDepartment=department==='all'||item.departmentKey===department;
    const haystack=`${item.name||''} ${item.jobTitle||''} ${item.role||''} ${item.department||''} ${item.email||''}`;
    return matchesDepartment&&haystack.toLowerCase().includes(query.toLowerCase());
  }),[staff,department,query]);
  const sales=staff.filter(item=>['sales_user','sales_supervisor','sales_manager'].includes(item.roleKey));
  const activeAccounts=staff.filter(item=>item.accountStatus==='active').length;
  const managerProfiles=staff.filter(item=>['tenant_admin','executive_manager'].includes(item.roleKey));

  function openCreate(roleKey='sales_user'){
    setError('');
    setInvitationUrl('');
    setResetResult(null);
    setModal({
      type:'create',
      roleKey,
      departmentKey:['tenant_admin','executive_manager'].includes(roleKey)
        ?'management'
        :'sales'
    });
  }

  function openEdit(staffMember){
    setError('');
    setInvitationUrl('');
    setResetResult(null);
    setModal({type:'edit',staff:staffMember});
  }

  function openInvite(staffMember){
    setError('');
    setInvitationUrl('');
    setResetResult(null);
    setModal({
      type:'invite',
      staff:staffMember,
      suggestedEmail:staffMember.email||demoEmail(staffMember,slug)
    });
  }

  function openPasswordReset(staffMember){
    setError('');
    setMessage('');
    setInvitationUrl('');
    setResetResult(null);
    setModal({type:'resetPassword',staff:staffMember});
  }

  function closeModal(){
    if(busy)return;
    setModal(null);
    setError('');
    setInvitationUrl('');
    setResetResult(null);
  }

  async function call(action,body){
    const response=await fetch(`/api/tenant/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    const payload=await response.json();
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }

  async function saveStaff(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const isEdit=modal.type==='edit';
    try{
      await call(isEdit?'update-staff':'create-staff',isEdit?{
        p_tenant_slug:slug,
        p_staff_id:modal.staff.id,
        p_full_name:values.full_name,
        p_role_key:values.role_key,
        p_department_key:values.department_key,
        p_job_title:values.job_title,
        p_email:values.email||null,
        p_phone:values.phone||null,
        p_employment_status:values.employment_status||'active',
        p_capacity_minutes_weekly:Number(values.capacity_minutes_weekly||2400)
      }:{
        p_tenant_slug:slug,
        p_full_name:values.full_name,
        p_role_key:values.role_key,
        p_department_key:values.department_key,
        p_job_title:values.job_title,
        p_email:values.email||null,
        p_phone:values.phone||null
      });
      setMessage(isEdit
        ?'تم تحديث بيانات الموظف وصلاحياته'
        :'تم إنشاء الملف الوظيفي وربطه بهيكل المنشأة'
      );
      setModal(null);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function inviteStaff(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');setInvitationUrl('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    try{
      const data=await call('invite-staff',{
        p_tenant_slug:slug,
        p_staff_id:modal.staff.id,
        p_email:values.email
      });
      if(data.status==='linked'){
        setMessage('تم ربط الموظف بحسابه الموجود وتفعيل صلاحياته مباشرة');
        setModal(null);
      }else{
        const url=`${window.location.origin}/accept-invite?token=${encodeURIComponent(data.invitationToken)}`;
        setInvitationUrl(url);
        setMessage('تم إنشاء الدعوة. انسخ رابط التفعيل وأرسله للموظف.');
      }
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function copyInvitation(){
    await navigator.clipboard.writeText(invitationUrl);
    setMessage('تم نسخ رابط التفعيل');
  }

  async function resetPassword(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');setResetResult(null);
    try{
      const response=await fetch('/api/tenant/reset-staff-password',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          p_tenant_slug:slug,
          p_staff_id:modal.staff.id
        })
      });
      const payload=await response.json();
      if(!response.ok){
        throw new Error(payload.error||'تعذر إعادة تعيين كلمة المرور');
      }
      setResetResult(payload.data);
      setMessage('');
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  async function copyTemporaryPassword(){
    await navigator.clipboard.writeText(resetResult.temporaryPassword);
    setMessage('تم نسخ كلمة المرور المؤقتة');
  }

  function canReset(staffMember){
    if(!canResetPasswords||staffMember.accountStatus!=='active')return false;
    if(staffMember.membershipId&&staffMember.membershipId===viewerMembershipId){
      return false;
    }
    if(platformAccess)return true;
    const viewerRank=Math.max(
      0,
      ...(viewerRoleKeys||[]).map(roleRank)
    );
    return viewerRank>roleRank(staffMember.roleKey);
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>PEOPLE & ACCESS</small>
        <h2>فريق عمل ريف المهارات</h2>
        <p>أكمل البيانات من لوحة المنشأة، ثم حوّل أي ملف وظيفي إلى حساب دخول بالدور والصلاحيات المحددة.</p>
      </div>
      <div className="mt-page-actions">
        {canManage&&<button className="mt-button primary" onClick={()=>openCreate()}>+ إضافة موظف</button>}
      </div>
    </header>

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}
    {!managerProfiles.length&&<section className="mt-data-note warning">
      <div>
        <b>مدير المنشأة والمدير التنفيذي جاهزان للإضافة من لوحة التحكم</b>
        <p>اترك الاسم والبريد فارغين الآن، أو أضفهما لاحقًا ثم أرسل دعوة الدخول. كلا الدورين يملك جميع الصلاحيات الحالية.</p>
      </div>
      {canManage&&<div className="mt-data-note-actions">
        <button className="mt-button soft" onClick={()=>openCreate('tenant_admin')}>+ مدير منشأة</button>
        <button className="mt-button soft" onClick={()=>openCreate('executive_manager')}>+ مدير تنفيذي</button>
      </div>}
    </section>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>إجمالي الفريق</span><b>{staff.length}</b><small>ملفًا وظيفيًا فعليًا</small></article>
      <article className="mt-kpi"><span>فريق المبيعات</span><b>{sales.length}</b><small>7 مسؤولين + مشرف</small></article>
      <article className="mt-kpi"><span>حسابات الدخول النشطة</span><b>{activeAccounts}</b><small>{staff.length-activeAccounts} ملفات بلا دخول نشط</small></article>
      <article className="mt-kpi"><span>الأقسام</span><b>{departments.length}</b><small>إدارة ومبيعات وخدمة عملاء وبيانات</small></article>
    </section>

    <section className="mt-panel">
      <div className="mt-toolbar">
        <div className="mt-segmented">
          <button className={department==='all'?'active':''} onClick={()=>setDepartment('all')}>الكل</button>
          {departments.map(item=><button
            className={department===item.key?'active':''}
            onClick={()=>setDepartment(item.key)}
            key={item.id}
          >{item.nameAr}</button>)}
        </div>
        <input
          className="mt-search"
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث بالاسم أو الوظيفة أو البريد"
        />
      </div>
      <div className="mt-team-grid">
        {shown.map(item=><article className="mt-person-card" key={item.id}>
          <header>
            <span className="mt-person-avatar">{item.name?.[0]||'م'}</span>
            <div><h3>{item.name}</h3><p>{item.jobTitle||item.role}</p></div>
            <em className={item.status==='active'?'mt-status active':'mt-status'}>{employmentLabels[item.status]||item.status}</em>
          </header>
          <dl>
            <div><dt>القسم</dt><dd>{item.department||'غير محدد'}</dd></div>
            <div><dt>الدور</dt><dd>{item.role||item.roleKey}</dd></div>
            <div><dt>البريد</dt><dd>{item.email||'لم يضف بعد'}</dd></div>
            <div><dt>الجوال</dt><dd>{item.phone||'لم يضف بعد'}</dd></div>
          </dl>
          <footer>
            <span className={`mt-account-state ${item.accountStatus==='active'?'active':''}`}>
              {accountLabels[item.accountStatus]||item.accountStatus}
            </span>
            {canManage&&<div className="mt-card-actions">
              <button className="mt-button soft" onClick={()=>openEdit(item)}>تعديل البيانات</button>
              {canInvite&&item.accountStatus!=='active'&&<button className="mt-button" onClick={()=>openInvite(item)}>
                {item.accountStatus==='invited'?'إعادة الدعوة':'دعوة للدخول'}
              </button>}
              {canReset(item)&&<button className="mt-button" onClick={()=>openPasswordReset(item)}>
                إعادة تعيين كلمة المرور
              </button>}
            </div>}
          </footer>
        </article>)}
        {!shown.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}
      </div>
    </section>

    {modal?.type==='invite'&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>
      <form className="mt-modal" onSubmit={inviteStaff}>
        <header>
          <div><small>ACCOUNT ACTIVATION</small><h3>دعوة {modal.staff.name} للدخول</h3></div>
          <button type="button" onClick={closeModal}>×</button>
        </header>
        <div className="mt-form">
          <label className="mt-field wide">
            البريد الإلكتروني
            <input
              name="email"
              type="email"
              defaultValue={modal.suggestedEmail}
              required
            />
          </label>
          {modal.suggestedEmail?.endsWith('.demo@reefskills.sa')&&<div className="mt-field wide mt-inline-help">
            هذا عنوان تجريبي مقترح تحت دومين ريف، ولا يعني وجود صندوق بريد فعلي. غيّره إلى البريد الحقيقي قبل التشغيل الفعلي.
          </div>}
          {invitationUrl&&<div className="mt-invitation-link mt-field wide">
            <span>رابط التفعيل يظهر مرة واحدة</span>
            <input readOnly value={invitationUrl}/>
            <button type="button" className="mt-button" onClick={copyInvitation}>نسخ الرابط</button>
          </div>}
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={closeModal}>إغلاق</button>
          {!invitationUrl&&<button className="mt-button primary" disabled={busy}>{busy?'جارٍ إنشاء الدعوة…':'حفظ البريد وإنشاء الدعوة'}</button>}
        </footer>
      </form>
    </div>}

    {modal?.type==='resetPassword'&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>
      <form className="mt-modal mt-password-reset-modal" onSubmit={resetPassword}>
        <header>
          <div><small>SECURE PASSWORD RESET</small><h3>إعادة كلمة مرور {modal.staff.name}</h3></div>
          <button type="button" onClick={closeModal}>×</button>
        </header>
        <div className="mt-form">
          {!resetResult&&<>
            <div className="mt-field wide mt-reset-warning">
              <b>سيتم إلغاء كلمة المرور الحالية</b>
              <p>سينشئ النظام كلمة مؤقتة قوية، ولن تُعرض إلا مرة واحدة. يجب إرسالها للموظف عبر قناة آمنة، وسيُطلب منه تغييرها فور تسجيل الدخول.</p>
            </div>
            <dl className="mt-field wide mt-reset-account">
              <div><dt>الموظف</dt><dd>{modal.staff.name}</dd></div>
              <div><dt>البريد</dt><dd>{modal.staff.email}</dd></div>
              <div><dt>الدور</dt><dd>{modal.staff.role}</dd></div>
            </dl>
            <label className="mt-field wide mt-confirm-reset">
              <input name="confirm_reset" type="checkbox" required/>
              <span>أؤكد أنني أريد إعادة تعيين كلمة مرور هذا الموظف.</span>
            </label>
          </>}
          {resetResult&&<div className="mt-field wide mt-reset-success">
            <b>تم إنشاء كلمة المرور المؤقتة</b>
            <p>انسخها الآن؛ لن يحتفظ النظام بنسخة قابلة للعرض منها.</p>
            <div>
              <input
                dir="ltr"
                readOnly
                value={resetResult.temporaryPassword}
                aria-label="كلمة المرور المؤقتة"
              />
              <button type="button" className="mt-button" onClick={copyTemporaryPassword}>نسخ</button>
            </div>
          </div>}
          {message&&<div className="mt-alert mt-field wide">{message}</div>}
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={closeModal}>
            {resetResult?'تم':'إلغاء'}
          </button>
          {!resetResult&&<button className="mt-button primary" disabled={busy}>
            {busy?'جارٍ إعادة التعيين…':'إنشاء كلمة مرور مؤقتة'}
          </button>}
        </footer>
      </form>
    </div>}

    {modal&&['create','edit'].includes(modal.type)&&<div className="mt-modal-layer">
      <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={closeModal}/>
      <form className="mt-modal" onSubmit={saveStaff}>
        <header>
          <div><small>STAFF PROFILE</small><h3>{modal.type==='edit'?'تعديل بيانات الموظف':'إضافة موظف إلى المنشأة'}</h3></div>
          <button type="button" onClick={closeModal}>×</button>
        </header>
        <div className="mt-form">
          <label className="mt-field wide">اسم الموظف<input name="full_name" defaultValue={modal.staff?.name||''} required/></label>
          <label className="mt-field">المسمى الوظيفي<input name="job_title" defaultValue={modal.staff?.jobTitle||roleJobTitle(modal.roleKey)} required/></label>
          <label className="mt-field">الدور<select name="role_key" defaultValue={modal.staff?.roleKey||modal.roleKey||'sales_user'}>
            {roles.map(role=><option value={role.key} key={role.key}>{role.nameAr}</option>)}
          </select></label>
          <label className="mt-field">القسم<select name="department_key" defaultValue={modal.staff?.departmentKey||modal.departmentKey||'sales'}>
            {departments.map(item=><option value={item.key} key={item.key}>{item.nameAr}</option>)}
          </select></label>
          <label className="mt-field">البريد — اختياري<input name="email" type="email" defaultValue={modal.staff?.email||''}/></label>
          <label className="mt-field">الجوال — اختياري<input name="phone" inputMode="tel" defaultValue={modal.staff?.phone||''}/></label>
          {modal.type==='edit'&&<>
            <label className="mt-field">الحالة الوظيفية<select name="employment_status" defaultValue={modal.staff?.status||'active'}>
              <option value="active">نشط</option>
              <option value="leave">في إجازة</option>
              <option value="inactive">غير نشط</option>
            </select></label>
            <label className="mt-field">الطاقة الأسبوعية بالدقائق<input name="capacity_minutes_weekly" type="number" min="0" max="10080" defaultValue={modal.staff?.capacityMinutesWeekly||2400}/></label>
          </>}
          <div className="mt-field wide mt-inline-help">
            إضافة البريد هنا تحفظه في الملف فقط. إنشاء حساب الدخول يتم من زر «دعوة للدخول» بعد مراجعة الدور.
          </div>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={closeModal}>إلغاء</button>
          <button className="mt-button primary" disabled={busy}>{busy?'جارٍ الحفظ…':modal.type==='edit'?'حفظ التعديلات':'حفظ الملف الوظيفي'}</button>
        </footer>
      </form>
    </div>}
  </>;
}

function demoEmail(staffMember,slug){
  if(slug!=='reef-skills')return '';
  const alias=reefDemoAliases[staffMember.name];
  return alias?`${alias}@reefskills.sa`:'';
}

function roleJobTitle(roleKey){
  return ({
    tenant_admin:'مدير المنشأة',
    executive_manager:'المدير التنفيذي',
    sales_user:'مسؤول مبيعات'
  })[roleKey]||'موظف';
}

function roleRank(roleKey){
  return ({
    tenant_owner:100,
    tenant_admin:90,
    executive_manager:80,
    sales_manager:70,
    sales_supervisor:60,
    training_manager:60,
    sales_user:40,
    customer_service:40,
    data_officer:40,
    data_analyst:40
  })[roleKey]||10;
}
