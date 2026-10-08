import { afterEach, expect, it, vi } from 'vitest';
import { createNotify } from '../src/server/notify.js';

const event = {
  title: 'Approval needed',
  text: 'Run tests?',
  url: 'https://app.test/x',
};

afterEach(() => {
  vi.restoreAllMocks();
});

it('does nothing when no webhook URL is configured', async () => {
  const transport = vi.fn<typeof fetch>();
  await expect(
    createNotify(undefined, transport)(event),
  ).resolves.toBeUndefined();
  await expect(createNotify('', transport)(event)).resolves.toBeUndefined();
  expect(transport).not.toHaveBeenCalled();
});

it('posts only title, clipped text, and url as JSON', async () => {
  const transport = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  const notify = createNotify('https://hooks.test/abc', transport, vi.fn());
  await notify({ ...event, text: 'a'.repeat(600) });
  const [target, init] = transport.mock.calls[0];
  expect(target).toBe('https://hooks.test/abc');
  expect(init?.method).toBe('POST');
  expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  expect(init?.redirect).toBe('error');
  expect(JSON.parse(String(init?.body))).toEqual({
    title: 'Approval needed',
    text: 'a'.repeat(500),
    url: 'https://app.test/x',
  });
});

it('logs and resolves on a non-2xx response', async () => {
  const log = vi.fn();
  const transport = vi.fn<typeof fetch>(
    async () => new Response('x', { status: 500 }),
  );
  await expect(
    createNotify('https://hooks.test/abc', transport, log)(event),
  ).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log.mock.calls[0][0]).toContain('500');
  expect(log.mock.calls[0][0]).not.toContain('hooks.test');
});

it('logs and resolves when the transport throws', async () => {
  const log = vi.fn();
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error('socket hang up');
  });
  await expect(
    createNotify('https://hooks.test/abc', transport, log)(event),
  ).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith('Notification failed: socket hang up');
});

it('aborts a hung request on the 5 second timeout and resolves', async () => {
  const controller = new AbortController();
  const timeout = vi
    .spyOn(AbortSignal, 'timeout')
    .mockReturnValue(controller.signal);
  const log = vi.fn();
  const transport = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      }),
  );
  const pending = createNotify('https://hooks.test/abc', transport, log)(event);
  expect(timeout).toHaveBeenCalledWith(5000);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('Notification failed: aborted');
});

it('makes a relative link absolute with the app origin', async () => {
  const transport = vi.fn<typeof fetch>(
    async () => new Response(null, { status: 204 }),
  );
  const notify = createNotify(
    'https://hooks.test/abc',
    transport,
    vi.fn(),
    'http://127.0.0.1:5174',
  );
  await notify({ ...event, url: '/#/approvals' });
  await notify(event);
  const urls = transport.mock.calls.map(
    ([, init]) => JSON.parse(String(init?.body)).url,
  );
  expect(urls).toEqual([
    'http://127.0.0.1:5174/#/approvals',
    'https://app.test/x',
  ]);
});
