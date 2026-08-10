from __future__ import annotations

from pathlib import Path

OLD_VERSION = "2.0.0-beta.29"
NEW_VERSION = "2.0.0-beta.30"


def replace_once(path: str, old: str, new: str) -> None:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one anchor in {path}, found {count}: {old[:90]!r}")
    file_path.write_text(source.replace(old, new, 1), encoding="utf-8")


replace_once(
    "components/page-builder.js",
    """              onSelect={selectTarget} onDropAt={handleDrop} onDragStart={handleDragStart}
              onDuplicate={duplicateBlock} onDelete={deleteBlock} onMoveBlock={moveBlock} onColumnDrop={handleColumnDrop}
""",
    """              onSelect={selectTarget} onDropAt={handleDrop} onDragStart={handleDragStart}
              onDuplicate={duplicateBlock} onDelete={deleteBlock} onSaveToLibrary={saveToLibrary}
              onMoveBlock={moveBlock} onColumnDrop={handleColumnDrop}
""",
)

replace_once(
    "components/page-builder.js",
    """  function saveToLibrary(kind,data){
    const item={id:`saved-${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`,kind,type:data.type,name:`${kind==='block'?'صف':'موديول'} · ${BLOCK_CATALOG[data.type]?.label||'عنصر محفوظ'}`,data,createdAt:new Date().toISOString()};
    const next=[item,...savedItems].slice(0,60);setSavedItems(next);localStorage.setItem(storageKey,JSON.stringify(next));setNotice({type:'success',text:'تم حفظ العنصر في تبويب Saved.'});setLibraryTab('saved');
  }
""",
    """  function saveToLibrary(kind,data){
    if(!data)return;
    const scope=kind==='block'
      ?data.type==='columns'&&data.props?.row===true?'صف':'بلوك'
      :'موديول';
    const item={
      id:`saved-${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`,
      kind,type:data.type,
      name:`${scope} محفوظ · ${BLOCK_CATALOG[data.type]?.label||'عنصر محفوظ'}`,
      data,createdAt:new Date().toISOString()
    };
    const next=[item,...savedItems].slice(0,60);
    setSavedItems(next);
    localStorage.setItem(storageKey,JSON.stringify(next));
    setNotice({type:'success',text:`تم حفظ ${scope} في المحفوظات ويمكن سحبه إلى أي مكان.`});
    setLibraryOpen(true);
    setLibraryTab('saved');
  }
""",
)

replace_once(
    "components/page-document-renderer.js",
    """  onDuplicate,onDelete,onMoveBlock,onColumnDrop,onModuleDragStart,onDuplicateModule,onDeleteModule,
  onInlineEdit,showOutlines=true
""",
    """  onDuplicate,onDelete,onSaveToLibrary,onMoveBlock,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,showOutlines=true
""",
)

replace_once(
    "components/page-document-renderer.js",
    """      onDelete={onDelete} onMoveBlock={onMoveBlock} onColumnDrop={onColumnDrop}
      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}
""",
    """      onDelete={onDelete} onSaveToLibrary={onSaveToLibrary}
      onMoveBlock={onMoveBlock} onColumnDrop={onColumnDrop}
      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit}
""",
)

replace_once(
    "components/page-document-renderer.js",
    """    onDragStart,onDuplicate,onDelete,onMoveBlock
""",
    """    onDragStart,onDuplicate,onDelete,onSaveToLibrary,onMoveBlock
""",
)

replace_once(
    "components/page-document-renderer.js",
    """        onDuplicate={()=>onDuplicate?.(block.id)}
        onDelete={()=>onDelete?.(block.id)}
""",
    """        onDuplicate={()=>onDuplicate?.(block.id)}
        onSave={()=>onSaveToLibrary?.('block',block)}
        onDelete={()=>onDelete?.(block.id)}
""",
)

replace_once(
    "components/page-document-renderer.js",
    """  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss=''
""",
    """  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss=''
""",
)

replace_once(
    "components/page-document-renderer.js",
    """        onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule}
        onInlineEdit={onInlineEdit} pageCss={pageCss}
""",
    """        onDuplicateModule={onDuplicateModule} onDeleteModule={onDeleteModule}
        onSaveToLibrary={onSaveToLibrary} onInlineEdit={onInlineEdit} pageCss={pageCss}
""",
)

replace_once(
    "components/page-document-renderer.js",
    """  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
""",
    """  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
""",
)

replace_once(
    "components/page-document-renderer.js",
    """      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onInlineEdit={onInlineEdit} pageCss={pageCss}
""",
    """      onModuleDragStart={onModuleDragStart} onDuplicateModule={onDuplicateModule}
      onDeleteModule={onDeleteModule} onSaveToLibrary={onSaveToLibrary}
      onInlineEdit={onInlineEdit} pageCss={pageCss}
""",
)

replace_once(
    "components/page-document-renderer.js",
    """  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
""",
    """  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
}){
""",
)

replace_once(
    "components/page-document-renderer.js",
    """        <button type=\"button\" onClick={event=>{
          event.stopPropagation();
          onDeleteModule?.(row.id,column.id,module.id);
        }}>حذف</button>
""",
    """        <button
          type=\"button\" className={styles.saveToolbarButton}
          title=\"حفظ الموديول في المحفوظات\"
          onClick={event=>{
            event.stopPropagation();
            onSaveToLibrary?.('module',module);
          }}
        >☆ حفظ</button>
        <button type=\"button\" onClick={event=>{
          event.stopPropagation();
          onDeleteModule?.(row.id,column.id,module.id);
        }}>حذف</button>
""",
)

replace_once(
    "components/page-document-renderer.js",
    """  label,detail,hidden,onDragStart,onDuplicate,onDelete,
  canMoveUp,canMoveDown,onMoveUp,onMoveDown
""",
    """  label,detail,hidden,onDragStart,onDuplicate,onSave,onDelete,
  canMoveUp,canMoveDown,onMoveUp,onMoveDown
""",
)

replace_once(
    "components/page-document-renderer.js",
    """    <button type=\"button\" draggable={false} onClick={event=>{
      event.stopPropagation();onDuplicate();
    }}>نسخ</button>
    <button type=\"button\" draggable={false} onClick={event=>{
      event.stopPropagation();onDelete();
    }}>حذف</button>
""",
    """    <button type=\"button\" draggable={false} onClick={event=>{
      event.stopPropagation();onDuplicate();
    }}>نسخ</button>
    <button
      type=\"button\" draggable={false} className={styles.saveToolbarButton}
      title=\"حفظ البلوك في المحفوظات\"
      onClick={event=>{event.stopPropagation();onSave?.();}}
    >☆ حفظ</button>
    <button type=\"button\" draggable={false} onClick={event=>{
      event.stopPropagation();onDelete();
    }}>حذف</button>
""",
)

css_path = Path("components/page-document-renderer.module.css")
css = css_path.read_text(encoding="utf-8")
marker = "/* builder-toolbar-save-v1 */"
if marker in css:
    raise RuntimeError("Save toolbar CSS already exists")
css += """
/* builder-toolbar-save-v1 */
.saveToolbarButton{background:rgba(230,179,78,.2)!important;color:#ffe7a6!important;border:1px solid rgba(230,179,78,.45)!important;font-weight:900!important}
.saveToolbarButton:hover{background:#e6b34e!important;color:#06182e!important;border-color:#e6b34e!important}
"""
css_path.write_text(css, encoding="utf-8")

for path in [
    "package.json",
    "package-lock.json",
    "components/page-builder-with-library.js",
]:
    file_path = Path(path)
    source = file_path.read_text(encoding="utf-8")
    if OLD_VERSION not in source:
        raise RuntimeError(f"Missing {OLD_VERSION} in {path}")
    file_path.write_text(source.replace(OLD_VERSION, NEW_VERSION), encoding="utf-8")

for test_path in Path("tests").glob("*.test.mjs"):
    source = test_path.read_text(encoding="utf-8")
    if OLD_VERSION in source:
        test_path.write_text(source.replace(OLD_VERSION, NEW_VERSION), encoding="utf-8")

Path("tests/builder-toolbar-save.test.mjs").write_text(
    """import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const root=new URL('../',import.meta.url);
const source=path=>readFile(new URL(path,root),'utf8');

test('block and module toolbars expose one-click save beside delete',async()=>{
  const [builder,renderer,css,wrapper,pkg]=await Promise.all([
    source('components/page-builder.js'),
    source('components/page-document-renderer.js'),
    source('components/page-document-renderer.module.css'),
    source('components/page-builder-with-library.js'),
    source('package.json')
  ]);
  assert.match(builder,/onSaveToLibrary=\{saveToLibrary\}/);
  assert.match(builder,/setLibraryTab\('saved'\)/);
  assert.match(renderer,/onSave=\{\(\)=>onSaveToLibrary\?\.\('block',block\)\}/);
  assert.match(renderer,/onSaveToLibrary\?\.\('module',module\)/);
  assert.match(renderer,/حفظ البلوك في المحفوظات/);
  assert.match(renderer,/حفظ الموديول في المحفوظات/);
  assert.match(renderer,/☆ حفظ/);
  assert.match(css,/builder-toolbar-save-v1/);
  assert.match(wrapper,/2\.0\.0-beta\.30/);
  assert.equal(JSON.parse(pkg).version,'2.0.0-beta.30');
});
""",
    encoding="utf-8",
)

print("Applied one-click save buttons to builder toolbars.")
