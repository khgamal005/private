'use client';

import {useEffect,useMemo,useState} from 'react';
import PageBuilder from './page-builder';

const TOOLBAR_LAYOUT_FIX=`
@media (min-width:931px){
  .marktone-builder-host>div:first-child{
    grid-template-rows:64px auto minmax(0,1fr)!important;
    isolation:isolate;
  }
  .marktone-builder-host>div:first-child>header{
    box-sizing:border-box!important;
    height:64px!important;
    min-height:64px!important;
    padding:8px 10px!important;
    position:relative!important;
    z-index:40!important;
    align-self:stretch!important;
    overflow:hidden!important;
  }
  .marktone-builder-host>div:first-child>header>div{
    box-sizing:border-box!important;
    height:48px!important;
    min-height:48px!important;
    min-width:0!important;
    margin:0!important;
    padding-block:0!important;
    align-self:center!important;
    overflow:hidden;
  }
  .marktone-builder-host>div:first-child>header>div:nth-child(2){
    justify-content:flex-start!important;
    overflow-x:auto!important;
    overflow-y:hidden!important;
    scrollbar-width:none;
    overscroll-behavior-inline:contain;
  }
  .marktone-builder-host>div:first-child>header>div:nth-child(2)::-webkit-scrollbar{
    display:none;
  }
  .marktone-builder-host>div:first-child>header>div:first-child,
  .marktone-builder-host>div:first-child>header>div:last-child{
    position:relative;
    z-index:1;
  }
}
@media (min-width:931px) and (max-width:1420px){
  .marktone-builder-host>div:first-child>header{
    grid-template-columns:minmax(320px,1fr) minmax(410px,auto) minmax(340px,1fr)!important;
    gap:6px!important;
  }
}
`;

export default function PageBuilderWithLibrary({initialData}){
  const [ready,setReady]=useState(false);
  const context=initialData?.context||{};
  const savedBlocks=initialData?.savedBlocks;
  const storageKey=`marktone-builder-saved:${context.siteKey||'marktone-main'}:${context.tenantSlug||'platform'}`;
  const systemItems=useMemo(()=>{
    const rows=Array.isArray(savedBlocks)?savedBlocks:[];
    return rows
      .filter(item=>item?.block&&item?.id)
      .map(item=>({
        id:`system-${item.id}`,
        kind:'block',
        type:item.block?.type||'columns',
        name:`ماركتون · ${item.name||'بلوك محفوظ'}`,
        data:item.block,
        createdAt:item.updatedAt||item.createdAt||'2026-01-01T00:00:00.000Z',
        systemSource:'marktone-db',
        category:item.category||'عام',
        description:item.description||''
      }));
  },[savedBlocks]);

  useEffect(()=>{
    try{
      const parsed=JSON.parse(localStorage.getItem(storageKey)||'[]');
      const personal=Array.isArray(parsed)
        ?parsed.filter(item=>item?.systemSource!=='marktone-db'&&!String(item?.id||'').startsWith('system-'))
        :[];
      localStorage.setItem(storageKey,JSON.stringify([...systemItems,...personal].slice(0,60)));
    }catch{}
    setReady(true);
  },[storageKey,systemItems]);

  if(!ready)return <div dir="rtl" style={{minHeight:'100vh',display:'grid',placeItems:'center',background:'#f5f8fb',color:'#0b2949',fontFamily:'Tahoma,Arial,sans-serif'}}><div style={{textAlign:'center'}}><strong>Marktone Builder Pro</strong><p style={{margin:'8px 0 0',fontSize:12,color:'#74879a'}}>جارٍ تجهيز مكتبة البلوكات المحفوظة…</p></div></div>;
  return <div className="marktone-builder-host"><PageBuilder initialData={initialData}/><style jsx global>{TOOLBAR_LAYOUT_FIX}</style></div>;
}
