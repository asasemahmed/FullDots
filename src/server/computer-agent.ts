// How an agent uses its computer's browser. The computer itself only offers primitives (navigate,
// snapshot, click, type, key, scroll). This layer turns them into something a model can drive in few
// steps: every browser action returns the fresh page, a refused action is recovered instead of
// reported, dropdowns have a tool of their own, and nothing huge or binary reaches the model.
import { z } from 'zod';
import type { ComputerAction } from '../shared/computer-types.js';
import { ComputerConflictError } from './computer-conflict.js';
import type {
  ComputerService,
  ComputerSessionCall,
} from './computer-service.js';

/** How many elements a result describes. The snapshot tool itself returns up to 200. */
export const PAGE_ELEMENT_LIMIT = 150;
const NAME_LIMIT = 80;
const VALUE_LIMIT = 80;
/** Snapshots remembered, so refs from a slightly older one can still be matched to the current page. */
const KNOWN_SNAPSHOTS = 64;
const OPTION_LIST_LIMIT = 40;
/** The longest option text typed key by key when a dropdown offers nothing to click. */
const TYPE_AHEAD_LIMIT = 16;
/** How many times a refused action is retried against a fresh snapshot before giving up. */
const MAX_REFRESHES = 2;

export const selectInputSchema = z
  .object({
    ref: z.string().min(1).max(100),
    snapshotId: z.number().int().nonnegative(),
    option: z.string().trim().min(1).max(200),
  })
  .strict();

export type AgentAction = Exclude<ComputerAction, `human_${string}`> | 'select';
type PageAction = 'navigate' | 'click' | 'type' | 'key' | 'scroll';

export interface PageElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
}
export interface PageView {
  snapshotId: number;
  url: string;
  title: string;
  elements: PageElement[];
  /** True when the page has more elements than are listed. Scroll or use computer_snapshot. */
  truncated?: true;
  omitted?: number;
  /** A human verification step the page is showing. Tell the user; do not try to solve it. */
  challenge?: { kind: string; reason: string; requestId?: string };
}

const elementSchema = z.object({
  ref: z.string(),
  role: z.string().catch(''),
  name: z.string().catch(''),
  value: z.string().optional().catch(undefined),
  disabled: z.boolean().optional().catch(undefined),
  checked: z.boolean().optional().catch(undefined),
});
const snapshotSchema = z.object({
  snapshotId: z.number(),
  url: z.string().catch(''),
  title: z.string().catch(''),
  elements: z.array(z.unknown()).catch([]),
  truncated: z.boolean().optional().catch(undefined),
  challenge: z.unknown().optional(),
});
interface Snapshot {
  snapshotId: number;
  url: string;
  title: string;
  elements: z.infer<typeof elementSchema>[];
  truncated: boolean;
  challenge?: { kind: string; reason: string; requestId?: string };
}
/** What the page called an element: the role and accessible name, never a ref. */
export interface ElementIdentity {
  role: string;
  name: string;
}
type Identity = ElementIdentity;

/** What the approval gate needs to know about the page. Implemented by {@link AgentComputer}. */
export interface GateComputer {
  /** Strict: only snapshots this instance took in this turn. */
  identityInTurn(ref: string, snapshotId: number): ElementIdentity | undefined;
  latestUrl(): string | undefined;
  latestElements(): ElementIdentity[];
  presumedFocus(): ElementIdentity | undefined;
}

export function parseSnapshot(raw: unknown): Snapshot {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(
      'The computer returned a page description that could not be read.',
    );
  const { challenge } = parsed.data;
  const found =
    challenge && typeof challenge === 'object'
      ? (challenge as Record<string, unknown>)
      : undefined;
  return {
    snapshotId: parsed.data.snapshotId,
    url: parsed.data.url,
    title: parsed.data.title,
    elements: parsed.data.elements.flatMap((element) => {
      const item = elementSchema.safeParse(element);
      return item.success ? [item.data] : [];
    }),
    truncated: parsed.data.truncated === true,
    ...(found && typeof found.reason === 'string'
      ? {
          challenge: {
            kind: typeof found.kind === 'string' ? found.kind : 'challenge',
            reason: found.reason,
            ...(typeof found.requestId === 'string'
              ? { requestId: found.requestId }
              : {}),
          },
        }
      : {}),
  };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : flat;
}
export const SENSITIVE =
  /pass(word|code)|secret|\bpin\b|cvv|card number|one[- ]time|\botp\b/i;
function compact(element: Snapshot['elements'][number]): PageElement {
  const out: PageElement = {
    ref: element.ref,
    role: element.role,
    name: clip(element.name, NAME_LIMIT),
  };
  if (element.value)
    out.value = SENSITIVE.test(element.name)
      ? '[hidden]'
      : clip(element.value, VALUE_LIMIT);
  if (element.checked !== undefined) out.checked = element.checked;
  if (element.disabled) out.disabled = true;
  return out;
}
export function toPage(snapshot: Snapshot): PageView {
  const elements = snapshot.elements.slice(0, PAGE_ELEMENT_LIMIT).map(compact);
  const omitted = snapshot.elements.length - elements.length;
  return {
    snapshotId: snapshot.snapshotId,
    url: snapshot.url,
    title: clip(snapshot.title, 200),
    elements,
    ...(omitted > 0 || snapshot.truncated ? { truncated: true as const } : {}),
    ...(omitted > 0 ? { omitted } : {}),
    ...(snapshot.challenge ? { challenge: snapshot.challenge } : {}),
  };
}

const normalize = (text: string) =>
  text.replace(/\s+/g, ' ').trim().toLowerCase();
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : { result: value };

const OPTION_ROLES = new Set([
  'option',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
]);
const EDITABLE_ROLES = new Set(['combobox', 'textbox', 'searchbox']);
const KEYBOARD_ROLES = new Set(['combobox', 'listbox']);

type OptionSearch =
  | {
      kind: 'match';
      element: Snapshot['elements'][number];
      names: string[];
    }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'none'; names: string[] };

/** The option the person asked for among what the page offers, never guessing between several. */
function findOption(
  elements: Snapshot['elements'],
  want: string,
  targetRef: string,
): OptionSearch {
  const options = elements.filter(
    (element) =>
      OPTION_ROLES.has(element.role) &&
      element.ref !== targetRef &&
      !element.disabled &&
      normalize(element.name),
  );
  const names = options.map((element) => clip(element.name, NAME_LIMIT));
  const exact = options.filter((element) => normalize(element.name) === want);
  if (exact[0]) return { kind: 'match', element: exact[0], names };
  for (const test of [
    (name: string) => name.startsWith(want),
    (name: string) => name.includes(want),
    (name: string) => name.length >= 3 && want.includes(name),
  ]) {
    const found = options.filter((element) => test(normalize(element.name)));
    if (found.length === 1 && found[0])
      return { kind: 'match', element: found[0], names };
    if (found.length > 1)
      return {
        kind: 'ambiguous',
        names: found.map((element) => clip(element.name, NAME_LIMIT)),
      };
  }
  return { kind: 'none', names };
}

/** Whether the control now shows the option: true, false, or null when it is no longer listed. */
function shows(snapshot: Snapshot, ref: string, want: string): boolean | null {
  const element = snapshot.elements.find((item) => item.ref === ref);
  if (!element) return null;
  const value = normalize(element.value ?? '');
  return (
    normalize(`${element.value ?? ''} ${element.name}`).includes(want) ||
    (value.length >= 3 && want.includes(value))
  );
}

/**
 * Replaces binary payloads, which are worth thousands of tokens and mean nothing to a model, with a
 * short note. A screenshot is the usual one; any long base64 string or data URL is treated the same.
 */
export function withoutBinary(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return stringWithoutBinary(value);
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value))
    return value.map((item) => withoutBinary(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      typeof item === 'string' &&
      item.length > 200 &&
      /^(base64|image|screenshot|data)$/i.test(key) &&
      /^[A-Za-z0-9+/=_-]+$/.test(item.slice(0, 200))
        ? omitted(item.length)
        : withoutBinary(item, depth + 1),
    ]),
  );
}
const omitted = (length: number) =>
  `[${length} characters of binary data omitted]`;
function stringWithoutBinary(text: string): string {
  if (text.length >= 200 && /^data:[^,]{0,100};base64,/i.test(text))
    return omitted(text.length);
  if (text.length < 2000 || !/^[A-Za-z0-9+/=_\-\s]+$/.test(text)) return text;
  let spaces = 0;
  for (let index = 0; index < text.length; index++)
    if (/\s/.test(text[index] ?? '')) spaces++;
  return spaces / text.length < 0.05 ? omitted(text.length) : text;
}

export interface AgentComputerOptions {
  /** How long to let a page settle after an action before reading it. Zero skips the wait. */
  settleMs?: number;
}

export class AgentComputer implements GateComputer {
  private readonly known = new Map<number, Map<string, Identity>>();
  private latest?: Snapshot;
  /** Inferred, not read from the page: the element the agent last clicked or typed into. */
  private focus?: Identity;
  private readonly settleMs: number;

  constructor(
    private readonly service: ComputerService,
    private readonly dotId: string,
    private readonly signal: AbortSignal,
    options: AgentComputerOptions = {},
  ) {
    this.settleMs = options.settleMs ?? 250;
  }

  async act(action: AgentAction, input: unknown): Promise<unknown> {
    return withoutBinary(await this.dispatch(action, input));
  }

  private dispatch(action: AgentAction, input: unknown): Promise<unknown> {
    switch (action) {
      case 'navigate':
      case 'click':
      case 'type':
      case 'key':
      case 'scroll': {
        const parsed: Record<string, unknown> =
          this.service.inputs[action].parse(input);
        return this.session(action, (call) =>
          this.perform(call, action, parsed, true),
        );
      }
      case 'select': {
        const parsed = selectInputSchema.parse(input);
        return this.session('select', (call) => this.select(call, parsed));
      }
      case 'snapshot':
        this.service.inputs.snapshot.parse(input);
        return this.session('snapshot', async (call) => {
          const snapshot = await this.takeSnapshot(call);
          return {
            snapshotId: snapshot.snapshotId,
            url: snapshot.url,
            title: snapshot.title,
            elements: snapshot.elements,
            ...(snapshot.truncated ? { truncated: true } : {}),
            ...(snapshot.challenge ? { challenge: snapshot.challenge } : {}),
          };
        });
      case 'screenshot':
        this.service.inputs.screenshot.parse(input);
        return this.session('screenshot', async (call) => {
          const shot = record(await call('screenshot'));
          const url = typeof shot.url === 'string' ? shot.url : undefined;
          return {
            action: 'screenshot',
            ...(url ? { url } : {}),
            ...(url && this.latest?.url === url && this.latest.title
              ? { title: clip(this.latest.title, 200) }
              : {}),
            ...(typeof shot.width === 'number' ? { width: shot.width } : {}),
            ...(typeof shot.height === 'number' ? { height: shot.height } : {}),
            ...(typeof shot.capturedAt === 'string'
              ? { capturedAt: shot.capturedAt }
              : {}),
            note: 'The image is shown to the user in the live computer view and is not included in this result. Use computer_read for the page text or computer_snapshot for its controls.',
          };
        });
      default:
        return this.service.action(
          this.dotId,
          action,
          input,
          'agent',
          this.signal,
        );
    }
  }

  private session<T>(
    label: ComputerAction | 'select',
    body: (call: ComputerSessionCall) => Promise<T>,
  ) {
    return this.service.session(this.dotId, label, 'agent', this.signal, body);
  }

  private pause(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.signal.addEventListener('abort', done, { once: true });
    });
  }

  private remember(snapshot: Snapshot) {
    this.latest = snapshot;
    // Oldest first, by when they were taken: a restarted computer numbers its snapshots from the start.
    this.known.delete(snapshot.snapshotId);
    this.known.set(
      snapshot.snapshotId,
      new Map(
        snapshot.elements.map((element) => [
          element.ref,
          { role: element.role, name: element.name },
        ]),
      ),
    );
    while (this.known.size > KNOWN_SNAPSHOTS) {
      const oldest = this.known.keys().next();
      if (oldest.done) break;
      this.known.delete(oldest.value);
    }
  }

  private async takeSnapshot(call: ComputerSessionCall): Promise<Snapshot> {
    const snapshot = parseSnapshot(await call('snapshot', {}));
    this.remember(snapshot);
    return snapshot;
  }

  /** The page after an action. The action already happened, so a failure here is reported, not thrown. */
  private async pageAfter(
    call: ComputerSessionCall,
    action: PageAction,
  ): Promise<{ page: PageView } | { pageError: string }> {
    try {
      await this.pause(
        action === 'navigate' ? this.settleMs * 2 : this.settleMs,
      );
      const read = async () => {
        try {
          return await this.takeSnapshot(call);
        } catch (error) {
          if (error instanceof ComputerConflictError) throw error;
          this.signal.throwIfAborted();
          await this.pause(this.settleMs * 4);
          return this.takeSnapshot(call);
        }
      };
      let snapshot = await read();
      // A page that is still loading has nothing to act on yet.
      if (!snapshot.elements.length && this.settleMs > 0) {
        await this.pause(this.settleMs * 4);
        snapshot = await read();
      }
      return { page: toPage(snapshot) };
    } catch (error) {
      this.signal.throwIfAborted();
      return {
        pageError: `The action was performed, but the page could not be read afterwards (${
          error instanceof Error ? error.message : 'unknown error'
        }). Call computer_snapshot to see it.`,
      };
    }
  }

  /** The element a ref meant in a snapshot this instance took, or undefined: no fallback to the latest page. */
  identityInTurn(ref: string, snapshotId: number): ElementIdentity | undefined {
    return this.known.get(snapshotId)?.get(ref);
  }

  /** The address of the latest page the agent saw. */
  latestUrl(): string | undefined {
    return this.latest?.url;
  }

  /** What the latest page offers, by role and name. */
  latestElements(): ElementIdentity[] {
    return (this.latest?.elements ?? []).map((element) => ({
      role: element.role,
      name: element.name,
    }));
  }

  /**
   * The element that probably has keyboard focus. Inferred, not read from the page: the last element
   * the agent clicked or typed into, cleared by navigation.
   */
  presumedFocus(): ElementIdentity | undefined {
    return this.focus;
  }

  /** What the page called this element when the agent last saw it. */
  private identity(ref: string, snapshotId: number): Identity | undefined {
    return (
      this.known.get(snapshotId)?.get(ref) ??
      (this.latest
        ? this.known.get(this.latest.snapshotId)?.get(ref)
        : undefined)
    );
  }

  /**
   * The ref of the element in a snapshot that is provably the one the agent meant: the same ref with
   * the same role and name, or else the only element with that role and (non-empty) name. Refs are
   * renumbered between snapshots, so matching by identity is what keeps batched actions working.
   */
  private locate(before: Identity, ref: string, snapshotId: number) {
    const elements = this.known.get(snapshotId);
    if (!elements) return undefined;
    const now = elements.get(ref);
    if (now && same(before, now)) return ref;
    if (!normalize(before.name)) return undefined;
    const matches = [...elements].filter(([, identity]) =>
      same(before, identity),
    );
    return matches.length === 1 ? matches[0][0] : undefined;
  }

  /**
   * An agent that sends several actions in one reply uses the same snapshot id for all of them, but
   * each action refreshes the page and moves the id on. When the latest snapshot provably still has
   * that element, the action is addressed to it in the latest snapshot.
   */
  private adopt(input: Record<string, unknown>): Record<string, unknown> {
    const latest = this.latest?.snapshotId;
    const asked = input.snapshotId;
    if (latest === undefined || typeof asked !== 'number' || asked === latest)
      return input;
    const ref = String(input.ref);
    const before = this.known.get(asked)?.get(ref);
    const located = before && this.locate(before, ref, latest);
    return located ? { ...input, ref: located, snapshotId: latest } : input;
  }

  /**
   * One browser action, then the fresh page. A refusal from the computer is recovered here where the
   * recovery is safe, and turned into a clear instruction where it is not. The owner's control is never
   * worked around.
   */
  private async perform(
    call: ComputerSessionCall,
    action: PageAction,
    input: Record<string, unknown>,
    withPage: boolean,
  ): Promise<Record<string, unknown>> {
    const usesRef = action === 'click' || action === 'type';
    const asked = typeof input.snapshotId === 'number' ? input.snapshotId : -1;
    // Never act blind: a ref from a snapshot this instance did not take may point at another element,
    // and a ref that snapshot does not list was never classified by the approval gate.
    if (usesRef) {
      const knownSnapshot = this.known.get(asked);
      const refused = !knownSnapshot
        ? 'that snapshotId is not from this turn, so the ref may now point at a different element.'
        : !knownSnapshot.has(String(input.ref))
          ? 'that ref is not on the page you saw in this turn.'
          : undefined;
      if (refused) {
        const fresh = await this.takeSnapshot(call);
        return {
          error: `Nothing was clicked or typed: ${refused} The page below is current; find the element and repeat the action with its ref and snapshotId.`,
          retry: true,
          page: toPage(fresh),
        };
      }
    }
    let current = usesRef ? this.adopt(input) : input;
    let refreshes = 0;
    for (;;) {
      try {
        const result = await call(action, current);
        const element = usesRef
          ? this.identity(String(current.ref), Number(current.snapshotId))
          : undefined;
        if (usesRef) this.focus = element;
        else if (action === 'navigate') this.focus = undefined;
        return {
          ...record(result),
          ...(element
            ? {
                element: {
                  role: element.role,
                  name: clip(element.name, NAME_LIMIT),
                },
              }
            : {}),
          ...(withPage ? await this.pageAfter(call, action) : {}),
        };
      } catch (error) {
        if (
          !(error instanceof ComputerConflictError) ||
          (error.kind !== 'snapshot_required' && error.kind !== 'stale_ref') ||
          (error.kind === 'stale_ref' && !usesRef)
        )
          throw error;
        const before = usesRef
          ? this.known.get(asked)?.get(String(input.ref))
          : undefined;
        const fresh = await this.takeSnapshot(call);
        if (error.kind === 'snapshot_required') {
          // Control was handed back or the computer restarted. Navigation, keys and scrolling do not
          // depend on old refs, so they simply go again. A click or typing aimed at the old page might
          // now be wrong, so the agent decides again from the fresh page.
          if (!usesRef) {
            if (refreshes++ === 0) continue;
            throw new Error(
              'The computer still asks for a refresh after computer_snapshot. Do not keep retrying; tell the user what is blocking you.',
              { cause: error },
            );
          }
          return {
            error: `Nothing was ${action === 'click' ? 'clicked' : 'typed'}: the browser had to be refreshed first because control was handed back or the computer restarted. Look at the page below and, if the action is still needed, repeat it with its ref and snapshotId.`,
            retry: true,
            page: toPage(fresh),
          };
        }
        const located =
          before && this.locate(before, String(input.ref), fresh.snapshotId);
        if (located && refreshes < MAX_REFRESHES) {
          refreshes++;
          current = { ...current, ref: located, snapshotId: fresh.snapshotId };
          continue;
        }
        return {
          error: `Nothing was ${action === 'click' ? 'clicked' : 'typed'}: that element reference was out of date. The page below is current; find the element in it and repeat the action with its ref and snapshotId.`,
          retry: true,
          page: toPage(fresh),
        };
      }
    }
  }

  /**
   * Chooses an option in a dropdown. The computer has no select call, so this is built from clicks,
   * typing and keys, and every step that could act on the page twice is avoided: once an option has
   * been clicked, nothing else is pressed.
   */
  private async select(
    call: ComputerSessionCall,
    input: z.infer<typeof selectInputSchema>,
  ): Promise<Record<string, unknown>> {
    const want = normalize(input.option);
    const base: Record<string, unknown> = {
      action: 'select',
      ref: input.ref,
      option: input.option,
    };
    const opened = await this.perform(
      call,
      'click',
      { ref: input.ref, snapshotId: input.snapshotId },
      false,
    );
    if ('error' in opened) return { ...opened, ...base };
    if (opened.element) base.element = opened.element;

    let snapshot = await this.afterOpening(call);
    const role = snapshot.elements.find((item) => item.ref === input.ref)?.role;
    const dropdown = this.identityInTurn(input.ref, input.snapshotId);
    const finish = async (method: string, chosen?: string) => {
      // Clicking an option moved the presumed focus onto it; the dropdown is what the agent worked on.
      this.focus = dropdown;
      await this.pause(this.settleMs);
      const after = await this.takeSnapshot(call);
      const selected = shows(after, input.ref, want);
      return {
        ...base,
        method,
        ...(chosen ? { chosen: clip(chosen, NAME_LIMIT) } : {}),
        selected,
        ...(selected === true
          ? {}
          : {
              note: 'The control does not visibly show that option yet. Check the page; if a list is still open, close it with computer_key Escape.',
            }),
        page: toPage(after),
      };
    };
    const fail = (message: string, names: string[]) => ({
      ...base,
      selected: false,
      error: message,
      ...(names.length ? { options: names.slice(0, OPTION_LIST_LIMIT) } : {}),
      page: toPage(snapshot),
    });
    const ambiguous = (names: string[]) =>
      fail(
        `Several options match "${input.option}": ${names.slice(0, 8).join(', ')}. Call computer_select again with the full text of one of them.`,
        names,
      );
    const clickOption = async (
      element: Snapshot['elements'][number],
      method: string,
    ) => {
      try {
        const clicked = await this.perform(
          call,
          'click',
          { ref: element.ref, snapshotId: snapshot.snapshotId },
          false,
        );
        if ('error' in clicked) return { ...clicked, ...base };
        return await finish(method, element.name);
      } catch (error) {
        if (isOwnerControl(error)) throw error;
        return undefined; // Not clickable here; try the next way.
      }
    };

    // 1. The options are on the page: click the one that matches.
    const found = findOption(snapshot.elements, want, input.ref);
    if (found.kind === 'ambiguous') return ambiguous(found.names);
    if (found.kind === 'match') {
      const done = await clickOption(found.element, 'option');
      if (done) return done;
    }

    // 2. A field that takes text: type the option and pick it from what appears.
    let typed = false;
    if (role && EDITABLE_ROLES.has(role)) {
      try {
        const result = await this.perform(
          call,
          'type',
          {
            ref: input.ref,
            snapshotId: snapshot.snapshotId,
            text: input.option,
          },
          false,
        );
        if ('error' in result) return { ...result, ...base };
        typed = true;
      } catch (error) {
        if (isOwnerControl(error)) throw error;
      }
      if (typed) {
        await this.pause(this.settleMs);
        snapshot = await this.takeSnapshot(call);
        const again = findOption(snapshot.elements, want, input.ref);
        if (again.kind === 'ambiguous') return ambiguous(again.names);
        if (again.kind === 'match') {
          const done = await clickOption(again.element, 'type');
          if (done) return done;
        }
        // Enter confirms the highlighted suggestion of a combobox. It is only safe when no list is
        // showing: with a list of other options the highlighted one would be wrong, and in a plain
        // text field Enter could submit the form.
        if (role === 'combobox' && !again.names.length) {
          try {
            await call('key', { key: 'Enter' });
            return await finish('type+enter');
          } catch (error) {
            if (isOwnerControl(error)) throw error;
          }
        } else {
          return fail(
            `No option matching "${input.option}" was found after typing it.`,
            again.names,
          );
        }
      }
    }

    // 3. A native select, or a widget that lists nothing: type the text key by key, as a person does
    // to jump to an option, and confirm.
    if (role && KEYBOARD_ROLES.has(role) && !typed) {
      try {
        for (const char of Array.from(input.option).slice(0, TYPE_AHEAD_LIMIT))
          if (char.length === 1)
            await call('key', { key: char === ' ' ? 'Space' : char });
        await call('key', { key: 'Enter' });
        return await finish('keyboard');
      } catch (error) {
        if (isOwnerControl(error)) throw error;
      }
    }

    return fail(
      `No option matching "${input.option}" was found, and this control could not be typed into. Its options are not exposed on the page; try computer_click on what is visible.`,
      found.names,
    );
  }

  /** A freshly opened dropdown needs a moment before its options exist. */
  private async afterOpening(call: ComputerSessionCall): Promise<Snapshot> {
    await this.pause(this.settleMs);
    return this.takeSnapshot(call);
  }
}

function same(a: Identity, b: Identity): boolean {
  return a.role === b.role && normalize(a.name) === normalize(b.name);
}
function isOwnerControl(error: unknown): boolean {
  return (
    error instanceof ComputerConflictError && error.kind === 'owner_control'
  );
}
