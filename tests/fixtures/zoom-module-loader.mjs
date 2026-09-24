import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
const require=createRequire(import.meta.url);
const root=fileURLToPath(new URL('../../',import.meta.url));
export function moduleLoader(overrides={}){
 const cache=new Map();
 function load(path){
  const absolute=resolve(root,path);if(cache.has(absolute))return cache.get(absolute).exports;
  const mod={exports:{}};cache.set(absolute,mod);
  const dependency=name=>{
   if(Object.hasOwn(overrides,name))return overrides[name];
   const full=name.startsWith('.')?resolve(dirname(absolute),name):name;
   if(Object.hasOwn(overrides,full))return overrides[full];
   if(name==='next/link')return {__esModule:true,default:({children,...props})=>React.createElement('a',props,children)};
   if(name==='server-only')return {};
   if(name.endsWith('.module.css'))return {__esModule:true,default:new Proxy({},{get:(_,key)=>key})};
   if(name.startsWith('.')){
    const file=[full,full+'.js',full+'.jsx',full+'.mjs',full+'.tsx'].find(p=>existsSync(p));
    if(file)return Object.hasOwn(overrides,file)?overrides[file]:load(file);
   }
   return require(name);
  };
  const source=ts.transpileModule(readFileSync(absolute,'utf8'),{fileName:absolute.replace(/\.mjs$/,'.js'),compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`,{filename:absolute})(dependency,mod,mod.exports);
  return mod.exports;
 }
 return load;
}
