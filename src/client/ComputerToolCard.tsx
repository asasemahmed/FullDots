// Step model for `computer_*` tool calls. The chat no longer renders one big
// card per call; ComputerActivity shows one compact block per turn and uses
// the helpers below to describe each call as a single short step. The live
// browser view lives in the computer side panel, so nothing here fetches or
// renders screenshots.
import {
  ArrowDownUp,
  BookOpen,
  Camera,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Keyboard,
  ListChecks,
  Monitor,
  MousePointerClick,
  Plug,
  ScanSearch,
  Terminal,
  TextCursorInput,
  type LucideIcon,
} from 'lucide-react';

const labels: Record<string, string> = {
  navigate: 'Opening website',
  snapshot: 'Inspecting browser',
  read: 'Reading page',
  screenshot: 'Viewing browser',
  click: 'Clicking in browser',
  type: 'Typing in browser',
  select: 'Choosing an option',
  key: 'Using keyboard',
  scroll: 'Scrolling page',
  files_write: 'Saving file',
  files_read: 'Reading file',
  files_list: 'Listing files',
  exec: 'Running terminal command',
};
const icons: Record<string, LucideIcon> = {
  navigate: Globe,
  snapshot: ScanSearch,
  read: BookOpen,
  screenshot: Camera,
  click: MousePointerClick,
  type: TextCursorInput,
  select: ListChecks,
  key: Keyboard,
  scroll: ArrowDownUp,
  files_write: FilePen,
  files_read: FileText,
  files_list: FolderOpen,
  exec: Terminal,
};
export function computerActionName(toolName: string): string {
  return toolName.replace(/^computer_/, '');
}
/** `mcp__<connector>__<tool>` split into its connector and tool, or undefined for other tools. */
export function mcpToolParts(
  toolName: string,
): { connector: string; tool: string } | undefined {
  const match = /^mcp__(.+?)__(.+)$/.exec(toolName);
  return match ? { connector: match[1], tool: match[2] } : undefined;
}
export function computerStepLabel(toolName: string): string {
  const mcp = mcpToolParts(toolName);
  if (mcp) return `Using ${mcp.connector}`;
  return labels[computerActionName(toolName)] ?? 'Using computer';
}
export function computerStepIcon(toolName: string): LucideIcon {
  if (mcpToolParts(toolName)) return Plug;
  return icons[computerActionName(toolName)] ?? Monitor;
}
export function computerToolResult(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: raw };
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : {};
}

export type ComputerStepState = 'running' | 'done' | 'failed' | 'interrupted';
export type ComputerStep = {
  id: string;
  /** Tool name, e.g. `computer_type`. */
  name: string;
  label: string;
  /** Short, single-line, never contains base64 or data URLs. */
  detail: string;
  /** Longer text for a tooltip when the detail was shortened. */
  title: string;
  state: ComputerStepState;
  /** Error or interruption note, already shortened. */
  message: string;
};
type ElementInfo = { role: string; name: string };
export type ComputerElementIndex = Map<string, ElementInfo>;

const DETAIL_LIMIT = 80;
const TITLE_LIMIT = 300;
const MESSAGE_LIMIT = 200;
// Results larger than this (screenshots, huge snapshots) are never fully
// parsed on render; only a few leading fields are read.
const PARSE_LIMIT = 1_000_000;
const CACHE_LIMIT = 64;
const parsedResults = new Map<string, Record<string, unknown>>();

/** Collapse whitespace, shorten, and never let base64 or data URLs through. */
export function clipText(value: string, max = DETAIL_LIMIT): string {
  const text = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || /^data:/i.test(text)) return '';
  const safe = text.replace(/[A-Za-z0-9+/=]{120,}/g, '…');
  return safe.length > max ? `${safe.slice(0, max - 1).trimEnd()}…` : safe;
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function headField(head: string, key: string): string {
  const match = new RegExp(
    `"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.){0,2000})"`,
  ).exec(head);
  if (!match) return '';
  try {
    return text(JSON.parse(`"${match[1]}"`));
  } catch {
    return match[1];
  }
}
function parseResult(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return computerToolResult(raw);
  if (raw.length > PARSE_LIMIT) {
    const head = raw.slice(0, 4000);
    const result: Record<string, unknown> = {};
    for (const key of ['url', 'title', 'error'])
      if (headField(head, key)) result[key] = headField(head, key);
    return result;
  }
  const cached = parsedResults.get(raw);
  if (cached) return cached;
  const parsed = computerToolResult(raw);
  parsedResults.set(raw, parsed);
  if (parsedResults.size > CACHE_LIMIT)
    parsedResults.delete(parsedResults.keys().next().value as string);
  return parsed;
}
/** A connector result: usually JSON with a `content` string, but plain text is fine too. */
function parseMcpResult(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return computerToolResult(raw);
  if (raw.length > PARSE_LIMIT) return { content: raw.slice(0, 4000) };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parseResult(raw);
  } catch {
    // plain text
  }
  return { content: raw };
}
function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {}; // still streaming; fill in once the arguments are complete
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? Object.fromEntries(Object.entries(raw))
    : {};
}
function formatUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return clipText(url);
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return clipText(`${parsed.host.replace(/^www\./, '')}${path}`);
  } catch {
    return clipText(url);
  }
}
function firstText(item: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = item[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
/** Remember element names from a snapshot so click/type steps can name them. */
export function indexSnapshotElements(
  data: Record<string, unknown>,
  index: ComputerElementIndex,
) {
  if (!Array.isArray(data.elements)) return;
  for (const entry of data.elements.slice(0, 5000)) {
    const item = asRecord(entry);
    const ref = text(item.ref);
    if (!ref) continue;
    index.set(ref, {
      role: firstText(item, ['role', 'tag']),
      name: firstText(item, [
        'name',
        'text',
        'label',
        'title',
        'placeholder',
        'alt',
        'description',
      ]),
    });
  }
}
function describeElement(
  ref: string,
  data: Record<string, unknown>,
  index?: ComputerElementIndex,
): { label: string; sensitive: boolean } {
  const direct = data.element ?? data.target;
  const fromResult =
    typeof direct === 'string'
      ? { role: '', name: direct }
      : (() => {
          const item = asRecord(direct);
          return {
            role: firstText(item, ['role', 'tag']),
            name: firstText(item, ['name', 'text', 'label', 'title']),
          };
        })();
  const known = index?.get(ref);
  const name = fromResult.name || known?.name || '';
  const role = fromResult.role || known?.role || '';
  const sensitive =
    data.inputType === 'password' ||
    data.type === 'password' ||
    /pass(word|code)|secret|\bpin\b|cvv|card number/i.test(`${role} ${name}`);
  const label = name
    ? `${role ? `${role} ` : ''}“${clipText(name, 40)}”`
    : ref
      ? `element ${clipText(ref, 24)}`
      : '';
  return { label, sensitive };
}

export function describeComputerStep(
  call: { id: string; name: string; arguments?: unknown },
  result: unknown,
  options: { live: boolean; elements?: ComputerElementIndex },
): ComputerStep {
  const action = computerActionName(call.name);
  const mcp = mcpToolParts(call.name);
  const args = parseArgs(call.arguments);
  const hasResult = result !== undefined && result !== null;
  const data = hasResult ? (mcp ? parseMcpResult : parseResult)(result) : {};
  const interrupted =
    data.status === 'stopped' || data.reason === 'stop_requested';
  const error =
    typeof data.error === 'string'
      ? data.error
      : data.status === 'error' && typeof data.message === 'string'
        ? data.message
        : '';
  const exitCode = typeof data.exitCode === 'number' ? data.exitCode : 0;
  const failed = data.status === 'error' || !!error || exitCode !== 0;
  const state: ComputerStepState = interrupted
    ? 'interrupted'
    : failed
      ? 'failed'
      : hasResult
        ? 'done'
        : options.live
          ? 'running'
          : 'interrupted';
  const message = interrupted
    ? text(data.message)
    : error ||
      (exitCode !== 0
        ? text(data.stderr)
            .split('\n')
            .find((line) => line.trim()) || `Exited with code ${exitCode}`
        : '');

  let detail = '';
  let full = '';
  const url = text(args.url) || text(data.url);
  if (mcp) {
    // Connector results are text for the model; show the start of it, or the
    // tool name while the call is still running.
    const content = text(data.content);
    full = content || mcp.tool;
    detail = clipText(content) || mcp.tool;
  } else
    switch (action) {
      case 'navigate':
        full = url;
        detail = formatUrl(url);
        break;
      case 'snapshot':
      case 'read':
        full = text(data.title) || url;
        detail = clipText(text(data.title)) || formatUrl(url);
        break;
      case 'screenshot':
        full = url;
        detail = formatUrl(url);
        break;
      case 'click': {
        const element = describeElement(text(args.ref), data, options.elements);
        full = detail = element.label;
        break;
      }
      case 'select':
        full = detail = clipText(text(args.option));
        break;
      case 'type': {
        const element = describeElement(text(args.ref), data, options.elements);
        const typed = text(args.text);
        const shown = element.sensitive
          ? typed
            ? '••••••'
            : ''
          : clipText(typed, 50);
        const submit = args.submit === true || data.submitted === true;
        const target = element.label && !element.label.startsWith('element ');
        detail = shown
          ? `“${shown}”${target ? ` in ${element.label}` : ''}${submit ? ' + Enter' : ''}`
          : element.label;
        full = element.sensitive ? detail : clipText(typed, TITLE_LIMIT);
        break;
      }
      case 'key':
        full = detail = text(args.key);
        break;
      case 'scroll':
        full = detail =
          typeof args.deltaY === 'number' && Number.isFinite(args.deltaY)
            ? `${args.deltaY < 0 ? 'Up' : 'Down'} ${Math.abs(Math.round(args.deltaY))}px`
            : '';
        break;
      case 'files_list':
      case 'files_read':
      case 'files_write':
        full = text(args.path) || '/';
        detail = clipText(full);
        break;
      case 'exec':
        full = text(args.command);
        detail = clipText(full);
        break;
    }
  detail = clipText(detail);
  const title = clipText(full, TITLE_LIMIT);
  return {
    id: call.id,
    name: call.name,
    label: computerStepLabel(call.name),
    detail,
    title: title && title !== detail ? title : '',
    state,
    message: clipText(message, MESSAGE_LIMIT),
  };
}

/** Describe an ordered run of computer calls, resolving element names from earlier snapshots. */
export function describeComputerSteps(
  calls: { id: string; name: string; arguments?: unknown }[],
  results: ReadonlyMap<string, unknown>,
  live: boolean,
): ComputerStep[] {
  const elements: ComputerElementIndex = new Map();
  return calls.map((call) => {
    const result = results.get(call.id);
    if (computerActionName(call.name) === 'snapshot' && result !== undefined)
      indexSnapshotElements(parseResult(result), elements);
    return describeComputerStep(call, result, { live, elements });
  });
}
