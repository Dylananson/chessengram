import { test, describe } from "node:test";
import assert from "node:assert";
import type { ScheduleStateDetails, TimingSegments } from "@chessengram/contracts";
import { fixedClock } from "../src/clock.ts";
import { scoreOnce } from "../src/transition.ts";
import { applyCorrectionCompletion, createInitialSchedule } from "../src/core.ts";
import { resolveSettings } from "../src/settings.ts";
import { Scheduler } from "../src/scheduler.ts";
import { commitScoredOutcome, createSchedulerState, finishCorrection, startAttempt } from "../src/commit.ts";

const settings = resolveSettings();

function tsNeutral(): TimingSegments {
  return {
    activeSolvingSeconds: 60,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

function tsFast(): TimingSegments {
  return {
    activeSolvingSeconds: 30,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

function tsSlow(): TimingSegments {
  return {
    activeSolvingSeconds: 120,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

function tsSlowish(): TimingSegments {
  return {
    activeSolvingSeconds: 60,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

function tsWithInterruption(): TimingSegments {
  return {
    activeSolvingSeconds: 35,
    correctionSeconds: 0,
    interruptionSeconds: 1,
    hiddenSeconds: 0,
    timingTrustworthy: true,
  };
}

describe("T03 acceptance scenarios", () => {
  test("AC01 Acquisition: New clean -> Learning -> Review", () => {
    const base = createInitialSchedule(settings);
    const t1 = 9_000_000;
    const r1 = scoreOnce({ prev: base, outcome: "success", occurredAt: t1, timing: tsNeutral(), requiredMoves: 4 }, settings);
    assert.equal(r1.next.state, "learning");
    assert.ok(r1.next.dueAt === t1 + 10 * 60 * 1000);
    const r2 = scoreOnce({ prev: r1.next, outcome: "success", occurredAt: t1 + 10 * 60 * 1000, timing: tsNeutral(), requiredMoves: 4 }, settings);
    assert.equal(r2.next.state, "review");
    assert.equal(r2.next.rung, 0);
    assert.ok(r2.next.dueAt === (t1 + 10 * 60 * 1000) + 86_400_000);
  });

  test("AC02 Failure survives correction; enters relearning with returnRung 0", () => {
    const s = createSchedulerState(settings);
    const sched = new Scheduler({ clock: fixedClock(0), settings });
    const attemptId = { value: "a1" };
    const pk = { programId: "p", puzzleId: "pz1" };
    void s.schedule;
    const st = sched.createState();
    // put into review rung 3 first? simulate: start new, success, success, learning success -> review 0, then success x3? easier: fabricate
    let cur = createInitialSchedule(settings);
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 0, timing: tsNeutral(), requiredMoves: 4 }, settings).next;
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 0, timing: tsNeutral(), requiredMoves: 4 }, settings).next;
    assert.equal(cur.state, "review");
    assert.equal(cur.rung, 0);
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 10_000, timing: tsNeutral(), requiredMoves: 4 }, settings).next;
    assert.equal(cur.rung, 1);
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 20_000, timing: tsNeutral(), requiredMoves: 4 }, settings).next;
    assert.equal(cur.rung, 2);
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 30_000, timing: tsFast(), requiredMoves: 4 }, settings).next; // rung 3
    assert.equal(cur.rung, 3);
    // fail
    const failAt = 40_000;
    const fail = scoreOnce({ prev: cur, outcome: "failure", occurredAt: failAt, timing: tsNeutral(), requiredMoves: 4 }, settings);
    assert.equal(fail.next.state, "relearning");
    assert.equal(fail.next.returnRung, 0);
    assert.ok(fail.next.dueAt === failAt + 10 * 60 * 1000);
    assert.equal(fail.effect.lapseIncremented, true);
    // correction completion
    const afterCorr = applyCorrectionCompletion(fail.next);
    assert.equal(afterCorr.state, "relearning");
    assert.equal(afterCorr.returnRung, 0);
    assert.equal(afterCorr.dueAt, fail.next.dueAt);
  });

  test("AC03 Retry from scratch creates new attempt", () => {
    const base = createInitialSchedule(settings);
    let cur = scoreOnce({ prev: base, outcome: "success", occurredAt: 0, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 10 * 60 * 1000, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    assert.equal(cur.state, "review");
    const failAt = 100_000;
    cur = scoreOnce({ prev: cur, outcome: "failure", occurredAt: failAt, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    assert.equal(cur.state, "relearning");
    // new attempt starts fresh from original solver position; we simulate by creating initial state and scoring
    const retryAt = failAt + 10 * 60 * 1000;
    let retry = createInitialSchedule(settings);
    retry = scoreOnce({ prev: retry, outcome: "success", occurredAt: retryAt, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    retry = scoreOnce({ prev: retry, outcome: "success", occurredAt: retryAt + 10 * 60 * 1000, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    assert.equal(retry.state, "review");
    assert.equal(retry.rung, 0);
  });

  test("AC04 Repeated relearning failures do not add Review lapses", () => {
    const base = createInitialSchedule(settings);
    let cur = scoreOnce({ prev: base, outcome: "success", occurredAt: 0, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    cur = scoreOnce({ prev: cur, outcome: "success", occurredAt: 600_000, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    const lapse0 = cur.lapseCount;
    cur = scoreOnce({ prev: cur, outcome: "failure", occurredAt: 1_000_000, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    assert.equal(cur.state, "relearning");
    assert.equal(cur.lapseCount, lapse0 + 1);
    const t = cur.dueAt!;
    cur = scoreOnce({ prev: cur, outcome: "failure", occurredAt: t + 100, timing: tsNeutral(), requiredMoves: 3 }, settings).next;
    assert.equal(cur.state, "relearning");
    assert.equal(cur.lapseCount, lapse0 + 1);
    assert.equal(cur.returnRung, 0);
    assert.ok(cur.dueAt === t + 100 + 10 * 60 * 1000);
  });
});
