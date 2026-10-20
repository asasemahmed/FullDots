import { describe, expect, it } from 'vitest';
import { DOT_PALETTES } from '../src/client/DotCharacter';
import {
  PENGUIN_STATES,
  lerpPose,
  penguinMarkup,
  penguinState,
  penguinSvg,
  poseAt,
  restPose,
  type PenguinLook,
  type PenguinState,
} from '../src/client/penguin/engine';
import { DOT_GEAR, DOT_SPECIES } from '../src/shared/types';

const look = (over: Partial<PenguinLook> = {}): PenguinLook => ({
  palette: DOT_PALETTES.indigo,
  species: 'emperor',
  gear: 'none',
  ...over,
});
const states = Object.keys(PENGUIN_STATES) as PenguinState[];
const draw = (state: PenguinState, t: number, over?: Partial<PenguinLook>) =>
  penguinMarkup(look(over), poseAt(state, t), 'avatar', { id: 'x' });

describe('penguin species and gear', () => {
  it('offers five penguins and six kinds of gear, without the crown', () => {
    expect(DOT_SPECIES).toEqual([
      'emperor',
      'adelie',
      'rockhopper',
      'macaroni',
      'chick',
    ]);
    expect(DOT_GEAR).toEqual([
      'none',
      'headphones',
      'glasses',
      'beanie',
      'scarf',
      'bow',
    ]);
  });

  it('draws every species differently', () => {
    const drawn = DOT_SPECIES.map((species) => draw('idle', 1, { species }));
    expect(new Set(drawn).size).toBe(DOT_SPECIES.length);
    // The Adélie's white eye rings.
    expect(draw('idle', 1, { species: 'adelie' })).toContain(
      'rx="9.3" ry="10.8" fill="#fff"',
    );
  });

  it('adds each piece of gear and draws nothing for none', () => {
    const bare = draw('idle', 1);
    for (const gear of DOT_GEAR.filter((g) => g !== 'none')) {
      const worn = draw('idle', 1, { gear });
      expect(worn).not.toBe(bare);
      expect(worn.length).toBeGreaterThan(bare.length);
    }
    expect(draw('idle', 1, { gear: 'none' })).toBe(bare);
  });

  it('draws the Dot in its own colour', () => {
    expect(draw('idle', 1, { palette: DOT_PALETTES.moss })).toContain(
      `fill="${DOT_PALETTES.moss.base}"`,
    );
  });
});

describe('penguin states', () => {
  it('renders every state at every moment without a broken number', () => {
    for (const state of states)
      for (const t of [0, 0.05, 0.3, 0.9, 1.5, 2.6, 4.4, 9.7])
        for (const species of DOT_SPECIES) {
          const markup = penguinMarkup(
            look({ species, gear: 'headphones' }),
            poseAt(state, t),
            'mascot',
            { id: 'x' },
          );
          expect(markup).not.toMatch(/NaN|undefined|Infinity/);
        }
  });

  it('maps the app state names onto the penguin', () => {
    expect(penguinState('working')).toBe('typing');
    expect(penguinState('thinking')).toBe('thinking');
    expect(penguinState('using-tool')).toBe('using-tool');
    expect(penguinState('needs-input')).toBe('needs-input');
    expect(penguinState('something new')).toBe('idle');
    expect(penguinState(undefined)).toBe('idle');
  });

  it('thinks as three dots with a pulse running through them', () => {
    const at = (t: number) => poseAt('thinking', t);
    expect(at(2).s).toBeLessThan(0.3);
    expect(at(2).face).toBe(0);
    expect(at(2).dots).toHaveLength(2);
    // The side dots slide out of the body.
    expect(Math.abs(at(0).dots[0].x)).toBeLessThan(Math.abs(at(1).dots[0].x));
    // The pulse reaches the left dot before the right one.
    const left = at(0.4).dots[0].r;
    const right = at(0.4).dots[1].r;
    expect(left).toBeGreaterThan(right);
  });

  it('types as three dots that hop in turn', () => {
    const heights = [0.05, 0.2, 0.35].map((t) => poseAt('typing', t));
    expect(heights.every((pose) => pose.face === 0)).toBe(true);
    expect(heights[0].dots[0].y).toBeLessThan(heights[0].dots[1].y);
    expect(new Set(heights.map((pose) => pose.y.toFixed(2))).size).toBe(3);
  });

  it('bursts into confetti once when done, then stays smiling with a green badge', () => {
    expect(poseAt('complete', 0.4).motes.some((m) => m.r > 0)).toBe(true);
    for (const t of [2.6, 4, 10]) {
      const settled = poseAt('complete', t);
      expect(settled.motes).toHaveLength(0);
      expect(settled.face).toBe(1);
      expect(settled.eyes[0].mode).toBe('smile');
      expect(settled.badge).toMatchObject({ k: 'done' });
      expect(settled.badge.r).toBeGreaterThan(6);
    }
  });

  it('pops an amber badge when it needs the owner', () => {
    expect(poseAt('needs-input', 0).badge.r).toBe(0);
    expect(poseAt('needs-input', 1.2).badge).toMatchObject({ k: 'needs' });
    expect(draw('needs-input', 1.2)).toContain('mask="url(#xm)"');
  });

  it('shrinks to a grey dot when paused', () => {
    const paused = restPose('paused');
    expect(paused.s).toBeLessThan(0.4);
    expect(paused.muted).toBe(1);
    expect(draw('paused', 0.6)).not.toContain(DOT_PALETTES.indigo.base);
  });

  it('blinks now and then while idle', () => {
    const opens = Array.from(
      { length: 90 },
      (_, i) => poseAt('idle', i * 0.05).eyes[0].open,
    );
    expect(Math.min(...opens)).toBeLessThan(0.3);
    expect(Math.max(...opens)).toBe(1);
  });

  it('watches the pointer only in states that look around', () => {
    expect(poseAt('idle', 1, { gaze: [2, 1] })).toMatchObject({
      gx: 2,
      gy: 1,
    });
    expect(poseAt('needs-input', 1, { gaze: [-3, 0] }).gx).toBeGreaterThan(0);
  });

  it('blends a change of state from the frame on screen', () => {
    const from = restPose('idle');
    const to = restPose('thinking');
    const half = lerpPose(from, to, 0.5);
    expect(half.s).toBeCloseTo((from.s + to.s) / 2);
    expect(half.face).toBeCloseTo(0.5);
    expect(lerpPose(from, to, 1).s).toBeCloseTo(to.s);
    // The smile replaces open eyes behind a blink, never both at once.
    const smile = restPose('complete');
    expect(lerpPose(from, smile, 0.25).eyes[0].mode).toBe('open');
    expect(lerpPose(from, smile, 0.75).eyes[0].mode).toBe('smile');
  });

  it('keeps clip and mask ids under the prefix it is given', () => {
    const markup = penguinMarkup(
      look({ species: 'adelie' }),
      restPose('needs-input'),
      'avatar',
      { id: 'abc' },
    );
    for (const [, id] of markup.matchAll(/id="([^"]+)"/g))
      expect(id.startsWith('abc')).toBe(true);
  });

  it('writes a standalone SVG for files', () => {
    const svg = penguinSvg(look(), 'idle', 'mascot', {
      size: 64,
      title: 'Dot',
    });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('width="64"');
    expect(svg).toContain('<title>Dot</title>');
  });
});
