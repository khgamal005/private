import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('journey and payment marks do not depend on fragile lazy or third-party loading',async()=>{
  const [landing,styles]=await Promise.all([
    read('components/odeir-landing-experience.tsx'),
    read('app/odeir-landing-experience.css')
  ]);

  assert.match(landing,/<img className=\{source\.logoClass \?\? ""\}[^>]+loading="eager"[^>]+decoding="async"/);
  assert.doesNotMatch(landing,/cdn\.prod\.website-files\.com|paymob\.com\/images|sama\.gov\.sa|cdn\.visa\.com|mastercard\.com\/content/);
  for(const mark of ['payment-wordmark--tamara','payment-wordmark--paymob','payment-wordmark--mada','payment-wordmark--visa','payment-mastercard-mark']){
    assert.match(`${landing}\n${styles}`,new RegExp(mark));
  }
});
