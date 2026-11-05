import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLIENT = join(__dirname, '..', 'src', 'client');

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith('.css') ? [path] : [];
  });
}

describe('reduced motion', () => {
  const animated = cssFiles(CLIENT).filter((file) =>
    readFileSync(file, 'utf8').includes('@keyframes'),
  );

  it('finds the stylesheets that animate', () => {
    expect(animated.length).toBeGreaterThan(0);
  });

  it.each(animated.map((file) => [file.slice(CLIENT.length + 1), file]))(
    '%s has a prefers-reduced-motion block',
    (_name, file) => {
      expect(readFileSync(file, 'utf8')).toMatch(
        /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
      );
    },
  );
});

describe('reduced motion everywhere', () => {
  const read = (file: string) => readFileSync(join(CLIENT, file), 'utf8');

  it('turns off every CSS animation and transition from the stylesheet every page loads', () => {
    expect(read('main.tsx')).toContain("import './style.css';");
    const block = read('style.css').match(
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{\s*\*,\s*\*:before,\s*\*:after\s*\{([^}]*)\}/,
    );
    expect(block?.[1]).toContain('animation: none !important');
    expect(block?.[1]).toContain('transition: none !important');
  });

  it('leaves the Dot character to its script, which checks the setting', () => {
    // dot-character.css only sizes the penguin; penguin/live.ts draws it at rest under reduce
    // (tests/penguin-motion.test.ts).
    expect(read('dot-character.css')).not.toMatch(/@keyframes|animation:/);
    expect(read('penguin/live.ts')).toContain(
      "'(prefers-reduced-motion: reduce)'",
    );
  });

  it('scrolls without smooth motion under reduce', () => {
    for (const file of [
      'inbox/InboxView.tsx',
      'message-actions/useMessageActions.tsx',
    ])
      expect(read(file)).toContain("behavior: still ? 'auto' : 'smooth'");
  });
});
