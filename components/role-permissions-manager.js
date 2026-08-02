'use client';

import {useEffect,useMemo,useState} from 'react';
import styles from './role-permissions-manager.module.css';

const ORIGIN_LABELS={
  system:'افتراضي من ماركتون',
  overridden:'معدل لهذه المنشأة',
  custom:'دور مضاف'
};

export default function RolePermissionsManager({
  slug,
  initialData
}){
  const [data,setData]=useState(initialData||{roles:[],permissions:[]});
  const [selectedKey,setSelectedKey]=useState(
    initialData?.roles?.[0]?.key||''
  );
  const [creating,setCreating]=useState(false);
  const [draft,setDraft]=useState(null);
  const [query,setQuery]=useState('');
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');

  const roles=data.roles||[];
  const permissions=data.permissions||[];
  const selectedRole=roles.find(role=>role.key===selectedKey)||null;
  const shownRoles=useMemo(()=>roles.filter(role=>
    `${role.nameAr||''} ${role.nameEn||''} ${role.key||''}`
      .toLowerCase()
      .includes(query.toLowerCase())
  ),[roles,query]);
  const groups=useMemo(()=>{
    const map=new Map();
    for(const permission of permissions){
      const key=permission.moduleKey||'other';
      if(!map.has(key)){
        map.set(key,{
          key,
          name:permission.moduleName||key,
          permissions:[]
        });
      }
      map.get(key).permissions.push(permission);
    }
    return [...map.values()];
  },[permissions]);

  useEffect(()=>{
    if(creating)return;
    if(!selectedRole){
      setDraft(null);
      return;
    }
    setDraft({
      roleKey:selectedRole.key,
      nameAr:selectedRole.nameAr||'',
      nameEn:selectedRole.nameEn||'',
      permissions:new Set(selectedRole.permissions||[])
    });
  },[selectedRole,creating]);

  function chooseRole(key){
    if(busy)return;
    setCreating(false);
    setSelectedKey(key);
    setNotice('');
    setError('');
  }

  function startCreate(){
    if(busy)return;
    setCreating(true);
    setSelectedKey('');
    setDraft({
      roleKey:null,
      nameAr:'',
      nameEn:'',
      permissions:new Set(['tenant.workspace.read'])
    });
    setNotice('');
    setError('');
  }

  function setField(key,value){
    setDraft(current=>({...current,[key]:value}));
  }

  function togglePermission(permissionKey){
    if(!draft)return;
    const locked=new Set(
      creating
        ?['tenant.workspace.read']
        :selectedRole?.lockedPermissions||[]
    );
    if(locked.has(permissionKey))return;
    setDraft(current=>{
      const next=new Set(current.permissions);
      if(next.has(permissionKey))next.delete(permissionKey);
      else next.add(permissionKey);
      return {...current,permissions:next};
    });
  }

  async function action(actionName,payload={}){
    setBusy(actionName);
    setNotice('');
    setError('');
    try{
      const response=await fetch('/api/tenant/roles',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          tenantSlug:slug,
          action:actionName,
          payload
        })
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok){
        throw new Error(result.error||'تعذر حفظ إعدادات الدور');
      }
      const next=result.data||result;
      setData(next);
      const nextKey=next.changedRoleKey
        ||next.roles?.find(role=>role.key===selectedKey)?.key
        ||next.roles?.[0]?.key
        ||'';
      setCreating(false);
      setSelectedKey(nextKey);
      setNotice(successMessage(actionName));
      return next;
    }catch(err){
      setError(err.message);
      return null;
    }finally{
      setBusy('');
    }
  }

  async function save(event){
    event.preventDefault();
    if(!draft)return;
    await action(creating?'create_role':'update_role',{
      roleKey:draft.roleKey,
      nameAr:draft.nameAr,
      nameEn:draft.nameEn,
      permissions:[...draft.permissions]
    });
  }

  async function resetRole(){
    if(!selectedRole?.canReset||busy)return;
    if(!window.confirm(
      `إعادة دور «${selectedRole.nameAr}» إلى صلاحيات ماركتون الافتراضية؟`
    ))return;
    await action('reset_role',{roleKey:selectedRole.key});
  }

  async function deleteRole(){
    if(!selectedRole?.canDelete||busy)return;
    if(!window.confirm(
      `حذف دور «${selectedRole.nameAr}» نهائيًا؟`
    ))return;
    await action('delete_role',{roleKey:selectedRole.key});
  }

  const locked=new Set(
    creating
      ?['tenant.workspace.read']
      :selectedRole?.lockedPermissions||[]
  );
  const assignedTotal=(selectedRole?.assignedStaffCount||0)
    +(selectedRole?.pendingInvitationCount||0);

  return <div className={styles.manager}>
    <section className={styles.explainer}>
      <article>
        <span>1</span>
        <div>
          <b>المسمى الوظيفي</b>
          <p>{data.terminology?.jobTitle
            ||'وصف بشري للوظيفة مثل مسؤول تسجيل وقبول.'}</p>
        </div>
      </article>
      <article>
        <span>2</span>
        <div>
          <b>القسم</b>
          <p>{data.terminology?.department
            ||'تصنيف تنظيمي مثل المبيعات أو التسجيل والقبول.'}</p>
        </div>
      </article>
      <article>
        <span>3</span>
        <div>
          <b>الدور والصلاحيات</b>
          <p>{data.terminology?.role
            ||'هو الذي يفتح الشاشات ويحدد ما يمكن تنفيذه.'}</p>
        </div>
      </article>
    </section>

    <section className={styles.summary}>
      <article>
        <span>الأدوار المتاحة</span>
        <b>{roles.length}</b>
        <small>{roles.filter(role=>role.origin==='custom').length} أدوار مضافة</small>
      </article>
      <article>
        <span>أدوار معدلة</span>
        <b>{roles.filter(role=>role.origin==='overridden').length}</b>
        <small>مخصصة لهذه المنشأة فقط</small>
      </article>
      <article>
        <span>الصلاحيات</span>
        <b>{permissions.length}</b>
        <small>موزعة على {groups.length} أقسام</small>
      </article>
      <article>
        <span>الأقسام التنظيمية</span>
        <b>{data.departments?.length||0}</b>
        <small>لا تمنح صلاحيات بذاتها</small>
      </article>
    </section>

    {notice&&<div className="mt-alert">{notice}</div>}
    {error&&<div className="mt-alert error">{error}</div>}

    <section className={styles.workspace}>
      <aside className={styles.rolesPane}>
        <header>
          <div>
            <small>قوالب الصلاحيات</small>
            <h3>الأدوار</h3>
          </div>
          <button
            type="button"
            className="mt-button primary"
            onClick={startCreate}
          >
            + إضافة دور
          </button>
        </header>
        <input
          className={styles.search}
          value={query}
          onChange={event=>setQuery(event.target.value)}
          placeholder="ابحث عن دور"
        />
        <div className={styles.roleList}>
          {shownRoles.map(role=><button
            type="button"
            key={role.key}
            className={[
              styles.roleCard,
              !creating&&role.key===selectedKey?styles.active:''
            ].filter(Boolean).join(' ')}
            onClick={()=>chooseRole(role.key)}
          >
            <div>
              <b>{role.nameAr}</b>
              <small>{ORIGIN_LABELS[role.origin]||role.origin}</small>
            </div>
            <span>{role.permissions?.length||0}</span>
            <p>
              {role.assignedStaffCount||0} موظف
              {role.pendingInvitationCount
                ?` · ${role.pendingInvitationCount} دعوة`
                :''}
            </p>
          </button>)}
          {!shownRoles.length&&<div className="mt-empty">
            لا توجد أدوار مطابقة.
          </div>}
        </div>
      </aside>

      <form className={styles.editor} onSubmit={save}>
        <header className={styles.editorHead}>
          <div>
            <small>{creating?'دور جديد':'تعديل قالب الصلاحيات'}</small>
            <h3>{creating?'إضافة دور مخصص':selectedRole?.nameAr||'اختر دورًا'}</h3>
            {!creating&&selectedRole&&<p>
              {ORIGIN_LABELS[selectedRole.origin]}
              {' · '}
              {assignedTotal} موظف أو دعوة مرتبطة
            </p>}
          </div>
          {!creating&&selectedRole&&<div className={styles.headActions}>
            {selectedRole.canReset&&<button
              type="button"
              className="mt-button"
              onClick={resetRole}
              disabled={Boolean(busy)}
            >
              استعادة الافتراضي
            </button>}
            {selectedRole.canDelete&&<button
              type="button"
              className={styles.deleteButton}
              onClick={deleteRole}
              disabled={Boolean(busy)}
            >
              حذف الدور
            </button>}
          </div>}
        </header>

        {draft?<div className={styles.editorBody}>
          <section className={styles.identityFields}>
            <label>
              اسم الدور بالعربية
              <input
                value={draft.nameAr}
                onChange={event=>setField('nameAr',event.target.value)}
                maxLength={80}
                required
              />
            </label>
            <label>
              الاسم بالإنجليزية — اختياري
              <input
                dir="ltr"
                value={draft.nameEn}
                onChange={event=>setField('nameEn',event.target.value)}
                maxLength={80}
              />
            </label>
          </section>

          {selectedRole?.isProtected&&!creating&&<div className={styles.protectedNote}>
            دور المالك محمي. يمكنك تعديل الاسم، لكن جميع الصلاحيات تظل مفعّلة
            لمنع فقدان التحكم في المنشأة.
          </div>}

          <div className={styles.permissionToolbar}>
            <div>
              <b>اختر صلاحيات الدور</b>
              <small>
                الصلاحيات التابعة تُضاف تلقائيًا؛ مثل «إدارة» التي تتطلب
                صلاحية «عرض».
              </small>
            </div>
            <span>{draft.permissions.size} محددة</span>
          </div>

          <section className={styles.permissionGroups}>
            {groups.map(group=><article key={group.key}>
              <header>
                <h4>{group.name}</h4>
                <span>
                  {group.permissions.filter(permission=>
                    draft.permissions.has(permission.key)
                  ).length}
                  /{group.permissions.length}
                </span>
              </header>
              <div>
                {group.permissions.map(permission=>{
                  const checked=draft.permissions.has(permission.key)
                    ||locked.has(permission.key);
                  const disabled=locked.has(permission.key)
                    ||selectedRole?.isProtected;
                  return <label
                    key={permission.key}
                    className={disabled?styles.locked:''}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={()=>togglePermission(permission.key)}
                    />
                    <span>
                      <b>{permission.name}</b>
                      <small>{permission.description}</small>
                    </span>
                    {locked.has(permission.key)&&<em>أساسية</em>}
                  </label>;
                })}
              </div>
            </article>)}
          </section>
        </div>:<div className="mt-empty">
          اختر دورًا لعرض صلاحياته.
        </div>}

        {draft&&<footer className={styles.footer}>
          {creating&&<button
            type="button"
            className="mt-button"
            onClick={()=>chooseRole(roles[0]?.key||'')}
            disabled={Boolean(busy)}
          >
            إلغاء
          </button>}
          <button
            className="mt-button primary"
            disabled={Boolean(busy)}
          >
            {busy
              ?'جارٍ حفظ الصلاحيات…'
              :creating
                ?'إنشاء الدور'
                :'حفظ الدور والصلاحيات'}
          </button>
        </footer>}
      </form>
    </section>
  </div>;
}

function successMessage(action){
  return ({
    create_role:'تم إنشاء الدور وأصبح متاحًا عند إضافة أو تعديل الموظف.',
    update_role:'تم حفظ الصلاحيات وتطبيقها على المستخدمين المرتبطين بالدور.',
    reset_role:'تمت استعادة الصلاحيات الافتراضية للدور.',
    delete_role:'تم حذف الدور المخصص.'
  })[action]||'تم حفظ التغييرات.';
}
