const fs=require('fs');
const zlib=require('zlib');
const encoded=fs.readFileSync('knowledge-feature.part0','utf8').trim()+fs.readFileSync('knowledge-feature.part1','utf8').trim();
const source=zlib.gunzipSync(Buffer.from(encoded,'base64')).toString('utf8');
fs.writeFileSync('knowledge-feature-patch.cjs',source,'utf8');
require('./knowledge-feature-patch.cjs');
