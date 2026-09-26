// Training plan logic. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, expand, totalS, zoneBpm, targetStatus, startRun, advance, skip, current, holdPlan } from '../../core/plans.js';

const live = PLANS.find((p) => p.id === 'live');

// Catches: repeats expanded the wrong number of times, out of order, or without their number.
test('repeated phases expand in order, numbered, with the right total length', () => {
  const ph = expand(live);
  assert.equal(ph.length, 2 + 5 * 2 + 1);
  assert.deepEqual(ph.slice(2, 6).map((p) => p.name), ['Live bout 1 of 5', 'Rest 1 of 5', 'Live bout 2 of 5', 'Rest 2 of 5']);
  assert.equal(ph.at(-1).name, 'Cool down');
  assert.equal(totalS(live), 600 + 600 + 5 * (120 + 60) + 300);
});

// Catches: off by one zone at the boundaries (a Z4 athlete on a Z4 target shown as "work harder").
test('status: inside the target range is on target, including both ends', () => {
  assert.equal(targetStatus(4, [4, 4]), 'on');
  assert.equal(targetStatus(2, [2, 3]), 'on');
  assert.equal(targetStatus(3, [2, 3]), 'on');
  assert.equal(targetStatus(3, [4, 5]), 'below');
  assert.equal(targetStatus(5, [4, 4]), 'above');
});

// Catches: a resting athlete told to "work harder" during recovery, and a colour shown with no data.
test('status: below zone 1 is fine when zone 1 is the target; no data means no status', () => {
  assert.equal(targetStatus(0, [1, 1]), 'on');
  assert.equal(targetStatus(0, [1, 2]), 'on');
  assert.equal(targetStatus(0, [2, 2]), 'below');
  assert.equal(targetStatus(null, [4, 4]), null);
});

// Catches: wrong percentage bands in the bpm shown next to the target (zone 4 is 80 to 90 % of max).
test('zone bpm spans follow the 50/60/70/80/90 % bands', () => {
  assert.deepEqual(zoneBpm([4, 4], 190), [152, 171]);
  assert.deepEqual(zoneBpm([1, 5], 200), [100, 200]);
  assert.equal(zoneBpm([3, 3], null), null);
});

// Catches: a late check (hidden tab) skipping phases without labelling them, or labelling them at
// the time of the check instead of when the plan said they started; running past the end.
test('advance enters every phase that passed, at its scheduled time, and stops at the end', () => {
  const run = startRun(live, 100);
  assert.deepEqual(advance(run, 700).map((p) => [p.name, p.at]), [['Drilling', 700]]);
  const late = advance(run, 700 + 600 + 120 + 60 + 5); // two more phases passed before this check
  assert.deepEqual(late.map((p) => [p.name, p.at]), [['Live bout 1 of 5', 1300], ['Rest 1 of 5', 1420], ['Live bout 2 of 5', 1480]]);
  assert.equal(current(run, 1485).left, 115);
  advance(run, 100 + totalS(live) + 1);
  assert.equal(run.done, true);
  assert.equal(current(run, 99999), null);
});

// Catches: "Next phase" shifting the rest of the plan wrongly or losing the skipped phase's real length.
test('skip ends the current phase now and the next one starts now', () => {
  const run = startRun(live, 0);
  const e = skip(run, 42);
  assert.deepEqual(e.map((p) => [p.name, p.at]), [['Drilling', 42]]);
  assert.equal(current(run, 42).left, 600);
});

// Catches: an open ended "hold one zone" plan ending by itself.
test('a hold plan never ends on its own', () => {
  const run = startRun(holdPlan(3), 0);
  assert.deepEqual(advance(run, 1e7), []);
  assert.equal(current(run, 1e7).zone[0], 3);
});
