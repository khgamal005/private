import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('the public ODEIR experience tells the complete fictional trainee journey',async()=>{
  const landing=await read('components/odeir-landing-experience.tsx');
  const integrationBlock=landing.slice(landing.indexOf('const integrationActionSources'),landing.indexOf('const journeyPhases'));
  const stepsBlock=landing.slice(landing.indexOf('const journeySteps'),landing.indexOf('function JourneyPhaseIcon'));
  const runtimeBlock=landing.slice(landing.indexOf('function JourneyLab'),landing.indexOf('const roleViews'));

  assert.match(landing,/href="#story"[\s\S]{0,100}>التكاملات<\/a>/);
  assert.match(landing,/href="#journey"[\s\S]{0,100}>رحلة العميل<\/a>/);
  assert.match(integrationBlock,/function IntegrationActionLab/);
  assert.match(integrationBlock,/className="integration-action-section" id="integrations"/);
  assert.match(integrationBlock,/الإشعار ما يكفي/);
  for(const platform of ['Meta','WhatsApp','سلة','زد','WooCommerce']) assert.match(integrationBlock,new RegExp(platform));
  assert.match(landing,/<IntegrationActionLab \/>[\s\S]*<JourneyLab \/>/);
  assert.match(runtimeBlock,/className="journey-section" id="journey"/);
  assert.doesNotMatch(runtimeBlock,/id="integrations"/);
  assert.match(runtimeBlock,/محاكاة تشغيلية مستوحاة من رحلة فعلية · جميع البيانات افتراضية/);
  assert.match(runtimeBlock,/05•• ••• 4821/);
  assert.match(runtimeBlock,/اسم افتراضي/);

  for(const phase of ['الإعلان والطلب','المبيعات والمتابعة','الإغلاق والقبول','التسجيل والمحاضرات','الرفع والشهادة']){
    assert.match(landing,new RegExp(phase));
  }
  for(const step of ['الإعلان','التقاط الطلب','التوزيع','المتابعة','الإغلاق والدفع','القبول','التسجيل','المحاضرات','الرفع','الشهادة']){
    assert.match(stepsBlock,new RegExp(`label: "${step}"`));
  }
  assert.equal((stepsBlock.match(/\n\s+key: "/g)??[]).length,10);
  assert.match(runtimeBlock,/aria-current=\{index === step \? "step" : undefined\}/);
  assert.match(runtimeBlock,/aria-pressed=\{paused\}/);
  assert.match(runtimeBlock,/visibilitychange/);
  assert.match(runtimeBlock,/IntersectionObserver/);
  assert.match(runtimeBlock,/prefers-reduced-motion: reduce/);
  assert.match(stepsBlock,/جاهز للرفع بعد اكتمال التحقق/);
  assert.match(runtimeBlock,/لا يعني هذا العرض شراكة أو تكاملًا آليًا مباشرًا/);
  assert.doesNotMatch(`${stepsBlock}\n${runtimeBlock}`,/fetch\(|supabase|tenant_id|رفع تلقائي|تم الرفع تلقائي/i);
  assert.doesNotMatch(landing,/ريف|reef/i);
  for(const number of ['04','05','06','07','08']) assert.match(landing,new RegExp(`<span>${number}<\\/span>`));
});

test('the complete journey remains responsive, readable, and motion-aware',async()=>{
  const styles=await read('app/odeir-landing-experience.css');

  for(const selector of ['integration-action-section','integration-action-picker','integration-action-console','integration-action-track','integration-action-rail']){
    assert.match(styles,new RegExp(`\\.${selector}`));
  }
  for(const selector of ['journey-phase-picker','journey-progress','journey-stage-card','journey-stage-facts','journey-authorities','journey-disclaimer']){
    assert.match(styles,new RegExp(`\\.${selector}`));
  }
  assert.match(styles,/grid-template-columns: repeat\(10, minmax\(0,1fr\)\)/);
  assert.match(styles,/@keyframes journey-stage-in/);
  assert.match(styles,/@keyframes journey-live-pulse/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]+\.journey-track \{[^}]+grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(styles,/@media \(max-width: 370px\)[\s\S]+\.journey-phase-picker, \.odeir-experience \.journey-track \{ grid-template-columns: 1fr; \}/);
  assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/);
});
