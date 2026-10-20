import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import {
  DOT_GEAR,
  DOT_SPECIES,
  type DotColor,
  type DotGear,
  type DotSpecies,
} from '../shared/types';
import { DOT_PALETTES } from './DotCharacter';
import { rovingIndex } from './DotColorPicker';
import { dotColor, speciesFor } from './Mascot';
import {
  GEAR_LABELS,
  SPECIES_INFO,
  penguinMarkup,
  restPose,
  viewBox,
} from './penguin/engine';
import './dot-look-picker.css';

/** A still penguin for a picker option. */
function Thumb({
  color,
  species,
  gear,
}: {
  color: DotColor;
  species: DotSpecies;
  gear: DotGear;
}) {
  const id = 'pt' + useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <svg
      className="dlp-thumb"
      viewBox={viewBox('avatar')}
      aria-hidden="true"
      focusable="false"
      dangerouslySetInnerHTML={{
        __html: penguinMarkup(
          { palette: DOT_PALETTES[color], species, gear },
          restPose('idle'),
          'avatar',
          { id },
        ),
      }}
    />
  );
}

/** A radio group with a roving tab stop: arrow keys move and select. */
function Choices<T>({
  label,
  options,
  value,
  onChange,
  name,
  thumb,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
  name: (option: T) => string;
  thumb: (option: T) => ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(0, options.indexOf(value));
  const move = (event: KeyboardEvent, from: number) => {
    const next = rovingIndex(event.key, from, options.length);
    if (next < 0) return;
    event.preventDefault();
    onChange(options[next]);
    refs.current[next]?.focus();
  };
  return (
    <div className="dlp-group" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={name(option)}
          ref={(node) => {
            refs.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={index === selected}
          tabIndex={index === selected ? 0 : -1}
          className="dlp-option"
          onClick={() => onChange(option)}
          onKeyDown={(event) => move(event, index)}
        >
          {thumb(option)}
          <span>{name(option)}</span>
        </button>
      ))}
    </div>
  );
}

const SPECIES_OPTIONS: readonly (DotSpecies | null)[] = [null, ...DOT_SPECIES];

/**
 * Choose a Dot's penguin and what it wears. Automatic (null) keeps the species derived from the
 * Dot's id; each option previews the Dot in its colour.
 */
export function DotLookPicker({
  identity,
  color,
  species,
  gear,
  onSpecies,
  onGear,
}: {
  identity?: string;
  color: DotColor | null;
  species: DotSpecies | null;
  gear: DotGear;
  onSpecies: (species: DotSpecies | null) => void;
  onGear: (gear: DotGear) => void;
}) {
  const shown = dotColor({ id: identity ?? '', color: color ?? undefined });
  const automatic = speciesFor(identity);
  return (
    <div className="dot-look-picker">
      <span className="dlg-label">Penguin</span>
      <Choices
        label="Penguin"
        options={SPECIES_OPTIONS}
        value={species}
        onChange={onSpecies}
        name={(option) => (option ? SPECIES_INFO[option].label : 'Automatic')}
        thumb={(option) => (
          <Thumb color={shown} species={option ?? automatic} gear={gear} />
        )}
      />
      <span className="dlg-label">Gear</span>
      <Choices
        label="Gear"
        options={DOT_GEAR}
        value={gear}
        onChange={onGear}
        name={(option) => GEAR_LABELS[option]}
        thumb={(option) => (
          <Thumb color={shown} species={species ?? automatic} gear={option} />
        )}
      />
    </div>
  );
}
