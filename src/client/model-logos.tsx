// Brand marks for model providers. Logos come from Simple Icons (CC0; each mark stays its
// owner's trademark), imported one by one so only these are bundled. Providers without a mark
// there get a Lucide glyph in the brand colour. Everything is inline SVG: the app's CSP allows
// no remote images.
import {
  siAnthropic,
  siDeepseek,
  siGooglegemini,
  siLmstudio,
  siMistralai,
  siOllama,
  type SimpleIcon,
} from 'simple-icons';
import {
  Cpu,
  Flame,
  Layers,
  Orbit,
  Server,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react';

export type ModelMark =
  | { kind: 'brand'; icon: SimpleIcon }
  | { kind: 'glyph'; icon: LucideIcon; hex: string };

const brand = (icon: SimpleIcon): ModelMark => ({ kind: 'brand', icon });
const glyph = (icon: LucideIcon, hex: string): ModelMark => ({
  kind: 'glyph',
  icon,
  hex,
});

/** Keyed by preset id. */
const MARKS: Record<string, ModelMark> = {
  openai: glyph(Sparkles, '#0E8F6E'),
  anthropic: brand(siAnthropic),
  gemini: brand(siGooglegemini),
  // Simple Icons lists OpenRouter in pale grey, weak on a light tile: use the brand blue.
  openrouter: glyph(Orbit, '#6467F2'),
  groq: glyph(Zap, '#F55036'),
  mistral: brand(siMistralai),
  deepseek: brand(siDeepseek),
  xai: glyph(Orbit, '#242424'),
  together: glyph(Layers, '#0F6FFF'),
  fireworks: glyph(Flame, '#E9631A'),
  cerebras: glyph(Cpu, '#E5461E'),
  ollama: brand(siOllama),
  lmstudio: brand(siLmstudio),
  custom: glyph(Server, '#5B6170'),
};

/** The mark for a preset id; anything unknown looks like a custom server. */
export function modelMark(presetId?: string | null): ModelMark {
  return (presetId && MARKS[presetId]) || MARKS.custom!;
}

/** Readable brand colour for a mark on a light tile (very light colours fall back to ink). */
export function modelMarkColor(mark: ModelMark): string {
  const hex = mark.kind === 'brand' ? `#${mark.icon.hex}` : mark.hex;
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.72 ? '#242424' : hex;
}

/**
 * A square logo tile: the mark in its colour on a soft tint of that colour. `size` is the
 * tile edge in pixels; the mark fills about 55% of it.
 */
export function ModelLogo({
  presetId,
  size = 48,
}: {
  presetId?: string | null;
  size?: number;
}) {
  const mark = modelMark(presetId);
  const color = modelMarkColor(mark);
  const inner = Math.round(size * 0.55);
  return (
    <span
      className="connector-logo model-logo"
      data-preset={presetId ?? 'custom'}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        color,
        background: `color-mix(in srgb, ${color} 10%, #fff)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 18%, transparent)`,
        display: 'inline-grid',
        placeItems: 'center',
        flex: 'none',
      }}
    >
      {mark.kind === 'brand' ? (
        <svg
          viewBox="0 0 24 24"
          width={inner}
          height={inner}
          fill="currentColor"
          role="img"
        >
          <path d={mark.icon.path} />
        </svg>
      ) : (
        <mark.icon size={inner} strokeWidth={1.8} />
      )}
    </span>
  );
}
