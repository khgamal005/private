import assert from 'node:assert/strict';
import test from 'node:test';
import {monthlyInstallments} from '../lib/diploma-contracts.mjs';

test('monthly preview preserves exact minor units and calendar month end without local timezone drift', () => {
  let n = 0;
  const plan = monthlyInstallments(10001, 3, '2028-01-31', () => String(++n));
  assert.deepEqual(plan.map(item => item.dueOn), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.equal(plan.reduce((sum, item) => sum + item.amountMinor, 0), 10001);
  assert.deepEqual(plan.map(item => item.amountMinor), [3334, 3334, 3333]);
  assert.throws(() => monthlyInstallments(100, 31, '2026-01-01'), /invalid_schedule/);
  assert.throws(() => monthlyInstallments(100, 2, '2026-02-30'), /invalid_schedule/);
});
