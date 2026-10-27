import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {
  JpegFrames,
  DesktopCapture,
  MAX_JPEG,
} from '../deployment/computers/desktop/capture.mjs';
import {
  parseDesktopInput,
  keyCombo,
} from '../deployment/computers/desktop/input.mjs';
import {
  desktopSupervisorDocker,
  desktopSupervisorIndex,
} from '../deployment/computers/desktop-supervisor.mjs';
import {
  hardenSupervisorDocker,
  hardenSupervisorIndex,
} from '../deployment/computers/harden-supervisor.mjs';
import {
  memoryForKind,
  requestedComputerKind,
} from '../deployment/computers/computer-desktop.ts';

const { AbortController, Request } = globalThis;

const jpeg = (n) => Buffer.from([255, 216, 1, n, 255, 217]);
it('decodes split and consecutive JPEG frames with bounded memory', () => {
  const frames = [];
  const parser = new JpegFrames((frame) => frames.push(frame));
  parser.push(Buffer.from([1, 2, 255]));
  parser.push(jpeg(1).subarray(1, 4));
  parser.push(Buffer.concat([jpeg(1).subarray(4), jpeg(2)]));
  expect(frames).toEqual([jpeg(1), jpeg(2)]);
  const tooLarge = new JpegFrames(() => {});
  expect(() =>
    tooLarge.push(
      Buffer.concat([jpeg(1).subarray(0, 2), Buffer.alloc(MAX_JPEG)]),
    ),
  ).toThrow('size limit');
  expect(() =>
    new JpegFrames(() => {}).push(Buffer.alloc(MAX_JPEG * 2 + 1)),
  ).toThrow('buffer limit');
});
it('shares one long-running capture between viewers and fresh screenshot requests, and cleans up cancellation', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  const spawn = vi.fn(() => child);
  const capture = new DesktopCapture(spawn);
  const frames = [];
  const unsubscribe = capture.subscribe((frame) => frames.push(frame));
  const first = capture.next(),
    second = capture.next();
  child.stdout.write(jpeg(1));
  expect((await first).data).toBe(jpeg(1).toString('base64'));
  expect((await second).data).toBe(jpeg(1).toString('base64'));
  const next = capture.next();
  child.stdout.write(jpeg(2));
  await next;
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(spawn.mock.calls[0][1]).not.toContain('-frames:v');
  expect(frames).toHaveLength(2);
  const controller = new AbortController();
  const cancelled = capture.next(controller.signal);
  controller.abort();
  await expect(cancelled).rejects.toThrow('cancelled');
  unsubscribe();
  capture.close();
  expect(child.kill).toHaveBeenCalledTimes(1);
});
it('refuses native unknown actions, out-of-range coordinates, extra fields and key command injection', () => {
  for (const action of ['unknown', 'exec', '../exec'])
    expect(() => parseDesktopInput(action, {})).toThrow('Unknown');
  for (const x of [-1, 1280, 1.5, Infinity])
    expect(() => parseDesktopInput('click', { x, y: 0 })).toThrow();
  expect(() =>
    parseDesktopInput('type', { text: 'fixture', command: 'unused' }),
  ).toThrow();
  for (const key of ['exec', '--window', 'ctrl+exec', 'ctrl+c;unused', 'ctrl+'])
    expect(() => keyCombo(key)).toThrow();
  expect(keyCombo('ctrl+s')).toBe('Control_L+s');
});
it('selects per-kind defaults while retaining explicit memory and unlimited overrides', () => {
  expect(memoryForKind('browser', '', 2147483648)).toBe(2147483648);
  expect(memoryForKind('desktop', undefined, 2147483648)).toBe(4294967296);
  expect(memoryForKind('desktop', '2147483648', 2147483648)).toBe(2147483648);
  expect(memoryForKind('desktop', '0', undefined)).toBeUndefined();
});
it('validates the supervisor kind request strictly and bounds its body', async () => {
  const request = (body) =>
    new Request('http://supervisor/ensure', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  expect(await requestedComputerKind(request({}))).toBe('browser');
  expect(await requestedComputerKind(request({ kind: 'desktop' }))).toBe(
    'desktop',
  );
  for (const body of [
    null,
    [],
    { kind: 'other' },
    { kind: 'desktop', image: 'untrusted' },
    { kind: 'x'.repeat(2000) },
  ])
    expect(await requestedComputerKind(request(body))).toBeUndefined();
});
const pinned = (name) =>
  readFileSync(
    new URL(`./fixtures/openbot-b6932d3/${name}.ts.txt`, import.meta.url),
    'utf8',
  );
it('patches the pinned supervisor for image selection, UID1001 bootstrap and restart reconciliation without adding capabilities', () => {
  const index = desktopSupervisorIndex(hardenSupervisorIndex(pinned('index')));
  const docker = desktopSupervisorDocker(
    hardenSupervisorDocker(pinned('docker')),
  );
  expect(index).toContain('kind === "desktop" ? desktopImage : image');
  expect(index).toContain(
    'memoryForKind(kind, process.env.COMPUTER_MEMORY_BYTES, memoryBytes)',
  );
  expect(docker).toContain('User: "1001"');
  expect(docker).toContain('CapDrop: ["ALL"]');
  expect(docker).toContain('SecurityOpt: ["no-new-privileges:true"]');
  expect(docker).toContain(
    'COMPUTER_TOKEN=desktop-internal-transport-only-0000',
  );
  expect(docker).toContain(
    'if (options.kind === "desktop") await startDesktopWorker',
  );
  expect(index).toContain('await reconcileDesktopWorkers()');
  for (const source of [index, docker])
    expect(
      ts.transpileModule(source, { reportDiagnostics: true }).diagnostics,
    ).toHaveLength(0);
  expect(() => desktopSupervisorDocker('changed upstream')).toThrow(
    'contract changed',
  );
  expect(() => desktopSupervisorIndex(index)).toThrow('contract changed');
});
