/**
 * AN-002 — the chessground adapter for the analysis screen.
 *
 * The analysis board is a *free* board (both sides, any legal move), which the
 * puzzle board deliberately is not. Keeping this adapter separate means
 * `train-view.ts` (the serialized lane) is not touched for analysis work, and
 * the view stays testable with a fake port.
 */
import { Chessground } from 'chessground';
import type { Api } from 'chessground/api';
import type { Key } from 'chessground/types';
import { chessgroundDests } from 'chessops/compat';
import { Chess } from 'chessops/chess';
import { parseFen } from 'chessops/fen';
import type { SquareName } from 'chessops/types';
import type { AnalysisBoardPort } from './analysis-view.ts';

export interface AnalysisBoardOptions {
  /** Called for every legal user move on the free board. */
  onMove: (from: SquareName, to: SquareName) => void;
}

/** Build a free-play chessground board and return the port the view uses. */
export function createAnalysisBoard(host: HTMLElement, options: AnalysisBoardOptions): AnalysisBoardPort {
  let fen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  const dests = (): Map<Key, Key[]> => {
    const setup = parseFen(fen);
    if (setup.isErr) return new Map();
    const position = Chess.fromSetup(setup.value);
    if (position.isErr) return new Map();
    return chessgroundDests(position.value) as Map<Key, Key[]>;
  };

  const ground: Api = Chessground(host, {
    fen,
    orientation: 'white',
    coordinates: true,
    animation: { enabled: true, duration: 150 },
    drawable: { enabled: true, visible: true, shapes: [] },
    movable: {
      // Free play: both colours, any legal move — this is an analysis board.
      free: false,
      color: 'both',
      dests: dests(),
      showDests: true,
      events: {
        after: (orig: Key, dest: Key) => options.onMove(orig as SquareName, dest as SquareName),
      },
    },
  });

  return {
    setFen(next: string) {
      fen = next;
      // Recompute destinations for the new position; without this the board
      // would keep the previous position's legal-move set.
      ground.set({ fen: next, movable: { dests: dests() } });
    },
    setOrientation(color: 'white' | 'black') {
      ground.set({ orientation: color });
    },
    setShapes(shapes: Array<{ orig: string; dest?: string; brush?: string }>) {
      ground.set({
        drawable: {
          shapes: shapes.map((shape) => ({
            orig: shape.orig as Key,
            ...(shape.dest !== undefined ? { dest: shape.dest as Key } : {}),
            brush: shape.brush ?? 'green',
          })),
        },
      });
    },
    onMove(handler) {
      options.onMove = handler;
    },
  };
}
