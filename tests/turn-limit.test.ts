import { expect, it } from 'vitest';
import { NO_TIME_LIMIT_MS } from '../src/server/limits.js';
import { delegationTurnLimit, turnTimers } from '../src/server/turn-limit.js';

const limits = { agentTurnMs: 30_000, agentGraceMs: 5_000 };

function userMessage(turnLimitMs: unknown, source = 'delegation') {
  return {
    id: 'turn',
    role: 'user' as const,
    content: 'Review the notes',
    metadata: { source, turnLimitMs },
  };
}

it('gives ordinary turns their configured wrap-up and stop times', () => {
  expect(turnTimers(limits, [])).toEqual({
    limitMs: 30_000,
    wrapUpMs: 30_000,
    stopMs: 35_000,
  });
});

it('returns no timers for an ordinary turn with no time limit', () => {
  expect(
    turnTimers({ ...limits, agentTurnMs: NO_TIME_LIMIT_MS }, []),
  ).toBeUndefined();
});

it('reads the delegation limit from the most recent user message', () => {
  const older = { ...userMessage(10_000), id: 'previous-turn' };
  const newest = userMessage(18_000);
  const assistant = {
    id: 'answer',
    role: 'assistant' as const,
    content: 'Okay',
  };
  expect(delegationTurnLimit([older, newest, assistant])).toBe(18_000);
  expect(
    delegationTurnLimit([older, userMessage(18_000, 'chat')]),
  ).toBeUndefined();
});

it.each([
  { turnLimitMs: 12_000, wrapUpMs: 9_000 },
  { turnLimitMs: 24_000, wrapUpMs: 19_000 },
])(
  'reserves the smaller of the grace period and one quarter of $turnLimitMs ms',
  ({ turnLimitMs, wrapUpMs }) => {
    expect(turnTimers(limits, [userMessage(turnLimitMs)])).toEqual({
      limitMs: turnLimitMs,
      wrapUpMs,
      stopMs: turnLimitMs,
    });
  },
);

it('clamps finite delegation limits at the no-time-limit boundary', () => {
  const messages = [userMessage(NO_TIME_LIMIT_MS + 10_000)];
  expect(delegationTurnLimit(messages)).toBe(NO_TIME_LIMIT_MS);
  expect(turnTimers(limits, messages)).toBeUndefined();
});

it.each([undefined, '12000', Number.NaN, Infinity, 0, -1])(
  'falls back to the ordinary turn timers for a delegation limit of %s',
  (invalid) => {
    const messages = [userMessage(invalid)];
    expect(delegationTurnLimit(messages)).toBeUndefined();
    expect(turnTimers(limits, messages)).toEqual(turnTimers(limits, []));
  },
);
