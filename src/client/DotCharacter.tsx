// The Dot character and the FullDots mark, drawn as SVG so they stay sharp at every size, keep a
// transparent background, and can change expression with the Dot's state (see dot-character.css).
import { useId } from 'react';
import './dot-character.css';

export const DOT_PALETTES = {
  indigo: {
    base: '#6e7ff3',
    light: '#b8c1ff',
    dark: '#4b58cf',
    cheek: '#ff7aa8',
    cheekOpacity: 0.38,
  },
  mint: {
    base: '#33c49f',
    light: '#a0f0da',
    dark: '#1b9374',
    cheek: '#ffa6bf',
    cheekOpacity: 0.78,
  },
  coral: {
    base: '#ff8a66',
    light: '#ffcab6',
    dark: '#de5f3c',
    cheek: '#ff4d73',
    cheekOpacity: 0.38,
  },
  lilac: {
    base: '#a98bf3',
    light: '#dccfff',
    dark: '#8063d4',
    cheek: '#ff7ab8',
    cheekOpacity: 0.38,
  },
} as const;
export type DotPalette = keyof typeof DOT_PALETTES;
export const DOT_PALETTE_NAMES = Object.keys(DOT_PALETTES) as DotPalette[];

/** idle, working, needs-input, complete or paused; anything else looks idle. */
export type DotState = string;

const EYE = '#1c1f2e';

/**
 * A round Dot with an antenna whose tip is a status light: it glows while the Dot works, turns
 * amber when the Dot needs you, green when it is done and grey when it is paused.
 */
export function DotCharacter({
  palette = 'indigo',
  state = 'idle',
  label,
  className = '',
}: {
  palette?: DotPalette;
  state?: DotState;
  /** Accessible name; omit for a decorative character. */
  label?: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, '');
  const p = DOT_PALETTES[palette];
  return (
    <svg
      className={`dot-figure ${state} ${className}`}
      viewBox="0 0 200 200"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        <radialGradient id={`${id}b`} cx="36%" cy="28%" r="80%">
          <stop offset="0" stopColor={p.light} />
          <stop offset=".5" stopColor={p.base} />
          <stop offset="1" stopColor={p.dark} />
        </radialGradient>
        <radialGradient id={`${id}g`} cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor={p.light} stopOpacity=".45" />
          <stop offset="1" stopColor={p.light} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${id}s`} cx="38%" cy="32%" r="72%">
          <stop offset="0" stopColor="#fff6c4" />
          <stop offset="1" stopColor="#ffc52e" />
        </radialGradient>
      </defs>
      <g className="dot-body-group">
        <ellipse cx="76" cy="170" rx="19" ry="11" fill={p.dark} />
        <ellipse cx="124" cy="170" rx="19" ry="11" fill={p.dark} />
        <ellipse
          cx="33"
          cy="116"
          rx="11"
          ry="17"
          transform="rotate(24 33 116)"
          fill={p.dark}
        />
        <ellipse
          cx="167"
          cy="116"
          rx="11"
          ry="17"
          transform="rotate(-24 167 116)"
          fill={p.dark}
        />
        <path
          d="M100 42 C 99 29, 104 20, 113 15"
          fill="none"
          stroke={p.dark}
          strokeWidth="6"
          strokeLinecap="round"
        />
        <circle className="dot-glow" cx="116" cy="13" r="17" />
        <circle
          className="dot-spark"
          cx="116"
          cy="13"
          r="11"
          fill={`url(#${id}s)`}
        />
        <path
          d="M100 38 C 143 38 169 72 170 113 C 171 148 144 170 100 170 C 56 170 29 148 30 113 C 31 72 57 38 100 38 Z"
          fill={`url(#${id}b)`}
        />
        <ellipse cx="100" cy="144" rx="50" ry="24" fill={`url(#${id}g)`} />
        <ellipse
          cx="69"
          cy="68"
          rx="20"
          ry="10.5"
          transform="rotate(-32 69 68)"
          fill="#fff"
          opacity=".42"
        />
        <circle cx="94" cy="56" r="4" fill="#fff" opacity=".35" />
        <ellipse
          cx="60"
          cy="122"
          rx="11"
          ry="6.5"
          fill={p.cheek}
          opacity={p.cheekOpacity}
        />
        <ellipse
          cx="140"
          cy="122"
          rx="11"
          ry="6.5"
          fill={p.cheek}
          opacity={p.cheekOpacity}
        />
        <g className="dot-eyes-open">
          <g className="dot-pupils">
            <ellipse cx="77" cy="98" rx="11.5" ry="14.5" fill={EYE} />
            <ellipse cx="123" cy="98" rx="11.5" ry="14.5" fill={EYE} />
            <circle cx="81.5" cy="91.5" r="4.6" fill="#fff" />
            <circle cx="127.5" cy="91.5" r="4.6" fill="#fff" />
            <circle cx="73.5" cy="104" r="2" fill="#fff" opacity=".85" />
            <circle cx="119.5" cy="104" r="2" fill="#fff" opacity=".85" />
          </g>
        </g>
        <g
          className="dot-eyes-happy"
          fill="none"
          stroke={EYE}
          strokeWidth="5.5"
          strokeLinecap="round"
        >
          <path d="M65 102 Q77 87 89 102" />
          <path d="M111 102 Q123 87 135 102" />
        </g>
        <g
          className="dot-eyes-closed"
          fill="none"
          stroke={EYE}
          strokeWidth="5"
          strokeLinecap="round"
        >
          <path d="M66 99 Q77 107 88 99" />
          <path d="M112 99 Q123 107 134 99" />
        </g>
        <path
          d="M88 117 Q100 121 112 117 Q111 132 100 132 Q89 132 88 117 Z"
          fill={EYE}
        />
        <path
          d="M93 127.5 Q100 123 107 127.5 Q104 131.5 100 131.5 Q96 131.5 93 127.5 Z"
          fill="#ff7d8f"
        />
      </g>
    </svg>
  );
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
