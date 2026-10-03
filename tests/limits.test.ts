import { expect, it } from 'vitest';
import { defaultLimits, readLimits } from '../src/server/limits.js';
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
  expect(() => readLimits({ AGENT_TURN_TIMEOUT: '0' })).toThrow();
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
