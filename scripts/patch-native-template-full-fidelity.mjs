import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';

const path='lib/cms-native-template-client.js';
const source=await readFile(path,'utf8');
const before=`  const cssParts=[
    nativeBaseCss(),
    ...externalStyles,
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),`;
const after=`  const cssParts=[
    ...externalStyles,
    nativeBaseCss(),
    ...inlineStyles.map(css=>rewriteCss(css,baseUrl)),`;
assert.ok(source.includes(before),'Missing external style ordering anchor');
await writeFile(path,source.replace(before,after));
console.log('Ordered approved external font styles before native CSS rules.');
