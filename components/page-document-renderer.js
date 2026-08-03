'use client';

import Link from 'next/link';
import {useState} from 'react';
import {normalizeBuilderDocument} from '../lib/website-builder';
import styles from './page-document-renderer.module.css';

const ICONS=['âœ¦','â†—','â—','â—‡','â—Œ','âŒ','â–¦','â†³'];

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
            <span className={styles.dragHandle} title="Ø§Ø³Ø­Ø¨ Ù„Ø¥Ø¹Ø§Ø¯Ø© Ø§Ù„ØªØ±ØªÙŠØ¨">â‹®â‹®</span>
            <b>{blockLabel(block.type)}</b>
            {hidden&&<small>Ù…Ø®ÙÙŠ Ø¹Ù„Ù‰ Ù‡Ø°Ø§ Ø§Ù„Ù…Ù‚Ø§Ø³</small>}
            <button type="button" onClick={event=>{event.stopPropagation();onDuplicate?.(block.id);}}>Ù†Ø³Ø®</button>
            <button type="button" onClick={event=>{event.stopPropagation();onDelete?.(block.id);}}>Ø­Ø°Ù</button>
          </div>
          {content}
        </article>
        <DropZone index={index+1} onDropAt={onDropAt}/>
      </div>;
    })}
    {editor&&!normalized.blocks.length&&<div className={styles.emptyCanvas}>
      <strong>Ø§Ø¨Ø¯Ø£ Ø¨Ø¥Ø¶Ø§ÙØ© Ø£ÙˆÙ„ Ø¹Ù†ØµØ±</strong>
      <span>Ø§Ø³Ø­Ø¨ Ø¹Ù†ØµØ±Ù‹Ø§ Ù…Ù† Ø§Ù„Ù…ÙƒØªØ¨Ø© Ø£Ùˆ Ø§Ø¶ØºØ· Ø¹Ù„ÙŠÙ‡.</span>
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
      <h1>{props.title||'Ø¹Ù†ÙˆØ§Ù† Ø§Ù„ØµÙØ­Ø©'}</h1>
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
        <Tag>{props.title||'Ø¹Ù†ÙˆØ§Ù† Ø§Ù„Ù‚Ø³Ù…'}</Tag>
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
        {!props.url&&<span>Ø£Ø¶Ù Ø±Ø§Ø¨Ø· Ø§Ù„ØµÙˆØ±Ø© Ù…Ù† Ù„ÙˆØ­Ø© Ø§Ù„Ø®ØµØ§Ø¦Øµ</span>}
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
    <blockquote className={styles.quote}><span>â€œ</span><p>{props.quote}</p><footer><strong>{props.author}</strong><small>{props.role}</small></footer></blockquote>
  </section>;

  if(block.type==='faq')return <section {...common}>
    <SectionHeading props={props}/>
    <div className={styles.faqList}>{array(props.items).map((item,index)=><details key={`${item.title}-${index}`} open={editor&&index===0}><summary>{item.title}<span>+</span></summary><p>{item.description}</p></details>)}</div>
  </section>;

  if(block.type==='cta')return <section {...common}>
    <div className={styles.ctaBlock}><div>{props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}<h2>{props.title}</h2><p>{props.body}</p></div><SmartLink href={props.buttonHref} className={styles.primaryButton}>{props.buttonLabel||'Ø§Ø¨Ø¯Ø£ Ø§Ù„Ø¢Ù†'} <span>â†—</span></SmartLink></div>
  </section>;

  if(block.type==='contact')return <section {...common}>
    <ContactBlock props={props} editor={editor}/>
  </section>;

  if(block.type==='divider')return <section {...common}><div className={styles.divider} style={{width:`${clamp(props.width,10,100,100)}%`,borderTopWidth:clamp(props.thickness,1,8,1)}}/></section>;

  if(block.type==='spacer')return <section {...common} className={`${className} ${styles.spacer}`} style={{...inline,'--desktop-space':`${clamp(props.desktop,0,300,72)}px`,'--tablet-space':`${clamp(props.tablet,0,240,52)}px`,'--mobile-space':`${clamp(props.mobile,0,200,36)}px`}} aria-hidden="true"/>;

  return <section {...common}><div className={styles.textBlock}>Ø¹Ù†ØµØ± ØºÙŠØ± Ù…Ø¯Ø¹ÙˆÙ…</div></section>;
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
  ><span>Ø¶Ø¹ Ø§Ù„Ø¹Ù†ØµØ± Ù‡Ù†Ø§</span></div>;
}

function SectionHeading({props}){
  return <div className={styles.sectionHeading}>
    {props.eyebrow&&<p className={styles.eyebrow}>{props.eyebrow}</p>}
    {props.title&&<h2>{props.title|</h2>}
    {props.body&&<p>{props.body}</p>}
  </div>;
}

function ButtonRow({props}){
  return <div className={styles.buttonRow}>
    {props.primaryLabel&&<SmartLink href={props.primaryHref} className={styles.primaryButton}>{props.primaryLabel}<span>â†—</span></SmartLink>}
    {props.secondaryLabel&&<SmartLink href={props.secondaryHref} className={styles.secondaryButton}>{props.secondaryLabel}<span>â†—</span></SmartLink>}
  </div>;
}

function SmartLink({href,children,className=''}){
  const target=safeHref(href);
  if(!target)return <span className={className}>{children|</span>;
  if(target.startsWith('#')||target.startsWith('mailto:')||target.startsWith('tel:')||/^https?:\/\//i.test(target)){
    return <a href={target} className={className} rel={/^https?:\/\//i.test(target)?'noreferrer':undefined}>{children}</a>;
  }
  return <Link href={target} className={className}>{children|</ink>;
}

function ContactBlock({props,editor}){
  const [state,setState]=useState({status:'idle',message:''});
  async function submit(event){
    event.preventDefault();
    if(editor)\™]\›ÂˆÛÛœİ›Ü›OY]™[˜İ\œ™[\™Ù]ÂˆÛÛœİ^[ØYSØš™Xİ™œ›ÛQ[šY\Ê™]È›Ü›Q]J›Ü›JJNÂˆÙ]İ]JÜİ]\Î‰ÛØY[™ÉËY\ÜØYÙN‰ÉßJNÂˆ^ÂˆÛÛœİ™\ÜÛœÙOX]ØZ]™]Ú
	ËØ\KÜX›XËØÛÛXİ	ËÂˆY]Ù‰ÔÔÕ	ËXY\œÎÉĞÛÛ[U\IÎ‰Ø\XØ][Û‹ÚœÛÛ‰ßKˆ›ÙN’”ÓÓ‹œİš[™ÚYJË‹‹œ^[ØYÛÛœÙ[›ÛÛX[Š^[ØY˜ÛÛœÙ[
KÛİ\˜ÙTYÙNÚ[™İË›ØØ][Û‹œ]˜[Y_JBˆJNÂˆÛÛœİ™\İ[X]ØZ]™\ÜÛœÙKšœÛÛŠ
NÂˆYŠ\™\ÜÛœÙK›ÚÊ]›İÈ™]È\œ›ÜŠ™\İ[Ë™\œ›ÜŸ	ö*¶.v,6,H6)v,v,ö)öa6)öa6-öa6*	ÊNÂˆ›Ü›Kœ™\Ù]

NÂˆÙ]İ]JÜİ]\Î‰ÜİXØÙ\ÜÉËY\ÜØYÙNœ™\İ[›Y\ÜØYÙ_	ö*¶aH6)v,v,ö)öa6)öa6-öa6*	ßJNÂˆXØ]Ú
\œ›ÜŠ^ÜÙ]İ]JÜİ]\Î‰Ù\œ›Ü‰ËY\ÜØYÙN™\œ›Ü‹›Y\ÜØYÙ_JNßBˆBˆ™]\›ˆ]ˆÛ\ÜÓ˜[YO^Üİ[\Ë˜ÛÛXİ›ØÚßO‚ˆ]Û\ÜÓ˜[YO^Üİ[\Ë™^YXœ›İßOÜ›ÜË™^YXœ›İßÜÜ›ÜË]_ÚÜ›ÜË˜›Ù_OÜÛX[¶,öb¶*¶aH6+v`v.6)öa6,v,ö)ö)¶a6+ö)ö+¶a6a6b6+v*H6)v+ö)ö,v*H6avb6`¶.H6av)ö,v`ö*¶b6a‹ÜÛX[Ù]‚ˆ›Ü›HÛ”İX›Z]^ÜİX›Z]O‚ˆ]X™[Ü[¶)öa6)ö,öaH
ÜÜ[[œ]˜[YOH›˜[YHˆ™\]Z\™YZ[“[™İ^ÌŸH\ØX›Y^ÙY]ÜŸKÏÛX™[X™[Ü[¶)ö,öaH6)öa6ava¶-6(ö*OÜÜ[[œ]˜[YOH›Ü™Ø[š^˜][Ûˆˆ\ØX›Y^ÙY]ÜŸKÏÛX™[Ù]‚ˆ]X™[Ü[¶)öa6+6b6)öaÜÜ[[œ]˜[YOHœÛ™Hˆ[œ][ÙOH[ˆ\ØX›Y^ÙY]ÜŸKÏÛX™[X™[Ü[¶)öa6*6,vb¶+È6)öa6)va6`ö*¶,vb6a¶bÜÜ[[œ]˜[YOH™[XZ[ˆ\OH™[XZ[ˆ\ØX›Y^ÙY]ÜŸKÏÛX™[Ù]‚ˆX™[Ü[¶)öa6*¶+v+öbˆ6)öa6+v)öa6bˆ
ÜÜ[^\™XH˜[YOH›Y\ÜØYÙHˆ›İÜÏ^ÍH™\]Z\™YZ[“[™İ^ÌLH\ØX›Y^ÙY]ÜŸKÏÛX™[‚ˆX™[Û\ÜÓ˜[YO^Üİ[\Ë˜ÛÛœÙ[O[œ]\OH˜ÚXÚØ›Şˆ˜[YOH˜ÛÛœÙ[ˆ\ØX›Y^ÙY]ÜŸKÏÜ[¶(öb6)ö`v`ˆ6.va6bH6*¶b6)ö-va6`v,vb¶`ˆ6av)ö,v`ö*¶b6aˆ6*6+¶-vb6-H6)öa6-öa6*ÜÜ[ÛX™[‚ˆ[œ]Û\ÜÓ˜[YO^Üİ[\ËšÛ™^\İH˜[YOHÙXœÚ]HˆX’[™^^ËL_H]]ĞÛÛ\]OH›Ù™ˆ‹Ï‚ˆ]Ûˆ\ØX›Y^ÙY]ÜŸİ]Kœİ]\ÏOOIÛØY[™ÉßOÜİ]Kœİ]\ÏOOIÛØY[™ÉÏÉö+6)ö,vcH6)öa6)v,v,ö)öa8 )‰Îœ›ÜË˜]Û“X™[	ö)v,v,ö)öa6)öa6-öa6*	ßHÜ[¸¡¥ÏÜÜ[Ø]Û‚ˆÜİ]K›Y\ÜØYÙI‰Û\ÜÓ˜[YO^Üİ]Kœİ]\ÏOOIÜİXØÙ\ÜÉÏÜİ[\Ë™›Ü›TİXØÙ\ÜÎœİ[\Ë™›Ü›Q\œ›ÜŸOÜİ]K›Y\ÜØYÙ_OÜŸBˆÙ›Ü›O‚ˆÙ]ÂŸB‚™[˜İ[Ûˆ^›ØÚÜÊ˜[YJ^Âˆ™]\›ˆİš[™Ê˜[Y_	ÉÊKœÜ]
×Ì‹KÊK™š[\Š›ÛÛX[ŠK›X\

^[™^
OOÙ^O^Ø	İ^œÛXÙJŒ
_KIÚ[™^XOİ^œÜ]
	×‰ÊK›X\

[™K[™R[™^
OOÜ[ˆÙ^O^Ø	Û[™_KIÛ[™R[™^XOÛ[™_^Û[™R[™^^œÜ]
	×‰ÊK›[™İLI‰œ‹ÏŸOÜÜ[Š_OÜŠNÂŸB™[˜İ[Ûˆ\œ˜^J˜[YJ^Ü™]\›ˆ\œ˜^Kš\Ğ\œ˜^J˜[YJOİ˜[YN–×NßB™[˜İ[ÛˆÛ[\
˜[YKZ[‹X^˜[˜XÚÊ^ØÛÛœİ[X™\S[X™\Š˜[YJNÜ™]\›ˆ[X™\‹š\Ñš[š]J[X™\ŠOÓX]›Z[ŠX]›X^
[X™\‹Z[ŠKX^
N™˜[˜XÚÎßB™[˜İ[Ûˆ›ØÚÓX™[
\J^Ü™]\›ˆ
Ú\›Î‰öb6)ö+6aö*H6,v)¶b¶,öb¶*IËXY[™Î‰ö.va¶b6)öaˆ6`¶,öaIË^‰öa¶-IË[XYÙN‰ö-vb6,v*IË]ÛœÎ‰ö(ö,¶,v)ö,IËØ\™Î‰ö*6-ö)ö`¶)ö*‰Ëİ]Î‰ö)v+v-v)ö)¶b¶)ö*‰ËÛÛ[[œÎ‰ö(ö.vav+ö*IË][İN‰ö)ö`¶*¶*6)ö,ÉË˜\N‰ö(ö,ö)¶a6*H6-6)ö)¶.v*IËİN‰ö+ö.vb6*H6a6)ö*¶+¶)ö,6)v+6,v)ö(IËÛÛXİ‰öa¶avb6,6+6*¶b6)ö-va	Ë]šY\‰ö`v)ö-va	ËÜXÙ\‰öav,ö)ö`v*IßJVİ\W_\NßB™[˜İ[ÛˆØY™R™YŠ˜[YJ^ØÛÛœİ™YTİš[™Ê˜[Y_	ÉÊKš[J
NÚYŠZ™YŠ\™]\›ˆ	ÉÎÚYŠ×Š˜]˜\ØÜš\]_˜œØÜš\
N‹ÚK\İ
™YŠJ\™]\›ˆ	ÉÎÜ™]\›ˆ™YßB™[˜İ[ÛˆØY™R[XYÙJ˜[YJ^ØÛÛœİ\›Tİš[™Ê˜[Y_	ÉÊKš[J
NÚYŠ]\›×Š˜]˜\ØÜš\]N^Ú[˜œØÜš\
N‹ÚK\İ
\›
J\™]\›ˆ	ÉÎÜ™]\›ˆ\›œ™\XÙJÖÈ‰Ê
WKÙË[˜ÛÙUT’PÛÛ\Û™[
NßB