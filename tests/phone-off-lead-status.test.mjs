import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const migrationPath=
  'supabase/migrations/20260808171237_add_phone_off_lead_status.sql';

test('phone_off is available as an active customer follow-up status',async()=>{
  const [component,migration]=await Promise.all([
    read('components/sales-followup-modal.js'),
    read(migrationPath)
  ]);

  assert.match(
    component,
    /OPEN_STATUSES=new Set\(\[[\s\S]+?'busy',[\s\S]+?'phone_off',[\s\S]+?'follow_up'/
  );
  assert.match(
    component,
    /phone_off:\{label:'الجوال مغلق',tone:'warning'\}/
  );

  assert.match(
    migration,
    /contacts_lead_status_check[\s\S]+?'phone_off'[\s\S]+?validate constraint contacts_lead_status_check/
  );
  assert.match(
    migration,
    /activities_result_status_check[\s\S]+?'phone_off'[\s\S]+?validate constraint activities_result_status_check/
  );
  assert.match(
    migration,
    /if p_lead_status not in \([\s\S]+?'busy',[\s\S]+?'phone_off',[\s\S]+?'follow_up'/
  );
  assert.match(
    migration,
    /v_is_open := p_lead_status in \([\s\S]+?'busy',[\s\S]+?'phone_off',[\s\S]+?'follow_up'/
  );
  assert.match(
    migration,
    /p_lead_status in \('no_answer', 'busy', 'phone_off', 'follow_up', 'postponed'\)[\s\S]+?then 'contacted'/
  );
  const closedStatuses=migration.match(
    /v_is_closed := p_lead_status in \(([\s\S]+?)\);/
  );
  assert.ok(closedStatuses,'closed status block must remain explicit');
  assert.doesNotMatch(closedStatuses[1],/'phone_off'/);
});
