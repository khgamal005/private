'use client';

import Link from 'next/link';
import {useEffect,useMemo,useRef,useState} from 'react';
import baseStyles from './page-document-renderer.module.css';
import proStyles from './page-document-renderer-pro.module.css';

const styles={...baseStyles,...proStyles};
const ICONS=['✦','↗','◎','◇','◌','⌁','▦','↳'];

export function ModuleView({block,editor=false,target,onInlineEdit,onActivate,nested=false,pageCss=''}){
  const p=block.props||{};const s=block.style||{};
  const className=[styles.block,nested?styles.nestedBlock:'',styles[`variant_${s.variant||'light'}`]||'',styles[`align_${s.align||'right'}`]||'',styles[`width_${s.maxWidth||'wide'}`]||'',safeClass(s.cssClass)].filter(Boolean).join(' ');
  const common={id:p.anchor||undefined,className,style:blockStyle(s),'data-builder-type':block.type,'data-animation':s.animation&&s.animation!=='none'?s.animation:undefined};
  const edit=(path)=>({editor,target,path,onInlineEdit});

  if(block.type==='hero')return <section {...common} className={`${className} ${styles.hero}`}><div className={styles.heroCopy}><Edit as="p" className={styles.eyebrow} value={p.eyebrow} {...edit('props.eyebrow')}/><Edit as="h1" value={p.title||'عنوان الصفحة'} {...edit('props.title')}/><Edit as="p" className={styles.lead} value={p.body} {...edit('props.body')}/><ButtonRow p={p} editor edit={edit}/></div><Visual image={p.imageUrl} alt={p.imageAlt}/></section>;

  if(['heading','fancyHeading'].includes(block.type)){const Tag=['h1','h2','h3','h4'].includes(p.level)?p.level:'h2';return <section {...common}><div className={`${styles.headingBlock} ${block.type==='fancyHeading'?styles.fancyHeading:''}`}><Edit as="p" className={styles.eyebrow} value={p.eyebrow} {...edit('props.eyebrow')}/><Edit as={Tag} value={p.title||'عنوان القسم'} {...edit('props.title')}/>{p.accent&&<span className={styles.headingAccent}>{p.accent}</span>}<Edit as="p" value={p.body} {...edit('props.body')}/></div></section>}
  if(block.type==='text')return <section {...common}><EditableTextBlock value={p.content} columns={p.columns} editor={editor} target={target} onInlineEdit={onInlineEdit}/></section>;
  if(block.type==='image')return <section {...common}><figure className={styles.imageBlock}><SmartLink href={p.linkHref} editor={editor}><div style={{aspectRatio:p.ratio||'16 / 9',backgroundImage:p.url?`url(${safeImage(p.url)})`:undefined,backgroundSize:p.fit||'cover'}}>{!p.url&&<span>أضف الصورة من لوحة الخصائص</span>}</div></SmartLink>{p.caption&&<figcaption>{p.caption}</figcaption>}</figure></section>;
  if(block.type==='video')return <section {...common}><Video p={p}/></section>;
  if(block.type==='map')return <section {...common}><div className={styles.mapBlock}>{p.mapUrl?<iframe src={safeHref(p.mapUrl)} title={p.title||'الخريطة'}/>:<div><span>⌖</span><b>{p.title}</b><p>{p.address}</p></div>}</div></section>;
  if(block.type==='lottie')return <section {...common}><div className={styles.lottieBlock}><span>◌</span><b>{p.title}</b><small>{p.url?'تم ربط ملف Lottie':'أضف رابط ملف Lottie JSON'}</small></div></section>;

  if(block.type==='button')return <section {...common}><div className={styles.buttonRow}><SmartLink href={p.href} editor={editor} className={p.style==='secondary'?styles.secondaryButton:styles.primaryButton}><Edit as="span" value={p.label||'اضغط هنا'} {...edit('props.label')}/><span>{p.icon||'↗'}</span></SmartLink></div></section>;
  if(block.type==='buttons')return <section {...common}><ButtonRow p={p} editor edit={edit}/></section>;
  if(block.type==='divider')return <section {...common}><div className={styles.divider} style={{width:`${clamp(p.width,10,100,100)}%`,borderTopWidth:clamp(p.thickness,1,8,1),borderTopStyle:p.style||'solid'}}/></section>;
  if(block.type==='spacer')return <section {...common} className={`${className} ${styles.spacer}`} style={{...blockStyle(s),'--desktop-space':`${clamp(p.desktop,0,300,72)}px`,'--tablet-space':`${clamp(p.tablet,0,240,52)}px`,'--mobile-space':`${clamp(p.mobile,0,200,36)}px`}} aria-hidden="true"/>;

  if(['box','alert','callout','feature','linkBlock','icon'].includes(block.type))return <section {...common}><InfoCard type={block.type} p={p} editor={editor} edit={edit}/></section>;
  if(block.type==='code')return <section {...common}><div className={styles.codeBlock}><header><b>{p.title}</b><small>{p.language}</small></header><pre><code>{p.code}</code></pre></div></section>;
  if(block.type==='html')return <section {...common}><HtmlSandbox content={p.content} pageCss={pageCss} title={p.title||'محتوى HTML معزول'} editor={editor} target={target} onActivate={onActivate} onInlineEdit={onInlineEdit}/></section>;
  if(block.type==='copyright')return <section {...common}><p className={styles.copyright}>{String(p.text||'© {year} جميع الحقوق محفوظة.').replace('{year}',String(new Date().getFullYear()))} {p.company}</p></section>;

  if(['gallery','mosaic'].includes(block.type))return <section {...common}><div className={block.type==='mosaic'?styles.mosaicGrid:styles.galleryGrid} style={{'--columns':clamp(p.columns,2,6,3)}}>{array(p.items).map((item,index)=><figure key={index} style={{backgroundImage:item.url?`url(${safeImage(item.url)})`:undefined}}><span>{item.url?'':`صورة ${index+1}`}</span></figure>)}</div></section>;
  if(['cards','post','productCategories','products'].includes(block.type))return <section {...common}><SectionHead p={p} edit={edit}/><CardGrid items={p.items} columns={p.columns} kind={block.type} editor={editor} edit={edit}/></section>;
  if(block.type==='stats')return <section {...common}><SectionHead p={p} edit={edit}/><div className={styles.statsGrid} style={{'--columns':clamp(p.columns,2,4,4)}}>{array(p.items).map((item,index)=><article key={index}><Edit as="strong" value={item.value} {...edit(`props.items.${index}.value`)}/><Edit as="h3" value={item.title} {...edit(`props.items.${index}.title`)}/><Edit as="p" value={item.description} {...edit(`props.items.${index}.description`)}/></article>)}</div></section>;
  if(block.type==='testimonials')return <section {...common}><SectionHead p={p} edit={edit}/><div className={styles.testimonialGrid} style={{'--columns':clamp(p.columns,1,4,3)}}>{array(p.items).map((item,index)=><blockquote key={index}><span>“</span><Edit as="p" value={item.description} {...edit(`props.items.${index}.description`)}/><footer><Edit as="b" value={item.title} {...edit(`props.items.${index}.title`)}/><Edit as="small" value={item.role} {...edit(`props.items.${index}.role`)}/></footer></blockquote>)}</div></section>;
  if(['faq','accordion'].includes(block.type))return <section {...common}>{block.type==='faq'?<SectionHead p={p} edit={edit}/>:<Edit as="h3" value={p.title} {...edit('props.title')}/>}<Faq items={p.items} editor={editor} edit={edit}/></section>;
  if(block.type==='quote')return <section {...common}><blockquote className={styles.quote}><span>“</span><Edit as="p" value={p.quote} {...edit('props.quote')}/><footer><Edit as="strong" value={p.author} {...edit('props.author')}/><Edit as="small" value={p.role} {...edit('props.role')}/></footer></blockquote></section>;
  if(block.type==='timeline')return <section {...common}><SectionHead p={p} edit={edit}/><div className={styles.timeline}>{array(p.items).map((item,index)=><article key={index}><Edit as="strong" value={item.value||String(index+1).padStart(2,'0')} {...edit(`props.items.${index}.value`)}/><div><Edit as="h3" value={item.title} {...edit(`props.items.${index}.title`)}/><Edit as="p" value={item.description} {...edit(`props.items.${index}.description`)}/></div></article>)}</div></section>;

  if(block.type==='cta')return <section {...common}><div className={styles.ctaBlock}><div><Edit as="p" className={styles.eyebrow} value={p.eyebrow} {...edit('props.eyebrow')}/><Edit as="h2" value={p.title} {...edit('props.title')}/><Edit as="p" value={p.body} {...edit('props.body')}/></div><SmartLink href={p.buttonHref} editor={editor} className={styles.primaryButton}><Edit as="span" value={p.buttonLabel||'ابدأ الآن'} {...edit('props.buttonLabel')}/> <span>↗</span></SmartLink></div></section>;
  if(block.type==='contact')return <section {...common}><Contact p={p} editor={editor}/></section>;
  if(['optin','signup'].includes(block.type))return <section {...common}><MiniForm p={p} editor={editor}/></section>;
  if(block.type==='login')return <section {...common}><Login p={p} editor={editor}/></section>;

  if(['menu','serviceMenu','toc'].includes(block.type))return <section {...common}><MenuList p={p} editor={editor} edit={edit} vertical={block.type!=='menu'||p.orientation==='vertical'}/></section>;
  if(block.type==='socialShare')return <section {...common}><div className={styles.socialShare}><b>{p.title}</b>{String(p.networks||'').split(',').map(v=>v.trim()).filter(Boolean).map(v=><span key={v}>{v}</span>)}</div></section>;
  if(block.type==='slider')return <section {...common} className={`${className} ${styles.sliderBlock}`}><Slider p={p} editor={editor} edit={edit}/></section>;
  if(block.type==='table')return <section {...common}><Table p={p}/></section>;
  if(block.type==='tabs')return <section {...common}><Tabs items={p.items}/></section>;
  if(block.type==='rating')return <section {...common}><Rating p={p}/></section>;
  if(block.type==='widget'&&p.widgetKey==='imported-template'){
    const src=safeTemplateUrl(p.entryUrl);
    return <section {...common} className={`${className} ${styles.templateEmbed}`}><ImportedTemplate src={src} p={p} editor={editor}/></section>;
  }
  if(['widget','widgetArea','layoutPart'].includes(block.type))return <section {...common}><Placeholder p={p} type={block.type}/></section>;

  return <section {...common}><Placeholder p={p} type={block.type}/></section>;
}

function HtmlSandbox({content,pageCss,title,editor,target,onActivate,onInlineEdit}){
  const frameRef=useRef(null);
  const callbacksRef=useRef({onActivate,onInlineEdit,target});
  const [height,setHeight]=useState(420);
  const srcDoc=useMemo(()=>safeHtmlDocument(content,pageCss,editor),[content,pageCss,editor]);

  useEffect(()=>{
    callbacksRef.current={onActivate,onInlineEdit,target};
  },[onActivate,onInlineEdit,target]);

  useEffect(()=>{
    const frame=frameRef.current;
    if(!frame)return undefined;
    let releaseDocument=()=>{};

    function wireDocument(){
      releaseDocument();
      const doc=frame.contentDocument;
      if(!doc?.body)return;
      const body=doc.body;
      let dirty=false;
      let animationFrame=0;
      const editable=[];
      const cleanups=[];

      const measure=()=>{
        if(animationFrame)window.cancelAnimationFrame(animationFrame);
        animationFrame=window.requestAnimationFrame(()=>{
          animationFrame=0;
          const next=Math.ceil(Math.max(body.scrollHeight,doc.documentElement?.scrollHeight||0,120));
          setHeight(clamp(next,120,6000,420));
        });
      };
      const activate=()=>callbacksRef.current.onActivate?.(callbacksRef.current.target);
      const save=()=>{
        if(!dirty)return;
        dirty=false;
        const next=serializeEditableBody(body);
        if(next!==String(content||''))callbacksRef.current.onInlineEdit?.(callbacksRef.current.target,'props.content',next);
      };
      const preventNavigation=event=>{
        if(event.target?.closest?.('a,button,input,select,textarea'))event.preventDefault();
      };
      const preventSubmit=event=>event.preventDefault();

      if(editor){
        const selector='h1,h2,h3,h4,h5,h6,p,li,a,button,small,label,figcaption,blockquote,dt,dd,th,td';
        for(const element of body.querySelectorAll(selector)){
          if(!element.textContent?.trim()||element.closest('[data-marktone-no-edit]'))continue;
          if(element.parentElement?.closest(selector))continue;
          element.setAttribute('contenteditable','true');
          element.setAttribute('data-marktone-editable','true');
          element.setAttribute('spellcheck','true');
          editable.push(element);
        }
        const input=()=>{dirty=true;measure();};
        const keydown=event=>{
          if(event.key==='Escape'){event.preventDefault();event.target?.blur?.();return}
          if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();event.target?.blur?.();}
        };
        const paste=event=>{
          if(!event.target?.closest?.('[data-marktone-editable]'))return;
          event.preventDefault();
          doc.execCommand('insertText',false,event.clipboardData?.getData('text/plain')||'');
        };
        doc.addEventListener('pointerdown',activate,true);
        doc.addEventListener('click',preventNavigation,true);
        doc.addEventListener('submit',preventSubmit,true);
        doc.addEventListener('input',input,true);
        doc.addEventListener('focusout',save,true);
        doc.addEventListener('keydown',keydown,true);
        doc.addEventListener('paste',paste,true);
        cleanups.push(()=>{
          doc.removeEventListener('pointerdown',activate,true);
          doc.removeEventListener('click',preventNavigation,true);
          doc.removeEventListener('submit',preventSubmit,true);
          doc.removeEventListener('input',input,true);
          doc.removeEventListener('focusout',save,true);
          doc.removeEventListener('keydown',keydown,true);
          doc.removeEventListener('paste',paste,true);
        });
      }

      const resizeObserver=typeof ResizeObserver==='function'?new ResizeObserver(measure):null;
      resizeObserver?.observe(body);
      const mutationObserver=new MutationObserver(measure);
      mutationObserver.observe(body,{subtree:true,childList:true,characterData:true,attributes:true});
      for(const asset of doc.querySelectorAll('img,video')){
        asset.addEventListener('load',measure);
        cleanups.push(()=>asset.removeEventListener('load',measure));
      }
      measure();
      releaseDocument=()=>{
        save();
        if(animationFrame)window.cancelAnimationFrame(animationFrame);
        resizeObserver?.disconnect();mutationObserver.disconnect();
        for(const element of editable){element.removeAttribute('contenteditable');element.removeAttribute('data-marktone-editable');element.removeAttribute('spellcheck');}
        cleanups.forEach(cleanup=>cleanup());
      };
    }

    frame.addEventListener('load',wireDocument);
    if(frame.contentDocument?.readyState==='complete')window.setTimeout(wireDocument,0);
    return()=>{frame.removeEventListener('load',wireDocument);releaseDocument();};
  },[content,editor,srcDoc]);

  return <div className={styles.htmlSandboxWrap}>
    <iframe ref={frameRef} className={`${styles.htmlSandbox} ${editor?styles.htmlSandboxEditor:''}`} sandbox="allow-same-origin" srcDoc={srcDoc} title={title} loading="lazy" referrerPolicy="no-referrer" style={{height:`${height}px`}}/>
    {editor&&<span className={styles.htmlEditHint}>انقر على النص واكتب مباشرة</span>}
  </div>;
}

function serializeEditableBody(body){
  const clone=body.cloneNode(true);
  for(const element of clone.querySelectorAll('[data-marktone-editable]')){
    element.removeAttribute('contenteditable');
    element.removeAttribute('data-marktone-editable');
    element.removeAttribute('spellcheck');
  }
  return clone.innerHTML;
}

function ImportedTemplate({src,p,editor}){
  const frameRef=useRef(null);
  const [height,setHeight]=useState(()=>clamp(p.height,320,6000,720));
  useEffect(()=>setHeight(clamp(p.height,320,6000,720)),[p.height,src]);
  useEffect(()=>{
    const receive=event=>{
      if(event.source!==frameRef.current?.contentWindow||event.data?.type!=='marktone:template-height')return;
      const next=Number(event.data.height);
      if(Number.isFinite(next))setHeight(clamp(Math.ceil(next),320,6000,720));
    };
    window.addEventListener('message',receive);
    return()=>window.removeEventListener('message',receive);
  },[]);
  return <div style={{height:`${height}px`}}>{src?<iframe ref={frameRef} src={src} title={p.title||'قالب مستورد'} sandbox="allow-scripts" allow="autoplay; fullscreen; picture-in-picture" allowFullScreen loading="lazy" referrerPolicy="no-referrer" tabIndex={editor?-1:0} style={editor?{pointerEvents:'none'}:undefined}/>:<Placeholder p={{title:'رابط القالب غير صالح',body:'أعد استيراد ملف ZIP من شريط أدوات المصمم.'}} type="widget"/>}{editor&&<span>قالب ZIP معزول · الارتفاع يتكيف تلقائيًا</span>}</div>;
}

function Visual({image,alt}){return <div className={styles.heroVisual} style={image?{backgroundImage:`url(${safeImage(image)})`}:undefined} role={image?'img':undefined} aria-label={alt||undefined}>{!image&&<><i/><i/><i/><strong>Marktone</strong><small>Live Builder</small></>}</div>}
function ButtonRow({p,editor,edit}){return <div className={styles.buttonRow}>{p.primaryLabel&&<SmartLink href={p.primaryHref} editor={editor} className={styles.primaryButton}><Edit as="span" value={p.primaryLabel} {...edit('props.primaryLabel')}/><span>↗</span></SmartLink>}{p.secondaryLabel&&<SmartLink href={p.secondaryHref} editor={editor} className={styles.secondaryButton}><Edit as="span" value={p.secondaryLabel} {...edit('props.secondaryLabel')}/><span>↗</span></SmartLink>}</div>}
function SectionHead({p,edit}){return <div className={styles.sectionHeading}><Edit as="p" className={styles.eyebrow} value={p.eyebrow} {...edit('props.eyebrow')}/><Edit as="h2" value={p.title} {...edit('props.title')}/><Edit as="p" value={p.body} {...edit('props.body')}/></div>}
function InfoCard({type,p,editor,edit}){
  const content=<><span className={styles.infoIcon} style={type==='icon'?{fontSize:clamp(p.size,18,100,42)}:undefined}>{p.icon||'✦'}</span><div>{p.eyebrow&&<Edit as="small" value={p.eyebrow} {...edit('props.eyebrow')}/>}<Edit as="h3" value={p.title} {...edit('props.title')}/><Edit as="p" value={p.body} {...edit('props.body')}/>{p.linkLabel&&<b>{p.linkLabel} ↗</b>}</div></>;
  if(type==='linkBlock')return <SmartLink href={p.href} editor={editor} className={styles.infoLink}>{content}</SmartLink>;
  return <div className={`${styles.boxBlock} ${type==='alert'?styles[`alert_${p.tone||'info'}`]||'':''}`}>{content}</div>;
}
function CardGrid({items,columns,kind,editor,edit}){return <div className={styles.cardGrid} style={{'--columns':clamp(columns,1,6,3)}}>{array(items).map((item,index)=><article className={styles.card} key={index}><span>{kind==='products'?'🛍':kind==='productCategories'?'▦':ICONS[index%ICONS.length]}</span><small>{String(index+1).padStart(2,'0')}</small><Edit as="h3" value={item.title} {...edit(`props.items.${index}.title`)}/><Edit as="p" value={item.description} {...edit(`props.items.${index}.description`)}/>{item.value&&<Edit as="strong" value={item.value} {...edit(`props.items.${index}.value`)}/>} {item.href&&<SmartLink href={item.href} editor={editor}>اعرف المزيد ↗</SmartLink>}</article>)}</div>}
function Faq({items,editor,edit}){return <div className={styles.faqList}>{array(items).map((item,index)=><details key={index} open={editor&&index===0}><summary><Edit as="span" value={item.title} {...edit(`props.items.${index}.title`)}/><span>+</span></summary><Edit as="p" value={item.description} {...edit(`props.items.${index}.description`)}/></details>)}</div>}
function MenuList({p,editor,edit,vertical}){return <nav className={`${styles.menuBlock} ${vertical?styles.verticalMenu:''}`}><Edit as="b" value={p.title} {...edit('props.title')}/><div>{array(p.items).map((item,index)=><SmartLink key={index} href={item.href} editor={editor}><Edit as="span" value={item.title} {...edit(`props.items.${index}.title`)}/></SmartLink>)}</div></nav>}
function MiniForm({p,editor}){return <div className={styles.optinBlock}><div><p className={styles.eyebrow}>{p.eyebrow}</p><h3>{p.title}</h3><p>{p.body}</p></div><form onSubmit={e=>e.preventDefault()}><input disabled={editor} placeholder="الاسم"/><input disabled={editor} type="email" placeholder="البريد الإلكتروني"/><button disabled={editor}>{p.buttonLabel||'إرسال'}</button></form></div>}
function Login({p,editor}){return <div className={styles.loginBlock}><h3>{p.title}</h3><p>{p.body}</p><input disabled={editor} placeholder="البريد الإلكتروني"/><input disabled={editor} type="password" placeholder="كلمة المرور"/><button disabled={editor}>{p.buttonLabel||'دخول'}</button><small>{p.forgotLabel}</small></div>}
function Slider({p,editor,edit}){const item=array(p.items)[0]||{};return <div className={styles.slide} style={{minHeight:clamp(p.height,240,800,480),backgroundImage:item.imageUrl?`linear-gradient(135deg,rgba(4,20,38,.88),rgba(4,20,38,.25)),url(${safeImage(item.imageUrl)})`:undefined}}><div><small>01 / {Math.max(1,array(p.items).length)}</small><Edit as="h2" value={item.title} {...edit('props.items.0.title')}/><Edit as="p" value={item.description} {...edit('props.items.0.description')}/><SmartLink href={item.buttonHref} editor={editor} className={styles.primaryButton}><Edit as="span" value={item.buttonLabel||'اعرف المزيد'} {...edit('props.items.0.buttonLabel')}/> ↗</SmartLink></div></div>}
function Table({p}){return <div className={styles.tableWrap}><h3>{p.title}</h3><table><tbody>{array(p.rows).map((row,index)=><tr key={index}>{array(row).map((cell,i)=>index===0?<th key={i}>{cell}</th>:<td key={i}>{cell}</td>)}</tr>)}</tbody></table></div>}
function Tabs({items}){const rows=array(items);return <div className={styles.tabsBlock}><div>{rows.map((item,index)=><button type="button" key={index} className={index===0?styles.activeTab:''}>{item.title}</button>)}</div>{rows[0]&&<article><h3>{rows[0].title}</h3><p>{rows[0].description}</p></article>}</div>}
function Rating({p}){return <div className={styles.ratingBlock}><div>{Array.from({length:clamp(p.outOf,1,10,5)},(_,i)=><span key={i} className={i<clamp(p.value,0,10,5)?styles.starActive:''}>★</span>)}</div><b>{p.title}</b><small>{p.value}/{p.outOf} · {p.count} تقييم</small></div>}
function Placeholder({p,type}){return <div className={styles.placeholderBlock}><span>▧</span><b>{p.title||blockLabel(type)}</b><p>{p.body||'اربط هذا الموديول بمصدره من لوحة الخصائص.'}</p><code>{p.widgetKey||p.areaKey||p.partKey||type}</code></div>}
function Video({p}){const embed=videoEmbed(p.url);return <figure className={styles.videoBlock} style={{aspectRatio:p.ratio||'16 / 9'}}>{embed?<iframe src={embed} title={p.title||'فيديو'} allowFullScreen/>:p.url?<video src={safeHref(p.url)} controls poster={safeImage(p.poster)}/>:<div><span>▶</span><b>أضف رابط الفيديو</b></div>}</figure>}

function Contact({p,editor}){const [state,setState]=useState({status:'idle',message:''});async function submit(e){e.preventDefault();if(editor)return;const form=e.currentTarget;setState({status:'loading',message:''});try{const payload=Object.fromEntries(new FormData(form));const response=await fetch('/api/public/contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,consent:Boolean(payload.consent),sourcePage:window.location.pathname})});const result=await response.json();if(!response.ok)throw new Error(result?.error||'تعذر الإرسال');form.reset();setState({status:'success',message:result.message||'تم إرسال الطلب'});}catch(error){setState({status:'error',message:error.message});}}return <div className={styles.contactBlock}><div><p className={styles.eyebrow}>{p.eyebrow}</p><h2>{p.title}</h2><p>{p.body}</p></div><form onSubmit={submit}><div><label><span>الاسم *</span><input name="name" required disabled={editor}/></label><label><span>اسم المنشأة</span><input name="organization" disabled={editor}/></label></div><div><label><span>الجوال</span><input name="phone" disabled={editor}/></label><label><span>البريد الإلكتروني</span><input name="email" type="email" disabled={editor}/></label></div><label><span>رسالتك *</span><textarea name="message" rows={4} required disabled={editor}/></label><button disabled={editor||state.status==='loading'}>{state.status==='loading'?'جارٍ الإرسال…':p.buttonLabel||'إرسال الطلب'}</button>{state.message&&<p className={state.status==='success'?styles.formSuccess:styles.formError}>{state.message}</p>}</form></div>}

function Edit({as:Tag='span',value='',editor,target,path,onInlineEdit,className=''}){if(!value&&!editor)return null;const placeholder='انقر للكتابة';return <Tag className={`${className} ${editor?styles.inlineEditable:''}`} contentEditable={editor} suppressContentEditableWarning onBlur={e=>{let next=e.currentTarget.innerText.trim();if(!value&&next===placeholder)next='';if(next!==String(value||''))onInlineEdit?.(target,path,next);}}>{value||placeholder}</Tag>}
function EditableTextBlock({value='',columns=1,editor,target,onInlineEdit}){const placeholder='انقر للكتابة';if(editor)return <div className={`${styles.textBlock} ${styles.inlineEditable}`} style={{columnCount:clamp(columns,1,3,1)}} contentEditable suppressContentEditableWarning onBlur={e=>{let next=e.currentTarget.innerText.trim();if(!value&&next===placeholder)next='';if(next!==String(value||''))onInlineEdit?.(target,'props.content',next);}}>{value||placeholder}</div>;return <div className={styles.textBlock} style={{columnCount:clamp(columns,1,3,1)}}>{String(value||'').split(/\n{2,}/).filter(Boolean).map((text,index)=><p key={index}>{text}</p>)}</div>}
function SmartLink({href,children,className='',editor=false}){const target=safeHref(href);if(editor||!target)return <span className={className}>{children}</span>;if(target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:')||/^https?:\/\//i.test(target))return <a href={target} className={className} rel={/^https?:\/\//i.test(target)?'noreferrer':undefined}>{children}</a>;return <Link href={target} className={className}>{children}</Link>}

export function blockStyle(s={}){return {'--block-padding':`${clamp(s.paddingY,0,180,48)}px`,'--block-background':s.background||'transparent','--block-color':s.color||'inherit','--block-border':s.borderColor||'transparent','--block-border-width':`${clamp(s.borderWidth,0,12,0)}px`,'--block-radius':`${clamp(s.borderRadius,0,80,0)}px`,'--block-shadow':shadow(s.shadow),'--animation-delay':`${clamp(s.animationDelay,0,5000,0)}ms`}}
export function blockLabel(type){return ({hero:'واجهة رئيسية',heading:'عنوان',fancyHeading:'عنوان مميز',text:'نص',box:'صندوق',alert:'تنبيه',accordion:'أكورديون',code:'كود',callout:'ملاحظة',button:'زر',buttons:'أزرار',divider:'فاصل',spacer:'مسافة',copyright:'حقوق النشر',icon:'أيقونة',image:'صورة',gallery:'معرض صور',mosaic:'موزاييك',feature:'ميزة',linkBlock:'بلوك رابط',layoutPart:'جزء محفوظ',map:'خريطة',lottie:'Lottie',login:'تسجيل دخول',overlay:'محتوى فوق صورة',optin:'اشتراك',menu:'قائمة',serviceMenu:'قائمة خدمات',post:'مقالات',html:'HTML',socialShare:'مشاركة',slider:'سلايدر',signup:'تسجيل',table:'جدول',tabs:'تبويبات',rating:'تقييم',toc:'جدول محتويات',testimonials:'آراء العملاء',widgetArea:'منطقة ودجت',widget:'ودجت',video:'فيديو',cards:'بطاقات',stats:'إحصائيات',columns:'أعمدة',quote:'اقتباس',faq:'أسئلة شائعة',cta:'دعوة لاتخاذ إجراء',contact:'نموذج تواصل',productCategories:'تصنيفات المنتجات',timeline:'خط زمني',products:'منتجات'})[type]||type}
export function hiddenFor(responsive,device){return Boolean(device==='desktop'&&responsive?.hideDesktop||device==='tablet'&&responsive?.hideTablet||device==='mobile'&&responsive?.hideMobile)}
export function safeCss(value){return String(value||'').replace(/<\/style/gi,'').replace(/@import/gi,'').slice(0,30000)}
function array(value){return Array.isArray(value)?value:[]}
function clamp(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.min(Math.max(n,min),max):fallback}
function safeClass(value){return String(value||'').replace(/[^a-zA-Z0-9_\- ]/g,'').slice(0,160)}
function safeHref(value){const href=String(value||'').trim();return !href||/^(javascript|data|vbscript):/i.test(href)?'':href}
function safeImage(value){return safeHref(value).replace(/["'()]/g,encodeURIComponent)}
function safeHtmlDocument(value,pageCss='',editor=false){const policy="default-src 'none'; img-src https: data: blob:; media-src https: data: blob:; font-src https: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";const editing=editor?'[data-marktone-editable]{cursor:text;border-radius:4px;outline:1px dashed transparent}[data-marktone-editable]:hover{outline-color:#f36b21}[data-marktone-editable]:focus{outline:2px solid #f36b21;outline-offset:3px;background:rgba(255,247,239,.14)}':'';return `<!doctype html><html dir=\"rtl\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta http-equiv=\"Content-Security-Policy\" content=\"${policy}\"><style>html,body{margin:0;min-height:0;background:transparent;font-family:Tahoma,\"Segoe UI\",Arial,sans-serif}*,*:before,*:after{box-sizing:border-box}img,video{max-width:100%}${editing}\n${safeCss(pageCss)}</style></head><body>${String(value||'')}</body></html>`}
function safeTemplateUrl(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&/\/storage\/v1\/object\/public\/cms-template-assets\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/r1\/index\.html$/i.test(url.pathname)?url.href:''}catch{return ''}}
function shadow(value){return ({none:'none',soft:'0 12px 35px rgba(10,31,53,.09)',medium:'0 20px 55px rgba(10,31,53,.14)',strong:'0 28px 80px rgba(10,31,53,.22)'})[value]||'none'}
function videoEmbed(value){const url=safeHref(value);const yt=url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);if(yt)return `https://www.youtube.com/embed/${yt[1]}`;const vm=url.match(/vimeo\.com\/(\d+)/i);return vm?`https://player.vimeo.com/video/${vm[1]}`:''}
