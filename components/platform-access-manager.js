'use client';

import {useMemo,useState} from 'react';
import styles from './platform-access-manager.module.css';

const STATUS_LABELS={
  active:'نشط',
  suspended:'موقوف',
  pending:'دعوة معلقة',
  expired:'منتهية',
  revoked:'ملغاة',
  accepted:'مقبولة'
};

const ROLE_ORIGINS={
  platform_owner:'مالك المنصة',
  platform_website_manager:'مسؤول الموقع الإلكتروني',
  platform_tenants_manager:'مسؤول إدارة المنشآت',
  platform_billing_manager:'مسؤول الباقات والاشتراكات',
  platform_content_manager:'مسؤول المحتوى والمعارف',
  platform_access_manager:'مسؤول فريق المنصة والصلاحيات',
  platform_operations_manager:'مشرف تشغيل المنصة',
  platform_support_agent:'مسؤول الدعم الفني',
  platform_support_manager:'مدير الدعم الفني'
};

export default function PlatformAccessManager({initialData}){
  const [data,setData]=useState(initialData||{});
  const [tab,setTab]=useState('employees');
  const [query,setQuery]=useState('');
  const [statusFilter,setStatusFilter]=useState('all');
  const [modal,setModal]=useState(null);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [generatedInvite,setGeneratedInvite]=useState(null);
  const [selectedRoleKey,setSelectedRoleKey]=useState(
    initialData?.roles?.[0]?.key||''
  );
  const [roleMode,setRoleMode]=useState('edit');
  const [roleDraft,setRoleDraft]=useState(()=>roleToDraft(
    initialData?.roles?.[0]
  ));

  const roles=useMemo(
    ()=>Array.isArray(data.roles)?data.roles:[],
    [data.roles]
  );
  const permissions=useMemo(
    ()=>Array.isArray(data.permissions)?data.permissions:[],
    [data.permissions]
  );
  const employees=useMemo(
    ()=>Array.isArray(data.employees)?data.employees:[],
    [data.employees]
  );
  const invitations=useMemo(
    ()=>Array.isArray(data.invitations)?data.invitations:[],
    [data.invitations]
  );

  const viewer=employees.find(item=>
    item.membershipId===data.viewer?.membershipId
  );
  const viewerIsOwner=Boolean(viewer?.roles?.some(role=>
    role.key==='platform_owner'
  ));

  const permissionGroups=useMemo(()=>{
    const groups=new Map();
    for(const permission of permissions){
      const key=permission.moduleKey||'platform';
      if(!groups.has(key)){
        groups.set(key,{
          key,
          name:permission.moduleName||'صلاحيات المنصة',
          permissions:[]
        });
      }
      groups.get(key).permissions.push(permission);
    }
    return [...groups.values()];
  },[permissions]);

  const shownEmployees=useMemo(()=>employees.filter(employee=>{
    const statusMatches=statusFilter==='all'||employee.status===statusFilter;
    const rolesText=(employee.roles||[]).map(role=>role.nameAr).join(' ');
    const haystack=`${employee.fullName||''} ${employee.email||''} ${rolesText}`;
    return statusMatches&&haystack.toLowerCase().includes(query.toLowerCase());
  }),[employees,query,statusFilter]);

  const selectedRole=roles.find(role=>role.key===selectedRoleKey)||null;
  const activeCount=employees.filter(item=>item.status==='active').length;
  const suspendedCount=employees.filter(item=>item.status==='suspended').length;
  const pendingCount=invitations.filter(item=>item.status==='pending').length;

  async function action(actionName,payload={}){
    setBusy(actionName);
    setError('');
    setNotice('');
    try{
      const response=await fetch('/api/platform/access',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({action:actionName,payload})
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok){
        throw new Error(result.error||'تعذر تنفيذ العملية');
      }
      const next=result.data||{};
      setData(next);
      return next;
    }catch(reason){
      setError(reason instanceof Error?reason.message:String(reason));
      return null;
    }finally{
      setBusy('');
    }
  }

  function openInvite(){
    setGeneratedInvite(null);
    setError('');
    setNotice('');
    const defaultRole=roles.find(role=>role.key!=='platform_owner')||roles[0];
    setModal({type:'invite',roleKey:defaultRole?.key||''});
  }

  function openEmployee(employee){
    setGeneratedInvite(null);
    setError('');
    setNotice('');
    setModal({
      type:'employee',
      employee,
      fullName:employee.fullName||'',
      roleKey:employee.roles?.[0]?.key||roles[0]?.key||''
    });
  }

  function closeModal(){
    if(busy)return;
    setModal(null);
    setGeneratedInvite(null);
    setError('');
  }

  async function submitInvite(event){
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const next=await action('invite_employee',{
      fullName:values.fullName,
      email:values.email,
      roleKey:values.roleKey
    });
    if(!next)return;
    const result=next.actionResult||{};
    if(result.status==='linked'){
      setNotice('تم ربط الموظف بحسابه الحالي وتفعيل صلاحياته مباشرة.');
      setModal(null);
      return;
    }
    if(result.invitationToken){
      const url=platformInvitationUrl(result.invitationToken);
      setGeneratedInvite({
        invitationId:result.invitationId,
        email:result.email,
        url
      });
      setNotice('تم إنشاء الدعوة. انسخ الرابط وأرسله إلى الموظف.');
    }
  }

  async function submitEmployee(event){
    event.preventDefault();
    const values=Object.fromEntries(new FormData(event.currentTarget));
    const next=await action('update_employee',{
      membershipId:modal.employee.membershipId,
      fullName:values.fullName,
      roleKey:values.roleKey
    });
    if(!next)return;
    setNotice('تم تحديث بيانات الموظف ودوره وصلاحياته.');
    setModal(null);
  }

  async function changeEmployeeStatus(employee,nextStatus){
    const verb=nextStatus==='suspended'?'إيقاف':'إعادة تفعيل';
    if(!window.confirm(`${verb} حساب «${employee.fullName}»؟`))return;
    const next=await action(
      nextStatus==='suspended'?'suspend_employee':'activate_employee',
      {membershipId:employee.membershipId}
    );
    if(next)setNotice(
      nextStatus==='suspended'
        ?'تم إيقاف دخول الموظف إلى لوحة المنصة.'
        :'تم تفعيل دخول الموظف من جديد.'
    );
  }

  async function invitationAction(invitation,actionName){
    if(actionName==='revoke_invitation'&&!window.confirm(
      `إلغاء دعوة ${invitation.email}؟`
    ))return;
    const next=await action(actionName,{invitationId:invitation.id});
    if(!next)return;
    const result=next.actionResult||{};
    if(result.invitationToken){
      const url=platformInvitationUrl(result.invitationToken);
      setGeneratedInvite({
        invitationId:invitation.id,
        email:invitation.email,
        url
      });
      setNotice('تم تجديد الدعوة وإنشاء رابط جديد صالح لمدة 7 أيام.');
      return;
    }
    setGeneratedInvite(null);
    setNotice('تم إلغاء الدعوة.');
  }

  async function copyInvite(url){
    try{
      await navigator.clipboard.writeText(url);
      setNotice('تم نسخ رابط دعوة موظف المنصة.');
    }catch{
      setError('تعذر النسخ تلقائيًا؛ حدد الرابط وانسخه يدويًا.');
    }
  }

  function chooseRole(role){
    if(busy)return;
    setSelectedRoleKey(role.key);
    setRoleMode('edit');
    setRoleDraft(roleToDraft(role));
    setError('');
    setNotice('');
  }

  function startRole(){
    if(busy)return;
    setSelectedRoleKey('');
    setRoleMode('create');
    setRoleDraft({
      roleKey:null,
      nameAr:'',
      nameEn:'',
      permissions:new Set(['platform.control.read'])
    });
    setError('');
    setNotice('');
  }

  function updateRoleField(key,value){
    setRoleDraft(current=>({...current,[key]:value}));
  }

  function toggleRolePermission(permissionKey){
    if(!roleDraft)return;
    const protectedRole=selectedRole?.isProtected&&roleMode==='edit';
    if(permissionKey==='platform.control.read'||protectedRole)return;
    setRoleDraft(current=>{
      const next=new Set(current.permissions);
      if(next.has(permissionKey))next.delete(permissionKey);
      else next.add(permissionKey);
      return {...current,permissions:next};
    });
  }

  async function saveRole(event){
    event.preventDefault();
    if(!roleDraft)return;
    const actionName=roleMode==='create'?'create_role':'update_role';
    const next=await action(actionName,{
      roleKey:roleDraft.roleKey,
      nameAr:roleDraft.nameAr,
      nameEn:roleDraft.nameEn,
      permissions:[...roleDraft.permissions]
    });
    if(!next)return;
    const key=next.changedRoleKey||roleDraft.roleKey;
    const role=next.roles?.find(item=>item.key===key)||next.roles?.[0];
    setRoleMode('edit');
    setSelectedRoleKey(role?.key||'');
    setRoleDraft(roleToDraft(role));
    setNotice(
      actionName==='create_role'
        ?'تم إنشاء الدور وأصبح متاحًا عند إضافة موظف جديد.'
        :'تم حفظ الدور وتطبيق صلاحياته فورًا على الموظفين المرتبطين به.'
    );
  }

  async function deleteRole(){
    if(!selectedRole?.canDelete||busy)return;
    if(!window.confirm(`حذف دور «${selectedRole.nameAr}» نهائيًا؟`))return;
    const next=await action('delete_role',{roleKey:selectedRole.key});
    if(!next)return;
    const role=next.roles?.[0];
    setSelectedRoleKey(role?.key||'');
    setRoleDraft(roleToDraft(role));
    setNotice('تم حذف الدور المخصص.');
  }

  return <section className={styles.manager} dir="rtl">
    <header className={styles.hero}>
      <div>
        <small>PLATFORM PEOPLE & ACCESS</small>
        <h1>فريق المنصة والأدوار والصلاحيات</h1>
        <p>أضف موظفي ماركتون، أنشئ أدوارًا مخصصة، واجعل كل موظف يرى وينفذ المهام المرتبطة بوظيفته فقط.</p>
      </div>
      <button type="button" className={styles.primary} onClick={openInvite}>+ إضافة موظف منصة</button>
    </header>

    <section className={styles.summary}>
      <SummaryCard label="موظفون نشطون" value={activeCount} detail="يمكنهم تسجيل الدخول الآن" tone="green"/>
      <SummaryCard label="دعوات معلقة" value={pendingCount} detail="بانتظار التفعيل" tone="amber"/>
      <SummaryCard label="أدوار متاحة" value={roles.length} detail={`${roles.filter(role=>!role.isSystem).length} أدوار مخصصة`} tone="blue"/>
      <SummaryCard label="حسابات موقوفة" value={suspendedCount} detail="لا يمكنها الدخول" tone="red"/>
    </section>

    {notice&&<div className={styles.notice}>{notice}</div>}
    {error&&<div className={styles.error}><span>{error}</span><button type="button" onClick={()=>setError('')}>×</button></div>}
    {generatedInvite&&<InviteResult result={generatedInvite} onCopy={copyInvite}/>} 

    <nav className={styles.tabs} aria-label="إدارة فريق المنصة">
      <button type="button" className={tab==='employees'?styles.activeTab:''} onClick={()=>setTab('employees')}>الموظفون والدعوات <b>{employees.length}</b></button>
      <button type="button" className={tab==='roles'?styles.activeTab:''} onClick={()=>setTab('roles')}>الأدوار والصلاحيات <b>{roles.length}</b></button>
    </nav>

    {tab==='employees'?<div className={styles.employeeWorkspace}>
      <div className={styles.toolbar}>
        <div>
          <input value={query} onChange={event=>setQuery(event.target.value)} placeholder="ابحث بالاسم أو البريد أو الدور"/>
          <select value={statusFilter} onChange={event=>setStatusFilter(event.target.value)}>
            <option value="all">كل الحالات</option>
            <option value="active">نشط</option>
            <option value="suspended">موقوف</option>
          </select>
        </div>
        <button type="button" className={styles.primary} onClick={openInvite}>+ إضافة موظف</button>
      </div>

      <div className={styles.employeeTable}>
        <div className={styles.tableHead}><span>الموظف</span><span>الدور</span><span>الصلاحيات</span><span>الحالة</span><span>الإجراءات</span></div>
        {shownEmployees.map(employee=><EmployeeRow
          key={employee.membershipId}
          employee={employee}
          viewerMembershipId={data.viewer?.membershipId}
          viewerIsOwner={viewerIsOwner}
          busy={busy}
          onEdit={openEmployee}
          onStatus={changeEmployeeStatus}
        />)}
        {!shownEmployees.length&&<Empty text="لا توجد حسابات مطابقة للفلاتر الحالية."/>}
      </div>

      <section className={styles.invitationSection}>
        <header><div><small>INVITATIONS</small><h2>دعوات موظفي المنصة</h2><p>يمكن تجديد الدعوة المنتهية أو إلغاء الدعوات المعلقة قبل استخدامها.</p></div></header>
        <div className={styles.invitationGrid}>
          {invitations.map(invitation=><InvitationCard
            key={invitation.id}
            invitation={invitation}
            busy={busy}
            generated={generatedInvite?.invitationId===invitation.id?generatedInvite:null}
            onAction={invitationAction}
            onCopy={copyInvite}
          />)}
          {!invitations.length&&<Empty text="لا توجد دعوات معلقة أو سابقة."/>}
        </div>
      </section>
    </div>:<div className={styles.roleWorkspace}>
      <aside className={styles.roleList}>
        <header><div><small>ROLE TEMPLATES</small><h2>الأدوار</h2></div><button type="button" onClick={startRole}>+ دور جديد</button></header>
        <div>{roles.map(role=><button
          type="button"
          key={role.key}
          className={roleMode==='edit'&&role.key===selectedRoleKey?styles.selectedRole:''}
          onClick={()=>chooseRole(role)}
        >
          <span><b>{role.nameAr}</b><small>{role.isSystem?'دور أساسي':'دور مخصص'}</small></span>
          <em>{role.permissions?.length||0}</em>
          <p>{role.assignedEmployeeCount||0} موظف · {role.pendingInvitationCount||0} دعوة</p>
        </button>)}</div>
      </aside>

      <form className={styles.roleEditor} onSubmit={saveRole}>
        <header>
          <div><small>{roleMode==='create'?'NEW PLATFORM ROLE':'ROLE PERMISSIONS'}</small><h2>{roleMode==='create'?'إنشاء دور منصة جديد':selectedRole?.nameAr||'اختر دورًا'}</h2><p>الدور هو قالب الصلاحيات الذي يحدد القوائم والشاشات والعمليات المتاحة للموظف.</p></div>
          {roleMode==='edit'&&selectedRole?.canDelete&&<button type="button" className={styles.dangerButton} onClick={deleteRole}>حذف الدور</button>}
        </header>

        {roleDraft?<>
          <div className={styles.roleIdentity}>
            <label><span>اسم الدور بالعربية</span><input required maxLength={90} value={roleDraft.nameAr} onChange={event=>updateRoleField('nameAr',event.target.value)}/></label>
            <label><span>الاسم بالإنجليزية — اختياري</span><input dir="ltr" maxLength={90} value={roleDraft.nameEn} onChange={event=>updateRoleField('nameEn',event.target.value)}/></label>
          </div>

          {selectedRole?.isProtected&&roleMode==='edit'&&<div className={styles.protectedNote}>دور مالك المنصة محمي؛ تبقى جميع صلاحيات المنصة مفعلة لمنع فقدان التحكم الرئيسي.</div>}

          <div className={styles.permissionSummary}><div><b>اختر صلاحيات الدور</b><small>صلاحية «عرض لوحة المنصة» أساسية وتُضاف تلقائيًا.</small></div><span>{roleDraft.permissions.size} محددة</span></div>

          <div className={styles.permissionGroups}>
            {permissionGroups.map(group=><article key={group.key}>
              <header><h3>{group.name}</h3><span>{group.permissions.filter(permission=>roleDraft.permissions.has(permission.key)).length}/{group.permissions.length}</span></header>
              <div>{group.permissions.map(permission=>{
                const locked=permission.key==='platform.control.read'||Boolean(selectedRole?.isProtected&&roleMode==='edit');
                const checked=roleDraft.permissions.has(permission.key)||locked;
                return <label key={permission.key} className={locked?styles.lockedPermission:''}>
                  <input type="checkbox" checked={checked} disabled={locked} onChange={()=>toggleRolePermission(permission.key)}/>
                  <span><b>{permission.name}</b><small>{permission.description}</small></span>
                  {permission.key==='platform.control.read'&&<em>أساسية</em>}
                </label>;
              })}</div>
            </article>)}
          </div>

          <footer className={styles.roleFooter}>
            {roleMode==='create'&&<button type="button" className={styles.secondary} onClick={()=>roles[0]&&chooseRole(roles[0])}>إلغاء</button>}
            <button className={styles.primary} disabled={Boolean(busy)}>{busy?(roleMode==='create'?'جارٍ إنشاء الدور…':'جارٍ حفظ الصلاحيات…'):(roleMode==='create'?'إنشاء الدور':'حفظ الدور والصلاحيات')}</button>
          </footer>
        </>:<Empty text="اختر دورًا من القائمة أو أنشئ دورًا جديدًا."/>}
      </form>
    </div>}

    {modal&&<AccessModal
      modal={modal}
      roles={roles}
      viewerIsOwner={viewerIsOwner}
      busy={busy}
      error={error}
      generatedInvite={generatedInvite}
      onClose={closeModal}
      onSubmitInvite={submitInvite}
      onSubmitEmployee={submitEmployee}
      onCopy={copyInvite}
      onChange={setModal}
    />}
  </section>;
}

function SummaryCard({label,value,detail,tone}){
  return <article data-tone={tone}><span>{label}</span><b>{Number(value||0).toLocaleString('ar-SA')}</b><small>{detail}</small></article>;
}

function EmployeeRow({employee,viewerMembershipId,viewerIsOwner,busy,onEdit,onStatus}){
  const isSelf=employee.membershipId===viewerMembershipId;
  const isOwner=employee.roles?.some(role=>role.key==='platform_owner');
  const canModify=!isOwner||viewerIsOwner;
  return <article className={styles.employeeRow}>
    <div className={styles.employeeIdentity}><span>{Array.from(employee.fullName||'م')[0]}</span><div><b>{employee.fullName}</b><small dir="ltr">{employee.email}</small>{isSelf&&<em>حسابك الحالي</em>}</div></div>
    <div className={styles.roleBadges}>{(employee.roles||[]).map(role=><span key={role.key}>{role.nameAr||ROLE_ORIGINS[role.key]||role.key}</span>)}</div>
    <div className={styles.permissionCount}><b>{employee.permissions?.length||0}</b><small>صلاحية فعالة</small></div>
    <span className={`${styles.status} ${styles[`status_${employee.status}`]||''}`}>{STATUS_LABELS[employee.status]||employee.status}</span>
    <div className={styles.rowActions}>
      <button type="button" onClick={()=>onEdit(employee)} disabled={!canModify||Boolean(busy)}>تعديل</button>
      {employee.status==='active'
        ?<button type="button" className={styles.dangerText} disabled={isSelf||!canModify||Boolean(busy)} onClick={()=>onStatus(employee,'suspended')}>إيقاف</button>
        :<button type="button" className={styles.successText} disabled={!canModify||Boolean(busy)} onClick={()=>onStatus(employee,'active')}>تفعيل</button>}
    </div>
  </article>;
}

function InvitationCard({invitation,busy,generated,onAction,onCopy}){
  const actionable=['pending','expired'].includes(invitation.status);
  return <article className={styles.invitationCard}>
    <header><span className={`${styles.status} ${styles[`status_${invitation.status}`]||''}`}>{STATUS_LABELS[invitation.status]||invitation.status}</span><time>{formatDate(invitation.createdAt)}</time></header>
    <h3>{invitation.fullName}</h3>
    <p dir="ltr">{invitation.email}</p>
    <small>{invitation.roleName||ROLE_ORIGINS[invitation.roleKey]||invitation.roleKey}</small>
    <dl><div><dt>تنتهي</dt><dd>{formatDate(invitation.expiresAt)}</dd></div></dl>
    {generated&&<button type="button" className={styles.copyInvite} onClick={()=>onCopy(generated.url)}>نسخ الرابط الجديد</button>}
    {actionable&&<footer><button type="button" disabled={Boolean(busy)} onClick={()=>onAction(invitation,'renew_invitation')}>تجديد الرابط</button><button type="button" className={styles.dangerText} disabled={Boolean(busy)} onClick={()=>onAction(invitation,'revoke_invitation')}>إلغاء الدعوة</button></footer>}
  </article>;
}

function InviteResult({result,onCopy}){
  return <section className={styles.inviteResult}>
    <div><b>رابط تفعيل موظف المنصة جاهز</b><small>{result.email}</small><input dir="ltr" readOnly value={result.url}/></div>
    <button type="button" onClick={()=>onCopy(result.url)}>نسخ رابط التفعيل</button>
  </section>;
}

function AccessModal({modal,roles,viewerIsOwner,busy,error,generatedInvite,onClose,onSubmitInvite,onSubmitEmployee,onCopy,onChange}){
  const isInvite=modal.type==='invite';
  const roleOptions=roles.filter(role=>viewerIsOwner||role.key!=='platform_owner');
  return <div className={styles.modalBackdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label={isInvite?'إضافة موظف منصة':'تعديل موظف المنصة'}>
      <header><div><small>{isInvite?'PLATFORM INVITATION':'EMPLOYEE ACCESS'}</small><h2>{isInvite?'إضافة موظف إلى لوحة إدارة المنصة':'تعديل الموظف والدور'}</h2></div><button type="button" onClick={onClose}>×</button></header>
      <form onSubmit={isInvite?onSubmitInvite:onSubmitEmployee}>
        <label><span>الاسم الكامل</span><input name="fullName" required minLength={2} maxLength={120} value={isInvite?modal.fullName||'':modal.fullName} onChange={event=>onChange({...modal,fullName:event.target.value})}/></label>
        {isInvite&&<label><span>البريد الإلكتروني</span><input name="email" type="email" dir="ltr" required maxLength={254} value={modal.email||''} onChange={event=>onChange({...modal,email:event.target.value})}/></label>}
        <label><span>الدور والصلاحيات</span><select name="roleKey" required value={modal.roleKey} onChange={event=>onChange({...modal,roleKey:event.target.value})}>{roleOptions.map(role=><option value={role.key} key={role.key}>{role.nameAr} — {role.permissions?.length||0} صلاحية</option>)}</select></label>
        <div className={styles.rolePreview}>{roleOptions.find(role=>role.key===modal.roleKey)?.permissions?.map(permission=><span key={permission}>{permissionLabel(permission)}</span>)}</div>
        {error&&<div className={styles.modalError}>{error}</div>}
        {isInvite&&generatedInvite&&<div className={styles.modalInvite}><b>تم إنشاء الدعوة</b><input dir="ltr" readOnly value={generatedInvite.url}/><button type="button" onClick={()=>onCopy(generatedInvite.url)}>نسخ الرابط</button></div>}
        <footer><button type="button" className={styles.secondary} onClick={onClose} disabled={Boolean(busy)}>إغلاق</button><button className={styles.primary} disabled={Boolean(busy)||Boolean(isInvite&&generatedInvite)}>{busy?'جارٍ الحفظ…':isInvite?'إنشاء دعوة الموظف':'حفظ التعديل'}</button></footer>
      </form>
    </section>
  </div>;
}

function Empty({text}){return <div className={styles.empty}><span>◇</span><p>{text}</p></div>;}

function roleToDraft(role){
  if(!role)return null;
  return {
    roleKey:role.key,
    nameAr:role.nameAr||'',
    nameEn:role.nameEn||'',
    permissions:new Set(role.permissions||[])
  };
}

function platformInvitationUrl(token){
  return `${window.location.origin}/accept-platform-invite?token=${encodeURIComponent(token)}`;
}

function permissionLabel(value){
  return ({
    'platform.control.read':'لوحة المنصة',
    'platform.control.write':'تشغيل المنصة',
    'platform.tenants.manage':'إدارة المنشآت',
    'platform.billing.manage':'الباقات والاشتراكات',
    'platform.content.manage':'المحتوى والمعارف',
    'platform.website.manage':'الموقع الإلكتروني',
    'platform.access.manage':'فريق المنصة',
    'platform.settings.manage':'الإعدادات',
    'platform.audit.read':'سجل التدقيق',
    'platform.support.read':'عرض تذاكر الدعم',
    'platform.support.reply':'الرد على تذاكر الدعم',
    'platform.support.manage':'إسناد وإدارة تذاكر الدعم'
  })[value]||value;
}

function formatDate(value){
  if(!value)return '—';
  const date=new Date(value);
  if(Number.isNaN(date.getTime()))return '—';
  return new Intl.DateTimeFormat('ar-SA',{
    dateStyle:'medium',
    timeStyle:'short'
  }).format(date);
}
