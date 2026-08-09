import assert from 'node:assert/strict';
import test from 'node:test';
import {deflateRawSync} from 'node:zlib';
import {parseTemplateArchive,prepareTemplateIndex} from '../lib/cms-template-archive.js';

test('accepts a rooted website archive and injects an isolated CSP',()=>{
  const archive=zip([
    {name:'site/index.html',data:'<!doctype html><html><head><base href="https://evil.test/"></head><body><script src="assets/app.js"></script></body></html>'},
    {name:'site/assets/app.js',data:'document.body.dataset.ready="yes"'},
    {name:'site/assets/app.css',data:'body{color:#123}'}
  ]);
  const parsed=parseTemplateArchive(archive);
  assert.deepEqual(parsed.files.map(file=>file.path),['assets/app.css','assets/app.js','index.html']);
  const index=parsed.files.find(file=>file.path==='index.html');
  const html=prepareTemplateIndex(index.data,'https://project.supabase.co/storage/v1/object/public/cms-template-assets/site/template/r1').toString();
  assert.match(html,/connect-src 'none'/);
  assert.match(html,/form-action 'none'/);
  assert.match(html,/script-src https:\/\/project\.supabase\.co 'unsafe-inline'/);
  assert.doesNotMatch(html,/https:\/\/evil\.test/);
});

test('rejects path traversal and Windows paths',()=>{
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'../escape.js',data:'x'}])),error=>error.code==='archive_path');
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'C:\\escape.js',data:'x'}])),error=>error.code==='archive_path');
});

test('rejects duplicate normalized names and nested archives',()=>{
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'A.css',data:'x'},{name:'a.css',data:'y'}])),error=>error.code==='archive_duplicate');
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'payload.zip',data:'x'}])),error=>error.code==='archive_nested');
});

test('rejects encrypted files and symbolic links',()=>{
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok',flags:1}])),error=>error.code==='archive_encrypted');
  assert.throws(()=>parseTemplateArchive(zip([
    {name:'index.html',data:'ok'},
    {name:'link.js',data:'target',versionMadeBy:(3<<8)|20,externalAttributes:(0o120777<<16)>>>0}
  ])),error=>error.code==='archive_symlink');
});

test('rejects missing or multiple index files',()=>{
  assert.throws(()=>parseTemplateArchive(zip([{name:'app.js',data:'x'}])),error=>error.code==='archive_index');
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'x'},{name:'nested/index.html',data:'y'}])),error=>error.code==='archive_index');
});

test('rejects suspicious compression ratios before inflation',()=>{
  const data=Buffer.alloc(2*1024*1024,65);
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'large.txt',data,method:8}])),error=>error.code==='archive_ratio');
});

test('rejects MIME mismatches for executable image formats',()=>{
  assert.throws(()=>parseTemplateArchive(zip([{name:'index.html',data:'ok'},{name:'fake.png',data:'not a png'}])),error=>error.code==='archive_mime');
});

function zip(entries){
  const local=[];const central=[];let offset=0;
  for(const entry of entries){
    const name=Buffer.from(entry.name,'utf8');
    const data=Buffer.isBuffer(entry.data)?entry.data:Buffer.from(entry.data||'');
    const method=entry.method||0;
    const compressed=method===8?deflateRawSync(data):data;
    const flags=(entry.flags||0)|0x800;
    const crc=crc32(data);
    const localHeader=Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50,0);localHeader.writeUInt16LE(20,4);
    localHeader.writeUInt16LE(flags,6);localHeader.writeUInt16LE(method,8);
    localHeader.writeUInt32LE(crc,14);localHeader.writeUInt32LE(compressed.length,18);
    localHeader.writeUInt32LE(data.length,22);localHeader.writeUInt16LE(name.length,26);
    local.push(localHeader,name,compressed);
    const centralHeader=Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50,0);
    centralHeader.writeUInt16LE(entry.versionMadeBy||20,4);centralHeader.writeUInt16LE(20,6);
    centralHeader.writeUInt16LE(flags,8);centralHeader.writeUInt16LE(method,10);
    centralHeader.writeUInt32LE(crc,16);centralHeader.writeUInt32LE(compressed.length,20);
    centralHeader.writeUInt32LE(data.length,24);centralHeader.writeUInt16LE(name.length,28);
    centralHeader.writeUInt32LE(entry.externalAttributes||0,38);centralHeader.writeUInt32LE(offset,42);
    central.push(centralHeader,name);
    offset+=localHeader.length+name.length+compressed.length;
  }
  const localData=Buffer.concat(local);const centralData=Buffer.concat(central);const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(localData.length,16);
  return Buffer.concat([localData,centralData,end]);
}

let table;
function crc32(buffer){
  if(!table)table=Array.from({length:256},(_,n)=>{let c=n;for(let i=0;i<8;i+=1)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  let value=0xffffffff;for(const byte of buffer)value=table[(value^byte)&0xff]^(value>>>8);return (value^0xffffffff)>>>0;
}
