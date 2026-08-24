import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('the public ODEIR experience tells the complete fictional trainee journey',async()=>{
  const landing=await read('components/odeir-landing-experience.tsx');
  const stepsBlock=landing.slice(landing.indexOf('const journeySteps'),landing.indexOf('function JourneyPhaseIcon'));
  const runtimeBlock=landing.slice(landing.indexOf('function JourneyLab'),landing.indexOf('const roleViews'));

  assert.match(landing,/href="#story"[\s\S]{0,100}>التكاملات<\/a>/);
  assert.match(landing,/href="#journey"[\s\S]{0,100}>رحلة العميل<\/a>/);
  assert.doesNotMatch(landing,/IntegrationActionLab|integrationActionSources|تكاملات تحرّك العمل|الإشعار ما يكفي/);
  assert.match(landing,/<StoryStrip \/>[\s\S]*<ProductDemo \/>[\s\S]*<JourneyLab \/>[\s\S]*<OperationalStories cms=\{cms\} \/>/);
  assert.match(runtimeBlock,/<span>03<\/span> رحلة العميل والمتدرب كاملة/);
  assert.match(runtimeBlock,/variant = "dark"/);
  assert.match(runtimeBlock,/const idPrefix = variant === "blended" \? "journey-blended" : "journey"/);
  assert.match(runtimeBlock,/journey-section journey-section--blended/);
  assert.ok(runtimeBlock.includes('id={`${idPrefix}-phase-${phase.key}`}'));
  assert.ok(runtimeBlock.includes('aria-controls={`${idPrefix}-stage-panel`}'));
  assert.ok(runtimeBlock.includes('id={`${idPrefix}-stage-panel`}'));
  assert.ok(runtimeBlock.includes('aria-labelledby={`${idPrefix}-phase-${currentPhase.key}`}'));
  assert.doesNotMatch(runtimeBlock,/id="journey-phase-|id="journey-stage-panel"/);
  assert.match(landing,/<JourneyLab \/>[\s\S]*<JourneyLab variant="blended" \/>[\s\S]*<OperationalStories/);
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
  assert.match(runtimeBlock,/aria-live=\{paused \? "polite" : "off"\}/);
  assert.match(runtimeBlock,/visibilitychange/);
  assert.match(runtimeBlock,/IntersectionObserver/);
  assert.match(runtimeBlock,/prefers-reduced-motion: reduce/);
  assert.match(stepsBlock,/جاهز للرفع بعد اكتمال التحقق/);
  assert.match(runtimeBlock,/لا يعني هذا العرض شراكة أو تكاملًا آليًا مباشرًا/);
  assert.doesNotMatch(`${stepsBlock}\n${runtimeBlock}`,/fetch\(|supabase|tenant_id|رفع تلقائي|تم الرفع تلقائي/i);
  assert.doesNotMatch(landing,/ريف|reef/i);
  for(const number of ['01','02','03','04','05','06','07']) assert.match(landing,new RegExp(`<span>${number}<\\/span>`));
  assert.doesNotMatch(landing,/<span>08<\/span>/);
});

test('the complete journey remains responsive, readable, and motion-aware',async()=>{
  const styles=await read('app/odeir-landing-experience.css');

  assert.doesNotMatch(styles,/\.integration-action-/);
  for(const selector of ['journey-phase-picker','journey-progress','journey-stage-card','journey-stage-facts','journey-authorities','journey-disclaimer']){
    assert.match(styles,new RegExp(`\\.${selector}`));
  }
  assert.match(styles,/grid-template-columns: repeat\(10, minmax\(0,1fr\)\)/);
  assert.match(styles,/\.journey-section \{[^}]+linear-gradient\(150deg, #031329, #061f40 65%, #031126\)/);
  assert.match(styles,/\.journey-section--blended \{[^}]+linear-gradient\(155deg, #f8fbfa 0%, #edf6f4 54%, #f8faf9 100%\)/);
  assert.match(styles,/\.journey-section--blended \.journey-heading h2 \{ color: #071d36; \}/);
  assert.match(styles,/\.journey-section--blended \.journey-phase \{[^}]+background: rgba\(255,255,255,\.72\)/);
  assert.match(styles,/\.journey-section--blended \.journey-phase\.is-active \{[^}]+linear-gradient\(145deg, #073552, #041c38 78%\)/);
  assert.match(styles,/\.journey-section--blended \.journey-phase\.is-active \.journey-phase-icon \{[^}]+background: var\(--yellow\)/);
  assert.match(styles,/\.journey-section--blended \.journey-phase small \{ color: #5f7284; \}/);
  assert.match(styles,/\.journey-section--blended \.journey-console \{[^}]+linear-gradient\(145deg, rgba\(2,15,34,\.96\), rgba\(4,24,52,\.92\)\)/);
  assert.match(styles,/\.journey-section--blended \.journey-console::before/);
  assert.match(styles,/@keyframes journey-stage-in/);
  assert.match(styles,/@keyframes journey-live-pulse/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]+\.journey-track \{[^}]+grid-template-columns: repeat\(2, minmax\(0,1fr\)\)/);
  assert.match(styles,/@media \(max-width: 370px\)[\s\S]+\.journey-phase-picker \{ grid-template-columns: 1fr; \}/);
  assert.match(styles,/@media \(max-width: 370px\)[\s\S]+\.journey-track \{ grid-template-columns: repeat\(2, minmax\(0,1fr\)\); \}/);
  for(const mobileRule of [
    /\.journey-phase small \{ font-size: 9px; \}/,
    /\.journey-step small \{ font-size: 9px; \}/,
    /\.journey-stage-facts b \{ font-size: 10px; \}/,
    /\.journey-disclaimer \{ font-size: 9px; \}/,
  ]) assert.match(styles,mobileRule);
  assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/);
});
