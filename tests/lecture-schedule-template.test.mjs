import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const read=path=>readFile(new URL(path,import.meta.url),'utf8');

test('WhatsApp templates expose and render the real lecture schedule',async()=>{
  const migration=await read(
    '../supabase/migrations/20260812233019_add_lecture_schedule_template_variable.sql'
  );
  const normalization=await read(
    '../supabase/migrations/20260812233441_normalize_lecture_schedule_display_times.sql'
  );
  const hub=await read('../components/integration-hub.js');

  assert.match(migration,/'lecture_schedule'/);
  assert.match(migration,/course_run_lecture_schedule/);
  assert.match(migration,/academy\.course_run_sessions/);
  assert.match(migration,/session\.status <> 'cancelled'/);
  assert.match(migration,/at time zone v_timezone/);
  assert.match(migration,/موعد المحاضرات: \{\{lecture_schedule\}\}/);
  assert.match(migration,/'lectureSchedule', v_lecture_schedule/);
  assert.match(
    migration,
    /template\.body_template = template\.default_body_template/
  );
  assert.match(hub,/key:'lecture_schedule'/);
  assert.match(hub,/موعد المحاضرة\/المحاضرات/);
  assert.match(hub,/من الأحد إلى الخميس، من 6:00 م إلى 10:00 م/);
  assert.match(normalization,/interval '5 minutes'/);
  assert.match(normalization,/mode\(\) within group/);
});
