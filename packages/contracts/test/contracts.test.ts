import { test, describe } from "node:test";
import assert from "node:assert";
import { InMemoryTrainingService } from "../src/reference-implementation.ts";
import type { NormalizedPuzzle } from "../src/types.ts";

// Load real puzzle fixtures from data
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../../..");
const packPath = join(projectRoot, "data/puzzles/lichess-900-1099-v1/pack.jsonl");

const packContent = readFileSync(packPath, "utf8");
const puzzleLines = packContent.trim().split(/\n/).slice(0, 3); // Use 3 real puzzles

function createNormalizedPuzzleFromPack(line: string): NormalizedPuzzle {
  const raw = JSON.parse(line);
  return {
    id: raw.id,
    contentSchemaVersion: "1.0.0",
    rating: raw.rating,
    ratingDeviation: raw.ratingDeviation,
    source: raw.source || "lichess",
    sourceId: raw.original?.PuzzleId || raw.id,
    themes: raw.themes || [],
    sourceFen: raw.sourceFen,
    setupMove: raw.setupMove,
    solverFen: raw.solverFen,
    solverColor: raw.solverColor,
    solution: raw.solution || [],
    originalFields: raw.original || {},
  };
}

const fixtures = puzzleLines.map(createNormalizedPuzzleFromPack);

describe("TrainingService contracts", () => {
  test("startSession creates a new session", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const response = await service.startSession({
      programId: "puzzle-spaced-rep",
    });
    assert.ok(response.session.sessionId);
    assert.equal(response.session.programId, "puzzle-spaced-rep");
    assert.equal(response.session.scheduleRevision, 0);
  });

  test("loadPuzzle returns normalized puzzle with correct schema", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const response = await service.loadPuzzle({ puzzleId: fixtures[0].id });
    assert.equal(response.puzzle.id, fixtures[0].id);
    assert.equal(response.puzzle.contentSchemaVersion, "1.0.0");
    assert.equal(response.puzzle.sourceFen, fixtures[0].sourceFen);
    assert.equal(response.puzzle.solverFen, fixtures[0].solverFen);
    assert.deepEqual(response.puzzle.solution, fixtures[0].solution);
  });

  test("startAttempt creates attempt with starting position", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const session = await service.startSession({ programId: "test" });
    const attempt = await service.startAttempt({
      sessionId: session.session.sessionId,
      progressKey: { programId: "test", puzzleId: fixtures[0].id },
      expectedScheduleRevision: 0,
    });
    assert.ok(attempt.attemptId.value);
    assert.equal(attempt.startingFen, fixtures[0].solverFen);
  });

  test("commitOutcome with success updates schedule state", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const session = await service.startSession({ programId: "test" });
    const attempt = await service.startAttempt({
      sessionId: session.session.sessionId,
      progressKey: { programId: "test", puzzleId: fixtures[0].id },
      expectedScheduleRevision: 0,
    });
    const result = await service.commitOutcome({
      attemptId: attempt.attemptId,
      outcome: "success",
      timing: {
        activeSolvingSeconds: 10,
        correctionSeconds: 0,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      expectedScheduleRevision: 0,
      idempotencyKey: "key1",
    });
    assert.ok(result.committed);
    assert.ok(result.receipt);
    // A new puzzle advances to learning on first success (per-program scope)
    assert.equal(result.newScheduleState?.state, "learning");
    assert.ok(result.newScheduleState?.dueAt);
  });

  test("commitOutcome is idempotent via idempotencyKey", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const session = await service.startSession({ programId: "test" });
    const attempt = await service.startAttempt({
      sessionId: session.session.sessionId,
      progressKey: { programId: "test", puzzleId: fixtures[1].id },
      expectedScheduleRevision: 0,
    });
    const req = {
      attemptId: attempt.attemptId,
      outcome: "failure" as const,
      failureReason: "wrong-move" as const,
      timing: {
        activeSolvingSeconds: 5,
        correctionSeconds: 2,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      expectedScheduleRevision: 0,
      idempotencyKey: "idemp-1",
    };
    const r1 = await service.commitOutcome(req);
    const r2 = await service.commitOutcome(req);
    assert.deepEqual(r1.receipt?.receiptId, r2.receipt?.receiptId);
  });

  test("correction completion does not change scored outcome", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const session = await service.startSession({ programId: "test" });
    const attempt = await service.startAttempt({
      sessionId: session.session.sessionId,
      progressKey: { programId: "test", puzzleId: fixtures[2].id },
      expectedScheduleRevision: 0,
    });
    await service.commitOutcome({
      attemptId: attempt.attemptId,
      outcome: "failure",
      failureReason: "wrong-move",
      timing: {
        activeSolvingSeconds: 3,
        correctionSeconds: 10,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      expectedScheduleRevision: 0,
      idempotencyKey: "fail-1",
    });
    const corr = await service.finishCorrection({
      attemptId: attempt.attemptId,
      timing: {
        activeSolvingSeconds: 3,
        correctionSeconds: 15,
        interruptionSeconds: 0,
        hiddenSeconds: 0,
        timingTrustworthy: true,
      },
      idempotencyKey: "corr-1",
    });
    assert.ok(corr.accepted);
    const rec = await service.getAttempt({ attemptId: attempt.attemptId });
    assert.equal(rec.outcome, "failure");
  });

  test("selectNext returns a puzzle", async () => {
    const service = new InMemoryTrainingService(fixtures);
    const session = await service.startSession({ programId: "test" });
    const next = await service.selectNext({
      sessionId: session.session.sessionId,
      programId: "test",
    });
    assert.ok(next.puzzleId !== null || next.reason);
  });
});
