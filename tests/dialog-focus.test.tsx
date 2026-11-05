// Modal dialogs share one focus trap (src/client/useModalDialog.ts): focus moves in when one opens,
// Tab and Shift+Tab wrap inside it, Escape closes it and focus goes back to its opener. The browser
// is played by tests/fixtures/fake-dom.ts, since the tests run without a DOM.
import { useRef, useState, type ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(() => new Promise(() => {})),
  authHeaders: () => ({}),
}));
import {
  openDialogCount,
  useModalDialog,
  type InitialFocus,
} from '../src/client/useModalDialog';
import { WorkspaceDialog, type Dialog } from '../src/client/WorkspaceDialog';
import { TriggerDialog } from '../src/client/TriggerDialog';
import { TeamBuilder } from '../src/client/teams/TeamBuilder';
import { DotNotesSheet } from '../src/client/DotNotes';
import { CommandPalette } from '../src/client/palette/CommandPalette';
import { AddDotDialog } from '../src/client/room/AddDotDialog';
import type { Dot, State, WorkspaceState } from '../src/shared/types';
import { FakeDocument, mountTree, type FakeElement } from './fixtures/fake-dom';

let doc: FakeDocument;
let opener: FakeElement;
let roots: ReactTestRenderer[] = [];
let dom: ReturnType<typeof mountTree>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  // The penguins: reduced motion draws them once, with no animation loop to stub.
  vi.stubGlobal('matchMedia', () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  opener = doc.createElement('button');
  doc.body.append(opener);
  opener.focus();
  dom = mountTree(doc);
});

afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.unstubAllGlobals();
});

async function open(element: ReactElement) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element, { createNodeMock: dom.createNodeMock });
    dom.attach(root);
  });
  roots.push(root);
  return root;
}

async function press(key: string, shiftKey = false) {
  let event!: ReturnType<FakeDocument['press']>;
  await act(async () => {
    event = doc.press(key, { shiftKey });
  });
  return event;
}

/** What a screen reader would call the focused element: its aria-label, else its text. */
function focusedName(): string {
  const el = doc.activeElement;
  const label = el.getAttribute('aria-label');
  if (label) return label;
  const text = (props: unknown): string => {
    if (typeof props === 'string' || typeof props === 'number')
      return String(props);
    if (Array.isArray(props)) return props.map(text).join('');
    if (props && typeof props === 'object' && 'props' in props)
      return text((props as { props: { children?: unknown } }).props.children);
    return '';
  };
  return text(el.props.children).trim() || el.tagName.toLowerCase();
}

async function closeWith(root: ReactTestRenderer) {
  await act(async () => root.unmount());
  roots = roots.filter((item) => item !== root);
}

function Harness({
  onClose,
  initialFocus,
  children,
}: {
  onClose: () => void;
  initialFocus?: InitialFocus;
  children?: ReactElement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const modal = useModalDialog(ref, {
    onClose,
    ...(initialFocus !== undefined ? { initialFocus } : {}),
  });
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      tabIndex={-1}
      onKeyDown={modal.onKeyDown}
    >
      <button type="button">First</button>
      <input aria-label="Name" />
      <button type="button" disabled>
        Off
      </button>
      <div hidden>
        <button type="button">In a hidden panel</button>
      </div>
      <button type="button" tabIndex={-1}>
        Not a Tab stop
      </button>
      <fieldset disabled>
        <button type="button">In a disabled fieldset</button>
      </fieldset>
      <button type="button">Last</button>
      {children}
    </div>
  );
}

describe('the shared modal dialog hook', () => {
  it('starts on the first field, or where it is told to', async () => {
    await open(<Harness onClose={() => {}} />);
    expect(focusedName()).toBe('Name');
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    await open(<Harness onClose={() => {}} initialFocus="first" />);
    expect(focusedName()).toBe('First');
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    await open(<Harness onClose={() => {}} initialFocus="dialog" />);
    expect(doc.activeElement.getAttribute('role')).toBe('dialog');
    await act(async () => roots.splice(0).forEach((root) => root.unmount()));
    opener.focus();
    await open(<Harness onClose={() => {}} initialFocus={false} />);
    expect(doc.activeElement).toBe(opener);
  });

  it('wraps Tab from the last control to the first, skipping what Tab cannot reach', async () => {
    await open(<Harness onClose={() => {}} />);
    expect(focusedName()).toBe('Name');
    await press('Tab');
    // The disabled, hidden, tabindex -1 and disabled-fieldset buttons are skipped.
    expect(focusedName()).toBe('Last');
    const wrapped = await press('Tab');
    expect(wrapped.defaultPrevented).toBe(true);
    expect(focusedName()).toBe('First');
  });

  it('wraps Shift+Tab from the first control to the last', async () => {
    await open(<Harness onClose={() => {}} initialFocus="first" />);
    await press('Tab', true);
    expect(focusedName()).toBe('Last');
    await press('Tab', true);
    expect(focusedName()).toBe('Name');
  });

  it('brings focus back in when it fell outside, Tab to the first and Shift+Tab to the last', async () => {
    await open(<Harness onClose={() => {}} />);
    doc.activeElement = doc.body;
    await press('Tab');
    expect(focusedName()).toBe('First');
    doc.activeElement = doc.body;
    await press('Tab', true);
    expect(focusedName()).toBe('Last');
  });

  it('closes on Escape, from inside or from the page body', async () => {
    const onClose = vi.fn();
    await open(<Harness onClose={onClose} />);
    const event = await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    doc.activeElement = doc.body;
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('stays open when a control inside claims Escape first', async () => {
    const onClose = vi.fn();
    await open(
      <Harness onClose={onClose}>
        <input
          aria-label="Search"
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.preventDefault();
          }}
        />
      </Harness>,
    );
    const search = roots[0]!.root.find(
      (node) => node.props['aria-label'] === 'Search',
    );
    dom.el(search).focus();
    expect(focusedName()).toBe('Search');
    await press('Escape');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('gives focus back to the opener when it closes, and stops listening', async () => {
    const root = await open(<Harness onClose={() => {}} />);
    expect(doc.activeElement).not.toBe(opener);
    expect(openDialogCount()).toBe(1);
    await closeWith(root);
    expect(doc.activeElement).toBe(opener);
    expect(openDialogCount()).toBe(0);
    expect(doc.listenerCount).toBe(0);
  });

  it('lets only the innermost of two open dialogs answer keys', async () => {
    const outer = vi.fn();
    const inner = vi.fn();
    function Nested() {
      const [second, setSecond] = useState(true);
      return (
        <>
          <Harness onClose={outer} />
          {second && (
            <Harness
              onClose={() => {
                inner();
                setSecond(false);
              }}
            />
          )}
        </>
      );
    }
    await open(<Nested />);
    await press('Escape');
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
    // The inner one gave focus back to where it was opened from: the outer dialog's field.
    expect(focusedName()).toBe('Name');
    await press('Escape');
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('counts a radio group as one stop, the checked radio', async () => {
    function Radios() {
      const ref = useRef<HTMLDivElement>(null);
      const modal = useModalDialog(ref, { onClose: () => {} });
      return (
        <div ref={ref} tabIndex={-1} onKeyDown={modal.onKeyDown}>
          <input type="radio" name="kind" aria-label="One" readOnly />
          <input type="radio" name="kind" aria-label="Two" checked readOnly />
          <input type="radio" name="kind" aria-label="Three" readOnly />
        </div>
      );
    }
    await open(<Radios />);
    expect(focusedName()).toBe('Two');
    await press('Tab');
    expect(focusedName()).toBe('Two');
  });

  it('holds focus on the dialog itself when it has no controls', async () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null);
      const modal = useModalDialog(ref, { onClose: () => {} });
      return (
        <div ref={ref} role="dialog" tabIndex={-1} onKeyDown={modal.onKeyDown}>
          Nothing to press.
        </div>
      );
    }
    await open(<Empty />);
    expect(doc.activeElement.getAttribute('role')).toBe('dialog');
    await press('Tab');
    expect(doc.activeElement.getAttribute('role')).toBe('dialog');
  });
});

// ---- Every dialog that uses it --------------------------------------------------------

const workspace = {
  spaces: [{ id: 's1', name: 'Everyday' }],
  dots: [],
  setup: {
    missing: [],
    search: false,
    browser: false,
    voice: false,
    defaultModel: 'acme/model-1',
  },
} as unknown as WorkspaceState;
const state = {
  settings: { researchAllowed: true, memoryAllowed: true },
} as unknown as State;
const dot = {
  id: 'dot-1',
  name: 'Scout',
  color: 'mint',
  spaceId: 's1',
  spaceIds: ['s1'],
  instructions: 'Be kind.',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
} as unknown as Dot;

/** Opens a dialog, then checks the whole contract against it. */
async function checkDialog(
  name: string,
  render: (onClose: () => void) => ReactElement,
  expected: { first: string; last: string; start: string },
) {
  const onClose = vi.fn();
  const root = await open(render(onClose));
  expect(focusedName(), `${name} starts on`).toBe(expected.start);
  // Walk to the end with Tab, then once more: back to the first control.
  for (let step = 0; step < 60 && focusedName() !== expected.last; step++)
    await press('Tab');
  expect(focusedName(), `${name} last control`).toBe(expected.last);
  await press('Tab');
  expect(focusedName(), `${name} wraps forward to`).toBe(expected.first);
  await press('Tab', true);
  expect(focusedName(), `${name} wraps back to`).toBe(expected.last);
  await press('Escape');
  expect(onClose, `${name} closes on Escape`).toHaveBeenCalledTimes(1);
  await closeWith(root);
  expect(doc.activeElement, `${name} returns focus`).toBe(opener);
}

describe('each dialog keeps focus inside and gives it back', () => {
  it('the space form', async () => {
    await checkDialog(
      'Space dialog',
      (onClose) => (
        <WorkspaceDialog
          dialog={{ type: 'space' } as Dialog}
          state={state}
          workspace={workspace}
          onClose={onClose}
          mutate={async () => true}
        />
      ),
      { start: 'input', first: 'Close dialog', last: 'Save' },
    );
  });

  it('the Dot form', async () => {
    await checkDialog(
      'Dot dialog',
      (onClose) => (
        <WorkspaceDialog
          dialog={{ type: 'dot', spaceId: 's1' } as Dialog}
          state={state}
          workspace={workspace}
          onClose={onClose}
          mutate={async () => true}
        />
      ),
      { start: 'input', first: 'Close dialog', last: 'Create Dot' },
    );
  });

  it('Settings, whose hidden tabs stay in the page after the one showing', async () => {
    const onClose = vi.fn();
    await open(
      <WorkspaceDialog
        dialog={{ type: 'settings', tab: 'channels' } as Dialog}
        state={state}
        workspace={workspace}
        onClose={onClose}
        mutate={async () => true}
      />,
    );
    // Channels is still loading, so its own tab is the last control showing; the About panel
    // after it is hidden but its links are still in the page. Tab must not fall into them.
    const tab = roots[0]!.root.find(
      (node) => node.props.id === 'settings-tab-channels',
    );
    dom.el(tab).focus();
    await press('Tab');
    expect(focusedName()).toBe('Close dialog');
    await press('Tab', true);
    expect(doc.activeElement.id).toBe('settings-tab-channels');
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the trigger dialog', async () => {
    await checkDialog(
      'Trigger dialog',
      (onClose) => (
        <TriggerDialog
          threadId="t1"
          dotId="dot-1"
          onClose={onClose}
          onCreated={() => {}}
        />
      ),
      { start: 'input', first: 'Close dialog', last: 'Add trigger' },
    );
  });

  it('the team builder', async () => {
    await checkDialog(
      'Team builder',
      (onClose) => (
        <TeamBuilder
          dots={[dot]}
          teams={[]}
          team={{
            id: 'team-1',
            name: 'Launch crew',
            emoji: '🚀',
            color: 'coral',
            description: '',
            leadDotId: 'dot-1',
            members: [],
            style: 'parallel',
            mode: 'lead',
            summarize: false,
            reviewerDotId: null,
            spaceId: null,
            runLog: false,
            createdAt: 1,
            updatedAt: 1,
            archivedAt: null,
          }}
          onClose={onClose}
          onSaved={() => {}}
        />
      ),
      { start: 'input', first: 'Close dialog', last: 'Save team' },
    );
  });

  it('the notes sheet', async () => {
    await checkDialog(
      'Notes sheet',
      (onClose) => <DotNotesSheet dot={dot} onClose={onClose} />,
      { start: 'Close notes', first: 'Close notes', last: 'input' },
    );
  });

  it('the command palette', async () => {
    const onClose = vi.fn();
    const root = await open(
      <CommandPalette
        open
        onClose={onClose}
        workspace={{ dots: [], spaces: [], conversations: [] }}
        configured
        handlers={{
          openThread: vi.fn(),
          openPage: vi.fn(),
          openDot: vi.fn(),
          usePrompt: vi.fn(),
          runAction: vi.fn(),
        }}
      />,
    );
    expect(doc.activeElement.getAttribute('role')).toBe('combobox');
    // From outside (a click on the backdrop left focus on the page body) Tab comes back in.
    doc.activeElement = doc.body;
    await press('Tab');
    expect(doc.activeElement.getAttribute('role')).toBe('combobox');
    await press('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    await closeWith(root);
    expect(doc.activeElement).toBe(opener);
  });

  it('the add-a-Dot confirm', async () => {
    vi.useFakeTimers();
    try {
      const onCancel = vi.fn();
      const root = await open(
        <AddDotDialog dot={dot} onAdd={() => {}} onCancel={onCancel} />,
      );
      // Focus arrives once the keypress that opened it has settled.
      expect(doc.activeElement).toBe(opener);
      await act(async () => {
        vi.runAllTimers();
      });
      expect(focusedName()).toBe('Add');
      await press('Tab');
      expect(focusedName()).toBe('Cancel');
      await press('Tab', true);
      expect(focusedName()).toBe('Add');
      await press('Escape');
      expect(onCancel).toHaveBeenCalledTimes(1);
      await closeWith(root);
      expect(doc.activeElement).toBe(opener);
    } finally {
      vi.useRealTimers();
    }
  });
});
