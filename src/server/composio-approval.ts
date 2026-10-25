import type { ActionLevel } from './approvals.js';

/** Prefix so the approval gate can tell a Composio tool from a built-in one. */
export const COMPOSIO_TOOL_PREFIX = 'composio__';

const READ_TOKEN = /^(GET|LIST|SEARCH|FETCH|READ|FIND)(?:S|ING|ED)?$/i;
const SECRET_KEY =
  /(^|[^a-z])(authorization|api[-_]?key|key|token|secret|password|passwd|cookie|credential|refresh|session|private)([^a-z]|$)/i;
const SECRET_VALUE =
  /^(sk-|ghp_|gho_|github_pat_|xox[baprs]-|ya29\.|bearer\s)/i;
const APP_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  github: 'GitHub',
  googlecalendar: 'Google Calendar',
  googledrive: 'Google Drive',
  slack: 'Slack',
  notion: 'Notion',
  linear: 'Linear',
};

export function isComposioTool(name: string): boolean {
  return (
    name.startsWith(COMPOSIO_TOOL_PREFIX) &&
    name.length > COMPOSIO_TOOL_PREFIX.length
  );
}

export function composioSlug(name: string): string {
  return isComposioTool(name) ? name.slice(COMPOSIO_TOOL_PREFIX.length) : name;
}

/** A slug that contains a read verb as its own word, such as `GMAIL_FETCH_EMAILS`. */
export function isComposioRead(slug: string): boolean {
  return slug
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .some((part) => READ_TOKEN.test(part));
}

/** Reads are ordinary; everything else, including an unknown slug, is sensitive. */
export function composioBaseLevel(tool: string): {
  level: ActionLevel;
  reason: string;
} {
  return isComposioRead(composioSlug(tool))
    ? { level: 'none', reason: 'read-only connected app' }
    : { level: 'sensitive', reason: 'connected app action' };
}

export function composioParts(slug: string): { app: string; action: string } {
  const parts = slug.split('_').filter(Boolean);
  const head = parts[0]?.toLowerCase() ?? 'app';
  const app =
    APP_NAMES[head] ??
    (head ? `${head.charAt(0).toUpperCase()}${head.slice(1)}` : 'App');
  const action = parts.slice(1).join(' ').toLowerCase() || 'use this app';
  return { app, action };
}

/** The phrase after "wants to" on the approval card. */
export function describeComposioAction(tool: string): string | undefined {
  if (!isComposioTool(tool)) return undefined;
  const { app, action } = composioParts(composioSlug(tool));
  return `${action} in ${app}`;
}

function mask(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string' && SECRET_VALUE.test(value.trim()))
    return '[hidden]';
  if (Array.isArray(value)) return value.map((item) => mask(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = SECRET_KEY.test(key) ? '[hidden]' : mask(item, depth + 1);
    return out;
  }
  return value;
}

/** App, action and arguments for the approval card, with secrets masked. */
export function composioExact(
  tool: string,
  args: Record<string, unknown>,
): string | undefined {
  if (!isComposioTool(tool)) return undefined;
  const { app, action } = composioParts(composioSlug(tool));
  return `${app} · ${action}\n${JSON.stringify(mask(args))}`;
}
