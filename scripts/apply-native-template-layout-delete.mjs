import {readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const root=process.cwd();
const operations=JSON.parse(await readFile(join(root,'scripts/native-template-layout-delete-ops.json'),'utf8'));

for(const operation of operations){
  const path=operation.path;
  let source=await readFile(join(root,path),'utf8');
  if(operation.type==='replace'){
    source=replaceOnce(source,operation.from,operation.to,operation.label||path);
  }else if(operation.type==='replaceAll'){
    if(!source.includes(operation.from))fail(operation.label||path,'text not found');
    source=source.split(operation.from).join(operation.to);
  }else if(operation.type==='insertBefore'){
    const index=source.indexOf(operation.marker);
    if(index<0)fail(operation.label||path,'insert marker not found');
    source=source.slice(0,index)+operation.content+source.slice(index);
  }else if(operation.type==='insertAfter'){
    const index=source.indexOf(operation.marker);
    if(index<0)fail(operation.label||path,'insert marker not found');
    const position=index+operation.marker.length;
    source=source.slice(0,position)+operation.content+source.slice(position);
  }else{
    fail(operation.label||path,`unsupported operation ${operation.type}`);
  }
  await writeFile(join(root,path),source,'utf8');
}

for(const path of [
  'scripts/apply-native-template-layout-delete.mjs',
  'scripts/native-template-layout-delete-ops.json',
  '.github/workflows/apply-native-template-layout-delete.yml'
]){
  await rm(join(root,path),{force:true});
}
console.log(`Applied ${operations.length} template layout and library patches.`);

function replaceOnce(source,from,to,label){
  const index=source.indexOf(from);
  if(index<0)fail(label,'text not found');
  if(source.indexOf(from,index+from.length)>=0)fail(label,'text matched more than once');
  return source.slice(0,index)+to+source.slice(index+from.length);
}
function fail(label,message){throw new Error(`${label}: ${message}`)}
