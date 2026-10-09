/**
 * Puzzle content validation and normalization (PB3).
 *
 * Ports the `tools/puzzles` acceptance rules to chessops for on-device use:
 *   - the position must be a legal chess setup,
 *   - every solution ply must be legal from the solver position (alternating
 *     solver / opponent, starting with the solver),
 *   - an optional setup move must legally lead FROM sourceFen TO solverFen,
 *   - a "mate"-tagged puzzle must actually end in checkmate,
 *   - solverColor must agree with the side to move in solverFen.
 *
 * This is the single validator reused by the JSONL import, the puzzle creator /
 * editor, and the Lichess puzzle-CSV import.
 */

import { Chess } from 'chessops/chess';
import { makeFen, parseFen } from 'chessops/fen';
import type { Setup } from 'chessops/setup';
import { parseUci } from 'chessops/util';
import type { Color } from 'chessops/types';
import type { NormalizedPuzzle } from '@chessreps/contracts';

const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
const ID_RE = /^[A-Za-z0-9_-]+$/;

export interface PuzzleInput {
  id?: string;
  rating?: number;
  themes?: string[];
  source?: string;
  sourceId?: string;
  sourceFen?: string;
  setupMove?: string;
  solverFen: string;
  solution: readonly string[];
  solverColor?: 'white' | 'black';
}

export type ValidationResult =
  | { ok: true; puzzle: NormalizedPuzzle }
  | { ok: false; errors: string[] };

function fenError(fen: string): string | undefined {
  const result = parseFen(fen);
  return result.isErr ? result.error.message : undefined;
}

function setupFrom(fen: string): Setup | undefined {
  const result = parseFen(fen);
  return result.isOk ? result.value : undefined;
}

function chessFrom(fen: string): { chess?: Chess; message?: string } {
  const setup = setupFrom(fen);
  if (!setup) return { message: fenError(fen) };
  const result = Chess.fromSetup(setup);
  if (result.isErr) return { message: result.error.message };
  return { chess: result.value };
}

function uid(salt = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`): string {
  return `u-${salt}`;
}

/** Lichess-style id (5 alphanumeric) generator for creator-made puzzles. */
export function makeLichessStyleId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 5; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

export function normalizeUciList(text: string): string[] {
  return text
    .split(/\s+/)
    .map((m) => m.trim())
    .filter(Boolean);
}

export function solutionToText(puzzle: NormalizedPuzzle): string {
  return puzzle.solution.join(' ');
}

/**
 * Validate raw user/import input and turn it into a NormalizedPuzzle.
 * Returns a flat list of human-readable errors otherwise.
 */
export function validateAndNormalize(input: PuzzleInput): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['input is not an object'] };
  }

  const solverFen = String(input.solverFen ?? '');
  const solverFenProblem = fenError(solverFen);
  if (solverFenProblem) errors.push(`invalid solver FEN (${solverFenProblem})`);
  else if (!setupFrom(solverFen)?.board.occupied.size()) errors.push('solver FEN is an empty board');

  const rawSolution = input.solution ?? [];
  if (!Array.isArray(rawSolution) || rawSolution.length === 0) {
    errors.push('solution must be a non-empty list of UCI moves');
  }

  const id = input.id === undefined || input.id === '' ? makeLichessStyleId() : String(input.id);
  if (!ID_RE.test(id)) errors.push(`invalid id "${id}": use letters, digits, _ or -`);

  const rating = input.rating === undefined ? 0 : Number(input.rating);
  if (!Number.isFinite(rating) || rating < 0) errors.push(`invalid rating: ${input.rating}`);

  const setupMove = input.setupMove ? String(input.setupMove).trim() : undefined;
  if (setupMove && !UCI_RE.test(setupMove)) errors.push(`invalid setup move: ${setupMove}`);

  const solution = rawSolution.map((m) => String(m).trim());
  for (const move of solution) {
    if (!UCI_RE.test(move)) errors.push(`invalid solution move: ${move}`);
  }

  const sourceFen = input.sourceFen ? String(input.sourceFen) : undefined;
  if (setupMove && !sourceFen) {
    errors.push('a source FEN is required when a setup move is given');
  } else if (sourceFen) {
    const sourceProblem = fenError(sourceFen);
    if (sourceProblem) errors.push(`invalid source FEN (${sourceProblem})`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // Position must be legal, and the setup move must bridge sourceFen -> solverFen.
  const solver = chessFrom(solverFen);
  if (!solver.chess) return { ok: false, errors: [`solver position is illegal (${solver.message})`] };
  const board = solver.chess;
  const solverFenNormalized = makeFen(board.toSetup());

  if (setupMove) {
    const source = chessFrom(sourceFen!);
    if (!source.chess) return { ok: false, errors: [`source position is illegal (${source.message})`] };
    const move = parseUci(setupMove);
    if (!move || !source.chess.isLegal(move)) {
      errors.push(`setup move ${setupMove} is not legal from the source FEN`);
    } else {
      source.chess.play(move);
      if (makeFen(source.chess.toSetup()) !== solverFenNormalized) {
        errors.push('source FEN + setup move does not reach the solver FEN');
      }
    }
  }

  // Every solution ply must be legal, alternating solver/opponent from solverFen.
  const pos = board.clone();
  for (const [index, uci] of solution.entries()) {
    const move = parseUci(uci);
    if (!move || !pos.isLegal(move)) {
      errors.push(`solution move ${index + 1} "${uci}" is not legal at that position`);
      break;
    }
    pos.play(move);
  }

  const derivedColor: Color = board.turn;
  const solverColorInput = input.solverColor ?? derivedColor;
  if (solverColorInput !== derivedColor) {
    errors.push(`solverColor "${solverColorInput}" disagrees with the side to move (${derivedColor})`);
  }

  const themes = (input.themes ?? []).map((theme) => String(theme).trim()).filter(Boolean);
  if (themes.includes('mate') && !pos.isCheckmate()) {
    errors.push('theme "mate" but the line does not end in checkmate');
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    puzzle: {
      id,
      contentSchemaVersion: '1.0.0',
      rating,
      source: input.source ?? 'user',
      sourceId: input.sourceId && input.sourceId !== '' ? String(input.sourceId) : id,
      themes,
      sourceFen: input.setupMove ? sourceFen! : solverFen,
      setupMove,
      solverFen: solverFenNormalized,
      solverColor: derivedColor,
      solution: [...solution],
      originalFields: {},
    },
  };
}

// --- import formats ---------------------------------------------------------

export interface ImportResult {
  puzzles: NormalizedPuzzle[];
  errors: string[];
  examined: number;
}

/** Parse a JSONL file: one JSON object per line (the pack/bundle format). */
export function parseJsonlPuzzles(text: string): ImportResult {
  const puzzles: NormalizedPuzzle[] = [];
  const errors: string[] = [];
  let examined = 0;
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//')) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      errors.push(`line ${index + 1}: invalid JSON`);
      continue;
    }
    examined += 1;
    const result = normalizeKnownRecord(value);
    if (result.ok) {
      puzzles.push(result.puzzle);
    } else {
      errors.push(`line ${index + 1}: ${result.errors.join('; ')}`);
    }
  }
  return { puzzles, errors, examined };
}

/** Accept pack-shaped records and plain key/value variations. */
function normalizeKnownRecord(value: unknown): ValidationResult {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, errors: ['not an object'] };
  }
  const record = value as Record<string, unknown>;
  if (record.solverFen === undefined || record.solution === undefined) {
    return { ok: false, errors: ['record is missing solverFen/solution'] };
  }
  const input: PuzzleInput = {
    id: record.id === undefined ? undefined : String(record.id),
    rating: record.rating === undefined ? undefined : Number(record.rating),
    themes: Array.isArray(record.themes) ? (record.themes as unknown[]).map(String) : [],
    source: record.source === undefined ? undefined : String(record.source),
    sourceId: record.sourceId === undefined ? undefined : String(record.sourceId),
    sourceFen: record.sourceFen === undefined ? undefined : String(record.sourceFen),
    setupMove: record.setupMove === undefined ? undefined : String(record.setupMove),
    solverFen: String(record.solverFen),
    solution: Array.isArray(record.solution) ? (record.solution as unknown[]).map(String) : [],
    solverColor: record.solverColor === 'white' || record.solverColor === 'black'
      ? record.solverColor
      : undefined,
  };
  const result = validateAndNormalize(input);
  if (!result.ok) return result;
  return {
    ok: true,
    puzzle: {
      ...result.puzzle,
      ratingDeviation: record.ratingDeviation === undefined
        ? undefined
        : Number(record.ratingDeviation),
      originalFields: (record.originalFields as Record<string, unknown>) ?? {},
    },
  };
}