import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('the manager comparison is an isolated noindex route and leaves the production homepage entry unchanged',async()=>{
  const [page,home,landing]=await Promise.all([
    read('app/odeir-preview/manager/page.js'),
    read('app/page.js'),
    read('components/odeir-landing-experience.tsx')
  ]);

  assert.match(page,/OdeirManagerPreview/);
  assert.match(page,/robots:\{index:false,follow:false,nocache:true\}/);
  assert.match(page,/getCmsPublicSnapshot\(\{siteKey:'marktone-main'\}\)/);
  assert.doesNotMatch(page,/throw new Error|tenant_id|core\.tenants|migration|ريف|reef/i);

  assert.match(home,/return <OdeirLandingExperience cms=\{landingCms\(snapshot,home\)\}\/?>/);
  assert.doesNotMatch(home,/OdeirManagerPreview|variant=["']manager["']/);

  const defaultBlock=landing.slice(landing.indexOf('export default function OdeirLandingExperience'),landing.indexOf('export function OdeirManagerPreview'));
  assert.match(defaultBlock,/<MorningBriefing articles=\{cms\.articles\} \/>[\s\S]*<StoryStrip \/>[\s\S]*<ProductDemo \/>[\s\S]*<JourneyLab \/>[\s\S]*<OperationalStories cms=\{cms\} \/>/);
  assert.doesNotMatch(defaultBlock,/ManagerTrustRail|ManagerOperationalProof|ManagerCapabilities|variant="manager"/);
});

test('the manager preview follows the decision-first order with honest Saudi training-center copy',async()=>{
  const landing=await read('components/odeir-landing-experience.tsx');
  const managerBlock=landing.slice(landing.indexOf('export function OdeirManagerPreview'));
  const ordered=[
    '<ManagerTrustRail />',
    '<ProductDemo kickerNumber="01" />',
    '<JourneyLab kickerNumber="02" />',
    '<ManagerOperationalProof />',
    '<ManagerCapabilities />',
    '<StoryStrip kickerNumber="05" />',
    '<RoleSwitcher kickerNumber="06" />',
    '<SecuritySection cms={cms} kickerNumber="07" />',
    '<MorningBriefing articles={cms.articles} />',
    '<FAQ cms={cms} kickerNumber="08" variant="manager" />',
    '<FinalCTA cms={cms} onRegister={openRegistration} variant="manager" />'
  ];
  let cursor=-1;
  for(const marker of ordered){
    const next=managerBlock.indexOf(marker);
    assert.ok(next>cursor,`${marker} must appear after the previous manager-preview section`);
    cursor=next;
  }

  assert.match(landing,/شغّل مركزك من أول استفسار،/);
  assert.match(landing,/حتى الشهادة… من مكان واحد/);
  assert.match(landing,/شاهد رحلة متدرب كاملة/);
  assert.match(landing,/مصمم لواقع مراكز التدريب السعودية/);
  assert.match(landing,/لا يلزم نقل كل بياناتك/);
  assert.match(landing,/سيناريو مبني على مواقف يومية شائعة داخل مراكز التدريب؛ جميع الأسماء والبيانات المعروضة افتراضية/);
  assert.match(landing,/تجهيز بيانات المؤسسة ومنار/);
  assert.match(landing,/لا نصفهما كتَكامل آلي مباشر إلا عندما تكون الخدمة متاحة ومعلنة بوضوح/);
  assert.match(landing,/جرّب مسارًا واحدًا… ثم قرر على واقع مركزك/);
  assert.doesNotMatch(managerBlock,/دخول المنشآت/);
  assert.doesNotMatch(landing,/ريف|reef/i);
});

test('manager-only styling is scoped, readable, responsive, and motion-aware',async()=>{
  const styles=await read('app/odeir-preview/manager/manager-preview.css');

  assert.match(styles,/^\.odeir-experience--manager \{/);
  assert.doesNotMatch(styles,/(^|\n)\.manager-[^{]+\{/);
  for(const selector of [
    'manager-trust-rail',
    'manager-proof-board',
    'manager-proof-compare',
    'manager-proof-lifecycle',
    'manager-capabilities-grid'
  ]) assert.match(styles,new RegExp(`\\.odeir-experience--manager \\.${selector}`));
  assert.match(styles,/\.odeir-experience--manager \.hero-copy h1 \{[\s\S]*font-size: clamp\(45px, 4\.3vw, 62px\)/);
  assert.match(styles,/\.odeir-experience--manager \.journey-phase small \{[\s\S]*font-size: 10px/);
  assert.match(styles,/\.odeir-experience--manager \.journey-disclaimer \{[\s\S]*font-size: 10\.5px/);
  assert.match(styles,/@media \(max-width: 920px\)[\s\S]*\.odeir-experience--manager \.manager-proof-compare/);
  assert.match(styles,/@media \(max-width: 620px\)[\s\S]*\.manager-capabilities-grid \{[\s\S]*grid-template-columns: 1fr/);
  assert.match(styles,/@media \(prefers-reduced-motion: reduce\)/);
});
