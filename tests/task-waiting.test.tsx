import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import {
  TaskRow,
  taskWaits,
  type ListedTask,
} from '../src/client/TaskPresentation';
import type { Approval, Handoff } from '../src/shared/types';

const task: ListedTask = {
  id: 't1',
  prompt: 'Check the invoices every morning',
  status: 'running',
  intervalSeconds: null,
  nextRunAt: null,
  createdAt: 1,
  updatedAt: 1,
  error: null,
  lease: null,
  leaseUntil: null,
  threadId: 'thread-1',
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
const handoff = (extra: Partial<Handoff> = {}): Handoff => ({
  id: 'h1',
  dotId: 'dot-1',
  threadId: 'thread-1',
  kind: 'credential',
  reason: 'Sign in',
  status: 'waiting',
  createdAt: 1,
  finishedAt: null,
  controlRequestId: null,
  ...extra,
});
const render = (waits: string[]) =>
  renderToStaticMarkup(
    <TaskRow task={task} onClick={() => {}} waits={waits} />,
  );

it('names what a task waits for, by its thread', () => {
  expect(taskWaits(task, [approval()], [])).toEqual([
    'Waiting for your approval',
  ]);
  expect(taskWaits(task, [], [handoff()])).toEqual([
    'Waiting for you on the computer',
  ]);
  expect(taskWaits(task, [approval()], [handoff()])).toHaveLength(2);
});

it('ignores other threads, decided approvals, finished handoffs and unbound tasks', () => {
  expect(
    taskWaits(
      task,
      [approval({ threadId: 'other' }), approval({ status: 'approved' })],
      [handoff({ threadId: 'other' }), handoff({ status: 'done' })],
    ),
  ).toEqual([]);
  expect(taskWaits({ ...task, threadId: null }, [approval()], [])).toEqual([]);
  expect(
    taskWaits({ ...task, threadId: undefined }, [approval()], [handoff()]),
  ).toEqual([]);
});

it('shows a badge on a waiting task and none otherwise', () => {
  expect(render(['Waiting for your approval'])).toContain(
    'Waiting for your approval',
  );
  expect(render(['Waiting for you on the computer'])).toContain(
    'Waiting for you on the computer',
  );
  expect(render([])).not.toContain('Waiting for');
});
