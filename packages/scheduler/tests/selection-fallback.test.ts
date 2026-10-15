import { test, describe } from "node:test";
import assert from "node:assert";
import type { ScheduleStateDetails } from "@chessreps/contracts";
import {
  selectEarliestFutureDue,
  selectNextDue,
  type Candidate,
} from "../src/selection.ts";

/**
 * UX-001 unit tests for the practice-ahead fallback. `selectNextDue`
 * (due-priority ordering) is intentionally untouched; the fallback is a
 * separate pure helper used only for the explicit opt-in path.
 */

const NOW = 1_000_000;

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

describe("selectEarliestFutureDue", () => {
  test("returns null when nothing is due in the future", () => {
    const candidates = [
      cand("a", "new"),
      cand("b", "review", NOW - 1000),
      cand("c", "learning", NOW),
    ];
    assert.equal(selectEarliestFutureDue(candidates, { now: NOW }), null);
    assert.equal(selectEarliestFutureDue([], { now: NOW }), null);
  });

  test("picks the earliest future due time across states", () => {
    const candidates = [
      cand("late", "review", NOW + 86_400_000),
      cand("early", "learning", NOW + 60_000),
      cand("fresh", "new"),
    ];
    assert.equal(
      selectEarliestFutureDue(candidates, { now: NOW })?.progressKey,
      "early",
    );
  });

  test("skips reserved keys and breaks ties by orderKey", () => {
    const candidates = [
      cand("b", "review", NOW + 1000),
      cand("a", "review", NOW + 1000),
    ];
    assert.equal(
      selectEarliestFutureDue(candidates, { now: NOW })?.progressKey,
      "a",
    );
    assert.equal(
      selectEarliestFutureDue(candidates, {
        now: NOW,
        reservedKeys: new Set(["a"]),
      })?.progressKey,
      "b",
    );
    assert.equal(
      selectEarliestFutureDue(candidates, {
        now: NOW,
        reservedKeys: new Set(["a", "b"]),
      }),
      null,
    );
  });
});

describe("selectNextDue ordering is unchanged", () => {
  test("due learning beats due review beats new; null when nothing eligible", () => {
    const candidates = [
      cand("new1", "new"),
      cand("rev", "review", NOW - 5000),
      cand("learn", "learning", NOW - 1000),
    ];
    assert.equal(
      selectNextDue(candidates, { now: NOW, newOrder: ["prog:new1"] }),
      "learn",
    );
    const future = [
      cand("learn", "learning", NOW + 1000),
      cand("new1", "new"),
    ];
    // New puzzles are eligible regardless of due time, so new1 is chosen;
    // a pure all-future-due set still yields null (fallback stays separate).
    assert.equal(selectNextDue(future, { now: NOW, newOrder: [] }), "new1");
    assert.equal(
      selectNextDue([cand("learn", "learning", NOW + 1000)], { now: NOW }),
      null,
    );
  });
});
