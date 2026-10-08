import { DOT_PALETTE_NAMES, DotCharacter } from './DotCharacter';

/** Stable identity keeps each specialist recognizable across views and reloads. */
function paletteFor(identity?: string) {
  if (!identity) return DOT_PALETTE_NAMES[0];
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return DOT_PALETTE_NAMES[hash % DOT_PALETTE_NAMES.length];
}

export function Mascot({
  state = 'idle',
  small = false,
  identity,
  name = 'Dot',
  decorative = false,
}: {
  state?: string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
}) {
  return (
    <span className={`mascot ${state} ${small ? 'small' : ''}`}>
      <DotCharacter
        palette={paletteFor(identity)}
        state={state}
        label={decorative ? undefined : `${name} is ${state}`}
      />
    </span>
  );
}
