import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { ApprovalCard } from '../src/client/ApprovalCard';
import { ApprovalsView } from '../src/client/ApprovalsView';
import { Sidebar } from '../src/client/sidebar/Sidebar';
import type {
  Approval,
  ConversationSummary,
  Dot,
  Handoff,
  WorkspaceState,
} from '../src/shared/types';

const dot: Dot = {
  id: 'dot-1',
  spaceId: 'space-1',
  spaceIds: ['space-1'],
  name: 'Scout',
  instructions: 'Help',
  researchAllowed: true,
  memoryAllowed: true,
  createdAt: 1,
};
const chat: ConversationSummary = {
  id: 'thread-1',
  dotId: 'dot-1',
  ownerId: 'owner',
  title: 'Tidy the build folder',
  createdAt: 1,
  updatedAt: null,
  empty: false,
};
const approval = (extra: Partial<Approval> = {}): Approval => ({
  id: 'a1',
  threadId: 'thread-1',
  dotId: 'dot-1',
  toolCallId: 'call-1',
  tool: 'computer_exec',
  argsHash: 'hash',
  summary: 'Delete the folder',
  argsRedacted: 'rm -rf build',
  status: 'pending',
  note: null,
  createdAt: 1,
  expiresAt: 2,
  decidedAt: null,
  consumedAt: null,
  ...extra,
});
const handoff: Handoff = {
  id: 'h1',
  dotId: 'dot-1',
  threadId: 'thread-1',
  kind: 'credential',
  reason: 'Sign in to the bank',
  status: 'waiting',
  createdAt: 1,
  finishedAt: null,
  controlRequestId: null,
};
const noop = async () => {};
const view = (approvals: Approval[], handoffs: Handoff[]) =>
  renderToStaticMarkup(
    <ApprovalsView
      approvals={approvals}
      handoffs={handoffs}
      dots={[dot]}
      conversations={[chat]}
      onDecide={noop}
      onOpenThread={() => {}}
      onOpenComputer={() => {}}
      onDismissHandoff={noop}
    />,
  );

it('lists pending approvals with the Dot, conversation and both labelled parts', () => {
  const html = view([approval()], []);
  expect(html).toContain('Scout');
  expect(html).toContain('Tidy the build folder');
  expect(html).toContain('Delete the folder');
  expect(html).toContain('rm -rf build');
  expect(html).toContain('Exact action');
  expect(html).toMatch(/Dot(&#x27;|&apos;|')s description/);
  expect(html).toContain('>Approve<');
  expect(html).toContain('>Deny<');
  expect(html).toContain('Open conversation');
  expect(html).not.toContain('Nothing is waiting for you.');
});

it('lists waiting handoffs with Open computer and Dismiss', () => {
  const html = view([], [handoff]);
  expect(html).toContain('Your turn on the computer: Sign in to the bank');
  expect(html).toContain('Open computer');
  expect(html).toContain('>Dismiss<');
  expect(html).not.toContain('Nothing is waiting for you.');
});

it('says nothing is waiting when both lists are empty', () => {
  expect(view([], [])).toContain('Nothing is waiting for you.');
});

it('counts approvals in the sidebar footer only when something is waiting', () => {
  const workspace = {
    spaces: [
      {
        id: 'space-1',
        ownerId: 'owner',
        name: 'Everyday',
        description: '',
        createdAt: 1,
      },
    ],
    dots: [dot],
    conversations: [chat],
    setup: { model: true, search: false, voice: false, missing: [] },
    calls: [],
  } as unknown as WorkspaceState;
  const sidebar = (approvalCount?: number) =>
    renderToStaticMarkup(
      <Sidebar
        workspace={workspace}
        dot={dot}
        view="chat"
        spaceId=""
        taskCount={0}
        memoryCount={0}
        approvalCount={approvalCount}
        configured
        collapsed={false}
        onToggleCollapsed={() => {}}
        mobileOpen={false}
        onDismissMobile={() => {}}
        onHome={() => {}}
        onNewChat={() => {}}
        onChooseDot={() => {}}
        onSelectThread={() => {}}
        onRenameThread={async () => true}
        onDeleteThreads={async () => true}
        onOpenPage={() => {}}
        onView={() => {}}
        onDialog={() => {}}
      />,
    );
  expect(sidebar()).toContain('aria-label="Approvals"');
  expect(sidebar()).not.toContain('sb-badge');
  expect(sidebar(3)).toMatch(/class="sb-badge"[^>]*>3</);
  expect(sidebar(3)).toContain('aria-label="Approvals (3)"');
});

const asked = {
  status: 'pending_approval' as const,
  approvalId: 'a1',
  summary: 'Delete the folder',
  exact: 'rm -rf build',
};

it('shows Approve and Deny with a note box while an approval is pending', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard result={asked} onDecide={noop} />,
  );
  expect(html).toContain('>Approve<');
  expect(html).toContain('>Deny<');
  expect(html).toContain('<textarea');
  expect(html).toContain('maxLength="1000"');
});

it('shows a badge instead of buttons once decided', () => {
  const badge = (status: Approval['status']) =>
    renderToStaticMarkup(
      <ApprovalCard
        result={asked}
        approval={approval({ status })}
        onDecide={noop}
      />,
    );
  expect(badge('consumed')).toContain('Done');
  expect(badge('approved')).toContain('Approved');
  expect(badge('denied')).toContain('Denied');
  expect(badge('expired')).toContain('Expired');
  expect(badge('consumed')).not.toContain('>Approve<');
});

it('marks advisory requests and truncates a long exact action behind Show more', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{ ...asked, advisory: true, exact: 'x'.repeat(700) }}
      onDecide={noop}
    />,
  );
  expect(html).toContain('(advisory)');
  expect(html).toContain('Show more');
  expect(html).not.toContain('x'.repeat(601));
});
