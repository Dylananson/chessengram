import type { NormalizedPuzzle } from '@chessreps/contracts';

export const DEFAULT_PACK_PATH = '/data/puzzles/lichess-900-1099-v1/pack.jsonl';
export const DEFAULT_PACK_ID = 'lichess-900-1099-v1';

export interface LoadedPack {
  packId: string;
  path: string;
  puzzles: NormalizedPuzzle[];
  parseErrors: number;
}

/**
 * Fetch and parse a JSONL content pack. Invalid lines are skipped (counted in
 * `parseErrors`) rather than failing the whole pack, so one bad row cannot brick
 * the player.
 */
export async function loadPuzzlesFromPack(
  path: string = DEFAULT_PACK_PATH,
  packId: string = DEFAULT_PACK_ID,
): Promise<LoadedPack> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Failed to load pack: ${response.status} ${path}`);
  }
  const text = await response.text();
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const puzzles: NormalizedPuzzle[] = [];
  let parseErrors = 0;
  for (const line of lines) {
    try {
      puzzles.push(JSON.parse(line) as NormalizedPuzzle);
    } catch {
      parseErrors += 1;
    }
  }
  return { packId, path, puzzles, parseErrors };
}

export async function loadPuzzleByIndex(index = 0, path?: string): Promise<NormalizedPuzzle> {
  const { puzzles } = await loadPuzzlesFromPack(path);
  return puzzles[index % puzzles.length]!;
}
