'use client';

import {useState} from 'react';
import {BLOCK_CATALOG,ROW_LAYOUTS} from '../lib/website-builder';
import styles from './page-builder.module.css';

export function SelectionInspector({selected,update,context,onSaveToLibrary}){
  if(!selected)return <div className={styles.inspectorBody}><div className={styles.emptyInspector}><span>◇</span><strong>اختر صفًا أو عمودًا أو موديولًا</strong><p>ستظهر هنا إعدادات المحتوى والتصميم والاستجابة.</p></div></div>;
  if(selected.kind==='row')return <RowInspector row={selected.row} update={update} onSave={()=>onSaveToLibrary?.('block',selected.row)}/>;
  if(selected.kind==='column')return <ColumnInspector column={selected.column} update={update}/>;
  const block=selected.kind==='module'?selected.module:selected.block;
  return <BlockInspector block={block} update={update} context={context} onSave={()=>onSaveToLibrary?.('module',block)}/>;
}

export function BlockInspector({block,update,context,onSave}){
  const style=block.style||{};const responsive=block.responsive||{};
  return <div className={styles.inspectorBody}>
    <InspectorSection title="المحتوى" icon="✎"><TypeFields block={block} update={update} context={context}/></InspectorSection>
    <InspectorSection title="التصميم" icon="✦">
      <SelectField label="نمط الخلفية" value={style.variant||'light'} options={[['light','فاتح'],['dark','داكن'],['paper','كريمي'],['brand','هوية ماركتون']]} onChange={value=>update('style.variant',value)}/>
      <SelectField label="المحاذاة" value={style.align||'right'} options={[['right','يمين'],['center','وسط'],['left','يسار']]} onChange={value=>update('style.align',value)}/>
      <SelectField label="عرض المحتوى" value={style.maxWidth||'wide'} options={[['wide','واسع'],['reading','عرض قراءة'],['full','كامل']]} onChange={value=>update('style.maxWidth',value)}/>
      <RangeField label="المسافة الرأسية" value={style.paddingY??48} min={0} max={180} suffix="px" onChange={value=>update('style.paddingY',value)}/>
      <ColorTextField label="لون الخلفية المخصص" value={style.background||''} placeholder="#ffffff" onChange={value=>update('style.background',value)}/>
      <ColorTextField label="لون النص المخصص" value={style.color||''} placeholder="#12233a" onChange={value=>update('style.color',value)}/>
      <div className={styles.fieldColumns}><NumberField label="سمك الحد" value={style.borderWidth??0} min={0} max={12} onChange={value=>update('style.borderWidth',value)}/><NumberField label="استدارة الحواف" value={style.borderRadius??0} min={0} max={80} onChange={value=>update('style.borderRadius',value)}/></div>
      <ColorTextField label="لون الحد" value={style.borderColor||''} placeholder="#dfe5eb" onChange={value=>update('style.borderColor',value)}/>
      <SelectField label="الظل" value={style.shadow||'none'} options={[['none','بدون'],['soft','خفيف'],['medium','متوسط'],['strong','قوي']]} onChange={value=>update('style.shadow',value)}/>
    </InspectorSection>
    <InspectorSection title="متقدم واستجابة" icon="⚙">
      <TextField label="معرّف القسم Anchor" value={block.props?.anchor||''} dir="ltr" placeholder="section-name" onChange={value=>update('props.anchor',slug(value))}/>
      <TextField label="CSS Class" value={style.cssClass||''} dir="ltr" placeholder="custom-class" onChange={value=>update('style.cssClass',safeClass(value))}/>
      <SelectField label="حركة الدخول" value={style.animation||'none'} options={[['none','بدون'],['fade','تلاشي'],['fade-up','تلاشي لأعلى'],['slide-right','دخول من اليمين'],['slide-left','دخول من اليسار'],['zoom','تكبير']]} onChange={value=>update('style.animation',value)}/>
      <NumberField label="تأخير الحركة" value={style.animationDelay??0} min={0} max={5000} onChange={value=>update('style.animationDelay',value)}/>
      <ResponsiveFields responsive={responsive} update={update}/>
      {onSave&&<button type="button" className={styles.librarySaveButton} onClick={onSave}>☆ حفظ الموديول في Saved</button>}
    </InspectorSection>
  </div>;
}

function RowInspector({row,update,onSave}){
  const props=row.props||{};const style=row.style||{};
  return <div className={styles.inspectorBody}>
    <InspectorSection title="تخطيط الصف" icon="▥">
      <LayoutSelect value={props.layoutKey||'1'} onChange={value=>update('props.layoutKey',value)}/>
      <Toggle label="عرض كامل للشاشة" checked={props.fullWidth} onChange={value=>update('props.fullWidth',value)}/>
      <RangeField label="المسافة بين الأعمدة" value={props.gap??18} min={0} max={64} suffix="px" onChange={value=>update('props.gap',value)}/>
      <NumberField label="الحد الأدنى للارتفاع" value={props.minHeight??0} min={0} max={1200} onChange={value=>update('props.minHeight',value)}/>
      <SelectField label="المحاذاة الرأسية" value={props.verticalAlign||'stretch'} options={[['stretch','تمديد'],['start','أعلى'],['center','وسط'],['end','أسفل']]} onChange={value=>update('props.verticalAlign',value)}/>
    </InspectorSection>
    <InspectorSection title="تصميم الصف" icon="✦">
      <SelectField label="نمط الخلفية" value={style.variant||'light'} options={[['light','فاتح'],['dark','داكن'],['paper','كريمي'],['brand','هوية ماركتون']]} onChange={value=>update('style.variant',value)}/>
      <SelectField label="عرض المحتوى" value={style.maxWidth||'wide'} options={[['wide','واسع'],['reading','عرض قراءة'],['full','كامل']]} onChange={value=>update('style.maxWidth',value)}/>
      <RangeField label="المسافة الرأسية" value={style.paddingY??18} min={0} max={180} suffix="px" onChange={value=>update('style.paddingY',value)}/>
      <ColorTextField label="لون الخلفية" value={style.background||''} onChange={value=>update('style.background',value)}/>
      <ColorTextField label="لون النص" value={style.color||''} onChange={value=>update('style.color',value)}/>
      <div className={styles.fieldColumns}><NumberField label="سمك الحد" value={style.borderWidth??0} min={0} max={12} onChange={value=>update('style.borderWidth',value)}/><NumberField label="استدارة الحواف" value={style.borderRadius??0} min={0} max={80} onChange={value=>update('style.borderRadius',value)}/></div>
      <ColorTextField label="لون الحد" value={style.borderColor||''} onChange={value=>update('style.borderColor',value)}/>
      <SelectField label="الظل" value={style.shadow||'none'} options={[['none','بدون'],['soft','خفيف'],['medium','متوسط'],['strong','قوي']]} onChange={value=>update('style.shadow',value)}/>
    </InspectorSection>
    <InspectorSection title="متقدم" icon="⚙">
      <TextField label="Anchor ID" value={props.anchor||''} dir="ltr" onChange={value=>update('props.anchor',slug(value))}/>
      <TextField label="CSS Class" value={style.cssClass||''} dir="ltr" onChange={value=>update('style.cssClass',safeClass(value))}/>
      <SelectField label="حركة الدخول" value={style.animation||'none'} options={[['none','بدون'],['fade','تلاشي'],['fade-up','تلاشي لأعلى'],['slide-right','من اليمين'],['slide-left','من اليسار'],['zoom','تكبير']]} onChange={value=>update('style.animation',value)}/>
      <ResponsiveFields responsive={row.responsive||{}} update={update}/>
      <button type="button" className={styles.librarySaveButton} onClick={onSave}>☆ حفظ الصف في Saved</button>
    </InspectorSection>
  </div>;
}

function ColumnInspector({column,update}){
  const style=column.style||{};
  return <div className={styles.inspectorBody}>
    <InspectorSection title="إعدادات العمود" icon="▰">
      <RangeField label="المسافة الداخلية" value={style.padding??18} min={0} max={100} suffix="px" onChange={value=>update('style.padding',value)}/>
      <RangeField label="المسافة بين العناصر" value={style.gap??14} min={0} max={64} suffix="px" onChange={value=>update('style.gap',value)}/>
      <SelectField label="المحاذاة الرأسية" value={style.verticalAlign||'stretch'} options={[['stretch','تمديد'],['start','أعلى'],['center','وسط'],['end','أسفل']]} onChange={value=>update('style.verticalAlign',value)}/>
      <ColorTextField label="لون الخلفية" value={style.background||''} onChange={value=>update('style.background',value)}/>
      <ColorTextField label="لون النص" value={style.color||''} onChange={value=>update('style.color',value)}/>
      <div className={styles.fieldColumns}><NumberField label="سمك الحد" value={style.borderWidth??0} min={0} max={12} onChange={value=>update('style.borderWidth',value)}/><NumberField label="استدارة الحواف" value={style.borderRadius??0} min={0} max={80} onChange={value=>update('style.borderRadius',value)}/></div>
      <ColorTextField label="لون الحد" value={style.borderColor||''} onChange={value=>update('style.borderColor',value)}/>
      <SelectField label="الظل" value={style.shadow||'none'} options={[['none','بدون'],['soft','خفيف'],['medium','متوسط'],['strong','قوي']]} onChange={value=>update('style.shadow',value)}/>
    </InspectorSection>
    <InspectorSection title="الاستجابة" icon="▣"><ResponsiveFields responsive={column.responsive||{}} update={update}/></InspectorSection>
  </div>;
}

function TypeFields({block,update,context}){
  const p=block.props||{};const type=block.type;
  if(type==='hero')return <><TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/><TextArea label="العنوان الرئيسي" value={p.title} rows={3} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} rows={5} onChange={v=>update('props.body',v)}/><MediaField label="صورة الواجهة" value={p.imageUrl} path="props.imageUrl" update={update} context={context}/><TextField label="وصف الصورة" value={p.imageAlt} onChange={v=>update('props.imageAlt',v)}/><ButtonFields prefix="primary" label="الزر الأساسي" props={p} update={update}/><ButtonFields prefix="secondary" label="الزر الثانوي" props={p} update={update}/></>;
  if(['heading','fancyHeading'].includes(type))return <><TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/><TextArea label="العنوان" value={p.title} rows={3} onChange={v=>update('props.title',v)}/>{type==='fancyHeading'&&<TextField label="الكلمة البارزة" value={p.accent} onChange={v=>update('props.accent',v)}/>}<TextArea label="الوصف" value={p.body} rows={4} onChange={v=>update('props.body',v)}/><SelectField label="مستوى العنوان" value={p.level||'h2'} options={[['h1','H1'],['h2','H2'],['h3','H3'],['h4','H4']]} onChange={v=>update('props.level',v)}/></>;
  if(type==='text')return <><TextArea label="النص" value={p.content} rows={14} onChange={v=>update('props.content',v)}/><SelectField label="عدد الأعمدة النصية" value={String(p.columns||1)} options={[['1','عمود واحد'],['2','عمودان'],['3','ثلاثة أعمدة']]} onChange={v=>update('props.columns',Number(v))}/></>;
  if(type==='image')return <><MediaField label="الصورة" value={p.url} path="props.url" update={update} context={context}/><TextField label="النص البديل" value={p.alt} onChange={v=>update('props.alt',v)}/><TextField label="التعليق" value={p.caption} onChange={v=>update('props.caption',v)}/><TextField label="رابط عند النقر" value={p.linkHref} dir="ltr" onChange={v=>update('props.linkHref',v)}/><SelectField label="نسبة الأبعاد" value={p.ratio||'16 / 9'} options={[['16 / 9','عريض 16:9'],['4 / 3','تقليدي 4:3'],['1 / 1','مربع'],['3 / 4','رأسي']]} onChange={v=>update('props.ratio',v)}/><SelectField label="احتواء الصورة" value={p.fit||'cover'} options={[['cover','ملء الإطار'],['contain','إظهار الصورة كاملة']]} onChange={v=>update('props.fit',v)}/></>;
  if(type==='button')return <><TextField label="نص الزر" value={p.label} onChange={v=>update('props.label',v)}/><TextField label="الرابط" value={p.href} dir="ltr" onChange={v=>update('props.href',v)}/><TextField label="الأيقونة" value={p.icon} onChange={v=>update('props.icon',v)}/><SelectField label="النمط" value={p.style||'primary'} options={[['primary','أساسي'],['secondary','ثانوي']]} onChange={v=>update('props.style',v)}/></>;
  if(type==='buttons')return <><ButtonFields prefix="primary" label="الزر الأساسي" props={p} update={update}/><ButtonFields prefix="secondary" label="الزر الثانوي" props={p} update={update}/></>;
  if(['box','alert','callout','feature','linkBlock'].includes(type))return <><TextField label="الأيقونة" value={p.icon} onChange={v=>update('props.icon',v)}/>{['callout','linkBlock'].includes(type)&&<TextField label="العنوان الصغير" value={p.eyebrow} onChange={v=>update('props.eyebrow',v)}/>}<TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} rows={5} onChange={v=>update('props.body',v)}/>{type==='alert'&&<SelectField label="نوع التنبيه" value={p.tone||'info'} options={[['info','معلومة'],['success','نجاح'],['warning','تحذير'],['danger','خطر']]} onChange={v=>update('props.tone',v)}/>} {type==='feature'&&<><TextField label="نص الرابط" value={p.linkLabel} onChange={v=>update('props.linkLabel',v)}/><TextField label="الرابط" value={p.linkHref} dir="ltr" onChange={v=>update('props.linkHref',v)}/></>}{type==='linkBlock'&&<TextField label="الرابط" value={p.href} dir="ltr" onChange={v=>update('props.href',v)}/>}</>;
  if(type==='icon')return <><TextField label="الأيقونة" value={p.icon} onChange={v=>update('props.icon',v)}/><NumberField label="حجم الأيقونة" value={p.size??42} min={18} max={100} onChange={v=>update('props.size',v)}/><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} onChange={v=>update('props.body',v)}/></>;
  if(type==='code')return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextField label="لغة الكود" value={p.language} dir="ltr" onChange={v=>update('props.language',v)}/><TextArea label="الكود" value={p.code} rows={16} dir="ltr" onChange={v=>update('props.code',v)}/></>;
  if(type==='html')return <TextArea label="HTML / Shortcode" value={p.content} rows={18} dir="ltr" onChange={v=>update('props.content',v)}/>;
  if(['gallery','mosaic'].includes(type))return <><SelectField label="عدد الأعمدة" value={String(p.columns||3)} options={[['2','عمودان'],['3','ثلاثة'],['4','أربعة'],['5','خمسة'],['6','ستة']]} onChange={v=>update('props.columns',Number(v))}/><TextArea label="الصور: الرابط | النص البديل" value={itemsToText(p.items,'image')} rows={12} dir="ltr" onChange={v=>update('props.items',textToItems(v,'image'))}/></>;
  if(['cards','post','testimonials','productCategories','products'].includes(type))return <><SectionTextFields p={p} update={update}/><SelectField label="عدد الأعمدة" value={String(p.columns||3)} options={[['1','عمود واحد'],['2','عمودان'],['3','ثلاثة'],['4','أربعة'],['5','خمسة'],['6','ستة']]} onChange={v=>update('props.columns',Number(v))}/><TextArea label={type==='testimonials'?'العناصر: الاسم | الرأي | المسمى':type==='products'?'العناصر: العنوان | الوصف | السعر':'العناصر: العنوان | الوصف | الرابط'} value={itemsToText(p.items,type)} rows={13} onChange={v=>update('props.items',textToItems(v,type))}/></>;
  if(type==='stats')return <><SectionTextFields p={p} update={update}/><SelectField label="عدد الأعمدة" value={String(p.columns||4)} options={[['2','عمودان'],['3','ثلاثة'],['4','أربعة']]} onChange={v=>update('props.columns',Number(v))}/><TextArea label="العناصر: الرقم | العنوان | الوصف" value={itemsToText(p.items,'stats')} rows={12} onChange={v=>update('props.items',textToItems(v,'stats'))}/></>;
  if(['faq','accordion','tabs','timeline'].includes(type))return <>{type!=='accordion'&&type!=='tabs'&&<SectionTextFields p={p} update={update}/>} {type==='accordion'&&<TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/>}<TextArea label={type==='timeline'?'العناصر: الرقم | العنوان | الوصف':'العناصر: العنوان | الوصف'} value={itemsToText(p.items,type)} rows={14} onChange={v=>update('props.items',textToItems(v,type))}/></>;
  if(['menu','serviceMenu','toc'].includes(type))return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="العناصر: العنوان | الرابط" value={itemsToText(p.items,'links')} rows={12} onChange={v=>update('props.items',textToItems(v,'links'))}/>{type==='menu'&&<SelectField label="الاتجاه" value={p.orientation||'horizontal'} options={[['horizontal','أفقي'],['vertical','رأسي']]} onChange={v=>update('props.orientation',v)}/>}</>;
  if(type==='quote')return <><TextArea label="الاقتباس" value={p.quote} rows={7} onChange={v=>update('props.quote',v)}/><TextField label="الاسم" value={p.author} onChange={v=>update('props.author',v)}/><TextField label="المسمى أو المنشأة" value={p.role} onChange={v=>update('props.role',v)}/></>;
  if(type==='cta')return <><SectionTextFields p={p} update={update}/><TextField label="نص الزر" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/><TextField label="رابط الزر" value={p.buttonHref} dir="ltr" onChange={v=>update('props.buttonHref',v)}/></>;
  if(['contact','optin','signup'].includes(type))return <><SectionTextFields p={p} update={update}/><TextField label="نص زر الإرسال" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/></>;
  if(type==='divider')return <><RangeField label="العرض" value={p.width??100} min={10} max={100} suffix="%" onChange={v=>update('props.width',v)}/><NumberField label="السُمك" value={p.thickness??1} min={1} max={8} onChange={v=>update('props.thickness',v)}/><SelectField label="النمط" value={p.style||'solid'} options={[['solid','متصل'],['dashed','متقطع'],['dotted','منقط']]} onChange={v=>update('props.style',v)}/></>;
  if(type==='spacer')return <><NumberField label="كمبيوتر" value={p.desktop??72} min={0} max={300} onChange={v=>update('props.desktop',v)}/><NumberField label="تابلت" value={p.tablet??52} min={0} max={240} onChange={v=>update('props.tablet',v)}/><NumberField label="جوال" value={p.mobile??36} min={0} max={200} onChange={v=>update('props.mobile',v)}/></>;
  if(type==='copyright')return <><TextField label="النص" value={p.text} onChange={v=>update('props.text',v)}/><TextField label="اسم المنشأة" value={p.company} onChange={v=>update('props.company',v)}/><Hint>استخدم {'{year}'} لإظهار السنة الحالية تلقائيًا.</Hint></>;
  if(['map','lottie','video'].includes(type))return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextField label={type==='map'?'رابط الخريطة':type==='lottie'?'رابط ملف JSON':'رابط الفيديو'} value={p.mapUrl||p.url} dir="ltr" onChange={v=>update(type==='map'?'props.mapUrl':'props.url',v)}/>{type==='map'&&<><TextArea label="العنوان البريدي" value={p.address} onChange={v=>update('props.address',v)}/><NumberField label="الارتفاع" value={p.height??320} min={180} max={700} onChange={v=>update('props.height',v)}/></>}{type==='video'&&<SelectField label="نسبة الأبعاد" value={p.ratio||'16 / 9'} options={[['16 / 9','16:9'],['4 / 3','4:3'],['1 / 1','مربع']]} onChange={v=>update('props.ratio',v)}/>}</>;
  if(type==='overlay')return <><MediaField label="صورة الخلفية" value={p.imageUrl} path="props.imageUrl" update={update} context={context}/><SectionTextFields p={p} update={update}/><TextField label="نص الزر" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/><TextField label="الرابط" value={p.buttonHref} dir="ltr" onChange={v=>update('props.buttonHref',v)}/></>;
  if(type==='slider')return <><NumberField label="الارتفاع" value={p.height??480} min={240} max={800} onChange={v=>update('props.height',v)}/><TextArea label="الشرائح: العنوان | الوصف | رابط الصورة | نص الزر | الرابط" value={itemsToText(p.items,'slider')} rows={15} onChange={v=>update('props.items',textToItems(v,'slider'))}/></>;
  if(type==='table')return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="كل سطر صف، وافصل الخلايا بعلامة |" value={tableToText(p.rows)} rows={15} onChange={v=>update('props.rows',textToTable(v))}/></>;
  if(type==='rating')return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><NumberField label="التقييم" value={p.value??5} min={0} max={10} onChange={v=>update('props.value',v)}/><NumberField label="من" value={p.outOf??5} min={1} max={10} onChange={v=>update('props.outOf',v)}/><NumberField label="عدد التقييمات" value={p.count??0} min={0} max={1000000} onChange={v=>update('props.count',v)}/></>;
  if(type==='login')return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} onChange={v=>update('props.body',v)}/><TextField label="نص زر الدخول" value={p.buttonLabel} onChange={v=>update('props.buttonLabel',v)}/><TextField label="نص نسيت كلمة المرور" value={p.forgotLabel} onChange={v=>update('props.forgotLabel',v)}/></>;
  if(['widget','widgetArea','layoutPart'].includes(type))return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body} onChange={v=>update('props.body',v)}/><TextField label="المعرّف" value={p.widgetKey||p.areaKey||p.partKey} dir="ltr" onChange={v=>update(type==='widget'?'props.widgetKey':type==='widgetArea'?'props.areaKey':'props.partKey',v)}/></>;
  if(type==='socialShare')return <><TextField label="العنوان" value={p.title} onChange={v=>update('props.title',v)}/><TextField label="الشبكات مفصولة بفاصلة" value={p.networks} dir="ltr" onChange={v=>update('props.networks',v)}/></>;
  return <><TextField label="العنوان" value={p.title||''} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body||''} rows={6} onChange={v=>update('props.body',v)}/></>;
}

export function PageInspector({document,update}){return <div className={styles.inspectorBody}><InspectorSection title="إعدادات الصفحة" icon="▤"><SelectField label="عرض المحتوى الافتراضي" value={document.settings.contentWidth} options={[['wide','واسع'],['reading','عرض قراءة'],['full','كامل']]} onChange={v=>update('contentWidth',v)}/><ColorTextField label="خلفية الصفحة" value={document.settings.background} onChange={v=>update('background',v)}/><TextArea label="CSS مخصص للصفحة" value={document.settings.customCss||''} rows={14} dir="ltr" onChange={v=>update('customCss',v)}/><div className={styles.helpCard}><strong>اختصارات المصمم</strong><kbd>Ctrl + S</kbd><span>حفظ المسودة</span><kbd>Ctrl + Z</kbd><span>تراجع</span><kbd>Ctrl + D</kbd><span>تكرار العنصر</span><kbd>Delete</kbd><span>حذف المحدد</span></div></InspectorSection></div>}
export function VersionHistory({versions,busy,onRestore}){return <section className={styles.versionPanel}><header><h2>سجل الإصدارات</h2><p>الحفظ والنشر ينشئان نقاط استعادة.</p></header><div>{versions.map(version=><article key={version.id}><span>{version.versionKind==='published'?'منشور':version.versionKind==='restored'?'استعادة':'مسودة'} · #{version.versionNumber}</span><time>{formatDate(version.createdAt)}</time><button type="button" disabled={busy==='restore-version'} onClick={()=>onRestore(version.id)}>استعادة</button></article>)}{!versions.length&&<p>لا توجد إصدارات محفوظة بعد.</p>}</div></section>}
export function Status({value}){return <span className={`${styles.status} ${styles[`status_${value}`]||''}`}>{value==='published'?'منشور':value==='draft'?'مسودة':'مؤرشف'}</span>}

function LayoutSelect({value,onChange}){return <div className={styles.layoutPicker}>{Object.entries(ROW_LAYOUTS).map(([key,item])=><button type="button" key={key} className={value===key?styles.layoutActive:''} onClick={()=>onChange(key)} title={item.label}><span style={{gridTemplateColumns:item.template}}>{Array.from({length:item.columns},(_,index)=><i key={index}/>)}</span><small>{item.label}</small></button>)}</div>}
function ResponsiveFields({responsive,update}){return <div className={styles.responsiveToggles}><Toggle label="إخفاء على الكمبيوتر" checked={responsive.hideDesktop} onChange={value=>update('responsive.hideDesktop',value)}/><Toggle label="إخفاء على التابلت" checked={responsive.hideTablet} onChange={value=>update('responsive.hideTablet',value)}/><Toggle label="إخفاء على الجوال" checked={responsive.hideMobile} onChange={value=>update('responsive.hideMobile',value)}/></div>}
function SectionTextFields({p,update}){return <><TextField label="العنوان الصغير" value={p.eyebrow||''} onChange={v=>update('props.eyebrow',v)}/><TextArea label="العنوان" value={p.title||''} rows={3} onChange={v=>update('props.title',v)}/><TextArea label="الوصف" value={p.body||''} rows={4} onChange={v=>update('props.body',v)}/></>}
function ButtonFields({prefix,label,props,update}){return <div className={styles.fieldGroup}><strong>{label}</strong><TextField label="النص" value={props[`${prefix}Label`]} onChange={v=>update(`props.${prefix}Label`,v)}/><TextField label="الرابط" value={props[`${prefix}Href`]} dir="ltr" onChange={v=>update(`props.${prefix}Href`,v)}/></div>}

function MediaField({label,value='',path,update,context}){
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  async function upload(event){const file=event.target.files?.[0];if(!file)return;setBusy(true);setError('');try{const form=new FormData();form.set('file',file);form.set('siteKey',context?.siteKey||'marktone-main');if(context?.tenantSlug)form.set('tenantSlug',context.tenantSlug);const response=await fetch('/api/cms/media/upload',{method:'POST',body:form});const result=await response.json();if(!response.ok)throw new Error(result?.error||'تعذر رفع الصورة');const asset=result.asset||{};const url=asset.url||asset.publicUrl||asset.public_url;if(!url)throw new Error('لم يتم استلام رابط الصورة');update(path,url);}catch(caught){setError(caught instanceof Error?caught.message:String(caught));}finally{setBusy(false);event.target.value='';}}
  return <div className={styles.mediaField}><TextField label={label} value={value} dir="ltr" onChange={v=>update(path,v)}/><label className={styles.uploadButton}><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" onChange={upload}/><span>{busy?'جارٍ الرفع…':'رفع من الجهاز'}</span></label>{value&&<div className={styles.mediaPreview} style={{backgroundImage:`url(${safePreview(value)})`}}/>}{error&&<small className={styles.fieldError}>{error}</small>}</div>;
}
function InspectorSection({title,icon,children}){return <section className={styles.inspectorSection}><h2><span>{icon}</span>{title}</h2>{children}</section>}
function TextField({label,value='',onChange,dir,placeholder=''}){return <label className={styles.field}><span>{label}</span><input value={value||''} dir={dir} placeholder={placeholder} onChange={event=>onChange(event.target.value)}/></label>}
function TextArea({label,value='',onChange,rows=5,dir}){return <label className={styles.field}><span>{label}</span><textarea value={value||''} rows={rows} dir={dir} onChange={event=>onChange(event.target.value)}/></label>}
function NumberField({label,value,onChange,min,max}){return <label className={styles.field}><span>{label}</span><input type="number" value={value??0} min={min} max={max} onChange={event=>onChange(Number(event.target.value))}/></label>}
function RangeField({label,value,onChange,min,max,suffix=''}){return <label className={styles.rangeField}><span>{label}<b>{value}{suffix}</b></span><input type="range" value={value??0} min={min} max={max} onChange={event=>onChange(Number(event.target.value))}/></label>}
function ColorTextField({label,value='',onChange,placeholder='#ffffff'}){const color=/^#[0-9a-f]{6}$/i.test(value)?value:'#ffffff';return <label className={styles.field}><span>{label}</span><div className={styles.colorInput}><input type="color" value={color} onChange={event=>onChange(event.target.value)}/><input value={value||''} dir="ltr" placeholder={placeholder} onChange={event=>onChange(event.target.value)}/></div></label>}
function SelectField({label,value,onChange,options}){return <label className={styles.field}><span>{label}</span><select value={value} onChange={event=>onChange(event.target.value)}>{options.map(([key,text])=><option value={key} key={key}>{text}</option>)}</select></label>}
function Toggle({label,checked,onChange}){return <label className={styles.toggle}><input type="checkbox" checked={Boolean(checked)} onChange={event=>onChange(event.target.checked)}/><span>{label}</span></label>}
function Hint({children}){return <div className={styles.hint}>{children}</div>}

function itemsToText(items,type){return (Array.isArray(items)?items:[]).map(item=>{
  if(type==='stats'||type==='timeline')return `${item.value||''} | ${item.title||''} | ${item.description||''}`;
  if(type==='testimonials')return `${item.title||''} | ${item.description||''} | ${item.role||''}`;
  if(type==='products')return `${item.title||''} | ${item.description||''} | ${item.value||''}`;
  if(type==='post'||type==='cards'||type==='productCategories')return `${item.title||''} | ${item.description||''} | ${item.href||''}`;
  if(type==='links')return `${item.title||''} | ${item.href||''}`;
  if(type==='image')return `${item.url||''} | ${item.alt||''}`;
  if(type==='slider')return `${item.title||''} | ${item.description||''} | ${item.imageUrl||''} | ${item.buttonLabel||''} | ${item.buttonHref||''}`;
  return `${item.title||''} | ${item.description||''}`;
}).join('\n')}
function textToItems(text,type){return String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const parts=line.split('|').map(item=>item.trim());
  if(type==='stats'||type==='timeline')return {value:parts[0]||'',title:parts[1]||'',description:parts.slice(2).join(' | ')};
  if(type==='testimonials')return {title:parts[0]||'',description:parts[1]||'',role:parts.slice(2).join(' | ')};
  if(type==='products')return {title:parts[0]||'',description:parts[1]||'',value:parts.slice(2).join(' | ')};
  if(type==='post'||type==='cards'||type==='productCategories')return {title:parts[0]||'',description:parts[1]||'',href:parts.slice(2).join(' | ')};
  if(type==='links')return {title:parts[0]||'',href:parts.slice(1).join(' | ')};
  if(type==='image')return {url:parts[0]||'',alt:parts.slice(1).join(' | ')};
  if(type==='slider')return {title:parts[0]||'',description:parts[1]||'',imageUrl:parts[2]||'',buttonLabel:parts[3]||'',buttonHref:parts.slice(4).join(' | ')};
  return {title:parts[0]||'',description:parts.slice(1).join(' | ')};
}).filter(item=>item.title||item.value||item.url)}
function tableToText(rows){return (Array.isArray(rows)?rows:[]).map(row=>(Array.isArray(row)?row:[]).join(' | ')).join('\n')}
function textToTable(text){return String(text||'').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>line.split('|').map(cell=>cell.trim()))}
function slug(value){return String(value||'').toLowerCase().replace(/[^a-z0-9_-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,64)}
function safeClass(value){return String(value||'').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,160)}
function safePreview(value){return String(value||'').replace(/["'()]/g,encodeURIComponent)}
function formatDate(value){try{return new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}catch{return ''}}
