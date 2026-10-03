// Tunable work limits, read from the environment. Defaults match the original
// OpenDots values; maximums follow what the OpenBot computer itself accepts.
import {
  defaultComputerInputLimits,
  type ComputerInputLimits,
} from '../shared/computer-types.js';

/**
 * What "no time limit" becomes where a timer or a lease needs a number: the voice call, the
 * scheduled-task runner and its database lease. A Dot's own turn treats it as no timer at all.
 * Twenty-four hours is far beyond any real turn, and keeps a lease from outliving a crash by weeks.
 */
export const NO_TIME_LIMIT_MS = 24 * 60 * 60 * 1000;

export const hasTimeLimit = (ms: number) => ms < NO_TIME_LIMIT_MS;

export interface Limits extends ComputerInputLimits {
  agentTurnMs: number;
  /** Extra time a Dot gets to write its summary once the turn limit is reached. */
  agentGraceMs: number;
  agentMaxSteps: number;
  agentMaxTokens: number;
  taskTimeoutMs: number;
  computerRequestMs: number;
  computerResponseBytes: number;
}

export const defaultLimits: Limits = {
  ...defaultComputerInputLimits,
  agentTurnMs: 90_000,
  agentGraceMs: 20_000,
  agentMaxSteps: 8,
  agentMaxTokens: 2200,
  taskTimeoutMs: 90_000,
  computerRequestMs: 70_000,
  computerResponseBytes: 4_000_000,
};

type Env = Record<string, string | undefined>;

function number(
  env: Env,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return value;
}

export function readLimits(env: Env = process.env): Limits {
  const seconds = (name: string, fallback: number, max: number) =>
    number(env, name, fallback / 1000, 1, max) * 1000;
  // 0 means no time limit; see NO_TIME_LIMIT_MS for what the rest of the server sees.
  const unlimitedSeconds = (name: string, fallback: number, max: number) => {
    const value = number(env, name, fallback / 1000, 0, max) * 1000;
    return value === 0 ? NO_TIME_LIMIT_MS : value;
  };
  const execMaxMs = seconds(
    'COMPUTER_EXEC_MAX_TIMEOUT',
    defaultLimits.execMaxMs,
    600, // OpenBot rejects shell timeouts above 10 minutes.
  );
  return {
    agentTurnMs: unlimitedSeconds(
      'AGENT_TURN_TIMEOUT',
      defaultLimits.agentTurnMs,
      7200,
    ),
    agentGraceMs: seconds('AGENT_TURN_GRACE', defaultLimits.agentGraceMs, 600),
    agentMaxSteps: number(
      env,
      'AGENT_MAX_STEPS',
      defaultLimits.agentMaxSteps,
      1,
      1000,
    ),
    agentMaxTokens: number(
      env,
      'AGENT_MAX_TOKENS',
      defaultLimits.agentMaxTokens,
      256,
      128_000,
    ),
    taskTimeoutMs: unlimitedSeconds(
      'TASK_TIMEOUT',
      defaultLimits.taskTimeoutMs,
      7200,
    ),
    execMaxMs,
    commandChars: number(
      env,
      'COMPUTER_COMMAND_MAX_CHARS',
      defaultLimits.commandChars,
      100,
      100_000,
    ),
    fileChars: number(
      env,
      'COMPUTER_FILE_MAX_CHARS',
      defaultLimits.fileChars,
      1000,
      1_000_000, // OpenBot accepts writes up to 1 MB.
    ),
    typeChars: number(
      env,
      'COMPUTER_TYPE_MAX_CHARS',
      defaultLimits.typeChars,
      100,
      100_000,
    ),
    // A computer request must outlive the longest shell command it carries.
    computerRequestMs: Math.max(
      seconds(
        'COMPUTER_REQUEST_TIMEOUT',
        defaultLimits.computerRequestMs,
        7200,
      ),
      execMaxMs + 10_000,
    ),
    computerResponseBytes:
      number(env, 'COMPUTER_RESPONSE_MAX_MB', 4, 1, 64) * 1_000_000,
  };
}
