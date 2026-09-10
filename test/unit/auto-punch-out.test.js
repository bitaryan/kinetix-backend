import assert from 'node:assert/strict';
import test from 'node:test';
import { attendanceDay, autoPunchOutAt } from '../../src/attendance/day.js';
import { startAutoPunchOutScheduler } from '../../src/attendance/auto-punch-out.js';

test('attendance boundaries use India time across UTC days and year changes', () => {
  const day = attendanceDay(new Date('2026-12-31T18:30Z'));
  assert.equal(day.start.toISOString(), '2026-12-31T18:30:00.000Z');
  assert.equal(day.end.toISOString(), '2027-01-01T18:30:00.000Z');
  assert.equal(day.cutoff.toISOString(), '2027-01-01T14:30:00.000Z');
  assert.equal(autoPunchOutAt(new Date('2026-09-05T15:00Z')).toISOString(), '2026-09-05T15:00:00.000Z');
});

test('scheduler aligns with 8 PM, retries failures, and drains before shutdown', async () => {
  let scheduled;
  let delay;
  let failures = 0;
  let count = 0;
  let release;
  const scheduler = startAutoPunchOutScheduler({
    now: () => new Date('2026-09-06T14:29:59Z'),
    schedule(fn, ms) { scheduled = fn; delay = ms; return 1; }, cancel() { scheduled = null; },
    onError() { failures += 1; },
    async run() {
      count += 1;
      if (count === 1) throw new Error('Database temporarily unavailable');
      await new Promise((resolve) => { release = resolve; });
    },
  });
  assert.equal(delay, 1000);
  scheduled();
  await new Promise(setImmediate);
  assert.equal(failures, 1);
  scheduled();
  await new Promise(setImmediate);
  let stopped = false;
  const stopping = scheduler.stop().then(() => { stopped = true; });
  await new Promise(setImmediate);
  assert.equal(stopped, false);
  release();
  await stopping;
  assert.equal(scheduled, null);
  assert.equal(count, 2);
});
