import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerPanel } from '../src/client/ComputerPanel';
import { ControlBar } from '../src/client/computer-panel/ControlBar';
import {
  PanelView,
  type PanelActions,
  type PanelViewProps,
} from '../src/client/computer-panel/PanelView';
import { PanelHeader } from '../src/client/computer-panel/PanelHeader';
import { SettingsSheet } from '../src/client/computer-panel/SettingsSheet';
import {
  MORE_OPEN_KEY,
  PAST_LABELS,
  auditLabel,
  currentActivity,
  newestFirst,
  normalizeUrl,
  panelPhase,
  readMorePrefs,
  visibleAudit,
  writeMorePrefs,
} from '../src/client/computer-panel/model';
import type {
  ComputerAudit,
  ComputerStatus,
} from '../src/shared/computer-types';
import type { Dot } from '../src/shared/types';

// The API module reads the session token the moment it loads, and there is no browser here.
vi.hoisted(() => {
  Object.assign(globalThis, {
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
});

const dot: Dot = {
  id: 'dot-1',
  spaceId: 'space',
  spaceIds: ['space'],
  name: 'Dot',
  instructions: '',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 0,
};
const permissions = { enabled: true, browser: true, files: true, shell: true };
const control = (
  holder: 'bot' | 'human' = 'bot',
  transitioning = false,
): NonNullable<ComputerStatus['control']> => ({
  holder,
  requested: false,
  transitioning,
  resumeSnapshotRequired: false,
});
const running = (over: Partial<ComputerStatus> = {}): ComputerStatus => ({
  configured: true,
  state: 'running',
  permissions,
  audit: [],
  control: control(),
  ...over,
});
const entry = (over: Partial<ComputerAudit>): ComputerAudit => ({
  id: String(Math.random()),
  action: 'click',
  actor: 'agent',
  outcome: 'succeeded',
  createdAt: 1_000_000,
  ...over,
});
const actions = (): PanelActions => ({
  refresh: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  enable: vi.fn(),
  take: vi.fn(),
  release: vi.fn(),
  dismissHandoff: vi.fn(),
  navigate: vi.fn(async () => true),
  act: vi.fn(async () => ({})),
  setPermission: vi.fn(),
  retryStream: vi.fn(),
  clickSnapshot: vi.fn(),
  onPhase: vi.fn(),
  onFrameSize: vi.fn(),
});
const view = (over: Partial<PanelViewProps> = {}) =>
  renderToStaticMarkup(
    <PanelView
      dot={dot}
      status={running()}
      loadFailed={false}
      error=""
      onDismissError={() => {}}
      busy={false}
      stream={{ phase: 'connecting' }}
      streamKey={0}
      snapshotError=""
      optimistic={{}}
      notes={{}}
      actions={actions()}
      {...over}
    />,
  );

type Props = Record<string, unknown> & { children?: ReactNode };
/** Finds elements in a tree of host elements, which is all the hook-free components return. */
function findAll(
  node: ReactNode,
  test: (element: ReactElement<Props>) => boolean,
  found: ReactElement<Props>[] = [],
) {
  if (Array.isArray(node))
    for (const child of node) findAll(child, test, found);
  else if (isValidElement<Props>(node)) {
    if (test(node)) found.push(node);
    findAll(node.props.children, test, found);
  }
  return found;
}
const textOf = (node: ReactNode): string =>
  Array.isArray(node)
    ? node.map(textOf).join('')
    : isValidElement<Props>(node)
      ? textOf(node.props.children)
      : typeof node === 'string' || typeof node === 'number'
        ? String(node)
        : '';
/** The opening tag of the first element whose class list contains `name`. */
const tag = (html: string, name: string) =>
  new RegExp(`<[a-z0-9]+ [^>]*class="[^"]*\\b${name}\\b[^"]*"[^>]*>`).exec(
    html,
  )?.[0] ?? '';
/** The panel's visible body: the settings sheet is always in the markup, hidden. */
const body = (html: string) => html.slice(0, html.indexOf('class="cp-sheet"'));
const button = (root: ReactNode, label: string) =>
  findAll(
    root,
    (element) => element.type === 'button' && textOf(element).includes(label),
  )[0];

afterEach(() => vi.unstubAllGlobals());

describe('panel states', () => {
  it('says plainly that no computer is set up and links the guide', () => {
    const html = view({
      status: {
        configured: false,
        state: 'not_configured',
        permissions,
        audit: [],
      },
    });
    expect(body(html)).toContain('No computer is set up');
    expect(body(html)).toContain('Not set up');
    expect(body(html)).toContain('docs/COMPUTERS.md');
    expect(body(html)).not.toContain('cp-more');
    expect(body(html)).not.toContain('Start computer');
  });

  it('offers one big Start button when stopped, and nothing to stop', () => {
    const html = body(view({ status: running({ state: 'stopped' }) }));
    expect(html).toContain('Stopped');
    expect(html).toContain('Start computer');
    expect(html).toContain('cp-btn-large');
    expect(html).not.toContain('Take control</button>');
    expect(html).not.toContain('Stop the computer');
  });

  it('asks to turn access on, rather than starting a computer it may not use', () => {
    const html = body(
      view({
        status: running({
          state: 'stopped',
          permissions: { ...permissions, enabled: false },
        }),
      }),
    );
    expect(html).toContain('Computer access is off');
    expect(html).toContain('Turn on and start');
  });

  it('shows what went wrong and a retry when unavailable', () => {
    const html = body(
      view({
        status: running({ state: 'unavailable', error: 'Supervisor is down.' }),
      }),
    );
    expect(html).toContain('Unavailable');
    expect(html).toContain('Supervisor is down.');
    expect(html).toContain('Try again');
  });

  it('shows a failed first load as unreachable, with the reason once', () => {
    const html = body(
      view({ status: undefined, loadFailed: true, error: 'Failed to fetch' }),
    );
    expect(html).toContain('Can’t reach the computer');
    expect(html.match(/Failed to fetch/g)).toHaveLength(1);
    expect(tag(html, 'cp-icon-btn')).toContain('disabled');
  });

  it('loads without touching the browser', () => {
    const html = renderToStaticMarkup(<ComputerPanel dot={dot} />);
    expect(html).toContain('Loading computer');
  });

  it('shows the live screen first, the Dot in control, and the way to take over', () => {
    const html = body(
      view({ activity: { action: 'click', verb: 'clicking' } }),
    );
    expect(html).toContain('Running');
    expect(html).toContain('Stop the computer');
    expect(html).toContain('computer-screen-live');
    expect(html).toContain('LIVE');
    expect(html).toContain('Dot is clicking…');
    expect(html).toContain('Dot is in control');
    expect(html).toContain('Take control</button>');
    expect(html).not.toContain('Give control back');
    expect(html).toContain('aria-label="Open a web address"');
    expect(html.indexOf('computer-screen-live')).toBeLessThan(
      html.indexOf('Take control'),
    );
  });

  it('shows the owner in control with the way out and a hint', () => {
    const html = body(view({ status: running({ control: control('human') }) }));
    expect(html).toContain('Give control back');
    expect(html).toContain('Click and type directly on the screen.');
    expect(html).toContain('Shift+Esc to stop typing.');
    expect(html).not.toContain('Take control</button>');
    expect(tag(html, 'cp-stage')).toContain('is-human');
    expect(tag(html, 'cp-address')).toBeTruthy();
    expect(html).toMatch(
      /<input[^>]*aria-label="Open a web address"[^>]*disabled/,
    );
  });

  it('waits for the Dot to pause instead of offering the button again', () => {
    const html = body(
      view({ status: running({ control: control('bot', true) }) }),
    );
    expect(html).toContain('Waiting for Dot to pause…');
    expect(html).not.toContain('Take control</button>');
    const taking = body(view({ working: 'take' }));
    expect(taking).toContain('Waiting for Dot to pause…');
  });

  it('explains a missing screen when the browser is off, and keeps files reachable', () => {
    const html = body(
      view({
        status: running({ permissions: { ...permissions, browser: false } }),
      }),
    );
    expect(html).toContain('The browser is turned off');
    expect(html).not.toContain('Take control</button>');
    expect(html).toContain('cp-more');
  });

  it('falls back to the still picture and offers to retry the live view', () => {
    const html = body(
      view({
        stream: {
          phase: 'failed',
          message: 'Could not reach the server.',
        },
        snapshot: {
          base64: 'AAAA',
          width: 800,
          height: 600,
          url: 'https://www.example.com/pricing',
          capturedAt: 1,
        },
        page: { url: 'https://www.example.com/pricing', title: 'Pricing' },
      }),
    );
    expect(html).toContain('cp-snapshot');
    expect(html).toContain('Snapshot');
    expect(html).toContain('Pricing');
    expect(html).toContain('example.com/pricing');
    expect(html).toContain('Retry live view');
    const ended = body(
      view({ stream: { phase: 'ended', reason: 'superseded', message: 'x' } }),
    );
    expect(ended).toContain('Watch here');
  });
});

describe('header', () => {
  it('names the Dot, shows its status and offers Stop only while running', () => {
    const on = PanelHeader({
      dot,
      phase: 'running',
      settingsOpen: false,
      settingsId: 'sheet',
      onToggleSettings: vi.fn(),
      onStop: vi.fn(),
    });
    expect(textOf(findAll(on, (el) => el.type === 'h2'))).toBe('Dot');
    expect(button(on, 'Stop')).toBeDefined();
    const off = PanelHeader({
      dot,
      phase: 'stopped',
      settingsOpen: false,
      settingsId: 'sheet',
      onToggleSettings: vi.fn(),
      onStop: vi.fn(),
    });
    expect(button(off, 'Stop')).toBeUndefined();
  });

  it('wires Stop and the gear, and marks the gear open', () => {
    const onStop = vi.fn();
    const onToggleSettings = vi.fn();
    const header = PanelHeader({
      dot,
      phase: 'running',
      settingsOpen: true,
      settingsId: 'sheet',
      onToggleSettings,
      onStop,
    });
    (button(header, 'Stop')?.props.onClick as () => void)();
    const gear = findAll(
      header,
      (el) => el.props['aria-label'] === 'Computer settings',
    )[0];
    expect(gear.props['aria-expanded']).toBe(true);
    expect(gear.props['aria-controls']).toBe('sheet');
    (gear.props.onClick as () => void)();
    expect(onStop).toHaveBeenCalledOnce();
    expect(onToggleSettings).toHaveBeenCalledOnce();
  });

  it('only closes when asked to', () => {
    expect(view()).not.toContain('Close computer panel');
    expect(view({ onClose: () => {} })).toContain('Close computer panel');
  });
});

describe('control bar', () => {
  const props = {
    dotName: 'Dot',
    disabled: false,
    onTake: vi.fn(),
    onRelease: vi.fn(),
  };
  it('takes control from the Dot and gives it back', () => {
    const onTake = vi.fn();
    const onRelease = vi.fn();
    (
      button(ControlBar({ ...props, human: false, onTake, onRelease }), 'Take')
        ?.props.onClick as () => void
    )();
    (
      button(ControlBar({ ...props, human: true, onTake, onRelease }), 'Give')
        ?.props.onClick as () => void
    )();
    expect(onTake).toHaveBeenCalledOnce();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('disables the button while another request is running', () => {
    const bar = ControlBar({ ...props, human: false, disabled: true });
    expect(button(bar, 'Take control')?.props.disabled).toBe(true);
  });

  it('names the wait for either direction', () => {
    expect(
      textOf(ControlBar({ ...props, human: false, waiting: 'take' })),
    ).toBe('Waiting for Dot to pause…');
    expect(
      textOf(ControlBar({ ...props, human: true, waiting: 'release' })),
    ).toBe('Handing control back to Dot…');
  });
});

describe('settings sheet', () => {
  const sheet = (over: Partial<Parameters<typeof SettingsSheet>[0]> = {}) =>
    SettingsSheet({
      id: 'sheet',
      dot,
      status: running(),
      optimistic: {},
      notes: {},
      busy: false,
      hidden: false,
      onSetPermission: vi.fn(),
      onStart: vi.fn(),
      onStop: vi.fn(),
      onClose: vi.fn(),
      ...over,
    });
  const switches = (root: ReactNode) =>
    findAll(root, (el) => el.props.role === 'switch');

  it('describes each permission in a sentence and says the shell stays in the container', () => {
    const text = textOf(sheet());
    for (const title of ['Computer access', 'Browser', 'Files', 'Shell'])
      expect(text).toContain(title);
    expect(text).toContain('never on your device');
    expect(text).toContain('Dot’s workspace');
    expect(switches(sheet())).toHaveLength(4);
  });

  it('reflects the saved permissions and flips a switch the moment it is pressed', () => {
    const status = running({ permissions: { ...permissions, shell: false } });
    expect(switches(sheet({ status })).map((el) => el.props.checked)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(
      switches(sheet({ status, optimistic: { shell: true } })).map(
        (el) => el.props.checked,
      ),
    ).toEqual([true, true, true, true]);
  });

  it('reports a change through the right permission', () => {
    const onSetPermission = vi.fn();
    const [, browser, , shell] = switches(sheet({ onSetPermission }));
    (shell.props.onChange as (e: unknown) => void)({
      target: { checked: true },
    });
    (browser.props.onChange as (e: unknown) => void)({
      target: { checked: false },
    });
    expect(onSetPermission).toHaveBeenNthCalledWith(1, 'shell', true);
    expect(onSetPermission).toHaveBeenNthCalledWith(2, 'browser', false);
  });

  it('shows saving, saved and failed next to the permission it belongs to', () => {
    const text = textOf(
      sheet({ notes: { files: 'saving', shell: 'saved', browser: 'error' } }),
    );
    expect(text).toContain('Saving…');
    expect(text).toContain('Saved');
    expect(text).toContain('Could not save. Try again.');
    expect(textOf(sheet())).not.toContain('Saving…');
  });

  it('keeps switches still while a request runs or nothing is connected', () => {
    expect(
      switches(sheet({ busy: true })).every((el) => el.props.disabled),
    ).toBe(true);
    expect(
      switches(
        sheet({
          status: {
            configured: false,
            state: 'not_configured',
            permissions,
            audit: [],
          },
        }),
      ).every((el) => el.props.disabled),
    ).toBe(true);
  });

  it('starts and stops, each only when it can', () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    const live = sheet({ onStart, onStop });
    expect(button(live, 'Start computer')?.props.disabled).toBe(true);
    (button(live, 'Stop computer')?.props.onClick as () => void)();
    expect(onStop).toHaveBeenCalledOnce();
    const off = sheet({
      onStart,
      onStop,
      status: running({ state: 'stopped' }),
    });
    expect(button(off, 'Stop computer')?.props.disabled).toBe(true);
    (button(off, 'Start computer')?.props.onClick as () => void)();
    expect(onStart).toHaveBeenCalledOnce();
  });

  it('only offers a switch between Dots when there is more than one', () => {
    const pick = (dots: Dot[]) => textOf(sheet({ dots, onSelectDot: vi.fn() }));
    expect(pick([dot])).not.toContain('Computer for');
    expect(pick([dot, { ...dot, id: 'dot-2', name: 'Scout' }])).toContain(
      'Computer for',
    );
  });

  it('leaves through Done, the back arrow and Escape', () => {
    const onClose = vi.fn();
    const root = sheet({ onClose }) as ReactElement<Props>;
    (button(root, 'Done')?.props.onClick as () => void)();
    (
      findAll(root, (el) => el.props['aria-label'] === 'Back to the screen')[0]
        .props.onClick as () => void
    )();
    const keydown = root.props.onKeyDown as (e: unknown) => void;
    keydown({ key: 'Escape', defaultPrevented: false });
    keydown({ key: 'a', defaultPrevented: false });
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it('is part of the panel, closed until the gear is pressed', () => {
    const html = view();
    expect(tag(html, 'cp-sheet')).toContain('hidden');
    expect(tag(html, 'cp-body')).not.toContain('hidden');
  });
});

describe('more tools', () => {
  const store = (initial: Record<string, string> = {}) => {
    const data = new Map(Object.entries(initial));
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
    });
    return data;
  };

  it('is collapsed by default, with files first', () => {
    store();
    expect(readMorePrefs()).toEqual({ open: false, tool: 'files' });
    const html = body(view());
    expect(tag(html, 'cp-more-toggle')).toContain('aria-expanded="false"');
    expect(tag(html, 'cp-more-region')).toContain('hidden');
  });

  it('remembers being opened, and which tool, for next time', () => {
    const data = store();
    writeMorePrefs({ open: true, tool: 'activity' });
    expect(data.get(MORE_OPEN_KEY)).toBe('1');
    expect(readMorePrefs()).toEqual({ open: true, tool: 'activity' });
    const html = body(view());
    expect(tag(html, 'cp-more-toggle')).toContain('aria-expanded="true"');
    expect(tag(html, 'cp-more-region')).not.toContain('hidden');
    expect(html).toMatch(/aria-selected="true"[^>]*>Activity</);
    writeMorePrefs({ open: false, tool: 'activity' });
    expect(readMorePrefs().open).toBe(false);
  });

  it('ignores a stored tool it does not know', () => {
    store({ 'fulldots:computer:more-tool': 'nonsense' });
    expect(readMorePrefs().tool).toBe('files');
  });

  it('works when browser storage throws or is missing', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    });
    expect(readMorePrefs()).toEqual({ open: false, tool: 'files' });
    expect(() => writeMorePrefs({ open: true, tool: 'files' })).not.toThrow();
    expect(body(view())).toContain('cp-more');
    vi.stubGlobal('localStorage', undefined);
    expect(readMorePrefs().open).toBe(false);
  });

  it('keeps the terminal off, and says why, without the shell permission', () => {
    const off = body(
      view({
        status: running({ permissions: { ...permissions, shell: false } }),
      }),
    );
    expect(off).toContain('The terminal is off.');
    expect(off).toMatch(
      /<textarea[^>]*aria-label="Terminal command"[^>]*disabled/,
    );
    const on = body(view());
    expect(on).toContain('Runs inside Dot’s computer, not on your device.');
    expect(on).not.toMatch(
      /<textarea[^>]*aria-label="Terminal command"[^>]*disabled/,
    );
  });

  it('keeps files off without their permission, and while stopped', () => {
    const off = body(
      view({
        status: running({ permissions: { ...permissions, files: false } }),
      }),
    );
    expect(off).toContain('Files are off.');
    const stopped = body(view({ status: running({ state: 'stopped' }) }));
    expect(stopped).toContain('Start the computer to use files.');
    expect(stopped).toContain('Start the computer to use the terminal.');
  });

  it('shows the Dot’s own actions in the activity list, newest first, without the panel’s polling', () => {
    const audit = [
      entry({ id: 'old', action: 'navigate', createdAt: 1000 }),
      entry({
        id: 'poll',
        action: 'screenshot',
        actor: 'owner',
        createdAt: 3000,
      }),
      entry({ id: 'new', action: 'exec', createdAt: 2000 }),
    ];
    const html = body(view({ status: running({ audit }) }));
    expect(html).toContain('Ran a command');
    expect(html).toContain('Opened a page');
    expect(html).not.toContain('Took a screenshot');
    expect(html.indexOf('Ran a command')).toBeLessThan(
      html.indexOf('Opened a page'),
    );
  });
});

describe('what the Dot is doing', () => {
  const now = 1_000_000;
  it.each([
    ['navigate', 'navigating'],
    ['click', 'clicking'],
    ['type', 'typing'],
    ['read', 'reading the page'],
    ['exec', 'running a command'],
    ['files_write', 'saving a file'],
  ])('puts %s as "%s"', (action, verb) => {
    expect(
      currentActivity(
        [entry({ action, outcome: 'pending', createdAt: now })],
        now,
      ),
    ).toEqual({ action, verb });
  });

  it('follows only the Dot, and only while it is fresh', () => {
    expect(currentActivity([], now)).toBeUndefined();
    expect(
      currentActivity([entry({ actor: 'owner', createdAt: now })], now),
    ).toBeUndefined();
    expect(
      currentActivity([entry({ createdAt: now - 3000 })], now),
    ).toBeDefined();
    expect(
      currentActivity([entry({ createdAt: now - 60_000 })], now),
    ).toBeUndefined();
    expect(
      currentActivity(
        [entry({ outcome: 'pending', createdAt: now - 60_000 })],
        now,
      ),
    ).toBeDefined();
    expect(
      currentActivity(
        [entry({ outcome: 'pending', createdAt: now - 10 * 60_000 })],
        now,
      ),
    ).toBeUndefined();
    expect(
      currentActivity([entry({ outcome: 'failed', createdAt: now })], now),
    ).toBeUndefined();
  });

  it('reads the newest entry whichever way the list is ordered', () => {
    const typed = entry({ action: 'type', createdAt: now - 500 });
    const clicked = entry({ action: 'click', createdAt: now - 100 });
    expect(currentActivity([typed, clicked], now)?.verb).toBe('clicking');
    expect(currentActivity([clicked, typed], now)?.verb).toBe('clicking');
    expect(newestFirst([typed, clicked])[0]).toBe(clicked);
  });

  it('does not announce actions it has no words for', () => {
    expect(
      currentActivity([entry({ action: 'start', createdAt: now })], now),
    ).toBeUndefined();
  });

  it('limits the activity list', () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry({ id: String(index), createdAt: index }),
    );
    expect(visibleAudit(many)).toHaveLength(30);
  });
});

describe('addresses and phases', () => {
  it('accepts a bare domain as a web address', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('  http://example.com/a  ')).toBe(
      'http://example.com/a',
    );
    expect(normalizeUrl('localhost:3000/app')).toBe(
      'https://localhost:3000/app',
    );
    expect(normalizeUrl('')).toBe('');
  });

  it('tells the states apart', () => {
    expect(panelPhase(undefined, false)).toBe('loading');
    expect(panelPhase(undefined, true)).toBe('unreachable');
    expect(
      panelPhase(
        { configured: false, state: 'not_configured', permissions, audit: [] },
        false,
      ),
    ).toBe('not_configured');
    expect(panelPhase(running({ state: 'unavailable' }), false)).toBe(
      'unavailable',
    );
    expect(panelPhase(running({ state: 'stopped' }), false)).toBe('stopped');
    expect(
      panelPhase(
        running({ permissions: { ...permissions, enabled: false } }),
        false,
      ),
    ).toBe('disabled');
    expect(panelPhase(running(), false)).toBe('running');
  });
});

describe('handoff', () => {
  const props = {
    dotName: 'Dot',
    disabled: false,
    onTake: vi.fn(),
    onRelease: vi.fn(),
  };
  const handoff = {
    id: 'h1',
    kind: 'credential',
    reason: 'Sign in to GitHub',
  };

  it('asks for the owner and offers Take control and Dismiss', () => {
    const onTake = vi.fn();
    const onDismiss = vi.fn();
    const bar = ControlBar({
      ...props,
      human: false,
      handoff,
      onTake,
      onDismiss,
    });
    const text = textOf(bar);
    expect(text).toContain('Your turn:');
    expect(text).toContain('Sign in to GitHub');
    expect(tag(renderToStaticMarkup(bar), 'cp-control-handoff')).toContain(
      'role="status"',
    );
    (button(bar, 'Take control')?.props.onClick as () => void)();
    (button(bar, 'Dismiss')?.props.onClick as () => void)();
    expect(onTake).toHaveBeenCalledOnce();
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(button(bar, 'Take control')?.props.className).toContain(
      'cp-btn-primary',
    );
    expect(button(bar, 'Dismiss')?.props.className).toContain('cp-btn-quiet');
  });

  it('disables both buttons while another request is running', () => {
    const bar = ControlBar({
      ...props,
      human: false,
      disabled: true,
      handoff,
      onDismiss: vi.fn(),
    });
    expect(button(bar, 'Take control')?.props.disabled).toBe(true);
    expect(button(bar, 'Dismiss')?.props.disabled).toBe(true);
  });

  it('hints at what to do, by kind of handoff', () => {
    const hint = (kind: string) =>
      textOf(
        ControlBar({ ...props, human: false, handoff: { ...handoff, kind } }),
      );
    expect(hint('credential')).toContain(
      'Sign in on the screen yourself; the Dot never sees what you type.',
    );
    expect(hint('two_factor')).toContain(
      'Enter the code on the screen yourself.',
    );
    expect(hint('captcha')).toContain('Complete the check on the screen.');
    expect(hint('other')).toBe(
      'Your turn: Sign in to GitHubTake controlDismiss',
    );
  });

  it('reminds the owner that the secret stays off the Dot while they hold control', () => {
    const bar = ControlBar({ ...props, human: true, handoff });
    expect(button(bar, 'Give control back')).toBeDefined();
    expect(textOf(bar)).toContain(
      'Type the secret on the screen; the Dot never sees it.',
    );
    expect(button(bar, 'Dismiss')).toBeUndefined();
  });

  it('is unchanged without a handoff', () => {
    const bot = ControlBar({ ...props, human: false });
    expect(textOf(bot)).toBe('Dot is in controlTake control');
    expect(button(bot, 'Dismiss')).toBeUndefined();
    const human = ControlBar({ ...props, human: true });
    expect(textOf(human)).toBe(
      'Give control backClick and type directly on the screen. Shift+Esc to stop typing.',
    );
    expect(renderToStaticMarkup(bot)).not.toContain('Your turn');
  });

  it('shows "Needs you" in the header and the handoff bar in the view', () => {
    const waiting = running({
      handoff: { id: 'h1', kind: 'captcha', reason: 'Solve it', createdAt: 1 },
    });
    const pill = (html: string) => /cp-pill[^>]*>.*?<\/span>/.exec(html)?.[0];
    const html = body(view({ status: waiting }));
    expect(pill(html)).toContain('cp-pill-warn');
    expect(pill(html)).toContain('Needs you');
    expect(html).toContain('Your turn:');
    expect(html).toContain('Complete the check on the screen.');
    expect(pill(body(view()))).toContain('Running');
    expect(body(view())).not.toContain('Needs you');
    // Once the owner holds control the Dot no longer needs them.
    const taken = running({
      handoff: waiting.handoff,
      control: control('human'),
    });
    expect(body(view({ status: taken }))).not.toContain('Needs you');
    expect(body(view({ status: taken }))).toContain('never sees it');
  });

  it('labels the handoff requests in the activity list and does not call them live work', () => {
    expect(PAST_LABELS.request_control).toBe('Asked for your help');
    expect(PAST_LABELS.cancel_control).toBe('Dismissed the handoff');
    expect(auditLabel(entry({ action: 'request_control' }))).toBe(
      'Asked for your help',
    );
    expect(
      currentActivity(
        [
          entry({
            action: 'request_control',
            outcome: 'pending',
            createdAt: 1000,
          }),
        ],
        1000,
      ),
    ).toBeUndefined();
  });
});
