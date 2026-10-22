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
import { parsePgn, startingPosition, type Node, type PgnNodeData } from 'chessops/pgn';
import { parseSan } from 'chessops/san';
import type { Setup } from 'chessops/setup';
import { makeUci, parseUci } from 'chessops/util';
import type { Color } from 'chessops/types';
import type { NormalizedPuzzle } from '@chessengram/contracts';

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
    solverColor:
      record.solverColor === 'white' || record.solverColor === 'black'
        ? record.solverColor
        : undefined,
  };
  const result = validateAndNormalize(input);
  if (!result.ok) return result;
  return {
    ok: true,
    puzzle: {
      ...result.puzzle,
      ratingDeviation:
        record.ratingDeviation === undefined ? undefined : Number(record.ratingDeviation),
      originalFields: (record.originalFields as Record<string, unknown>) ?? {},
    },
  };
}

// --- Lichess puzzle CSV ------------------------------------------------------

const LICHESS_COLUMNS = [
  'PuzzleId',
  'FEN',
  'Moves',
  'Rating',
  'RatingDeviation',
  'Popularity',
  'NbPlays',
  'Themes',
  'GameUrl',
  'OpeningTags',
] as const;

/** Minimal RFC-4180-ish CSV parser (handles quoted fields and CRLF). */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizeLichessRow(row: Record<string, string>): ValidationResult {
  const id = row.PuzzleId ?? '';
  const sourceFen = row.FEN ?? '';
  const moves = (row.Moves ?? '').split(/\s+/).filter(Boolean);
  if (moves.length < 2 || moves.length % 2 !== 0) {
    return { ok: false, errors: [`expected setup + an even solver line, got ${moves.length} plies`] };
  }
  const source = chessFrom(sourceFen);
  if (!source.chess) return { ok: false, errors: [`invalid FEN (${source.message})`] };

  let solverFen: string | undefined;
  for (const [index, uci] of moves.entries()) {
    const move = parseUci(uci);
    if (!move || !source.chess.isLegal(move)) {
      return { ok: false, errors: [`illegal ply ${index + 1}: ${uci}`] };
    }
    source.chess.play(move);
    if (index === 0) solverFen = makeFen(source.chess.toSetup());
  }
  if (!solverFen) return { ok: false, errors: ['could not derive solver position'] };

  const rating = Number(row.Rating);
  const ratingDeviation = row.RatingDeviation === undefined ? undefined : Number(row.RatingDeviation);
  const themes = (row.Themes ?? '').split(/\s+/).filter(Boolean);

  const result = validateAndNormalize({
    id,
    rating: Number.isFinite(rating) ? rating : 0,
    themes,
    source: 'lichess',
    sourceId: id,
    sourceFen,
    setupMove: moves[0],
    solverFen,
    solution: moves.slice(1),
  });
  if (!result.ok) return result;

  const originalFields: Record<string, unknown> = {};
  for (const column of LICHESS_COLUMNS) originalFields[column] = row[column] ?? '';

  return {
    ok: true,
    puzzle: { ...result.puzzle, ratingDeviation, originalFields },
  };
}

/**
 * Parse the official Lichess puzzle CSV export. The first move of `Moves` is
 * the opponent's setup move; `FEN` is the position before it.
 */
export function parseLichessCsv(text: string): ImportResult {
  const puzzles: NormalizedPuzzle[] = [];
  const errors: string[] = [];
  const rows = parseCsvRows(text);
  if (rows.length === 0) return { puzzles, errors: ['empty file'], examined: 0 };

  const header = rows[0]!.map((h) => h.trim());
  const required = ['PuzzleId', 'FEN', 'Moves', 'Rating', 'Themes'];
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    return { puzzles, errors: [`missing required column(s): ${missing.join(', ')}`], examined: 0 };
  }

  let examined = 0;
  for (const row of rows.slice(1)) {
    if (row.length === 1 && row[0]!.trim() === '') continue;
    examined += 1;
    const record: Record<string, string> = {};
    header.forEach((column, index) => {
      record[column] = row[index] ?? '';
    });
    const result = normalizeLichessRow(record);
    if (result.ok) puzzles.push(result.puzzle);
    else errors.push(`row ${examined} (${record.PuzzleId || '?'}): ${result.errors.join('; ')}`);
  }
  return { puzzles, errors, examined };
}
// --- PGN import -------------------------------------------------------------

export interface PgnCandidate {
  index: number;
  headers: Record<string, string>;
  solverFen?: string;
  solverColor: 'white' | 'black';
  plies: number;
  variations: number;
  /** Present when the game's mainline validated as a puzzle. */
  puzzle?: NormalizedPuzzle;
  /** Present when the game could not be turned into a puzzle. */
  error?: string;
}

export interface PgnPreview {
  candidates: PgnCandidate[];
}

const SUPPORTED_VARIANTS = new Set(['standard', 'chess', 'from position', '']);

function countVariations(node: Node<PgnNodeData>): number {
  let count = node.children.length > 1 ? node.children.length - 1 : 0;
  for (const child of node.children) count += countVariations(child);
  return count;
}

/**
 * Turn each PGN game into a puzzle candidate: the game's starting position is
 * the solver position and the mainline is the solution. Variations are counted
 * and reported but never imported as solutions (T13: no silent mistake branches).
 */
export function previewPgn(text: string): PgnPreview {
  const games = parsePgn(text);
  const candidates: PgnCandidate[] = [];

  games.forEach((game, i) => {
    const headers: Record<string, string> = {};
    for (const [key, value] of game.headers) headers[key] = value;

    const candidate: PgnCandidate = {
      index: i + 1,
      headers,
      solverColor: 'white',
      plies: 0,
      variations: countVariations(game.moves),
    };

    const variant = (headers.Variant ?? '').toLowerCase();
    if (!SUPPORTED_VARIANTS.has(variant)) {
      candidate.error = `unsupported variant: ${headers.Variant}`;
      candidates.push(candidate);
      return;
    }

    const start = startingPosition(game.headers);
    if (start.isErr) {
      candidate.error = `invalid start position (${start.error.message})`;
      candidates.push(candidate);
      return;
    }

    const pos = start.value;
    candidate.solverFen = makeFen(pos.toSetup());
    candidate.solverColor = pos.turn === 'white' ? 'white' : 'black';

    const solution: string[] = [];
    let problem: string | undefined;
    for (const node of game.moves.mainline()) {
      const move = parseSan(pos, node.san);
      if (!move) {
        problem = `illegal SAN "${node.san}" at ply ${solution.length + 1}`;
        break;
      }
      solution.push(makeUci(move));
      pos.play(move);
    }
    candidate.plies = solution.length;

    if (problem) {
      candidate.error = problem;
      candidates.push(candidate);
      return;
    }
    if (solution.length === 0) {
      candidate.error = 'game has no moves';
      candidates.push(candidate);
      return;
    }

    const normalized = validateAndNormalize({
      id: makeLichessStyleId(),
      rating: 0,
      themes: [],
      source: 'pgn',
      sourceId: headers.Site || headers.Event || `pgn-${i + 1}`,
      solverFen: candidate.solverFen,
      solution,
    });
    if (normalized.ok) {
      candidate.puzzle = {
        ...normalized.puzzle,
        originalFields: headers as Record<string, unknown>,
      };
    } else {
      candidate.error = normalized.errors.join('; ');
    }
    candidates.push(candidate);
  });

  return { candidates };
}
