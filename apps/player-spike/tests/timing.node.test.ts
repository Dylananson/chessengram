import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AttemptTimer } from '../src/timing.ts';

test('accumulates active time and shifts post-failure time to correction', () => {
  let now = 1_000;
  const timer = new AttemptTimer({ now: () => now });
  timer.start();

  now = 6_000;
  assert.equal(timer.snapshot().activeSolvingSeconds, 5);

  timer.markFailure();
  now = 9_000;
  const afterFailure = timer.snapshot();
  assert.equal(afterFailure.activeSolvingSeconds, 5);
  assert.equal(afterFailure.correctionSeconds, 3);
});

test('hidden time is excluded and disables timing trust', () => {
  let now = 1_000;
  const timer = new AttemptTimer({ now: () => now });
  timer.start();

  now = 4_000;
  timer.interrupt(); // 3s active so far

  now = 64_000; // away for 60s
  timer.resume();

  now = 69_000; // 5s active after resuming
  const snapshot = timer.snapshot();
  assert.equal(snapshot.activeSolvingSeconds, 8);
  assert.equal(snapshot.hiddenSeconds, 60);
  assert.equal(snapshot.interruptionSeconds, 60);
  assert.equal(snapshot.timingTrustworthy, false);
});

test('snapshot is repeatable without advancing internal anchors', () => {
  let now = 0;
  const timer = new AttemptTimer({ now: () => now });
  timer.start();
  now = 2_000;
  assert.equal(timer.snapshot().activeSolvingSeconds, 2);
  assert.equal(timer.snapshot().activeSolvingSeconds, 2);
  now = 4_000;
  assert.equal(timer.snapshot().activeSolvingSeconds, 4);
});
