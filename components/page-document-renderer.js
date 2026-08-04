'use client';

import {normalizeBuilderDocument,ROW_LAYOUTS} from '../lib/website-builder';
import baseStyles from './page-document-renderer.module.css';
import proStyles from './page-document-renderer-pro.module.css';
import {ModuleView,blockLabel,blockStyle,hiddenFor,safeCss} from './page-builder-module-view';

const styles={...baseStyles,...proStyles};

export default function PageDocumentRenderer({
  document,editor=false,device='desktop',selection=null,onSelect,onDropAt,onDragStart,
  onDuplicate,onDelete,onColumnDrop,onModuleDragStart,onDuplicateModule,onDeleteModule,
  onInlineEdit,showOutlines=true
}){
  const normalized=normalizeBuilderDocument(document);
  return <div className={`${styles.document} ${styles[`device_${device}`]||''} ${editor&&showOutlines?styles.showOutlines:''}`} style={{background:normalized.settings.background}}>
    {normalized.settings.customCss&&<style dangerouslySetInnerHTML={{__html:safeCss(normalized.settings.customCss)}}/>}
    {editor&&<TopDrop index={0} onDropAt={onDropAt}/>} 
    {normalized.blocks.map((block,index)=><TopBlock
      key={block.id} block={block} index={index} editor={editor} device={device} selection={selection}
      onSelect={onSelect} onDropAt={onDropAt} onDragStart={onDragStart} onDuplicate={onDuplicate}
      onDelete={onDelete} onColumnDrop={onColumnDrop} onModuleDragStart={onModuleDragStart}
      onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}
    />)}
    {editor&&!normalized.blocks.length&&<div className={styles.emptyCanvas}><strong>ابدأ بإضافة أول صف</strong><span>اسحب توزيع أعمدة أو موديول من المكتبة.</span></div>}
  </div>;
}

function TopBlock(props){
  const {block,index,editor,device,selection,onSelect,onDropAt,onDragStart,onDuplicate,onDelete}=props;
  const row=isRow(block);const hidden=hiddenFor(block.responsive,device);
  const selected=row?selection?.kind==='row'&&selection.rowId===block.id:selection?.kind==='block'&&selection.blockId===block.id;
  if(!editor)return <Responsive responsive={block.responsive}><BlockView block={block} device={device}/></Responsive>;
  return <div className={styles.editorBlockWrap}>
    <article className={`${styles.editorBlock} ${row?styles.editorRow:''} ${selected?styles.selected:''} ${hidden?styles.hiddenInDevice:''}`} draggable onDragStart={event=>onDragStart?.(event,block.id)} onClick={event=>{event.stopPropagation();onSelect?.(row?{kind:'row',rowId:block.id}:{kind:'block',blockId:block.id});}}>
      <Toolbar label={row?'صف':blockLabel(block.type)} detail={row?ROW_LAYOUTS[block.props.layoutKey]?.label:''} hidden={hidden} onDuplicate={()=>onDuplicate?.(block.id)} onDelete={()=>onDelete?.(block.id)}/>
      <BlockView {...props}/>
    </article>
    <TopDrop index={index+1} onDropAt={onDropAt}/>
  </div>;
}

export function BlockView({
  block,editor=false,device='desktop',selection=null,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit
}){
  if(!isRow(block))return <ModuleView block={block} editor={editor} target={{kind:'block',blockId:block.id}} onInlineEdit={onInlineEdit}/>;
  const p=block.props||{};const s=block.style||{};const layout=ROW_LAYOUTS[p.layoutKey]||ROW_LAYOUTS['1'];
  const className=[styles.block,styles.layoutSection,styles[`variant_${s.variant||'light'}`]||'',styles[`align_${s.align||'right'}`]||'',styles[`width_${s.maxWidth||'wide'}`]||'',s.cssClass||''].filter(Boolean).join(' ');
  return <section id={p.anchor||undefined} className={className} style={blockStyle(s)} data-builder-type="columns" data-animation={s.animation&&s.animation!=='none'?s.animation:undefined}>
    <div className={`${styles.layoutRow} ${p.fullWidth?styles.fullWidthRow:''}`} style={{gridTemplateColumns:layout.template,gap:clamp(p.gap,0,64,18),minHeight:clamp(p.minHeight,0,1200,0),alignItems:p.verticalAlign||'stretch'}}>
      {p.items.map((column,columnIndex)=><Column key={column.id} row={block} column={column} columnIndex={columnIndex} editor={editor} device={device} selection={selection} onSelect={onSelect} onColumnDrop={onColumnDrop} onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}/>) }
    </div>
  </section>;
}

function Column({row,column,columnIndex,editor,device,selection,onSelect,onColumnDrop,onModuleDragStart,onDuplicateModule,onDeleteModule,onInlineEdit}){
  const hidden=hiddenFor(column.responsive,device);const selected=selection?.kind==='column'&&selection.rowId===row.id&&selection.columnId===column.id;
  const style=columnStyle(column.style);
  if(!editor)return <Responsive responsive={column.responsive}><div className={styles.publicColumn} style={style}>{column.modules.map(module=><Responsive key={module.id} responsive={module.responsive}><ModuleView block={module} nested/></Responsive>)}</div></Responsive>;
  return <div className={`${styles.builderColumn} ${selected?styles.selectedColumn:''} ${hidden?styles.hiddenColumn:''}`} style={style} onClick={event=>{event.stopPropagation();onSelect?.({kind:'column',rowId:row.id,columnId:column.id});}}>
    <div className={styles.columnToolbar}><span>عمود {columnIndex+1}</span><small>{column.modules.length} عنصر</small></div>
    <ColumnDrop rowId={row.id} columnId={column.id} index={0} onColumnDrop={onColumnDrop}/>
    {column.modules.map((module,moduleIndex)=><NestedModule key={module.id} row={row} column={column} module={module} moduleIndex={moduleIndex} device={device} selection={selection} onSelect={onSelect} onColumnDrop={onColumnDrop} onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}/>) }
    {!column.modules.length&&<div className={styles.emptyColumn}><span>＋</span><b>اسحب موديول هنا</b></div>}
  </div>;
}

function NestedModule({row,column,module,moduleIndex,device,selection,onSelect,onColumnDrop,onModuleDragStart,onDuplicateModule,onDeleteModule,onInlineEdit}){
  const target={kind:'module',rowId:row.id,columnId:column.id,moduleId:module.id};
  const selected=selection?.kind==='module'&&selection.rowId===row.id&&selection.columnId===column.id&&selection.moduleId===module.id;
  return <div className={styles.nestedEditorWrap}>
    <article className={`${styles.nestedEditor} ${selected?styles.selectedModule:''} ${hiddenFor(module.responsive,device)?styles.hiddenInDevice:''}`} draggable onDragStart={event=>{event.stopPropagation();onModuleDragStart?.(event,row.id,column.id,module.id);}} onClick={event=>{event.stopPropagation();onSelect?.(target);}}>
      <div className={styles.moduleToolbar}><span className={styles.dragHandle}>⋮⋮</span><b>{blockLabel(module.type)}</b><button type="button" onClick={event=>{event.stopPropagation();onDuplicateModule?.(row.id,column.id,module.id);}}>نسخ</button><button type="button" onClick={event=>{event.stopPropagation();onDeleteModule?.(row.id,column.id,module.id);}}>حذف</button></div>
      <ModuleView block={module} editor nested target={target} onInlineEdit={onInlineEdit}/>
    </article>
    <ColumnDrop rowId={row.id} columnId={column.id} index={moduleIndex+1} onColumnDrop={onColumnDrop}/>
  </div>;
}

function Toolbar({label,detail,hidden,onDuplicate,onDelete}){return <div className={styles.editorToolbar}><span className={styles.dragHandle} title="اسحب لإعادة الترتيب">⋮⋮</span><b>{label}</b>{detail&&<small>{detail}</small>}{hidden&&<small>مخفي</small>}<button type="button" onClick={event=>{event.stopPropagation();onDuplicate();}}>نسخ</button><button type="button" onClick={event=>{event.stopPropagation();onDelete();}}>حذف</button></div>}
function TopDrop({index,onDropAt}){return <div className={styles.dropZone} onDragOver={event=>{event.preventDefault();event.dataTransfer.dropEffect='move';}} onDrop={event=>{event.preventDefault();onDropAt?.(index,event);}}><span>ضع الصف أو العنصر هنا</span></div>}
function ColumnDrop({rowId,columnId,index,onColumnDrop}){return <div className={styles.columnDropZone} onDragOver={event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';}} onDrop={event=>{event.preventDefault();event.stopPropagation();onColumnDrop?.(rowId,columnId,index,event);}}><span>إفلات هنا</span></div>}
function Responsive({responsive,children}){return <div className={styles.responsiveBlock} data-hide-desktop={responsive?.hideDesktop||undefined} data-hide-tablet={responsive?.hideTablet||undefined} data-hide-mobile={responsive?.hideMobile||undefined}>{children}</div>}
function isRow(block){return block.type==='columns'&&block.props?.row===true}
function columnStyle(s={}){return {'--column-background':s.background||'transparent','--column-color':s.color||'inherit','--column-padding':`${clamp(s.padding,0,100,18)}px`,'--column-gap':`${clamp(s.gap,0,64,14)}px`,'--column-border':s.borderColor||'transparent','--column-border-width':`${clamp(s.borderWidth,0,12,0)}px`,'--column-radius':`${clamp(s.borderRadius,0,80,0)}px`,'--column-shadow':({none:'none',soft:'0 12px 35px rgba(10,31,53,.09)',medium:'0 20px 55px rgba(10,31,53,.14)',strong:'0 28px 80px rgba(10,31,53,.22)'})[s.shadow]||'none',alignContent:s.verticalAlign||'stretch'}}
function clamp(value,min,max,fallback){const n=Number(value);return Number.isFinite(n)?Math.min(Math.max(n,min),max):fallback}
