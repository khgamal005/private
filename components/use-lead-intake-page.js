'use client';

import {useEffect,useRef,useState} from 'react';
import {validLeadIntakePage} from '../lib/lead-intake-page-contract.mjs';

const EMPTY=[];

export default function useLeadIntakePage(criteria,refreshToken){
  const criteriaKey=JSON.stringify(criteria);
  const enabled=Boolean(criteria.section);
  const [navigation,setNavigation]=useState(null);
  const [result,setResult]=useState(null);
  const [retry,setRetry]=useState(0);
  const sequence=useRef(0);
  const nav=navigation?.criteriaKey===criteriaKey
    &&navigation.refreshToken===refreshToken?navigation:null;
  const pageIndex=nav?.index||0;
  const cursor=nav?.cursors[pageIndex]||null;
  const anchor=nav?.anchor||null;
  const requestKey=JSON.stringify([criteriaKey,pageIndex,cursor,anchor,retry]);
  const current=result?.key===requestKey&&result.refreshToken===refreshToken
    ?result:null;
  const cursorKey=JSON.stringify(cursor);

  useEffect(()=>{
    const requestId=++sequence.current;
    if(!enabled)return undefined;
    const controller=new AbortController();
    const timer=setTimeout(async()=>{
      setResult({key:requestKey,refreshToken,loading:true});
      try{
        const response=await fetch('/api/tenant/lead-intake-page',{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({...JSON.parse(criteriaKey),anchor,
            cursor:JSON.parse(cursorKey)}),
          cache:'no-store',signal:controller.signal
        });
        const body=await response.json();
        if(!response.ok)throw new Error(body.error||'تعذر تحميل السجل.');
        if(!validLeadIntakePage(body.data,JSON.parse(criteriaKey).section)){
          throw new Error('تعذر التحقق من نتائج السجل.');
        }
        if(!controller.signal.aborted&&sequence.current===requestId){
          setResult({key:requestKey,refreshToken,data:body.data,loading:false});
        }
      }catch(error){
        if(!controller.signal.aborted&&sequence.current===requestId){
          setResult({key:requestKey,refreshToken,loading:false,
            error:error.message||'تعذر تحميل السجل.'});
        }
      }
    },JSON.parse(criteriaKey).query?250:0);
    return ()=>{clearTimeout(timer);controller.abort()};
  },[enabled,criteriaKey,cursorKey,anchor,requestKey,refreshToken]);

  const loading=enabled&&(!current||current.loading);
  const data=current?.data;
  const records=data?.records||EMPTY;
  const total=data?.total??nav?.total??null;
  function move(direction){
    if(loading||!data)return;
    const nextIndex=pageIndex+direction;
    if(nextIndex<0||(direction>0&&!data.hasMore))return;
    const cursors=[...(nav?.cursors||[null])];
    if(direction>0)cursors[nextIndex]=data.nextCursor;
    setNavigation({criteriaKey,refreshToken,index:nextIndex,cursors,
      anchor:data.anchor,total});
  }
  return {enabled,records,total,pageIndex,loading,error:current?.error||'',
    hasMore:Boolean(data?.hasMore),previous:()=>move(-1),next:()=>move(1),
    retry:()=>setRetry(value=>value+1),
    selectionKey:requestKey,
    refreshToken};
}
