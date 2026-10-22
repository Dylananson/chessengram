/**
 * Public content distribution for the CC0 puzzle packs.
 *
 * The worker serves **only** the small `content-manifest.json` produced by
 * `tools/puzzles/pack-manifest.py`: a cacheable list of packs with their
 * content-addressed URLs. The large `pack.jsonl` bytes are never streamed
 * through the worker — they live on the CDN / R2 / Pages mirror named by
 * `CONTENT_BASE_URL`, and clients fetch immutable `<packId>/<version>/…` URLs.
 *
 * `ContentSource` is the injected seam so tests need no network or account:
 *
 * - `InMemoryContentSource` (tests, or a parsed build-time JSON).
 * - A `FileContentSource` / `R2ContentSource` reads `content-manifest.json`
 *   from a build artifact or an R2/Pages binding in production:
 *
 *     class R2ContentSource implements ContentSource {
 *       constructor(private bucket: { get(key: string): Promise<{ text(): Promise<string> } | null> }) {}
 *       async loadManifest(): Promise<unknown> {
 *         const object = await this.bucket.get('content-manifest.json');
 *         if (object === null) throw new Error('content-manifest.json is missing');
 *         return JSON.parse(await object.text());
 *       }
 *     }
 *
 * Deploy wiring lives in `selectContentSource` (`contentSourceFromEnv`) and is
 * documented in `services/sync-worker/README.md`.
 */

export interface ContentSource {
  loadManifest(): Promise<unknown>;
}

/** A manifest already held in memory (tests, or a parsed build-time JSON). */
export class InMemoryContentSource implements ContentSource {
  readonly #manifest: unknown;

  constructor(manifest: unknown) {
    this.#manifest = manifest;
  }

  async loadManifest(): Promise<unknown> {
    return this.#manifest;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a content source from a `CONTENT_MANIFEST` JSON string binding — the
 * "build-time JSON" deploy path, with no bucket/account required. A missing or
 * malformed value yields `undefined`, so the worker stays *unconfigured* and
 * fails closed rather than serving a half-parsed manifest.
 */
export function contentSourceFromEnv(
  env: Record<string, unknown> = {},
): ContentSource | undefined {
  const raw = env.CONTENT_MANIFEST;
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  try {
    return new InMemoryContentSource(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Fill in pack `url`s from `CONTENT_BASE_URL` when a pack does not embed one.
 * A manifest that already carries absolute urls (or a base that is not set) is
 * returned unchanged, and the shape is left untouched for unrecognised input.
 */
export function applyContentBaseUrl(manifest: unknown, baseUrl: string | undefined): unknown {
  if (baseUrl === undefined) return manifest;
  const base = baseUrl.replace(/\/+$/, '');
  if (base.length === 0) return manifest;
  if (!isRecord(manifest) || !Array.isArray(manifest.packs)) return manifest;

  let changed = false;
  const packs = manifest.packs.map((pack) => {
    if (!isRecord(pack)) return pack;
    const existing = pack.url;
    if (typeof existing === 'string' && existing.length > 0) return pack;
    const packId = pack.packId;
    const version = pack.version;
    if (typeof packId !== 'string' || packId.length === 0) return pack;
    if (typeof version !== 'string' || version.length === 0) return pack;
    changed = true;
    return { ...pack, url: `${base}/${packId}/${version}/pack.jsonl` };
  });

  return changed ? { ...manifest, packs } : manifest;
}
