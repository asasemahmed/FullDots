import { describe, expect, it } from 'vitest';
import { unsafePermissionOption } from '../src/server/agents/acp-policy';

describe('which permission options an approval may select', () => {
  it('allows a plain once grant and the default mode', () => {
    expect(unsafePermissionOption('approved')).toBe(false);
    expect(unsafePermissionOption('default')).toBe(false);
  });

  it('never selects a Codex grant that lasts the rest of the turn', () => {
    expect(unsafePermissionOption('allow_permissions_turn')).toBe(true);
    expect(
      unsafePermissionOption('allow_permissions_turn_strict_auto_review'),
    ).toBe(true);
  });

  it('never selects a mode switch, for either coding agent', () => {
    for (const id of [
      'bypassPermissions',
      'acceptEdits',
      'agent-full-access',
      'workspace-write',
      'implement_plan',
    ])
      expect(unsafePermissionOption(id)).toBe(true);
    expect(unsafePermissionOption('custom-mode', ['custom-mode'])).toBe(true);
  });
});
