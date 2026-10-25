import { describe, expect, it, vi } from 'vitest';
import { composioTools } from '../src/server/composio-tools.js';

function fakeSession(execute?: ReturnType<typeof vi.fn>) {
  const run =
    execute ?? vi.fn(async () => ({ data: { id: 'm1' }, error: null }));
  return {
    tools: vi.fn(async () => [
      {
        type: 'function',
        function: {
          name: 'GMAIL_SEND_EMAIL',
          description: 'Send an email',
          parameters: {
            type: 'object',
            properties: { to: { type: 'string' } },
          },
        },
      },
      { type: 'function', function: { name: 'has space', parameters: {} } },
    ]),
    execute: run,
  };
}

describe('Composio tools', () => {
  it('names each app action and passes the abort signal through', async () => {
    const session = fakeSession();
    const signal = new AbortController().signal;
    const tools = await composioTools(session as never, () => {}, signal);
    expect(tools.map((tool) => tool.name)).toEqual([
      'composio__GMAIL_SEND_EMAIL',
    ]);
    expect(session.tools).toHaveBeenCalledWith(undefined, { signal });
    await tools[0]?.execute({ to: 'a@b.test', token: 'ghp_secret' });
    expect(session.execute).toHaveBeenCalledWith(
      'GMAIL_SEND_EMAIL',
      { to: 'a@b.test', token: 'ghp_secret' },
      undefined,
      { signal },
    );
  });

  it('returns the provider data and drops a raw failure', async () => {
    const session = fakeSession();
    const tools = await composioTools(session as never, () => {});
    await expect(tools[0]?.execute({})).resolves.toEqual({
      data: { id: 'm1' },
      error: null,
    });

    session.execute.mockRejectedValueOnce(
      Object.assign(new Error('provider secret sk-live-abc'), { status: 401 }),
    );
    const failed = await tools[0]?.execute({});
    expect(failed).toEqual({
      data: {},
      error: 'Composio tool failed: Error (HTTP 401).',
    });
    expect(JSON.stringify(failed)).not.toContain('sk-live');

    session.execute.mockRejectedValueOnce(
      Object.assign(new Error('token ghp_abc'), { name: 'ProviderBoom' }),
    );
    const renamed = await tools[0]?.execute({});
    expect(renamed).toEqual({
      data: {},
      error: 'Composio tool failed: Error.',
    });
    expect(JSON.stringify(renamed)).not.toContain('ghp_');
  });

  it('turns a Connect link into a handoff and keeps the provider text out', async () => {
    const session = fakeSession(
      vi.fn(async () => ({
        data: { redirect_url: 'https://backend.composio.dev/s/start?user=1' },
        error: 'raw token abc',
        resultType: 'failed',
      })),
    );
    const tools = await composioTools(session as never, () => {});
    const result = await tools[0]?.execute({});
    expect(result).toMatchObject({
      status: 'handoff',
      kind: 'credential',
      handoffId: '',
      url: 'https://backend.composio.dev/s/start?user=1',
    });
    expect(JSON.stringify(result)).not.toContain('abc');
    expect(JSON.stringify(result)).not.toContain('raw token');

    session.execute.mockResolvedValueOnce({
      data: {},
      error: 'Please authenticate at https://backend.composio.dev/s/only once',
      resultType: 'failed',
    });
    const fromText = await tools[0]?.execute({});
    expect(fromText).toMatchObject({
      status: 'handoff',
      url: 'https://backend.composio.dev/s/only',
    });
    expect(JSON.stringify(fromText)).not.toContain('authenticate at');
  });

  it('ignores a link that is not on a Composio host and keeps the result', async () => {
    const session = fakeSession(
      vi.fn(async () => ({
        data: { webhook: { redirect_url: 'https://attacker.example/x' } },
        error: null,
        successful: true,
      })),
    );
    const tools = await composioTools(session as never, () => {});
    const result = await tools[0]?.execute({});
    expect(result).not.toMatchObject({ status: 'handoff' });
    expect(JSON.stringify(result)).toContain('attacker.example');

    session.execute.mockResolvedValueOnce({
      data: {},
      error: 'Please connect at https://composio.dev.evil.example/start',
      resultType: 'failed',
    });
    const lookalike = await tools[0]?.execute({});
    expect(lookalike).not.toMatchObject({ status: 'handoff' });
  });

  it('cancels with a clean error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = fakeSession(
      vi.fn(async () => {
        throw new Error('provider secret');
      }),
    );
    const tools = await composioTools(
      session as never,
      () => {},
      controller.signal,
    );
    await expect(tools[0]?.execute({})).rejects.toThrow(/cancelled/);
    await expect(tools[0]?.execute({})).rejects.not.toThrow(/secret/);
  });
});
