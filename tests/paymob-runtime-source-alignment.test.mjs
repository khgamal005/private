import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const checkout=readFileSync(
  join(root,'supabase/functions/paymob-checkout/index.ts'),'utf8'
);
const admin=readFileSync(
  join(root,'supabase/functions/payment-provider-admin/index.ts'),'utf8'
);
const config=readFileSync(join(root,'supabase/config.toml'),'utf8');

test('Paymob runtime is one source-controlled Hosted Redirect adapter',()=>{
  assert.match(checkout,/LEGACY_INTENTION_PROVIDER_MUTATION_ENABLED\s*=\s*false/);
  assert.match(checkout,/runtime\.checkoutFlow\s*===\s*"quicklink"/);
  assert.match(checkout,/new FormData\(\)/);
  assert.match(checkout,/PAYMOB_QUICKLINK_URL/);
  assert.match(checkout,/!providerResult\.response\.ok/);
  assert.match(checkout,/\["created",\s*"active"\]\.includes\(state\)/);
  assert.doesNotMatch(checkout,/32958|32957|27946/);
  assert.match(admin,/PAYMOB_SECRET_KEYS=new Set\(\['apiKey','hmacSecret'\]\)/);
  assert.match(admin,/integrationPath\s*===\s*'quicklink'/);
  const functionBlock=/\[functions\.paymob-checkout\]([\s\S]*?)(?=\n\[|$)/.exec(config);
  assert.ok(functionBlock,'Missing paymob-checkout function config');
  assert.match(functionBlock[1],/verify_jwt\s*=\s*true/);
});

test('non-QuickLink configuration fails before any legacy provider mutation',()=>{
  const guard=checkout.indexOf(
    'if (!LEGACY_INTENTION_PROVIDER_MUTATION_ENABLED)'
  );
  const request=checkout.indexOf('const intentionRequest = {',guard);
  const mutation=checkout.indexOf('PAYMOB_INTENTION_URL,',request);
  assert.ok(guard!==-1&&request>guard&&mutation>request);
  const surface=checkout.slice(guard,request);
  assert.match(surface,/recordIntentionBestEffort/);
  assert.match(surface,/"unsupported_checkout_flow"/);
  assert.match(surface,/return jsonResponse\(503/);
  assert.doesNotMatch(
    surface,
    /fetchTextWithTimeout|providerMutationStarted\s*=\s*true/
  );
});
