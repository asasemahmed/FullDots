import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  isThemePreference,
  readThemePreference,
  resolveTheme,
  storeThemePreference,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
} from '../src/client/theme';

const css = readFileSync(
  join(__dirname, '..', 'src', 'client', 'tokens.css'),
  'utf8',
);
const html = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');
const themeInit = readFileSync(
  join(__dirname, '..', 'public', 'theme-init.js'),
  'utf8',
);

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThan(-1);
  const end = css.indexOf('\n}', start);
  const body = css.slice(start, end);
  const tokens = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g))
    tokens.set(match[1], match[2].trim());
  return tokens;
}

const light = block(':root');
const dark = block("[data-theme='dark']");

function resolve(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name) ?? light.get(name) ?? '';
  for (let guard = 0; value.startsWith('var(') && guard < 10; guard += 1) {
    const next = value.slice(4, value.indexOf(')')).split(',')[0].trim();
    value = tokens.get(next) ?? light.get(next) ?? '';
  }
  return value;
}

function rgb(value: string): [number, number, number] {
  const hex = value.trim();
  if (hex.startsWith('#')) {
    const digits =
      hex.length === 4
        ? hex
            .slice(1)
            .split('')
            .map((d) => d + d)
            .join('')
        : hex.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)) as [
      number,
      number,
      number,
    ];
  }
  const match = hex.match(/rgba?\(([^)]+)\)/);
  if (!match) throw new Error(`not a colour: ${value}`);
  const parts = match[1]
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(Number);
  return [parts[0], parts[1], parts[2]];
}

function luminance(value: string): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(value).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const surfaces = [0, 1, 2, 3, 4, 5, 6].map((n) => `--surface-${n}`);
const textTokens = ['--text', '--text-soft', '--text-muted', '--text-faint'];
const families = ['red', 'amber', 'green', 'teal', 'blue', 'violet', 'pink'];

describe('theme', () => {
  it('resolves the system preference and explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });

  it('only accepts the three preferences', () => {
    expect(isThemePreference('system')).toBe(true);
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('light')).toBe(true);
    expect(isThemePreference('sepia')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });

  it('applies a theme to the document and announces it', () => {
    const root = { dataset: {}, style: {} } as unknown as HTMLElement;
    const meta = { content: '' };
    const doc = {
      querySelector: () => meta,
      dispatchEvent: vi.fn(() => true),
    } as unknown as Document;
    applyTheme('dark', root, doc);
    expect(root.dataset.theme).toBe('dark');
    expect(root.style.colorScheme).toBe('dark');
    expect(meta.content).toBe('#14171b');
    expect(doc.dispatchEvent).toHaveBeenCalledTimes(1);
    applyTheme('light', root, doc);
    expect(root.dataset.theme).toBe('light');
    expect(meta.content).toBe('#f8f7f4');
  });
});

describe('theme preference storage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    });
    return store;
  }

  it('defaults to system and reads a stored choice', () => {
    stubStorage();
    expect(readThemePreference()).toBe('system');
    stubStorage({ [THEME_STORAGE_KEY]: 'dark' });
    expect(readThemePreference()).toBe('dark');
  });

  it('ignores a value that is not a preference', () => {
    stubStorage({ [THEME_STORAGE_KEY]: 'sepia' });
    expect(readThemePreference()).toBe('system');
  });

  it('survives storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readThemePreference()).toBe('system');
    expect(() => storeThemePreference('dark')).not.toThrow();
  });

  it('saves the chosen preference', () => {
    const store = stubStorage();
    storeThemePreference('light');
    expect(store.get(THEME_STORAGE_KEY)).toBe('light');
  });
});

describe('theme before the first paint', () => {
  /** Runs public/theme-init.js against a stub page and reports what it painted. */
  function runThemeInit(
    getItem: (key: string) => string | null,
    dark: boolean,
  ) {
    const root = { dataset: {}, style: {} } as unknown as HTMLElement;
    let color = '#f8f7f4';
    const meta = {
      setAttribute: (name: string, value: string) => {
        if (name === 'content') color = value;
      },
    };
    runInNewContext(themeInit, {
      localStorage: { getItem },
      window: {
        matchMedia: (query: string) => ({
          matches: query === '(prefers-color-scheme: dark)' && dark,
        }),
      },
      document: {
        documentElement: root,
        querySelector: (selector: string) =>
          selector === 'meta[name="theme-color"]' ? meta : null,
      },
    });
    return {
      theme: root.dataset.theme,
      colorScheme: root.style.colorScheme,
      color,
    };
  }

  /** What src/client/theme.ts paints for the same theme. */
  function painted(theme: ResolvedTheme) {
    const root = { dataset: {}, style: {} } as unknown as HTMLElement;
    const meta = { content: '' };
    applyTheme(theme, root, {
      querySelector: () => meta,
      dispatchEvent: () => true,
    } as unknown as Document);
    return {
      theme: root.dataset.theme,
      colorScheme: root.style.colorScheme,
      color: meta.content,
    };
  }

  it('loads every script from a file, since the CSP blocks inline scripts', () => {
    const scripts = [
      ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi),
    ];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [tag, attributes, body] of scripts) {
      expect(attributes, tag).toMatch(/\bsrc=["'][^"']+["']/i);
      expect(body.trim(), tag).toBe('');
    }
  });

  it('runs the theme script in <head>, synchronously and after the theme-color meta', () => {
    const head = html.slice(0, html.indexOf('</head>'));
    const tag = head.match(/<script\b[^>]*\bsrc="\/theme-init\.js"[^>]*>/)?.[0];
    expect(tag, 'theme-init.js in <head>').toBeDefined();
    expect(tag).not.toMatch(/\b(type|async|defer)\b/);
    expect(head.indexOf('name="theme-color"')).toBeGreaterThan(-1);
    expect(head.indexOf('name="theme-color"')).toBeLessThan(
      head.indexOf('/theme-init.js'),
    );
  });

  it('resolves and paints the theme exactly as theme.ts does', () => {
    for (const saved of [null, 'system', 'light', 'dark', 'sepia'])
      for (const dark of [false, true]) {
        const preference = isThemePreference(saved) ? saved : 'system';
        expect(
          runThemeInit(
            (key) => (key === THEME_STORAGE_KEY ? saved : null),
            dark,
          ),
          `saved ${saved}, system dark ${dark}`,
        ).toEqual(painted(resolveTheme(preference, dark)));
      }
  });

  it('leaves the page alone when storage is blocked', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    expect(() => runThemeInit(blocked, true)).not.toThrow();
    expect(runThemeInit(blocked, true).theme).toBeUndefined();
  });
});

describe('theme tokens', () => {
  it('gives every colour in the light palette a dark value', () => {
    for (const name of light.keys()) {
      if (name.startsWith('--dot-')) continue;
      if (!light.get(name)?.match(/^#[0-9a-f]{3,8}$|^rgb/)) continue;
      expect(dark.get(name), `${name} needs a dark value`).toBeTruthy();
    }
  });

  it('only overrides names that exist in the light palette', () => {
    for (const name of dark.keys())
      expect(light.has(name), `${name} is dark-only`).toBe(true);
  });

  it('keeps the Dot palette identical in both themes', () => {
    for (const name of light.keys())
      if (name.startsWith('--dot-')) expect(dark.has(name)).toBe(false);
  });

  for (const [theme, tokens] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`meets WCAG AA for text in the ${theme} theme`, () => {
      const failures: string[] = [];
      const check = (fg: string, bg: string) => {
        const ratio = contrast(resolve(tokens, fg), resolve(tokens, bg));
        if (ratio < 4.5) failures.push(`${fg} on ${bg}: ${ratio.toFixed(2)}:1`);
      };
      for (const fg of textTokens) for (const bg of surfaces) check(fg, bg);
      for (const family of families) {
        for (const bg of ['--surface-0', '--surface-2', `--${family}-50`])
          check(`--${family}-ink`, bg);
      }
      for (const [fg, tints] of [
        ['--accent', ['--accent-soft-bg']],
        ['--success', ['--green-50']],
        ['--warning', ['--amber-50']],
        ['--danger', ['--red-50']],
      ] as const)
        for (const bg of ['--surface-0', '--surface-2', ...tints])
          check(fg, bg);
      expect(failures).toEqual([]);
    });

    it(`keeps text on solid fills readable in the ${theme} theme`, () => {
      for (const bg of ['--solid-1', '--solid-2'])
        expect(
          contrast(resolve(tokens, '--on-solid'), resolve(tokens, bg)),
        ).toBeGreaterThanOrEqual(4.5);
      for (const bg of [
        '--accent-solid',
        '--accent-solid-hover',
        '--blue-solid',
      ])
        expect(
          contrast(resolve(tokens, '--on-accent'), resolve(tokens, bg)),
        ).toBeGreaterThanOrEqual(4.5);
    });
  }
});
