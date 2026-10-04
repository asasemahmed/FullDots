import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Observable } from 'rxjs';
import { AbstractAgent, type BaseEvent } from '@ag-ui/client';
import { EventType, type RunAgentInput } from '@ag-ui/core';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { runThreadTurn } from '../src/server/headless.js';
import { titleFromFirstMessage } from '../src/server/workspace-routes.js';
import type { WorkspaceState } from '../src/shared/types.js';

class ReplyAgent extends AbstractAgent {
  release = () => {};
  private onReady = () => {};
  ready = new Promise<void>((resolve) => (this.onReady = resolve));
  /** When gated, the run stays open until `release()` is called. */
  constructor(private gated = false) {
    super({ agentId: 'dot-1' });
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable((subscriber) => {
      const messageId = `reply-${input.runId}`;
      const emit = (...events: object[]) =>
        events.forEach((event) => subscriber.next(event as BaseEvent));
      emit({
        type: EventType.RUN_STARTED,
        threadId: input.threadId,
        runId: input.runId,
      });
      const finish = () => {
        emit(
          { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'Done' },
          { type: EventType.TEXT_MESSAGE_END, messageId },
          {
            type: EventType.RUN_FINISHED,
            threadId: input.threadId,
            runId: input.runId,
          },
        );
        subscriber.complete();
      };
      this.onReady();
      if (this.gated) this.release = finish;
      else finish();
    });
  }
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function fixture(ownerToken?: string, workspacePath = ':memory:') {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(workspacePath, 'owner');
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
  });
  cleanup.push(async () => {
    await platform.stop();
    store.close();
    ws.close();
  });
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
    ownerToken,
  });
  return { ws, platform, app, dot: ws.dots()[0] };
}
const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const workspace = async (app: ReturnType<typeof fixture>['app']) =>
  (await (await app.request('/api/workspace')).json()) as WorkspaceState;
const say = (
  platform: Platform,
  threadId: string,
  agent = new ReplyAgent(),
  text = 'Hello',
) =>
  runThreadTurn(
    platform.runner,
    agent,
    threadId,
    text,
    AbortSignal.timeout(5000),
  );

it('renames a conversation with a trimmed single-line title', async () => {
  const { ws, app, dot } = fixture();
  ws.bindThread('t1', dot.id, 'A new thought');
  const response = await app.request(
    '/api/conversations/t1',
    json('PATCH', { title: '  Plan   the\n launch  ' }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    id: 't1',
    title: 'Plan the launch',
  });
  expect(ws.requireThread('t1').title).toBe('Plan the launch');
  expect((await workspace(app)).conversations[0].title).toBe('Plan the launch');
});

it('rejects invalid titles and unknown conversations on rename', async () => {
  const { ws, app, dot } = fixture();
  ws.bindThread('t1', dot.id, 'Keep me');
  for (const body of [
    { title: '' },
    { title: '   ' },
    { title: 'x'.repeat(121) },
    { title: 7 },
    { name: 'Wrong key' },
    { title: 'Fine', extra: true },
  ])
    expect(
      (await app.request('/api/conversations/t1', json('PATCH', body))).status,
    ).toBe(400);
  expect(
    (
      await app.request('/api/conversations/t1', {
        ...json('PATCH'),
        body: '{not json',
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        '/api/conversations/t1',
        json('PATCH', { title: 'x'.repeat(120) }),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        '/api/conversations/missing',
        json('PATCH', { title: 'Hello' }),
      )
    ).status,
  ).toBe(404);
});

it("never renames or deletes another owner's conversation", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fulldots-conversations-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workspace.sqlite');
  const { app, dot } = fixture(undefined, path);
  const other = new WorkspaceStore(path, 'someone-else');
  cleanup.push(() => other.close());
  other.bindThread('foreign', dot.id, 'Private');
  expect(
    (
      await app.request(
        '/api/conversations/foreign',
        json('PATCH', { title: 'Mine now' }),
      )
    ).status,
  ).toBe(404);
  expect(
    (await app.request('/api/conversations/foreign', json('DELETE'))).status,
  ).toBe(404);
  expect(other.requireThread('foreign').title).toBe('Private');
});

it('requires the owner token and a same-origin request', async () => {
  const { ws, app, dot } = fixture('secret-token');
  ws.bindThread('t1', dot.id, 'Locked');
  const patch = json('PATCH', { title: 'Changed' });
  expect((await app.request('/api/conversations/t1', patch)).status).toBe(401);
  expect(
    (await app.request('/api/conversations/t1', json('DELETE'))).status,
  ).toBe(401);
  const authorized = {
    ...patch,
    headers: { ...patch.headers, Authorization: 'Bearer secret-token' },
  };
  expect(
    (
      await app.request('/api/conversations/t1', {
        ...authorized,
        headers: { ...authorized.headers, Origin: 'https://evil.example' },
      })
    ).status,
  ).toBe(403);
  expect((await app.request('/api/conversations/t1', authorized)).status).toBe(
    200,
  );
});

it('deletes a conversation with its history and links, and nothing else', async () => {
  const { ws, platform, app, dot } = fixture();
  ws.bindThread('doomed', dot.id, 'Doomed');
  ws.bindThread('bystander', dot.id, 'Bystander');
  await say(platform, 'doomed');
  await say(platform, 'bystander');
  ws.saveCapture('doomed', { text: 'result', sources: [], sample: false });
  ws.saveCapture('bystander', { text: 'other', sources: [], sample: false });
  ws.bindTask('task-1', 'doomed');
  ws.bindTask('task-2', 'bystander');
  const call = ws.createCall('doomed');
  ws.setCall(call.id, 'ended', 'transcript');
  const page = ws.pages.create(dot.spaceId, {
    title: 'Notes',
    content: 'Body',
  });
  ws.pages.reserveThread(page.id, dot.id, 'doomed');
  ws.pages.finishThread(page.id, dot.id);
  const sourced = ws.pages.createReviewed(
    dot.spaceId,
    { title: 'Saved', content: 'From chat' },
    'doomed',
    'tool-call-1',
  );

  const response = await app.request(
    '/api/conversations/doomed',
    json('DELETE'),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ deleted: 'doomed' });

  expect(ws.conversations().map((c) => c.id)).toEqual(['bystander']);
  expect(() => ws.requireThread('doomed')).toThrow();
  expect(ws.calls()).toEqual([]);
  expect(ws.taskThread('task-1')).toBeUndefined();
  expect(ws.taskThread('task-2')).toBe('bystander');
  expect(ws.pages.thread(page.id, dot.id)).toBeUndefined();
  expect(ws.pages.reviewReceipt('doomed', 'tool-call-1')).toBeNull();
  // Pages are the user's content: they stay, minus the dangling provenance.
  expect(ws.pages.get(dot.spaceId, page.id).title).toBe('Notes');
  expect(ws.pages.get(dot.spaceId, sourced.id).sourceThreadId).toBeNull();
  expect(ws.capture('bystander')).toMatchObject({ text: 'other' });
  expect(platform.runner.getThreadMessages('doomed')).toEqual([]);
  expect(platform.runner.getThreadEvents('doomed')).toEqual([]);
  expect(platform.runner.listThreads().map((t) => t.id)).toEqual(['bystander']);
  expect(
    (await app.request('/api/conversations/doomed', json('DELETE'))).status,
  ).toBe(404);
});

it('refuses to delete a running conversation and removes nothing', async () => {
  const { ws, platform, app, dot } = fixture();
  ws.bindThread('busy', dot.id, 'Busy');
  ws.saveCapture('busy', { text: 'kept', sources: [], sample: false });
  const agent = new ReplyAgent(true);
  const turn = say(platform, 'busy', agent);
  await agent.ready;

  const refused = await app.request('/api/conversations/busy', json('DELETE'));
  expect(refused.status).toBe(409);
  expect(ws.requireThread('busy').title).toBe('Busy');
  expect(ws.capture('busy')).toMatchObject({ text: 'kept' });
  // A streaming first reply is not stored yet, so it must not look empty.
  expect((await workspace(app)).conversations[0].empty).toBe(false);

  agent.release();
  await turn;
  expect(
    (await app.request('/api/conversations/busy', json('DELETE'))).status,
  ).toBe(200);
  expect(ws.conversations()).toEqual([]);
});

it('refuses to delete while a call is in progress but not after it ends', async () => {
  const { ws, app, dot } = fixture();
  ws.bindThread('calling', dot.id, 'On a call');
  const call = ws.createCall('calling');
  expect(
    (await app.request('/api/conversations/calling', json('DELETE'))).status,
  ).toBe(409);
  expect(ws.calls('calling')).toHaveLength(1);
  // A call left unended long ago (crashed server) must not block forever.
  expect(ws.hasLiveCall('calling', call.startedAt + 61 * 60 * 1000)).toBe(
    false,
  );
  ws.setCall(call.id, 'ended', '');
  expect(
    (await app.request('/api/conversations/calling', json('DELETE'))).status,
  ).toBe(200);
});

it('lists activity so the sidebar can order chats and hide empty ones', async () => {
  const { ws, platform, app, dot } = fixture();
  ws.bindThread('talked', dot.id, 'Talked');
  ws.bindThread('blank', dot.id, 'A new thought');
  ws.bindThread('scheduled', dot.id, 'Scheduled');
  ws.bindTask('task-1', 'scheduled');
  await say(platform, 'talked');
  const byId = Object.fromEntries(
    (await workspace(app)).conversations.map((c) => [c.id, c]),
  );
  expect(byId.talked.empty).toBe(false);
  expect(byId.talked.updatedAt).toBeGreaterThan(0);
  expect(byId.blank).toMatchObject({ empty: true, updatedAt: null });
  expect(byId.scheduled).toMatchObject({ empty: false, updatedAt: null });
});

it('titles an untitled conversation from the first message only', async () => {
  const { ws, platform, dot } = fixture();
  ws.bindThread('fresh', dot.id, 'A new thought');
  ws.bindThread('named', dot.id, 'Kept title');
  const run = (threadId: string, content: unknown, path = '/run') =>
    titleFromFirstMessage(
      platform,
      new Request(
        `http://127.0.0.1/api/copilotkit/agent/${dot.id}${path}`,
        json('POST', {
          threadId,
          messages: [
            { id: 's', role: 'system', content: 'ignore me' },
            { id: 'm', role: 'user', content },
          ],
        }),
      ),
    );
  await run('named', 'Something else');
  expect(ws.requireThread('named').title).toBe('Kept title');
  await run('fresh', 'x', '/connect');
  expect(ws.requireThread('fresh').title).toBe('A new thought');
  await run('fresh', [
    { type: 'text', text: '  Summarise\nthe quarterly   report ' },
  ]);
  expect(ws.requireThread('fresh').title).toBe('Summarise');
  await run('fresh', 'Later message');
  expect(ws.requireThread('fresh').title).toBe('Summarise');
  await run('missing', 'Ignored');
  const garbage = new Request(
    `http://127.0.0.1/api/copilotkit/agent/${dot.id}/run`,
    { method: 'POST', body: 'not json' },
  );
  await expect(
    titleFromFirstMessage(platform, garbage),
  ).resolves.toBeUndefined();
});
