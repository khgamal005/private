import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const [helper,addons,services,returnClient]=await Promise.all([
  'lib/paymob-checkout-window.js',
  'components/marketplace-addon-store-v2.js',
  'components/marketplace-store.js',
  'components/paymob-return-status.js'
].map(path=>readFile(new URL(path,root),'utf8')));

test('QuickLink opens separately while ODEIR keeps the verified status page',()=>{
  assert.match(helper,/popup=yes/);
  assert.match(helper,/checkoutWindow\.opener=null/);
  assert.match(helper,/new Set\(\[[\s\S]*?'ksa\.paymob\.com'[\s\S]*?'ksa\.checkout\.paymob\.com'/);
  assert.match(helper,/candidate\.location\.replace\(url\.toString\(\)\)/);
  assert.match(helper,/validPaymobPath\(url\)/);
  assert.match(helper,/checkoutWindow\.close\(\)/);
  assert.doesNotMatch(helper,/localStorage|sessionStorage|document\.cookie/);

  for(const [name,source] of [['addons',addons],['services',services]]){
    assert.match(source,/openPaymobCheckoutWindow/);
    assert.match(source,/navigatePaymobCheckoutWindow/);
    assert.match(source,/redirectToPaymob\(order,paymentRequestKey,paymentWindow=null\)/);
    assert.match(source,/navigatePaymobCheckoutWindow\(paymentWindow,checkoutUrl\)[\s\S]*?router\.push\(returnUrl\)/);
    assert.match(source,/window\.location\.assign\(checkoutUrl\)/,`${name} keeps a popup-blocker fallback`);

    for(const functionName of ['createOrder','continuePaymob']){
      const start=source.indexOf(`async function ${functionName}`);
      const end=source.indexOf('\n  async function ',start+20);
      const body=source.slice(start,end===-1?source.length:end);
      const openAt=body.indexOf('openPaymobCheckoutWindow()');
      const awaitAt=body.indexOf('await ');
      assert.ok(openAt>0&&awaitAt>openAt,`${name} ${functionName} must open before the first await`);
    }
  }
});

test('terminal server state closes Paymob and decline offers a direct retry path',()=>{
  assert.match(returnClient,/closePaymobCheckoutWindow/);
  assert.match(returnClient,/const finish=nextPhase=>\{[\s\S]*?closePaymobCheckoutWindow\(\)[\s\S]*?setPhase\(nextPhase\)/);
  assert.match(returnClient,/result\.resultCode==='issuer_declined_retry_available'[\s\S]*?closePaymobCheckoutWindow\(\)[\s\S]*?setPhase\('declined'\)/);
  assert.match(returnClient,/phase==='declined'[\s\S]*?المحاولة ببطاقة أخرى/);
  assert.doesNotMatch(returnClient,/تحقق بعد إعادة المحاولة/);
});
