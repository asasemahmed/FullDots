import { expect, it } from 'vitest';
import {
  defaultLimits,
  hasTimeLimit,
  NO_TIME_LIMIT_MS,
  readLimits,
} from '../src/server/limits.js';
import { computerInputSchemas } from '../src/shared/computer-types.js';

it('keeps the original limits when nothing is configured', () => {
  expect(readLimits({})).toEqual(defaultLimits);
});

it('reads generous limits from the environment in seconds and characters', () => {
  const limits = readLimits({
    AGENT_TURN_TIMEOUT: '600',
    AGENT_MAX_STEPS: '30',
    AGENT_MAX_TOKENS: '8000',
    TASK_TIMEOUT: '900',
    COMPUTER_EXEC_MAX_TIMEOUT: '600',
    COMPUTER_COMMAND_MAX_CHARS: '32000',
    COMPUTER_FILE_MAX_CHARS: '1000000',
    COMPUTER_RESPONSE_MAX_MB: '16',
  });
  expect(limits).toMatchObject({
    agentTurnMs: 600_000,
    agentMaxSteps: 30,
    agentMaxTokens: 8000,
    taskTimeoutMs: 900_000,
    execMaxMs: 600_000,
    commandChars: 32_000,
    fileChars: 1_000_000,
    computerResponseBytes: 16_000_000,
  });
  // A computer request always outlives the longest shell command.
  expect(limits.computerRequestMs).toBe(610_000);
});

it('rejects values beyond what the OpenBot computer accepts, or malformed values', () => {
  expect(() => readLimits({ COMPUTER_EXEC_MAX_TIMEOUT: '601' })).toThrow(
    'COMPUTER_EXEC_MAX_TIMEOUT',
  );
  expect(() => readLimits({ COMPUTER_FILE_MAX_CHARS: '2000000' })).toThrow();
  expect(() => readLimits({ AGENT_MAX_STEPS: 'many' })).toThrow();
  expect(() => readLimits({ AGENT_TURN_TIMEOUT: '-1' })).toThrow();
  expect(() => readLimits({ AGENT_TURN_TIMEOUT: '7201' })).toThrow();
  expect(() => readLimits({ TASK_TIMEOUT: '1.5' })).toThrow();
  expect(() => readLimits({ AGENT_MAX_STEPS: '1001' })).toThrow();
  expect(() => readLimits({ AGENT_MAX_STEPS: '0' })).toThrow();
  // A zero grace period would leave no time to summarize.
  expect(() => readLimits({ AGENT_TURN_GRACE: '0' })).toThrow();
});

it('builds computer input schemas from the configured limits', () => {
  const inputs = computerInputSchemas({
    ...defaultLimits,
    execMaxMs: 300_000,
    commandChars: 20_000,
  });
  expect(
    inputs.exec.safeParse({ command: 'make', timeoutMs: 300_000 }).success,
  ).toBe(true);
  expect(
    inputs.exec.safeParse({ command: 'make', timeoutMs: 300_001 }).success,
  ).toBe(false);
  expect(inputs.exec.safeParse({ command: 'x'.repeat(20_000) }).success).toBe(
    true,
  );
});

it('allows up to a thousand steps', () => {
  expect(readLimits({ AGENT_MAX_STEPS: '1000' }).agentMaxSteps).toBe(1000);
});

it('treats a zero turn or task timeout as no time limit', () => {
  const limits = readLimits({ AGENT_TURN_TIMEOUT: '0', TASK_TIMEOUT: '0' });
  expect(limits.agentTurnMs).toBe(NO_TIME_LIMIT_MS);
  expect(limits.taskTimeoutMs).toBe(NO_TIME_LIMIT_MS);
  expect(hasTimeLimit(limits.agentTurnMs)).toBe(false);
  expect(
    hasTimeLimit(readLimits({ AGENT_TURN_TIMEOUT: '7200' }).agentTurnMs),
  ).toBe(true);
  expect(hasTimeLimit(defaultLimits.agentTurnMs)).toBe(true);
  // Other timeouts still have to be positive, and the shell and file caps are OpenBot's.
  expect(() => readLimits({ COMPUTER_EXEC_MAX_TIMEOUT: '0' })).toThrow();
  expect(() => readLimits({ COMPUTER_REQUEST_TIMEOUT: '0' })).toThrow();
});

it('keeps the computer request timeout above the shell limit however it is configured', () => {
  const limits = readLimits({
    AGENT_TURN_TIMEOUT: '0',
    COMPUTER_EXEC_MAX_TIMEOUT: '600',
    COMPUTER_REQUEST_TIMEOUT: '30',
    COMPUTER_FILE_MAX_CHARS: '1000000',
  });
  expect(limits.execMaxMs).toBe(600_000);
  expect(limits.computerRequestMs).toBeGreaterThan(limits.execMaxMs);
  expect(limits.fileChars).toBe(1_000_000);
});

it('gives a Dot a grace period to summarize once its time is up', () => {
  expect(defaultLimits.agentGraceMs).toBe(20_000);
  expect(readLimits({ AGENT_TURN_GRACE: '45' }).agentGraceMs).toBe(45_000);
});
