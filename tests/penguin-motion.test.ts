// The Dot character is animated by penguin/live.ts, not by CSS: with prefers-reduced-motion it must
// not run its animation loop, must draw each state once at rest, and must settle when the setting
// is switched on while the page is open.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOT_PALETTES } from '../src/client/dot-palettes';
import {
  penguinMarkup,
  restPose,
  type PenguinLook,
  type PenguinState,
} from '../src/client/penguin/engine';

const look: PenguinLook = {
  palette: DOT_PALETTES.indigo,
  species: 'emperor',
  gear: 'none',
};
const options = (state: PenguinState) => ({
  look,
  state,
  variant: 'avatar' as const,
  large: false,
  rim: false,
});
const atRest = (state: PenguinState) =>
  penguinMarkup(look, restPose(state), 'avatar', { id: 'pd1', rim: false });

let reduce = true;
let onChange: (() => void) | undefined;
const frames: FrameRequestCallback[] = [];
const requestFrame = vi.fn((callback: FrameRequestCallback) => {
  frames.push(callback);
  return frames.length;
});
const cancelFrame = vi.fn();

beforeEach(() => {
  vi.resetModules();
  reduce = true;
  onChange = undefined;
  frames.length = 0;
  requestFrame.mockClear();
  cancelFrame.mockClear();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === '(prefers-reduced-motion: reduce)' && reduce;
    },
    addEventListener: (_type: string, listener: () => void) => {
      onChange = listener;
    },
  }));
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('document', { hidden: false });
});
afterEach(() => vi.unstubAllGlobals());

const svg = () => ({ innerHTML: '' }) as unknown as SVGSVGElement;

describe('the penguin under reduced motion', () => {
  it('starts no animation loop and draws a new state once, at rest', async () => {
    const { LiveDot } = await import('../src/client/penguin/live');
    const el = svg();
    const dot = new LiveDot(el, 'pd1', options('idle'));
    expect(requestFrame).not.toHaveBeenCalled();
    dot.update(options('thinking'));
    expect(requestFrame).not.toHaveBeenCalled();
    expect(el.innerHTML).toBe(atRest('thinking'));
    dot.destroy();
  });

  it('animates when motion is allowed', async () => {
    reduce = false;
    const { LiveDot } = await import('../src/client/penguin/live');
    const dot = new LiveDot(svg(), 'pd1', options('thinking'));
    expect(requestFrame).toHaveBeenCalledTimes(1);
    dot.destroy();
  });

  it('stops and settles every penguin when reduced motion is switched on, and resumes after', async () => {
    reduce = false;
    const { LiveDot } = await import('../src/client/penguin/live');
    const el = svg();
    const dot = new LiveDot(el, 'pd1', options('typing'));
    // A few frames in, mid-hop.
    for (const now of [100, 400, 900]) frames.shift()?.(now);
    expect(el.innerHTML).not.toBe('');
    reduce = true;
    onChange?.();
    expect(cancelFrame).toHaveBeenCalled();
    expect(el.innerHTML).toBe(atRest('typing'));
    reduce = false;
    requestFrame.mockClear();
    onChange?.();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    dot.destroy();
  });
});
