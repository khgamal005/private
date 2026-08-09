'use client';

import {useEffect,useMemo,useState} from 'react';
import PageBuilder from './page-builder';

export default function PageBuilderWithLibrary({initialData}){
  const [ready,setReady]=useState(false);
  const context=initialData?.context||{};
  const storageKey=`marktone-builder-saved:${context.siteKey||'marktone-main'}:${context.tenantSlug||'platform'}`;
  const systemItems=useMemo(()=>{
    const rows=Array.isArray(initialData?.savedBlocks)?initialData.savedBlocks:[];
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
  },[initialData?.savedBlocks]);

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
  return <PageBuilder initialData={initialData}/>;
}
