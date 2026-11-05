// Accessible names and announced status chips in Settings, the dialogs and the approval cards.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import {
  act,
  create,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(() => new Promise(() => {})),
  authHeaders: () => ({}),
}));
import { ApprovalBadge, ApprovalCard } from '../src/client/ApprovalCard';
import { ApprovalsView } from '../src/client/ApprovalsView';
import { ConnectorGallery, StatusPill } from '../src/client/ConnectorGallery';
import { ConnectorSheet } from '../src/client/ConnectorSheet';
import { DotNotesButton, DotNotesSheet } from '../src/client/DotNotes';
import {
  ModelProviderGallery,
  StatusPill as ProviderPill,
} from '../src/client/ModelProviderGallery';
import { ModelProviderPage } from '../src/client/ModelProviderPage';
import { TriggerDialog } from '../src/client/TriggerDialog';
import { WorkspaceDialog, type Dialog } from '../src/client/WorkspaceDialog';
import { SettingsSheet } from '../src/client/computer-panel/SettingsSheet';
import { connectorPresets } from '../src/shared/connector-presets';
import {
  modelPreset,
  modelPresets,
  type ModelProviderView,
} from '../src/shared/model-presets';
import type {
  Approval,
  ConnectorView,
  Dot,
  State,
  WorkspaceState,
} from '../src/shared/types';
import type { ApprovalToolResult } from '../src/client/chat-turns';
import { FakeDocument, FakeElement, mountTree } from './fixtures/fake-dom';

const noop = () => {};
/** Markup with every tag removed, repeated until none is left (one pass can leave a tag behind). */
function withoutTags(html: string, between = ''): string {
  let previous: string;
  let text = html;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, between);
  } while (text !== previous);
  return text;
}
const roots: ReactTestRenderer[] = [];
let dom: ReturnType<typeof mountTree>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  // Just enough browser for the components' effects (focus on open, theme, timers).
  const doc = new FakeDocument();
  const media = () => ({
    matches: true,
    addEventListener: noop,
    removeEventListener: noop,
  });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', FakeElement);
  vi.stubGlobal('matchMedia', media);
  vi.stubGlobal('addEventListener', noop);
  vi.stubGlobal('removeEventListener', noop);
  vi.stubGlobal('window', {
    setTimeout,
    clearTimeout,
    matchMedia: media,
    addEventListener: noop,
    removeEventListener: noop,
  });
  dom = mountTree(doc);
});
afterEach(async () => {
  await act(async () => roots.splice(0).forEach((root) => root.unmount()));
  vi.unstubAllGlobals();
});

async function render(element: ReactElement) {
  let root!: ReactTestRenderer;
  await act(async () => {
    root = create(element, { createNodeMock: dom.createNodeMock });
    dom.attach(root);
  });
  roots.push(root);
  return root;
}

/** The text a screen reader reads for a node: aria-hidden parts left out. */
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  if (
    node.props['aria-hidden'] === true ||
    node.props['aria-hidden'] === 'true'
  )
    return '';
  return node.children.map(textOf).join('');
}

/** Name from aria-label, aria-labelledby, the contents, then title, like the accname rules. */
function accessibleName(root: ReactTestInstance, node: ReactTestInstance) {
  const label = node.props['aria-label'];
  if (typeof label === 'string' && label.trim()) return label.trim();
  const by = node.props['aria-labelledby'];
  if (typeof by === 'string') {
    const names = by.split(/\s+/).map((id) => {
      const target = root.findAll((item) => item.props.id === id)[0];
      return target ? textOf(target) : '';
    });
    if (names.join('').trim()) return names.join(' ').trim();
  }
  const text = textOf(node).replace(/\s+/g, ' ').trim();
  if (text) return text;
  const title = node.props.title;
  return typeof title === 'string' ? title.trim() : '';
}

const isButton = (node: ReactTestInstance) =>
  node.type === 'button' || node.props.role === 'button';

/** Like Testing Library's getByRole('button', { name }). */
function getButton(root: ReactTestRenderer, name: string | RegExp) {
  const found = root.root.findAll(
    (node) =>
      typeof node.type === 'string' &&
      isButton(node) &&
      (typeof name === 'string'
        ? accessibleName(root.root, node) === name
        : name.test(accessibleName(root.root, node))),
  );
  expect(found, `a button named ${name}`).toHaveLength(1);
  return found[0]!;
}

function expectEveryButtonNamed(root: ReactTestRenderer) {
  const nameless = root.root
    .findAll((node) => typeof node.type === 'string' && isButton(node))
    .filter((node) => !accessibleName(root.root, node))
    .map((node) => String(node.props.className ?? node.type));
  expect(nameless).toEqual([]);
}

// ---- Fixtures --------------------------------------------------------------------------

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

function connector(status: ConnectorView['status']): ConnectorView {
  return {
    id: 'id-github',
    name: 'github',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    command: null,
    args: [],
    cwd: null,
    headers: {},
    env: {},
    callTimeoutMs: 30_000,
    enabled: true,
    presetId: 'github',
    auth: 'oauth',
    createdAt: 1,
    updatedAt: 1,
    status,
  };
}

const groq: ModelProviderView = {
  id: 'p-groq',
  presetId: 'groq',
  name: 'Groq',
  baseUrl: modelPreset('groq')!.baseUrl ?? 'https://llm.example.com/v1',
  key: { kind: 'stored', set: true, last4: 'wxyz' },
  enabled: true,
  createdAt: 1,
  updatedAt: 1,
  lastTestedAt: 1000,
  lastError: null,
  builtIn: false,
};

const approval = (extra: Partial<Approval> = {}): Approval =>
  ({
    id: 'a1',
    dotId: 'dot-1',
    threadId: 't1',
    tool: 'run_command',
    summary: 'Delete the folder',
    argsRedacted: 'rm -rf build',
    argsHash: 'hash',
    status: 'pending',
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
    ...extra,
  }) as Approval;
const asked = {
  status: 'approval_required',
  approvalId: 'a1',
  summary: 'Delete the folder',
  exact: 'rm -rf build',
} as unknown as ApprovalToolResult;

// ---- Names ----------------------------------------------------------------------------

describe('icon-only buttons have names', () => {
  it('names the close buttons of the dialogs', async () => {
    for (const dialog of [
      { type: 'space' },
      { type: 'settings', tab: 'general' },
      { type: 'memory' },
    ] as Dialog[]) {
      const root = await render(
        <WorkspaceDialog
          dialog={dialog}
          state={state}
          workspace={workspace}
          onClose={noop}
          mutate={async () => true}
        />,
      );
      getButton(root, 'Close dialog');
      expectEveryButtonNamed(root);
    }
    const trigger = await render(
      <TriggerDialog
        threadId="t1"
        dotId="dot-1"
        onClose={noop}
        onCreated={noop}
      />,
    );
    getButton(trigger, 'Close dialog');
    expectEveryButtonNamed(trigger);
    const notes = await render(<DotNotesSheet dot={dot} onClose={noop} />);
    getButton(notes, 'Close notes');
    expectEveryButtonNamed(notes);
  });

  it('names the Settings tabs and the notes button by what they do', async () => {
    const settings = await render(
      <WorkspaceDialog
        dialog={{ type: 'settings', tab: 'general' } as Dialog}
        state={state}
        workspace={workspace}
        onClose={noop}
        mutate={async () => true}
      />,
    );
    for (const tab of ['General', 'Models', 'Connectors', 'Channels'])
      expect(getButton(settings, tab).props.role).toBe('tab');
    const opener = await render(<DotNotesButton dot={dot} />);
    expect(
      getButton(opener, 'Notes: what Scout remembers about you').props[
        'aria-haspopup'
      ],
    ).toBe('dialog');
  });

  it('names the way back on a connector page, a provider page and computer settings', async () => {
    const sheet = await render(
      <ConnectorSheet
        target={{ kind: 'connector', id: 'id-github' }}
        connectors={[connector({ state: 'connected', tools: [] })]}
        presets={connectorPresets}
        allowStdio
        auth={{
          state: { phase: 'idle' },
          start: noop,
          cancel: noop,
          reset: noop,
        }}
        onClose={noop}
        onSaved={noop}
        onDeleted={noop}
      />,
    );
    getButton(sheet, 'Back to connectors');
    expectEveryButtonNamed(sheet);
    const page = await render(
      <ModelProviderPage
        target={{ kind: 'provider', id: 'p-groq' }}
        providers={[groq]}
        presets={modelPresets}
        defaultModel={null}
        onClose={noop}
        onSaved={noop}
        onDeleted={noop}
        onDefaultChanged={noop}
        onReload={noop}
        onCount={noop}
      />,
    );
    getButton(page, 'Back to models');
    expectEveryButtonNamed(page);
    const computer = await render(
      <SettingsSheet
        id="computer-settings"
        dot={dot}
        status={
          {
            state: 'stopped',
            permissions: { enabled: false, kind: 'browser' },
          } as never
        }
        optimistic={{}}
        notes={{}}
        busy={false}
        hidden={false}
        onSetPermission={noop}
        onStart={noop}
        onStop={noop}
        onClose={noop}
      />,
    );
    getButton(computer, 'Back to the screen');
    expectEveryButtonNamed(computer);
  });

  it('names every button in the connector and model galleries, with the status in the card name', async () => {
    const connectors = await render(
      <ConnectorGallery
        connectors={[connector({ state: 'needs_auth', tools: [] })]}
        presets={connectorPresets}
        allowStdio
        onOpenConnector={noop}
        onConnect={noop}
        onOpenPreset={noop}
        onCustom={noop}
      />,
    );
    getButton(connectors, /^GitHub, Not connected\. Open details$/i);
    expectEveryButtonNamed(connectors);
    const models = await render(
      <ModelProviderGallery
        providers={[groq]}
        presets={modelPresets}
        defaultModel={null}
        counts={{ 'p-groq': 3 }}
        onOpenProvider={noop}
        onOpenPreset={noop}
        onChangeDefault={noop}
      />,
    );
    getButton(models, 'Groq, Ready · 3 models. Open details');
    expectEveryButtonNamed(models);
  });

  it('names every button on approval cards', async () => {
    const card = await render(
      <ApprovalCard
        result={asked}
        approval={approval()}
        onDecide={async () => {}}
      />,
    );
    for (const name of ['Deny', 'Approve', 'Add a note']) getButton(card, name);
    expectEveryButtonNamed(card);
  });

  // A source check, so a new icon-only button anywhere in the client needs a name too.
  it('gives every <button> in the client text, aria-label or aria-labelledby', () => {
    const client = join(__dirname, '..', 'src', 'client');
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith('.tsx') ? [path] : [];
      });
    })(client);
    const nameless: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/<button\b/g)) {
        const end = source.indexOf('</button>', match.index);
        const block = source.slice(match.index, end < 0 ? undefined : end);
        if (/aria-label(ledby)?=|\{\.\.\.\w/.test(block)) continue;
        // The opening tag ends at the first '>' outside braces.
        let depth = 0;
        let at = 0;
        for (; at < block.length; at++) {
          const char = block[at];
          if (char === '{') depth++;
          else if (char === '}') depth--;
          else if (char === '>' && depth === 0) break;
        }
        const inside = withoutTags(block.slice(at + 1), ' ').replace(
          /\{\/\*[\s\S]*?\*\/\}/g,
          ' ',
        );
        // Text, or an expression that renders text (a label variable, a ternary of strings).
        if (/[A-Za-z]{2,}/.test(inside)) continue;
        const line = source.slice(0, match.index).split('\n').length;
        nameless.push(`${file.slice(client.length + 1)}:${line}`);
      }
    }
    expect(nameless).toEqual([]);
  });
});

// ---- Chips ----------------------------------------------------------------------------

describe('status chips are read out', () => {
  it('writes every connector and provider state in words, not colour alone', () => {
    for (const status of [
      { state: 'connected', tools: [] },
      { state: 'needs_auth', tools: [] },
      { state: 'error', tools: [], error: 'Boom' },
      { state: 'missing_env', tools: [], missing: ['TOKEN'] },
      { state: 'disabled', tools: [] },
      { state: 'connecting', tools: [] },
    ] as ConnectorView['status'][]) {
      const html = renderToStaticMarkup(
        <StatusPill status={status} detail={false} />,
      );
      expect(withoutTags(html).trim()).not.toBe('');
    }
    expect(
      withoutTags(
        renderToStaticMarkup(
          <ProviderPill status={{ tone: 'ok', label: 'Ready' }} />,
        ),
      ),
    ).toBe('Ready');
  });

  it('makes the pill on an open connector page a status region, and not the gallery cards', () => {
    const sheet = renderToStaticMarkup(
      <ConnectorSheet
        target={{ kind: 'connector', id: 'id-github' }}
        connectors={[connector({ state: 'needs_auth', tools: [] })]}
        presets={connectorPresets}
        allowStdio
        auth={{
          state: { phase: 'idle' },
          start: noop,
          cancel: noop,
          reset: noop,
        }}
        onClose={noop}
        onSaved={noop}
        onDeleted={noop}
      />,
    );
    expect(sheet).toMatch(
      /<span class="cn-status" role="status"><span class="cn-pill[^"]*"[^>]*>Not connected<\/span>/,
    );
    const gallery = renderToStaticMarkup(
      <ConnectorGallery
        connectors={[connector({ state: 'needs_auth', tools: [] })]}
        presets={connectorPresets}
        allowStdio
        onOpenConnector={noop}
        onConnect={noop}
        onOpenPreset={noop}
        onCustom={noop}
      />,
    );
    expect(gallery).toContain('Not connected');
    expect(gallery).not.toContain('role="status"><span class="cn-pill');
  });

  it('makes the pill on an open provider page a status region', () => {
    const page = renderToStaticMarkup(
      <ModelProviderPage
        target={{ kind: 'provider', id: 'p-groq' }}
        providers={[groq]}
        presets={modelPresets}
        defaultModel={null}
        onClose={noop}
        onSaved={noop}
        onDeleted={noop}
        onDefaultChanged={noop}
        onReload={noop}
        onCount={noop}
      />,
    );
    expect(page).toMatch(
      /<span class="cn-status" role="status"><span class="cn-pill cn-pill-ok"[^>]*>.*?Ready<\/span>/,
    );
  });

  it('announces an approval being answered by changing the same status region', async () => {
    const root = await render(
      <ApprovalCard
        result={asked}
        approval={approval()}
        onDecide={async () => {}}
      />,
    );
    const status = () =>
      root.root.find(
        (node) => node.type === 'span' && node.props.role === 'status',
      );
    const before = status();
    expect(textOf(before)).toBe('Waiting for you');
    await act(async () =>
      root.update(
        <ApprovalCard
          result={asked}
          approval={approval({ status: 'approved' })}
          onDecide={async () => {}}
        />,
      ),
    );
    // Same element, new words: a live region speaks the change, and only the change.
    expect(status()).toBe(before);
    expect(textOf(status())).toBe('Approved');
    expect(renderToStaticMarkup(<ApprovalBadge status="denied" />)).toBe(
      '<span class="approval-badge is-denied" role="status">Denied</span>',
    );
  });

  it('keeps the count of waiting requests in a status region on the approvals page', () => {
    const html = renderToStaticMarkup(
      <ApprovalsView
        approvals={[approval(), approval({ id: 'a2' })]}
        handoffs={[]}
        dots={[dot]}
        conversations={[]}
        onDecide={async () => {}}
        onOpenThread={noop}
        onOpenComputer={noop}
        onDismissHandoff={async () => {}}
      />,
    );
    expect(html).toContain(
      '<div class="approvals-summary" role="status"><span class="approval-badge is-pending">2 to approve</span>',
    );
  });
});
