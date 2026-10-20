import {
  DOT_GEAR,
  DOT_SPECIES,
  type Dot,
  type DotColor,
  type DotGear,
  type DotSpecies,
} from '../shared/types';
import {
  DOT_PALETTES,
  DotCharacter,
  dotStateLabel,
  type DotPalette,
} from './DotCharacter';

// The id hash only ever picks from these four so Dots without a chosen colour keep the look they
// had before the palette grew; the other colours are reached by choosing them on the Dot.
const HASHED_COLORS: readonly DotColor[] = ['indigo', 'mint', 'coral', 'lilac'];

function hashOf(identity: string, factor: number) {
  let hash = 0;
  for (const character of identity)
    hash = (hash * factor + character.charCodeAt(0)) >>> 0;
  return hash;
}

/** Stable identity keeps each specialist recognizable across views and reloads. */
function paletteFor(identity?: string): DotColor {
  if (!identity) return HASHED_COLORS[0];
  return HASHED_COLORS[hashOf(identity, 31) % HASHED_COLORS.length];
}

/** The species of a Dot that has not chosen one: stable, and independent of its colour. */
export function speciesFor(identity?: string): DotSpecies {
  if (!identity) return DOT_SPECIES[0];
  return DOT_SPECIES[hashOf(identity, 37) % DOT_SPECIES.length];
}

function isDotColor(value: unknown): value is DotColor {
  return typeof value === 'string' && value in DOT_PALETTES;
}
function isSpecies(value: unknown): value is DotSpecies {
  return DOT_SPECIES.includes(value as DotSpecies);
}
function isGear(value: unknown): value is DotGear {
  return DOT_GEAR.includes(value as DotGear);
}

/** The colour a Dot shows everywhere: its chosen colour, else the one derived from its id. */
export function dotColor(dot: Pick<Dot, 'id' | 'color'>): DotColor {
  return isDotColor(dot.color) ? dot.color : paletteFor(dot.id);
}

/** The full palette for a Dot, for lanes, bubbles and anything else that should match its character. */
export function dotPalette(dot: Pick<Dot, 'id' | 'color'>) {
  return DOT_PALETTES[dotColor(dot)];
}

/** The penguin a Dot is drawn as: its chosen species, else the one derived from its id. */
export function dotSpecies(dot: Pick<Dot, 'id' | 'species'>): DotSpecies {
  return isSpecies(dot.species) ? dot.species : speciesFor(dot.id);
}

/** The choices that draw a Dot, to spread onto a Mascot: `<Mascot {...dotLook(dot)} />`. */
export function dotLook(dot?: Pick<Dot, 'color' | 'species' | 'gear'> | null): {
  color?: DotColor;
  species?: DotSpecies;
  gear?: DotGear;
} {
  if (!dot) return {};
  return { color: dot.color, species: dot.species, gear: dot.gear };
}

export function Mascot({
  state = 'idle',
  small = false,
  hero = false,
  identity,
  color,
  species,
  gear,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  /** A large character on an empty page: it stands on the ground and watches the pointer. */
  hero?: boolean;
  identity?: string;
  /** The Dot's chosen colour; without one the colour comes from `identity`. */
  color?: DotColor | null;
  /** The Dot's chosen penguin; without one it comes from `identity`. */
  species?: DotSpecies | null;
  gear?: DotGear | null;
  name?: string;
  decorative?: boolean;
}) {
  const palette: DotPalette = isDotColor(color) ? color : paletteFor(identity);
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <DotCharacter
        palette={palette}
        species={isSpecies(species) ? species : speciesFor(identity)}
        gear={isGear(gear) ? gear : 'none'}
        state={state}
        large={hero}
        label={decorative ? undefined : `${name} is ${dotStateLabel(state)}`}
      />
    </span>
  );
}
