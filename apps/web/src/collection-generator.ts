import type { NormalizedPuzzle } from '@chessengram/contracts';

export interface CollectionFilter { size: number; ratingMin?: number; ratingMax?: number; themes?: string[] }

/** Seeded Fisher–Yates sampling, with exact theme intersection semantics. */
export function selectCollectionPuzzles(puzzles: readonly NormalizedPuzzle[], filter: CollectionFilter, seed = 1): string[] {
  if (!Number.isInteger(filter.size) || filter.size < 100 || filter.size > 1000) throw new Error('Collection size must be between 100 and 1000.');
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const themes = filter.themes ?? [];
  const matches = puzzles.filter((puzzle) =>
    (filter.ratingMin === undefined || puzzle.rating >= filter.ratingMin)
    && (filter.ratingMax === undefined || puzzle.rating <= filter.ratingMax)
    && themes.every((theme) => puzzle.themes.includes(theme)));
  if (matches.length < filter.size) throw new Error(`Only ${matches.length} puzzles match; ${filter.size} required.`);
  for (let i = matches.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [matches[i], matches[j]] = [matches[j]!, matches[i]!];
  }
  return matches.slice(0, filter.size).map((puzzle) => puzzle.id);
}
