import { test, describe } from "node:test";
import assert from "node:assert";
import type { ScheduleStateDetails } from "@chessreps/contracts";
import {
  selectEarliestFutureDue,
  selectNextDue,
  type Candidate,
} from "../src/selection.ts";

/**
 * UX-004 queue-fairness lock for `selectNextDue` simultaneous-due ordering.
 * Behavior is intentionally unchanged from UX-001; these tests pin it:
 * tier priority Learning/Relearning > Review > New, within-tier ties by
 * dueAt then orderKey, New by stable newOrder then orderKey.
 */

const NOW = 2_000_000;

function details(state: ScheduleStateDetails["state"], dueAt?: number): ScheduleStateDetails {
  return {
    scheduleSchemaVersion: "1.0.0",
    state,
    ...(dueAt !== undefined ? { dueAt } : {}),
    algorithmId: "ladder-v1",
    algorithmVersion: "1.0.0",
    settingsHash: "test",
    lapseCount: 0,
    currentStepFailureCount: 0,
  };
}

function cand(
  key: string,
  state: ScheduleStateDetails["state"],
  dueAt?: number,
  orderKey?: string,
): Candidate {
  return { progressKey: key, state: details(state, dueAt), orderKey: orderKey ?? key };
}

/** Drain the queue by repeatedly selecting and reserving the winner. */
function drain(candidates: readonly Candidate[], newOrder: readonly string[] = []): string[] {
  const reserved = new Set<string>();
  const picked: string[] = [];
  for (let i = 0; i < candidates.length + 1; i++) {
    const next = selectNextDue(candidates, { now: NOW, reservedKeys: reserved, newOrder });
    if (next === null) break;
    picked.push(next);
    reserved.add(next);
  }
  return picked;
}

describe("UX-004 simultaneous-due tiebreakers", () => {
  test("learning/relearning tier: dueAt first, then orderKey", () => {
    const candidates = [
      cand("late", "learning", NOW - 100),
      cand("b-sim", "relearning", NOW - 5000),
      cand("a-sim", "learning", NOW - 5000),
    ];
    assert.equal(selectNextDue(candidates, { now: NOW }), "a-sim");
    // Full tier drain follows dueAt, then orderKey.
    assert.deepEqual(drain(candidates), ["a-sim", "b-sim", "late"]);
  });

  test("review tier: simultaneous-due resolves by orderKey", () => {
    const candidates = [
      cand("r-c", "review", NOW - 1000),
      cand("r-a", "review", NOW - 1000),
      cand("r-b", "review", NOW - 1000),
    ];
    assert.equal(selectNextDue(candidates, { now: NOW }), "r-a");
    assert.deepEqual(drain(candidates), ["r-a", "r-b", "r-c"]);
  });

  test("tier priority holds with identical due times: learning > review > new", () => {
    const candidates = [
      cand("n1", "new"),
      cand("rev", "review", NOW - 1000),
      cand("lrn", "learning", NOW - 1000),
    ];
    assert.equal(selectNextDue(candidates, { now: NOW, newOrder: ["n1"] }), "lrn");
    assert.deepEqual(drain(candidates, ["n1"]), ["lrn", "rev", "n1"]);
  });

  test("new tier: stable newOrder, unlisted keys last, orderKey fallback", () => {
    const candidates = [cand("n-b", "new"), cand("n-a", "new"), cand("n-c", "new")];
    const newOrder = ["n-b", "n-a"]; // n-c unlisted
    assert.equal(
      selectNextDue(candidates, { now: NOW, newOrder }),
      "n-b",
    );
    assert.deepEqual(drain(candidates, newOrder), ["n-b", "n-a", "n-c"]);
    // Empty newOrder falls back to pure orderKey order.
    assert.deepEqual(drain(candidates, []), ["n-a", "n-b", "n-c"]);
  });
});

describe("UX-004 no starvation across repeated selections", () => {
  test("mixed queue drain visits every eligible candidate (new not starved)", () => {
    const candidates = [
      cand("new-1", "new"),
      cand("new-2", "new"),
      cand("rev-1", "review", NOW - 2000),
      cand("rev-2", "review", NOW - 2000),
      cand("fail-1", "relearning", NOW - 1000), // recently-failed
      cand("fail-2", "learning", NOW - 1000), // recently-failed
    ];
    const newOrder = ["new-1", "new-2"];
    const picked = drain(candidates, newOrder);
    // Recently-failed (learning/relearning) first, then review, then new —
    // and every candidate is eventually served exactly once.
    assert.deepEqual(picked, ["fail-1", "fail-2", "rev-1", "rev-2", "new-1", "new-2"]);
    assert.equal(new Set(picked).size, candidates.length);
  });

  test("large simultaneous-due set drains completely without skips", () => {
    const candidates = Array.from(
      { length: 20 },
      (_, i) => cand(`k-${String(i).padStart(2, "0")}`, "review", NOW - 1000),
    );
    const picked = drain([...candidates].reverse());
    assert.equal(picked.length, candidates.length);
    assert.deepEqual([...picked].sort(), candidates.map((c) => c.progressKey).sort());
    // Deterministic: sorted by orderKey.
    assert.deepEqual(picked, [...picked].sort());
  });
});

describe("UX-004 stable repeatable order for identical inputs", () => {
  test("identical calls return the identical key", () => {
    const candidates = [
      cand("b", "review", NOW - 1000),
      cand("a", "review", NOW - 1000),
      cand("c", "learning", NOW - 1000),
    ];
    const opts = { now: NOW, newOrder: [] as readonly string[] };
    const first = selectNextDue(candidates, opts);
    for (let i = 0; i < 10; i++) {
      assert.equal(selectNextDue(candidates, opts), first);
    }
  });

  test("input permutation does not change the pick", () => {
    const base = [
      cand("b", "review", NOW - 1000),
      cand("a", "review", NOW - 1000),
      cand("n", "new"),
    ];
    const expected = selectNextDue(base, { now: NOW, newOrder: [] });
    // All 6 permutations of 3 items.
    const perms = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    for (const p of perms) {
      const permuted = p.map((i) => base[i]!);
      assert.equal(selectNextDue(permuted, { now: NOW, newOrder: [] }), expected);
    }
    assert.equal(expected, "a");
  });

  test("new-tier pick is permutation-stable under a fixed newOrder", () => {
    const base = [cand("n3", "new"), cand("n1", "new"), cand("n2", "new")];
    const newOrder = ["n2", "n1", "n3"];
    const expected = selectNextDue(base, { now: NOW, newOrder });
    assert.equal(expected, "n2");
    assert.equal(
      selectNextDue([...base].reverse(), { now: NOW, newOrder }),
      expected,
    );
  });
});

describe("UX-004 selectEarliestFutureDue semantics preserved", () => {
  test("all-future set still yields null from selectNextDue and earliest from fallback", () => {
    const candidates = [
      cand("later", "review", NOW + 86_400_000),
      cand("sooner", "learning", NOW + 60_000),
    ];
    assert.equal(selectNextDue(candidates, { now: NOW }), null);
    assert.equal(
      selectEarliestFutureDue(candidates, { now: NOW })?.progressKey,
      "sooner",
    );
  });
});
