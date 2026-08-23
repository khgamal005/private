import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('tenant team heading always uses the current tenant identity',async()=>{
  const team=await read('components/team-directory.js');
  assert.match(
    team,
    /<h2>فريق عمل \{initialData\.tenant\?\.name\|\|'المنشأة'\}<\/h2>/
  );
  assert.doesNotMatch(team,/<h2>فريق عمل ريف المهارات<\/h2>/);
});

test('new tenant setup contains no Reef-specific integration defaults',async()=>{
  const [ui,source,migration]=await Promise.all([
    read('components/yeastar-settings.js'),
    read('supabase/migrations/20260729215925_yeastar_p550_telephony_v2.sql'),
    read('supabase/migrations/20260823190000_tenant_brand_isolation_v1.sql')
  ]);

  for(const content of [ui,source,migration]){
    assert.doesNotMatch(content,/https:\/\/reef\.ras\.yeastar\.com/);
  }
  assert.match(ui,/baseUrl:''/);
  assert.match(ui,/extensions:''/);
  assert.match(ui,/https:\/\/your-company\.ras\.yeastar\.com/);
  assert.match(migration,/private_app\.yeastar_settings_snapshot_core/);
  assert.match(migration,/'baseUrl', ''/);
  assert.match(migration,/'extensions', ''/);
});

test('new tenant provisioning is parameter-driven and Odeir-domain aware',async()=>{
  const [admin,onboarding,provisioning,migration]=await Promise.all([
    read('components/platform-tenants.js'),
    read('components/onboarding-form.js'),
    read('supabase/migrations/20260726211556_tenant_provisioning_cycle_v2.sql'),
    read('supabase/migrations/20260823190000_tenant_brand_isolation_v1.sql')
  ]);

  assert.match(admin,/placeholder="training-center"/);
  assert.match(admin,/training-center\.odeir\.com/);
  assert.doesNotMatch(admin,/placeholder="reef|reef\.marktone\.sa/);
  assert.match(onboarding,/example\.odeir\.com/);
  assert.doesNotMatch(onboarding,/example\.marktone\.sa/);
  assert.match(
    provisioning,
    /v_hostname in \(p_slug \|\| '\.odeir\.com', p_slug \|\| '\.marktone\.sa'\)/
  );
  assert.doesNotMatch(provisioning,/مركز ريف المهارات|slug='reef-skills'/);
  assert.match(migration,/public\.v2_platform_provision_tenant/);
  assert.doesNotMatch(migration,/'reef-skills'/);
});

test('all user-facing product surfaces use the Odeir identity',async()=>{
  const paths=[
    'components/workspace-shell.js',
    'components/marketplace-store.js',
    'components/addon-center.js',
    'components/marketplace-addon-store-v2.js',
    'components/platform-marketplace.js',
    'components/platform-addon-console.js',
    'components/platform-plans.js',
    'app/control/page.js',
    'app/api/tenant/report-export/route.js'
  ];
  const files=await Promise.all(paths.map(read));
  for(let index=0;index<files.length;index++){
    assert.doesNotMatch(
      files[index],
      /مُدار|MODAAR|Modaar-/,
      `legacy product identity in ${paths[index]}`
    );
  }
  assert.match(files[0],/إضافات أودير/);
  assert.match(files[2],/ODEIR ADD-ON MANAGER/);
  assert.match(files.at(-1),/Odeir-/);
});

test('fresh installs and existing databases receive the same neutral defaults',async()=>{
  const [marketplace,founder,automation,commerce,migration]=await Promise.all([
    read('supabase/migrations/20260808000722_marktone_marketplace_v1.sql'),
    read('supabase/migrations/20260811210000_modaar_founder_core.sql'),
    read('supabase/migrations/20260728050000_automation_rules_engine_v2.sql'),
    read('supabase/migrations/20260812100000_modaar_saas_commerce_control_v1.sql'),
    read('supabase/migrations/20260823190000_tenant_brand_isolation_v1.sql')
  ]);

  assert.doesNotMatch(marketplace,/مُدار|Modaar|MDR-/);
  assert.match(marketplace,/أودير|ODEIR/);
  assert.match(marketplace,/ODR-/);
  assert.doesNotMatch(founder,/مركز مُدار النموذجي للتدريب/);
  assert.match(founder,/مركز أودير النموذجي للتدريب/);
  assert.doesNotMatch(automation,/REEF-DEMO-001/);
  assert.match(automation,/ODEIR-DEMO-001/);
  assert.doesNotMatch(commerce,/'خدمة من مُدار'/);
  assert.match(commerce,/'خدمة من أودير'/);

  assert.match(migration,/alter column order_number set default/);
  assert.match(migration,/'ODR-'/);
  assert.match(migration,/ODEIR-DEMO-001/);
  assert.match(migration,/'خدمة من أودير'/);
  assert.match(migration,/where slug='modaar-training-center'/);
  assert.doesNotMatch(migration,/where slug='reef-skills'/);
});
