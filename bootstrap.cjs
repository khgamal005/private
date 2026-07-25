const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const zlib=require('zlib');

const expected='cb4806df0defd4b62c9510c493c7dd290a532495afaaa20eaf753f7d2a573f5a';
const parts=[0,1,2,3].map(i=>fs.readFileSync(path.join(__dirname,`release-1.3.0.part${i}`),'utf8').trim());
const encoded=parts.join('');
const actual=crypto.createHash('sha256').update(encoded).digest('hex');
if(actual!==expected)throw new Error(`Release artifact checksum mismatch: ${actual}`);
const compressed=Buffer.from(encoded,'base64');
const source=JSON.parse(zlib.brotliDecompressSync(compressed).toString('utf8'));
for(const target of ['app','components','lib','public'])fs.rmSync(path.join(__dirname,target),{recursive:true,force:true});
for(const [file,data] of Object.entries(source)){
  const destination=path.join(__dirname,file);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,data,'utf8');
}
console.log(`Marktone release 1.3.0 restored: ${Object.keys(source).length} files`);
