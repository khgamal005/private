import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

const path='scripts/patch-precise-builder-drag-drop.mjs';
let source=await readFile(path,'utf8');
const replacements=[
  [
    "className={\\`${styles.document} \\${styles[\\`device_\\${device}\\`]||''} \\${editor&&showOutlines?styles.showOutlines:''} \\${dragActive?styles.draggingDocument:''}\\`}",
    "className={[styles.document,styles[`device_${device}`]||'',editor&&showOutlines?styles.showOutlines:'',dragActive?styles.draggingDocument:''].filter(Boolean).join(' ')}"
  ],
  [
    "className={\\`${styles.editorBlockWrap} \\${dropBefore?styles.dropTargetBefore:''} \\${dropAfter?styles.dropTargetAfter:''}\\`}",
    "className={[styles.editorBlockWrap,dropBefore?styles.dropTargetBefore:'',dropAfter?styles.dropTargetAfter:''].filter(Boolean).join(' ')}"
  ],
  [
    "<article className={\\`${styles.editorBlock} \\${row?styles.editorRow:''} \\${selected?styles.selected:''} \\${hidden?styles.hiddenInDevice:''}\\`}",
    "<article className={[styles.editorBlock,row?styles.editorRow:'',selected?styles.selected:'',hidden?styles.hiddenInDevice:''].filter(Boolean).join(' ')}"
  ],
  [
    "className={\\`${styles.dropZone} \\${active?styles.activeDropZone:''}\\`}",
    "className={[styles.dropZone,active?styles.activeDropZone:''].filter(Boolean).join(' ')}"
  ]
];
for(const [before,after] of replacements){
  assert.ok(source.includes(before),`Missing repair anchor: ${before.slice(0,80)}`);
  source=source.replace(before,after);
}
await writeFile(path,source);
console.log('Repaired literal JSX templates in precise drag-drop patch.');
