/**
 * Regression test for the silent "the puzzle came back again" bug.
 *
 * When the schedule revision moves between starting and finishing a puzzle (a
 * sync apply replays schedules; a restart re-reads them), the reducer rejects
 * the commit as stale. The adapter used to swallow that rejection, so the
 * attempt was never scored — the puzzle stayed due and the queue served it
 * again immediately. `commitOutcomeTolerant` now retries once with the live
 * revision the reducer hands back.
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { commitOutcomeTolerant } from '../src/training-adapter.ts';
import type { CommitOutcomeRequest, CommitOutcomeResponse } from '@chessengram/contracts';

const REQUEST = (revision: number): CommitOutcomeRequest => ({
  attemptId: { value: 'attempt-1' },
  outcome: 'success',
  timing: { activeSolvingSeconds: 5, correctionSeconds: 0 } as never,
  idempotencyKey: 'success-attempt-1',
  expectedScheduleRevision: revision,
});

type Response = CommitOutcomeResponse;

/** A stub service that plays a scripted sequence of responses. */
function stubService(responses: Response[]) {
  const seen: number[] = [];
  return {
    seen,
    service: {
      async commitOutcome(request: CommitOutcomeRequest): Promise<Response> {
        seen.push(request.expectedScheduleRevision ?? -1);
        const next = responses.shift() ?? responses[responses.length - 1];
        assert.ok(next, 'the stub ran out of scripted responses');
        return next;
      },
    },
  };
}

function committed(scheduleRevision: number): Response {
  return { committed: true, scheduleRevision } as Response;
}
function stale(liveRevision: number): Response {
  return { committed: false, reason: 'stale-schedule-revision', scheduleRevision: liveRevision } as Response;
}

test('a stale revision is retried once with the live revision the reducer reports', async () => {
  const { service, seen } = stubService([stale(7), committed(8)]);

  const result = await commitOutcomeTolerant(service, REQUEST, 3);

  assert.equal(result.recorded, true, 'the attempt is recorded');
  assert.equal(result.scheduleRevision, 8);
  assert.deepEqual(seen, [3, 7], 'the retry used the live revision, not the stale one');
});

test('a normal commit is not retried', async () => {
  const { service, seen } = stubService([committed(4)]);
  const result = await commitOutcomeTolerant(service, REQUEST, 3);
  assert.equal(result.recorded, true);
  assert.deepEqual(seen, [3]);
});

test('a duplicate (already recorded) counts as recorded and is not retried', async () => {
  const { service, seen } = stubService([{ committed: true, scheduleRevision: 5 } as Response]);
  const result = await commitOutcomeTolerant(service, REQUEST, 5);
  assert.equal(result.recorded, true);
  assert.deepEqual(seen, [5]);
});

test('a non-stale rejection is reported, not retried, and never silently swallowed', async () => {
  const { service, seen } = stubService([
    { committed: false, reason: 'no-schedule', scheduleRevision: 0 } as Response,
  ]);
  const result = await commitOutcomeTolerant(service, REQUEST, 3);
  assert.equal(result.recorded, false, 'the caller can tell the user');
  assert.deepEqual(seen, [3], 'no pointless retry for an unrecoverable reason');
});

test('a second stale rejection is not retried forever', async () => {
  const { service, seen } = stubService([stale(7), stale(9)]);
  const result = await commitOutcomeTolerant(service, REQUEST, 3);
  assert.equal(result.recorded, false);
  assert.deepEqual(seen, [3, 7], 'exactly one retry');
});
