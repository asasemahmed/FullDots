import { z } from 'zod';

/** Coding agents a Dot can use. Anything else is refused, here and in the computer bridge. */
export const codingProviderIds = ['claude', 'codex'] as const;
export type CodingProviderId = (typeof codingProviderIds)[number];
export const codingProviderSchema = z.enum(codingProviderIds);

export function unsafePermissionOption(
  id: string,
  modes: readonly string[] = [],
): boolean {
  const normalized = id.trim().toLowerCase();
  if (normalized === 'default' || normalized === 'exit-plan-default')
    return false;
  return (
    modes.some((mode) => mode.toLowerCase() === normalized) ||
    [
      'acceptedits',
      'plan',
      'auto',
      'bypasspermissions',
      'dontask',
      'manual',
      'bypass',
      // Codex presets and its plan-to-implementation switch. The app only ever selects read-only.
      'read-only',
      'workspace-write',
      'agent',
      'agent-full-access',
      'implement_plan',
      // Codex grants that last for the rest of the turn: an approval covers one action, once.
      'allow_permissions_turn',
      'allow_permissions_turn_strict_auto_review',
    ].includes(normalized) ||
    normalized.startsWith('exit-plan-') ||
    /(?:^|[-_])(?:auto|acceptedits|bypasspermissions|dontask)(?:$|[-_])/.test(
      normalized,
    )
  );
}

export class CodingModeError extends Error {
  constructor() {
    super('The coding worker left default permission mode and was stopped.');
  }
}

export class CodingBridgeError extends Error {}

export class CodingTaskBusyError extends Error {
  constructor() {
    super('A coding task is already running for this Dot.');
  }
}

export const bridgeReasons = new Set([
  'Coding adapter installation failed.',
  'Coding adapter installation timed out.',
  'Coding storage must stay outside the computer Files root.',
  'Coding storage resolves inside the computer Files root.',
  'Coding adapter resolves inside the computer Files root.',
  'Coding managed settings are missing or unsafe.',
  'Pinned adapter settings loader changed; review before installing.',
  'Unknown coding provider.',
]);
