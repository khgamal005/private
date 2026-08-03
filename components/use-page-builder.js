'use client';

import {useEffect,useMemo,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  blockCatalogGroups,
  createBuilderBlock,
  createBuilderDocument,
  normalizeBuilderDocument
} from '../lib/website-builder';

export function usePageBuilder(initialData){
  const router=useRouter();
  const entity=initialData?.entity||initialData?.page||{};
  const context=initialData?.context||{};
  const initialDocument=useMemo(()=>normalizeBuilderDocument(
    initialData?.document?.draftDocument
      ||entity?.content
      ||createBuilderDocument(entity.type==='article'?'service':'blank')
  ),[initialData,entity]);
  const [document,setDocument]=useState(initialDocument);
  const [selectedId,setSelectedId]=useState(initialDocument.blocks[0]?.id||'');
  const [device,setDevice]=useState('desktop');
  const [history,setHistory]=useState({past:[],future:[]});
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState(null);
  const [versions,setVersions]=useState(initialData?.versions||[]);
  const [showVersions,setShowVersions]=useState(false);
  const [templateKey,setTemplateKey]=useState(entity.type==='article'?'service':'landing');
  const groups=useMemo(()=>blockCatalogGroups(),[]);
  const selected=document.blocks.find(block=>block.id===selectedId)||null;

  useEffect(()=>{
    function beforeUnload(event){if(!dirty)return;event.preventDefault();event.returnValue='';}
    function shortcuts(event){
      const command=event.ctrlKey||event.metaKey;
      if(command&&event.key.toLowerCase()==='s'){event.preventDefault();saveDraft();}
      if(command&&event.key.toLowerCase()==='z'){event.preventDefault();event.shiftKey?redo():undo();}
    }
    window.addEventListener('beforeunload',beforeUnload);
    window.addEventListener('keydown',shortcuts);
    return ()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('keydown',shortcuts);};
  });

  function commit(next,{selectId=selectedId}={}){
    const normalized=normalizeBuilderDocument(next);
    setHistory(current=>({past:[...current.past.slice(-39),document],future:[]}));
    setDocument(normalized);
    setSelectedId(selectId&&normalized.blocks.some(block=>block.id===selectId)?selectId:normalized.blocks[0]?.id||'');
    setDirty(true);setNotice(null);
  }
  function undo(){const previous=history.past.at(-1);if(!previous)return;setHistory(current=>({past:current.past.slice(0,-1),future:[document,...current.future].slice(0,40)}));setDocument(previous);setSelectedId(previous.blocks[0]?.id||'');setDirty(true);}
  function redo(){const next=history.future[0];if(!next)return;setHistory(current=>({past:[...current.past,document].slice(-40),future:current.future.slice(1)}));setDocument(next);setSelectedId(next.blocks[0]?.id||'');setDirty(true);}
  function addBlock(type,index=document.blocks.length){const block=createBuilderBlock(type);const blocks=[...document.blocks];blocks.splice(index,0,block);commit({...document,blocks},{selectId:block.id});}
  function duplicateBlock(id){const index=document.blocks.findIndex(block=>block.id===id);if(index<0)return;const source=document.blocks[index];const block=createBuilderBlock(source.type,{props:source.props,style:source.style,responsive:source.responsive});const blocks=[...document.blocks];blocks.splice(index+1,0,block);commit({...document,blocks},{selectId:block.id});}
  function deleteBlock(id){const index=document.blocks.findIndex(block=>block.id===id);if(index<0)return;const blocks=document.blocks.filter(block=>block.id!==id);commit({...document,blocks},{selectId:blocks[Math.min(index,blocks.length-1)]?.id||''});}
  function reorderBlock(id,index){const currentIndex=document.blocks.findIndex(block=>block.id===id);if(currentIndex<0)return;const blocks=[...document.blocks];const [block]=blocks.splice(currentIndex,1);const target=currentIndex<index?index-1:index;blocks.splice(Math.max(0,Math.min(target,blocks.length)),0,block);commit({...document,blocks},{selectId:id});}
  function handleDragStart(event,id){event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-marktone-existing-block',id);}
  function handleDrop(index,event){const type=event.dataTransfer.getData('application/x-marktone-new-block');const id=event.dataTransfer.getData('application/x-marktone-existing-block');if(type)return addBlock(type,index);if(id)return reorderBlock(id,index);}
  function updateSelected(path,value){if(!selected)return;const [group,key]=path.split('.');const blocks=document.blocks.map(block=>block.id===selected.id?{...block,[group]:{...(block[group]||{}),[key]:value}}:block);commit({...document,blocks},{selectId:selected.id});}
  function updatePageSetting(key,value){commit({...document,settings:{...document.settings,[key]:value}},{selectId:selectedId});}

  async function request(action,payload={}){
    setBusy(action);setNotice(null);
    try{
      const response=await fetch(`/api/cms/builder/${action}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          siteKey:context.siteKey||'marktone-main',tenantSlug:context.tenantSlug||null,
          entityType:entity.type||'page',entityId:entity.id,...payload
        })
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result?.error||'تعذر تنفيذ العملية');
      if(result.data?.versions)setVersions(result.data.versions);
      if(result.data?.draftDocument)setDocument(normalizeBuilderDocument(result.data.draftDocument));
      return result.data||{};
    }catch(error){setNotice({type:'error',text:error instanceof Error?error.message:String(error)});throw error;}
    finally{setBusy('');}
  }
  async function saveDraft(){if(busy)return;try{await request('save-draft',{document});setDirty(false);setNotice({type:'success',text:'تم حفظ المسودة دون تغيير النسخة المنشورة.'});}catch{}}
  async function publish(){if(busy)return;if(!window.confirm('سيتم استبدال النسخة المنشورة بهذه المسودة. هل تريد النشر؟'))return;try{await request('publish',{document});setDirty(false);setNotice({type:'success',text:'تم نشر المحتوى بنجاح.'});router.refresh();}catch{}}
  async function restore(versionId){if(!window.confirm('سيتم استعادة هذا الإصدار داخل المسودة الحالية فقط.'))return;try{const data=await request('restore-version',{versionId});const restored=normalizeBuilderDocument(data.draftDocument);setHistory(current=>({past:[...current.past,document].slice(-40),future:[]}));setDocument(restored);setSelectedId(restored.blocks[0]?.id||'');setDirty(true);setNotice({type:'success',text:'تمت استعادة الإصدار إلى المسودة. اضغط نشر لتحديث الموقع.'});}catch{}}
  function applyTemplate(){if(document.blocks.length&&!window.confirm('سيستبدل القالب محتوى المسودة الحالي.'))return;const next=createBuilderDocument(templateKey);commit(next,{selectId:next.blocks[0]?.id||''});}

  return {
    page:entity,entity,context,document,selected,selectedId,setSelectedId,
    device,setDevice,history,dirty,busy,notice,setNotice,versions,showVersions,setShowVersions,
    templateKey,setTemplateKey,groups,undo,redo,addBlock,duplicateBlock,deleteBlock,
    handleDragStart,handleDrop,updateSelected,updatePageSetting,saveDraft,publish,restore,applyTemplate
  };
}
