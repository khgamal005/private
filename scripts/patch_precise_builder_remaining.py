from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERSION_FROM = "2.0.0-beta.28"
VERSION_TO = "2.0.0-beta.29"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    (ROOT / path).write_text(content, encoding="utf-8")


def replace_once(path: str, before: str, after: str) -> None:
    source = read(path)
    count = source.count(before)
    if count != 1:
        raise RuntimeError(f"Expected one anchor in {path}, found {count}: {before[:80]!r}")
    write(path, source.replace(before, after, 1))


def regex_once(path: str, pattern: str, replacement: str, label: str) -> None:
    source = read(path)
    updated, count = re.subn(pattern, replacement, source, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f"Missing regex anchor {label} in {path}")
    write(path, updated)


def append_once(path: str, marker: str, block: str) -> None:
    source = read(path)
    if marker in source:
        return
    write(path, source.rstrip() + "\n" + block.strip() + "\n")


regex_once(
    "components/use-page-builder.js",
    r"  function addBlock\(type,index\)\{.*?\n  \}\n\n  function insertModule",
    r'''  function addBlock(type,index){
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

  function insertModule''',
    "addBlock explicit drop index",
)

regex_once(
    "components/use-page-builder.js",
    r"  function insertSaved\(item,index=defaultTopIndex\(true\)\)\{.*?\n  \}\n\n  function addBlockDefinition\(source\)\{.*?\n  \}\n\n  function duplicateBlock",
    r'''  function insertSaved(item,index){
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

  function duplicateBlock''',
    "saved block exact index",
)

regex_once(
    "components/use-page-builder.js",
    r"  function reorderBlock\(id,index\)\{.*?\n  \}\n\n  function handleDragStart\(event,id\)\{.*?\}\n  function handleModuleDragStart",
    r'''  function reorderBlock(id,index){
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
  function handleModuleDragStart''',
    "block reorder and deterministic controls",
)

replace_once(
    "components/use-page-builder.js",
    "    duplicateBlock,deleteBlock,duplicateModule,deleteModule,duplicateSelected,deleteSelected,",
    "    duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,duplicateSelected,deleteSelected,",
)

replace_once(
    "components/page-builder.js",
    "    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,duplicateModule,deleteModule,",
    "    addRow,addBlock,insertPreset,insertSaved,duplicateBlock,deleteBlock,moveBlock,duplicateModule,deleteModule,",
)
replace_once(
    "components/page-builder.js",
    "      <main className={styles.stage} onClick={()=>{setSelection(null);setInspectorMode('page');}}>",
    "      <main className={styles.stage} data-builder-scroll-container=\"true\" onClick={()=>{setSelection(null);setInspectorMode('page');}}>",
)
replace_once(
    "components/page-builder.js",
    "              onDuplicate={duplicateBlock} onDelete={deleteBlock} onColumnDrop={handleColumnDrop}",
    "              onDuplicate={duplicateBlock} onDelete={deleteBlock} onMoveBlock={moveBlock} onColumnDrop={handleColumnDrop}",
)
replace_once(
    "components/page-builder.js",
    "<div key={item.id} className={styles.savedCard} draggable onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));}}>",
    "<div key={item.id} className={styles.savedCard} draggable title=\"اسحب البلوك وأفلته في موضعه داخل الصفحة\" onDragStart={event=>{event.dataTransfer.effectAllowed='copy';event.dataTransfer.setData('application/x-marktone-saved',JSON.stringify({kind:item.kind,data:item.data}));event.dataTransfer.setData(item.kind==='module'?'application/x-marktone-saved-module':'application/x-marktone-saved-block',String(item.id||item.kind));event.dataTransfer.setData('text/plain',String(item.name||'Marktone saved block'));}}>",
)
replace_once(
    "components/page-builder.js",
    "<small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))}</small>",
    "<small>{new Intl.DateTimeFormat('ar-SA',{dateStyle:'medium'}).format(new Date(item.createdAt))} · اسحب للمكان المطلوب</small>",
)

append_once(
    "components/page-document-renderer.module.css",
    "/* precise-builder-drag-drop-v1 */",
    r'''
/* precise-builder-drag-drop-v1 */
.draggingDocument{overflow:visible!important}
.editorBlockWrap{isolation:isolate}
.editorBlockWrap.dropTargetBefore>.editorBlock{box-shadow:inset 0 4px 0 #f36b21}
.editorBlockWrap.dropTargetAfter>.editorBlock{box-shadow:inset 0 -4px 0 #f36b21}
.editorToolbar[draggable="true"]{cursor:grab;user-select:none}
.editorToolbar[draggable="true"]:active{cursor:grabbing}
.dragHandle{display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:58px;min-height:28px;padding:4px 8px;border-radius:6px;background:#ffffff18;color:var(--gold);cursor:grab;user-select:none}
.dragHandle em{font-style:normal;font-size:8px;color:#fff}
.editorToolbar button:disabled{opacity:.3;cursor:not-allowed}
.dropZone{height:18px}
.document[data-builder-dragging="true"] .dropZone{height:20px}
.activeDropZone{height:44px!important;background:linear-gradient(90deg,transparent,rgba(243,107,33,.08),transparent)}
.activeDropZone:before{inset:20px 18px auto!important;border-top:4px solid #f36b21!important;filter:drop-shadow(0 2px 5px rgba(243,107,33,.35))}
.activeDropZone span{display:block!important;background:#f36b21!important;padding:5px 12px!important;font-weight:900;white-space:nowrap}
''',
)
append_once(
    "components/page-document-renderer-pro.module.css",
    "/* precise-column-drop-v1 */",
    r'''
/* precise-column-drop-v1 */
:global([data-builder-dragging="true"]) .columnDropZone{height:16px}
.columnDropZone:hover{height:38px}
''',
)
append_once(
    "components/page-builder.module.css",
    "/* precise-saved-drag-v1 */",
    r'''
/* precise-saved-drag-v1 */
.savedCard{position:relative;cursor:grab;transition:transform .15s,border-color .15s,box-shadow .15s}
.savedCard:hover{transform:translateY(-2px);border-color:#f36b21;box-shadow:0 8px 22px rgba(14,39,63,.12)}
.savedCard:active{cursor:grabbing;transform:scale(.985);opacity:.82}
.savedCard>button:first-child{cursor:grab}
.savedCard>button:first-child small{line-height:1.55}
''',
)

for path in ["package.json", "package-lock.json", "components/page-builder-with-library.js"]:
    source = read(path)
    if VERSION_FROM not in source:
        raise RuntimeError(f"Missing {VERSION_FROM} in {path}")
    write(path, source.replace(VERSION_FROM, VERSION_TO))

for path in (ROOT / "tests").glob("*.test.mjs"):
    source = path.read_text(encoding="utf-8")
    if VERSION_FROM in source:
        path.write_text(source.replace(VERSION_FROM, VERSION_TO), encoding="utf-8")

replace_once(
    "tests/visual-builder-pro.test.mjs",
    "  assert.match(renderer,/onDropAt\\?\\.\\(normalized\\.blocks\\.length,event\\)/);",
    "  assert.match(renderer,/resolveTopDropIndex/);\n  assert.match(renderer,/data-builder-block-index/);\n  assert.match(renderer,/activeTopDrop/);\n  assert.match(renderer,/autoScrollBuilder/);\n  assert.doesNotMatch(renderer,/onDropAt\\?\\.\\(normalized\\.blocks\\.length,event\\)/);\n  assert.match(state,/addBlockDefinition\\(item\\.data,index\\)/);\n  assert.match(state,/function moveBlock\\(id,offset\\)/);",
)

write(
    "tests/builder-drag-drop-precision.test.mjs",
    r'''import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('saved blocks and modules honor the exact top-level drop index',async()=>{
  const [hook,builder]=await Promise.all([
    source('components/use-page-builder.js'),source('components/page-builder.js')
  ]);
  assert.match(hook,/function insertSaved\(item,index\)/);
  assert.match(hook,/addBlockDefinition\(item\.data,index\)/);
  assert.match(hook,/index===undefined\?defaultTopIndex\(true\):index/);
  assert.match(hook,/if\(index===undefined\)\{[\s\S]*?currentModuleTarget/);
  assert.match(builder,/application\/x-marktone-saved-block/);
  assert.match(builder,/application\/x-marktone-saved-module/);
  assert.match(builder,/data-builder-scroll-container="true"/);
});

test('canvas uses magnetic before and after drop targets instead of appending blindly',async()=>{
  const [renderer,css,proCss]=await Promise.all([
    source('components/page-document-renderer.js'),
    source('components/page-document-renderer.module.css'),
    source('components/page-document-renderer-pro.module.css')
  ]);
  assert.match(renderer,/resolveTopDropIndex/);
  assert.match(renderer,/event\.clientY<rect\.top\+rect\.height\/2\?index:index\+1/);
  assert.match(renderer,/data-builder-drop-index/);
  assert.match(renderer,/activeTopDrop/);
  assert.match(renderer,/autoScrollBuilder/);
  assert.match(renderer,/onMoveBlock/);
  assert.doesNotMatch(renderer,/normalized\.blocks\.length,event/);
  assert.match(css,/activeDropZone/);
  assert.match(css,/dropTargetBefore/);
  assert.match(proCss,/precise-column-drop-v1/);
});

test('builder exposes large drag handles and deterministic move buttons',async()=>{
  const renderer=await source('components/page-document-renderer.js');
  assert.match(renderer,/اسحب الشريط لنقل البلوك/);
  assert.match(renderer,/رفع البلوك خطوة/);
  assert.match(renderer,/خفض البلوك خطوة/);
  assert.match(renderer,/onMoveBlock\?\.\(block\.id,-1\)/);
  assert.match(renderer,/onMoveBlock\?\.\(block\.id,1\)/);
});
''',
)

print("Applied remaining precise builder drag-and-drop changes.")
