import type {
  ComputerAudit,
  ComputerPermissions,
  ComputerStatus,
} from '../../shared/computer-types';

export const COMPUTER_DOCS_URL =
  'https://github.com/asasemahmed/FullDots/blob/main/docs/COMPUTERS.md';

/** The part of the panel's UI the viewer picks and expects to find again next time. */
export type MoreTool = 'files' | 'terminal' | 'activity' | 'keyboard';
export const MORE_TOOLS: readonly MoreTool[] = [
  'files',
  'terminal',
  'activity',
  'keyboard',
];
export const MORE_TOOL_LABELS: Record<MoreTool, string> = {
  files: 'Files',
  terminal: 'Terminal',
  activity: 'Activity',
  keyboard: 'Keyboard',
};

export const MORE_OPEN_KEY = 'fulldots:computer:more-open';
export const MORE_TOOL_KEY = 'fulldots:computer:more-tool';

/** Browser storage can be missing, blocked or full. The panel works the same without it. */
export function readStored(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
export function writeStored(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Remembering is a convenience.
  }
}
export interface MorePrefs {
  open: boolean;
  tool: MoreTool;
}
/** Folded away until the viewer opens it; then it stays as they left it. */
export function readMorePrefs(): MorePrefs {
  const tool = readStored(MORE_TOOL_KEY);
  return {
    open: readStored(MORE_OPEN_KEY) === '1',
    tool: MORE_TOOLS.find((name) => name === tool) ?? 'files',
  };
}
export function writeMorePrefs(prefs: MorePrefs): void {
  writeStored(MORE_OPEN_KEY, prefs.open ? '1' : '0');
  writeStored(MORE_TOOL_KEY, prefs.tool);
}

export type PermissionKey = keyof ComputerPermissions;
export const PERMISSION_COPY: readonly {
  key: PermissionKey;
  title: string;
  description: (dot: string) => string;
}[] = [
  {
    key: 'enabled',
    title: 'Computer access',
    description: (dot) =>
      `The main switch. Turn it off and neither you nor ${dot} can use this computer.`,
  },
  {
    key: 'browser',
    title: 'Browser',
    description: () =>
      'Open websites, see the live screen, and click and type in the browser.',
  },
  {
    key: 'files',
    title: 'Files',
    description: (dot) =>
      `Read and save files in ${dot}’s workspace. They are kept when the computer stops.`,
  },
  {
    key: 'shell',
    title: 'Shell',
    description: () =>
      'Run terminal commands. They run only inside the computer’s container, never on your device.',
  },
];

export type PillTone = 'ok' | 'neutral' | 'warn' | 'bad';
/** What the panel is showing, in order of what the viewer can do about it. */
export type PanelPhase =
  | 'loading'
  | 'unreachable'
  | 'not_configured'
  | 'unavailable'
  | 'stopped'
  | 'disabled'
  | 'running';

export function panelPhase(
  status: ComputerStatus | undefined,
  loadError: boolean,
): PanelPhase {
  if (!status) return loadError ? 'unreachable' : 'loading';
  if (!status.configured || status.state === 'not_configured')
    return 'not_configured';
  if (status.state === 'unavailable') return 'unavailable';
  if (!status.permissions.enabled) return 'disabled';
  return status.state === 'running' ? 'running' : 'stopped';
}

export const PHASE_PILL: Record<PanelPhase, { label: string; tone: PillTone }> =
  {
    loading: { label: 'Loading', tone: 'neutral' },
    unreachable: { label: 'Unavailable', tone: 'bad' },
    not_configured: { label: 'Not set up', tone: 'neutral' },
    unavailable: { label: 'Unavailable', tone: 'bad' },
    stopped: { label: 'Stopped', tone: 'neutral' },
    disabled: { label: 'Access off', tone: 'warn' },
    running: { label: 'Running', tone: 'ok' },
  };

/** How the panel shows a running computer whose access switch is off: not at all, like a stopped one. */
export function isUsable(status: ComputerStatus | undefined): boolean {
  return status?.state === 'running' && !!status.permissions.enabled;
}

const SHORT_WINDOW_MS = 8_000;
const PENDING_WINDOW_MS = 90_000;
/** What the Dot is doing, in the words used next to "Dot is …". */
const PRESENT_VERBS: Record<string, string> = {
  navigate: 'navigating',
  snapshot: 'looking at the page',
  read: 'reading the page',
  screenshot: 'looking at the screen',
  click: 'clicking',
  type: 'typing',
  key: 'pressing a key',
  scroll: 'scrolling',
  files_list: 'browsing files',
  files_read: 'reading a file',
  files_write: 'saving a file',
  exec: 'running a command',
};
/** The same events, as the activity list records them after the fact. */
const PAST_LABELS: Record<string, string> = {
  navigate: 'Opened a page',
  snapshot: 'Looked at the page',
  read: 'Read the page',
  screenshot: 'Took a screenshot',
  click: 'Clicked',
  type: 'Typed',
  key: 'Pressed a key',
  scroll: 'Scrolled',
  files_list: 'Listed files',
  files_read: 'Read a file',
  files_write: 'Saved a file',
  exec: 'Ran a command',
  human_click: 'Clicked',
  human_type: 'Typed',
  human_key: 'Pressed a key',
  human_scroll: 'Scrolled',
  take: 'Took control',
  release: 'Gave control back',
  start: 'Started the computer',
  stop: 'Stopped the computer',
  permissions: 'Changed permissions',
};

/** Newest first, whichever way the server happened to order them. */
export function newestFirst(audit: readonly ComputerAudit[]): ComputerAudit[] {
  return audit
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.createdAt - a.entry.createdAt || a.index - b.index)
    .map(({ entry }) => entry);
}

/**
 * What the owner's own panel does to keep itself current. These are recorded like any other action
 * but are not something anyone did, so the activity list leaves them out.
 */
function isHousekeeping(entry: ComputerAudit): boolean {
  return (
    entry.actor === 'owner' &&
    (entry.action === 'screenshot' ||
      entry.action === 'read' ||
      entry.action === 'stream')
  );
}
export function visibleAudit(audit: readonly ComputerAudit[], limit = 30) {
  return newestFirst(audit)
    .filter((entry) => !isHousekeeping(entry))
    .slice(0, limit);
}
export function auditLabel(entry: ComputerAudit): string {
  return (
    PAST_LABELS[entry.action] ??
    entry.action.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
  );
}

export interface Activity {
  action: string;
  /** "navigating", "typing" … */
  verb: string;
}
/**
 * The Dot's current action, from the newest thing it did: running now, or finished a moment ago so a
 * quick click is not missed between two polls. Undefined when it is idle.
 */
export function currentActivity(
  audit: readonly ComputerAudit[],
  now: number,
): Activity | undefined {
  const latest = newestFirst(audit).find((entry) => entry.actor === 'agent');
  if (!latest) return undefined;
  const verb = PRESENT_VERBS[latest.action];
  if (!verb) return undefined;
  const age = now - latest.createdAt;
  const fresh =
    latest.outcome === 'pending'
      ? age < PENDING_WINDOW_MS
      : latest.outcome === 'succeeded' && age < SHORT_WINDOW_MS;
  return fresh ? { action: latest.action, verb } : undefined;
}

/** `example.com/path` for an address, without the noise. */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return url;
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return `${parsed.host.replace(/^www\./, '')}${path}`;
  } catch {
    return url;
  }
}

/** Accepts `example.com` as well as `https://example.com`. */
export function normalizeUrl(input: string): string {
  const text = input.trim();
  if (!text) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(text) && !/^[^/]+:\d+(\/|$)/.test(text)
    ? text
    : `https://${text}`;
}

/** Results of file and terminal actions are shown as text. */
export function formatOutput(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
}
