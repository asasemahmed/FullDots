import { useRef, type KeyboardEvent } from 'react';
import {
  DOT_COLORS,
  type DotColor,
  type DotGear,
  type DotSpecies,
} from '../shared/types';
import { Mascot } from './Mascot';
import './dot-color-picker.css';

const OPTIONS: readonly (DotColor | null)[] = [null, ...DOT_COLORS];

/** Where an arrow, Home or End key moves the selection of a radio group; -1 for other keys. */
export function rovingIndex(key: string, from: number, count: number) {
  const last = count - 1;
  if (key === 'ArrowRight' || key === 'ArrowDown')
    return from === last ? 0 : from + 1;
  if (key === 'ArrowLeft' || key === 'ArrowUp')
    return from === 0 ? last : from - 1;
  if (key === 'Home') return 0;
  if (key === 'End') return last;
  return -1;
}

const label = (color: DotColor | null) =>
  color ? color[0].toUpperCase() + color.slice(1) : 'Automatic';

/**
 * Choose a Dot's colour: nine round swatches plus Automatic (null, the colour derived from the
 * Dot's id). A radio group with a roving tab stop; arrow keys move and select.
 */
export function DotColorPicker({
  value,
  onChange,
  identity,
  name,
  species,
  gear,
}: {
  value: DotColor | null;
  onChange: (color: DotColor | null) => void;
  /** The Dot's id, so the Automatic preview shows the colour it would get. */
  identity?: string;
  name?: string;
  /** The penguin and gear chosen beside the colour, so the preview matches them. */
  species?: DotSpecies | null;
  gear?: DotGear | null;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, OPTIONS.indexOf(value));

  const move = (event: KeyboardEvent, from: number) => {
    const next = rovingIndex(event.key, from, OPTIONS.length);
    if (next < 0) return;
    event.preventDefault();
    onChange(OPTIONS[next]);
    refs.current[next]?.focus();
  };

  return (
    <div className="dot-color-picker">
      <span className="dcp-preview">
        <Mascot
          identity={identity}
          color={value}
          species={species}
          gear={gear}
          name={name ?? 'Dot'}
          small
          decorative
        />
      </span>
      <div className="dcp-group" role="radiogroup" aria-label="Dot colour">
        {OPTIONS.map((color, index) => (
          <button
            key={color ?? 'auto'}
            ref={(node) => {
              refs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={index === selected}
            aria-label={label(color)}
            title={label(color)}
            tabIndex={index === selected ? 0 : -1}
            className={`dcp-option ${color ? 'dcp-swatch' : 'dcp-auto'}`}
            style={
              color
                ? {
                    background: `radial-gradient(circle at 35% 30%, var(--dot-${color}-light), var(--dot-${color}-base) 60%, var(--dot-${color}-dark))`,
                  }
                : undefined
            }
            onClick={() => onChange(color)}
            onKeyDown={(event) => move(event, index)}
          >
            {color ? null : 'Automatic'}
          </button>
        ))}
      </div>
    </div>
  );
}
