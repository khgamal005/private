import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');

test('dashboard range uses a calendar-only client control',async()=>{
  const [dashboard,picker,styles]=await Promise.all([
    read('components/role-dashboard.js'),
    read('components/dashboard-date-range-picker.js'),
    read('components/role-dashboard.module.css')
  ]);

  assert.match(dashboard,/DashboardDateRangePicker/);
  assert.doesNotMatch(dashboard,/defaultValue=\{range\?\.from\}/);
  assert.match(picker,/'use client'/);
  assert.equal((picker.match(/type="date"/g)||[]).length,2);
  assert.match(picker,/showPicker/);
  assert.match(picker,/event\.preventDefault\(\)/);
  assert.match(picker,/min=\{from\}/);
  assert.match(picker,/max=\{maxDate\}/);
  assert.match(styles,/\.calendarControl input\{[\s\S]*opacity:0/);
  assert.match(styles,/@media \(max-width:390px\)[\s\S]*\.dateInputs\{grid-template-columns:1fr\}/);
});
