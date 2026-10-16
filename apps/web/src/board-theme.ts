/** Display-only chessboard square color preference. */
export const BOARD_THEME_KEY = 'chessreps.boardTheme';

export const BOARD_THEMES = ['green', 'blue', 'wood', 'slate', 'classic'] as const;
export type BoardTheme = (typeof BOARD_THEMES)[number];
export const DEFAULT_BOARD_THEME: BoardTheme = 'green';

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface ClassTarget {
  classList: Pick<DOMTokenList, 'add' | 'remove'>;
}

export function parseBoardTheme(value: unknown): BoardTheme {
  return typeof value === 'string' && (BOARD_THEMES as readonly string[]).includes(value)
    ? (value as BoardTheme)
    : DEFAULT_BOARD_THEME;
}

export function getSavedBoardTheme(storage: StorageLike | undefined = browserStorage()): BoardTheme {
  try {
    return parseBoardTheme(storage?.getItem(BOARD_THEME_KEY));
  } catch {
    return DEFAULT_BOARD_THEME;
  }
}

function browserStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** Load, validate, and apply the preference before the first board render. */
export function applySavedBoardTheme(
  target?: ClassTarget,
  storage: StorageLike | undefined = browserStorage(),
): BoardTheme {
  const theme = getSavedBoardTheme(storage);
  applyBoardThemeClass(theme, target);
  return theme;
}

export function saveBoardTheme(
  value: unknown,
  target?: ClassTarget,
  storage: StorageLike | undefined = browserStorage(),
): BoardTheme {
  const theme = parseBoardTheme(value);
  try {
    storage?.setItem(BOARD_THEME_KEY, theme);
  } catch {
    // Applying the choice still works for this page if persistence is blocked.
  }
  applyBoardThemeClass(theme, target);
  return theme;
}

function applyBoardThemeClass(theme: BoardTheme, target?: ClassTarget): void {
  const element = target ?? (typeof document === 'undefined' ? undefined : document.body);
  if (!element) return;
  for (const name of BOARD_THEMES) element.classList.remove(`board-theme-${name}`);
  element.classList.add(`board-theme-${theme}`);
}
