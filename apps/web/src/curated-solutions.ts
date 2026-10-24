/**
 * Explicit exceptions for verified alternate puzzle lines. Never populate this
 * from engine output. `canonicalSolution` must exactly match the bundled line;
 * verification records the human/source evidence for each alternate.
 * Lichess source semantics: https://database.lichess.org/#puzzles describes
 * one `Moves` line per CSV row and explicitly calls out the mate-in-one case.
 *
 * The current registry is intentionally empty: no alternate has yet been
 * verified against repository/source evidence. Add entries only after review.
 */
export interface CuratedSolutionEntry {
  readonly canonicalSolution: readonly string[];
  readonly alternatives: readonly {
    readonly line: readonly string[];
    readonly verification: string;
  }[];
}

export const CURATED_SOLUTIONS: Readonly<Record<string, CuratedSolutionEntry>> = {};
