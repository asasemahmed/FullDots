import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DOT_PALETTES, DotCharacter } from '../src/client/DotCharacter';
import { DotColorPicker } from '../src/client/DotColorPicker';
import { Mascot, dotColor, dotPalette } from '../src/client/Mascot';
import { DOT_COLORS } from '../src/shared/types';

/** The hash exactly as it was before Dots could choose a colour. */
function legacyPalette(identity: string) {
  const names = ['indigo', 'mint', 'coral', 'lilac'];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return names[hash % names.length];
}

describe('Dot colour', () => {
  it('has a palette for every shared colour, with the original four unchanged', () => {
    expect(Object.keys(DOT_PALETTES)).toEqual([...DOT_COLORS]);
    expect(DOT_PALETTES.indigo.base).toBe('#6e7ff3');
    expect(DOT_PALETTES.mint.cheekOpacity).toBe(0.78);
    expect(DOT_PALETTES.coral.dark).toBe('#de5f3c');
    expect(DOT_PALETTES.lilac.light).toBe('#dccfff');
  });

  it('keeps the id-hash colour for Dots without a chosen colour', () => {
    for (const id of [
      'a',
      'dot-1',
      'scout',
      'f3a9c1d0-1111-4222-8333-444455556666',
      'x'.repeat(40),
    ])
      expect(dotColor({ id })).toBe(legacyPalette(id));
    expect(dotColor({ id: 'dot-1', color: undefined })).toBe(
      legacyPalette('dot-1'),
    );
  });

  it('uses dot.color when set, whatever the id hashes to', () => {
    for (const color of DOT_COLORS) {
      expect(dotColor({ id: 'dot-1', color })).toBe(color);
      expect(dotPalette({ id: 'dot-1', color })).toBe(DOT_PALETTES[color]);
    }
  });

  it('renders the Mascot in the chosen colour, else the old one', () => {
    const chosen = renderToStaticMarkup(
      <Mascot identity="dot-1" color="moss" />,
    );
    expect(chosen).toContain(DOT_PALETTES.moss.base);
    expect(chosen).not.toContain(
      DOT_PALETTES[legacyPalette('dot-1') as 'indigo'].dark,
    );
    const legacy = renderToStaticMarkup(<Mascot identity="dot-1" />);
    const old = DOT_PALETTES[legacyPalette('dot-1') as 'indigo'];
    expect(legacy).toContain(old.base);
    expect(legacy).toContain(old.dark);
    expect(
      renderToStaticMarkup(<Mascot identity="dot-1" color={null} />),
    ).toContain(old.base);
  });
});

describe('DotCharacter hand-off states', () => {
  it.each(['handing-off', 'receiving', 'reviewing', 'stopped'])(
    'renders the %s state as the penguin',
    (state) => {
      const html = renderToStaticMarkup(
        <DotCharacter state={state} label="Scout" />,
      );
      expect(html).toContain(`class="dot-figure ${state} `);
      expect(html).toContain(`data-pose="${state}"`);
      expect(html).toContain('role="img"');
      // The body and the belly of the penguin.
      expect(html).toContain('<circle cx="64" cy="68" r="46"');
      expect(html).toContain('<path d="M64 46C57 37');
    },
  );
});

describe('DotColorPicker', () => {
  it('is a radiogroup of ten options including Automatic', () => {
    const html = renderToStaticMarkup(
      <DotColorPicker value="sky" onChange={() => {}} identity="dot-1" />,
    );
    expect(html).toContain('role="radiogroup"');
    expect(html.match(/role="radio"/g)).toHaveLength(10);
    expect(html).toContain('aria-label="Automatic"');
    for (const color of DOT_COLORS)
      expect(html).toContain(
        `aria-label="${color[0].toUpperCase()}${color.slice(1)}"`,
      );
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Sky"/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    // The live preview uses the chosen colour.
    expect(html).toContain(DOT_PALETTES.sky.base);
  });

  it('selects Automatic when no colour is chosen', () => {
    const html = renderToStaticMarkup(
      <DotColorPicker value={null} onChange={() => {}} identity="dot-1" />,
    );
    expect(html).toMatch(/aria-checked="true"[^>]*aria-label="Automatic"/);
  });
});
