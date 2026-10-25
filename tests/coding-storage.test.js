import { afterEach, expect, it, vi } from 'vitest';
import process from 'node:process';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  readFile,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { URL } from 'node:url';
import {
  assertPrivateEntry,
  assertPrivateStorage,
  codingEnvironment,
  codingPaths,
  prepareCodingStorage,
} from '../deployment/computers/acp-bridge/storage.mjs';
import { withAcpBridge } from '../deployment/computers/acp-bridge/bridge.mjs';
import { managedOnlyAdapterSettings } from '../deployment/computers/acp-bridge/harden-adapter.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fulldots-coding-storage-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const profiles = join(root, 'profiles');
  await mkdir(workspace);
  await mkdir(profiles);
  return { root, workspace, profiles, paths: codingPaths(workspace, profiles) };
}

it('keeps the adapter cache and both home settings variables outside the Files root', async () => {
  const f = await fixture();
  await assertPrivateStorage(f.paths);
  const env = codingEnvironment(f.paths);
  for (const path of [f.paths.cache, env.HOME, env.CLAUDE_CONFIG_DIR]) {
    expect(relative(f.workspace, path).startsWith('..')).toBe(true);
    expect(relative(f.profiles, path).startsWith('..')).toBe(false);
  }
  expect(env.NPM_CONFIG_USERCONFIG).toBe('/dev/null');
  expect(env.COMPUTER_TOKEN).toBeUndefined();
});

it('refuses to launch the adapter if configured storage is under the Files root', async () => {
  const f = await fixture();
  vi.stubEnv('WORKSPACE_DIR', f.workspace);
  vi.stubEnv('PROFILES_DIR', f.workspace);
  const socket = { data: { acp: true }, close: vi.fn(), send: vi.fn() };
  await withAcpBridge({ websocket: {} }).websocket.open(socket);
  expect(socket.close).toHaveBeenCalledWith(
    1011,
    'Coding storage must stay outside the computer Files root.',
  );
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.data.child).toBeUndefined();
});

it('rejects a cache symlink that resolves inside the Files root', async () => {
  const f = await fixture();
  await assertPrivateStorage(f.paths);
  await rm(f.paths.cache, { recursive: true });
  await symlink(
    f.workspace,
    f.paths.cache,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(assertPrivateStorage(f.paths)).rejects.toThrow(
    'resolves inside',
  );
  vi.stubEnv('WORKSPACE_DIR', f.workspace);
  vi.stubEnv('PROFILES_DIR', f.profiles);
  const socket = { data: { acp: true }, close: vi.fn(), send: vi.fn() };
  await withAcpBridge({ websocket: {} }).websocket.open(socket);
  expect(socket.close).toHaveBeenCalledWith(
    1011,
    'Coding storage resolves inside the computer Files root.',
  );
  expect(socket.send).not.toHaveBeenCalled();
});

it('rejects an adapter entry symlink into the Files root', async () => {
  const f = await fixture();
  await assertPrivateStorage(f.paths);
  const source = join(f.workspace, 'poisoned');
  await mkdir(source);
  await writeFile(join(source, 'index.js'), 'fixture code');
  const link = join(f.paths.cache, 'entry');
  await symlink(
    source,
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(
    assertPrivateEntry(f.paths, join(link, 'index.js')),
  ).rejects.toThrow('resolves inside');
});

it('quarantines the earlier writable home before the Files API is started', async () => {
  const f = await fixture();
  const legacy = join(f.workspace, '.coding-home', '.claude');
  await mkdir(legacy, { recursive: true });
  await writeFile(join(legacy, '.credentials.json'), 'fixture-sign-in');
  vi.stubEnv('WORKSPACE_DIR', f.workspace);
  vi.stubEnv('PROFILES_DIR', f.profiles);
  await prepareCodingStorage();
  await expect(
    readFile(join(legacy, '.credentials.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  const quarantine = (await readdir(f.paths.root)).find((name) =>
    name.startsWith('legacy-home-'),
  );
  expect(
    await readFile(
      join(f.paths.root, quarantine, '.claude', '.credentials.json'),
      'utf8',
    ),
  ).toBe('fixture-sign-in');
  await expect(
    readFile(join(f.paths.home, '.claude', '.credentials.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('limits the pinned adapter settings manager to managed sources and refuses drift', () => {
  const source = 'const resolved = await resolveSettings({ cwd: this.cwd });';
  expect(managedOnlyAdapterSettings(source)).toContain('settingSources: []');
  expect(() => managedOnlyAdapterSettings('changed loader')).toThrow(
    'Pinned adapter',
  );
  expect(() => managedOnlyAdapterSettings(source + source)).toThrow(
    'Pinned adapter',
  );
});

it('ships a policy with no pre-allowed actions or untrusted hooks', async () => {
  const policy = JSON.parse(
    await readFile(
      new URL(
        '../deployment/computers/acp-bridge/managed-settings.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  expect(policy).toMatchObject({
    allowManagedHooksOnly: true,
    allowManagedPermissionRulesOnly: true,
    disableAutoMode: true,
    hooks: {},
    permissions: {
      defaultMode: 'default',
      disableBypassPermissionsMode: 'disable',
      allow: [],
    },
  });
  expect(policy.permissions.ask).toContain('Bash');
  expect(policy.permissions.deny).toContain('Read(//profiles/.coding/**)');
  const dockerfile = await readFile(
    new URL('../deployment/computers/computer.Dockerfile', import.meta.url),
    'utf8',
  );
  expect(dockerfile).toContain('COPY --chown=0:0 --chmod=0444');
});
