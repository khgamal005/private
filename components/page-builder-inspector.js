'use client';

import styles from './page-builder.module.css';

export function BlockInspector({block,update}){
  const props=block.props||{};const style=block.style||{};const responsive=block.responsive||{};
  return <div className={styles.inspectorBody}>
    <InspectorSection title="المحتوى"><TypeFields block={block} update={update}/></InspectorSection>
    <InspectorSection title="التنسيق">
      <SelectField label="نمط الخلفية" value={style.variant||'light'} options={[['light','فاتح'],['dark','داكن'],['paper','كريمي'],['brand','هوية ماركتون']]} onChange={value=>update('style.variant',value)}/>
      <SelectField label="المحاذاة" value={style.align||'right'} options={[['right','يمين'],['center','وسط'],['left','يسار']]} onChange={value=>update('style.align',value)}/>
      <SelectField label="عرض المحتوى" value={style.maxWidth||'wide'} options={[['wide','واسع'],['reading','قراءة'],['full','كامل']]} onChange={value=>update('style.maxWidth',value)}/>
      <NumberField label="المسافة الرأسية" value={style.paddingY??72} min={0} max={180} onChange={value=>update('style.paddingY',value)}/>
      <TextField label="لون خلفية مخصص" value={style.background||''} dir="ltr" placeholder="#ffffff" onChange={value=>update('style.background',value)}/>
      <TextField label="لون النص المخصص" value={style.color||''} dir="ltr" placeholder="#12233a" onChange={value=>update('style.color',value)}/>
    </InspectorSection>
    <InspectorSection title="الرابط والاستجابة">
      <TextField label="معركف القسم" value={props.anchor||''} dir="ltr" placeholder="section-name" onChange={value=>update('props.anchor',slug(value))}/>
      <Toggle label="إخفاء على الكمبيوتر" checked={responsive.hideDesktop} onChange={value=>update('responsive.hideDesktop',value)}/>
      <Toggle label="إخفاء على التابلت" checked={responsive.hideTablet} onChange={value=>update('responsive.hideTablet',value)}/>
      <Toggle label="إخفاء على الجوال" checked={responsive.hideMobile} onChange={value=>update('responsive.hideMobile',value)}/>
    </InspectorSection>
  </div>;
}

function TypeFields({block,update}){
  const p=block.props||{};
  if(block.type==='hero')return <>
    <TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/>
    <TextArea label="العنوان الر٦يسي" value={p.title} rows={3} onChange={v=>update('props.title',v)}/>
    <TextArea label="الوصف" value={p.body} rows={5} onChange={v=>update('props.body',v)}/>
    <TextField label="رابط الصورة" value={p.imageUrl} dir="ltr" onChange={v=>update('props.imageUrl',v)}/>
    <TextField label="وصف الصورة" value={p.imageAlt} onChange={v=>update('props.imageAlt',v)}/>
    <ButtonFields prefix="primary" label="الزر الأساسي" props={p} update={update}/><ButtonFields prefix="secondary" label="الزر الثانوي" props={p} update={update}/>
  </>;
  if(block.type==='heading')return <>
    <TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/>
    <TextArea label="العنوان" value={p.title} rows={3} onChange={v=>update('props.title',v)}/>
    <TextArea label="الوصف" value={p.body} rows={4} onChange={v=>update('props.body',v)}/>
    <SelectField label="مستوى العنوان" value={p.level||'h2'} options={[['h2','عنوان رئيسي H2'],['h3','عنوان فرعي H3'],['h4','عنوان صغير H4']]} onChange={v=>update('props.level',v)}/>
  </>;
  if(block.type==='text')return <><TextArea label="النص" value={p.content} rows={14} onChange={v=>update('props.content',v)}/><SelectField label="عدد الأعمدة" value={String(p.columns||1)} options={[['1','عمود واحد'],['2','عمودان'],['3','ثلاثة أعمدة']]} onChange={v=>update('props.columns',Number(v))}/></>;
  if(block.type==='image')return <><TextField label="رابط الصورة" value={p.url} dir="ltr" onChange={v=>update('props.url',v)}/><TextField label="النص البديل" value={p.alt} onChange={v=>update('props.alt',v)}/><TextField label="التعليق" value={p.caption} onChange={v=>update('props.caption',v)}/><SelectField label="نسبة الأبعاد" value={p.ratio||'16 / 9'} options={[['16 / 9','عريض 16:9'],['4 / 3','تقليدي 4:3'],['1 / 1','مربع'],['3 / 4','رأسي']]} onChange={v=>update('props.ratio',v)}/></>;
  if(block.type==='buttons')return <><ButtonFields prefix="primary" label="الزر الأساسي" props={p} update={update}/><ButtonFields prefix="secondary" label="الزر الثانوي" props={p} update={update}/></>;
  if(['cards','stats','columns','faq'].includes(block.type))return <>
    {['cards','stats','faq'].includes(block.type)&&<><TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} rows={3} onChange={v=>update('props.body',v)}/></>}
    {block.type!=='faq'&&<SelectField label="عدد الأعمدة" value={String(p.columns||2)} options={[['1','عمود واحد'],['2','عمودان'],['3','ثلاثة أعمدة'],['4','أربعة أعمدة']]} onChange={v=>update('props.columns',Number(v))}/>} 
    <TextArea label={block.type==='stats'?'العناصر: الرقم | العنوان | الوصف':'العناصر: العنوان | الوصف'} value={itemsToText(p.items,block.type)} rows={12} onChange={v=>update('props.items',textToItems(v,block.type))}/>
  </>;
  if(block.type==='quote')return <><TextArea label="الاقتباس" value={p.quote} rows={7} onChange={v=>update('props.quote',v)}/><TextField label="الاسم" value={p.author} onChange={v=>update('props.author',v)}/><TextField label="المسمى أو المنشأة" value={p.role} onChange={v=>update('props.role',v)}/></>;
  if(block.type==='cta')return <><TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/><TextArea label="العنوان" value={p.title} rows={3} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} rows={4} onChange={v=>update('props.body',v)}/><TextField label="نص الزر" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/><TextField label="رابط الزر" value={p.buttonHref} dir="ltr" onChange={v=>update('props.buttonHref',v)}/></>;
  if(block.type==='contact')return <><TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/><TextArea label="العنوان" value={p.title} rows={3} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} rows={5} onChange={v=>update('props.body',v)}/><TextField label="نص زر الإرسال" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/></>;
  if(block.type==='divider')return <><NumberField label="العرض %" value={p.width??100} min={10} max={100} onChange={v=>update('props.width',v)}/><NumberField label="السُمك" value={p.thickness??1} min={1} max={8} onChange={v=>update('props.thickness',v)}/></>;
  if(block.type==='spacer')return <><NumberField label="كمبيوتر" value={p.desktop??72} min={0} max={300} onChange={v=>update('props.desktop',v)}/><NumberField label="تابلت" value={p.tablet??52} min={0} max={240} onChange={v=>update('props.tablet',v)}/><NumberField label="جوال" value={p.mobile??36} min={0} max={200} onChange={v=>update('props.mobile',v)}/></>;
  return null;
}

export function PageInspector({document,update}){return <div className={styles.inspectorBody}><InspectorSection title="الصفحة"><SelectField label="عرض المحتوى الافتراضي" value={document.settings.contentWidth} options={[['wide','واسع'],['reading','قراءة'],['full','كامل']]} onChange={v=>update('contentWidth',v)}/><TextField label="خلفية الصفحة" value={document.settings.background} dir="ltr" onChange={v=>update('background',v)}/><div className={styles.helpCard}><strong>طريقة الاستخدام</strong><p>اسحب العناصر من المكتبة، حدد أي عنصر لتعديل خصائصه، احفظ المسودة، ثم انشر عندما تصبح الصفحة جاهزة.</p><kbd>Ctrl + S</kbd><span>حفظ المسودة</span><kbd>Ctrl + Z</kbd><span>تراجع</span></div></InspectorSection></div>}
export function VersionHistory({versions,busy,onRestore}){return <section className={styles.versionPanel}><header><h2>سجل الإصدارات</h2><p>النشر والحفظ اليدوي ينشئان نقاط استعادة.</p></header><div>{versions.map(version=><article key={version.id}><span>{version.versionKind==='published'?'منشور':version.versionKind==='restored'?'استعادة':'مسودة'} · #{version.versionNumber}</span><time>{formatDate(version.createdAt)}</time><button type="button" disabled={busy==='restore-version'} onClick={()=>onRestore(version.id)}>استعادة</button></article>)}{!versions.length&&<p>لا توجد إصدارات محفوظة بعد.</p>}</div></section>}
function InspectorSection({title,children}){return <section className={styles.inspectorSection}><h2>{title}</h2>{children}</section>}
function TextField({label,value='',onChange,dir,placeholder=''}){return <label className={styles.field}><span>{label}</span><input value={value||''} dir={dir} placeholder={placeholder} onChange={event=>onChange(event.target.value)}/></label>}
function TextArea({label,value='',onChange,rows=5}){return <label className={styles.field}><span>{label}</span><textarea value={value||''} rows={rows} onChange={event=>onChange(event.target.value)}/></label>}
function NumberField({label,value,onChange,min,max}){return <label className={styles.field}><span>{label}</span><input type="number" value={value} min={min} max={max} onChange={event=>onChange(Number(event.target.value))}/></label>}
function SelectField({label,value,onChange,options}){return <label className={styles.field}><span>{label}</span><select value={value} onChange={event=>onChange(event.target.value)}>{options.map(([key,text])=><option value={key} key={key}>{text}</option>)}</select></label>}
function Toggle({label,checked,onChange}){return <label className={styles.toggle}><input type="checkbox" checked={Boolean(checked)} onChange={event=>onChange(event.target.checked)}/><span>{label}</span></label>}
function ButtonFields({prefix,label,props,update}){return <div className={styles.fieldGroup}><strong>{label}</strong><TextField label="النص" value={props[`${prefix}Label`]} onChange={v=>update(`props.${prefix}Label`,v)}/><TextField label="الرابط" value={props[`${prefix}Href`]} dir="ltr" onChange={v=>update(`props.${prefix}Href`,v)}/></div>}
export function Status({value}){return <span className={`${styles.status} ${styles[`status_${value}`]||''}`}>{value==='published'?'منشور':value==='draft'?'مسودة':'مؤرشف'}</span>}
function itemsToText(items,type){return (Array.isArray(items)?items:[]).map(item=>type==='stats'?`${item.value||''} | ${item.title||''} | ${item.description||''}`:`${item.title||''} | ${item.description||''}`).join('\n')}
function textToItems(text,type){return String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const parts=line.split('|').map(item=>item.trim());return type==='stats'?{value:parts[0]||'',title:parts[1]||'',description:parts.slice(2).join(' | ')}:{title:parts[0]||'',description:parts.slice(1).join(' | ')}}).filter(item=>item.title||item.value)}
function slug(value){return String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)}
function formatDate(value){try{return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}catch{return ''}}
