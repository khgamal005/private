import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const migrationName='20260904223000_single_authorized_operator_policy_v1.sql';
const migration=readFileSync(join(root,'supabase/migrations',migrationName),'utf8');
const route=readFileSync(join(root,'app/api/platform/paymob-control/route.js'),'utf8');
const ui=readFileSync(join(root,'components/platform-addon-console.js'),'utf8');

function escapeRegExp(value){
  return value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
}

function sqlFunction(text,qualifiedName){
  const start=new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+${escapeRegExp(qualifiedName)}\\s*\\(`,
    'i'
  ).exec(text);
  assert.ok(start,`Missing SQL function ${qualifiedName}`);
  const tail=text.slice(start.index);
  const body=/\bas\s+(\$[A-Za-z0-9_]*\$)([\s\S]*?)\1\s*;/i.exec(tail);
  assert.ok(body,`Unterminated SQL function ${qualifiedName}`);
  return tail.slice(0,body.index+body[0].length);
}

function runtimeFiles(directory){
  const result=[];
  for(const name of readdirSync(directory)){
    const path=join(directory,name);
    if(statSync(path).isDirectory())result.push(...runtimeFiles(path));
    else if(/\.(?:js|mjs|ts|tsx)$/.test(name))result.push(path);
  }
  return result;
}

test('active control surfaces have no second-person action',()=>{
  const runtime=[
    ...runtimeFiles(join(root,'app')),
    ...runtimeFiles(join(root,'components')),
    ...runtimeFiles(join(root,'lib')),
    ...runtimeFiles(join(root,'supabase/functions'))
  ];
  const prohibited=/maker[–-]?checker|checker_required|awaiting_checker|two_person_approved|global_approve|tenant_approve|evidence_approve|مراجع(?:ًا)? مختلف|مشغّل آخر/i;
  for(const path of runtime){
    assert.doesNotMatch(
      readFileSync(path,'utf8'),
      prohibited,
      `Second-person governance marker found in ${path.slice(root.length+1)}`
    );
  }
  assert.match(route,/GLOBAL_ACTIONS=new Set\(\['global_activate'\]\)/);
  assert.match(route,/TENANT_ACTIONS=new Set\(\['tenant_enable','tenant_disable'\]\)/);
  assert.match(route,/EVIDENCE_ACTIONS=new Set\(\['evidence_attest'\]\)/);
  assert.match(ui,/SINGLE AUTHORIZED OPERATOR/);
});

test('database policy removes identity separation but preserves authorization and evidence',()=>{
  for(const constraint of [
    'payment_tenant_rollouts_check1',
    'paymob_operational_evidence_requests_check',
    'refunds_check',
    'reconciliations_check1'
  ])assert.match(
    migration,
    new RegExp(`drop\\s+constraint\\s+if\\s+exists\\s+${constraint}`,'i')
  );

  const activation=sqlFunction(
    migration,'public.v1_platform_paymob_activation_gate'
  );
  const rollout=sqlFunction(
    migration,'public.v1_platform_paymob_tenant_rollout_action'
  );
  const evidence=sqlFunction(
    migration,'public.v1_platform_paymob_operational_evidence_action'
  );
  const canary=sqlFunction(
    migration,'private_app.paymob_live_canary_eligible_v1'
  );
  for(const sql of [activation,rollout,evidence]){
    assert.match(sql,/private_app\.has_platform_permission\(\s*'platform\.billing\.manage'\s*\)/i);
    assert.match(sql,/'approvalPolicy'\s*,\s*'single_authorized_operator'/i);
    assert.match(sql,/'explicitConfirmation'\s*,\s*true/i);
    assert.doesNotMatch(sql,/checker_required|awaiting_checker|two_person_approved/i);
  }
  assert.match(activation,/private_app\.paymob_missing_checks/i);
  assert.match(rollout,/paymob_reef_skills_rollout_prohibited/i);
  assert.match(evidence,/evidence_sha256[\s\S]*?\^\[a-f0-9\]\{64\}\$/i);
  assert.doesNotMatch(canary,/approved_by_subject_id\s*<>\s*rollout\.requested_by_subject_id/i);
  assert.match(migration,/refunds_single_operator_approval_integrity_v1/i);
  assert.match(migration,/reconciliations_single_operator_resolution_integrity_v1/i);
});

test('future migrations may not reintroduce a different-human approval gate',()=>{
  const future=readdirSync(join(root,'supabase/migrations'))
    .filter(name=>name.endsWith('.sql')&&name>migrationName);
  const prohibited=/checker_required|awaiting_checker|two_person_approved|maker[–-]?checker|approved_by_subject_id\s*(?:<>|!=|is\s+distinct\s+from)\s*requested_by_subject_id|activation_requested_by_subject_id\s*(?:<>|!=|is\s+distinct\s+from)\s*activated_by_subject_id/i;
  for(const name of future){
    assert.doesNotMatch(
      readFileSync(join(root,'supabase/migrations',name),'utf8'),
      prohibited,
      `Future migration ${name} reintroduced second-person approval`
    );
  }
});
