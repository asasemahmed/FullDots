// The Dot character and the FullDots mark. Every Dot is a penguin (see penguin/engine.ts): its
// colour, species and gear make it recognisable, and its state picks the animation.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { DotGear, DotSpecies } from '../shared/types';
import { DOT_PALETTES, type DotPalette } from './dot-palettes';
import {
  PENGUIN_STATES,
  penguinMarkup,
  penguinState,
  restPose,
  viewBox,
  type PenguinLook,
  type PenguinVariant,
} from './penguin/engine';
import { LiveDot } from './penguin/live';
import './dot-character.css';

export {
  DOT_PALETTES,
  DOT_PALETTE_NAMES,
  type DotPalette,
} from './dot-palettes';

/**
 * idle, thinking, typing (or working), using-tool, needs-input, complete, paused, or the hand-off
 * states handing-off, receiving, reviewing and stopped; anything else looks idle.
 */
export type DotState = string;

/** The penguin for one Dot, animated for its state. */
export function DotCharacter({
  palette = 'indigo',
  species = 'emperor',
  gear = 'none',
  state = 'idle',
  label,
  className = '',
  large = false,
}: {
  palette?: DotPalette;
  species?: DotSpecies;
  gear?: DotGear;
  state?: DotState;
  /** Accessible name; omit for a decorative character. */
  label?: string;
  className?: string;
  /** A large character stands on the ground and its eyes follow the pointer. */
  large?: boolean;
}) {
  const id = 'pd' + useId().replace(/[^a-zA-Z0-9]/g, '');
  const ref = useRef<SVGSVGElement>(null);
  const live = useRef<LiveDot | null>(null);
  const variant: PenguinVariant = large ? 'mascot' : 'avatar';
  const shown = penguinState(state);
  const look = useMemo<PenguinLook>(
    () => ({ palette: DOT_PALETTES[palette], species, gear }),
    [palette, species, gear],
  );
  // The first frame is drawn here, so a server render and the first paint show the Dot at rest.
  // After that the live loop owns the inside of the svg; React never rewrites it.
  const [first] = useState(() =>
    penguinMarkup(look, restPose(shown), variant, { id }),
  );
  useEffect(() => {
    const options = { look, state: shown, variant, large, rim: false };
    if (!ref.current) return;
    if (!live.current) live.current = new LiveDot(ref.current, id, options);
    else live.current.update(options);
  }, [id, look, shown, variant, large]);
  useEffect(
    () => () => {
      live.current?.destroy();
      live.current = null;
    },
    [],
  );
  return (
    <svg
      ref={ref}
      className={`dot-figure ${state} ${className}`}
      data-pose={shown}
      viewBox={viewBox(variant)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      dangerouslySetInnerHTML={{ __html: first }}
    />
  );
}

/** How a state reads in words, for labels: "Scout is thinking". */
export function dotStateLabel(state: DotState | undefined) {
  if (state === 'working') return 'working';
  return PENGUIN_STATES[penguinState(state)].label;
}

/** The FullDots mark: the Dot, simplified to read at 16 px (public/logo.svg, also the favicon). */
export function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/logo.svg"
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}
