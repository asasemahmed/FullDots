import { expect, it } from 'vitest';
import { runAcp } from '../src/server/agents/acp-client.js';
import { fakeCodingAgent } from './fixtures/fake-coding-agent.js';

it('returns cancellation to the agent if the approval system fails', async () => {
  const fake = fakeCodingAgent({ permission: true });
  await runAcp({
    target: fake.app,
    provider: 'claude',
    task: 'Task',
    signal: new AbortController().signal,
    session: () => {},
    update: () => {},
    permission: async () => {
      throw new Error('Fixture storage unavailable');
    },
  });
  expect(fake.state.outcome).toEqual({ outcome: { outcome: 'cancelled' } });
});
