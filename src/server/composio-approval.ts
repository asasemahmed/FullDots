import type { ActionLevel } from './approvals.js';

/** Prefix so the approval gate can tell a Composio tool from a built-in one. */
export const COMPOSIO_TOOL_PREFIX = 'composio__';

const READ_VERB = /^(GET|LIST|SEARCH|FETCH|READ|FIND)(?:S|ING|ED)?$/i;
/**
 * Any of these anywhere in a slug makes it a write, even after a read verb
 * (`DOCS_SEARCH_AND_REPLACE`, `X_GET_AND_DELETE`). It includes every action word
 * the rule categories match, so a send, payment, delete or publish never passes
 * as a read and always meets the owner's Never rules.
 */
const WRITE_VERB =
  /^(CREATE|ADD|INSERT|UPDATE|UPSERT|EDIT|MODIFY|PATCH|PUT|POST|SET|REPLACE|RENAME|MOVE|COPY|DUPLICATE|DELETE|REMOVE|DESTROY|ERASE|PURGE|WIPE|UNLINK|TRASH|ARCHIVE|UNARCHIVE|CLEAR|RESET|RESTORE|MARK|STAR|UNSTAR|LABEL|TAG|ASSIGN|UNASSIGN|SEND|REPLY|FORWARD|NOTIFY|INVITE|PUBLISH|SHARE|TWEET|DEPLOY|UPLOAD|WRITE|SUBMIT|APPROVE|REJECT|ACCEPT|DECLINE|CANCEL|CLOSE|REOPEN|MERGE|ENABLE|DISABLE|START|STOP|RUN|EXECUTE|TRIGGER|SCHEDULE|PIN|UNPIN|MUTE|UNMUTE|FOLLOW|UNFOLLOW|LIKE|REACT|SUBSCRIBE|UNSUBSCRIBE|LOCK|UNLOCK|IMPORT|SYNC|TRANSFER|BUY|PURCHASE|PAY|CHECKOUT|ORDER|DONATE|CHARGE|REFUND|BOOK|JOIN|LEAVE|KICK|BAN|BLOCK|UNBLOCK|GRANT|REVOKE|INSTALL|UNINSTALL|CONNECT|DISCONNECT)(?:S|ES|ED|D|ING)?$/i;
/** Key names that hold secrets, matched anywhere in the name so `accessToken` and `client_secret` both count. */
const SECRET_KEY =
  /authori[sz]ation|api[-_]?key|apikey|token|secret|password|passwd|pwd|cookie|credential|private[-_]?key|privatekey|session|auth|signature/i;
const SECRET_VALUE =
  /^(sk-|ghp_|gho_|ghs_|github_pat_|glpat-|xox[abeoprs]-|xapp-|ya29\.|AIza|AKIA|ASIA|eyJ[A-Za-z0-9_-]{8,}\.|bearer\s|basic\s)/i;
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

/**
 * A read is `<TOOLKIT>_<read verb>_...`, such as `GMAIL_FETCH_EMAILS`: the word right after the toolkit is
 * a read verb and no write verb appears anywhere. A read word elsewhere in the slug does not count
 * (`GOOGLETASKS_DELETE_TASK_LIST`, `GITHUB_MARK_NOTIFICATIONS_AS_READ`), and an unrecognised shape is not a read.
 */
export function isComposioRead(slug: string): boolean {
  const words = slug
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  if (words.length < 2 || !READ_VERB.test(words[1])) return false;
  return !words.some((word) => WRITE_VERB.test(word));
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
