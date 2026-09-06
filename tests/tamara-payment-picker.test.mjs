import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../components/payment-method-picker.js',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
const componentModule={exports:{}};
vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`)(name=>name.endsWith('.css')?{__esModule:true,default:new Proxy({},{get:(_,key)=>key})}:require(name),componentModule,componentModule.exports);
const {PaymentMethodPicker,PaymobOptionPicker}=componentModule.exports;
const methods=[{key:'bank_transfer',name:'التحويل البنكي'},{key:'paymob',name:'البطاقات',paymentOptions:[{key:'card',name:'بطاقة'}]},{key:'tamara',name:'تمارا'}];
const render=(component,props)=>new JSDOM(renderToStaticMarkup(React.createElement(component,props))).window.document;

test('payment picker uses native mutually exclusive radios and local brand assets',()=>{
 const doc=render(PaymentMethodPicker,{methods,value:'tamara',onChange(){}});
 const radios=[...doc.querySelectorAll('input[type=radio]')];assert.equal(radios.length,3);
 assert.equal(new Set(radios.map(x=>x.name)).size,1);assert.equal(radios.filter(x=>x.checked).length,1);
 assert.equal(radios.find(x=>x.checked).value,'tamara');assert.ok(doc.querySelector('legend').textContent.includes('وسيلة الدفع'));
 assert.ok(doc.querySelector('img[src="/payment-brands/tamara-ar.svg"]'));
 assert.ok(doc.querySelector('img[src="/payment-brands/visa.svg"]'));
 assert.ok(doc.querySelector('img[src="/payment-brands/mastercard.svg"]'));
 assert.equal(doc.querySelector('img[src="/payment-brands/apple-pay-v2.svg"]'),null);
});
test('Apple Pay is shown only for a server-supplied available option',()=>{
 const enabled=[methods[0],{...methods[1],paymentOptions:[{key:'card',name:'بطاقة'},{key:'apple_pay',name:'Apple Pay'}]},methods[2]];
 const doc=render(PaymentMethodPicker,{methods:enabled,value:'paymob',onChange(){}});
 assert.ok(doc.querySelector('img[src="/payment-brands/apple-pay-v2.svg"]'));
 const options=render(PaymobOptionPicker,{paymentMethods:enabled,value:'apple_pay',onChange(){}});
 assert.equal(options.querySelectorAll('input[type=radio]').length,2);
 assert.equal(options.querySelector('input:checked').value,'apple_pay');
});
test('Tamara is absent when the server has not enabled it',()=>{
 const doc=render(PaymentMethodPicker,{methods:methods.slice(0,2),value:'paymob',onChange(){}});
 assert.equal(doc.querySelector('input[value=tamara]'),null);
 assert.equal(doc.querySelector('img[src="/payment-brands/tamara-ar.svg"]'),null);
});
