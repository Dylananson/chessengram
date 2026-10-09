import type { NormalizedPuzzle, TimingSegments } from '../src/types.ts';
import { LocalTrainingService } from '../src/scheduler-service.ts';
import { LocalStore } from '../src/storage/local-store.ts';
import { InMemoryStorageBackend } from '../src/storage/memory-backend.ts';

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function makePuzzle(
  overrides: Partial<NormalizedPuzzle> & { id: string },
): NormalizedPuzzle {
  return {
    contentSchemaVersion: '1.0.0',
    rating: 1000,
    source: 'lichess',
    sourceId: overrides.id,
    themes: [],
    sourceFen: START_FEN,
    solverFen: START_FEN,
    solverColor: 'white',
    solution: ['e2e4'],
    originalFields: {},
    ...overrides,
  };
}

/** The T02 setup-move example: a move precedes the solver's turn. */
export const setupMovePuzzle = makePuzzle({
  id: 'setup-move-example',
  rating: 905,
  sourceId: '01q5Z',
  themes: ['endgame', 'mate', 'mateIn2', 'short'],
  sourceFen: '5r1k/pp4pp/8/3B4/1P2pRQ1/P5PP/3q4/6K1 b - - 2 33',
  setupMove: 'f8f4',
  solverFen: '7k/pp4pp/8/3B4/1P2prQ1/P5PP/3q4/6K1 w - - 0 34',
  solution: ['g4c8', 'f4f8', 'c8f8'],
});

/** A one-move promotion puzzle: white pawn b7 promotes on b8. */
export const promotionPuzzle = makePuzzle({
  id: 'promotion-example',
  solverFen: '7k/1P6/8/8/8/8/8/K7 w - - 0 1',
  solution: ['b7b8q'],
});

export async function makeService(
  backend = new InMemoryStorageBackend(),
): Promise<LocalTrainingService> {
  const service = new LocalTrainingService({ store: new LocalStore(backend) });
  await service.init();
  return service;
}

export const PROGRAM_ID = 'test-program';

export function timing(overrides: Partial<TimingSegments> = {}): TimingSegments {
  return {
    activeSolvingSeconds: 5,
    correctionSeconds: 0,
    interruptionSeconds: 0,
    hiddenSeconds: 0,
    timingTrustworthy: true,
    ...overrides,
  };
}
