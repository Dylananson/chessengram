import type { NormalizedPuzzle } from './types.js';

const PACK_PATH = '/data/puzzles/lichess-900-1099-v1/pack.jsonl';

export async function loadPuzzlesFromPack(): Promise<NormalizedPuzzle[]> {
  const response = await fetch(PACK_PATH);
  if (!response.ok) {
    throw new Error(`Failed to load pack: ${response.status}`);
  }
  const text = await response.text();
  const lines = text.trim().split('\n');
  const puzzles: NormalizedPuzzle[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i]);
      // The pack entries should already be in NormalizedPuzzle shape
      puzzles.push(parsed as NormalizedPuzzle);
    } catch (e) {
      console.warn(`Failed to parse line ${i + 1}:`, e);
    }
  }
  return puzzles;
}

export async function loadPuzzleByIndex(index = 0): Promise<NormalizedPuzzle> {
  const puzzles = await loadPuzzlesFromPack();
  if (index >= puzzles.length) {
    index = 0;
  }
  return puzzles[index];
}
