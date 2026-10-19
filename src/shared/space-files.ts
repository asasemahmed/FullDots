// Files kept in a Space, beside its pages. Shared by the server (which decides what a file is) and
// the viewer (which decides how to show it).

/** The default and the highest value of SPACE_FILE_MAX_MB. */
export const DEFAULT_SPACE_FILE_MB = 10;
export const MAX_SPACE_FILE_MB = 50;

/** What the viewer does with a file. `download` has no preview. */
export type FileKind =
  'markdown' | 'html' | 'csv' | 'text' | 'json' | 'image' | 'pdf' | 'download';

interface KnownType {
  mediaType: string;
  kind: FileKind;
}

/**
 * The extensions FullDots knows. The server derives the media type from the name and never trusts
 * the one a client sends. HTML is previewed only inside a sandboxed frame with no script access (see
 * FileViewer); scripts and other active formats are absent, so they are kept as downloads only and
 * a stored file can never run in the app's origin.
 */
const KNOWN: Record<string, KnownType> = {
  md: { mediaType: 'text/markdown', kind: 'markdown' },
  markdown: { mediaType: 'text/markdown', kind: 'markdown' },
  csv: { mediaType: 'text/csv', kind: 'csv' },
  tsv: { mediaType: 'text/tab-separated-values', kind: 'csv' },
  html: { mediaType: 'text/html', kind: 'html' },
  htm: { mediaType: 'text/html', kind: 'html' },
  txt: { mediaType: 'text/plain', kind: 'text' },
  log: { mediaType: 'text/plain', kind: 'text' },
  json: { mediaType: 'application/json', kind: 'json' },
  png: { mediaType: 'image/png', kind: 'image' },
  jpg: { mediaType: 'image/jpeg', kind: 'image' },
  jpeg: { mediaType: 'image/jpeg', kind: 'image' },
  gif: { mediaType: 'image/gif', kind: 'image' },
  webp: { mediaType: 'image/webp', kind: 'image' },
  svg: { mediaType: 'image/svg+xml', kind: 'image' },
  pdf: { mediaType: 'application/pdf', kind: 'pdf' },
};

const FALLBACK: KnownType = {
  mediaType: 'application/octet-stream',
  kind: 'download',
};

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function typeOfName(name: string): KnownType {
  return KNOWN[extensionOf(name)] ?? FALLBACK;
}

/** Text kinds the viewer fetches and shows itself, so a Dot can read them too. */
export const TEXT_KINDS: readonly FileKind[] = [
  'markdown',
  'html',
  'csv',
  'text',
  'json',
];

/** A file's details, without its contents. */
export interface SpaceFile {
  id: string;
  spaceId: string;
  /** The page it sits under, like a subpage; null at the top of the Space. */
  parentId: string | null;
  name: string;
  mediaType: string;
  kind: FileKind;
  size: number;
  sha256: string;
  /** The chat that produced it, when a Dot did. */
  sourceThreadId: string | null;
  createdAt: number;
  updatedAt: number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
