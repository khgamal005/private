const CONTENT_FIELDS=new Set([
  'eyebrow','title','body','content','label','primaryLabel','secondaryLabel','primaryHref',
  'secondaryHref','href','imageUrl','imageAlt','icon','accent','author','role','quote',
  'badge','name','value','suffix','description','items','features','bullets','logos','tabs',
  'steps','stats','testimonials'
]);
const STYLE_FIELDS=new Set([
  'variant','align','paddingY','maxWidth','background','color','borderColor','borderWidth',
  'borderRadius','shadow','animation','animationDelay','cssClass','gap','padding','minHeight',
  'verticalAlign'
]);
const RESPONSIVE_FIELDS=new Set(['hideDesktop','hideTablet','hideMobile']);
const PAGE_FIELDS=new Set(['direction','theme','background','contentWidth','fontScale']);

export function applyCmsAssistantOperations(source,operations,helpers={}){
  const document=clone(source);
  const applied=[];
  const rejected=[];
  const list=Array.isArray(operations)?operations.slice(0,18):[];
  for(const [index,operation] of list.entries()){
    try{
      applyOperation(document,operation,helpers);
      applied.push(index);
    }catch(error){
      rejected.push({index,reason:error instanceof Error?error.message:'invalid_operation'});
    }
  }
  if(!applied.length)throw new Error('لم ينتج المساعد تعديلًا صالحًا للمعاينة. أعد صياغة الطلب بشكل أكثر تحديدًا.');
  return {document,applied,rejected};
}

function applyOperation(document,operation,helpers){
  if(!operation||typeof operation!=='object')throw new Error('invalid_operation');
  if(operation.type==='set_content'){
    if(!CONTENT_FIELDS.has(operation.field))throw new Error('content_field_not_allowed');
    const node=findNode(document,operation.target);
    node.props={...(node.props||{}),[operation.field]:safeValue(operation.value)};
    return;
  }
  if(operation.type==='set_style'){
    if(!STYLE_FIELDS.has(operation.field))throw new Error('style_field_not_allowed');
    const node=findNode(document,operation.target);
    node.style={...(node.style||{}),[operation.field]:safeValue(operation.value)};
    return;
  }
  if(operation.type==='set_responsive'){
    if(!RESPONSIVE_FIELDS.has(operation.field))throw new Error('responsive_field_not_allowed');
    const node=findNode(document,operation.target);
    node.responsive={...(node.responsive||{}),[operation.field]:Boolean(operation.value)};
    return;
  }
  if(operation.type==='set_page'){
    if(!PAGE_FIELDS.has(operation.field))throw new Error('page_field_not_allowed');
    document.settings={...(document.settings||{}),[operation.field]:safeValue(operation.value)};
    return;
  }
  if(operation.type==='insert_module'){
    if(typeof helpers.createModule!=='function')throw new Error('module_factory_missing');
    const column=findColumn(document,operation.rowId,operation.columnId);
    const builderModule=helpers.createModule(operation.moduleType,{
      props:entriesToObject(operation.content,CONTENT_FIELDS),
      style:entriesToObject(operation.styles,STYLE_FIELDS),
      responsive:entriesToObject(operation.responsive,RESPONSIVE_FIELDS)
    });
    const modules=Array.isArray(column.modules)?column.modules:[];
    const afterIndex=operation.afterModuleId?modules.findIndex(item=>item.id===operation.afterModuleId):-1;
    modules.splice(afterIndex>=0?afterIndex+1:modules.length,0,builderModule);
    column.modules=modules;
    return;
  }
  if(operation.type==='insert_section'){
    if(typeof helpers.createRow!=='function'||typeof helpers.createModule!=='function')throw new Error('row_factory_missing');
    const row=helpers.createRow(operation.layoutKey||'1');
    const definitions=Array.isArray(operation.modules)?operation.modules:[];
    for(const definition of definitions){
      const columnIndex=Math.max(0,Math.min(row.props.items.length-1,Number(definition.columnIndex)||0));
      row.props.items[columnIndex].modules.push(helpers.createModule(definition.moduleType,{
        props:entriesToObject(definition.content,CONTENT_FIELDS),
        style:entriesToObject(definition.styles,STYLE_FIELDS),
        responsive:entriesToObject(definition.responsive,RESPONSIVE_FIELDS)
      }));
    }
    const afterIndex=operation.afterRowId?document.blocks.findIndex(item=>item.id===operation.afterRowId):-1;
    document.blocks.splice(afterIndex>=0?afterIndex+1:document.blocks.length,0,row);
    return;
  }
  if(operation.type==='delete_node'){
    deleteNode(document,operation.target);
    return;
  }
  throw new Error('operation_type_not_allowed');
}

function findNode(document,target){
  if(!target||typeof target!=='object')throw new Error('target_required');
  if(target.kind==='block'){
    const block=document.blocks.find(item=>item.id===target.blockId&&!item.props?.row);
    if(!block)throw new Error('block_not_found');
    return block;
  }
  if(target.kind==='row'){
    const row=findRow(document,target.rowId);
    return row;
  }
  if(target.kind==='column')return findColumn(document,target.rowId,target.columnId);
  if(target.kind==='module'){
    const column=findColumn(document,target.rowId,target.columnId);
    const builderModule=column.modules.find(item=>item.id===target.moduleId);
    if(!builderModule)throw new Error('module_not_found');
    return builderModule;
  }
  throw new Error('target_kind_not_allowed');
}

function findRow(document,rowId){
  const row=document.blocks.find(item=>item.id===rowId&&item.props?.row);
  if(!row)throw new Error('row_not_found');
  return row;
}
function findColumn(document,rowId,columnId){
  const row=findRow(document,rowId);
  const column=row.props.items.find(item=>item.id===columnId);
  if(!column)throw new Error('column_not_found');
  return column;
}
function deleteNode(document,target){
  if(target?.kind==='block'){
    const before=document.blocks.length;
    document.blocks=document.blocks.filter(item=>item.id!==target.blockId);
    if(before===document.blocks.length)throw new Error('block_not_found');
    return;
  }
  if(target?.kind==='row'){
    const before=document.blocks.length;
    document.blocks=document.blocks.filter(item=>item.id!==target.rowId);
    if(before===document.blocks.length)throw new Error('row_not_found');
    return;
  }
  if(target?.kind==='module'){
    const column=findColumn(document,target.rowId,target.columnId);
    const before=column.modules.length;
    column.modules=column.modules.filter(item=>item.id!==target.moduleId);
    if(before===column.modules.length)throw new Error('module_not_found');
    return;
  }
  throw new Error('delete_target_not_allowed');
}
function entriesToObject(value,allowed){
  if(!Array.isArray(value))return {};
  return Object.fromEntries(value.filter(item=>item&&allowed.has(item.field)).map(item=>[item.field,safeValue(item.value)]));
}
function safeValue(value){
  if(typeof value==='string')return value.slice(0,5000);
  if(typeof value==='number')return Number.isFinite(value)?value:0;
  if(typeof value==='boolean'||value===null)return value;
  if(Array.isArray(value))return value.slice(0,24).map(safeValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,24).map(([key,item])=>[key,safeValue(item)]));
  return '';
}
function clone(value){return typeof structuredClone==='function'?structuredClone(value):JSON.parse(JSON.stringify(value));}

export function compactCmsDocument(value,{maxDepth=7,maxArray=60,maxString=1600}={}){
  function visit(item,depth){
    if(depth>maxDepth)return '[مختصر]';
    if(typeof item==='string')return item.slice(0,maxString);
    if(typeof item==='number'||typeof item==='boolean'||item===null)return item;
    if(Array.isArray(item))return item.slice(0,maxArray).map(entry=>visit(entry,depth+1));
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).slice(0,80).map(([key,entry])=>[key,visit(entry,depth+1)]));
    return null;
  }
  return visit(value,0);
}
