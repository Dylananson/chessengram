/**
 * APP-001 PWA helpers: install prompt capture, persistent-storage request, and
 * an offline-readiness snapshot for the Settings panel.
 *
 * Browser-only APIs are guarded so this module stays importable under Node
 * (the view tests import the Settings screen). All reads are passive: nothing
 * here writes app data.
 */

/** Assets that must be cached before we call the app offline-ready. */
export const REQUIRED_OFFLINE_ASSETS = [
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/data/puzzles/lichess-900-1099-v1/pack.jsonl',
  '/data/puzzles/lichess-bands-v1/pack.jsonl',
  '/data/puzzles/lichess-bands-v1/bands.json',
] as const;

export const SHELL_CACHE_PREFIX = 'chessengram-shell-';

export interface PwaSnapshot {
  /** Running as an installed app (home screen / standalone window). */
  installed: boolean;
  /** A deferred install prompt is available (Android/desktop Chrome). */
  canInstall: boolean;
  /** iOS Safari has no prompt: installing is a manual Share -> Add to Home. */
  ios: boolean;
  /** Every required asset, plus a hashed bundle, is in the shell cache. */
  offlineReady: boolean;
  /** Required assets still missing from the cache. */
  missing: string[];
  usageBytes?: number;
  quotaBytes?: number;
  /** IndexedDB/Cache persistence was requested and granted where supported. */
  persisted?: boolean;
}

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice?: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPromptEvent | null = null;

function hasWindow(): boolean {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined';
}

/** Detect the app being launched from an installed home-screen/window. */
export function isInstalled(): boolean {
  if (!hasWindow()) return false;
  const standalone = typeof window.matchMedia === 'function'
    && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = (navigator as unknown as { standalone?: boolean }).standalone === true;
  return standalone || iosStandalone;
}

export function isIos(): boolean {
  if (!hasWindow()) return false;
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; treat touch-capable Macs as iOS.
  return /iPad|iPhone|iPod/.test(ua)
    || (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);
}

/**
 * Capture the install prompt and ask the browser to keep our storage. Called
 * once at boot; safe to call under Node (no-op).
 */
export function initPwa(): void {
  if (!hasWindow()) return;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
  });
  // Best effort: keep the puzzle library and progress from being evicted.
  void navigator.storage?.persist?.().catch(() => {});
}

/** Whether an install prompt can be shown right now. */
export function canInstall(): boolean {
  return deferredPrompt !== null;
}

/**
 * Show the captured install prompt. Resolves true when the user accepted.
 * No prompt available (iOS, already installed, or not offered yet) -> false.
 */
export async function promptInstall(): Promise<boolean> {
  if (deferredPrompt === null) return false;
  const event = deferredPrompt;
  deferredPrompt = null;
  await event.prompt();
  const choice = await event.userChoice?.catch(() => undefined);
  return choice?.outcome === 'accepted';
}

/** Shell cache key currently in use, if any. */
async function shellCacheKey(): Promise<string | undefined> {
  const keys = await caches.keys();
  return keys.find((key) => key.startsWith(SHELL_CACHE_PREFIX));
}

/**
 * Inspect the shell cache and storage estimate. Read-only; returns a safe
 * "not ready" snapshot when the Cache/Storage APIs are unavailable (Node tests,
 * insecure context).
 */
export async function pwaSnapshot(): Promise<PwaSnapshot> {
  const base: PwaSnapshot = {
    installed: isInstalled(),
    canInstall: canInstall(),
    ios: isIos(),
    offlineReady: false,
    missing: [...REQUIRED_OFFLINE_ASSETS],
  };
  if (!hasWindow() || typeof caches === 'undefined') return base;

  let missing: string[] = [...REQUIRED_OFFLINE_ASSETS];
  try {
    const key = await shellCacheKey();
    if (key !== undefined) {
      const cache = await caches.open(key);
      const present = new Set((await cache.keys()).map((request) => new URL(request.url).pathname));
      missing = REQUIRED_OFFLINE_ASSETS.filter((asset) => !present.has(asset));
      const hasBundle = [...present].some((path) => path.startsWith('/assets/'));
      if (!hasBundle) missing = [...missing, 'hashed bundle'];
    }
  } catch {
    /* treat as not ready */
  }

  const snapshot: PwaSnapshot = {
    ...base,
    offlineReady: missing.length === 0,
    missing,
  };
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.usage !== undefined) snapshot.usageBytes = estimate.usage;
    if (estimate?.quota !== undefined) snapshot.quotaBytes = estimate.quota;
  } catch {
    /* optional */
  }
  try {
    snapshot.persisted = (await navigator.storage?.persisted?.()) ?? undefined;
  } catch {
    /* optional */
  }
  return snapshot;
}

/** `12.3 MB` / `820 KB` / `0 B`. */
export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
