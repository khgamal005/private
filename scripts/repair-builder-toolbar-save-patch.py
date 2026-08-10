from pathlib import Path

path = Path('scripts/patch-builder-toolbar-save.py')
source = path.read_text(encoding='utf-8')

old_first = '''replace_once(
    "components/page-document-renderer.js",
    """  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
""",
    """  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
""",
)
'''
new_first = '''replace_once(
    "components/page-document-renderer.js",
    """function Column({
  row,column,columnIndex,editor,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
""",
    """function Column({
  row,column,columnIndex,editor,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
}){
""",
)
'''

old_second = '''replace_once(
    "components/page-document-renderer.js",
    """  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
""",
    """  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
}){
""",
)
'''
new_second = '''replace_once(
    "components/page-document-renderer.js",
    """function NestedModule({
  row,column,module,moduleIndex,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onInlineEdit,pageCss
}){
""",
    """function NestedModule({
  row,column,module,moduleIndex,device,selection,onSelect,onColumnDrop,onModuleDragStart,
  onDuplicateModule,onDeleteModule,onSaveToLibrary,onInlineEdit,pageCss
}){
""",
)
'''

if source.count(old_first) != 1 or source.count(old_second) != 1:
    raise RuntimeError('Could not find duplicate renderer signature anchors to repair')
source = source.replace(old_first, new_first, 1).replace(old_second, new_second, 1)
path.write_text(source, encoding='utf-8')
print('Repaired renderer signature anchors in save toolbar patch.')
