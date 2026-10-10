import type { AppTheme } from '@oblihub/shared';

export type { AppTheme };

const STORAGE_KEY = 'oh-theme';

// Bulletproof against future themes Obligate might ship — if the SSO assertion pushes
// an id we don't have CSS for, fall back to Operator instead of leaving the app in an
// "invisible" state (no tokens defined → naked HTML).
const KNOWN = new Set<AppTheme>(['obli-operator', 'obli-daylight', 'obli-dim', 'modern', 'neon']);

/** Apply a theme by setting data-theme on <html> and persisting it. */
export function applyTheme(theme: string): void {
  const safe = (KNOWN.has(theme as AppTheme) ? theme : 'obli-operator') as AppTheme;
  document.documentElement.dataset.theme = safe;
  try {
    localStorage.setItem(STORAGE_KEY, safe);
  } catch {
    // localStorage unavailable
  }
}

/** Load the theme from localStorage (used before session check to avoid flash). */
export function loadSavedTheme(): AppTheme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && KNOWN.has(saved as AppTheme)) return saved as AppTheme;
  } catch {
    // ignore
  }
  return 'obli-operator';
}

/** Called once on app boot in main.tsx to prevent flash of wrong theme. */
export function initTheme(): void {
  applyTheme(loadSavedTheme());
}
