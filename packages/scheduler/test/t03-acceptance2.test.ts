import { test, describe } from "node:test";
import assert from "node:assert";
import type { TimingSegments } from "@chessreps/contracts";
import { scoreOnce } from "../src/transition.ts";
import { applyCorrectionCompletion, createInitialSchedule } from "../src/core.ts";
import { resolveSettings } from "../src/settings.ts";
import { commitScoredOutcome, createSchedulerState } from "../src/commit.ts";

const settings = resolveSettings();

function tsNeutral(): TimingSegments {
  return { activeSolvingSeconds: 60, correctionSeconds: 0, interruptionSeconds: 0, hiddenSeconds: 0, timingTrustworthy: true };
}
function tsFast(): TimingSegments {
  return { activeSolvingSeconds: 30, correctionSeconds: 0, interruptionSeconds: 0, hiddenSeconds: 0, timingTrustworthy: true };
}
function tsSlow(): TimingSegments {
  return { activeSolvingSeconds: 120, correctionSeconds: 0, interruptionSeconds: 0, hiddenSeconds: 0, timingTrustworthy: true };
}

function toReviewAtRung(prev: any, targetRung: number, baseAt: number): any {
  let cur = prev;
  let at = baseAt;
  let rung = 0;
  while (rung < targetRung) {
    const res = scoreOnce({ prev: cur, outcome: "success", occurredAt: at, timing: tsNeutral(), requiredMoves: 4 }, settings);
    at = res.next.dueAt ?? at + 86_400_000;
    cur = res.next;
    rung = cur.rung ?? rung;
  }
  return { cur, at };
}

describe("T03 acceptance scenarios 2", () => {
  test("AC05 Step-back: review rung 3 fails with b=1 -> rung 2 due a+7d", () => {
    const s = resolveSettings({ failurePreset: "step-back", stepBackAmount: 1 });
    const base = createInitialSchedule(s);
    const t0 = 0;
    const r = toReviewAtRung(base, 3, t0);
    const failAt = r.at + 1000;
    const fail = scoreOnce({ prev: r.cur, outcome: "failure", occurredAt: failAt, timing: tsNeutral(), requiredMoves: 4 }, s);
    assert.equal(fail.next.state, "review");
    assert.equal(fail.next.rung, 2);
    assert.ok(fail.next.dueAt === failAt + 7 * 86_400_000);
  });

  test("AC06 Retry-retain: rung 4, b=1 fails; relearning S -> return rung 3 exits to rung 3 due a+14d", () => {
    const s = resolveSettings({ failurePreset: "retry-retain", retryRetainAmount: 1 });
    const base = createInitialSchedule(s);
    const r = toReviewAtRung(base, 4, 0);
    const failAt = r.at + 500;
    const fail = scoreOnce({ prev: r.cur, outcome: "failure", occurredAt: failAt, timing: tsNeutral(), requiredMoves: 4 }, s);
    assert.equal(fail.next.state, "relearning");
    assert.equal(fail.next.returnRung, 3);
    const succAt = failAt + 10 * 60 * 1000;
    const succ = scoreOnce({ prev: fail.next, outcome: "success", occurredAt: succAt, timing: tsNeutral(), requiredMoves: 4 }, s);
    assert.equal(succ.next.state, "review");
    assert.equal(succ.next.rung, 3);
    assert.ok(succ.next.dueAt === succAt + 14 * 86_400_000);
  });

  test("AC07 Timing math: n=4 T=60s, t=30 gives f~1.05 (14.7d), t=60 14d, t>=120 12.6d; all advance to rung 3", () => {
    const s = resolveSettings();
    const base = createInitialSchedule(s);
    const r = toReviewAtRung(base, 2, 0);
    const at = r.at;
    const fast = scoreOnce({ prev: r.cur, outcome: "success", occurredAt: at + 1, timing: tsFast(), requiredMoves: 4 }, s);
    assert.equal(fast.next.state, "review");
    assert.equal(fast.next.rung, 3);
    assert.ok(Math.abs((fast.next.dueAt! - (at + 1)) - Math.round(14 * 86_400_000 * 1.05)) < 2000);
    const neutral = scoreOnce({ prev: r.cur, outcome: "success", occurredAt: at + 2, timing: tsNeutral(), requiredMoves: 4 }, s);
    assert.ok(Math.abs((neutral.next.dueAt! - (at + 2)) - 14 * 86_400_000) < 2000);
    const slow = scoreOnce({ prev: r.cur, outcome: "success", occurredAt: at + 3, timing: tsSlow(), requiredMoves: 4 }, s);
    assert.ok(Math.abs((slow.next.dueAt! - (at + 3)) - Math.round(14 * 86_400_000 * 0.9)) < 2000);
  });

  test("AC08 Correctness/cap: failure not timed; rung 7 with f=1.10 capped at 240d", () => {
    const s = resolveSettings();
    const base = createInitialSchedule(s);
    let cur = base;
    let at = 0;
    for (let i = 0; i < 9; i++) {
      const res = scoreOnce({ prev: cur, outcome: "success", occurredAt: at, timing: tsNeutral(), requiredMoves: 4 }, s);
      at = res.next.dueAt ?? at + 86_400_000;
      cur = res.next;
    }
    assert.equal(cur.rung, 7);
    const topFast = scoreOnce({ prev: cur, outcome: "success", occurredAt: at + 10, timing: tsFast(), requiredMoves: 4 }, s);
    assert.equal(topFast.next.rung, 7);
    assert.ok(topFast.next.dueAt === at + 10 + 240 * 86_400_000);
  });

  test("AC09 No compounding: next neutral", () => {
    const s = resolveSettings();
    const base = createInitialSchedule(s);
    const r2 = toReviewAtRung(base, 2, 0);
    const first = scoreOnce({ prev: r2.cur, outcome: "success", occurredAt: r2.at + 1, timing: tsFast(), requiredMoves: 4 }, s);
    const second = scoreOnce({ prev: first.next, outcome: "success", occurredAt: first.next.dueAt! + 1, timing: tsNeutral(), requiredMoves: 4 }, s);
    assert.equal(second.next.rung, 4);
    assert.ok(Math.abs((second.next.dueAt! - (first.next.dueAt! + 1)) - 30 * 86_400_000) < 2000);
  });

  test("AC10 Duplicate/conflicting delivery with commit reducer", () => {
    const st0 = createSchedulerState(settings);
    const cid = { value: "c1" };
    const pk = { programId: "p", puzzleId: "z" };
    const res1 = commitScoredOutcome(
      st0,
      {
        attemptId: cid,
        expectedScheduleRevision: 0,
        idempotencyKey: "k1",
        outcome: "failure",
        occurredAt: 1000,
        timing: tsNeutral(),
        requiredMoves: 3,
      },
      settings,
    );
    assert.equal(res1.status, "committed");
    const res2 = commitScoredOutcome(
      res1.state,
      {
        attemptId: cid,
        expectedScheduleRevision: 1,
        idempotencyKey: "k1",
        outcome: "failure",
        occurredAt: 2000,
        timing: tsNeutral(),
        requiredMoves: 3,
      },
      settings,
    );
    assert.equal(res2.status, "duplicate");
    const res3 = commitScoredOutcome(
      res1.state,
      {
        attemptId: cid,
        expectedScheduleRevision: 1,
        idempotencyKey: "k2",
        outcome: "success",
        occurredAt: 2000,
        timing: tsNeutral(),
        requiredMoves: 3,
      },
      settings,
    );
    assert.equal(res3.status, "conflict");
  });
});
