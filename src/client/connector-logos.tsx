// Brand marks for connectors. Logos come from Simple Icons (CC0; each mark stays its owner's
// trademark), imported one by one so only these are bundled. Services without a mark get a
// matching Lucide icon. Everything is inline SVG: the app's CSP allows no remote images.
import {
  siAsana,
  siAtlassian,
  siBox,
  siCloudflare,
  siConfluence,
  siFigma,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siIntercom,
  siJira,
  siLinear,
  siNeon,
  siNotion,
  siPaypal,
  siSentry,
  siStripe,
  siSupabase,
  siVercel,
  siWebflow,
  siZapier,
  type SimpleIcon,
} from 'simple-icons';
import {
  FolderOpen,
  Globe,
  Plug,
  Terminal,
  type LucideIcon,
} from 'lucide-react';

type Mark =
  | { kind: 'brand'; icon: SimpleIcon }
  | { kind: 'glyph'; icon: LucideIcon; hex: string }
  /** The service's own full-colour logo, served from public/connectors; `hex` tints the tile. */
  | { kind: 'image'; src: string; hex: string };

const brand = (icon: SimpleIcon): Mark => ({ kind: 'brand', icon });
const image = (src: string, hex: string): Mark => ({
  kind: 'image',
  src,
  hex,
});
const glyph = (icon: LucideIcon, hex: string): Mark => ({
  kind: 'glyph',
  icon,
  hex,
});

/** Keyed by preset id, and by the words a custom connector's name or URL often contains. */
const MARKS: Record<string, Mark> = {
  github: brand(siGithub),
  notion: brand(siNotion),
  gmail: brand(siGmail),
  'google-drive': brand(siGoogledrive),
  googledrive: brand(siGoogledrive),
  'google-calendar': brand(siGooglecalendar),
  googlecalendar: brand(siGooglecalendar),
  linear: brand(siLinear),
  sentry: brand(siSentry),
  atlassian: brand(siAtlassian),
  jira: brand(siJira),
  confluence: brand(siConfluence),
  asana: brand(siAsana),
  stripe: brand(siStripe),
  figma: brand(siFigma),
  cloudflare: brand(siCloudflare),
  huggingface: image('/connectors/huggingface.svg', '#FF9D0B'),
  'hugging-face': image('/connectors/huggingface.svg', '#FF9D0B'),
  box: brand(siBox),
  webflow: brand(siWebflow),
  vercel: brand(siVercel),
  supabase: brand(siSupabase),
  neon: brand(siNeon),
  zapier: brand(siZapier),
  paypal: brand(siPaypal),
  intercom: brand(siIntercom),
  filesystem: glyph(FolderOpen, '#C27C0E'),
  fetch: glyph(Globe, '#2F80ED'),
};

/** The mark for a preset id, else the first known word in the connector's name or URL. */
export function connectorMark(
  presetId?: string | null,
  name?: string,
  url?: string | null,
  transport?: 'http' | 'stdio',
): Mark {
  if (presetId && MARKS[presetId]) return MARKS[presetId];
  const haystack = `${name ?? ''} ${url ?? ''}`.toLowerCase();
  for (const [key, mark] of Object.entries(MARKS))
    if (haystack.includes(key)) return mark;
  return transport === 'stdio'
    ? glyph(Terminal, '#5B6170')
    : glyph(Plug, '#5B6170');
}

/** Readable brand colour for a mark on a light tile (very light brand colours fall back to ink). */
export function markColor(mark: Mark): string {
  const hex = mark.kind === 'brand' ? `#${mark.icon.hex}` : mark.hex;
  const value = parseInt(hex.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.72 ? '#242424' : hex;
}

/**
 * A square logo tile: the brand mark in its colour on a soft tint of that colour.
 * `size` is the tile edge in pixels; the mark fills about 55% of it.
 */
export function ConnectorLogo({
  presetId,
  name,
  url,
  transport,
  size = 48,
}: {
  presetId?: string | null;
  name?: string;
  url?: string | null;
  transport?: 'http' | 'stdio';
  size?: number;
}) {
  const mark = connectorMark(presetId, name, url, transport);
  // A service's own full-colour logo stands on its own: no tinted tile behind it.
  if (mark.kind === 'image')
    return (
      <span
        className="connector-logo connector-logo-image"
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          display: 'inline-grid',
          placeItems: 'center',
        }}
      >
        <img
          src={mark.src}
          width={Math.round(size * 0.92)}
          height={Math.round(size * 0.92)}
          alt=""
          draggable={false}
          style={{ objectFit: 'contain' }}
        />
      </span>
    );
  const color = markColor(mark);
  const inner = Math.round(size * 0.55);
  return (
    <span
      className="connector-logo"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.26),
        color,
        background: `color-mix(in srgb, ${color} 10%, #fff)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 18%, transparent)`,
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
