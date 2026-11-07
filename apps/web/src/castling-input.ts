/**
 * Castling input normalisation shared by the puzzle and analysis boards.
 *
 * Chessground offers *two* representations of a castling move in
 * `movable.dests` (see chessops' `chessgroundDests`): the king's two-square
 * target (`e1g1`) and the rook's square (`e1h1`, chessground's `rookCastle`
 * default). Both are legal chessops moves, but `makeUci` reports the squares
 * the user actually touched, so a king dropped on its own rook yields
 * `e1h1` — which never matches the standard `e1g1` in a puzzle solution.
 *
 * Normalise any king-dropped-on-own-back-rank-rook input to the king's
 * two-square target so every layer (grading, premove probes, analysis lines)
 * sees one canonical move. Illegal drops are left alone and still rejected by
 * the caller's legality check.
 */
import type { Position } from 'chessops/chess';
import type { SquareName } from 'chessops/types';
import { kingCastlesTo, makeSquare, parseSquare, squareFile, squareRank } from 'chessops/util';

export function normalizeCastlingDest(position: Position, from: SquareName, to: SquareName): SquareName {
  const fromSq = parseSquare(from);
  const toSq = parseSquare(to);
  if (fromSq === undefined || toSq === undefined) return to;

  const mover = position.board.get(fromSq);
  const target = position.board.get(toSq);
  if (mover?.role !== 'king' || target?.role !== 'rook' || target.color !== mover.color) return to;

  // Only a king on its own back rank can be castling; anything else is an
  // ordinary (and illegal) king move onto a friendly rook.
  const homeRank = mover.color === 'white' ? 0 : 7;
  if (squareRank(fromSq) !== homeRank || squareRank(toSq) !== homeRank) return to;

  const side = squareFile(toSq) < squareFile(fromSq) ? 'a' : 'h';
  return makeSquare(kingCastlesTo(mover.color, side));
}
