/**
 * REN-001b: one-time migration of namespaced `localStorage` keys after the
 * product rename.
 *
 * The **IndexedDB database name is deliberately unchanged** (see AGENTS.md —
 * renaming it would silently empty the app), and so are the stored ids. The only
 * things that moved are the small preference keys that carried the old product
 * prefix; without this, an existing install would quietly forget its language
 * and board theme, which is a data-loss bug dressed up as a rename.
 *
 * Safe by construction: it only writes when the new key is absent and the old
 * one exists, it never throws (private mode / quota), and it removes the legacy
 * key so it runs once.
 */

/** Old key -> new key. Add to this map when a namespaced key is renamed. */
export const RENAMED_STORAGE_KEYS: Readonly<Record<string, string>> = {
  'chessreps.locale': 'chessengram.locale',
  'chessreps.boardTheme': 'chessengram.boardTheme',
};

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function migrateLegacyStorageKeys(
  storage: StorageLike | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  if (!storage) return;
  for (const [legacyKey, newKey] of Object.entries(RENAMED_STORAGE_KEYS)) {
    try {
      if (storage.getItem(newKey) !== null) continue; // already migrated: new choice wins
      const legacy = storage.getItem(legacyKey);
      if (legacy === null) continue;
      storage.setItem(newKey, legacy);
      storage.removeItem(legacyKey);
    } catch {
      // Storage unavailable: preferences simply fall back to their defaults.
    }
  }
}
