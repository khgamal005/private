'use client';

import {useEffect,useRef,useState} from 'react';
import {normalizeBuilderDocument,ROW_LAYOUTS} from '../lib/website-builder';
import baseStyles from './page-document-renderer.module.css';
import proStyles from './page-document-renderer-pro.module.css';
import {ModuleView,blockLabel,blockStyle,hiddenFor,safeCss} from './page-builder-module-view-runtime';

const styles={...baseStyles,...proStyles};
const COPY_DRAG_TYPES=new Set([
  'application/x-marktone-row-layout',
  'application/x-marktone-new-block',
  'application/x-marktone-preset',
  'application/x-marktone-saved',
  'application/x-marktone-saved-block',
  'application/x-marktone-saved-module'
]);
const BUILDER_DRAG_TYPES=new Set([
  ...COPY_DRAG_TYPES,
  'application/x-marktone-existing-block',
  'application/x-marktone-existing-row',
  'application/x-marktone-existing-module',
  'application/x-marktone-module'
]);

export default function PageDocumentRenderer({
  document,editor=false,device='desktop',selection=null,onSelect,onDropAt,onDragStart,
  onDuplicate,onDelete,onMoveBlock,onColumnDrop,onModuleDragStart,onDuplicateModule,onDeleteModule,
  onInlineEdit,showOutlines=true
}){
  const normalized=normalizeBuilderDocument(document);
  const rootRef=useRef(null);
  const [activeTopDrop,setActiveTopDrop]=useState(null);
  const [dragActive,setDragActive]=useState(false);

  useEffect(()=>{
    const clear=()=>{setActiveTopDrop(null);setDragActive(false);};
    window.addEventListener('dragend',clear);
    window.addEventListener('drop',clear);
    return()=>{
      window.removeEventListener('dragend',clear);
      window.removeEventListener('drop',clear);
    };
  },[]);

  function clearDragPreview(){
    setActiveTopDrop(null);
    setDragActive(false);
  }

  function previewTopDrop(index,event){
    if(index===null||index===undefined){clearDragPreview();return;}
    setDragActive(true);
    setActiveTopDrop(clampDropIndex(index,normalized.blocks.length));
    if(event)autoScrollBuilder(event,rootRef.current);
  }

  function handleRootDragOver(event){
    if(!editor||!hasBuilderPayload(event.dataTransfer))return;
    const columnZone=closestElement(event.target,`.${styles.columnDropZone}`);
    if(columnZone&&hasColumnPayload(event.dataTransfer))return;
    event.preventDefault();
    allowDrop(event);
    previewTopDrop(resolveTopDropIndex(event,rootRef.current,normalized.blocks.length),event);
  }

  function handleRootDrop(event){
    if(!editor||!hasBuilderPayload(event.dataTransfer))return;
    const columnZone=closestElement(event.target,`.${styles.columnDropZone}`);
    if(columnZone&&hasColumnPayload(event.dataTransfer))return;
    event.preventDefault();
    event.stopPropagation();
    const index=activeTopDrop??resolveTopDropIndex(event,rootRef.current,normalized.blocks.length);
    clearDragPreview();
    onDropAt?.(clampDropIndex(index,normalized.blocks.length),event);
  }

  function handleRootDragLeave(event){
    if(!event.currentTarget.contains(event.relatedTarget))clearDragPreview();
  }

  return <div
    ref={rootRef}
    className={[
      styles.document,
      styles[`device_${device}`]||'',
      editor&&showOutlines?styles.showOutlines:'',
      dragActive?styles.draggingDocument:''
    ].filter(Boolean).join(' ')}
    data-builder-dragging={dragActive?'true':undefined}
    style={{background:normalized.settings.background}}
    onDragOver={editor?handleRootDragOver:undefined}
    onDrop={editor?handleRootDrop:undefined}
    onDragLeave={editor?handleRootDragLeave:undefined}
  >
    {normalized.settings.customCss&&<style dangerouslySetInnerHTML={{__html:safeCss(normalized.settings.customCss)}}/>}
    {editor&&<TopDrop
      index={0} active={activeTopDrop===0} onPreview={previewTopDrop}
      onClear={clearDragPreview} onDropAt={onDropAt}
    />}
    {normalized.blocks.map((block,index)=><TopBlock
      key={block.id} block={block} index={index} blockCount={normalized.blocks.length}
      activeTopDrop={activeTopDrop} onPreview={previewTopDrop} onClear={clearDragPreview}
      editor={editor} device={device} selection={selection}
      onSelect={onSelect} onDropAt={onDropAt} onDragStart={onDragStart} onDuplicate={onDuplicate}
      onDelete={onDelete} onMoveBlock={onMoveBlock} onColumnDrop={onColumnDrop}
      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}
      pageCss={normalized.settings.customCss}
    />)}
    {editor&&!normalized.blocks.length&&<div className={styles.emptyCanvas}>
      <strong>ابدأ بإضافة أول صف</strong>
      <span>اسحب توزيع أعمدة أو موديول من المكتبة.</span>
    </div>}
  </div>;
}

function TopBlock(props){
  const {
    block,index,blockCount,activeTopDrop,onPreview,onClear,editor,device,selection,onSelect,onDropAt,
    onDragStart,onDuplicate,onDelete,onMoveBlock
  }=props;
  const row=isRow(block);
  const hidden=hiddenFor(block.responsive,device);
  const selected=row
    ?selection?.kind==='row'&&selection.rowId===block.id
    :selection?.kind==='block'&&selection.blockId===block.id;
  if(!editor){
    return <Responsive responsive={block.responsive}>
      <BlockView block={block} device={device} pageCss={props.pageCss}/>
    </Responsive>;
  }
  const dropBefore=activeTopDrop===index;
  const dropAfter=activeTopDrop===index+1;

  function previewBlockDrop(event){
    if(!hasBuilderPayload(event.dataTransfer))return;
    if(closestElement(event.target,`.${styles.dropZone}`))return;
    const columnZone=closestElement(event.target,`.${styles.columnDropZone}`);
    if(columnZone&&hasColumnPayload(event.dataTransfer))return;
    event.preventDefault();
    event.stopPropagation();
    allowDrop(event);
    const rect=event.currentTarget.getBoundingClientRect();
    onPreview?.(event.clientY<rect.top+rect.height/2?index:index+1,event);
  }

  return <div
    className={[
      styles.editorBlockWrap,
      dropBefore?styles.dropTargetBefore:'',
      dropAfter?styles.dropTargetAfter:''
    ].filter(Boolean).join(' ')}
    data-builder-block-index={index}
    onDragEnter={previewBlockDrop}
    onDragOver={previewBlockDrop}
  >
    <article
      className={[
        styles.editorBlock,
        row?styles.editorRow:'',
        selected?styles.selected:'',
        hidden?styles.hiddenInDevice:''
      ].filter(Boolean).join(' ')}
      onClick={event=>{
        event.stopPropagation();
        onSelect?.(row?{kind:'row',rowId:block.id}:{kind:'block',blockId:block.id});
      }}
    >
      <Toolbar
        label={row?'صف':blockLabel(block.type)}
        detail={row?ROW_LAYOUTS[block.props.layoutKey]?.label:''}
        hidden={hidden}
        onDragStart={event=>onDragStart?.(event,block.id)}
        onDuplicate={()=>onDuplicate?.(block.id)}
        onDelete={()=>onDelete?.(block.id)}
        canMoveUp={index>0}
        canMoveDown={index<blockCount-1}
        onMoveUp={()=>onMoveBlock?.(block.id,-1)}
        onMoveDown={()=>onMoveBlock?.(block.id,1)}
      />
      <BlockView {...props}/>
    </article>
    <TopDrop
      index={index+1} active={activeTopDrop===index+1}
      onPreview={onPreview} onClear={onClear} onDropAt={onDropAt}
    />
  </div>;
}

export function BlockView({
  block,editor=false,device='desktop',selection=null,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss=''
}){
  if(!isRow(block)){
    const target={kind:'block',blockId:block.id};
    return <ModuleView
      block={block} editor={editor} target={target}
      onActivate={()=>onSelect?.(target)} onInlineEdit={onInlineEdit} pageCss={pageCss}
    />;
  }
  const p=block.props||{};
  const s=block.style||{};
  const layout=ROW_LAYOUTS[p.layoutKey]||ROW_LAYOUTS['1'];
  const className=[
    styles.block,styles.layoutSection,
    styles[`variant_${s.variant||'light'}`]||'',
    styles[`align_${s.align||'right'}`]||'',
    styles[`width_${s.maxWidth||'wide'}`]||'',
    s.cssClass||''
  ].filter(Boolean).join(' ');
  return <section
    id={p.anchor||undefined} className={className} style={blockStyle(s)}
    data-builder-type="columns"
    data-animation={s.animation&&s.animation!=='none'?s.animation:undefined}
  >
    <div
      className={`${styles.layoutRow} ${p.fullWidth?styles.fullWidthRow:''}`}
      style={{
        gridTemplateColumns:layout.template,
        gap:clamp(p.gap,0,64,18),
        minHeight:clamp(p.minHeight,0,1200,0),
        alignItems:p.verticalAlign||'stretch'
      }}
    >
      {p.items.map((column,columnIndex)=><Column
        key={column.id} row={block} column={column} columnIndex={columnIndex}
        editor={editor} device={device} selection={selection} onSelect={onSelect}
        onColumnDrop={onColumnDrop} onModuleDragStart={onModuleDragStart}
        onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule}
        onInlineEdit={onInlineEdit} pageCss={pageCss}
      />)}
    </div>
  </section>;
}

function Column({
  row,column,columnIndex,editor,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
  const hidden=hiddenFor(column.responsive,device);
  const selected=selection?.kind==='column'&&selection.rowId===row.id&&selection.columnId===column.id;
  const style=columnStyle(column.style);
  if(!editor){
    return <Responsive responsive={column.responsive}>
      <div className={styles.publicColumn} style={style}>
        {column.modules.map(module=><Responsive key={module.id} responsive={module.responsive}>
          <ModuleView block={module} nested pageCss={pageCss}/>
        </Responsive>)}
      </div>
    </Responsive>;
  }
  return <div
    className={`${styles.builderColumn} ${selected?styles.selectedColumn:''} ${hidden?styles.hiddenColumn:''}`}
    style={style}
    onClick={event=>{
      event.stopPropagation();
      onSelect?.({kind:'column',rowId:row.id,columnId:column.id});
    }}
  >
    <div className={styles.columnToolbar}>
      <span>عمود {columnIndex+1}</span>
      <small>{column.modules.length} عنصر</small>
    </div>
    <ColumnDrop rowId={row.id} columnId={column.id} index={0} onColumnDrop={onColumnDrop}/>
    {column.modules.map((module,moduleIndex)=><NestedModule
      key={module.id} row={row} column={column} module={module} moduleIndex={moduleIndex}
      device={device} selection={selection} onSelect={onSelect} onColumnDrop={onColumnDrop}
      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit} pageCss={pageCss}
    />)}
    {!column.modules.length&&<div className={styles.emptyColumn}>
      <span>＋</span><b>اسحب موديول هنا</b>
    </div>}
  </div>;
}

function NestedModule({
  row,column,module,moduleIndex,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
  const target={kind:'module',rowId:row.id,columnId:column.id,moduleId:module.id};
  const selected=selection?.kind==='module'&&selection.rowId===row.id&&
    selection.columnId===column.id&&selection.moduleId===module.id;
  return <div className={styles.nestedEditorWrap}>
    <article
      className={`${styles.nestedEditor} ${selected?styles.selectedModule:''} ${hiddenFor(module.responsive,device)?styles.hiddenInDevice:''}`}
      onClick={event=>{event.stopPropagation();onSelect?.(target);}}
    >
      <div className={styles.moduleToolbar}>
        <span
          className={styles.dragHandle} draggable
          onDragStart={event=>{
            event.stopPropagation();
            onModuleDragStart?.(event,row.id,column.id,module.id);
          }}
          title="اسحب العنصر"
        >⋮⋮</span>
        <b>{blockLabel(module.type)}</b>
        <button type="button" onClick={event=>{
          event.stopPropagation();
          onDuplicateModule?.(row.id,column.id,module.id);
        }}>نسخ</button>
        <button type="button" onClick={event=>{
          event.stopPropagation();
          onDeleteModule?.(row.id,column.id,module.id);
        }}>حذف</button>
      </div>
      <ModuleView
        block={module} editor nested target={target}
        onActivate={()=>onSelect?.(target)} onInlineEdit={onInlineEdit} pageCss={pageCss}
      />
    </article>
    <ColumnDrop
      rowId={row.id} columnId={column.id} index={moduleIndex+1}
      onColumnDrop={onColumnDrop}
    />
  </div>;
}

function Toolbar({
  label,detail,hidden,onDragStart,onDuplicate,onDelete,
  canMoveUp,canMoveDown,onMoveUp,onMoveDown
}){
  function startDrag(event){
    if(closestElement(event.target,'button')){
      event.preventDefault();
      return;
    }
    onDragStart?.(event);
  }
  return <div
    className={styles.editorToolbar} draggable
    onDragStart={startDrag} title="اسحب الشريط لنقل البلوك"
  >
    <span className={styles.dragHandle} title="اسحب لنقل البلوك">⋮⋮ <em>اسحب</em></span>
    <b>{label}</b>
    {detail&&<small>{detail}</small>}
    {hidden&&<small>مخفي</small>}
    <button
      type="button" draggable={false} disabled={!canMoveUp}
      title="رفع البلوك خطوة"
      onClick={event=>{event.stopPropagation();onMoveUp?.();}}
    >↑</button>
    <button
      type="button" draggable={false} disabled={!canMoveDown}
      title="خفض البلوك خطوة"
      onClick={event=>{event.stopPropagation();onMoveDown?.();}}
    >↓</button>
    <button type="button" draggable={false} onClick={event=>{
      event.stopPropagation();onDuplicate();
    }}>نسخ</button>
    <button type="button" draggable={false} onClick={event=>{
      event.stopPropagation();onDelete();
    }}>حذف</button>
  </div>;
}

function TopDrop({index,onDropAt,active=false,onPreview,onClear}){
  function preview(event){
    if(!hasBuilderPayload(event.dataTransfer))return;
    allowDrop(event,true);
    onPreview?.(index,event);
  }
  return <div
    data-builder-drop-index={index}
    className={[styles.dropZone,active?styles.activeDropZone:''].filter(Boolean).join(' ')}
    onDragEnter={preview}
    onDragOver={preview}
    onDrop={event=>{
      if(!hasBuilderPayload(event.dataTransfer))return;
      event.preventDefault();
      event.stopPropagation();
      onClear?.();
      onDropAt?.(index,event);
    }}
  ><span>{active?'أفلت هنا الآن':'ضع الصف أو العنصر هنا'}</span></div>;
}

function ColumnDrop({rowId,columnId,index,onColumnDrop}){
  function preview(event){
    if(!hasColumnPayload(event.dataTransfer))return;
    allowDrop(event,true);
  }
  return <div
    data-builder-column-drop="true"
    className={styles.columnDropZone}
    onDragEnter={preview}
    onDragOver={preview}
    onDrop={event=>{
      if(!hasColumnPayload(event.dataTransfer))return;
      event.preventDefault();
      event.stopPropagation();
      onColumnDrop?.(rowId,columnId,index,event);
    }}
  ><span>إفلات داخل العمود</span></div>;
}

function Responsive({responsive,children}){
  return <div
    className={styles.responsiveBlock}
    data-hide-desktop={responsive?.hideDesktop||undefined}
    data-hide-tablet={responsive?.hideTablet||undefined}
    data-hide-mobile={responsive?.hideMobile||undefined}
  >{children}</div>;
}

function isRow(block){return block.type==='columns'&&block.props?.row===true}

function allowDrop(event,stopPropagation=false){
  event.preventDefault();
  if(stopPropagation)event.stopPropagation();
  if(!event.dataTransfer)return;
  const types=dragTypeSet(event.dataTransfer);
  const copySource=event.dataTransfer.effectAllowed==='copy'||
    [...types].some(type=>COPY_DRAG_TYPES.has(type));
  event.dataTransfer.dropEffect=copySource?'copy':'move';
}

function dragTypeSet(dataTransfer){
  return new Set(Array.from(dataTransfer?.types||[]));
}

function hasBuilderPayload(dataTransfer){
  const types=dragTypeSet(dataTransfer);
  return [...types].some(type=>BUILDER_DRAG_TYPES.has(type));
}

function hasColumnPayload(dataTransfer){
  const types=dragTypeSet(dataTransfer);
  if(types.has('application/x-marktone-saved-block'))return false;
  if(types.has('application/x-marktone-existing-row'))return false;
  if(types.has('application/x-marktone-row-layout')||types.has('application/x-marktone-preset'))return false;
  return types.has('application/x-marktone-new-block')||
    types.has('application/x-marktone-module')||
    types.has('application/x-marktone-existing-module')||
    types.has('application/x-marktone-saved-module')||
    (types.has('application/x-marktone-saved')&&!types.has('application/x-marktone-saved-block'));
}

function closestElement(target,selector){
  const element=target?.nodeType===1?target:target?.parentElement;
  return element?.closest?.(selector)||null;
}

function resolveTopDropIndex(event,root,count){
  const explicit=closestElement(event.target,'[data-builder-drop-index]');
  if(explicit&&root?.contains(explicit)){
    return clampDropIndex(explicit.getAttribute('data-builder-drop-index'),count);
  }
  const direct=closestElement(event.target,'[data-builder-block-index]');
  if(direct&&root?.contains(direct)){
    const index=Number(direct.getAttribute('data-builder-block-index'))||0;
    const rect=direct.getBoundingClientRect();
    return clampDropIndex(event.clientY<rect.top+rect.height/2?index:index+1,count);
  }
  const blocks=[...(root?.querySelectorAll?.('[data-builder-block-index]')||[])];
  for(const block of blocks){
    const rect=block.getBoundingClientRect();
    const index=Number(block.getAttribute('data-builder-block-index'))||0;
    if(event.clientY<rect.top+rect.height/2)return clampDropIndex(index,count);
  }
  return clampDropIndex(count,count);
}

function clampDropIndex(value,count){
  const number=Number(value);
  return Number.isFinite(number)
    ?Math.min(Math.max(Math.round(number),0),Math.max(0,count))
    :Math.max(0,count);
}

function autoScrollBuilder(event,root){
  const container=findBuilderScrollContainer(root);
  if(!container)return;
  const pageScroll=container===document.documentElement||container===document.body||
    container===document.scrollingElement;
  const rect=pageScroll
    ?{top:0,bottom:window.innerHeight,height:window.innerHeight}
    :container.getBoundingClientRect();
  const edge=Math.min(130,Math.max(64,rect.height*.18));
  let delta=0;
  if(event.clientY<rect.top+edge){
    const intensity=Math.min(1,Math.max(0,(rect.top+edge-event.clientY)/edge));
    delta=-Math.round(5+30*intensity);
  }else if(event.clientY>rect.bottom-edge){
    const intensity=Math.min(1,Math.max(0,(event.clientY-(rect.bottom-edge))/edge));
    delta=Math.round(5+30*intensity);
  }
  if(!delta)return;
  if(pageScroll)window.scrollBy(0,delta);
  else container.scrollTop+=delta;
}

function findBuilderScrollContainer(root){
  let current=root?.parentElement;
  while(current){
    if(current.hasAttribute('data-builder-scroll-container'))return current;
    const computed=window.getComputedStyle(current);
    if(/auto|scroll/.test(computed.overflowY)&&current.scrollHeight>current.clientHeight+8)return current;
    current=current.parentElement;
  }
  return document.scrollingElement||document.documentElement;
}

function columnStyle(s={}){
  return {
    '--column-background':s.background||'transparent',
    '--column-color':s.color||'inherit',
    '--column-padding':`${clamp(s.padding,0,100,18)}px`,
    '--column-gap':`${clamp(s.gap,0,64,14)}px`,
    '--column-border':s.borderColor||'transparent',
    '--column-border-width':`${clamp(s.borderWidth,0,12,0)}px`,
    '--column-radius':`${clamp(s.borderRadius,0,80,0)}px`,
    '--column-shadow':({
      none:'none',
      soft:'0 12px 35px rgba(10,31,53,.09)',
      medium:'0 20px 55px rgba(10,31,53,.14)',
      strong:'0 28px 80px rgba(10,31,53,.22)'
    })[s.shadow]||'none',
    alignContent:s.verticalAlign||'stretch'
  };
}

function clamp(value,min,max,fallback){
  const number=Number(value);
  return Number.isFinite(number)?Math.min(Math.max(number,min),max):fallback;
}
