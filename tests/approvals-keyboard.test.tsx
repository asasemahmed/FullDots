// Keyboard focus on approval cards: answering one must not drop focus on the page body.
import type { ReactElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(() => new Promise(() => {})),
  authHeaders: () => ({}),
}));
import { ApprovalCard } from '../src/client/ApprovalCard';
import { ApprovalsView } from '../src/client/ApprovalsView';
import type { ApprovalToolResult } from '../src/client/chat-turns';
import type { Approval, Dot } from '../src/shared/types';
import { FakeDocument, FakeElement, mountTree } from './fixtures/fake-dom';

const noop = () => {};
let doc: FakeDocument;
let dom: ReturnType<typeof mountTree>;
const roots: ReactTestRenderer[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', FakeElement);
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
const dot = { id: 'dot-1', name: 'Scout' } as Dot;

const button = (root: ReactTestRenderer, text: string) =>
  root.root.find(
    (node) =>
      node.type === 'button' && [node.props.children].flat(3).includes(text),
  );

describe('approval cards and the keyboard', () => {
  it('moves focus into the note field that replaces "Add a note"', async () => {
    const root = await render(
      <ApprovalCard
        result={asked}
        approval={approval()}
        onDecide={async () => {}}
      />,
    );
    const add = button(root, 'Add a note');
    dom.el(add).focus();
    await act(async () => add.props.onClick());
    dom.sync();
    expect(doc.activeElement.tagName).toBe('TEXTAREA');
  });

  it('keeps focus on the chat card once it is answered', async () => {
    const card = (status: Approval['status']) => (
      <ApprovalCard
        result={asked}
        approval={approval({ status })}
        onDecide={async () => {}}
      />
    );
    const root = await render(card('pending'));
    dom.el(button(root, 'Approve')).focus();
    await act(async () => root.update(card('approved')));
    dom.sync();
    expect(doc.activeElement.getAttribute('aria-label')).toBe(
      'Approval request',
    );
  });

  it('moves focus to the next waiting card, then to the heading, on the approvals page', async () => {
    const page = (approvals: Approval[]) => (
      <ApprovalsView
        approvals={approvals}
        handoffs={[]}
        dots={[dot]}
        conversations={[]}
        onDecide={async () => {}}
        onOpenThread={noop}
        onOpenComputer={noop}
        onDismissHandoff={async () => {}}
      />
    );
    const first = approval({ id: 'a1', summary: 'First' });
    const second = approval({ id: 'a2', summary: 'Second' });
    const root = await render(page([first, second]));
    const approve = root.root.findAll(
      (node) =>
        node.type === 'button' &&
        [node.props.children].flat(3).includes('Approve'),
    );
    dom.el(approve[0]!).focus();
    await act(async () => root.update(page([second])));
    dom.sync();
    // The card in its place, never its Approve button.
    expect(doc.activeElement.tagName).toBe('LI');
    const summary = dom.el(
      root.root.find(
        (node) => node.type === 'dd' && node.props.children === 'Second',
      ),
    );
    expect(doc.activeElement.contains(summary)).toBe(true);
    await act(async () => root.update(page([])));
    dom.sync();
    expect(doc.activeElement.tagName).toBe('H1');
  });

  it('leaves focus alone when it was somewhere else', async () => {
    const elsewhere = doc.createElement('button');
    doc.body.append(elsewhere);
    const page = (approvals: Approval[]) => (
      <ApprovalsView
        approvals={approvals}
        handoffs={[]}
        dots={[dot]}
        conversations={[]}
        onDecide={async () => {}}
        onOpenThread={noop}
        onOpenComputer={noop}
        onDismissHandoff={async () => {}}
      />
    );
    const root = await render(page([approval()]));
    elsewhere.focus();
    await act(async () => root.update(page([])));
    expect(doc.activeElement).toBe(elsewhere);
  });
});
