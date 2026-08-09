import {readFile,rm,writeFile} from 'node:fs/promises';

const replacements=[
  {
    path:'components/native-template-section.js',
    from:"      if(isPageShell(current)||current.hasAttribute('data-marktone-native-shell'))candidates.add(current);",
    to:"      if(depth===0||current.hasAttribute('data-marktone-native-content')||isPageShell(current)||current.hasAttribute('data-marktone-native-shell'))candidates.add(current);"
  },
  {
    path:'components/native-template-section.js',
    from:"  const pageLike=forced||element.hasAttribute('data-marktone-native-section')||isPageShell(element);",
    to:"  const pageLike=forced||element.hasAttribute('data-marktone-native-section')||element.hasAttribute('data-marktone-native-content')||isPageShell(element);"
  },
  {
    path:'components/page-builder.module.css',
    from:'.templateCatalogActions{display:flex;align-items:center;justify-content:flex-end;gap:5px}',
    to:'.templateCatalog>article>.templateCatalogActions{display:flex;align-items:center;justify-content:flex-end;gap:5px}'
  },
  {
    path:'components/page-builder.module.css',
    from:'.templateCatalogActions button{white-space:nowrap}',
    to:'.templateCatalog>article>.templateCatalogActions button{white-space:nowrap}'
  },
  {
    path:'components/page-builder.module.css',
    from:'.templateCatalogActions .templateDeleteButton{background:#fff1ef;color:#a53d38;border:1px solid #efc9c4}',
    to:'.templateCatalog>article>.templateCatalogActions .templateDeleteButton{background:#fff1ef;color:#a53d38;border:1px solid #efc9c4}'
  },
  {
    path:'components/page-builder.module.css',
    from:'.templateCatalogActions .templateDeleteButton:hover{background:#ffe2df}',
    to:'.templateCatalog>article>.templateCatalogActions .templateDeleteButton:hover{background:#ffe2df}'
  },
  {
    path:'components/page-builder.module.css',
    from:'.templateCatalogActions button:disabled{opacity:.52;cursor:wait}',
    to:'.templateCatalog>article>.templateCatalogActions button:disabled{opacity:.52;cursor:wait}'
  }
];

for(const item of replacements){
  let source=await readFile(item.path,'utf8');
  const index=source.indexOf(item.from);
  if(index<0)throw new Error(`${item.path}: text not found`);
  source=source.slice(0,index)+item.to+source.slice(index+item.from.length);
  await writeFile(item.path,source,'utf8');
}

await rm('scripts/refine-native-template-layout.mjs',{force:true});
await rm('.github/workflows/refine-native-template-layout.yml',{force:true});
