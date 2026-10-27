import { renderToStaticMarkup } from 'react-dom/server';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({ api: vi.fn() }));
import { api } from '../src/client/api';
import { ApprovalCard, ApprovalDecision } from '../src/client/ApprovalCard';
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
  expect(html).not.toContain('Nothing is waiting for you');
});

it('lists waiting handoffs with Open computer and Dismiss', () => {
  const html = view([], [handoff]);
  expect(html).toContain('Your turn on the computer');
  expect(html).toContain('Sign in to the bank');
  expect(html).toContain('Open computer');
  expect(html).toContain('>Dismiss<');
  expect(html).not.toContain('Nothing is waiting for you');
});

it('shows a calm empty state when both lists are empty', () => {
  const html = view([], []);
  expect(html).toContain('Nothing is waiting for you');
  expect(html).toContain(
    'When a Dot needs your approval or your help on the computer, it shows up here.',
  );
  expect(html).toContain('Actions and sign-ins waiting for you');
  expect(html).not.toContain('Waiting for approval');
});

it('titles the page and counts what is waiting in each section', () => {
  const html = view([approval(), approval({ id: 'a2' })], [handoff]);
  expect(html).toContain('<h1>Approvals</h1>');
  expect(html).toContain('Actions and sign-ins waiting for you');
  expect(html).toMatch(/Waiting for approval<span[^>]*>2</);
  expect(html).toMatch(/Your turn on the computer<span[^>]*>1</);
  expect(html).toContain('2 to approve');
  expect(html).toContain('1 on the computer');
});

it('lists decided approvals as a muted recent list', () => {
  const html = view(
    [approval({ id: 'a2', status: 'denied', decidedAt: 5 })],
    [],
  );
  expect(html).toContain('Recently decided');
  expect(html).toContain('Denied');
  expect(html).toContain('Nothing is waiting for you');
  expect(html).not.toContain('>Approve<');
});

it('counts what needs the owner on the sidebar Inbox only when something is waiting', () => {
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
        onExportThread={async () => {}}
        onOpenPage={() => {}}
        onOpenFile={() => {}}
        onView={() => {}}
        onDialog={() => {}}
      />,
    );
  expect(sidebar()).toContain('aria-label="Inbox"');
  expect(sidebar()).not.toContain('sb-badge');
  // Amber, like every other count of what waits for the owner.
  expect(sidebar(3)).toMatch(/class="sb-badge needs"[^>]*>3</);
  expect(sidebar(3)).toContain('aria-label="Inbox (3)"');
});

const asked = {
  status: 'pending_approval' as const,
  approvalId: 'a1',
  summary: 'Delete the folder',
  exact: 'rm -rf build',
};

it('shows Approve and Deny and the amber chip while an approval is pending', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard result={asked} onDecide={noop} />,
  );
  expect(html).toContain('Needs your approval');
  expect(html).toContain('approval-badge is-pending');
  expect(html).toContain('Waiting for you');
  expect(html).toContain('>Approve<');
  expect(html).toContain('>Deny<');
  expect(html).toContain('<pre class="approval-exact">rm -rf build</pre>');
});

it('keeps the note behind Add a note, then offers a limited textarea with a counter', () => {
  const closed = renderToStaticMarkup(
    <ApprovalCard result={asked} onDecide={noop} />,
  );
  expect(closed).toContain('Add a note');
  expect(closed).not.toContain('<textarea');
  const open = renderToStaticMarkup(
    <ApprovalDecision id="a1" onDecide={noop} defaultNoteOpen />,
  );
  expect(open).toContain('<textarea');
  expect(open).toContain('maxLength="1000"');
  expect(open).toContain('0/1000');
  expect(open).not.toContain('Add a note');
});

it('shows the connector line above the exact action for MCP tools', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{ ...asked, exact: '{"title":"Crash"}' }}
      approval={approval({
        tool: 'mcp__github__create_issue',
        argsRedacted: '{"title":"Crash"}',
      })}
      onDecide={noop}
    />,
  );
  expect(html).toContain('github · create_issue');
  expect(html).toContain('connector-logo');
  expect(html.indexOf('github · create_issue')).toBeLessThan(
    html.indexOf('{&quot;title&quot;'),
  );
  const shell = renderToStaticMarkup(
    <ApprovalCard result={asked} approval={approval()} onDecide={noop} />,
  );
  expect(shell).not.toContain('connector-logo');
});

it('renders a handoff as a card with Open live computer and the safety hint', () => {
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{
        status: 'handoff',
        handoffId: 'h1',
        kind: 'credential',
        reason: 'Enter your password',
      }}
      onViewComputer={() => {}}
    />,
  );
  expect(html).toContain('Your turn on the computer');
  expect(html).toContain('Enter your password');
  expect(html).toContain('never paste it into the chat');
  expect(html).toContain('Open live computer');
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
  expect(html).toContain('>Advisory<');
  expect(html).toContain('This approval does not unlock a specific action.');
  expect(html).toContain('Show more');
  expect(html).not.toContain('x'.repeat(601));
});

it('shows multiline pending desktop_type proposed text with count and preserves newlines and tabs', () => {
  const multiline = 'echo "first line"\n\techo "indented"\nexit 0';
  const row = approval({
    tool: 'desktop_type',
    argsPreview: multiline,
    expiresAt: Date.now() + 60_000,
  });
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{
        status: 'pending_approval',
        approvalId: row.id,
        summary: row.summary,
        exact: row.argsRedacted,
      }}
      approval={row}
      onDecide={noop}
    />,
  );
  expect(html).toContain(
    '<pre class="approval-exact">echo &quot;first line&quot;\n\techo &quot;indented&quot;\nexit 0</pre>',
  );
  expect(html).toContain(`${multiline.length} characters`);
  expect(html).not.toContain('Show more');
});

it('clips proposed text longer than 2,000 characters and shows first 2,000 of N characters without Show more', () => {
  const prefix = 'x'.repeat(2000);
  const excess = 'y'.repeat(500);
  const fullText = prefix + excess;
  const row = approval({
    tool: 'desktop_type',
    argsPreview: fullText,
    expiresAt: Date.now() + 60_000,
  });
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{
        status: 'pending_approval',
        approvalId: row.id,
        summary: row.summary,
        exact: row.argsRedacted,
      }}
      approval={row}
      onDecide={noop}
    />,
  );
  expect(html).toContain('first 2,000 of 2,500 characters');
  expect(html).toContain(prefix);
  expect(html).not.toContain(excess);
  expect(html).not.toContain('Show more');
});

it('escapes control chars (C0/C1 excluding LF and TAB) and bidi/format controls as literal \\uXXXX', () => {
  const dangerous =
    'cmd\x00\x1b\x0d\x7f\x80\x9f\u202e\u200e\u2066\ufeff\u200barg\n\ttab';
  const row = approval({
    tool: 'desktop_type',
    argsPreview: dangerous,
    expiresAt: Date.now() + 60_000,
  });
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{
        status: 'pending_approval',
        approvalId: row.id,
        summary: row.summary,
        exact: row.argsRedacted,
      }}
      approval={row}
      onDecide={noop}
    />,
  );
  expect(html).toContain('\\u0000');
  expect(html).toContain('\\u001B');
  expect(html).toContain('\\u000D');
  expect(html).toContain('\\u007F');
  expect(html).toContain('\\u0080');
  expect(html).toContain('\\u009F');
  expect(html).toContain('\\u202E');
  expect(html).toContain('\\u200E');
  expect(html).toContain('\\u2066');
  expect(html).toContain('\\uFEFF');
  expect(html).toContain('\\u200B');
  expect(html).not.toContain('\x00');
  expect(html).not.toContain('\x1b');
  expect(html).not.toContain('\x7f');
  expect(html).not.toContain('\x80');
  expect(html).not.toContain('\x9f');
  expect(html).not.toContain('\u202e');
  expect(html).not.toContain('\ufeff');
  expect(html).toContain('\n\ttab');
});

it('omits preview for finished, stale, or expired approvals even if argsPreview remains on props', () => {
  const previewText = 'printf "stale"';
  for (const status of ['approved', 'denied', 'consumed', 'expired'] as const) {
    const html = renderToStaticMarkup(
      <ApprovalCard
        result={asked}
        approval={approval({
          tool: 'desktop_type',
          argsPreview: previewText,
          status,
          expiresAt: Date.now() + 60_000,
        })}
        onDecide={noop}
      />,
    );
    expect(html).not.toContain(previewText);
    expect(html).not.toContain('characters');
  }

  const pastHtml = renderToStaticMarkup(
    <ApprovalCard
      result={asked}
      approval={approval({
        tool: 'desktop_type',
        argsPreview: previewText,
        status: 'pending',
        expiresAt: Date.now() - 5000,
      })}
      onDecide={noop}
    />,
  );
  expect(pastHtml).not.toContain(previewText);
  expect(pastHtml).not.toContain('characters');

  const initialHtml = renderToStaticMarkup(
    <ApprovalCard result={asked} onDecide={noop} />,
  );
  expect(initialHtml).not.toContain(previewText);
  expect(initialHtml).not.toContain('characters');

  const execHtml = renderToStaticMarkup(
    <ApprovalCard
      result={asked}
      approval={approval({
        tool: 'computer_exec',
        argsPreview: previewText,
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      })}
      onDecide={noop}
    />,
  );
  expect(execHtml).not.toContain('characters');
});

it('renders desktop preview in ApprovalsView waiting list', () => {
  const row = approval({
    tool: 'desktop_type',
    argsPreview: 'echo "approvals view test"',
    expiresAt: Date.now() + 60_000,
  });
  const html = view([row], []);
  expect(html).toContain('echo &quot;approvals view test&quot;');
  expect(html).toContain('26 characters');
});

it('fetches pending preview via owner approval API when row lacks argsPreview and clears on decision or expiry', async () => {
  const mockedApi = vi.mocked(api);
  const row = approval({
    id: 'desktop-fetch-1',
    tool: 'desktop_type',
    argsPreview: undefined,
    expiresAt: Date.now() + 2000,
  });

  mockedApi.mockResolvedValueOnce({
    ...row,
    argsPreview: 'cat /etc/os-release',
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row.id,
          summary: row.summary,
          exact: row.argsRedacted,
        }}
        approval={row}
        onDecide={noop}
      />,
    );
  });

  expect(mockedApi).toHaveBeenCalledWith(
    '/approvals/desktop-fetch-1',
    'GET',
    undefined,
    expect.any(AbortSignal),
  );

  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('cat /etc/os-release');
  expect(text).toContain('19 characters');

  // Clearing preview on decision
  await act(async () => {
    renderer.update(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row.id,
          summary: row.summary,
          exact: row.argsRedacted,
        }}
        approval={{ ...row, status: 'approved' }}
        onDecide={noop}
      />,
    );
  });
  const decidedText = JSON.stringify(renderer.toJSON());
  expect(decidedText).not.toContain('cat /etc/os-release');

  renderer.unmount();
});

it('shows plain inability-to-load hint on fetch failure without exposing text while decisions remain functional', async () => {
  const mockedApi = vi.mocked(api);
  const row = approval({
    id: 'desktop-fail-1',
    tool: 'desktop_type',
    argsPreview: undefined,
    expiresAt: Date.now() + 60_000,
  });

  mockedApi.mockRejectedValueOnce(new Error('Internal server error'));

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row.id,
          summary: row.summary,
          exact: row.argsRedacted,
        }}
        approval={row}
        onDecide={noop}
      />,
    );
  });

  const text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('Could not load preview.');
  // Decision buttons remain functional
  expect(text).toContain('Approve');
  expect(text).toContain('Deny');

  renderer.unmount();
});

it('clears preview when expiry timer triggers even if parent does not poll', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  try {
    const expiresAt = Date.now() + 500;
    const row = approval({
      id: 'desktop-timer-1',
      tool: 'desktop_type',
      argsPreview: 'echo "timer test"',
      expiresAt,
    });

    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = create(
        <ApprovalCard
          result={{
            status: 'pending_approval',
            approvalId: row.id,
            summary: row.summary,
            exact: row.argsRedacted,
          }}
          approval={row}
          onDecide={noop}
        />,
      );
    });

    let text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('timer test');

    // Advance timer past expiresAt
    act(() => {
      vi.advanceTimersByTime(600);
    });

    text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain('timer test');
    expect(text).not.toContain('characters');

    renderer.unmount();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it('renders empty preview string as empty pre with 0 characters', () => {
  const row = approval({
    tool: 'desktop_type',
    argsPreview: '',
    expiresAt: Date.now() + 60_000,
  });
  const html = renderToStaticMarkup(
    <ApprovalCard
      result={{
        status: 'pending_approval',
        approvalId: row.id,
        summary: row.summary,
        exact: row.argsRedacted,
      }}
      approval={row}
      onDecide={noop}
    />,
  );
  expect(html).toContain('<pre class="approval-exact"></pre>');
  expect(html).toContain('0 characters');
});

it('fails closed for missing or nonfinite expiresAt and past expiry', () => {
  const invalidExpiries = [
    undefined,
    null as unknown as number,
    NaN,
    Infinity,
    -Infinity,
    Date.now() - 1000,
  ];

  for (const exp of invalidExpiries) {
    const row = approval({
      tool: 'desktop_type',
      argsPreview: 'echo "should fail closed"',
      expiresAt: exp,
    });
    const html = renderToStaticMarkup(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row.id,
          summary: row.summary,
          exact: row.argsRedacted,
        }}
        approval={row}
        onDecide={noop}
      />,
    );
    expect(html).not.toContain('should fail closed');
    expect(html).not.toContain('characters');
  }
});

it('keys fetched preview to approval ID and ignores late fetches from previous IDs', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const mockedApi = vi.mocked(api);

  let resolve1!: (val: Approval) => void;
  let resolve2!: (val: Approval) => void;
  const p1 = new Promise<Approval>((res) => {
    resolve1 = res;
  });
  const p2 = new Promise<Approval>((res) => {
    resolve2 = res;
  });

  mockedApi.mockImplementation((path) => {
    if (path.includes('row-id-1')) return p1;
    if (path.includes('row-id-2')) return p2;
    return Promise.reject(new Error('Unknown'));
  });

  const row1 = approval({
    id: 'row-id-1',
    tool: 'desktop_type',
    argsPreview: undefined,
    expiresAt: Date.now() + 60_000,
  });
  const row2 = approval({
    id: 'row-id-2',
    tool: 'desktop_type',
    argsPreview: undefined,
    expiresAt: Date.now() + 60_000,
  });

  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row1.id,
          summary: row1.summary,
          exact: row1.argsRedacted,
        }}
        approval={row1}
        onDecide={noop}
      />,
    );
  });

  // Switch to row2 while row1 fetch is still pending
  await act(async () => {
    renderer.update(
      <ApprovalCard
        result={{
          status: 'pending_approval',
          approvalId: row2.id,
          summary: row2.summary,
          exact: row2.argsRedacted,
        }}
        approval={row2}
        onDecide={noop}
      />,
    );
  });

  // Now resolve late fetch for row1
  await act(async () => {
    resolve1({
      ...row1,
      argsPreview: 'row-1 late secret command',
    });
  });

  // Row 2 must NEVER show row 1's fetched text
  let text = JSON.stringify(renderer.toJSON());
  expect(text).not.toContain('row-1 late secret command');

  // Now resolve fetch for row2
  await act(async () => {
    resolve2({
      ...row2,
      argsPreview: 'row-2 intended command',
    });
  });

  text = JSON.stringify(renderer.toJSON());
  expect(text).toContain('row-2 intended command');
  expect(text).not.toContain('row-1 late secret command');

  renderer.unmount();
  vi.unstubAllGlobals();
});

it('clears fetched preview state when expiry timer fires', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const mockedApi = vi.mocked(api);

  try {
    const expiresAt = Date.now() + 400;
    const row = approval({
      id: 'fetch-expiry-row',
      tool: 'desktop_type',
      argsPreview: undefined,
      expiresAt,
    });

    mockedApi.mockResolvedValueOnce({
      ...row,
      argsPreview: 'fetched text to expire',
    });

    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <ApprovalCard
          result={{
            status: 'pending_approval',
            approvalId: row.id,
            summary: row.summary,
            exact: row.argsRedacted,
          }}
          approval={row}
          onDecide={noop}
        />,
      );
    });

    let text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('fetched text to expire');

    // Advance past expiresAt
    act(() => {
      vi.advanceTimersByTime(500);
    });

    text = JSON.stringify(renderer.toJSON());
    expect(text).not.toContain('fetched text to expire');
    expect(text).not.toContain('characters');

    renderer.unmount();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
