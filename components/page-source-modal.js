'use client';

import {useMemo,useState} from 'react';
import {normalizeBuilderDocument,ROW_LAYOUTS} from '../lib/website-builder';
import styles from './page-source-modal.module.css';

export default function PageSourceModal({document,page,onClose,onAddHtml}){
  const [tab,setTab]=useState('html');
  const [copied,setCopied]=useState(false);
  const html=useMemo(()=>documentToHtml(document,page),[document,page]);
  const json=useMemo(()=>JSON.stringify(normalizeBuilderDocument(document),null,2),[document]);
  const value=tab==='html'?html:json;

  async function copy(){
    try{
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(()=>setCopied(false),1600);
    }catch{
      const area=window.document.createElement('textarea');
      area.value=value;window.document.body.appendChild(area);area.select();
      window.document.execCommand('copy');area.remove();setCopied(true);
    }
  }

  function download(){
    const type=tab==='html'?'text/html':'application/json';
    const extension=tab==='html'?'html':'json';
    const blob=new Blob([value],{type:`${type};charset=utf-8`});
    const url=URL.createObjectURL(blob);const link=window.document.createElement('a');
    link.href=url;link.download=`${page?.slug||'page'}-source.${extension}`;link.click();URL.revokeObjectURL(url);
  }

  return <div className={styles.backdrop} role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose?.();}}>
    <section className={styles.modal} role="dialog" aria-modal="true" aria-label="سورس الصفحة" dir="rtl">
      <header className={styles.header}>
        <div><span>Marktone Builder Pro</span><h2>سورس الصفحة</h2><p>اعرض HTML الناتج أو بنية JSON الخاصة بالبيلدر، وانسخها أو نزّلها للاحتفاظ بنسخة.</p></div>
        <button type="button" className={styles.close} onClick={onClose} aria-label="إغلاق">×</button>
      </header>
      <div className={styles.toolbar}>
        <div className={styles.tabs}><button type="button" className={tab==='html'?styles.active:''} onClick={()=>setTab('html')}>HTML</button><button type="button" className={tab==='json'?styles.active:''} onClick={()=>setTab('json')}>Builder JSON</button></div>
        <div className={styles.actions}><button type="button" onClick={copy}>{copied?'تم النسخ ✓':'نسخ السورس'}</button><button type="button" onClick={download}>تنزيل</button><button type="button" className={styles.addHtml} onClick={()=>{onAddHtml?.();onClose?.();}}>＋ إضافة كود HTML للصفحة</button></div>
      </div>
      <div className={styles.notice}><b>ملاحظة أمان:</b> أكواد HTML المضافة تمر عبر فلترة تلقائية. لا يتم تشغيل وسوم script أو معالجات الأحداث مثل onclick داخل صفحات الموقع.</div>
      <pre className={styles.code} dir="ltr"><code>{value}</code></pre>
      <footer className={styles.footer}><span>{tab==='html'?'سورس HTML قابل للنسخ والمعاينة':'النسخة الأصلية القابلة للاستيراد إلى البيلدر'}</span><button type="button" onClick={onClose}>إغلاق</button></footer>
    </section>
  </div>;
}

export function documentToHtml(input,page={}){
  const document=normalizeBuilderDocument(input);
  const body=document.blocks.map(block=>serializeBlock(block,1)).join('\n');
  const customCss=String(document.settings?.customCss||'').trim();
  const title=escapeHtml(page?.title||'Marktone Page');
  return `<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${title}</title>${customCss?`\n  <style>\n${indent(customCss,4)}\n  </style>`:''}\n</head>\n<body>\n${body||'  <!-- الصفحة فارغة -->'}\n</body>\n</html>`;
}

function serializeBlock(block,depth){
  if(block?.type==='columns'&&block.props?.row===true)return serializeRow(block,depth);
  return serializeModule(block,depth);
}

function serializeRow(row,depth){
  const p=row.props||{};const style=styleAttribute(row.style);const pad='  '.repeat(depth);
  const layout=ROW_LAYOUTS[p.layoutKey]||ROW_LAYOUTS['1'];
  const attrs=[`class="marktone-row layout-${escapeAttr(p.layoutKey||'1')}"`,`data-columns="${layout.columns}"`,p.anchor?`id="${escapeAttr(p.anchor)}"`:'',style?`style="${style}"`:''].filter(Boolean).join(' ');
  const columns=(p.items||[]).map((column,index)=>{
    const columnStyle=styleAttribute(column.style);const modules=(column.modules||[]).map(module=>serializeModule(module,depth+2)).join('\n');
    return `${pad}  <div class="marktone-column column-${index+1}"${columnStyle?` style="${columnStyle}"`:''}>\n${modules||`${pad}    <!-- عمود فارغ -->`}\n${pad}  </div>`;
  }).join('\n');
  return `${pad}<section ${attrs}>\n${columns}\n${pad}</section>`;
}

function serializeModule(block,depth){
  const p=block?.props||{};const pad='  '.repeat(depth);const style=styleAttribute(block?.style);
  const attrs=[`class="marktone-module module-${escapeAttr(block?.type||'unknown')}"`,`data-module="${escapeAttr(block?.type||'unknown')}"`,p.anchor?`id="${escapeAttr(p.anchor)}"`:'',style?`style="${style}"`:''].filter(Boolean).join(' ');
  const content=moduleContent(block);
  return `${pad}<section ${attrs}>\n${indent(content,depth+1)}\n${pad}</section>`;
}

function moduleContent(block){
  const p=block?.props||{};
  switch(block?.type){
    case 'hero':return `${tag('p',p.eyebrow,'eyebrow')}\n${tag('h1',p.title)}\n${tag('p',p.body,'lead')}\n${link(p.primaryHref,p.primaryLabel,'button primary')}\n${link(p.secondaryHref,p.secondaryLabel,'button secondary')}`;
    case 'heading':case 'fancyHeading':return `${tag('p',p.eyebrow,'eyebrow')}\n${tag(p.level||'h2',p.title)}\n${tag('p',p.body)}`;
    case 'text':return String(p.content||'').split(/\n\s*\n/).map(value=>tag('p',value)).join('\n');
    case 'html':return `<!-- Custom HTML -->\n${String(p.content||'')}`;
    case 'image':return `<figure>${p.url?`<img src="${escapeAttr(p.url)}" alt="${escapeAttr(p.alt||'')}">`:'<!-- أضف رابط الصورة -->'}${p.caption?`<figcaption>${escapeHtml(p.caption)}</figcaption>`:''}</figure>`;
    case 'button':return link(p.href,p.label,'button');
    case 'buttons':return `${link(p.primaryHref,p.primaryLabel,'button primary')}\n${link(p.secondaryHref,p.secondaryLabel,'button secondary')}`;
    case 'divider':return '<hr>';
    case 'spacer':return '<div class="spacer" aria-hidden="true"></div>';
    case 'code':return `<pre><code class="language-${escapeAttr(p.language||'text')}">${escapeHtml(p.code||'')}</code></pre>`;
    case 'copyright':return tag('p',String(p.text||'© {year} جميع الحقوق محفوظة.').replace('{year}',String(new Date().getFullYear()))+' '+String(p.company||''),'copyright');
    case 'faq':case 'accordion':return `${tag('h2',p.title)}\n${(p.items||[]).map(item=>`<details><summary>${escapeHtml(item.title||'')}</summary><p>${escapeHtml(item.description||'')}</p></details>`).join('\n')}`;
    case 'cards':case 'post':case 'products':case 'productCategories':return `${tag('h2',p.title)}\n<div class="cards">\n${indent((p.items||[]).map(item=>`<article>${tag('h3',item.title)}${tag('p',item.description)}${item.href?link(item.href,'اعرف المزيد'):''}</article>`).join('\n'),1)}\n</div>`;
    case 'stats':return `<div class="stats">\n${indent((p.items||[]).map(item=>`<article><strong>${escapeHtml(item.value||'')}</strong>${tag('h3',item.title)}${tag('p',item.description)}</article>`).join('\n'),1)}\n</div>`;
    case 'cta':return `${tag('p',p.eyebrow,'eyebrow')}\n${tag('h2',p.title)}\n${tag('p',p.body)}\n${link(p.buttonHref,p.buttonLabel,'button primary')}`;
    default:return `${p.title?tag('h3',p.title):''}${p.body?`\n${tag('p',p.body)}`:''}${!p.title&&!p.body?'<!-- محتوى الموديول -->':''}`;
  }
}

function tag(name,value,className=''){if(!value)return '';return `<${name}${className?` class="${escapeAttr(className)}"`:''}>${escapeHtml(value)}</${name}>`;}
function link(href,label,className=''){if(!label)return '';return `<a href="${escapeAttr(href||'#')}"${className?` class="${escapeAttr(className)}"`:''}>${escapeHtml(label)}</a>`;}
function styleAttribute(style={}){const pairs=[];if(style.background)pairs.push(`background:${safeCssValue(style.background)}`);if(style.color)pairs.push(`color:${safeCssValue(style.color)}`);if(Number(style.paddingY))pairs.push(`padding-block:${Number(style.paddingY)}px`);if(Number(style.borderWidth))pairs.push(`border:${Number(style.borderWidth)}px solid ${safeCssValue(style.borderColor||'#dfe5eb')}`);if(Number(style.borderRadius))pairs.push(`border-radius:${Number(style.borderRadius)}px`);return escapeAttr(pairs.join(';'));}
function safeCssValue(value){return String(value||'').replace(/[<>"']/g,'').slice(0,120);}
function indent(value,depth){const pad='  '.repeat(depth);return String(value||'').split('\n').map(line=>`${pad}${line}`).join('\n');}
function escapeHtml(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
function escapeAttr(value){return escapeHtml(value).replace(/`/g,'&#096;');}
