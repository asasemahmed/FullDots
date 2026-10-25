/*
 * Theme choice: System, Light or Dark. The resolved theme is a `data-theme` attribute on <html>;
 * every colour in the app comes from tokens.css, so setting that attribute is the whole switch.
 *
 * The choice is per browser (localStorage) and defaults to following the system setting.
 * public/theme-init.js, loaded from the <head> of index.html, applies the same resolution before
 * the first paint so a dark screen never flashes light. It is a file rather than an inline script
 * because the server's Content-Security-Policy only allows scripts from 'self'.
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'fulldots-theme';
export const THEME_PREFERENCES: readonly ThemePreference[] = [
  'system',
  'light',
  'dark',
];
const DARK_QUERY = '(prefers-color-scheme: dark)';
/** Kept in step with --surface-2 (light) and --surface-2 (dark) in tokens.css. */
const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: '#f8f7f4',
  dark: '#14171b',
};

export function isThemePreference(value: unknown): value is ThemePreference {
  return (
    typeof value === 'string' &&
    (THEME_PREFERENCES as readonly string[]).includes(value)
  );
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    /* private window or blocked storage */
    return null;
  }
}

/** The saved choice, or `system` when nothing (valid) is saved. Storage can throw. */
export function readThemePreference(): ThemePreference {
  try {
    const saved = storage()?.getItem(THEME_STORAGE_KEY);
    return isThemePreference(saved) ? saved : 'system';
  } catch {
    return 'system';
  }
}

export function storeThemePreference(preference: ThemePreference): void {
  try {
    storage()?.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
}

/** Does the operating system currently ask for a dark UI? */
export function systemPrefersDark(): boolean {
  try {
    return globalThis.matchMedia?.(DARK_QUERY).matches ?? false;
  } catch {
    return false;
  }
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light';
  return preference;
}

/** Paint one theme: the CSS attribute, the browser UI (scrollbars, form controls) and the tab colour. */
export function applyTheme(
  theme: ResolvedTheme,
  root: HTMLElement = document.documentElement,
  doc: Document = document,
): void {
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = THEME_COLORS[theme];
  doc.dispatchEvent(new CustomEvent('fulldots:theme', { detail: theme }));
}

function applyPreference(preference: ThemePreference): ResolvedTheme {
  const theme = resolveTheme(preference);
  applyTheme(theme);
  return theme;
}

/**
 * Applies the saved theme now and keeps following the system setting (and other tabs) afterwards.
 * Returns a cleanup function. Safe to call once from the app entry point.
 */
export function startThemeSync(): () => void {
  applyPreference(readThemePreference());
  const query = globalThis.matchMedia?.(DARK_QUERY);
  const onSystemChange = () => {
    if (readThemePreference() === 'system') applyPreference('system');
  };
  query?.addEventListener('change', onSystemChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    applyPreference(readThemePreference());
  };
  globalThis.addEventListener?.('storage', onStorage);
  return () => {
    query?.removeEventListener('change', onSystemChange);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

export type ThemeController = {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
};

/** Theme state for the Settings control; changing it applies and saves immediately. */
export function useThemePreference(): ThemeController {
  const [preference, setPreferenceState] =
    useState<ThemePreference>(readThemePreference);
  const [theme, setTheme] = useState<ResolvedTheme>(() =>
    resolveTheme(readThemePreference()),
  );

  useEffect(() => {
    const sync = () => {
      const saved = readThemePreference();
      setPreferenceState(saved);
      setTheme(applyPreference(saved));
    };
    sync();
    const query = globalThis.matchMedia?.(DARK_QUERY);
    query?.addEventListener('change', sync);
    globalThis.addEventListener?.('storage', sync);
    return () => {
      query?.removeEventListener('change', sync);
      globalThis.removeEventListener?.('storage', sync);
    };
  }, []);

  const setPreference = useCallback((next: ThemePreference) => {
    if (!isThemePreference(next)) return;
    storeThemePreference(next);
    setPreferenceState(next);
    setTheme(applyPreference(next));
  }, []);

  return { preference, theme, setPreference };
}
