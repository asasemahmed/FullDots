// The penguin Dot: species, gear, poses and the SVG they draw. Everything here is a pure function
// of its inputs, so the live character, the server-side render and the tests draw the same frames.
// The three-dot thinking and typing effects follow bloub (github.com/jeremy-prt/bloub, MIT): the
// body becomes the middle dot, two more slide out of its sides, and a wave runs through them.
import type { DotGear, DotSpecies } from '../../shared/types';

export interface PenguinPalette {
  base: string;
  light: string;
  dark: string;
  cheek: string;
}

export interface PenguinLook {
  palette: PenguinPalette;
  species: DotSpecies;
  gear: DotGear;
}

/** `avatar` fits a circle and keeps the gear; `mascot` adds feet and a ground shadow. */
export type PenguinVariant = 'avatar' | 'mascot' | 'icon';

const TAU = Math.PI * 2;
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const mod = (x: number, m: number) => ((x % m) + m) % m;
export const easeOutQuint = (x: number) => 1 - Math.pow(1 - clamp(x), 5);
const easeOutCubic = (x: number) => 1 - Math.pow(1 - clamp(x), 3);
const f = (n: number) => +n.toFixed(2);

const EYE = '#171a26';
const BEAK = '#ff9d2e';
const GOLD = '#ffc83d';
const RED = '#ef5a5a';
const GREY = '#a9aebb';
export const STATUS_COLORS = {
  needs: '#ffb020',
  done: '#3dd68c',
  on: '#ffc52e',
} as const;
type BadgeKind = keyof typeof STATUS_COLORS;

function hex(h: string): [number, number, number] {
  const x =
    h.length === 4
      ? '#' + [...h.slice(1)].map((c) => c + c).join('')
      : h.slice(0, 7);
  return [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}
function mix(a: string, b: string, t: number) {
  const x = hex(a);
  const y = hex(b);
  return (
    '#' +
    x
      .map((v, i) =>
        Math.round(clamp(v + (y[i] - v) * t, 0, 255))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}
function luma(h: string) {
  const [r, g, b] = hex(h).map((v) => v / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const SPECIES_INFO: Record<
  DotSpecies,
  { label: string; blurb: string }
> = {
  emperor: { label: 'Emperor', blurb: 'Golden ear patches' },
  adelie: { label: 'Adélie', blurb: 'Dark face, eye rings' },
  rockhopper: { label: 'Rockhopper', blurb: 'Yellow brows' },
  macaroni: { label: 'Macaroni', blurb: 'Orange crest' },
  chick: { label: 'Chick', blurb: 'Soft and new' },
};
export const GEAR_LABELS: Record<DotGear, string> = {
  none: 'None',
  headphones: 'Headphones',
  glasses: 'Glasses',
  beanie: 'Beanie',
  scarf: 'Scarf',
  bow: 'Bow tie',
};

interface VariantSpec {
  vb: [number, number, number, number];
  flippers: boolean;
  feet: boolean;
  shadow: boolean;
  gear: boolean;
  cheeks: boolean;
  eye: number;
  eyeL: [number, number];
  eyeR: [number, number];
  beak: number;
}
const VARIANTS: Record<PenguinVariant, VariantSpec> = {
  avatar: {
    vb: [2, 2, 124, 124],
    flippers: true,
    feet: false,
    shadow: false,
    gear: true,
    cheeks: true,
    eye: 1,
    eyeL: [50, 66],
    eyeR: [78, 66],
    beak: 1,
  },
  mascot: {
    vb: [0, 0, 128, 128],
    flippers: true,
    feet: true,
    shadow: true,
    gear: true,
    cheeks: true,
    eye: 1,
    eyeL: [50, 66],
    eyeR: [78, 66],
    beak: 1,
  },
  icon: {
    vb: [14, 18, 100, 100],
    flippers: false,
    feet: false,
    shadow: false,
    gear: false,
    cheeks: false,
    eye: 1.15,
    eyeL: [49, 66],
    eyeR: [79, 66],
    beak: 1.15,
  },
};
export const viewBox = (variant: PenguinVariant) =>
  VARIANTS[variant].vb.join(' ');

const BELLIES: Record<DotSpecies, string> = {
  emperor:
    'M64 46C57 37 34 38 30 58C26 80 40 108 64 108C88 108 102 80 98 58C94 38 71 37 64 46Z',
  rockhopper:
    'M64 46C57 37 34 38 30 58C26 80 40 108 64 108C88 108 102 80 98 58C94 38 71 37 64 46Z',
  macaroni:
    'M64 46C57 37 34 38 30 58C26 80 40 108 64 108C88 108 102 80 98 58C94 38 71 37 64 46Z',
  adelie:
    'M64 75C46 75 33 85 33 96C33 106 47 111 64 111C81 111 95 106 95 96C95 85 82 75 64 75Z',
  chick:
    'M64 44C46 44 34 56 34 72C34 92 48 106 64 106C80 106 94 92 94 72C94 56 82 44 64 44Z',
};
const EYE_SCALE: Partial<Record<DotSpecies, number>> = { chick: 1.1 };
const BEAK_SCALE: Partial<Record<DotSpecies, number>> = { chick: 0.82 };

// ---------- Poses ----------

type EyeMode = 'open' | 'happy' | 'smile' | 'dash' | 'closed';
export interface Eye {
  mode: EyeMode;
  rx: number;
  ry: number;
  /** 1 open, 0 shut: blinks and shape changes go through it. */
  open: number;
  /** Top lid, as a share of the eye's height. */
  lid: number;
  /** Bottom lid. */
  low: number;
  spark: number;
}
export interface Mote {
  x: number;
  y: number;
  r: number;
  o: number;
  /** Colour key: the body or a status colour. */
  k?: 'body' | 'light' | 'cheek' | BadgeKind;
}
export interface Pose {
  /** Overall size, about the middle of the body: 1 is the penguin, about 0.17 is a dot. */
  s: number;
  x: number;
  y: number;
  /** Squash and stretch, about the feet. */
  sx: number;
  sy: number;
  rot: number;
  /** Face, flippers and gear; 0 leaves a plain dot. */
  face: number;
  gx: number;
  gy: number;
  eyes: [Eye, Eye];
  flipL: number;
  flipR: number;
  cheeks: number;
  /** The two side dots of the thinking and typing states, around the body. */
  dots: Mote[];
  /** Confetti and passing dots, around the body. */
  motes: Mote[];
  badge: { r: number; k: BadgeKind };
  /** 0 to 1: the colours fade to grey. */
  muted: number;
}

const EYE_DEFAULT: Eye = {
  mode: 'open',
  rx: 6,
  ry: 7.5,
  open: 1,
  lid: 0,
  low: 0,
  spark: 0,
};
const eye = (o: Partial<Eye> = {}): Eye => ({ ...EYE_DEFAULT, ...o });
const both = (o: Partial<Eye> = {}): [Eye, Eye] => [eye(o), eye(o)];

const R = 46;
const DOT_R = 0.165 * R;
const DOT_PEAK = 1.25;
const DOT_X = [-25, 0, 25];
const BADGE_R = 6.9;

/** A pulse that runs through the three dots from left to right. */
function dotPulse(t: number, i: number) {
  const p = mod((t - i * 0.5) / 1.5, 1);
  const k = p < 0.5 ? 0.5 - 0.5 * Math.cos(p * TAU) : 0;
  return clamp(k * 2);
}
/** A chat typing indicator: each dot hops in turn. */
function dotHop(t: number, i: number) {
  const p = mod((t - i * 0.16) / 0.95, 1);
  return p < 0.42 ? Math.sin((p / 0.42) * Math.PI) : 0;
}
/** A badge popping in at time t: it overshoots by 14 %, then settles. */
function pop(t: number) {
  if (t <= 0) return 0;
  const p = clamp(t / 0.45);
  return p < 1
    ? (0.6 + 0.4 * p) * (1 + 0.14 * Math.sin(p * Math.PI) * (1 - p * 0.35))
    : 1;
}
/** One blink every 4.4 s. */
function blinkAt(t: number) {
  const d = mod(t, 4.4) - 3.9;
  return d >= 0 && d < 0.18 ? 1 - 0.92 * Math.sin((Math.PI * d) / 0.18) : 1;
}
const emergeAt = (t: number) => 0.3 + 0.7 * easeOutCubic(t / 0.3);

export interface PoseContext {
  /** Where the eyes look, for states that watch the pointer. */
  gaze?: [number, number] | null;
}

function base(
  t: number,
  ctx: PoseContext,
  over: Partial<Pose> & { follow?: boolean; still?: boolean } = {},
): Pose {
  const { follow, still, ...rest } = over;
  const br = still ? 0 : Math.sin((t * TAU) / 3.2);
  const P: Pose = {
    s: 1,
    x: 0,
    y: 0,
    sx: 1 - br * 0.006,
    sy: 1 + br * 0.012,
    rot: 0,
    face: 1,
    gx: 0,
    gy: 0,
    eyes: both(),
    flipL: 2 * br,
    flipR: 2 * br,
    cheeks: 0,
    dots: [],
    motes: [],
    badge: { r: 0, k: 'on' },
    muted: 0,
    ...rest,
  };
  if (follow && ctx.gaze) [P.gx, P.gy] = ctx.gaze;
  if (!still) {
    const b = blinkAt(t);
    P.eyes = P.eyes.map((e) =>
      e.mode === 'open' ? { ...e, open: e.open * b } : e,
    ) as [Eye, Eye];
  }
  return P;
}
/** The pose of a state shrunk to the middle of three dots. */
function threeDots(
  t: number,
  ctx: PoseContext,
  size: number,
  y: number,
  dots: Mote[],
): Pose {
  return base(t, ctx, {
    s: size / R,
    sx: 1,
    sy: 1,
    face: 0,
    flipL: 0,
    flipR: 0,
    y,
    dots,
    still: true,
  });
}

export interface StateDef {
  label: string;
  /** Seconds into the state where it reads best: thumbnails and a first render use it. */
  rest: number;
  /** How long a change into this state blends from the frame on screen. */
  morph: number;
  /** Frames per second for small characters; large ones always run at full rate. */
  fps: number;
  pose(t: number, ctx: PoseContext): Pose;
}

/** Every state a Dot can be drawn in. Unknown states draw as idle. */
export const PENGUIN_STATES = {
  idle: {
    label: 'idle',
    rest: 1,
    morph: 0.45,
    fps: 15,
    pose: (t, ctx) => base(t, ctx, { follow: true }),
  },
  thinking: {
    label: 'thinking',
    rest: 1.95,
    morph: 0.4,
    fps: 30,
    pose: (t, ctx) =>
      threeDots(
        t,
        ctx,
        DOT_R * (1 + (DOT_PEAK - 1) * dotPulse(t, 1)),
        0,
        [0, 2].map((i) => {
          const k = dotPulse(t, i);
          return {
            x: DOT_X[i] * emergeAt(t),
            y: 0,
            r: DOT_R * (1 + (DOT_PEAK - 1) * k),
            o: 0.55 + 0.45 * k,
          };
        }),
      ),
  },
  typing: {
    label: 'writing',
    rest: 1.05,
    morph: 0.4,
    fps: 30,
    pose: (t, ctx) =>
      threeDots(
        t,
        ctx,
        DOT_R * 1.05,
        -dotHop(t, 1) * 7,
        [0, 2].map((i) => ({
          x: DOT_X[i] * emergeAt(t),
          y: -dotHop(t, i) * 7,
          r: DOT_R * 1.05,
          o: 0.6 + 0.4 * dotHop(t, i),
        })),
      ),
  },
  'using-tool': {
    label: 'working',
    rest: 0.4,
    morph: 0.4,
    fps: 24,
    pose: (t, ctx) => {
      const tap = Math.abs(Math.sin(t * 7.5));
      return base(t, ctx, {
        y: -1.2 * Math.abs(Math.sin(t * 3.4)),
        gx: Math.sin(t / 0.42) * 2.2,
        gy: 1.2,
        eyes: both({ rx: 6.8, ry: 6.4, lid: 0.24, low: 0.14, spark: 1 }),
        flipL: -12 * tap,
        flipR: -12 * (1 - tap),
      });
    },
  },
  'needs-input': {
    label: 'waiting for you',
    rest: 1.2,
    morph: 0.45,
    fps: 20,
    pose: (t, ctx) =>
      base(t, ctx, {
        gx: 2.3,
        gy: -2.1,
        rot: 5 + Math.sin((t * TAU) / 2.6) * 1.5,
        eyes: both({ rx: 6.3, ry: 7.9 }),
        badge: {
          r:
            BADGE_R *
            pop(t - 0.15) *
            (1 + (t > 1 ? 0.06 * Math.sin((t * TAU) / 1.4) : 0)),
          k: 'needs',
        },
      }),
  },
  complete: {
    label: 'done',
    rest: 2.6,
    morph: 0.3,
    fps: 30,
    pose: (t, ctx) => {
      // The confetti plays once when the Dot finishes, then it stays content.
      const c = Math.min(t, 2.6);
      const collapse = 1 - 0.8 * easeOutQuint(c / 0.45);
      const regrow = easeOutQuint((c - 0.95) / 0.6);
      const face = clamp((c - 1.05) / 0.3);
      const hop =
        c > 1.5 && c < 2.1 ? Math.sin(((c - 1.5) / 0.6) * Math.PI) : 0;
      const kinds = ['body', 'on', 'done', 'cheek'] as const;
      const waving = t < 2.6 ? 1 : 0;
      return base(t, ctx, {
        s: collapse + (1 - collapse) * regrow,
        face,
        y: -hop * 6,
        eyes: both({ mode: 'smile' }),
        cheeks: 0.8 * face,
        flipL: face * (12 + waving * (12 + 18 * Math.sin(c * 9))),
        flipR: face * (12 + waving * (12 + 18 * Math.sin(c * 9 + 1))),
        motes:
          c < 1.2
            ? Array.from({ length: 10 }, (_, i) => {
                const a = (i / 10) * TAU - Math.PI / 2 + 0.2;
                const d = 10 + 46 * easeOutCubic((c - 0.08) / 0.9);
                return {
                  x: Math.cos(a) * d,
                  y: Math.sin(a) * d,
                  r: c > 0.08 ? 3.6 * (1 - clamp((c - 0.35) / 0.75)) : 0,
                  o: clamp((1.15 - c) / 0.4),
                  k: kinds[i % 4],
                };
              })
            : [],
        badge: { r: BADGE_R * pop(c - 1.3), k: 'done' },
      });
    },
  },
  paused: {
    label: 'paused',
    rest: 0.6,
    morph: 0.5,
    fps: 15,
    pose: (t, ctx) =>
      base(t, ctx, {
        s: 0.32,
        sx: 1,
        sy: 1,
        face: 0,
        muted: 1,
        flipL: 0,
        flipR: 0,
        y: 3 - 4 * Math.sin((t * TAU) / 2.4),
        still: true,
      }),
  },
  stopped: {
    label: 'stopped',
    rest: 0,
    morph: 0.4,
    fps: 1,
    pose: (t, ctx) =>
      base(t, ctx, {
        eyes: both({ mode: 'dash' }),
        muted: 0.75,
        flipL: -12,
        flipR: -12,
        still: true,
      }),
  },
  'handing-off': {
    label: 'handing work over',
    rest: 0.5,
    morph: 0.45,
    fps: 24,
    pose: (t, ctx) => {
      const c = mod(t, 1.4);
      const k = easeOutCubic(c / 1.1);
      return base(t, ctx, {
        gx: 2.6,
        gy: -0.4,
        rot: 6,
        flipR: 40 + 16 * Math.sin(t * 7),
        motes: [
          {
            x: 44 + 22 * k,
            y: -6 - 14 * k,
            r: 5 * (1 - 0.4 * k),
            o: clamp((1.3 - c) / 0.4),
            k: 'light',
          },
        ],
      });
    },
  },
  receiving: {
    label: 'getting work',
    rest: 0.9,
    morph: 0.45,
    fps: 24,
    pose: (t, ctx) => {
      const c = mod(t, 1.6);
      const k = easeOutCubic(c / 1.1);
      return base(t, ctx, {
        gx: -2.2,
        gy: -1.6,
        rot: -5,
        eyes: both({ rx: 6.3, ry: 8 }),
        flipL: 44 + 10 * Math.sin(t * 6),
        motes: [
          {
            x: -66 + 26 * k,
            y: -34 + 22 * k,
            r: 5 * (1 - 0.5 * k),
            o: clamp(c / 0.25) * clamp((1.25 - c) / 0.3),
            k: 'light',
          },
        ],
      });
    },
  },
  reviewing: {
    label: 'reviewing',
    rest: 0.6,
    morph: 0.45,
    fps: 20,
    pose: (t, ctx) =>
      base(t, ctx, {
        rot: -4,
        gx: Math.sin((t * TAU) / 2.6) * 2.4,
        gy: 0.8,
        eyes: both({ lid: 0.36, low: 0.1 }),
      }),
  },
  happy: {
    label: 'happy',
    rest: 0.7,
    morph: 0.3,
    fps: 30,
    pose: (t, ctx) =>
      base(t, ctx, {
        y: -2.5 * (0.5 - 0.5 * Math.cos((t * TAU) / 1.4)),
        eyes: both({ mode: 'happy' }),
        cheeks: 0.85,
        flipL: 18 + 14 * Math.sin(t * 8),
        flipR: 18 + 14 * Math.sin(t * 8 + 1),
      }),
  },
} satisfies Record<string, StateDef>;
export type PenguinState = keyof typeof PENGUIN_STATES;

/** The app's state names for a Dot, mapped onto the penguin's. */
const STATE_ALIASES: Record<string, PenguinState> = {
  working: 'typing',
  writing: 'typing',
  tool: 'using-tool',
};
export function penguinState(state: string | undefined): PenguinState {
  if (!state) return 'idle';
  if (state in PENGUIN_STATES) return state as PenguinState;
  return STATE_ALIASES[state] ?? 'idle';
}
export function poseAt(
  state: PenguinState,
  t: number,
  ctx: PoseContext = {},
): Pose {
  return (PENGUIN_STATES[state] as StateDef).pose(t, ctx);
}
export const restPose = (state: PenguinState) =>
  poseAt(state, PENGUIN_STATES[state].rest);

function lerpMotes(a: Mote[], b: Mote[], k: number): Mote[] {
  const n = Math.max(a.length, b.length);
  return Array.from({ length: n }, (_, i) => {
    const p = a[i] ?? { ...b[i], r: 0, o: 0 };
    const q = b[i] ?? { ...a[i], r: 0, o: 0 };
    return {
      x: lerp(p.x, q.x, k),
      y: lerp(p.y, q.y, k),
      r: lerp(p.r, q.r, k),
      o: lerp(p.o, q.o, k),
      k: q.k ?? p.k,
    };
  });
}
const NUMERIC = [
  's',
  'x',
  'y',
  'sx',
  'sy',
  'rot',
  'face',
  'gx',
  'gy',
  'flipL',
  'flipR',
  'cheeks',
  'muted',
] as const;
/** Blends two poses. Eyes whose shapes differ swap behind a quick blink. */
export function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const P: Pose = { ...b };
  for (const key of NUMERIC) P[key] = lerp(a[key], b[key], k);
  P.eyes = b.eyes.map((e, i) => {
    const o = a.eyes[i];
    if (o.mode === e.mode)
      return {
        ...e,
        rx: lerp(o.rx, e.rx, k),
        ry: lerp(o.ry, e.ry, k),
        open: lerp(o.open, e.open, k),
        lid: lerp(o.lid, e.lid, k),
        low: lerp(o.low, e.low, k),
        spark: lerp(o.spark, e.spark, k),
      };
    return k < 0.5
      ? { ...o, open: o.open * (1 - k * 2) }
      : { ...e, open: e.open * (k * 2 - 1) };
  }) as [Eye, Eye];
  P.dots = lerpMotes(a.dots, b.dots, k);
  P.motes = lerpMotes(a.motes, b.motes, k);
  P.badge = {
    r: lerp(a.badge.r, b.badge.r, k),
    k: b.badge.r > 0.1 ? b.badge.k : a.badge.k,
  };
  return P;
}

// ---------- Drawing ----------

interface Colors {
  body: string;
  shade: string;
  light: string;
  cheek: string;
  belly: string;
  m: (c: string) => string;
}
function colorsFor(look: PenguinLook, muted: number): Colors {
  const p = look.palette;
  const m = (c: string) => (muted > 0 ? mix(c, GREY, 0.62 * muted) : c);
  const body = look.species === 'chick' ? mix(p.base, '#ffffff', 0.2) : p.base;
  return {
    body: m(body),
    shade: m(p.dark),
    light: m(p.light),
    cheek: m(p.cheek),
    belly: muted > 0 ? mix('#ffffff', '#eceef2', muted) : '#ffffff',
    m,
  };
}

function eyeMarkup(
  e: Eye,
  gx: number,
  gy: number,
  [cx, cy]: [number, number],
  sc: number,
  ring: boolean,
  lidFill: string,
  clipId: string,
): string {
  const open = clamp(e.open);
  const crx = ring ? 6 * sc + 3.3 : 6 * sc + 5;
  const cry = ring ? 7.5 * sc + 3.3 : 7.5 * sc + 5.5;
  const socket = `cx="${f(cx)}" cy="${f(cy)}" rx="${f(crx)}" ry="${f(cry)}"`;
  let s = `<clipPath id="${clipId}"><ellipse ${socket}/></clipPath>`;
  if (ring) s += `<ellipse ${socket} fill="#fff"/>`;
  let inner = '';
  if (e.mode === 'open') {
    const rx = e.rx * sc;
    const ryFull = e.ry * sc;
    const ry = Math.max(0.15, ryFull * open);
    const x = cx + gx * sc;
    const y = cy + gy * sc;
    inner += `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(rx)}" ry="${f(ry)}" fill="${EYE}"/>`;
    if (open > 0.45 && rx > 2.6) {
      inner += `<circle cx="${f(x - rx * 0.32)}" cy="${f(y - ry * 0.38)}" r="${f(rx * 0.32)}" fill="#fff"/>`;
      if (e.spark > 0.4)
        inner += `<circle cx="${f(x + rx * 0.34)}" cy="${f(y + ry * 0.36)}" r="${f(rx * 0.16)}" fill="#fff"/>`;
    }
    const w = rx + 5;
    if (e.lid > 0.01) {
      const b0 = cy - ryFull + e.lid * 2 * ryFull;
      const top = cy - cry - 1;
      inner += `<path d="M${f(cx - w)} ${f(top)}H${f(cx + w)}V${f(b0)}H${f(cx - w)}Z" fill="${lidFill}"/>`;
    }
    if (e.low > 0.01) {
      const b1 = cy + ryFull - e.low * 2 * ryFull;
      inner += `<path d="M${f(cx - w)} ${f(b1)}H${f(cx + w)}V${f(cy + cry + 1)}H${f(cx - w)}Z" fill="${lidFill}"/>`;
    }
  } else {
    const d = {
      happy: 'M-6.2 2.6Q0 -6.6 6.2 2.6',
      smile: 'M-6 -1.8Q0 5.4 6 -1.8',
      dash: 'M-6.8 .4H6.8',
      closed: 'M-6.2 .6Q0 2.6 6.2 .6',
    }[e.mode];
    inner = `<g transform="translate(${f(cx + gx * sc * 0.5)} ${f(cy + gy * sc * 0.5)}) scale(${f(sc)} ${f(sc * Math.max(0.05, open))})"><path d="${d}" fill="none" stroke="${EYE}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  }
  return s + `<g clip-path="url(#${clipId})">${inner}</g>`;
}

function marks(species: DotSpecies, c: Colors): string {
  switch (species) {
    case 'emperor':
      return `<ellipse cx="30.5" cy="62" rx="3.4" ry="7.8" fill="${c.m(GOLD)}" transform="rotate(-14 30.5 62)"/><ellipse cx="97.5" cy="62" rx="3.4" ry="7.8" fill="${c.m(GOLD)}" transform="rotate(14 97.5 62)"/>`;
    case 'rockhopper': {
      const brow = (x: (n: number) => number) =>
        `<path d="M${x(57)} 53Q${x(47)} 50 ${x(35)} 41M${x(55)} 56Q${x(45)} 54.5 ${x(34)} 49" stroke="${c.m('#ffcf33')}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
      return brow((n) => n) + brow((n) => 128 - n);
    }
    case 'macaroni':
      return `<path d="M63 41C58 31 64 20 79 15C72 22 72 28 77 33C70 31 66 35 63 41Z" fill="${c.m('#ff9f1c')}"/>`;
    case 'chick':
      return `<path d="M61 24Q58 16 63 11M66 24Q68 16 74 14" stroke="${c.body}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
    default:
      return '';
  }
}

const GEAR_INK = '#262a38';
/** Gear worn on the face (moves with the gaze) and on the head (stays with the body). */
function gearMarkup(
  gear: DotGear,
  v: VariantSpec,
  c: Colors,
  sc: number,
): { face: string; head: string } {
  switch (gear) {
    case 'glasses': {
      const [lx, ly] = v.eyeL;
      const [rx] = v.eyeR;
      const w = 10.5 * sc;
      const h = 9.5 * sc;
      const frame = (x: number) =>
        `<rect x="${f(x - w)}" y="${f(ly - h)}" width="${f(2 * w)}" height="${f(2 * h)}" rx="${f(7 * sc)}" fill="none" stroke="${GEAR_INK}" stroke-width="2.4"/>`;
      return {
        face:
          frame(lx) +
          frame(rx) +
          `<path d="M${f(lx + w)} ${f(ly - 2)}Q64 ${f(ly - 5)} ${f(rx - w)} ${f(ly - 2)}" stroke="${GEAR_INK}" stroke-width="2.4" fill="none"/>`,
        head: '',
      };
    }
    case 'headphones':
      return {
        face: '',
        head: `<path d="M15 66C12 2 116 2 113 66" stroke="${GEAR_INK}" stroke-width="4.6" fill="none" stroke-linecap="round"/><rect x="8.5" y="54" width="13" height="24" rx="6.5" fill="${c.light}" stroke="${GEAR_INK}" stroke-width="2.6"/><rect x="106.5" y="54" width="13" height="24" rx="6.5" fill="${c.light}" stroke="${GEAR_INK}" stroke-width="2.6"/>`,
      };
    case 'beanie': {
      const dark = luma(c.body) < 0.3;
      const hat = c.m(dark ? RED : c.light);
      const band = c.m(dark ? '#c94048' : c.shade);
      return {
        face: '',
        head: `<path d="M23 47C26 12 102 12 105 47C90 38 38 38 23 47Z" fill="${hat}"/><path d="M23 47C39 37 89 37 105 47" stroke="${band}" stroke-width="9" fill="none" stroke-linecap="round"/><circle cx="64" cy="15" r="6" fill="${band}"/>`,
      };
    }
    case 'scarf': {
      const red = c.m(RED);
      return {
        face: `<path d="M25.5 91C44 102 84 102 102.5 91L97 101C82 110 46 110 31 101Z" fill="${red}"/><path d="M82 101C84 109 86 115 88 120L96 117C94 111 92 105 90 99Z" fill="${mix(red, '#000000', 0.12)}"/>`,
        head: '',
      };
    }
    case 'bow':
      return {
        face: `<path d="M64 96L52.5 90Q50 96 52.5 102ZM64 96L75.5 90Q78 96 75.5 102Z" fill="${c.shade}"/><circle cx="64" cy="96" r="2.8" fill="${mix(c.shade, '#000000', 0.2)}"/>`,
        head: '',
      };
    default:
      return { face: '', head: '' };
  }
}

export interface DrawOptions {
  /** Prefix for the clip and mask ids: unique per character on the page. */
  id: string;
  /** A thin light rim, for dark Dots on a dark background. */
  rim?: boolean;
}

/** The inside of the penguin's `<svg>` for one pose. */
export function penguinMarkup(
  look: PenguinLook,
  P: Pose,
  variant: PenguinVariant,
  { id, rim = false }: DrawOptions,
): string {
  const v = VARIANTS[variant];
  const c = colorsFor(look, P.muted);
  const face = clamp(P.face);
  const fade = face < 1 ? ` opacity="${f(face)}"` : '';
  const ring = look.species === 'adelie';
  const sc = v.eye * (EYE_SCALE[look.species] ?? 1);
  let out = '';
  if (v.shadow)
    out += `<ellipse cx="64" cy="121.5" rx="${f(Math.max(4, 28 * Math.max(0.2, P.s) + Math.min(0, P.y) * 0.6))}" ry="3.4" fill="#000" opacity="${f(0.09 * Math.max(0.3, P.s))}"/>`;
  const rimStroke =
    rim && luma(c.body) < 0.3
      ? ` stroke="#ffffff" stroke-opacity=".22" stroke-width="${f(1.6 / Math.max(P.s, 0.15))}"`
      : '';
  let body = '';
  if (v.flippers && face > 0.02)
    body += `<g${fade} fill="${c.shade}"><ellipse cx="23" cy="83" rx="6.6" ry="13" transform="rotate(${f(14 + P.flipL)} 27 68)"/><ellipse cx="105" cy="83" rx="6.6" ry="13" transform="rotate(${f(-14 - P.flipR)} 101 68)"/></g>`;
  body += `<circle cx="64" cy="68" r="46" fill="${c.body}"${rimStroke}/>`;
  if (face > 0.02) {
    const gear = v.gear
      ? gearMarkup(look.gear, v, c, sc)
      : { face: '', head: '' };
    const beak = c.m(BEAK);
    // The face shifts a little with the gaze, so the head seems to turn.
    let fc = `<g transform="translate(${f(P.gx * 0.45)} ${f(P.gy * 0.35)})">`;
    fc += `<path d="${BELLIES[look.species]}" fill="${c.belly}"/>`;
    if (variant !== 'icon' || look.species !== 'chick')
      fc += marks(look.species, c);
    if (v.cheeks && P.cheeks > 0.02)
      fc += `<g fill="${c.cheek}" opacity="${f(0.55 * P.cheeks)}"><ellipse cx="37.5" cy="80.5" rx="6" ry="3.8"/><ellipse cx="90.5" cy="80.5" rx="6" ry="3.8"/></g>`;
    fc += `<path d="M56.4 76Q64 70.4 71.6 76Q67 84.6 64 85Q61 84.6 56.4 76Z" fill="${beak}" transform="translate(64 78) scale(${f(v.beak * (BEAK_SCALE[look.species] ?? 1))}) translate(-64 -78)"/>`;
    const lidFill = ring ? '#fff' : c.belly;
    fc += eyeMarkup(P.eyes[0], P.gx, P.gy, v.eyeL, sc, ring, lidFill, `${id}l`);
    fc += eyeMarkup(P.eyes[1], P.gx, P.gy, v.eyeR, sc, ring, lidFill, `${id}r`);
    fc += gear.face + '</g>';
    if (v.feet)
      fc += `<g fill="${beak}"><ellipse cx="50" cy="113.5" rx="9" ry="4.4"/><ellipse cx="78" cy="113.5" rx="9" ry="4.4"/></g>`;
    fc += gear.head;
    body += `<g${fade}>${fc}</g>`;
  }
  let defs = '';
  if (P.badge.r > 0.3) {
    // The badge sits in a notch cut out of the body, like a presence dot on an avatar.
    defs = `<defs><mask id="${id}m" maskUnits="userSpaceOnUse" x="-40" y="-40" width="208" height="208"><rect x="-40" y="-40" width="208" height="208" fill="#fff"/><circle cx="98.5" cy="37" r="${f(P.badge.r + 2.8)}" fill="#000"/></mask></defs>`;
    body = `<g mask="url(#${id}m)">${body}</g><circle cx="98.5" cy="37" r="${f(P.badge.r)}" fill="${STATUS_COLORS[P.badge.k]}"/><circle cx="96.6" cy="35.1" r="${f(P.badge.r * 0.28)}" fill="#fff" opacity=".7"/>`;
  }
  out += `<g transform="translate(${f(64 + P.x)} ${f(114 + P.y)}) rotate(${f(P.rot)}) scale(${f(P.sx)} ${f(P.sy)}) translate(-64 -114) translate(64 68) scale(${f(P.s)}) translate(-64 -68)">${body}</g>`;
  for (const d of P.dots)
    if (d.r > 0.2)
      out += `<circle cx="${f(64 + P.x + d.x)}" cy="${f(68 + d.y)}" r="${f(d.r)}" fill="${c.body}" opacity="${f(clamp(d.o))}"/>`;
  const moteColor = (k: Mote['k']) =>
    k === 'light'
      ? c.light
      : k === 'cheek'
        ? c.cheek
        : k && k !== 'body'
          ? STATUS_COLORS[k]
          : c.body;
  for (const m of P.motes)
    if (m.r > 0.2 && m.o > 0.02)
      out += `<circle cx="${f(64 + P.x + m.x)}" cy="${f(68 + P.y + m.y)}" r="${f(m.r)}" fill="${moteColor(m.k)}" opacity="${f(clamp(m.o))}"/>`;
  return defs + out;
}

/** A complete standalone SVG, for files and image tags. */
export function penguinSvg(
  look: PenguinLook,
  state: PenguinState,
  variant: PenguinVariant,
  options: Partial<DrawOptions> & { size?: number; title?: string } = {},
): string {
  const size = options.size
    ? ` width="${options.size}" height="${options.size}"`
    : '';
  const title = options.title ? `<title>${options.title}</title>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox(variant)}"${size}>${title}${penguinMarkup(look, restPose(state), variant, { id: options.id ?? 'p', rim: options.rim })}</svg>`;
}
