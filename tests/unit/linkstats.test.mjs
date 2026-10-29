// core/linkstats.js. Each test names the bug it would catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArrivalStats } from '../../core/linkstats.js';

const feed = (a, times) => { for (const t of times) a.add(t); return a; };
const every = (from, step, n) => Array.from({ length: n }, (_, i) => from + i * step);

test('rate over the span covered, not the window: 2 s of 100 packets/s reads 100, not 20', () => {
  const x = feed(new ArrivalStats({ windowMs: 10000 }), every(0, 10, 201)).read(2000);
  assert.ok(Math.abs(x.rate - 100) < 1e-9, String(x.rate));
  assert.equal(x.jitter, 0); assert.equal(x.mean, 10);
});

test('a stream that stopped reads 0 packets/s, not its old rate', () => {
  const x = feed(new ArrivalStats({ windowMs: 10000 }), every(0, 10, 100)).read(990 + 10001);
  assert.equal(x.rate, 0); assert.ok(x.sinceLast > 10000);
});

test('one packet gives no rate and no NaN', () => {
  const x = feed(new ArrivalStats(), [5]).read(10);
  assert.equal(x.rate, null); assert.equal(x.jitter, null); assert.equal(x.sinceLast, 5); assert.equal(x.total, 1);
});

test('bursts: 10 packets 1 ms apart every 100 ms keep 100/s on average with the right jitter', () => {
  const t = []; for (let b = 0; b < 50; b++) for (let k = 0; k < 10; k++) t.push(b * 100 + k);
  const x = feed(new ArrivalStats({ windowMs: 10000 }), t).read(4910);
  // 450 intervals of 1 ms and 49 of 91 ms: mean 9.84 ms, standard deviation sqrt((450 x 8.84² + 49 x 81.16²) / 499) = 26.78 ms
  assert.ok(Math.abs(x.mean - 9.838) < 0.01, String(x.mean));
  assert.ok(Math.abs(x.jitter - 26.78) < 0.01, String(x.jitter));
  assert.equal(x.max, 91); assert.equal(x.stalls, 0);
});

test('stalls and the longest interval survive the window; the window forgets old packets', () => {
  const a = feed(new ArrivalStats({ windowMs: 1000, stallMs: 250 }), [...every(0, 10, 50), ...every(1000, 20, 200)]);
  const x = a.read(4980);
  assert.equal(x.stalls, 1); assert.equal(x.longest, 510);
  assert.ok(Math.abs(x.rate - 50) < 1e-9, `rate after the change ${x.rate}`);
  assert.equal(x.max, 20);
});
