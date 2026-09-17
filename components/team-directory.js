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
  نور:'noor.demo',مي:'mai.demo',ليلى:'layla.demo',روان:'rawan.demo',
  عبدالجليل:'abdeljalil.demo',عمر:'omar.demo',رزان:'razan.demo',
  ياسمين:'yasmin.demo',داليا:'dalia.demo',وعد:'waad.demo',ياسر:'yasser.demo'
};

export default function TeamDirectory({
  slug,
  initialData,
  salesTeams,
  staffExtensions,
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
  const supervisors=salesTeams?.supervisors||[];
  const salesMembers=salesTeams?.members||[];
  const yeastarEnabled=Boolean(staffExtensions?.enabled);
  const yeastarConfigured=yeastarEnabled&&Boolean(staffExtensions?.configured);
  const supervisorByStaffId=useMemo(()=>new Map(
    salesMembers.map(member=>[member.id,member.supervisorStaffId||''])
  ),[salesMembers]);
  const supervisorNameById=useMemo(()=>new Map(
    supervisors.map(supervisor=>[supervisor.id,supervisor.name])
  ),[supervisors]);
  const extensionByStaffId=useMemo(()=>new Map(
    (staffExtensions?.enabled?staffExtensions.extensions||[]:[]).map(item=>[
      item.staffId,
      item.extension||''
    ])
  ),[staffExtensions]);
  const shown=useMemo(()=>staff.filter(item=>{
    const matchesDepartment=department==='all'||item.departmentKey===department;
    const extension=yeastarEnabled?(extensionByStaffId.get(item.id)||''):'';
    const haystack=`${item.name||''} ${item.jobTitle||''} ${item.role||''} ${item.department||''} ${item.email||''} ${item.phone||''} ${extension}`;
    return matchesDepartment&&haystack.toLowerCase().includes(query.toLowerCase());
  }),[staff,department,query,extensionByStaffId,yeastarEnabled]);
  const sales=staff.filter(item=>[
    'sales_user','sales_supervisor','sales_manager'
  ].includes(item.roleKey));
  const activeAccounts=staff.filter(item=>item.accountStatus==='active').length;
  const managerProfiles=staff.filter(item=>[
    'tenant_admin','executive_manager'
  ].includes(item.roleKey));

  function resetModalState(){
    setError('');
    setInvitationUrl('');
    setResetResult(null);
  }

  function openCreate(roleKey='sales_user'){
    resetModalState();
    setModal({
      type:'create',
      roleKey,
      selectedRole:roleKey,
      departmentKey:['tenant_admin','executive_manager'].includes(roleKey)
        ?'management'
        :'sales'
    });
  }

  function openEdit(staffMember){
    resetModalState();
    setModal({
      type:'edit',
      selectedRole:staffMember.roleKey,
      staff:{
        ...staffMember,
        supervisorStaffId:supervisorByStaffId.get(staffMember.id)||'',
        yeastarExtension:yeastarEnabled
          ?extensionByStaffId.get(staffMember.id)||''
          :''
      }
    });
  }

  function openInvite(staffMember){
    resetModalState();
    setModal({
      type:'invite',
      staff:staffMember,
      suggestedEmail:staffMember.email||demoEmail(staffMember,slug)
    });
  }

  function openPasswordReset(staffMember){
    resetModalState();
    setMessage('');
    setModal({type:'resetPassword',staff:staffMember});
  }

  function openStaffAccount(staffMember){
    resetModalState();
    setModal({type:'createAccount',staff:staffMember});
  }

  async function createStaffAccount(event){
    event.preventDefault();
    const form=event.currentTarget;
    const values=new FormData(form);
    if(values.get('password')!==values.get('confirm')){setError('كلمتا المرور غير متطابقتين');return;}
    setBusy(true);setError('');setMessage('');
    try{
      const data=await call('create-staff-account',{p_tenant_slug:slug,p_staff_id:modal.staff.id,password:values.get('password')});
      form.reset();
      setMessage(data.passwordUnchanged
        ?'اكتمل تفعيل الحساب بكلمة المرور المحددة في المحاولة الأولى. يجب على الموظف تغييرها عند الدخول.'
        :'تم تفعيل الحساب. سلّم كلمة المرور المؤقتة للموظف؛ سيُطلب منه تغييرها عند أول دخول.');
      setModal(null);
      router.refresh();
    }catch(err){setError(err.message)}finally{setBusy(false)}
  }

  function canCreateAccount(staffMember){
    if(!canManage||!canInvite||!canResetPasswords)return false;
    if(!['profile_only','invited'].includes(staffMember.accountStatus)||staffMember.status==='inactive')return false;
    return platformAccess||Math.max(0,...(viewerRoleKeys||[]).map(roleRank))>roleRank(staffMember.roleKey);
  }

  function closeModal(){
    if(busy)return;
    setModal(null);
    resetModalState();
  }

  async function call(action,body){
    const response=await fetch(`/api/tenant/${action}`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(body)
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||'تعذر تنفيذ العملية');
    return payload.data;
  }

  async function assignSalesSupervisor(staffId,supervisorStaffId){
    const response=await fetch('/api/tenant/sales-teams',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        tenantSlug:slug,
        staffId,
        supervisorStaffId:supervisorStaffId||null
      })
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||'تعذر حفظ إسناد المشرف');
    return payload.data;
  }

  async function assignYeastarExtension(staffId,extension){
    const response=await fetch('/api/tenant/staff-extension',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        tenantSlug:slug,
        staffId,
        extension:String(extension||'').trim()||null
      })
    });
    const payload=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(payload.error||'تعذر حفظ تحويلة Yeastar');
    return payload.data;
  }

  async function saveStaff(event){
    event.preventDefault();
    setBusy(true);setError('');setMessage('');
    const values=Object.fromEntries(new FormData(event.currentTarget).entries());
    const isEdit=modal.type==='edit';
    const previousRole=modal.staff?.roleKey;
    const nextRole=values.role_key;
    try{
      if(isEdit&&previousRole==='sales_user'&&nextRole!=='sales_user'){
        await assignSalesSupervisor(modal.staff.id,null);
      }
      const saved=await call(isEdit?'update-staff':'create-staff',isEdit?{
        p_tenant_slug:slug,
        p_staff_id:modal.staff.id,
        p_full_name:values.full_name,
        p_role_key:nextRole,
        p_department_key:values.department_key,
        p_job_title:values.job_title,
        p_email:values.email||null,
        p_phone:values.phone||null,
        p_employment_status:values.employment_status||'active',
        p_capacity_minutes_weekly:Number(values.capacity_minutes_weekly||2400)
      }:{
        p_tenant_slug:slug,
        p_full_name:values.full_name,
        p_role_key:nextRole,
        p_department_key:values.department_key,
        p_job_title:values.job_title,
        p_email:values.email||null,
        p_phone:values.phone||null
      });
      const staffId=isEdit?modal.staff.id:saved?.id;
      if(staffId&&nextRole==='sales_user'&&values.supervisor_staff_id){
        await assignSalesSupervisor(staffId,values.supervisor_staff_id);
      }else if(isEdit&&nextRole==='sales_user'){
        await assignSalesSupervisor(staffId,null);
      }
      if(staffId&&yeastarConfigured){
        await assignYeastarExtension(staffId,values.yeastar_extension||null);
      }
      setMessage(isEdit
        ?yeastarEnabled
          ?'تم تحديث بيانات الموظف والمشرف وتحويلة Yeastar'
          :'تم تحديث بيانات الموظف والمشرف'
        :'تم إنشاء الملف الوظيفي وحفظ بيانات الاتصال'
      );
      if(!isEdit&&saved?.accountStatus!=='active'&&values.account_setup!=='profile'){
        const member={id:staffId,name:values.full_name,email:values.email,roleKey:nextRole,accountStatus:saved?.accountStatus||'profile_only',status:'active'};
        if(values.account_setup==='password')openStaffAccount(member);
        else if(values.account_setup==='invite')openInvite(member);
        else setModal(null);
      }else setModal(null);
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
      const payload=await response.json().catch(()=>({}));
      if(!response.ok){
        throw new Error(payload.error||'تعذر إعادة تعيين كلمة المرور');
      }
      setResetResult(payload.data);
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
    const viewerRank=Math.max(0,...(viewerRoleKeys||[]).map(roleRank));
    return viewerRank>roleRank(staffMember.roleKey);
  }

  return <>
    <header className="mt-page-head">
      <div>
        <small>PEOPLE & ACCESS</small>
        <h2>فريق عمل {initialData.tenant?.name||'المنشأة'}</h2>
        <p>{yeastarEnabled
          ?'إدارة بيانات الموظفين والأدوار والمشرف المباشر وتحويلات Yeastar من ملف وظيفي واحد.'
          :'إدارة بيانات الموظفين والأدوار والمشرف المباشر وحسابات الدخول.'}
        </p>
      </div>
      <div className="mt-page-actions">
        {canManage&&<button className="mt-button primary" onClick={()=>openCreate()}>
          + إضافة موظف
        </button>}
      </div>
    </header>

    {message&&<div className="mt-alert">{message}</div>}
    {error&&!modal&&<div className="mt-alert error">{error}</div>}
    {yeastarEnabled&&!yeastarConfigured&&<section className="mt-data-note warning">
      <div>
        <b>إضافة Yeastar مفعّلة ولم يكتمل ربط السنترال</b>
        <p>استكمل بيانات الاتصال من الإعدادات ليصبح رقم التحويلة قابلًا للحفظ داخل ملف الموظف.</p>
      </div>
    </section>}
    {!managerProfiles.length&&<section className="mt-data-note warning">
      <div>
        <b>مدير المنشأة والمدير التنفيذي جاهزان للإضافة من لوحة التحكم</b>
        <p>يمكن إنشاء الملف ثم تعيين كلمة مرور مؤقتة أو إنشاء دعوة الدخول بعد مراجعة الدور والصلاحيات.</p>
      </div>
      {canManage&&<div className="mt-data-note-actions">
        <button className="mt-button soft" onClick={()=>openCreate('tenant_admin')}>
          + مدير منشأة
        </button>
        <button className="mt-button soft" onClick={()=>openCreate('executive_manager')}>
          + مدير تنفيذي
        </button>
      </div>}
    </section>}

    <section className="mt-kpis">
      <article className="mt-kpi"><span>إجمالي الفريق</span><b>{staff.length}</b><small>ملفًا وظيفيًا فعليًا</small></article>
      <article className="mt-kpi"><span>فريق المبيعات</span><b>{sales.length}</b><small>مسؤولو ومشرفو المبيعات</small></article>
      {yeastarEnabled
        ?<article className="mt-kpi"><span>تحويلات مرتبطة</span><b>{extensionByStaffId.size}</b><small>مرتبطة بتقارير المكالمات</small></article>
        :<article className="mt-kpi"><span>الأقسام</span><b>{departments.length}</b><small>أقسام مفعّلة داخل المنشأة</small></article>}
      <article className="mt-kpi"><span>حسابات نشطة</span><b>{activeAccounts}</b><small>{staff.length-activeAccounts} ملفات بلا دخول نشط</small></article>
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
          placeholder={yeastarEnabled
            ?'ابحث بالاسم أو الوظيفة أو التحويلة'
            :'ابحث بالاسم أو الوظيفة أو البريد'}
        />
      </div>
      <div className="mt-team-grid">
        {shown.map(item=>{
          const supervisorId=supervisorByStaffId.get(item.id)||'';
          const extension=yeastarEnabled
            ?extensionByStaffId.get(item.id)||''
            :'';
          return <article className="mt-person-card" key={item.id}>
            <header>
              <span className="mt-person-avatar">{item.name?.[0]||'م'}</span>
              <div><h3>{item.name}</h3><p>{item.jobTitle||item.role}</p></div>
              <em className={item.status==='active'?'mt-status active':'mt-status'}>
                {employmentLabels[item.status]||item.status}
              </em>
            </header>
            <dl>
              <div><dt>القسم</dt><dd>{item.department||'غير محدد'}</dd></div>
              <div><dt>الدور</dt><dd>{item.role||item.roleKey}</dd></div>
              {item.roleKey==='sales_user'&&<div>
                <dt>المشرف المباشر</dt>
                <dd>{supervisorNameById.get(supervisorId)||'غير مسند'}</dd>
              </div>}
              {yeastarEnabled&&<div>
                <dt>تحويلة Yeastar</dt>
                <dd dir="ltr">{extension||'غير مضافة'}</dd>
              </div>}
              <div><dt>البريد</dt><dd>{item.email||'لم يضف بعد'}</dd></div>
              <div><dt>الجوال</dt><dd>{item.phone||'لم يضف بعد'}</dd></div>
            </dl>
            <footer>
              <span className={`mt-account-state ${item.accountStatus==='active'?'active':''}`}>
                {accountLabels[item.accountStatus]||item.accountStatus}
              </span>
              {canManage&&<div className="mt-card-actions">
                <button className="mt-button soft" onClick={()=>openEdit(item)}>تعديل البيانات</button>
                {canInvite&&item.accountStatus!=='active'&&<button
                  className="mt-button"
                  onClick={()=>openInvite(item)}
                >{item.accountStatus==='invited'?'إعادة الدعوة':'دعوة للدخول'}</button>}
                {canCreateAccount(item)&&<button className="mt-button primary" onClick={()=>openStaffAccount(item)}>تعيين كلمة مرور وتفعيل الحساب</button>}
                {canReset(item)&&<button
                  className="mt-button"
                  onClick={()=>openPasswordReset(item)}
                >إعادة تعيين كلمة المرور</button>}
              </div>}
            </footer>
          </article>;
        })}
        {!shown.length&&<div className="mt-empty">لا توجد نتائج مطابقة.</div>}
      </div>
    </section>

    {modal?.type==='invite'&&<Modal title={`دعوة ${modal.staff.name} للدخول`} onClose={closeModal}>
      <form onSubmit={inviteStaff}>
        <div className="mt-form">
          <label className="mt-field wide">البريد الإلكتروني
            <input name="email" type="email" defaultValue={modal.suggestedEmail} required/>
          </label>
          {invitationUrl&&<div className="mt-invitation-link mt-field wide">
            <span>رابط التفعيل يظهر مرة واحدة</span>
            <input readOnly value={invitationUrl}/>
            <button type="button" className="mt-button" onClick={copyInvitation}>نسخ الرابط</button>
          </div>}
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={closeModal}>إغلاق</button>
          {!invitationUrl&&<button className="mt-button primary" disabled={busy}>
            {busy?'جارٍ إنشاء الدعوة…':'حفظ البريد وإنشاء الدعوة'}
          </button>}
        </footer>
      </form>
    </Modal>}

    {modal?.type==='createAccount'&&<Modal title={`تفعيل حساب ${modal.staff.name}`} onClose={closeModal}>
      <form onSubmit={createStaffAccount}>
        <div className="mt-form">
          <div className="mt-field wide"><b>{modal.staff.email||'احفظ بريد الموظف من تعديل البيانات أولًا'}</b>
            <p>حدد كلمة مرور مؤقتة من 12 إلى 128 حرفًا. لن تظهر بعد الحفظ، ويجب على الموظف تغييرها عند أول دخول.</p>
          </div>
          <label className="mt-field wide">كلمة المرور المؤقتة<input name="password" type="password" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
          <label className="mt-field wide">تأكيد كلمة المرور<input name="confirm" type="password" minLength={12} maxLength={128} autoComplete="new-password" required/></label>
          {error&&<div role="alert" className="mt-alert mt-field wide">{error}</div>}
        </div>
        <footer><button type="button" className="mt-button" onClick={closeModal}>إلغاء</button>
          <button className="mt-button primary" disabled={busy||!modal.staff.email}>{busy?'جارٍ التفعيل…':'تفعيل الحساب بكلمة المرور'}</button>
        </footer>
      </form>
    </Modal>}

    {modal?.type==='resetPassword'&&<Modal className="mt-password-reset-modal" title={`إعادة كلمة مرور ${modal.staff.name}`} onClose={closeModal}>
      <form className="mt-password-reset-form" onSubmit={resetPassword}>
        <div className="mt-form">
          {!resetResult?<>
            <div className="mt-field wide mt-reset-warning">
              <b>سيتم إلغاء كلمة المرور الحالية</b>
              <p>سينشئ النظام كلمة مؤقتة قوية تُعرض مرة واحدة.</p>
            </div>
            <label className="mt-field wide mt-confirm-reset">
              <input name="confirm_reset" type="checkbox" required/>
              <span>أؤكد إعادة تعيين كلمة مرور هذا الموظف.</span>
            </label>
          </>:<div className="mt-field wide mt-reset-success">
            <b>تم إنشاء كلمة المرور المؤقتة</b>
            <div>
              <input aria-label="كلمة المرور المؤقتة" dir="ltr" readOnly value={resetResult.temporaryPassword}/>
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
    </Modal>}

    {modal&&['create','edit'].includes(modal.type)&&<Modal
      title={modal.type==='edit'?'تعديل بيانات الموظف':'إضافة موظف إلى المنشأة'}
      onClose={closeModal}
    >
      <form onSubmit={saveStaff}>
        <div className="mt-form">
          <label className="mt-field wide">اسم الموظف
            <input name="full_name" defaultValue={modal.staff?.name||''} required/>
          </label>
          <label className="mt-field">المسمى الوظيفي
            <input name="job_title" defaultValue={modal.staff?.jobTitle||roleJobTitle(modal.roleKey)} required/>
          </label>
          <label className="mt-field">الدور
            <select
              name="role_key"
              value={modal.selectedRole||'sales_user'}
              onChange={event=>setModal(current=>({
                ...current,
                selectedRole:event.target.value
              }))}
            >{roles.map(role=><option value={role.key} key={role.key}>{role.nameAr}</option>)}</select>
          </label>
          <label className="mt-field">القسم
            <select name="department_key" defaultValue={modal.staff?.departmentKey||modal.departmentKey||'sales'}>
              {departments.map(item=><option value={item.key} key={item.key}>{item.nameAr}</option>)}
            </select>
          </label>
          <label className="mt-field">البريد — اختياري
            <input name="email" type="email" defaultValue={modal.staff?.email||''}/>
          </label>
          <label className="mt-field">الجوال — اختياري
            <input name="phone" inputMode="tel" defaultValue={modal.staff?.phone||''}/>
          </label>
          {yeastarEnabled&&<label className="mt-field">
            رقم تحويلة Yeastar — اختياري
            <input
              name="yeastar_extension"
              dir="ltr"
              inputMode="numeric"
              pattern="[0-9]{1,10}"
              maxLength={10}
              defaultValue={modal.staff?.yeastarExtension||''}
              disabled={!yeastarConfigured}
            />
            <small>{yeastarConfigured
              ?'تربط مكالمات هذه التحويلة بلوحة أداء الموظف وتقاريره.'
              :'استكمل ربط السنترال من الإعدادات أولًا.'}
            </small>
          </label>}
          {modal.selectedRole==='sales_user'&&<label className="mt-field wide">
            المشرف المباشر
            <select name="supervisor_staff_id" defaultValue={modal.staff?.supervisorStaffId||''}>
              <option value="">غير مسند إلى مشرف</option>
              {supervisors.map(supervisor=><option value={supervisor.id} key={supervisor.id}>
                {supervisor.name} — {supervisor.jobTitle||'مشرف مبيعات'}
              </option>)}
            </select>
            <small>يُستخدم في ترتيب المبيعات ولوحات الأداء وتقارير الفريق.</small>
          </label>}
          {modal.type==='edit'&&<>
            <label className="mt-field">الحالة الوظيفية
              <select name="employment_status" defaultValue={modal.staff?.status||'active'}>
                <option value="active">نشط</option>
                <option value="leave">في إجازة</option>
                <option value="inactive">غير نشط</option>
              </select>
            </label>
            <label className="mt-field">الطاقة الأسبوعية بالدقائق
              <input
                name="capacity_minutes_weekly"
                type="number"
                min="0"
                max="10080"
                defaultValue={modal.staff?.capacityMinutesWeekly||2400}
              />
            </label>
          </>}
          {modal.type==='create'&&canInvite&&<label className="mt-field wide">حساب الدخول بعد حفظ الملف
            <select name="account_setup" defaultValue={canResetPasswords?'password':'invite'}>
              {canResetPasswords&&<option value="password">تعيين كلمة مرور مؤقتة</option>}
              <option value="invite">إنشاء دعوة للموظف</option>
              <option value="profile">حفظ الملف فقط</option>
            </select>
          </label>}
          <div className="mt-field wide mt-inline-help">
            يمكنك تعيين كلمة مرور مؤقتة أو إنشاء دعوة من بطاقة الموظف بعد حفظ بياناته.
          </div>
          {error&&<div className="mt-alert error mt-field wide">{error}</div>}
        </div>
        <footer>
          <button type="button" className="mt-button" onClick={closeModal}>إلغاء</button>
          <button className="mt-button primary" disabled={busy}>
            {busy?'جارٍ الحفظ…':modal.type==='edit'?'حفظ التعديلات':'حفظ الملف الوظيفي'}
          </button>
        </footer>
      </form>
    </Modal>}
  </>;
}

function Modal({title,onClose,children,className=''}){
  return <div className="mt-modal-layer" dir="rtl">
    <button className="mt-modal-backdrop" aria-label="إغلاق" onClick={onClose}/>
    <div className={`mt-modal ${className}`} role="dialog" aria-modal="true">
      <header>
        <div><small>STAFF PROFILE</small><h3>{title}</h3></div>
        <button type="button" onClick={onClose}>×</button>
      </header>
      {children}
    </div>
  </div>;
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

