import { createHash } from 'node:crypto';
import type { ApprovalMode, ToolOverride } from '../shared/types.js';
import { SENSITIVE } from './computer-agent.js';

export type ActionLevel = 'none' | 'write' | 'sensitive';

/** Button, link and field names that suggest an irreversible or outward-facing action. */
export const SENSITIVE_ACTION =
  /send|submit|publish|post|buy|pay|order|checkout|delete|remove|confirm|transfer/i;

export interface ElementIdentity {
  role: string;
  name: string;
}

export interface ClassifyInput {
  /** computer_click | computer_type | computer_select | computer_key | computer_exec | computer_files_write | mcp__* | create_space_page | edit_space_page | ... */
  tool: string;
  /** Zod-parsed (defaults applied) for computer/page tools; the raw object for MCP. */
  args: Record<string, unknown>;
  /** Resolved target for ref actions (undefined when unknown). */
  element?: ElementIdentity;
  /** Presumed focus for computer_key. */
  focus?: ElementIdentity;
  /** Latest snapshot of this turn. */
  latestElements?: ElementIdentity[];
  mcp?: { readOnly: boolean; destructive: boolean; override?: ToolOverride };
}

export interface Classification {
  level: ActionLevel;
  gated: boolean;
  reason: string;
}

const METHOD = '(POST|PUT|DELETE|PATCH|post|put|delete|patch)';

/**
 * HEURISTIC list of shell commands that change state beyond plain reads or that
 * leave the machine. Each pattern is matched against the whole command and against
 * every segment of it (split on `; & | &&`, newlines, backticks, parentheses and
 * braces), with leading `env VAR=val`, `nohup`, `time` ... prefixes and the directory
 * part of the program name removed, on text whose quoted strings are masked. It is a
 * best-effort tripwire and not a sandbox: it can miss obfuscated commands and it
 * deliberately errs towards asking.
 * Choices: every `mv` counts (whether it overwrites needs file-system knowledge the
 * server lacks); `>` and `>|` count while `>>` does not; `2>&1`, `>&2` and redirects to
 * /dev/null do not count; `2> file` counts because it truncates the file.
 */
export const DESTRUCTIVE_EXEC: RegExp[] = [
  /^(sudo|doas)\b/,
  /^rm\b/,
  /^mv\b/,
  // `find ... -delete`, and `-exec`/`-execdir`/`-ok`/`-okdir`, which run a command on every match.
  /^find\b.*\s-(delete|exec|execdir|ok|okdir)\b/,
  // Truncating redirection: `>` or `>|` (optionally with a fd digit or `&` prefix) to a
  // target other than /dev/null. `>>`, `>&2` and `2>&1` do not match.
  /(?<![<>])(?:\d|&)?>\|?(?![>&])\s*(?!\/dev\/null(?![\w/.-]))\S/,
  /^git\s+push\b/,
  /^git\s+(reset\s+--hard|clean)\b/,
  new RegExp(
    `^curl\\b.*(\\s-(?![A-Za-z]*X)[A-Za-z]*[dFT]\\b|\\s-[A-Za-z]*X\\s*${METHOD}\\b|\\s--(request|method)[=\\s]\\s*${METHOD}\\b|\\s--(data(-\\w+)?|form(-string)?|json|upload-file)\\b)`,
  ),
  new RegExp(
    `^wget\\b.*(\\s--(post-data|post-file|body-data|body-file)\\b|\\s--method[=\\s]\\s*${METHOD}\\b)`,
  ),
  /^(ssh|scp|sftp|rsync)\b/,
  /^(npm|pnpm|yarn)\s+publish\b/,
  /^(cargo|gem|twine)\s+(publish|push|upload)\b/,
  /^docker\b/,
  /^systemctl\b/,
  /^(chmod|chown|chgrp)\b/,
  /^(mkfs(\.\w+)?|dd|shutdown|reboot|halt|poweroff|kill(all)?|pkill)\b/,
  /^(rmdir|unlink|shred|truncate)\b/,
  /^sed\b.*\s-[A-Za-z]*i/,
  /^tee\b(?!.*\s-[A-Za-z]*a)/,
  // Windows shells.
  /^(del|erase|rd|move|format|taskkill)\b/i,
  /^(Remove-Item|Move-Item|Set-Content|Out-File|Stop-Process)\b/i,
];

const PLACEHOLDER = '"_"';

/** Replace quoted strings with a placeholder so `echo "a > b"` is not seen as a redirection. */
function maskQuoted(command: string): { masked: string; quoted: string[] } {
  const quoted: string[] = [];
  const masked = command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (match) => {
    quoted.push(match);
    return PLACEHOLDER;
  });
  return { masked, quoted };
}

function maskQuotes(command: string): string {
  return maskQuoted(command).masked;
}

const countPlaceholders = (text: string) => text.split(PLACEHOLDER).length - 1;

const PREFIX_WORDS = new Set([
  'env',
  'nohup',
  'time',
  'command',
  'builtin',
  'nice',
  'exec',
  'stdbuf',
]);

/** Remove leading `env VAR=val`, `nohup`, `time` ... (and their options) and the program's directory part. */
function stripPrefixes(segment: string): string {
  let rest = segment.trim();
  let stripped = false;
  for (let i = 0; i < 20 && rest; i++) {
    const match = /^(\S+)(?:\s+|$)/.exec(rest);
    const word = match?.[1];
    if (!match || !word) break;
    const isPrefix =
      PREFIX_WORDS.has(word.toLowerCase()) ||
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ||
      (stripped && /^-[\w-]+$/.test(word));
    if (!isPrefix) break;
    rest = rest.slice(match[0].length);
    stripped = true;
  }
  return rest.replace(/^["']?(?:[^\s"']*[\\/])+(?=[^\s"'\\/]+)/, '');
}

function matchesDestructive(text: string): boolean {
  const masked = maskQuotes(text);
  return DESTRUCTIVE_EXEC.some((re) => re.test(masked));
}

/** Shells that run a command string: `sh -c '...'`, `cmd /c ...`, `pwsh -Command ...`. */
const SHELL_WRAPPER =
  /^(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|cmd)(?:\.exe)?(?=\s|$)(.*)$/is;
const SHELL_COMMAND_FLAG = /(?:^|\s)(?:-[a-z]*c[a-z]*|\/[ck])(?=\s|$)/i;
const POWERSHELL_ENCODED = /(?:^|\s)-e(?:nc\w*)?(?=\s|$)/i;
const XARGS = /\bxargs\b(.*)$/s;
const XARGS_OPTION_WITH_VALUE = /^-[IinPLsEdaJ]$/;
const XARGS_DESTRUCTIVE = /\b(rm|mv|chmod|chown|kill)\b/;

/**
 * The command text that follows `rest`'s start, with the quoted strings put back. `index` is the position of
 * `rest`'s first quoted-string placeholder in `quoted`. A single quoted argument loses its outer quotes. Returns
 * `undefined` when there is nothing to run or it cannot be known (empty, or a bare `$variable`).
 */
function commandText(
  rest: string,
  quoted: string[],
  index: number,
): string | undefined {
  const text = rest.trim();
  if (!text) return undefined;
  if (text.startsWith(PLACEHOLDER)) {
    const first = quoted[index];
    if (first === undefined) return undefined;
    const inner = first.slice(1, -1);
    return first.startsWith('"') ? inner.replace(/\\(["\\$`])/g, '$1') : inner;
  }
  if (/^\$/.test(text)) return undefined;
  let next = index;
  let missing = false;
  const restored = text.replace(PLACEHOLDER, () => {
    const value = quoted[next++];
    if (value === undefined) missing = true;
    return value ?? '';
  });
  return missing ? undefined : restored;
}

/** `sh -c '...'`, `eval '...'`, `xargs ...`: the wrapped command text is itself checked. */
function wrapsDestructive(
  segment: string,
  quoted: string[],
  index: number,
): boolean {
  const stripped = stripPrefixes(segment);
  // Quoted strings consumed by the stripped prefixes (for example `A="x" sh -c ...`) shift the index.
  const base = index + countPlaceholders(segment) - countPlaceholders(stripped);
  const indexAt = (offset: number) =>
    base + countPlaceholders(stripped.slice(0, offset));
  const shell = SHELL_WRAPPER.exec(stripped);
  if (shell) {
    const args = shell[2] ?? '';
    const start = stripped.length - args.length;
    if (
      /^(pwsh|powershell)$/i.test(shell[1] ?? '') &&
      POWERSHELL_ENCODED.test(args)
    )
      return true;
    const flag = SHELL_COMMAND_FLAG.exec(args);
    if (flag) {
      const offset = start + flag.index + flag[0].length;
      const command = commandText(
        stripped.slice(offset),
        quoted,
        indexAt(offset),
      );
      return command === undefined || isDestructiveCommand(command);
    }
  }
  const evaluated = /^eval(?=\s|$)/.exec(stripped);
  if (evaluated) {
    const offset = evaluated[0].length;
    if (!stripped.slice(offset).trim()) return false;
    const command = commandText(
      stripped.slice(offset),
      quoted,
      indexAt(offset),
    );
    return command === undefined || isDestructiveCommand(command);
  }
  const xargs = XARGS.exec(stripped);
  if (xargs) {
    const offset = xargs.index + 'xargs'.length;
    const tail = xargs[1] ?? '';
    if (XARGS_DESTRUCTIVE.test(tail)) return true;
    // Skip xargs's own options (and their values) to reach the command it runs.
    const tokens = /\S+/g;
    let cut = 0;
    let skipValue = false;
    for (let token = tokens.exec(tail); token; token = tokens.exec(tail)) {
      if (skipValue) skipValue = false;
      else if (XARGS_OPTION_WITH_VALUE.test(token[0])) skipValue = true;
      else if (!token[0].startsWith('-')) break;
      cut = tokens.lastIndex;
    }
    const command = tail.slice(cut);
    if (!command.trim()) return false;
    const text = commandText(command, quoted, indexAt(offset + cut));
    return text === undefined || isDestructiveCommand(text);
  }
  return false;
}

export function isDestructiveCommand(command: string): boolean {
  const whole = command.trim();
  if (!whole) return false;
  // `$(...)` and backticks run even inside double quotes, so check their contents on the raw text.
  for (const sub of whole.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    if (isDestructiveCommand(sub[1] ?? sub[2] ?? '')) return true;
  }
  const { masked, quoted } = maskQuoted(whole);
  if (matchesDestructive(masked) || matchesDestructive(stripPrefixes(masked)))
    return true;
  let used = 0;
  return masked.split(/[;&|\n`(){}]+/).some((segment) => {
    const index = used;
    used += countPlaceholders(segment);
    const trimmed = segment.trim();
    return (
      trimmed !== '' &&
      (matchesDestructive(trimmed) ||
        matchesDestructive(stripPrefixes(trimmed)) ||
        wrapsDestructive(
          trimmed,
          quoted,
          index + countPlaceholders(segment.slice(0, segment.indexOf(trimmed))),
        ))
    );
  });
}

const ENTER_KEY =
  /^(?:(?:ctrl|control|meta|cmd|command|shift|alt|option)\+)*(enter|numpadenter|return)$/i;
const ACTIONABLE_ROLE = /^(button|link|menuitem)$/i;

function describe(element: ElementIdentity): string {
  return `${element.role} "${element.name}"`;
}

function sensitiveControl(
  latest: ElementIdentity[] | undefined,
): ElementIdentity | undefined {
  return latest?.find(
    (e) => ACTIONABLE_ROLE.test(e.role) && SENSITIVE_ACTION.test(e.name),
  );
}

function baseLevel(
  input: ClassifyInput,
  mode: ApprovalMode,
): { level: ActionLevel; reason: string } {
  const { tool, args, element, focus, latestElements, mcp } = input;
  switch (tool) {
    case 'computer_exec':
      return isDestructiveCommand(String(args.command ?? ''))
        ? { level: 'sensitive', reason: 'destructive shell command' }
        : { level: 'write', reason: 'shell command' };
    case 'computer_files_write':
      return { level: 'write', reason: 'writes a file' };
    case 'create_space_page':
      return { level: 'write', reason: 'creates a page' };
    case 'edit_space_page':
      return { level: 'write', reason: 'edits a page' };
    case 'computer_click':
    case 'computer_select':
      if (!element) return { level: 'sensitive', reason: 'unknown element' };
      if (SENSITIVE_ACTION.test(element.name))
        return { level: 'sensitive', reason: `sensitive ${describe(element)}` };
      return { level: 'none', reason: 'ordinary page interaction' };
    case 'computer_type': {
      if (args.submit !== true)
        return { level: 'none', reason: 'typing without submitting' };
      if (!element) return { level: 'sensitive', reason: 'unknown element' };
      if (SENSITIVE_ACTION.test(element.name))
        return {
          level: 'sensitive',
          reason: `types and submits in sensitive ${describe(element)}`,
        };
      const control = sensitiveControl(latestElements);
      if (control)
        return {
          level: 'sensitive',
          reason: `types and submits while sensitive ${describe(control)} is on the page`,
        };
      return { level: 'none', reason: 'typing and submitting a plain field' };
    }
    case 'computer_key': {
      if (!ENTER_KEY.test(String(args.key ?? '').trim()))
        return { level: 'none', reason: 'ordinary key press' };
      if (mode === 'writes')
        return { level: 'write', reason: 'Enter key can submit a form' };
      if (!focus)
        return { level: 'sensitive', reason: 'Enter key with unknown focus' };
      if (SENSITIVE_ACTION.test(focus.name))
        return {
          level: 'sensitive',
          reason: `Enter key in sensitive ${describe(focus)}`,
        };
      const control = sensitiveControl(latestElements);
      if (control)
        return {
          level: 'sensitive',
          reason: `Enter key while sensitive ${describe(control)} is on the page`,
        };
      return { level: 'none', reason: 'Enter key in a plain field' };
    }
    default:
  }
  if (tool.startsWith('mcp__')) {
    // Unknown annotations (e.g. the connector is reconnecting) fail closed.
    if (!mcp)
      return { level: 'sensitive', reason: 'connector tool is unknown' };
    const meta = mcp;
    if (meta.destructive)
      return { level: 'sensitive', reason: 'connector tool is destructive' };
    if (!meta.readOnly)
      return { level: 'write', reason: 'connector tool can change data' };
    return { level: 'none', reason: 'read-only connector tool' };
  }
  return { level: 'none', reason: 'not a gated action' };
}

export function classify(
  input: ClassifyInput,
  mode: ApprovalMode,
): Classification {
  const override = input.mcp?.override;
  if (override === 'deny')
    return { level: 'sensitive', gated: true, reason: 'denied' };
  const base = baseLevel(input, mode);
  // A per-tool override is more specific than the Dot's mode, so `ask` still asks in mode `off`.
  if (override === 'ask')
    return base.level === 'none'
      ? { level: 'write', gated: true, reason: 'connector tool set to ask' }
      : { ...base, gated: true };
  if (override === 'allow' || mode === 'off') return { ...base, gated: false };
  const gated =
    base.level === 'sensitive' || (mode === 'writes' && base.level === 'write');
  return { ...base, gated };
}

export function normalizeUrl(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}`;
  } catch {
    return (url ?? '').trim().toLowerCase();
  }
}

export function normalizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface Intent {
  tool: string;
  url?: string;
  element?: ElementIdentity;
  args: Record<string, unknown>;
}

const INTENT_ARG_KEYS = ['text', 'submit', 'key', 'option'];
const REF_TOOLS = new Set([
  'computer_click',
  'computer_type',
  'computer_select',
  'computer_key',
]);

/** For computer ref actions keep only what the owner approves, never `ref` or `snapshotId`; other tools unchanged. */
export function pickIntentArgs(
  tool: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (!REF_TOOLS.has(tool)) return args;
  const out: Record<string, unknown> = {};
  for (const key of INTENT_ARG_KEYS)
    if (args[key] !== undefined) out[key] = args[key];
  return out;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** sha256 of the canonical intent. `args` passes through `pickIntentArgs` again, so full computer args hash the same as picked ones. */
export function intentHash(intent: Intent): string {
  const canonical = canonicalize({
    tool: intent.tool,
    url: intent.url === undefined ? undefined : normalizeUrl(intent.url),
    element: intent.element && {
      role: intent.element.role,
      name: normalizeName(intent.element.name),
    },
    args: pickIntentArgs(intent.tool, intent.args),
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const SECRET_KEY = /authorization|key|token|secret|password|cookie/i;
const MAX_REDACTED = 2000;

function mask(value: unknown, depth = 0): unknown {
  if (depth > 20) return '[truncated]';
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value))
      out[key] = SECRET_KEY.test(key) ? '[hidden]' : mask(v, depth + 1);
    return out;
  }
  return value;
}

function clipText(text: string): string {
  const chars = Array.from(text);
  return chars.length > MAX_REDACTED
    ? `${chars.slice(0, MAX_REDACTED - 1).join('')}…`
    : text;
}

/** The "Exact action" text shown to the owner: what will happen, secrets masked, at most 2000 characters. */
export function redactArgs(
  tool: string,
  args: Record<string, unknown>,
  element?: ElementIdentity,
  focus?: ElementIdentity,
): string {
  const target = element ? describe(element) : 'unknown element';
  // An unknown target might be a password field, so what is typed or chosen there is hidden too.
  const hidden = !element || SENSITIVE.test(element.name);
  let text: string;
  switch (tool) {
    case 'computer_exec': {
      const timeout =
        typeof args.timeoutMs === 'number'
          ? ` (timeout ${args.timeoutMs} ms)`
          : '';
      text = `${String(args.command ?? '')}${timeout}`;
      break;
    }
    case 'computer_type':
      text = `type "${hidden ? '[hidden]' : String(args.text ?? '')}" into ${target}${
        args.submit === true ? ' and press Enter' : ''
      }`;
      break;
    case 'computer_click':
      text = `click ${target}`;
      break;
    case 'computer_select':
      text = `choose "${hidden ? '[hidden]' : String(args.option ?? '')}" in ${target}`;
      break;
    case 'computer_key':
      text = `press ${String(args.key ?? '')}${
        focus ? ` in ${describe(focus)}` : ' (focus unknown)'
      }`;
      break;
    default:
      text = `${tool} ${JSON.stringify(mask(args))}`;
  }
  return clipText(text);
}
