import assert from 'node:assert/strict';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const VERSION_FROM='2.0.0-beta.28';
const VERSION_TO='2.0.0-beta.29';

async function text(path){return readFile(path,'utf8')}
async function replaceOnce(path,before,after){
  const source=await text(path);
  assert.ok(source.includes(before),`Missing patch anchor in ${path}`);
  assert.equal(source.indexOf(before),source.lastIndexOf(before),`Patch anchor is not unique in ${path}`);
  await writeFile(path,source.replace(before,after));
}
async function replaceRegex(path,pattern,replacement,label){
  const source=await text(path);
  const matches=source.match(pattern);
  assert.ok(matches,`Missing regex patch anchor ${label} in ${path}`);
  const next=source.replace(pattern,replacement);
  assert.notEqual(next,source,`Regex patch ${label} made no change in ${path}`);
  await writeFile(path,next);
}
async function appendOnce(path,marker,content){
  const source=await text(path);
  if(source.includes(marker))return;
  await writeFile(path,`${source.trimEnd()}\n${content.trim()}\n`);
}

await replaceRegex('components/use-page-builder.js',
  /  function addBlock\(type,index\)\{[\s\S]*?\n  \}\n\n  function insertModule/,
`  function addBlock(type,index){
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

  function insertModule`,
  'addBlock explicit top-level drop');

await replaceRegex('components/use-page-builder.js',
  /  function insertSaved\(item,index=defaultTopIndex\(true\)\)\{[\s\S]*?\n  \}\n\n  function addBlockDefinition\(source\)\{[\s\S]*?\n  \}\n\n  function duplicateBlock/,
`  function insertSaved(item,index){
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

  function duplicateBlock`,
  'saved items respect drop index');

await replaceRegex('components/use-page-builder.js',
  /  function reorderBlock\(id,index\)\{[\s\S]*?\n  \}\n\n  function handleDragStart\(event,id\)\{[^\n]*\}/,
`  function reorderBlock(id,index){
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
    const nextIndex=clampIndex(currentIndex+Number(offset||0),document.blocks.length-1);
    if(nextIndex===currentIndex)return;
    const blocks=[...document.blocks];const [block]=blocks.splice(currentIndex,1);blocks.splice(nextIndex,0,block);
    commit({...document,blocks},{
      selection:block.props?.row?{kind:'row',rowId:id}:{kind:'block',blockId:id},
      noticeMessage:offset<0?'تم رفع البلوك خطوة واحدة.':'تم خفض البلوك خطوة واحدة.'
    });
  }

  function handleDragStart(event,id){
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('application/x-marktone-existing-block',id);
    event.dataTransfer.setData('text/plain','Marktone builder block');
  }`,
  'block reorder and move controls');

await replaceOnce('components/use-page-builder.js',
`    duplicateBlock,deleteBlock,duplicateModule,deleteModule,duplicateSelected,deleteSelected,`,
`    duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,duplicateSelected,deleteSelected,`);

await replaceOnce('components/page-builder.js',
`    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,duplicateModule,deleteModule,`,
`    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,`);

await replaceOnce('components/page-builder.js',
`      <main className={styles.stage} onClick={()=>{setSelection(null);setInspectorMode('page');}}>`,
`      <main className={styles.stage} data-builder-scroll-container="true" onClick={()=>{setSelection(null);setInspectorMode('page');}}>`);

await replaceOnce('components/page-builder.js',
`              onDuplicate={duplicateBlock} onDelete={deleteBlock} onColumnDrop={handleColumnDrop}`,
`              onDuplicate={duplicateBlock} onDelete={deleteBlock} onMoveBlock={moveBlock} onColumnDrop={handleColumnDrop}`);

await replaceOnce('components/page-builder.js',
`<div key={item.id} className={styles.savedCard} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));}}>`,
`<div key={item.id} className={styles.savedCard} draggable title="اسحب البلوك وأفلته في موضعه داخل الصفحة" onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));event.dataTransfer.setData(item.kind==='module'?'application/x-marktone-saved-module':'application/x-marktone-saved-block',String(item.id||item.kind));event.dataTransfer.setData('text/plain',String(item.name||'Marktone saved block'));}}> `);

await replaceOnce('components/page-builder.js',
`<small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))}</small>`,
`<small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))} · اسحب للمكان المطلوب</small>`);

await replaceOnce('components/page-document-renderer.js',
`'use client';\n\nimport {normalizeBuilderDocument,ROW_LAYOUTS} from '../lib/website-builder';`,
`'use client';\n\nimport {useEffect,useRef,useState} from 'react';\nimport {normalizeBuilderDocument,ROW_LAYOUTS} from '../lib/website-builder';`);

await replaceOnce('components/page-document-renderer.js',
`const COPY_DRAG_TYPES=new Set([\n  'application/x-marktone-row-layout',\n  'application/x-marktone-new-block',\n  'application/x-marktone-preset',\n  'application/x-marktone-saved'\n]);`,
`const COPY_DRAG_TYPES=new Set([\n  'application/x-marktone-row-layout',\n  'application/x-marktone-new-block',\n  'application/x-marktone-preset',\n  'application/x-marktone-saved',\n  'application/x-marktone-saved-block',\n  'application/x-marktone-saved-module'\n]);\nconst BUILDER_DRAG_TYPES=new Set([\n  ...COPY_DRAG_TYPES,\n  'application/x-marktone-existing-block',\n  'application/x-marktone-module'\n]);`);

await replaceRegex('components/page-document-renderer.js',
  /export default function PageDocumentRenderer\(\{[\s\S]*?\n\}\n\nfunction TopBlock/,
`export default function PageDocumentRenderer({
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
    return()=>{window.removeEventListener('dragend',clear);window.removeEventListener('drop',clear);};
  },[]);

  function clearDragPreview(){setActiveTopDrop(null);setDragActive(false);}
  function previewTopDrop(index,event){
    if(index===null||index===undefined){clearDragPreview();return;}
    setDragActive(true);
    setActiveTopDrop(clampDropIndex(index,normalized.blocks.length));
    if(event)autoScrollBuilder(event,rootRef.current);
  }
  function handleRootDragOver(event){
    if(!editor||!hasBuilderPayload(event.dataTransfer))return;
    if(closestElement(event.target,\`.\${styles.columnDropZone}\`))return;
    event.preventDefault();
    allowDrop(event);
    previewTopDrop(resolveTopDropIndex(event,rootRef.current,normalized.blocks.length),event);
  }
  function handleRootDrop(event){
    if(!editor||!hasBuilderPayload(event.dataTransfer))return;
    if(closestElement(event.target,\`.\${styles.columnDropZone}\`))return;
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
    className={\`${styles.document} \${styles[\`device_\${device}\`]||''} \${editor&&showOutlines?styles.showOutlines:''} \${dragActive?styles.draggingDocument:''}\`}
    data-builder-dragging={dragActive?'true':undefined}
    style={{background:normalized.settings.background}}
    onDragOver={editor?handleRootDragOver:undefined}
    onDrop={editor?handleRootDrop:undefined}
    onDragLeave={editor?handleRootDragLeave:undefined}
  >
    {normalized.settings.customCss&&<style dangerouslySetInnerHTML={{__html:safeCss(normalized.settings.customCss)}}/>}
    {editor&&<TopDrop index={0} active={activeTopDrop===0} onPreview={previewTopDrop} onClear={clearDragPreview} onDropAt={onDropAt}/>} 
    {normalized.blocks.map((block,index)=><TopBlock
      key={block.id} block={block} index={index} blockCount={normalized.blocks.length}
      activeTopDrop={activeTopDrop} onPreview={previewTopDrop}
      editor={editor} device={device} selection={selection}
      onSelect={onSelect} onDropAt={onDropAt} onDragStart={onDragStart} onDuplicate={onDuplicate}
      onDelete={onDelete} onMoveBlock={onMoveBlock} onColumnDrop={onColumnDrop} onModuleDragStart={onModuleDragStart}
      onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}
      pageCss={normalized.settings.customCss}
    />)}
    {editor&&!normalized.blocks.length&&<div className={styles.emptyCanvas}><strong>ابدأ بإضافة أول صف</strong><span>اسحب توزيع أعمدة أو موديول من المكتبة.</span></div>}
  </div>;
}

function TopBlock`,
  'precision drag renderer root');

await replaceRegex('components/page-document-renderer.js',
  /function TopBlock\(props\)\{[\s\S]*?\n\}\n\nexport function BlockView/,
`function TopBlock(props){
  const {
    block,index,blockCount,activeTopDrop,onPreview,editor,device,selection,onSelect,onDropAt,
    onDragStart,onDuplicate,onDelete,onMoveBlock
  }=props;
  const row=isRow(block);const hidden=hiddenFor(block.responsive,device);
  const selected=row?selection?.kind==='row'&&selection.rowId===block.id:selection?.kind==='block'&&selection.blockId===block.id;
  if(!editor)return <Responsive responsive={block.responsive}><BlockView block={block} device={device} pageCss={props.pageCss}/></Responsive>;
  const dropBefore=activeTopDrop===index;
  const dropAfter=activeTopDrop===index+1;
  function previewBlockDrop(event){
    if(!hasBuilderPayload(event.dataTransfer))return;
    if(closestElement(event.target,\`.\${styles.dropZone},.\${styles.columnDropZone}\`))return;
    event.preventDefault();
    event.stopPropagation();
    allowDrop(event);
    const rect=event.currentTarget.getBoundingClientRect();
    onPreview?.(event.clientY<rect.top+rect.height/2?index:index+1,event);
  }
  return <div
    className={\`${styles.editorBlockWrap} \${dropBefore?styles.dropTargetBefore:''} \${dropAfter?styles.dropTargetAfter:''}\`}
    data-builder-block-index={index}
    onDragEnter={previewBlockDrop}
    onDragOver={previewBlockDrop}
  >
    <article className={\`${styles.editorBlock} \${row?styles.editorRow:''} \${selected?styles.selected:''} \${hidden?styles.hiddenInDevice:''}\`} onClick={event=>{event.stopPropagation();onSelect?.(row?{kind:'row',rowId:block.id}:{kind:'block',blockId:block.id});}}>
      <Toolbar
        label={row?'صف':blockLabel(block.type)} detail={row?ROW_LAYOUTS[block.props.layoutKey]?.label:''} hidden={hidden}
        onDragStart={event=>onDragStart?.(event,block.id)} onDuplicate={()=>onDuplicate?.(block.id)} onDelete={()=>onDelete?.(block.id)}
        canMoveUp={index>0} canMoveDown={index<blockCount-1}
        onMoveUp={()=>onMoveBlock?.(block.id,-1)} onMoveDown={()=>onMoveBlock?.(block.id,1)}
      />
      <BlockView {...props}/>
    </article>
    <TopDrop index={index+1} active={activeTopDrop===index+1} onPreview={onPreview} onDropAt={onDropAt}/>
  </div>;
}

export function BlockView`,
  'magnetic block drop surfaces');

await replaceRegex('components/page-document-renderer.js',
  /function Toolbar\(\{label,detail,hidden,onDragStart,onDuplicate,onDelete\}\)\{[^\n]*\}/,
`function Toolbar({label,detail,hidden,onDragStart,onDuplicate,onDelete,canMoveUp,canMoveDown,onMoveUp,onMoveDown}){
  function startDrag(event){
    if(closestElement(event.target,'button')){event.preventDefault();return;}
    onDragStart?.(event);
  }
  return <div className={styles.editorToolbar} draggable onDragStart={startDrag} title="اسحب الشريط لنقل البلوك">
    <span className={styles.dragHandle} title="اسحب لنقل البلوك">⋮⋮ <em>اسحب</em></span>
    <b>{label}</b>{detail&&<small>{detail}</small>}{hidden&&<small>مخفي</small>}
    <button type="button" draggable={false} disabled={!canMoveUp} title="رفع البلوك خطوة" onClick={event=>{event.stopPropagation();onMoveUp?.();}}>↑</button>
    <button type="button" draggable={false} disabled={!canMoveDown} title="خفض البلوك خطوة" onClick={event=>{event.stopPropagation();onMoveDown?.();}}>↓</button>
    <button type="button" draggable={false} onClick={event=>{event.stopPropagation();onDuplicate();}}>نسخ</button>
    <button type="button" draggable={false} onClick={event=>{event.stopPropagation();onDelete();}}>حذف</button>
  </div>;
}`,
  'large draggable block toolbar');

await replaceRegex('components/page-document-renderer.js',
  /function TopDrop\(\{index,onDropAt\}\)\{[^\n]*\}/,
`function TopDrop({index,onDropAt,active=false,onPreview,onClear}){
  function preview(event){
    if(!hasBuilderPayload(event.dataTransfer))return;
    allowDrop(event,true);
    onPreview?.(index,event);
  }
  return <div
    data-builder-drop-index={index}
    className={\`${styles.dropZone} \${active?styles.activeDropZone:''}\`}
    onDragEnter={preview}
    onDragOver={preview}
    onDrop={event=>{
      if(!hasBuilderPayload(event.dataTransfer))return;
      event.preventDefault();event.stopPropagation();onClear?.();onDropAt?.(index,event);
    }}
  ><span>{active?'أفلت هنا الآن':'ضع الصف أو العنصر هنا'}</span></div>;
}`,
  'active top drop indicator');

await replaceRegex('components/page-document-renderer.js',
  /function ColumnDrop\(\{rowId,columnId,index,onColumnDrop\}\)\{[^\n]*\}/,
`function ColumnDrop({rowId,columnId,index,onColumnDrop}){
  function preview(event){if(!hasColumnPayload(event.dataTransfer))return;allowDrop(event,true);}
  return <div
    data-builder-column-drop="true"
    className={styles.columnDropZone}
    onDragEnter={preview}
    onDragOver={preview}
    onDrop={event=>{
      if(!hasColumnPayload(event.dataTransfer))return;
      event.preventDefault();event.stopPropagation();onColumnDrop?.(rowId,columnId,index,event);
    }}
  ><span>إفلات داخل العمود</span></div>;
}`,
  'column payload filtering');

await replaceRegex('components/page-document-renderer.js',
  /function allowDrop\(event,stopPropagation=false\)\{[\s\S]*?\n\}/,
`function allowDrop(event,stopPropagation=false){
  event.preventDefault();
  if(stopPropagation)event.stopPropagation();
  if(!event.dataTransfer)return;
  const types=dragTypeSet(event.dataTransfer);
  const copySource=event.dataTransfer.effectAllowed==='copy'||[...types].some(type=>COPY_DRAG_TYPES.has(type));
  event.dataTransfer.dropEffect=copySource?'copy':'move';
}
function dragTypeSet(dataTransfer){return new Set(Array.from(dataTransfer?.types||[]))}
function hasBuilderPayload(dataTransfer){
  const types=dragTypeSet(dataTransfer);
  return [...types].some(type=>BUILDER_DRAG_TYPES.has(type));
}
function hasColumnPayload(dataTransfer){
  const types=dragTypeSet(dataTransfer);
  if(types.has('application/x-marktone-saved-block'))return false;
  if(types.has('application/x-marktone-row-layout')||types.has('application/x-marktone-preset'))return false;
  return types.has('application/x-marktone-new-block')||types.has('application/x-marktone-module')||
    types.has('application/x-marktone-existing-block')||types.has('application/x-marktone-saved-module')||
    (types.has('application/x-marktone-saved')&&!types.has('application/x-marktone-saved-block'));
}
function closestElement(target,selector){
  const element=target?.nodeType===1?target:target?.parentElement;
  return element?.closest?.(selector)||null;
}
function resolveTopDropIndex(event,root,count){
  const explicit=closestElement(event.target,'[data-builder-drop-index]');
  if(explicit&&root?.contains(explicit))return clampDropIndex(explicit.getAttribute('data-builder-drop-index'),count);
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
  return Number.isFinite(number)?Math.min(Math.max(Math.round(number),0),Math.max(0,count)):Math.max(0,count);
}
function autoScrollBuilder(event,root){
  const container=findBuilderScrollContainer(root);if(!container)return;
  const pageScroll=container===document.documentElement||container===document.body||container===document.scrollingElement;
  const rect=pageScroll?{top:0,bottom:window.innerHeight,height:window.innerHeight}:container.getBoundingClientRect();
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
  if(pageScroll)window.scrollBy(0,delta);else container.scrollTop+=delta;
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
}`,
  'drag payload and auto-scroll helpers');

await appendOnce('components/page-document-renderer.module.css','/* precise-builder-drag-drop-v1 */',`
/* precise-builder-drag-drop-v1 */
.document[data-builder-dragging="true"]{overflow:visible}.editorBlockWrap{isolation:isolate}.editorBlockWrap.dropTargetBefore>.editorBlock{box-shadow:inset 0 4px 0 #f36b21}.editorBlockWrap.dropTargetAfter>.editorBlock{box-shadow:inset 0 -4px 0 #f36b21}.editorToolbar[draggable="true"]{cursor:grab;user-select:none}.editorToolbar[draggable="true"]:active{cursor:grabbing}.dragHandle{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:58px;min-height:28px;padding:4px 8px;border-radius:6px;background:#ffffff18;color:var(--gold);cursor:grab;user-select:none}.dragHandle em{font-style:normal;font-size:8px;color:#fff}.editorToolbar button:disabled{opacity:.3;cursor:not-allowed}.dropZone{height:18px}.document[data-builder-dragging="true"] .dropZone{height:20px}.activeDropZone{height:44px!important;background:linear-gradient(90deg,transparent,rgba(243,107,33,.08),transparent)}.activeDropZone:before{inset:20px 18px auto!important;border-top:4px solid #f36b21!important;filter:drop-shadow(0 2px 5px rgba(243,107,33,.35))}.activeDropZone span{display:block!important;background:#f36b21!important;padding:5px 12px!important;font-weight:900;white-space:nowrap}
`);

await appendOnce('components/page-document-renderer-pro.module.css','/* precise-column-drop-v1 */',`
/* precise-column-drop-v1 */
:global([data-builder-dragging="true"]) .columnDropZone{height:16px}.columnDropZone:hover{height:38px}.moduleToolbar[draggable="true"]{cursor:grab;user-select:none}
`);

await appendOnce('components/page-builder.module.css','/* precise-saved-drag-v1 */',`
/* precise-saved-drag-v1 */
.savedCard{position:relative;cursor:grab;transition:transform .15s,border-color .15s,box-shadow .15s}.savedCard:hover{transform:translateY(-2px);border-color:#f36b21;box-shadow:0 8px 22px rgba(14,39,63,.12)}.savedCard:active{cursor:grabbing;transform:scale(.985);opacity:.82}.savedCard>button:first-child{cursor:grab}.savedCard>button:first-child small{line-height:1.55}
`);

for(const path of ['package.json','package-lock.json','components/page-builder-with-library.js']){
  const source=await text(path);
  assert.ok(source.includes(VERSION_FROM),`Missing ${VERSION_FROM} in ${path}`);
  await writeFile(path,source.replaceAll(VERSION_FROM,VERSION_TO));
}
for(const name of await readdir('tests')){
  if(!name.endsWith('.test.mjs'))continue;
  const path=join('tests',name);
  const source=await text(path);
  if(source.includes(VERSION_FROM))await writeFile(path,source.replaceAll(VERSION_FROM,VERSION_TO));
}

await replaceOnce('tests/visual-builder-pro.test.mjs',
`  assert.match(renderer,/onDropAt\\?\\.\\(normalized\\.blocks\\.length,event\\)/);`,
`  assert.match(renderer,/resolveTopDropIndex/);\n  assert.match(renderer,/data-builder-block-index/);\n  assert.match(renderer,/activeTopDrop/);\n  assert.match(renderer,/autoScrollBuilder/);\n  assert.doesNotMatch(renderer,/onDropAt\\?\\.\\(normalized\\.blocks\\.length,event\\)/);\n  assert.match(state,/addBlockDefinition\\(item\\.data,index\\)/);\n  assert.match(state,/function moveBlock\\(id,offset\\)/);`);

await writeFile('tests/builder-drag-drop-precision.test.mjs',`import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('saved blocks and modules honor the exact top-level drop index',async()=>{
  const [hook,builder]=await Promise.all([
    source('components/use-page-builder.js'),source('components/page-builder.js')
  ]);
  assert.match(hook,/function insertSaved\\(item,index\\)/);
  assert.match(hook,/addBlockDefinition\\(item\\.data,index\\)/);
  assert.match(hook,/index===undefined\\?defaultTopIndex\\(true\\):index/);
  assert.match(hook,/if\\(index===undefined\\)\\{[\\s\\S]*?currentModuleTarget/);
  assert.match(builder,/application\\/x-marktone-saved-block/);
  assert.match(builder,/application\\/x-marktone-saved-module/);
  assert.match(builder,/data-builder-scroll-container="true"/);
});

test('canvas uses magnetic before and after drop targets instead of appending blindly',async()=>{
  const [renderer,css,proCss]=await Promise.all([
    source('components/page-document-renderer.js'),
    source('components/page-document-renderer.module.css'),
    source('components/page-document-renderer-pro.module.css')
  ]);
  assert.match(renderer,/resolveTopDropIndex/);
  assert.match(renderer,/event\\.clientY<rect\\.top\\+rect\\.height\\/2\\?index:index\\+1/);
  assert.match(renderer,/data-builder-drop-index/);
  assert.match(renderer,/activeTopDrop/);
  assert.match(renderer,/autoScrollBuilder/);
  assert.match(renderer,/function moveBlock/);
  assert.doesNotMatch(renderer,/normalized\\.blocks\\.length,event/);
  assert.match(css,/activeDropZone/);
  assert.match(css,/dropTargetBefore/);
  assert.match(proCss,/precise-column-drop-v1/);
});

test('builder exposes large drag handles and deterministic move buttons',async()=>{
  const renderer=await source('components/page-document-renderer.js');
  assert.match(renderer,/اسحب الشريط لنقل البلوك/);
  assert.match(renderer,/رفع البلوك خطوة/);
  assert.match(renderer,/خفض البلوك خطوة/);
  assert.match(renderer,/onMoveBlock\\?\\.\\(block\\.id,-1\\)/);
  assert.match(renderer,/onMoveBlock\\?\\.\\(block\\.id,1\\)/);
});
`);

console.log('Applied precise builder drag and drop patch.');
