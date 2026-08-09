import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';

export const TEMPLATE_ARCHIVE_LIMITS=Object.freeze({
  compressedBytes:20*1024*1024,
  uncompressedBytes:64*1024*1024,
  fileBytes:20*1024*1024,
  files:250,
  compressionRatio:100
});

const MIME_TYPES=Object.freeze({
  '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.json':'application/json; charset=utf-8','.txt':'text/plain; charset=utf-8',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.gif':'image/gif',
  '.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.ico':'image/x-icon',
  '.mp4':'video/mp4','.webm':'video/webm','.ogv':'video/ogg',
  '.mp3':'audio/mpeg','.wav':'audio/wav','.ogg':'audio/ogg','.m4a':'audio/mp4',
  '.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'
});

const ARCHIVE_EXTENSIONS=new Set(['.zip','.rar','.7z','.tar','.gz','.tgz','.bz2','.xz']);
const IGNORED_NAMES=new Set(['.ds_store','thumbs.db']);

export function parseTemplateArchive(input,limits=TEMPLATE_ARCHIVE_LIMITS){
  const archive=Buffer.isBuffer(input)?input:Buffer.from(input);
  if(archive.length<22)fail('archive_invalid','الملف المضغوط غير صالح.');
  if(archive.length>limits.compressedBytes)fail('archive_too_large','حجم ملف ZIP يتجاوز 20 ميجابايت.');

  const eocd=findEndOfCentralDirectory(archive);
  const disk=archive.readUInt16LE(eocd+4);
  const centralDisk=archive.readUInt16LE(eocd+6);
  const entriesOnDisk=archive.readUInt16LE(eocd+8);
  const entryCount=archive.readUInt16LE(eocd+10);
  const centralSize=archive.readUInt32LE(eocd+12);
  const centralOffset=archive.readUInt32LE(eocd+16);
  if(disk||centralDisk||entriesOnDisk!==entryCount)fail('archive_multidisk','ملفات ZIP متعددة الأجزاء غير مدعومة.');
  if(entryCount===0xffff||centralSize===0xffffffff||centralOffset===0xffffffff)fail('archive_zip64','صيغة ZIP64 غير مدعومة.');
  if(entryCount>limits.files+32)fail('archive_files_limit',`القالب يتجاوز ${limits.files} ملفًا.`);
  if(centralOffset+centralSize>eocd)fail('archive_invalid','فهرس ZIP غير صالح.');

  const rawEntries=[];
  const seen=new Set();
  let cursor=centralOffset;
  let totalUncompressed=0;
  for(let index=0;index<entryCount;index+=1){
    if(cursor+46>archive.length||archive.readUInt32LE(cursor)!==0x02014b50)fail('archive_invalid','فهرس ZIP تالف.');
    const versionMadeBy=archive.readUInt16LE(cursor+4);
    const flags=archive.readUInt16LE(cursor+8);
    const method=archive.readUInt16LE(cursor+10);
    const crc=archive.readUInt32LE(cursor+16);
    const compressedSize=archive.readUInt32LE(cursor+20);
    const size=archive.readUInt32LE(cursor+24);
    const nameLength=archive.readUInt16LE(cursor+28);
    const extraLength=archive.readUInt16LE(cursor+30);
    const commentLength=archive.readUInt16LE(cursor+32);
    const diskStart=archive.readUInt16LE(cursor+34);
    const externalAttributes=archive.readUInt32LE(cursor+38);
    const localOffset=archive.readUInt32LE(cursor+42);
    const next=cursor+46+nameLength+extraLength+commentLength;
    if(next>centralOffset+centralSize||diskStart!==0)fail('archive_invalid','بيانات ZIP غير متسقة.');
    if(flags&1)fail('archive_encrypted','ملفات ZIP المشفرة غير مدعومة.');
    if(method!==0&&method!==8)fail('archive_method','يحتوي ZIP على طريقة ضغط غير مدعومة.');
    const nameBytes=archive.subarray(cursor+46,cursor+46+nameLength);
    const originalName=decodeName(nameBytes,Boolean(flags&0x800));
    const path=normalizeArchivePath(originalName);
    cursor=next;
    if(!path||isIgnoredPath(path))continue;
    const unixHost=(versionMadeBy>>>8)===3;
    const mode=(externalAttributes>>>16)&0xffff;
    if(unixHost&&(mode&0o170000)===0o120000)fail('archive_symlink','الروابط الرمزية داخل ZIP غير مسموحة.');
    if(path.endsWith('/'))continue;
    const duplicateKey=path.normalize('NFC').toLocaleLowerCase('en-US');
    if(seen.has(duplicateKey))fail('archive_duplicate','يحتوي ZIP على أسماء ملفات مكررة.');
    seen.add(duplicateKey);
    const extension=fileExtension(path);
    if(ARCHIVE_EXTENSIONS.has(extension))fail('archive_nested','الأرشيفات المتداخلة غير مسموحة.');
    if(!MIME_TYPES[extension])fail('archive_file_type',`نوع الملف غير مدعوم: ${path}`);
    if(size>limits.fileBytes)fail('archive_file_too_large',`الملف ${path} أكبر من الحد المسموح.`);
    if(size>1024*1024&&size/Math.max(1,compressedSize)>limits.compressionRatio)fail('archive_ratio','نسبة الضغط غير آمنة.');
    totalUncompressed+=size;
    if(totalUncompressed>limits.uncompressedBytes)fail('archive_uncompressed_limit','حجم القالب بعد فك الضغط يتجاوز 64 ميجابايت.');
    rawEntries.push({path,flags,method,crc,compressedSize,size,localOffset,mimeType:MIME_TYPES[extension]});
  }
  if(rawEntries.length<1)fail('archive_empty','لا يحتوي ZIP على ملفات قابلة للاستيراد.');
  if(rawEntries.length>limits.files)fail('archive_files_limit',`القالب يتجاوز ${limits.files} ملفًا.`);

  const indexCandidates=rawEntries.filter(entry=>/(^|\/)index\.html$/i.test(entry.path));
  if(indexCandidates.length!==1)fail('archive_index','يجب أن يحتوي القالب على ملف index.html واحد فقط.');
  const root=indexCandidates[0].path.slice(0,-'index.html'.length);
  const files=[];
  const normalizedSeen=new Set();
  for(const entry of rawEntries){
    if(root&&!entry.path.startsWith(root))fail('archive_root','يجب أن تكون كل ملفات القالب داخل مجلد index.html نفسه.');
    const relativePath=root?entry.path.slice(root.length):entry.path;
    if(!relativePath)continue;
    const key=relativePath.normalize('NFC').toLocaleLowerCase('en-US');
    if(normalizedSeen.has(key))fail('archive_duplicate','أسماء الملفات تتعارض بعد توحيد المسار.');
    normalizedSeen.add(key);
    const data=extractEntry(archive,entry);
    verifySignature(relativePath,entry.mimeType,data);
    files.push({
      path:relativePath,mimeType:entry.mimeType,size:data.length,
      sha256:createHash('sha256').update(data).digest('hex'),data
    });
  }
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  return {files,indexPath:'index.html',totalBytes:files.reduce((sum,file)=>sum+file.size,0)};
}

export function prepareTemplateIndex(input,publicBaseUrl){
  const html=new TextDecoder('utf-8',{fatal:true}).decode(input).replace(/<base\b[^>]*>/gi,'');
  const base=String(publicBaseUrl||'').replace(/\/$/,'')+'/';
  if(!/^https:\/\//i.test(base))fail('template_base_invalid','مسار القالب غير صالح.');
  const assetOrigin=new URL(base).origin;
  const policy=[
    "default-src 'none'",`script-src ${assetOrigin} 'unsafe-inline'`,`style-src ${assetOrigin} 'unsafe-inline'`,
    `img-src ${assetOrigin} data: blob:`,`media-src ${assetOrigin} data: blob:`,`font-src ${assetOrigin} data:`,
    "connect-src 'none'","frame-src 'none'","object-src 'none'",`base-uri ${assetOrigin}`,"form-action 'none'"
  ].join('; ');
  const guard=`<meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><base href="${escapeAttribute(base)}">`;
  const bridge='<script data-marktone-bridge>!function(){var t=0;function s(){cancelAnimationFrame(t);t=requestAnimationFrame(function(){var d=document.documentElement,b=document.body,h=Math.max(d?d.scrollHeight:0,b?b.scrollHeight:0,320);parent.postMessage({type:"marktone:template-height",height:h},"*")})}addEventListener("load",s);addEventListener("resize",s);if(window.ResizeObserver){new ResizeObserver(s).observe(document.documentElement)}if(window.MutationObserver){new MutationObserver(s).observe(document.documentElement,{subtree:true,childList:true,attributes:true,characterData:true})}s()}();</script>';
  const guarded=/<head[\s>]/i.test(html)?html.replace(/<head([^>]*)>/i,`<head$1>${guard}`):`<!doctype html><html><head>${guard}</head><body>${html}</body></html>`;
  const output=/<\/body\s*>/i.test(guarded)?guarded.replace(/<\/body\s*>/i,`${bridge}</body>`):`${guarded}${bridge}`;
  return Buffer.from(output,'utf8');
}

function findEndOfCentralDirectory(buffer){
  const minimum=Math.max(0,buffer.length-65557);
  for(let offset=buffer.length-22;offset>=minimum;offset-=1){
    if(buffer.readUInt32LE(offset)===0x06054b50){
      const commentLength=buffer.readUInt16LE(offset+20);
      if(offset+22+commentLength===buffer.length)return offset;
    }
  }
  fail('archive_invalid','تعذر العثور على نهاية ملف ZIP.');
}

function decodeName(bytes,utf8){
  if(!utf8&&bytes.some(byte=>byte>0x7f))fail('archive_filename_encoding','يجب أن تستخدم أسماء الملفات UTF-8.');
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}catch{fail('archive_filename_encoding','ترميز اسم ملف داخل ZIP غير صالح.');}
}

function normalizeArchivePath(value){
  const path=String(value||'').normalize('NFC');
  if(!path||path.includes('\0')||path.includes('\\')||path.startsWith('/')||/^[a-z]:/i.test(path)||path.includes('//'))fail('archive_path','يحتوي ZIP على مسار ملف غير آمن.');
  const directory=path.endsWith('/');
  const parts=path.split('/').filter(Boolean);
  if(parts.some(part=>part==='.'||part==='..'))fail('archive_path','يحتوي ZIP على محاولة خروج من مجلد القالب.');
  return parts.join('/')+(directory?'/':'');
}

function isIgnoredPath(path){
  const parts=path.split('/').filter(Boolean);
  return parts[0]?.toLowerCase()==='__macosx'||IGNORED_NAMES.has(parts.at(-1)?.toLowerCase());
}

function extractEntry(archive,entry){
  const offset=entry.localOffset;
  if(offset+30>archive.length||archive.readUInt32LE(offset)!==0x04034b50)fail('archive_invalid','رأس ملف داخل ZIP تالف.');
  const localFlags=archive.readUInt16LE(offset+6);
  const localMethod=archive.readUInt16LE(offset+8);
  const nameLength=archive.readUInt16LE(offset+26);
  const extraLength=archive.readUInt16LE(offset+28);
  if((localFlags&1)||localMethod!==entry.method)fail('archive_invalid','بيانات ملف ZIP غير متطابقة.');
  const start=offset+30+nameLength+extraLength;
  const end=start+entry.compressedSize;
  if(start<0||end>archive.length)fail('archive_invalid','بيانات ملف ZIP خارج الحدود.');
  const compressed=archive.subarray(start,end);
  let data;
  try{data=entry.method===0?Buffer.from(compressed):inflateRawSync(compressed,{maxOutputLength:Math.max(1,entry.size)});}
  catch{fail('archive_inflate','تعذر فك أحد ملفات القالب بأمان.');}
  if(data.length!==entry.size||crc32(data)!==entry.crc)fail('archive_integrity','فشل التحقق من سلامة أحد ملفات القالب.');
  return data;
}

function verifySignature(path,mimeType,data){
  if(mimeType==='image/png'&&!starts(data,[0x89,0x50,0x4e,0x47]))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='image/jpeg'&&!starts(data,[0xff,0xd8,0xff]))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='image/gif'&&!['GIF87a','GIF89a'].includes(data.subarray(0,6).toString('ascii')))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='image/webp'&&!(data.subarray(0,4).toString('ascii')==='RIFF'&&data.subarray(8,12).toString('ascii')==='WEBP'))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='video/mp4'&&data.subarray(4,8).toString('ascii')!=='ftyp')fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='video/webm'&&!starts(data,[0x1a,0x45,0xdf,0xa3]))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType==='image/svg+xml'&&!/<svg[\s>]/i.test(data.subarray(0,4096).toString('utf8')))fail('archive_mime',`محتوى ${path} لا يطابق امتداده.`);
  if(mimeType.startsWith('text/html')){
    try{new TextDecoder('utf-8',{fatal:true}).decode(data)}catch{fail('archive_encoding',`ملف ${path} ليس UTF-8 صالحًا.`);}
  }
}

function fileExtension(path){const name=path.slice(path.lastIndexOf('/')+1).toLowerCase();const index=name.lastIndexOf('.');return index<0?'':name.slice(index)}
function starts(buffer,bytes){return bytes.every((byte,index)=>buffer[index]===byte)}
function escapeAttribute(value){return String(value).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;')}

let crcTable;
function crc32(buffer){
  if(!crcTable)crcTable=Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k+=1)c=(c&1)?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
  let crc=0xffffffff;
  for(const byte of buffer)crc=crcTable[(crc^byte)&0xff]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}

function fail(code,message){const error=new Error(message);error.code=code;throw error}
