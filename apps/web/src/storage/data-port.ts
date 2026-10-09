/**
 * Export/import port for the local store (PB5 data safety).
 *
 * The export is a self-describing JSON document (`chessreps-export`). Import is
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
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  STORE_COLLECTIONS,
  type StoreExport,
  type StoreExportSummary,
} from './local-store.ts';

export const SUPPORTED_EXPORT_VERSIONS = ['1.0.0'] as const;

export interface Migration {
  from: string;
  to: string;
  migrate: (data: StoreExport) => StoreExport;
}

/** Sequential migrations, applied until `EXPORT_FORMAT_VERSION` is reached. */
export const MIGRATIONS: readonly Migration[] = [];

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
    return { ok: false, errors: ['not a ChessReps export file'] };
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
