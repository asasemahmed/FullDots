import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { ApprovalStore } from '../src/server/approval-store.js';
import { ApprovalService } from '../src/server/approval-service.js';
import { approvalGate, gateParse } from '../src/server/approval-gate.js';
import { classify } from '../src/server/approvals.js';
import {
  composioExact,
  isComposioRead,
} from '../src/server/composio-approval.js';
import { ComputerStore } from '../src/server/computer-store.js';
import { ResumeQueue } from '../src/server/resume-queue.js';
import { ResumeStore } from '../src/server/resume-store.js';
import { TurnRegistry } from '../src/server/turn-registry.js';
import type { ApprovalMode } from '../src/shared/types.js';
import type { TurnBudget } from '../src/server/turn-budget.js';
import { composioTools } from '../src/server/composio-tools.js';

const closers: DatabaseSync[] = [];
afterEach(() => closers.splice(0).forEach((db) => db.close()));

function services() {
  const db = new DatabaseSync(':memory:');
  closers.push(db);
  const approvals = new ApprovalStore(db, () => 1_000_000);
  const resumes = new ResumeQueue({
    store: new ResumeStore(db),
    registry: new TurnRegistry(),
    turn: vi.fn(async () => 'ok'),
    log: () => {},
  });
  const service = new ApprovalService({
    approvals,
    resumes,
    audit: new ComputerStore(db),
    notify: vi.fn(async () => {}),
    ttlMs: 60_000,
    log: () => {},
  });
  return { approvals, service };
}

function gate(mode: ApprovalMode, resume?: string, svc = services()) {
  let call = 0;
  const { middleware } = approvalGate({
    dotId: 'dot',
    dotName: 'Scout',
    threadId: 'thread',
    source: resume ? 'approval' : 'chat',
    ...(resume ? { ref: resume } : {}),
    mode,
    budget: {} as TurnBudget,
    approvals: svc.service,
    handoffs: {
      start: vi.fn(async (input) => ({
        ...input,
        id: 'h',
        status: 'waiting',
        createdAt: 0,
        finishedAt: null,
        controlRequestId: null,
      })),
    },
    mcpInfo: () => undefined,
    parse: gateParse,
  });
  const before = (toolName: string, args: unknown) =>
    middleware.onBeforeToolCall!({} as never, {
      toolCall: {} as never,
      tool: undefined,
      args,
      toolName,
      toolCallId: `call-${++call}`,
    });
  return { svc, before };
}

function skipped(decision: unknown) {
  const result = decision as {
    type?: string;
    result?: Record<string, unknown>;
  };
  expect(result.type).toBe('skip');
  return result.result ?? {};
}

const send = {
  tool: 'composio__GMAIL_SEND_EMAIL',
  args: { to: 'a@b.test', token: 'ghp_secret', note: 'hello' },
};

describe('Composio approvals', () => {
  it('never treats a write or delete as a read because of a word elsewhere in the slug', () => {
    for (const slug of [
      'GOOGLETASKS_DELETE_TASK_LIST',
      'MAILCHIMP_DELETE_LIST',
      'TRELLO_ARCHIVE_LIST',
      'GITHUB_MARK_NOTIFICATIONS_AS_READ',
      'SLACK_SET_READ_CURSOR_IN_A_CONVERSATION',
      'DOCS_SEARCH_AND_REPLACE',
      'X_GET_AND_DELETE',
      'GMAIL_LIST_AND_SEND',
      'GITHUB',
      'READ',
    ]) {
      expect(isComposioRead(slug), slug).toBe(false);
      expect(
        classify({ tool: `composio__${slug}`, args: {} }, 'sensitive'),
        slug,
      ).toMatchObject({ level: 'sensitive', gated: true });
    }
    for (const slug of [
      'GMAIL_FETCH_EMAILS',
      'GITHUB_LIST_REPOSITORIES',
      'GOOGLECALENDAR_GET_EVENT',
      'NOTION_SEARCH_PAGES',
    ])
      expect(isComposioRead(slug), slug).toBe(true);
  });

  it('applies Never rules to deletes that mention a read word', () => {
    expect(
      classify(
        { tool: 'composio__GOOGLETASKS_DELETE_TASK_LIST', args: {} },
        'off',
        { delete_things: 'never' },
      ),
    ).toMatchObject({ gated: true, denied: true });
  });

  it('masks secrets in camelCase keys and known value shapes on the card', () => {
    const text = composioExact('composio__GITHUB_CREATE_ISSUE', {
      title: 'Keep me',
      accessToken: 'one',
      clientSecret: 'two',
      privateKey: 'three',
      auth: 'Basic eHl6',
      jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig',
      awsKey: 'AKIAABCDEFGHIJKLMNOP',
    })!;
    expect(text).toContain('Keep me');
    for (const secret of ['one', 'two', 'three', 'eHl6', 'eyJhbGci', 'AKIA'])
      expect(text, secret).not.toContain(secret);
  });

  it('treats reads as ordinary and everything else as sensitive', () => {
    for (const mode of ['sensitive', 'writes', 'off'] as const) {
      expect(
        classify({ tool: 'composio__GMAIL_FETCH_EMAILS', args: {} }, mode),
      ).toMatchObject({ level: 'none', gated: false });
      expect(
        classify({ tool: 'composio__GMAIL_GET_MESSAGE', args: {} }, mode),
      ).toMatchObject({ level: 'none', gated: false });
    }
    expect(
      classify(
        { tool: 'composio__FINANCE_BUDGET_REPORT', args: {} },
        'sensitive',
      ).level,
    ).toBe('sensitive');
    expect(
      classify({ tool: 'composio__GMAIL_SEND_EMAIL', args: {} }, 'sensitive'),
    ).toMatchObject({ level: 'sensitive', gated: true });
    expect(
      classify({ tool: 'composio__GMAIL_SEND_EMAIL', args: {} }, 'writes')
        .gated,
    ).toBe(true);
    expect(
      classify({ tool: 'composio__GMAIL_SEND_EMAIL', args: {} }, 'off').gated,
    ).toBe(false);
    expect(
      classify({ tool: 'composio__GMAIL_SEND_EMAIL', args: {} }, 'off', {
        send_messages: 'never',
      }),
    ).toMatchObject({ gated: true, denied: true });
  });

  it('holds a write until that approval is used, and shows the app without the secret', async () => {
    const execute = vi.fn(async () => ({ data: { id: 'sent' }, error: null }));
    const tools = await composioTools(
      {
        tools: async () => [
          {
            type: 'function',
            function: {
              name: 'GMAIL_SEND_EMAIL',
              parameters: { type: 'object' },
            },
          },
        ],
        execute,
      } as never,
      () => {},
    );
    const held = gate('sensitive');
    const pending = skipped(await held.before(send.tool, send.args));
    expect(pending.status).toBe('pending_approval');
    expect(pending.summary).toBe('Scout wants to send email in Gmail');
    expect(String(pending.exact)).toContain('Gmail · send email');
    expect(String(pending.exact)).toContain('[hidden]');
    expect(String(pending.exact)).not.toContain('ghp_secret');
    expect(execute).not.toHaveBeenCalled();

    held.svc.approvals.decide(String(pending.approvalId), 'approve');
    const resumed = gate('sensitive', String(pending.approvalId), held.svc);
    expect(await resumed.before(send.tool, send.args)).toBeUndefined();
    await tools[0]?.execute({ to: 'a@b.test' });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('lets a read run in every approval mode and still holds a write in writes', async () => {
    for (const mode of ['sensitive', 'writes', 'off'] as const) {
      const read = gate(mode);
      expect(
        await read.before('composio__GMAIL_FETCH_EMAILS', { q: 'today' }),
      ).toBeUndefined();
    }
    expect(await gate('off').before(send.tool, send.args)).toBeUndefined();
    expect(
      skipped(await gate('writes').before(send.tool, send.args)).status,
    ).toBe('pending_approval');
  });
});
