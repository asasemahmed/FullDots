import { afterEach, expect, it, vi } from 'vitest';
import { codingProgress } from '../src/server/agents/coding-progress.js';
afterEach(() => vi.useRealTimers());

it('coalesces rapid chunks into one bounded tool-progress snapshot per second', () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const progress = codingProgress('session', emit);
  for (const text of ['one', 'two', 'three', 'four']) progress.write(text);
  expect(emit).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1000);
  expect(emit).toHaveBeenCalledExactlyOnceWith({
    codingSessionId: 'session',
    text: 'onetwothreefour',
    status: 'running',
  });
  progress.write('tail');
  progress.finish('completed');
  expect(emit).toHaveBeenLastCalledWith({
    codingSessionId: 'session',
    text: 'onetwothreefourtail',
    status: 'completed',
  });
  vi.advanceTimersByTime(5000);
  expect(emit).toHaveBeenCalledTimes(2);
});

it('caps cumulative progress and flushes the final status without extra assistant messages', () => {
  vi.useFakeTimers();
  const emit = vi.fn();
  const progress = codingProgress('session', emit);
  progress.write('x'.repeat(50_000));
  progress.write('ignored');
  progress.finish('timed_out');
  expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0][0]).toMatchObject({
    status: 'timed_out',
    codingSessionId: 'session',
  });
  expect(emit.mock.calls[0][0].text).toHaveLength(40_000);
  progress.finish('completed');
  progress.write('later');
  vi.advanceTimersByTime(5000);
  expect(emit).toHaveBeenCalledTimes(1);
});
