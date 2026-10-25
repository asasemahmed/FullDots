import { expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { computerFixture } from './fixtures/fake-computer.js';

it('returns the validated endpoint and existing per-Dot credential only in headers', async () => {
  const f = computerFixture();
  try {
    const target = await f.service.codingTarget(f.id);
    expect(target.url).toBe(`ws://opendots-computer-${f.id}:4100/acp`);
    const expected = createHmac('sha256', f.config.computerToken)
      .update(`opendots-computer:${f.id}`)
      .digest('hex');
    expect(target.headers).toEqual({
      'x-openbot-computer-token': expected,
      'x-openbot-bot-id': f.id,
    });
    expect(target.url).not.toContain(expected);
    expect(
      target.redact(
        `${expected} ${f.config.computerToken} ${f.config.computerSupervisorToken}`,
      ),
    ).toBe('[redacted] [redacted] [redacted]');
    f.workspace.setDotPaused(f.id, true);
    await expect(f.service.codingTarget(f.id)).rejects.toThrow('paused');
  } finally {
    f.workspace.close();
  }
});

it('refuses coding work while the owner holds the computer', async () => {
  const f = computerFixture();
  try {
    f.fake.holder = 'human';
    await expect(f.service.codingTarget(f.id)).rejects.toThrow(
      'owner has control',
    );
  } finally {
    f.workspace.close();
  }
});
