import type { NormalizedPuzzle } from '@chessreps/contracts';

export const DEFAULT_PACK_PATH = '/data/puzzles/lichess-900-1099-v1/pack.jsonl';
export const DEFAULT_PACK_ID = 'lichess-900-1099-v1';

/** Bundled rating-band content (F02): 500-puzzle, theme-diverse collections. */
export const BANDS_PACK_PATH = '/data/puzzles/lichess-bands-v1/pack.jsonl';
export const BANDS_META_PATH = '/data/puzzles/lichess-bands-v1/bands.json';
export const BANDS_PACK_ID = 'lichess-bands-v1';

export interface BundledBand {
  id: string;
  name: string;
  label: string;
  ratingMin: number;
  ratingMax: number | null;
  puzzleIds: string[];
}

export interface LoadedBands {
  packId: string;
  puzzles: NormalizedPuzzle[];
  bands: BundledBand[];
}

export interface LoadedPack {
  packId: string;
  path: string;
  puzzles: NormalizedPuzzle[];
  parseErrors: number;
}

/**
 * The bundled pack predates the contract envelope and uses `original` instead
 * of `originalFields`, and omits `contentSchemaVersion`. Normalize it here so
 * the seeded content is schema-correct and round-trips through storage (an
 * unstamped envelope version would otherwise be dropped on the next load).
 */
function normalizePackPuzzle(raw: Record<string, unknown>): NormalizedPuzzle {
  const { original, ...rest } = raw;
  return {
    ...(rest as Omit<NormalizedPuzzle, 'contentSchemaVersion' | 'originalFields'>),
    contentSchemaVersion: (rest.contentSchemaVersion as NormalizedPuzzle['contentSchemaVersion']) ?? '1.0.0',
    originalFields:
      (rest.originalFields as NormalizedPuzzle['originalFields']) ??
      (original as NormalizedPuzzle['originalFields']) ??
      {},
  };
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
      puzzles.push(normalizePackPuzzle(JSON.parse(line) as Record<string, unknown>));
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

/**
 * Load the bundled rating-band pack together with its band definitions. The
 * pack and its metadata are separate fetches; the metadata file carries the
 * stable collection ids, names and rating bounds.
 */
export async function loadBundledBands(
  path: string = BANDS_PACK_PATH,
  metaPath: string = BANDS_META_PATH,
  packId: string = BANDS_PACK_ID,
): Promise<LoadedBands> {
  const [pack, response] = await Promise.all([loadPuzzlesFromPack(path, packId), fetch(metaPath)]);
  if (!response.ok) {
    throw new Error(`Failed to load band metadata: ${response.status} ${metaPath}`);
  }
  const document = (await response.json()) as { bands?: BundledBand[] };
  return { packId, puzzles: pack.puzzles, bands: Array.isArray(document.bands) ? document.bands : [] };
}
