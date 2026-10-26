import { describe, expect, it } from 'vitest';
import {
  agentConnectLookup,
  createAgentFetch,
  type ResolvedAddress,
} from '../src/server/agent-endpoint.js';

const PUBLIC = '203.0.113.10';

function records(
  address: string,
  family = address.includes(':') ? 6 : 4,
): ResolvedAddress[] {
  return [{ address, family }];
}

function resolver(address: string) {
  return async () => records(address);
}

describe('agent address resolution', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '169.254.169.254',
    '::1',
    '::ffff:10.0.0.5',
  ])('refuses a public name that resolves to %s', async (address) => {
    const dialled: string[] = [];
    const agentFetch = createAgentFetch({
      resolve: resolver(address),
      fetchImpl: async (url) => {
        dialled.push(url);
        return new Response('no');
      },
    });
    await expect(agentFetch('https://agent.example/ag-ui')).rejects.toThrow(
      /not allowed|private network/,
    );
    expect(dialled).toEqual([]);
  });

  it('refuses a name that resolves to both a public and a private address', async () => {
    const dialled: string[] = [];
    const agentFetch = createAgentFetch({
      resolve: async () => [
        { address: PUBLIC, family: 4 },
        { address: '10.0.0.5', family: 4 },
      ],
      fetchImpl: async (url) => {
        dialled.push(url);
        return new Response('no');
      },
    });
    await expect(agentFetch('https://agent.example/ag-ui')).rejects.toThrow(
      /private network/,
    );
    expect(dialled).toEqual([]);
  });

  it('lets a listed host resolve to a private address', async () => {
    const dialled: string[] = [];
    const agentFetch = createAgentFetch({
      allowedHosts: new Set(['mine.example']),
      resolve: resolver('10.0.0.5'),
      fetchImpl: async (url) => {
        dialled.push(url);
        return new Response('ok');
      },
    });
    const response = await agentFetch('https://mine.example/ag-ui');
    expect(response.status).toBe(200);
    expect(dialled).toEqual(['https://mine.example/ag-ui']);
  });

  it('refuses a metadata address even when the host is listed', async () => {
    const dialled: string[] = [];
    const agentFetch = createAgentFetch({
      allowedHosts: new Set(['mine.example', '169.254.169.254']),
      resolve: resolver('169.254.169.254'),
      fetchImpl: async (url) => {
        dialled.push(url);
        return new Response('no');
      },
    });
    await expect(agentFetch('https://mine.example/latest')).rejects.toThrow(
      /not allowed/,
    );
    await expect(agentFetch('https://169.254.169.254/latest')).rejects.toThrow(
      /not allowed/,
    );
    expect(dialled).toEqual([]);
  });

  it('refuses a redirect to a name that resolves privately and does not dial it', async () => {
    const dialled: string[] = [];
    const agentFetch = createAgentFetch({
      resolve: async (hostname) =>
        hostname === 'evil.example' ? records('10.1.1.1') : records(PUBLIC),
      fetchImpl: async (url) => {
        dialled.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/secret' },
        });
      },
    });
    await expect(agentFetch('https://agent.example/ag-ui')).rejects.toThrow(
      /evil\.example/,
    );
    expect(dialled).toEqual(['https://agent.example/ag-ui']);
  });

  it('dials only the address it checked, and refuses when the next answer is private', async () => {
    const answers: ResolvedAddress[][] = [records(PUBLIC), records('10.0.0.5')];
    const dialled: string[] = [];
    let current = new URL('https://agent.example/ag-ui');
    const lookup = agentConnectLookup({
      resolve: async () => answers.shift() ?? records('10.0.0.5'),
      target: () => current,
    });
    const first = await new Promise<ResolvedAddress[] | string | undefined>(
      (resolve, reject) => {
        lookup('agent.example', { all: true }, (error, addresses) => {
          if (error) reject(error);
          else resolve(addresses);
        });
      },
    );
    expect(first).toEqual([{ address: PUBLIC, family: 4 }]);
    if (Array.isArray(first))
      for (const record of first) dialled.push(record.address);

    current = new URL('https://agent.example/ag-ui');
    const second = await new Promise<Error | null>((resolve) => {
      lookup('agent.example', { all: true }, (error, addresses) => {
        if (!error && Array.isArray(addresses))
          for (const record of addresses) dialled.push(record.address);
        resolve(error);
      });
    });
    expect(second).toBeInstanceOf(Error);
    expect(second?.message).toMatch(/private network/);
    expect(dialled).toEqual([PUBLIC]);
    expect(dialled).not.toContain('10.0.0.5');
  });

  it('refuses the connection when the name answers public and then private', async () => {
    const answers = [records(PUBLIC), records('10.0.0.5')];
    const agentFetch = createAgentFetch({
      resolve: async () => answers.shift() ?? records('10.0.0.5'),
      timeoutMs: 2_000,
    });
    await expect(agentFetch('https://agent.example/ag-ui')).rejects.toThrow(
      /private network/,
    );
  });
});
