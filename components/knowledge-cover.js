'use client';
import {useState} from 'react';
import styles from './knowledge-cover.module.css';
export function safeMediaUrl(value){
 if(String(value||'').startsWith('/')&&!String(value).startsWith('//'))return value;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!u.hostname.includes('.')||u.hostname.includes(':')||/^\d[\d.]+$/.test(u.hostname)||/\.(local|internal)$/.test(u.hostname))return '';return u.toString();}catch{return '';}
}
export default function KnowledgeCover({post,priority=false}){
 const cover=safeMediaUrl(post.cover_image_url);
 const base=safeMediaUrl(post.source_base_url||post.source_url);
 const host=base?new URL(base).hostname.replace(/^www\./,''):'';
 const bundledLogo=({'nelc.gov.sa':'/integrations/nelc-color.svg','tvtc.gov.sa':'/integrations/tvtc-color.svg'})[host];
 const logo=safeMediaUrl(post.source_logo_url)||bundledLogo||(base?new URL('/favicon.ico',base).toString():'');
 const [failed,setFailed]=useState([]);
 const image=cover&&!failed.includes(cover)?cover:logo&&!failed.includes(logo)?logo:'';
 const isLogo=image!==cover||!cover;
 return <div className={`${styles.cover} ${isLogo?styles.brand:''}`}>
  {image?<img key={image} src={image} alt={isLogo?`شعار ${post.source_name||'المصدر'}`:''} loading={priority?'eager':'lazy'} decoding="async" referrerPolicy="no-referrer" onError={()=>setFailed(items=>[...items,image])}/>:<span className={styles.monogram} aria-hidden="true">{(post.source_name||'م').slice(0,2)}</span>}
  {isLogo&&<div className={styles.name}><small>من المصدر</small><b>{post.source_name||'أخبار ومعارف'}</b></div>}
 </div>;
}
