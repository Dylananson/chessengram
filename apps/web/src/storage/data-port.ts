/**
 * Export/import port for the local store (PB5 data safety).
 *
 * The export is a self-describing JSON document (`chessengram-export`). Import is
 * strictly one-way and lossless: the raw on-disk envelopes are restored as-is.
 *
 * ## Migration policy (Q12)
 *
 * - The document carries `formatVersion`. Only versions in `SUPPORTED_VERSIONS`
 *   are accepted; a newer/unknown version is rejected rather than guessed at.
 * - When the format changes, add a `Migration` from the previous version to the
 *   next here. Migrations run in sequence until the document reaches the current
 *   `EXPORT_FORMAT_VERSION`. Never edit an existing migration once shipped.
 * - Individual records keep their own `schemaVersion`. The store already treats
 *   a record whose version it does not understand as absent, so a restore never
 *   silently misinterprets data. A record-level migration is only needed when a
 *   future record shape must be transformed, not merely ignored.
 * - Before any import the caller snapshots current data into the `backups`
 *   collection (excluded from exports), so a bad import is recoverable.
 */

import {
  COLLECTION_COLLECTIONS,
  COLLECTION_SYNC,
  COLLECTION_WOODPECKER,
  DEFAULT_COLLECTION_ID,
  EXPECTED_COLLECTION_SCHEMA_VERSION,
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  LOCAL_STORE_SCHEMA_VERSION,
  META_ACTIVE_COLLECTION,
  STORE_COLLECTIONS,
  type CollectionRecord,
  type StoreExport,
  type StoreExportSummary,
} from './local-store.ts';

export const SUPPORTED_EXPORT_VERSIONS = ['1.0.0', '1.1.0', '1.2.0', '1.3.0'] as const;

export interface Migration {
  from: string;
  to: string;
  migrate: (data: StoreExport) => StoreExport;
}

/** Sequential migrations, applied until `EXPORT_FORMAT_VERSION` is reached. */
export const MIGRATIONS: readonly Migration[] = [
  { from: '1.0.0', to: '1.1.0', migrate: migrate100to110 },
  { from: '1.1.0', to: '1.2.0', migrate: migrate110to120 },
  { from: '1.2.0', to: '1.3.0', migrate: migrate120to130 },
];

/**
 * B4 (2026-10-15): schedule scope becomes (program, collection, puzzle).
 * Legacy schedule keys `program:puzzle` move into the default collection
 * scope; a default collection seeded with the export's content ids is added
 * when none exists; the active collection defaults when absent. Raw attempt
 * records keep their recorded keys untouched (history is auditable
 * as-recorded). On a key collision the already-scoped record wins; legacy
 * 1.0.0 data cannot contain scoped keys, so this only triggers on
 * hand-edited files.
 */
function migrate100to110(data: StoreExport): StoreExport {
  const collections = { ...(data.collections ?? {}) };

  const rawSchedules = isRecord(collections.schedules) ? collections.schedules : {};
  const nextSchedules: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawSchedules)) {
    if (key.split(':').length === 2) {
      const [programId, ...rest] = key.split(':');
      const scoped = `${programId}:${DEFAULT_COLLECTION_ID}:${rest.join(':')}`;
      // Already-scoped record wins on collision; otherwise the legacy record moves.
      nextSchedules[scoped] = nextSchedules[scoped] ?? rawSchedules[scoped] ?? value;
    } else {
      nextSchedules[key] = value;
    }
  }
  collections.schedules = nextSchedules;

  const rawLibrary = isRecord(collections.collections) ? collections.collections : {};
  if (Object.keys(rawLibrary).length === 0) {
    const contentIds = isRecord(collections.content) ? Object.keys(collections.content) : [];
    const record: CollectionRecord = {
      id: DEFAULT_COLLECTION_ID,
      name: 'Default',
      puzzleIds: contentIds,
      createdAt: data.exportedAt,
    };
    rawLibrary[DEFAULT_COLLECTION_ID] = {
      schemaVersion: EXPECTED_COLLECTION_SCHEMA_VERSION,
      savedAt: data.exportedAt,
      data: record,
    };
  }
  collections.collections = rawLibrary;

  const rawMeta = isRecord(collections.meta) ? collections.meta : {};
  if (!(META_ACTIVE_COLLECTION in rawMeta)) {
    rawMeta[META_ACTIVE_COLLECTION] = {
      schemaVersion: LOCAL_STORE_SCHEMA_VERSION,
      savedAt: data.exportedAt,
      data: DEFAULT_COLLECTION_ID,
    };
  }
  collections.meta = rawMeta;

  return { ...data, formatVersion: '1.1.0', collections };
}

/** F01: add an empty logical record collection; existing envelopes are untouched. */
function migrate110to120(data: StoreExport): StoreExport {
  const collections = { ...data.collections };
  if (!isRecord(collections[COLLECTION_WOODPECKER])) {
    collections[COLLECTION_WOODPECKER] = {};
  }
  return { ...data, formatVersion: '1.2.0', collections };
}

/**
 * ONL-001: add the (empty) `sync` collection. Every other collection — including
 * any records this build does not know about — is carried over byte-for-byte.
 */
function migrate120to130(data: StoreExport): StoreExport {
  const collections = { ...data.collections };
  if (!isRecord(collections[COLLECTION_SYNC])) {
    collections[COLLECTION_SYNC] = {};
  }
  return { ...data, formatVersion: '1.3.0', collections };
}

export type ParseExportResult =
  | { ok: true; data: StoreExport }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksLikeExport(value: unknown): value is StoreExport {
  if (!isRecord(value)) return false;
  if (value.format !== EXPORT_FORMAT) return false;
  if (typeof value.formatVersion !== 'string') return false;
  if (typeof value.exportedAt !== 'number') return false;
  if (!isRecord(value.collections)) return false;
  return true;
}

function migrateToCurrent(data: StoreExport): StoreExport {
  let current = data;
  let guard = 0;
  while (current.formatVersion !== EXPORT_FORMAT_VERSION) {
    const migration = MIGRATIONS.find((m) => m.from === current.formatVersion);
    if (!migration) {
      throw new Error(
        `no migration path from export version ${current.formatVersion} to ${EXPORT_FORMAT_VERSION}`,
      );
    }
    current = migration.migrate(current);
    guard += 1;
    if (guard > MIGRATIONS.length + 1) throw new Error('migration cycle detected');
  }
  return current;
}

/**
 * Parse and migrate an export document. The parse is centralised so the UI can
 * show a summary and never applies unreadable data.
 */
export function parseExport(text: string): ParseExportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['not valid JSON'] };
  }
  if (!looksLikeExport(raw)) {
    return { ok: false, errors: ['not a ChessEngram export file'] };
  }
  if (!(SUPPORTED_EXPORT_VERSIONS as readonly string[]).includes(raw.formatVersion)) {
    return {
      ok: false,
      errors: [
        `unsupported export version ${raw.formatVersion} (this build reads ${SUPPORTED_EXPORT_VERSIONS.join(', ')})`,
      ],
    };
  }
  try {
    return { ok: true, data: migrateToCurrent(raw) };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function summarizeExport(exported: StoreExport): StoreExportSummary {
  const counts: Record<string, number> = {};
  let total = 0;
  for (const collection of STORE_COLLECTIONS) {
    const count = Object.keys(exported.collections[collection] ?? {}).length;
    counts[collection] = count;
    total += count;
  }
  return {
    formatVersion: exported.formatVersion,
    exportedAt: exported.exportedAt,
    backendKind: exported.backendKind,
    counts,
    total,
  };
}
