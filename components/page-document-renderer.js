'use client';

import Link from 'next/link';
import {useState} from 'react';
import {normalizeBuilderDocument} from '../lib/website-builder';
import styles from './page-document-renderer.module.css';

const ICONS=['✦','↗','◎','◇','◌','⌁','▦','↳'];

export default function PageDocumentRenderer({
  document,
  editor=false,
  device='desktop',
  selectedId='',
  onSelect,
  onDropAt,
  onDragStart,
  onDuplicate,
  onDelete
}){
  const normalized=normalizeBuilderDocument(document);
  return <div
    className={`${styles.document} ${styles[`device_${device}`]||''}`}
    style={{background:normalized.settings.background}}
  >
    {editor&&<DropZone index={0} onDropAt={onDropAt}/>} 
    {normalized.blocks.map((block,index)=>{
      const hidden=Boolean(
        device==='desktop'&&block.responsive?.hideDesktop
        ||device==='tablet'&&block.responsive?.hideTablet
        ||device==='mobile'&&block.responsive?.hideMobile
      );
      const content=<BlockView block={block} editor={editor}/>;
      if(!editor)return <ResponsiveBlock key={block.id} block={block}>{content}</ResponsiveBlock>;
      return <div key={block.id}>
        <article
          className={`${styles.editorBlock} ${selectedId===block.id?styles.selected:''} ${hidden?styles.hiddenInDevice:''}`}
          draggable
          onDragStart={event=>onDragStart?.(event,block.id)}
          onClick={event=>{event.stopPropagation();onSelect?.(block.id);}}
          data-block-id={block.id}
        >
          <div className={styles.editorToolbar}>
            <span className={styles.dragHandle} title="اسحب لإعادة الترتيب">⋮⋮</span>
            <b>{blockLabel(block.type)}</b>
            {hidden&&<small>مخفي على هذا المقاس</small>}
            <button type="button" onClick={event=>{event.stopPropagation();onDuplicate?.(block.id);}}>نسخ</button>
            <button type="button" onClick={event=>{event.stopPropagation();onDelete?.(block.id);}}>حذف</button>
          </div>
          {content}
        </article>
        <DropZone index={index+1} onDropAt={onDropAt}/>
      </div>;
    })}
    {editor&&!normalized.blocks.length&&<div className={styles.emptyCanvas}>
      <strong>ابدأ بإضافة أول عنصر</strong>
      <span>اسحب عنصرًا من المكتبة أو اضغط عليه.</span>
    </div>}
  </div>;
}

export function BlockView({block,editor=false}){
  const style=block.style||{};
  const props=block.props||{};
  const className=[
    styles.block,
    styles[`variant_${style.variant||'light'}`]||'',
    styles[`align_${style.align||'right'}`]||'',
    styles[`width_${style.maxWidth||'wide'}`]||''
  ].join(' ');
  const inline={
    '--block-padding':`${clamp(style.paddingY,0,180,72)}px`,
    '--block-background':style.background||'transparent',
    '--block-color':style.color||'inherit'
  };
  const common={id:props.anchor||undefined,className,style:inline,'data-builder-type':block.type};

  if(block.type==='hero')return <section {...common} className={`${className} ${styles.hero}`}>
    <div className={styles.heroCopy}>
      {props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}
      <h1>{props.title||'عنوان الصفحة'}</h1>
      {props.body&&<p className={styles.lead}>{props.body}</p>}
      <ButtonRow props={props}/>
    </div>
    <div className={styles.heroVisual} style={props.imageUrl?{backgroundImage:`url(${safeImage(props.imageUrl)})`}:undefined} role={props.imageUrl?'img':undefined} aria-label={props.imageAlt||undefined}>
      {!props.imageUrl&&<><i/><i/><i/><strong>Marktone</strong><small>Visual Builder</small></>}
    </div>
  </section>;

  if(block.type==='heading'){
    const Tag=['h2','h3','h4'].includes(props.level)?props.level:'h2';
    return <section {...common}>
      <div className={styles.headingBlock}>
        {props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}
        <Tag>{props.title||'عنوان القسم'}</Tag>
        {props.body&&<p>{props.body}</p>}
      </div>
    </section>;
  }

  if(block.type==='text')return <section {...common}>
    <div className={styles.textBlock} style={{columnCount:clamp(props.columns,1,3,1)}}>{textBlocks(props.content)}</div>
  </section>;

  if(block.type==='image')return <section {...common}>
    <figure className={styles.imageBlock}>
      <div style={{aspectRatio:props.ratio||'16 / 9',backgroundImage:props.url?`url(${safeImage(props.url)})`:undefined,backgroundSize:props.fit||'cover'}}>
        {!props.url&&<span>أضف رابط الصورة من لوحة الخصائص</span>}
      </div>
      {props.caption&&<figcaption>{props.caption}</figcaption>}
    </figure>
  </section>;

  if(block.type==='buttons')return <section {...common}><ButtonRow props={props}/></section>;

  if(block.type==='cards')return <section {...common}>
    <SectionHeading props={props}/>
    <div className={styles.cardGrid} style={{'--columns':clamp(props.columns,1,4,3)}}>
      {array(props.items).map((item,index)=><article key={`${item.title}-${index}`} className={styles.card}>
        <span>{ICONS[index%ICONS.length]}</span><small>{String(index+1).padStart(2,'0')}</small>
        <h3>{item.title}</h3><p>{item.description}</p>
      </article>)}
    </div>
  </section>;

  if(block.type==='stats')return <section {...common}>
    <SectionHeading props={props}/>
    <div className={styles.statsGrid} style={{'--columns':clamp(props.columns,2,4,4)}}>
      {array(props.items).map((item,index)=><article key={`${item.title}-${index}`}>
        <strong>{item.value}</strong><h3>{item.title}</h3><p>{item.description}</p>
      </article>)}
    </div>
  </section>;

  if(block.type==='columns')return <section {...common}>
    <div className={styles.columnsGrid} style={{'--columns':clamp(props.columns,1,3,2)}}>
      {array(props.items).map((item,index)=><article key={`${item.title}-${index}`}><span>{String(index+1).padStart(2,'0')}</span><h3>{item.title}</h3><p>{item.description}</p></article>)}
    </div>
  </section>;

  if(block.type==='quote')return <section {...common}>
    <blockquote className={styles.quote}><span>“</span><p>{props.quote}</p><footer><strong>{props.author}</strong><small>{props.role}</small></footer></blockquote>
  </section>;

  if(block.type==='faq')return <section {...common}>
    <SectionHeading props={props}/>
    <div className={styles.faqList}>{array(props.items).map((item,index)=><details key={`${item.title}-${index}`} open={editor&&index===0}><summary>{item.title}<span>+</span></summary><p>{item.description}</p></details>)}</div>
  </section>;

  if(block.type==='cta')return <section {...common}>
    <div className={styles.ctaBlock}><div>{props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}<h2>{props.title}</h2><p>{props.body}</p></div><SmartLink href={props.buttonHref} className={styles.primaryButton}>{props.buttonLabel||'ابدأ الآن'} <span>↗</span></SmartLink></div>
  </section>;

  if(block.type==='contact')return <section {...common}>
    <ContactBlock props={props} editor={editor}/>
  </section>;

  if(block.type==='divider')return <section {...common}><div className={styles.divider} style={{width:`${clamp(props.width,10,100,100)}%`,borderTopWidth:clamp(props.thickness,1,8,1)}}/></section>;

  if(block.type==='spacer')return <section {...common} className={`${className} ${styles.spacer}`} style={{...inline,'--desktop-space':`${clamp(props.desktop,0,300,72)}px`,'--tablet-space':`${clamp(props.tablet,0,240,52)}px`,'--mobile-space':`${clamp(props.mobile,0,200,36)}px`}} aria-hidden="true"/>;

  return <section {...common}><div className={styles.textBlock}>عنصر غير مدعوم</div></section>;
}

function ResponsiveBlock({block,children}){
  const responsive=block.responsive||{};
  return <div
    className={styles.responsiveBlock}
    data-hide-desktop={responsive.hideDesktop||undefined}
    data-hide-tablet={responsive.hideTablet||undefined}
    data-hide-mobile={responsive.hideMobile||undefined}
  >{children}</div>;
}

function DropZone({index,onDropAt}){
  return <div
    className={styles.dropZone}
    onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move';}}
    onDrop={event=>{event.preventDefault();onDropAt?.(index,event);}}
  ><span>ضع العنصر هنا</span></div>;
}

function SectionHeading({props}){
  return <div className={styles.sectionHeading}>
    {props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}
    {props.title&&<h2>{props.title}</h2>}
    {props.body&&<p>{props.body}</p>}
  </div>;
}

function ButtonRow({props}){
  return <div className={styles.buttonRow}>
    {props.primaryLabel&&<SmartLink href={props.primaryHref} className={styles.primaryButton}>{props.primaryLabel}<span>↗</span></SmartLink>}
    {props.secondaryLabel&&<SmartLink href={props.secondaryHref} className={styles.secondaryButton}>{props.secondaryLabel}<span>↗</span></SmartLink>}
  </div>;
}

function SmartLink({href,children,className=''}){
  const target=safeHref(href);
  if(!target)return <span className={className}>{children}</span>;
  if(target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:')||/^https?:\/\//i.test(target)){
    return <a href={target} className={className} rel={/^https?:\/\//i.test(target)?'noreferrer':undefined}>{children}</a>;
  }
  return <Link href={target} className={className}>{children}</Link>;
}

function ContactBlock({props,editor}){
  const [state,setState]=useState({status:'idle',message:''});
  async function submit(event){
    event.preventDefault();
    if(editor)return;
    const form=event.currentTarget;
    const payload=Object.fromEntries(new FormData(form));
    setState({status:'loading',message:''});
    try{
      const response=await fetch('/api/public/contact',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({...payload,consent:Boolean(payload.consent),sourcePage:window.location.pathname})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result?.error||'تعذر إرسال الطلب');
      form.reset();
      setState({status:'success',message:result.message||'تم إرسال الطلب'});
    }catch(error){setState({status:'error',message:error.message});}
  }
  return <div className={styles.contactBlock}>
    <div><p className={styles.eyebrow}>{props.eyebrow}</p><h2>{props.title}</h2><p>{props.body}</p><small>سيتم حفظ الرسائل داخل لوحة إدارة موقع ماركتون.</small></div>
    <form onSubmit={submit}>
      <div><label><span>الاسم *</span><input name="name" required minLength={2} disabled={editor}/></label><label><span>اسم المنشأة</span><input name="organization" disabled={editor}/></label></div>
      <div><label><span>الجوال</span><input name="phone" inputMode="tel" disabled={editor}/></label><label><span>البريد الإلكتروني</span><input name="email" type="email" disabled={editor}/></label></div>
      <label><span>التحدي الحالي *</span><textarea name="message" rows={4} required minLength={10} disabled={editor}/></label>
      <label className={styles.consent}><input type="checkbox" name="consent" disabled={editor}/><span>أوافق على تواصل فريق ماركتون بخصوص الطلب.</span></label>
      <input className={styles.honeypot} name="website" tabIndex={-1} autoComplete="off"/>
      <button disabled={editor||state.status==='loading'}>{state.status==='loading'?'جارٍ الإرسال…':props.buttonLabel||'إرسال الطلب'} <span>↗</span></button>
      {state.message&&<p className={state.status==='success'?styles.formSuccess:styles.formError}>{state.message}</p>}
    </form>
  </div>;
}

function textBlocks(value){
  return String(value||'').split(/\n{2,}/).filter(Boolean).map((text,index)=><p key={`${text.slice(0,20)}-${index}`}>{text.split('\n').map((line,lineIndex)=><span key={`${line}-${lineIndex}`}>{line}{lineIndex<text.split('\n').length-1&&<br/>}</span>)}</p>);
}
function array(value){return Array.isArray(value)?value:[];}
function clamp(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(Math.max(number,min),max):fallback;}
function blockLabel(type){return ({hero:'واجهة رئيسية',heading:'عنوان قسم',text:'نص',image:'صورة',buttons:'أزرار',cards:'بطاقات',stats:'إحصائيات',columns:'أعمدة',quote:'اقتباس',faq:'أسئلة شائعة',cta:'دعوة لاتخاذ إجراء',contact:'نموذج تواصل',divider:'فاصل',spacer:'مسافة'})[type]||type;}
function safeHref(value){const href=String(value||'').trim();if(!href)return '';if(/^(javascript|data|vbscript):/i.test(href))return '';return href;}
function safeImage(value){const url=String(value||'').trim();if(!url||/^(javascript|data:text\/html|vbscript):/i.test(url))return '';return url.replace(/["'()]/g,encodeURIComponent);}
