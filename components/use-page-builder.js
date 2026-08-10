'use client';

import {useEffect,useMemo,useRef,useState} from 'react';
import {useRouter} from 'next/navigation';
import {
  blockCatalogGroups,changeLayoutRow,createBuilderBlock,createBuilderDocument,
  createLayoutRow,createSectionPreset,normalizeBuilderDocument
} from '../lib/website-builder';
import {applyCmsAssistantOperations} from '../lib/cms-assistant-operations.mjs';
import {NATIVE_TEMPLATE_WIDGET_KEY,loadNativeTemplatePackage,nativeTemplatePackageId} from '../lib/cms-native-template-client';
import {useTemplateImportMode} from './template-import-mode-provider';

export function usePageBuilder(initialData){
  const router=useRouter();
  const chooseTemplateImportMode=useTemplateImportMode();
  const entity=useMemo(()=>initialData?.entity||initialData?.page||{},[initialData]);
  const context=useMemo(()=>initialData?.context||{},[initialData]);
  const initialDocument=useMemo(()=>normalizeEditorDocument(
    initialData?.document?.draftDocument||entity?.content||createBuilderDocument(entity.type==='article'?'service':'landing')
  ),[initialData,entity]);
  const [document,setDocument]=useState(initialDocument);
  const [selection,setSelection]=useState(firstSelection(initialDocument));
  const [device,setDevice]=useState('desktop');
  const [zoom,setZoom]=useState(100);
  const [previewMode,setPreviewMode]=useState(false);
  const [showOutlines,setShowOutlines]=useState(true);
  const [history,setHistory]=useState({past:[],future:[]});
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState('');
  const [notice,setNotice]=useState(null);
  const [versions,setVersions]=useState(initialData?.versions||[]);
  const [showVersions,setShowVersions]=useState(false);
  const [templateKey,setTemplateKey]=useState(entity.type==='article'?'service':'landing');
  const groups=useMemo(()=>blockCatalogGroups(),[]);
  const selected=useMemo(()=>locateSelection(document,selection),[document,selection]);
  const legacyTemplateCount=useMemo(()=>countUpgradeableLegacyTemplates(document),[document]);
  const recoveryKey=useMemo(()=>`marktone-builder-recovery:${context.siteKey||'marktone-main'}:${entity.type||'page'}:${entity.id||'unknown'}`,[context.siteKey,entity.id,entity.type]);
  const recoveryChecked=useRef(false);

  useEffect(()=>{
    if(recoveryChecked.current)return;
    recoveryChecked.current=true;
    try{
      const recovered=JSON.parse(localStorage.getItem(recoveryKey)||'null');
      const serverTime=new Date(initialData?.document?.draftUpdatedAt||0).getTime();
      if(!recovered?.document||recovered.entityId!==entity.id||Number(recovered.savedAt)<=serverTime)return;
      if(window.confirm('وجدنا نسخة محلية أحدث من المسودة المحفوظة. هل تريد استعادتها؟')){
        const next=normalizeEditorDocument(recovered.document);
        setDocument(next);setSelection(firstSelection(next));setDirty(true);
        setNotice({type:'success',text:'تمت استعادة النسخة المحلية. اضغط حفظ المسودة لتثبيتها على الخادم.'});
      }else localStorage.removeItem(recoveryKey);
    }catch{localStorage.removeItem(recoveryKey)}
  },[entity.id,initialData,recoveryKey]);

  useEffect(()=>{
    if(!dirty||!recoveryChecked.current)return;
    const timer=window.setTimeout(()=>{
      try{localStorage.setItem(recoveryKey,JSON.stringify({entityId:entity.id,savedAt:Date.now(),document}))}catch{}
    },1200);
    return()=>window.clearTimeout(timer);
  },[dirty,document,entity.id,recoveryKey]);

  useEffect(()=>{
    function beforeUnload(event){if(!dirty)return;event.preventDefault();event.returnValue='';}
    function shortcuts(event){
      const command=event.ctrlKey||event.metaKey;
      const key=event.key.toLowerCase();
      if(command&&key==='s'){event.preventDefault();saveDraft();}
      if(command&&key==='z'){event.preventDefault();event.shiftKey?redo():undo();}
      if(command&&key==='d'&&selected){event.preventDefault();duplicateSelected();}
      if((event.key==='Delete'||event.key==='Backspace')&&selected&&!isTyping(event.target)){
        event.preventDefault();deleteSelected();
      }
    }
    window.addEventListener('beforeunload',beforeUnload);
    window.addEventListener('keydown',shortcuts);
    return ()=>{window.removeEventListener('beforeunload',beforeUnload);window.removeEventListener('keydown',shortcuts);};
  });

  function commit(next,{selection:nextSelection=selection,noticeMessage=null}={}){
    const normalized=normalizeEditorDocument(next);
    setHistory(current=>({past:[...current.past.slice(-39),document],future:[]}));
    setDocument(normalized);
    setSelection(validSelection(normalized,nextSelection)?nextSelection:firstSelection(normalized));
    setDirty(true);
    setNotice(noticeMessage?{type:'success',text:noticeMessage}:null);
  }

  function undo(){
    const previous=history.past.at(-1);if(!previous)return;
    setHistory(current=>({past:current.past.slice(0,-1),future:[document,...current.future].slice(0,40)}));
    setDocument(previous);setSelection(firstSelection(previous));setDirty(true);setNotice(null);
  }
  function redo(){
    const next=history.future[0];if(!next)return;
    setHistory(current=>({past:[...current.past,document].slice(-40),future:current.future.slice(1)}));
    setDocument(next);setSelection(firstSelection(next));setDirty(true);setNotice(null);
  }

  function addRow(layoutKey='1',index=defaultTopIndex(true)){
    const row=createLayoutRow(layoutKey);
    const blocks=[...document.blocks];blocks.splice(clampIndex(index,blocks.length),0,row);
    commit({...document,blocks},{selection:{kind:'row',rowId:row.id}});
  }

  function addBlock(type,index){
    if(type==='columns')return addRow('1',index);
    const builderModule=createBuilderBlock(type);
    if(index===undefined){
      const target=currentModuleTarget();
      if(target)return insertModule(target.rowId,target.columnId,builderModule,target.index);
    }
    const row=createLayoutRow('1');row.props.items[0].modules=[builderModule];
    const blocks=[...document.blocks];
    const targetIndex=index===undefined?defaultTopIndex(true):index;
    blocks.splice(clampIndex(targetIndex,blocks.length),0,row);
    commit({...document,blocks},{selection:{kind:'module',rowId:row.id,columnId:row.props.items[0].id,moduleId:builderModule.id}});
  }

  function insertModule(rowId,columnId,moduleOrType,index){
    const builderModule=typeof moduleOrType==='string'?createBuilderBlock(moduleOrType):createBuilderBlock(moduleOrType.type,moduleOrType);
    const blocks=document.blocks.map(block=>{
      if(block.id!==rowId||block.type!=='columns'||block.props?.row!==true)return block;
      const items=block.props.items.map(column=>{
        if(column.id!==columnId)return column;
        const modules=[...(column.modules||[])];modules.splice(clampIndex(index??modules.length,modules.length),0,builderModule);
        return {...column,modules};
      });
      return {...block,props:{...block.props,items}};
    });
    commit({...document,blocks},{selection:{kind:'module',rowId,columnId,moduleId:builderModule.id}});
  }

  function insertPreset(key,index=defaultTopIndex(true)){
    const preset=createSectionPreset(key);
    const blocks=[...document.blocks];blocks.splice(clampIndex(index,blocks.length),0,...preset);
    const first=preset[0];
    commit({...document,blocks},{selection:first?.props?.row?{kind:'row',rowId:first.id}:first?{kind:'block',blockId:first.id}:selection});
  }

  function insertSaved(item,index){
    if(!item?.data)return;
    if(item.kind==='module')return addBlockDefinition(item.data,index);
    const source=createBuilderBlock(item.data.type,item.data);
    source.id=undefined;
    const copy=source.type==='columns'&&source.props?.row
      ?cloneRowWithFreshIds(source)
      :createBuilderBlock(source.type,{props:source.props,style:source.style,responsive:source.responsive});
    const blocks=[...document.blocks];
    const targetIndex=index===undefined?defaultTopIndex(true):index;
    blocks.splice(clampIndex(targetIndex,blocks.length),0,copy);
    commit({...document,blocks},{selection:copy.props?.row?{kind:'row',rowId:copy.id}:{kind:'block',blockId:copy.id}});
  }

  function addBlockDefinition(source,index){
    const builderModule=createBuilderBlock(source.type,{props:source.props,style:source.style,responsive:source.responsive});
    if(index===undefined){
      const target=currentModuleTarget();
      if(target)return insertModule(target.rowId,target.columnId,builderModule,target.index);
    }
    const row=createLayoutRow('1');row.props.items[0].modules=[builderModule];
    const blocks=[...document.blocks];
    const targetIndex=index===undefined?defaultTopIndex(true):index;
    blocks.splice(clampIndex(targetIndex,blocks.length),0,row);
    commit({...document,blocks},{selection:{kind:'module',rowId:row.id,columnId:row.props.items[0].id,moduleId:builderModule.id}});
  }

  function duplicateBlock(id){
    const index=document.blocks.findIndex(block=>block.id===id);if(index<0)return;
    const source=document.blocks[index];
    const block=source.type==='columns'&&source.props?.row?cloneRowWithFreshIds(source):createBuilderBlock(source.type,{props:source.props,style:source.style,responsive:source.responsive});
    const blocks=[...document.blocks];blocks.splice(index+1,0,block);
    commit({...document,blocks},{selection:block.props?.row?{kind:'row',rowId:block.id}:{kind:'block',blockId:block.id}});
  }

  function deleteBlock(id){
    const index=document.blocks.findIndex(block=>block.id===id);if(index<0)return;
    const blocks=document.blocks.filter(block=>block.id!==id);
    commit({...document,blocks},{selection:firstSelection({blocks:blocks.length?blocks:[]})});
  }

  function duplicateModule(rowId,columnId,moduleId){
    const row=document.blocks.find(block=>block.id===rowId);const column=row?.props?.items?.find(item=>item.id===columnId);
    const index=column?.modules?.findIndex(item=>item.id===moduleId)??-1;if(index<0)return;
    const source=column.modules[index];const builderModule=createBuilderBlock(source.type,{props:source.props,style:source.style,responsive:source.responsive});
    const blocks=document.blocks.map(block=>block.id!==rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>{
      if(item.id!==columnId)return item;const modules=[...item.modules];modules.splice(index+1,0,builderModule);return {...item,modules};
    })}});
    commit({...document,blocks},{selection:{kind:'module',rowId,columnId,moduleId:builderModule.id}});
  }

  function deleteModule(rowId,columnId,moduleId){
    const blocks=document.blocks.map(block=>block.id!==rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>item.id!==columnId?item:{...item,modules:item.modules.filter(entry=>entry.id!==moduleId)})}});
    commit({...document,blocks},{selection:{kind:'column',rowId,columnId}});
  }

  function duplicateColumn(rowId,columnId){
    const row=document.blocks.find(block=>block.id===rowId);const sourceIndex=row?.props?.items?.findIndex(item=>item.id===columnId)??-1;if(sourceIndex<0)return;
    const source=row.props.items[sourceIndex];
    const modules=source.modules.map(item=>createBuilderBlock(item.type,{props:item.props,style:item.style,responsive:item.responsive}));
    const copy={...source,id:freshId('column'),modules};
    if(row.props.items.length>=6){
      const newRow=createLayoutRow('1');newRow.props.items[0]={...copy,id:freshId('column')};
      const blocks=[...document.blocks];const rowIndex=blocks.findIndex(block=>block.id===rowId);blocks.splice(rowIndex+1,0,newRow);
      return commit({...document,blocks},{selection:{kind:'column',rowId:newRow.id,columnId:newRow.props.items[0].id}});
    }
    const nextItems=[...row.props.items];nextItems.splice(sourceIndex+1,0,copy);
    const nextLayout=layoutForCount(nextItems.length);
    const changed=changeLayoutRow({...row,props:{...row.props,items:nextItems}},nextLayout);
    const blocks=document.blocks.map(block=>block.id===rowId?changed:block);
    commit({...document,blocks},{selection:{kind:'column',rowId,columnId:copy.id}});
  }

  function duplicateSelected(){
    if(!selected)return;
    if(selected.kind==='module')return duplicateModule(selected.row.id,selected.column.id,selected.module.id);
    if(selected.kind==='column')return duplicateColumn(selected.row.id,selected.column.id);
    return duplicateBlock(selected.block.id);
  }

  function deleteSelected(){
    if(!selected)return;
    if(selected.kind==='module')return deleteModule(selected.row.id,selected.column.id,selected.module.id);
    if(selected.kind==='column'){
      if(selected.row.props.items.length<=1)return deleteBlock(selected.row.id);
      const remaining=selected.row.props.items.filter(item=>item.id!==selected.column.id);
      const layout=layoutForCount(remaining.length);
      const changed=changeLayoutRow({...selected.row,props:{...selected.row.props,items:remaining}},layout);
      const blocks=document.blocks.map(block=>block.id===selected.row.id?changed:block);
      return commit({...document,blocks},{selection:{kind:'row',rowId:selected.row.id}});
    }
    return deleteBlock(selected.block.id);
  }

  function reorderBlock(id,index){
    const currentIndex=document.blocks.findIndex(block=>block.id===id);if(currentIndex<0)return;
    const blocks=[...document.blocks];const [block]=blocks.splice(currentIndex,1);
    const target=currentIndex<index?index-1:index;
    const nextIndex=clampIndex(target,blocks.length);
    if(nextIndex===currentIndex)return;
    blocks.splice(nextIndex,0,block);
    commit({...document,blocks},{selection:block.props?.row?{kind:'row',rowId:id}:{kind:'block',blockId:id}});
  }

  function moveBlock(id,offset){
    const currentIndex=document.blocks.findIndex(block=>block.id===id);if(currentIndex<0)return;
    const direction=Number(offset)<0?-1:1;
    const nextIndex=Math.min(Math.max(currentIndex+direction,0),Math.max(0,document.blocks.length-1));
    if(nextIndex===currentIndex)return;
    const blocks=[...document.blocks];const [block]=blocks.splice(currentIndex,1);blocks.splice(nextIndex,0,block);
    commit({...document,blocks},{
      selection:block.props?.row?{kind:'row',rowId:id}:{kind:'block',blockId:id},
      noticeMessage:direction<0?'تم رفع البلوك خطوة واحدة.':'تم خفض البلوك خطوة واحدة.'
    });
  }

  function handleDragStart(event,id){
    const source=document.blocks.find(block=>block.id===id);
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-marktone-existing-block',id);
    event.dataTransfer.setData(
      source?.props?.row?'application/x-marktone-existing-row':'application/x-marktone-existing-module',
      id
    );
    event.dataTransfer.setData('text/plain','Marktone builder block');
  }
  function handleModuleDragStart(event,rowId,columnId,moduleId){
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-marktone-module',JSON.stringify({rowId,columnId,moduleId}));
  }

  function handleDrop(index,event){
    const layout=event.dataTransfer.getData('application/x-marktone-row-layout');
    const preset=event.dataTransfer.getData('application/x-marktone-preset');
    const type=event.dataTransfer.getData('application/x-marktone-new-block');
    const id=event.dataTransfer.getData('application/x-marktone-existing-block');
    const nested=safeJson(event.dataTransfer.getData('application/x-marktone-module'));
    const saved=safeJson(event.dataTransfer.getData('application/x-marktone-saved'));
    if(layout)return addRow(layout,index);
    if(preset)return insertPreset(preset,index);
    if(type)return addBlock(type,index);
    if(id)return reorderBlock(id,index);
    if(nested)return moveModuleToTop(nested,index);
    if(saved)return insertSaved(saved,index);
  }

  function handleColumnDrop(rowId,columnId,index,event){
    const type=event.dataTransfer.getData('application/x-marktone-new-block');
    const nested=safeJson(event.dataTransfer.getData('application/x-marktone-module'));
    const topId=event.dataTransfer.getData('application/x-marktone-existing-block');
    const saved=safeJson(event.dataTransfer.getData('application/x-marktone-saved'));
    if(type)return insertModule(rowId,columnId,type,index);
    if(nested)return moveModule(nested,{rowId,columnId,index});
    if(topId)return moveTopBlockIntoColumn(topId,{rowId,columnId,index});
    if(saved?.kind==='module')return insertModule(rowId,columnId,saved.data,index);
  }

  function moveModule(source,target){
    const row=document.blocks.find(block=>block.id===source.rowId);const column=row?.props?.items?.find(item=>item.id===source.columnId);
    const builderModule=column?.modules?.find(item=>item.id===source.moduleId);if(!builderModule)return;
    let blocks=document.blocks.map(block=>block.id!==source.rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>item.id!==source.columnId?item:{...item,modules:item.modules.filter(entry=>entry.id!==source.moduleId)})}});
    blocks=blocks.map(block=>block.id!==target.rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>{
      if(item.id!==target.columnId)return item;
      const modules=[...item.modules];let targetIndex=clampIndex(target.index,modules.length);
      if(source.rowId===target.rowId&&source.columnId===target.columnId){
        const oldIndex=column.modules.findIndex(entry=>entry.id===source.moduleId);if(oldIndex<targetIndex)targetIndex-=1;
      }
      modules.splice(clampIndex(targetIndex,modules.length),0,builderModule);return {...item,modules};
    })}});
    commit({...document,blocks},{selection:{kind:'module',rowId:target.rowId,columnId:target.columnId,moduleId:builderModule.id}});
  }

  function moveModuleToTop(source,index){
    const row=document.blocks.find(block=>block.id===source.rowId);const column=row?.props?.items?.find(item=>item.id===source.columnId);
    const builderModule=column?.modules?.find(item=>item.id===source.moduleId);if(!builderModule)return;
    const blocks=document.blocks.map(block=>block.id!==source.rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>item.id!==source.columnId?item:{...item,modules:item.modules.filter(entry=>entry.id!==source.moduleId)})}});
    const newRow=createLayoutRow('1');newRow.props.items[0].modules=[builderModule];blocks.splice(clampIndex(index,blocks.length),0,newRow);
    commit({...document,blocks},{selection:{kind:'module',rowId:newRow.id,columnId:newRow.props.items[0].id,moduleId:builderModule.id}});
  }

  function moveTopBlockIntoColumn(topId,target){
    const source=document.blocks.find(block=>block.id===topId);if(!source||source.props?.row)return;
    const blocks=document.blocks.filter(block=>block.id!==topId).map(block=>block.id!==target.rowId?block:{...block,props:{...block.props,items:block.props.items.map(item=>{
      if(item.id!==target.columnId)return item;const modules=[...item.modules];modules.splice(clampIndex(target.index,modules.length),0,source);return {...item,modules};
    })}});
    commit({...document,blocks},{selection:{kind:'module',rowId:target.rowId,columnId:target.columnId,moduleId:source.id}});
  }

  function updateSelected(path,value){
    if(!selected)return;
    if(selected.kind==='row'&&path==='props.layoutKey'){
      const changed=changeLayoutRow(selected.row,value);
      const blocks=document.blocks.map(block=>block.id===selected.row.id?changed:block);
      return commit({...document,blocks},{selection:{kind:'row',rowId:selected.row.id}});
    }
    const blocks=document.blocks.map(block=>{
      if(selected.kind==='block'&&block.id===selected.block.id)return setPath(block,path,value);
      if(selected.kind==='row'&&block.id===selected.row.id)return setPath(block,path,value);
      if((selected.kind==='column'||selected.kind==='module')&&block.id===selected.row.id){
        return {...block,props:{...block.props,items:block.props.items.map(column=>{
          if(column.id!==selected.column.id)return column;
          if(selected.kind==='column')return setPath(column,path,value);
          return {...column,modules:column.modules.map(item=>item.id===selected.module.id?setPath(item,path,value):item)};
        })}};
      }
      return block;
    });
    commit({...document,blocks},{selection});
  }

  function updateInline(target,path,value){
    const found=locateSelection(document,target);if(!found)return;
    const blocks=document.blocks.map(block=>{
      if(found.kind==='block'&&block.id===found.block.id)return setPath(block,path,value);
      if(found.kind==='module'&&block.id===found.row.id)return {...block,props:{...block.props,items:block.props.items.map(column=>column.id!==found.column.id?column:{...column,modules:column.modules.map(item=>item.id===found.module.id?setPath(item,path,value):item)})}};
      return block;
    });
    commit({...document,blocks},{selection:target});
  }

  function updatePageSetting(key,value){commit({...document,settings:{...document.settings,[key]:value}},{selection});}
  function importDocument(value){
    const next=normalizeEditorDocument(value);
    commit(next,{selection:firstSelection(next),noticeMessage:'تم استيراد التصميم إلى المسودة.'});
  }

  async function insertImportedTemplate(template={}){
    const entryUrl=String(template.entryUrl||'').trim();
    if(!entryUrl){setNotice({type:'error',text:'رابط القالب المستورد غير صالح.'});return}
    if(busy)return;
    const mode=await chooseTemplateImportMode({
      title:String(template.name||template.title||'قالب ZIP مستورد'),
      sectionCount:Number(template.sectionCount)||1,
      fileCount:Number(template.fileCount)||0,
      scriptCount:Number(template.scriptCount)||0,
      pendingAnalysis:true
    });
    if(!mode){
      setNotice({type:'success',text:'تم إلغاء إدراج القالب ولم تتغير المسودة.'});
      return;
    }
    setBusy('compile-template');
    setNotice({type:'success',text:'جارٍ تحليل القالب وتقسيمه إلى أقسام أصلية…'});
    try{
      const compiled=await loadNativeTemplatePackage(template);

      const importedBlocks=createNativeTemplateBlocks(template,compiled,{});
      if(!importedBlocks.length)throw new Error('لم نجد أقسامًا قابلة للإدراج داخل القالب.');

      const rawInsertionIndex=defaultTopIndex(true);
      const existingBlocks=document.blocks.filter(block=>!isEmptyLayoutRow(block));
      let blocks;
      if(mode==='replace'){
        blocks=importedBlocks;
      }else{
        if(existingBlocks.length+importedBlocks.length>80){
          throw new Error(`القالب يحتوي ${importedBlocks.length} قسمًا، ولا يمكن إضافته لأن الصفحة ستتجاوز الحد الأقصى البالغ 80 قسمًا. استخدم خيار الاستبدال أو احذف بعض الأقسام.`);
        }
        const insertionIndex=document.blocks.slice(0,rawInsertionIndex).filter(block=>!isEmptyLayoutRow(block)).length;
        blocks=[...existingBlocks];
        blocks.splice(clampIndex(insertionIndex,blocks.length),0,...importedBlocks);
      }

      const first=importedBlocks[0];
      const scriptNotice=compiled.scriptCount>0
        ?` تم تعطيل ${compiled.scriptCount} ملف JavaScript لحماية جلسة ماركتون.`
        :'';
      commit({...document,blocks},{
        selection:{kind:'block',blockId:first.id},
        noticeMessage:`${mode==='replace'?'تم استبدال التصميم':'تمت إضافة القالب'} بـ ${importedBlocks.length} قسمًا أصليًا بعرض الصفحة، بدون iframe وبدون عمود وسيط.${scriptNotice}`
      });
    }catch(error){
      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر تحويل القالب إلى أقسام أصلية.'});
    }finally{
      setBusy('');
    }
  }

  async function upgradeLegacyTemplates(){
    if(!legacyTemplateCount||busy)return;
    if(!window.confirm(`سيتم تحويل ${legacyTemplateCount} قالب ZIP قديم إلى أقسام أصلية مستقلة بعرض الصفحة، مع إزالة العمود والحاوية القديمة. متابعة؟`))return;
    setBusy('upgrade-legacy-templates');
    setNotice({type:'success',text:'جارٍ ترقية القالب القديم إلى أقسام أصلية بدون iframe…'});
    try{
      const blocks=[];
      let upgraded=0;
      for(const sourceBlock of document.blocks){
        const legacy=extractUpgradeableLegacyTemplate(sourceBlock);
        if(!legacy){
          if(!isEmptyLayoutRow(sourceBlock))blocks.push(sourceBlock);
          continue;
        }
        const p=legacy.props||{};
        const descriptor={
          id:String(p.templateId||''),templateId:String(p.templateId||''),
          name:String(p.title||'قالب ZIP قديم'),title:String(p.title||'قالب ZIP قديم'),
          entryUrl:String(p.entryUrl||''),nativeUrl:String(p.nativeUrl||''),
          checksum:String(p.checksum||''),fileCount:Number(p.fileCount)||0,
          totalBytes:Number(p.totalBytes)||0
        };
        if(!descriptor.entryUrl)throw new Error('أحد القوالب القديمة لا يحتوي رابط ملف صالحًا. أعد رفع ملف ZIP.');
        const compiled=await loadNativeTemplatePackage(descriptor);
        const nativeBlocks=createNativeTemplateBlocks(descriptor,compiled,p.textOverrides||{});
        if(!nativeBlocks.length)throw new Error('تعذر استخراج أقسام من أحد القوالب القديمة.');
        if(blocks.length+nativeBlocks.length>80)throw new Error('لا يمكن ترقية القالب لأن الصفحة ستتجاوز 80 قسمًا.');
        blocks.push(...nativeBlocks);
        upgraded+=1;
      }
      if(!upgraded)throw new Error('لم نجد قالبًا قديمًا قابلًا للترقية داخل المسودة.');
      const first=blocks.find(isNativeTemplateBlock);
      commit({...document,blocks},{
        selection:first?{kind:'block',blockId:first.id}:firstSelection({blocks}),
        noticeMessage:`تم تحويل ${upgraded} قالب قديم إلى أقسام أصلية مستقلة بعرض الصفحة. احفظ المسودة بعد المراجعة.`
      });
    }catch(error){
      setNotice({type:'error',text:error instanceof Error?error.message:'تعذر ترقية القالب القديم.'});
    }finally{
      setBusy('');
    }
  }

  function previewAssistantPlan(operations){
    const result=applyCmsAssistantOperations(document,operations,{
      createModule:(type,definition)=>createBuilderBlock(type,definition),
      createRow:(layoutKey)=>createLayoutRow(layoutKey)
    });
    return {...result,document:normalizeEditorDocument(result.document)};
  }

  function applyAssistantDocument(value,summary='تم تطبيق تعديلات المساعد'){
    const next=normalizeEditorDocument(value);
    commit(next,{
      selection:firstSelection(next),
      noticeMessage:`${String(summary).slice(0,180)}. يمكنك التراجع قبل الحفظ أو النشر.`
    });
  }

  async function request(action,payload={}){
    setBusy(action);setNotice(null);
    try{
      const response=await fetch(`/api/cms/builder/${action}`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({siteKey:context.siteKey||'marktone-main',tenantSlug:context.tenantSlug||null,entityType:entity.type||'page',entityId:entity.id,...payload})
      });
      const result=await response.json();
      if(!response.ok)throw new Error(result?.error||'تعذر تنفيذ العملية');
      if(result.data?.versions)setVersions(result.data.versions);
      if(result.data?.draftDocument)setDocument(normalizeEditorDocument(result.data.draftDocument));
      return result.data||{};
    }catch(error){setNotice({type:'error',text:error instanceof Error?error.message:String(error)});throw error;}
    finally{setBusy('');}
  }

  function clearRecovery(){try{localStorage.removeItem(recoveryKey)}catch{}}
  async function saveDraft(){if(busy)return;try{await request('save-draft',{document});setDirty(false);clearRecovery();setNotice({type:'success',text:'تم حفظ المسودة دون تغيير النسخة المنشورة.'});}catch{}}
  async function publish(){if(busy)return;if(!window.confirm('سيتم استبدال النسخة المنشورة بهذه المسودة. هل تريد النشر؟'))return;try{await request('publish',{document});setDirty(false);clearRecovery();setNotice({type:'success',text:'تم نشر المحتوى بنجاح.'});router.refresh();}catch{}}
  async function restore(versionId){if(!window.confirm('سيتم استعادة هذا الإصدار داخل المسودة الحالية فقط.'))return;try{const data=await request('restore-version',{versionId});const restored=normalizeEditorDocument(data.draftDocument);setHistory(current=>({past:[...current.past,document].slice(-40),future:[]}));setDocument(restored);setSelection(firstSelection(restored));setDirty(true);setNotice({type:'success',text:'تمت استعادة الإصدار إلى المسودة. اضغط نشر لتحديث الموقع.'});}catch{}}
  function applyTemplate(){if(document.blocks.length&&!window.confirm('سيستبدل القالب محتوى المسودة الحالي.'))return;const next=createBuilderDocument(templateKey);commit(next,{selection:firstSelection(next)});}

  function currentModuleTarget(){
    if(selected?.kind==='column')return {rowId:selected.row.id,columnId:selected.column.id,index:selected.column.modules.length};
    if(selected?.kind==='module')return {rowId:selected.row.id,columnId:selected.column.id,index:selected.moduleIndex+1};
    return null;
  }
  function defaultTopIndex(after=false){
    if(!selected)return document.blocks.length;
    const index=selected.blockIndex??document.blocks.findIndex(block=>block.id===(selected.row?.id||selected.block?.id));
    return index<0?document.blocks.length:index+(after?1:0);
  }

  return {
    page:entity,entity,context,document,selected,selection,setSelection,
    device,setDevice,zoom,setZoom,previewMode,setPreviewMode,showOutlines,setShowOutlines,
    history,dirty,busy,notice,setNotice,versions,showVersions,setShowVersions,
    templateKey,setTemplateKey,groups,undo,redo,addRow,addBlock,insertPreset,insertSaved,
    duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,duplicateSelected,deleteSelected,
    handleDragStart,handleModuleDragStart,handleDrop,handleColumnDrop,
    updateSelected,updateInline,updatePageSetting,importDocument,insertImportedTemplate,
    legacyTemplateCount,upgradeLegacyTemplates,
    previewAssistantPlan,applyAssistantDocument,saveDraft,publish,restore,applyTemplate
  };
}

function createNativeTemplateBlocks(template,compiled,textOverrides={}){
  const entryUrl=String(template.entryUrl||'').trim();
  const packageId=nativeTemplatePackageId(template);
  return (Array.isArray(compiled?.sections)?compiled.sections:[]).map((section,index)=>createBuilderBlock('widget',{
    props:{
      title:section.title||`قسم ${index+1}`,
      body:'قسم أصلي مستورد من قالب ZIP.',
      widgetKey:NATIVE_TEMPLATE_WIDGET_KEY,
      templateId:String(template.id||template.templateId||''),
      templatePackageId:packageId,
      entryUrl,
      nativeUrl:String(template.nativeUrl||compiled.nativeUrl||''),
      checksum:String(template.checksum||compiled.checksum||''),
      fileCount:Number(template.fileCount||compiled.fileCount)||0,
      totalBytes:Number(template.totalBytes||compiled.totalBytes)||0,
      scriptCount:Number(compiled.scriptCount)||0,
      templateOwnsPageShell:true,
      sectionKey:section.key,
      sectionIndex:index,
      sectionCount:Number(compiled.sectionCount)||1,
      textOverrides:textOverrides&&typeof textOverrides==='object'&&!Array.isArray(textOverrides)?{...textOverrides}:{}
    },
    style:{
      paddingY:0,maxWidth:'full',background:'transparent',borderWidth:0,
      borderRadius:0,shadow:'none',variant:'light',align:'right'
    }
  }));
}
function extractUpgradeableLegacyTemplate(block){
  if(isLegacyTemplateBlock(block))return block;
  if(block?.type!=='columns'||block.props?.row!==true)return null;
  const modules=(Array.isArray(block.props?.items)?block.props.items:[])
    .flatMap(column=>Array.isArray(column?.modules)?column.modules:[]);
  return modules.length===1&&isLegacyTemplateBlock(modules[0])?modules[0]:null;
}
function countUpgradeableLegacyTemplates(value){
  return (Array.isArray(value?.blocks)?value.blocks:[]).reduce((count,block)=>count+(extractUpgradeableLegacyTemplate(block)?1:0),0);
}
function isLegacyTemplateBlock(block){
  return block?.type==='widget'&&block.props?.widgetKey==='imported-template';
}

function normalizeEditorDocument(value){
  const normalized=normalizeBuilderDocument(value);
  if(!normalized.blocks.some(isNativeTemplateBlock))return normalized;
  const blocks=normalized.blocks.filter(block=>!isEmptyLayoutRow(block));
  return blocks.length===normalized.blocks.length?normalized:{...normalized,blocks};
}
function isNativeTemplateBlock(block){
  return block?.type==='widget'&&['native-template-section','imported-template'].includes(block.props?.widgetKey);
}
function isEmptyLayoutRow(block){
  if(block?.type!=='columns'||block.props?.row!==true)return false;
  const columns=Array.isArray(block.props?.items)?block.props.items:[];
  return columns.length>0&&columns.every(column=>!Array.isArray(column?.modules)||column.modules.length===0);
}

function locateSelection(document,selection){
  if(!selection)return null;
  const blocks=document.blocks||[];
  if(selection.kind==='block'){
    const blockIndex=blocks.findIndex(block=>block.id===selection.blockId);if(blockIndex<0)return null;
    return {kind:'block',block:blocks[blockIndex],blockIndex};
  }
  const blockIndex=blocks.findIndex(block=>block.id===selection.rowId);if(blockIndex<0)return null;
  const row=blocks[blockIndex];if(row.type!=='columns'||row.props?.row!==true)return null;
  if(selection.kind==='row')return {kind:'row',block:row,row,blockIndex};
  const columnIndex=row.props.items.findIndex(column=>column.id===selection.columnId);if(columnIndex<0)return null;
  const column=row.props.items[columnIndex];
  if(selection.kind==='column')return {kind:'column',block:row,row,column,blockIndex,columnIndex};
  const moduleIndex=column.modules.findIndex(item=>item.id===selection.moduleId);if(moduleIndex<0)return null;
  return {kind:'module',block:row,row,column,module:column.modules[moduleIndex],blockIndex,columnIndex,moduleIndex};
}
function firstSelection(document){
  const block=document?.blocks?.[0];if(!block)return null;
  return block.type==='columns'&&block.props?.row?{kind:'row',rowId:block.id}:{kind:'block',blockId:block.id};
}
function validSelection(document,selection){return Boolean(locateSelection(document,selection));}
function setPath(source,path,value){
  const keys=String(path||'').split('.').filter(Boolean);if(!keys.length)return source;
  const clone=Array.isArray(source)?[...source]:{...source};let cursor=clone;
  for(let index=0;index<keys.length-1;index+=1){const key=keys[index];const current=cursor[key];cursor[key]=Array.isArray(current)?[...current]:{...(current||{})};cursor=cursor[key];}
  cursor[keys.at(-1)]=value;return clone;
}
function cloneRowWithFreshIds(source){
  const row=createLayoutRow(source.props?.layoutKey||'1',{props:{...source.props,items:[]},style:source.style,responsive:source.responsive});
  row.props.items=source.props.items.map(column=>({
    ...column,id:freshId('column'),
    modules:(column.modules||[]).map(item=>createBuilderBlock(item.type,{props:item.props,style:item.style,responsive:item.responsive}))
  }));
  return row;
}
function layoutForCount(count){return ({1:'1',2:'1-1',3:'1-1-1',4:'1-1-1-1',5:'1-1-1-1-1',6:'1-1-1-1-1-1'})[Math.max(1,Math.min(6,count))]||'1';}
function freshId(prefix){return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2,10)}`;}
function safeJson(value){try{return value?JSON.parse(value):null;}catch{return null;}}
function clampIndex(value,length){const number=Number(value);return Number.isFinite(number)?Math.max(0,Math.min(number,length)):length;}
function isTyping(target){return Boolean(target?.closest?.('input,textarea,select,[contenteditable="true"]'));}
