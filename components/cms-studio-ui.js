'use client';

import {useState} from 'react';
import styles from './cms-studio.module.css';

export const STATUS_LABELS={
  draft:'مسودة',published:'منشور',archived:'مؤرشف',maintenance:'صيانة',
  new:'جديدة',in_progress:'قيد المتابعة',resolved:'تمت المعالجة',spam:'مزعجة'
};
export const PAGE_KINDS=[
  ['standard','صفحة عادية'],['landing','صفحة هبوط'],
  ['legal','صفحة قانونية'],['system','صفحة نظام']
];
export const VISIBILITY=[
  ['public','عامة'],['unlisted','غير مدرجة'],['members','للعملاء فقط']
];

export function MegaMenuPreview({tree}){
  const first=tree.find(item=>item.isMega)||tree[0];
  if(!first)return <Empty text="أضف عناصر لرؤية المعاينة."/>;
  const children=first.children||[];
  const columns=Math.max(2,Math.min(6,Number(first.megaSettings?.columns)||3));
  return <div className={styles.megaPreview}>
    <header><span>{first.icon||'☰'}</span><b>{first.label}</b><small>{first.badge}</small></header>
    <section style={{'--columns':columns}}>
      {Array.from({length:columns},(_,column)=><div key={column}>
        {children.filter(child=>(child.columnIndex||1)===column+1).map(child=><article key={child.id}>
          <span>{child.icon||'↗'}</span><div><b>{child.label}</b><small>{child.description}</small></div>
        </article>)}
      </div>)}
    </section>
  </div>;
}

export function MenuActions({items}){
  const [open,setOpen]=useState(false);
  const valid=items.filter(Boolean);
  return <div className={styles.moreActions}>
    <button type="button" onClick={()=>setOpen(value=>!value)}>•••</button>
    {open&&<div>{valid.map(item=><button
      type="button"
      key={item.label}
      className={item.danger?styles.dangerText:''}
      onClick={()=>{setOpen(false);item.onClick();}}
    >{item.label}</button>)}</div>}
  </div>;
}

export function Toolbar({query,setQuery,placeholder}){
  return <div className={styles.toolbar}>
    <span>⌕</span><input value={query} onChange={event=>setQuery(event.target.value)} placeholder={placeholder}/>
    {query&&<button type="button" onClick={()=>setQuery('')}>×</button>}
  </div>;
}
export function Stat({value,label,detail,icon}){return <article><span>{icon}</span><strong>{value}</strong><b>{label}</b><small>{detail}</small></article>}
export function PanelHeading({title,description,action,onAction}){return <header className={styles.panelHeading}><div><h2>{title}</h2><p>{description}</p></div>{action&&<button type="button" onClick={onAction}>{action}</button>}</header>}
export function Status({value}){return <span className={`${styles.status} ${styles[`status_${value}`]||''}`}>{STATUS_LABELS[value]||value||'مسودة'}</span>}
export function Empty({text}){return <div className={styles.empty}><span>◇</span><strong>{text}</strong></div>}

export function Field({label,name,defaultValue='',required=false,textarea=false,wide=false,ltr=false,type='text',hint=''}){
  return <label className={`${styles.field} ${wide?styles.wideField:''}`}>
    <span>{label}{required&&' *'}</span>
    {textarea
      ?<textarea name={name} defaultValue={defaultValue||''} rows={5} required={required}/>
      :<input name={name} defaultValue={defaultValue??''} type={type} required={required} dir={ltr?'ltr':undefined}/>} 
    {hint&&<small>{hint}</small>}
  </label>;
}
export function Select({label,name,defaultValue='',options=[]}){
  return <label className={styles.field}><span>{label}</span><select name={name} defaultValue={String(defaultValue??'')}>
    {options.map(([optionValue,optionLabel])=><option value={optionValue} key={String(optionValue)}>{optionLabel}</option>)}
  </select></label>;
}
export function Check({name,label,defaultChecked}){return <label className={styles.check}><input type="checkbox" name={name} defaultChecked={Boolean(defaultChecked)}/><span>{label}</span></label>}
export function ColorField({label,name,defaultValue}){return <label className={styles.colorField}><span>{label}</span><div><input type="color" name={name} defaultValue={defaultValue}/><code>{defaultValue}</code></div></label>}
export function MediaSelect({label,name,defaultValue='',assets=[]}){
  return <label className={`${styles.field} ${styles.wideField}`}>
    <span>{label}</span>
    <select name={`${name}Library`} defaultValue={assets.some(asset=>asset.url===defaultValue)?defaultValue:''} onChange={event=>{
      const input=event.currentTarget.parentElement.querySelector(`input[name="${name}"]`);
      if(event.target.value&&input)input.value=event.target.value;
    }}>
      <option value="">اختر من مكتبة الوسائط</option>
      {assets.map(asset=><option key={asset.id} value={asset.url}>{asset.fileName}</option>)}
    </select>
    <input name={name} defaultValue={defaultValue||''} dir="ltr" placeholder="أو ألصق رابط الصورة"/>
  </label>;
}

export function payloadFor(type,form,row){
  const base={id:value(form,'id')||undefined};
  if(type==='page')return {...base,title:value(form,'title'),slug:value(form,'slug').toLowerCase(),menuLabel:value(form,'menuLabel'),excerpt:value(form,'excerpt'),coverUrl:value(form,'coverUrl'),pageKind:value(form,'pageKind'),parentPageId:value(form,'parentPageId'),sortOrder:numberValue(form,'sortOrder',100),visibility:value(form,'visibility'),showInMenu:checked(form,'showInMenu'),menuOrder:numberValue(form,'menuOrder',100),status:value(form,'status'),seoTitle:value(form,'seoTitle'),seoDescription:value(form,'seoDescription'),canonicalUrl:value(form,'canonicalUrl'),robots:value(form,'robots'),layoutSettings:{}};
  if(type==='article')return {...base,title:value(form,'title'),slug:value(form,'slug').toLowerCase(),excerpt:value(form,'excerpt'),coverUrl:value(form,'coverUrl'),category:value(form,'category'),tags:value(form,'tags').split(',').map(item=>item.trim()).filter(Boolean),authorName:value(form,'authorName'),readingMinutes:value(form,'readingMinutes'),visibility:value(form,'visibility'),status:value(form,'status'),scheduledAt:value(form,'scheduledAt'),featured:checked(form,'featured'),seoTitle:value(form,'seoTitle'),seoDescription:value(form,'seoDescription'),canonicalUrl:value(form,'canonicalUrl'),robots:value(form,'robots')};
  if(type==='menu')return {...base,name:value(form,'name'),key:value(form,'key'),location:value(form,'location'),description:value(form,'description'),status:value(form,'status'),settings:{megaMenu:checked(form,'megaMenu'),mobileStyle:value(form,'mobileStyle')}};
  if(type==='menuItem')return {...base,menuId:value(form,'menuId'),label:value(form,'label'),kind:value(form,'kind'),targetPageId:value(form,'targetPageId'),targetArticleId:value(form,'targetArticleId'),newPageTitle:value(form,'newPageTitle'),newPageSlug:value(form,'newPageSlug'),newArticleTitle:value(form,'newArticleTitle'),newArticleSlug:value(form,'newArticleSlug'),href:value(form,'href'),parentId:value(form,'parentId'),description:value(form,'description'),icon:value(form,'icon'),badge:value(form,'badge'),imageUrl:value(form,'imageUrl'),columnIndex:numberValue(form,'columnIndex',1),sortOrder:numberValue(form,'sortOrder',100),isMega:checked(form,'isMega'),megaSettings:{columns:numberValue(form,'megaColumns',3)},mobileLabel:value(form,'mobileLabel'),cssClass:value(form,'cssClass'),status:value(form,'status'),isVisible:checked(form,'isVisible'),openInNewTab:checked(form,'openInNewTab')};
  if(type==='category')return {...base,name:value(form,'name'),slug:value(form,'slug').toLowerCase(),parentId:value(form,'parentId'),sortOrder:numberValue(form,'sortOrder',100),description:value(form,'description')};
  if(type==='asset')return {...base,altText:value(form,'altText'),caption:value(form,'caption')};
  return base;
}
export function cleanPayload(payload){
  const copy={...payload};
  delete copy.newPageTitle;delete copy.newPageSlug;delete copy.newArticleTitle;delete copy.newArticleSlug;
  if(copy.targetPageId==='__new__')copy.targetPageId='';
  if(copy.targetArticleId==='__new__')copy.targetArticleId='';
  return copy;
}
export function newPage(){return {title:'',slug:`page-${Date.now().toString(36)}`,excerpt:'',pageKind:'standard',visibility:'public',status:'draft',sortOrder:100,menuOrder:100,showInMenu:false};}
export function newArticle(){return {title:'',slug:`article-${Date.now().toString(36)}`,excerpt:'',category:'',tags:[],authorName:'فريق العمل',visibility:'public',status:'draft',featured:false};}
export function newMenu(){return {name:'',key:`menu-${Date.now().toString(36)}`,location:'custom',description:'',settings:{megaMenu:true,mobileStyle:'drawer'},status:'published'};}
export function newMenuItem(menuId,parentId=''){return {menuId,parentId,label:'',kind:'page',href:'',columnIndex:1,sortOrder:100,isMega:false,megaSettings:{columns:3},isVisible:true,status:'published'};}
export function newCategory(){return {name:'',slug:`category-${Date.now().toString(36)}`,sortOrder:100};}
export function value(form,key){return String(form.get(key)||'').trim();}
export function checked(form,key){return form.get(key)==='on';}
export function numberValue(form,key,fallback){const number=Number(form.get(key));return Number.isFinite(number)?number:fallback;}
export function matches(query,...values){const term=String(query||'').trim().toLowerCase();return !term||values.some(item=>String(item||'').toLowerCase().includes(term));}
export function safeImage(value){const url=String(value||'').trim();return /^(javascript|data:text\/html|vbscript):/i.test(url)?'':url.replace(/["'()]/g,encodeURIComponent);}
export function toDateTimeLocal(value){if(!value)return '';try{return new Date(value).toISOString().slice(0,16)}catch{return ''}}
