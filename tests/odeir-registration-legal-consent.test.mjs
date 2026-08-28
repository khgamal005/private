import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
const UI='components/free-trial-landing.js';
const MODAL_CSS='components/odeir-registration-modal.module.css';
const PAGE_CSS='app/free-trial/free-trial.css';
const EDGE='supabase/functions/odeir-registration-intake/index.ts';
const LEDGER=
  'supabase/migrations/20260828210000_registration_legal_consent_ledger_v1.sql';

function position(source,needle){
  const at=source.indexOf(needle);
  assert.notEqual(at,-1,`missing contract marker: ${needle}`);
  return at;
}

function functionSql(source,name){
  const start=position(source,`create or replace function ${name}(`);
  const end=source.indexOf('$function$;',start);
  assert.notEqual(end,-1,`missing function terminator: ${name}`);
  return source.slice(start,end+'$function$;'.length);
}

function quotedConstant(source,name){
  const match=source.match(new RegExp(`const ${name}=\\s*['\"]([^'\"]+)['\"]`));
  assert.ok(match,`missing constant ${name}`);
  return match[1];
}

test('registration adds an explicit, accessible fifth clickwrap step',async()=>{
  const [ui,modalCss,pageCss]=await Promise.all([
    read(UI),read(MODAL_CSS),read(PAGE_CSS)
  ]);

  assert.match(ui,/aria-label=\{`الخطوة \$\{activeStep\} من 5`\}/);
  assert.match(ui,/["ابحث", "تأكد", "بياناتك", "الإقرار", "الموافقة"]/);
  assert.match(ui,/aria-current=\{step !== "success" && activeStep === index \+ 1 \? "step"/);
  assert.match(ui,/step === "regulatory"/);
  assert.match(ui,/step === "agreement"[\s\S]*?<form[\s\S]*?onSubmit=\{submit\}/);
  assert.match(ui,/step !== "agreement"/);
  assert.match(ui,/scrollHeight - panel\.scrollTop - panel\.clientHeight <= 12/);
  assert.match(ui,/disabled=\{!legalReviewed \|\| busy === "submit"\}/);
  assert.match(ui,/legalReviewed \? "وصلت إلى نهاية الملخص/);
  assert.match(ui,/privacyConsent: false/);
  assert.match(ui,/privacyAcknowledged: false/);
  assert.match(ui,/termsConsent: false/);
  assert.match(ui,/legalConsent: false/);
  assert.match(ui,/href="\/p\/terms-of-use"/);
  assert.match(ui,/href="\/p\/privacy-policy"/);
  assert.match(ui,/href="\/p\/terms-of-use#free-plan"/);
  assert.match(ui,/أوافق وأرسل طلب إنشاء منشأتي/);
  assert.match(ui,/legalSummaryReviewed: legalReviewed/);

  const reset=position(ui,'setLegalReviewed(false);');
  const agreement=position(ui,'setStep("agreement");');
  assert.ok(reset<agreement,'consent must reset before the agreement renders');

  for(const css of [modalCss,pageCss]){
    assert.match(css,/repeat\(5,\s*minmax\(0,\s*1fr\)\)|repeat\(5,\s*1fr\)/);
    assert.match(css,/\.legal-scroll[\s\S]*?overflow-y:\s*auto/);
    assert.match(css,/\.legal-consent/);
    assert.match(css,/\.request-review-card/);
  }
});

test('the policy bundle and exact Arabic consent text agree across UI and Edge',async()=>{
  const [ui,edge,migration]=await Promise.all([read(UI),read(EDGE),read(LEDGER)]);
  const textMatch=ui.match(/const LEGAL_CONSENT_TEXT = "([^"]+)";/);
  assert.ok(textMatch,'missing canonical Arabic consent text');
  const hash=createHash('sha256').update(textMatch[1],'utf8').digest('hex');
  assert.match(ui,new RegExp(`consentTextHash: "${hash}"`));
  assert.equal(quotedConstant(edge,'LEGAL_CONSENT_TEXT_HASH'),hash);
  assert.match(migration,new RegExp(hash,'g'));
  const summaryBlock=ui.slice(
    ui.indexOf('const LEGAL_SUMMARY = ['),
    ui.indexOf('];',ui.indexOf('const LEGAL_SUMMARY = ['))+2
  );
  const summaryPairs=[...summaryBlock.matchAll(/\["([^"]+)", "([^"]+)"\]/g)]
    .map(match=>[match[1],match[2]]);
  assert.equal(summaryPairs.length,9);
  const summaryText=summaryPairs
    .map(([title,description])=>`${title}\n${description}`).join('\n');
  const summaryHash=createHash('sha256').update(summaryText,'utf8').digest('hex');
  assert.match(ui,new RegExp(`summaryTextHash: "${summaryHash}"`));
  assert.equal(quotedConstant(edge,'LEGAL_SUMMARY_TEXT_HASH'),summaryHash);
  assert.match(migration,new RegExp(summaryHash,'g'));
  const migrationSummary=migration.match(/\$summary\$([\s\S]*?)\$summary\$/)?.[1];
  assert.equal(migrationSummary,summaryText);

  const mappings=[
    ['policySetVersion','LEGAL_POLICY_SET_VERSION','odeir-legal-2026-08-28-v1'],
    ['termsVersion','LEGAL_TERMS_VERSION','terms-of-use-2026-08-28'],
    ['privacyVersion','LEGAL_PRIVACY_VERSION','privacy-policy-2026-08-28'],
    ['fairUseVersion','LEGAL_FAIR_USE_VERSION','free-plan-fair-use-2026-08-28'],
    ['presentationVersion','LEGAL_PRESENTATION_VERSION','registration-clickwrap-v1']
  ];
  for(const [uiName,edgeName,value] of mappings){
    assert.match(ui,new RegExp(`${uiName}: "${value}"`));
    assert.equal(quotedConstant(edge,edgeName),value);
    assert.match(migration,new RegExp(value,'g'));
  }
});

test('Edge rejects missing or stale legal evidence and routes every submit through v4',async()=>{
  const edge=await read(EDGE);
  assert.match(edge,/body\.legalConsent!==true/);
  assert.match(edge,/body\.termsConsent!==true/);
  assert.match(edge,/body\.privacyAcknowledged!==true/);
  assert.match(edge,/body\.legalSummaryReviewed!==true/);
  assert.match(edge,/throw new PublicError\('legal_consent_required',400\)/);
  assert.match(edge,/throw new PublicError\('legal_policy_version_stale',400\)/);
  for(const code of [
    'legal_consent_required','legal_policy_version_stale','legal_policy_unavailable'
  ]) assert.match(edge,new RegExp(`'${code}'`));
  assert.match(edge,/'legal_policy_unavailable'[\s\S]*?\.includes\(publicCode\)\?503:400/);
  assert.doesNotMatch(edge,/p_guard_email_activation/);
  assert.doesNotMatch(
    edge,
    /rpc<JsonRecord>\('v[123]_public_submit_registration_request'/
  );
  assert.equal(
    edge.match(/rpc<JsonRecord>\('v4_public_submit_registration_request'/g)?.length,
    1,
    'the existing path has one inline v4 call; the guarded path is split over lines'
  );
  assert.match(edge,/'v4_public_submit_registration_request',\{/);
});

test('database records an atomic, idempotent, server-timestamped receipt',async()=>{
  const migration=await read(LEDGER);
  const v4=functionSql(migration,'public.v4_public_submit_registration_request');

  for(const table of [
    'platform.registration_legal_policy_sets',
    'platform.registration_request_consents'
  ]){
    assert.match(migration,new RegExp(`alter table ${table.replace('.','\\.')} enable row level security`));
    assert.match(
      migration,
      new RegExp(`revoke all on table ${table.replace('.','\\.')}[\\s\\S]*?from public,anon,authenticated,service_role`)
    );
  }
  assert.match(migration,/request_id uuid not null[\s\S]*?references platform\.registration_requests\(id\) on delete cascade/);
  assert.match(migration,/accepted_at timestamptz not null default now\(\)/);
  assert.match(migration,/consent_method text not null check \(consent_method='scroll_clickwrap'\)/);
  assert.match(migration,/authority_declared boolean not null check \(authority_declared\)/);
  assert.match(migration,/terms_accepted boolean not null check \(terms_accepted\)/);
  assert.match(migration,/privacy_notice_acknowledged boolean not null[\s\S]*?check \(privacy_notice_acknowledged\)/);
  assert.match(migration,/request_ip_hash text not null[\s\S]*?\^\[a-f0-9\]\{64\}\$/);
  assert.match(migration,/user_agent_hash text[\s\S]*?\^\[a-f0-9\]\{64\}\$/);
  assert.match(migration,/consent_text_hash=encode\([\s\S]*?extensions\.digest\(consent_text,'sha256'\)/);
  assert.match(migration,/summary_text_hash=encode\([\s\S]*?extensions\.digest\(summary_text,'sha256'\)/);
  assert.match(migration,/unique \(request_id,policy_set_version,presentation_version\)/);
  assert.match(migration,/foreign key \(terms_document_id,terms_document_version\)[\s\S]*?website\.content_document_versions/);
  assert.match(migration,/platform_registration_consents_policy_idx/);
  assert.doesNotMatch(migration,/update platform\.registration_request_consents/);
  assert.doesNotMatch(migration,/delete from platform\.registration_request_consents/);

  const v3=position(v4,'public.v3_public_submit_registration_request');
  const v2=position(v4,'public.v2_public_submit_registration_request');
  const retry=position(v4,"v_result->>'_retryManual'");
  const insert=position(v4,'insert into platform.registration_request_consents');
  assert.ok(v3<insert&&v2<insert&&retry<insert);
  assert.match(v4,/p_payload->>'institutionState' not in \('existing','new'\)/);
  assert.match(v4,/v_requires_email_guard:=p_payload->>'institutionState'='new'/);
  assert.match(v4,/if v_requires_email_guard then[\s\S]*?public\.v3_public_submit_registration_request/);
  assert.match(v4,/on conflict \(request_id,policy_set_version,presentation_version\)[\s\S]*?do nothing/);
  assert.match(v4,/return v_result/);
  assert.doesNotMatch(v4,/p_payload->>'(?:acceptedAt|termsDocumentHash|privacyDocumentHash)'/);
  assert.match(
    migration,
    /grant execute on function public\.v4_public_submit_registration_request\([\s\S]*?\) to service_role/
  );
});

test('policy snapshots come from the published server documents, not the browser',async()=>{
  const migration=await read(LEDGER);
  assert.match(migration,/website\.sites[\s\S]*?site_key='marktone-main'/);
  assert.match(migration,/page\.slug='terms-of-use'/);
  assert.match(migration,/page\.slug='privacy-policy'/);
  assert.match(migration,/website\.content_documents/);
  assert.match(migration,/website\.content_document_versions/);
  assert.match(migration,/snapshot\.document=document\.published_document/);
  assert.match(migration,/extensions\.digest\(document\.published_document::text,'sha256'\)/);
  assert.match(migration,/raise exception 'legal_policy_unavailable'/);
  assert.match(migration,/terms_document_version/);
  assert.match(migration,/privacy_document_version/);
  assert.match(migration,/terms_document_hash/);
  assert.match(migration,/privacy_document_hash/);
  const v4=functionSql(migration,'public.v4_public_submit_registration_request');
  assert.match(v4,/order by document\.id\s+for share of document,page/);
  assert.match(v4,/v_current_terms_version is distinct from v_policy\.terms_document_version/);
  assert.match(v4,/v_current_privacy_hash is distinct from[\s\S]*?v_policy\.privacy_document_hash/);
  assert.match(v4,/raise exception 'legal_policy_version_stale'/);
  assert.match(v4,/server-side publication drift[\s\S]*?raise exception 'legal_policy_unavailable'/);
});
