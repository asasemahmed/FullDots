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
  assertCodexReadLimits,
  assertManagedSettings,
  assertPrivateEntry,
  assertPrivateStorage,
  codingEnvironment,
  codingPaths,
  prepareCodingStorage,
} from '../deployment/computers/acp-bridge/storage.mjs';
import { withAcpBridge } from '../deployment/computers/acp-bridge/bridge.mjs';
import {
  hardenAdapter,
  managedOnlyAdapterSettings,
  untrustedProjectCodexSettings,
} from '../deployment/computers/acp-bridge/harden-adapter.mjs';

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

it('refuses managed settings that are missing, changed or a link', async () => {
  const { root } = await fixture();
  const message = 'Coding managed settings are missing or unsafe.';
  await expect(
    assertManagedSettings(join(root, 'missing.json')),
  ).rejects.toThrow(message);

  const changed = join(root, 'changed.json');
  await writeFile(changed, '{"permissions":{"allow":["Bash"]}}');
  await expect(assertManagedSettings(changed)).rejects.toThrow(message);

  const real = join(root, 'real.json');
  await writeFile(
    real,
    await readFile(
      new URL(
        '../deployment/computers/acp-bridge/managed-settings.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const link = join(root, 'link.json');
  let linked = true;
  try {
    await symlink(real, link);
  } catch {
    // Creating symlinks needs extra rights on some Windows setups.
    linked = false;
  }
  if (linked)
    await expect(assertManagedSettings(link)).rejects.toThrow(message);
});

it('ships Codex read limits for the private coding tree and proc', async () => {
  const text = await readFile(
    new URL(
      '../deployment/computers/acp-bridge/codex-requirements.toml',
      import.meta.url,
    ),
    'utf8',
  );
  expect(text).toContain('deny_read = ["/profiles/.coding/**", "/proc/**"]');
  expect(text).toContain('glob_scan_max_depth = 16');
  const dockerfile = await readFile(
    new URL('../deployment/computers/computer.Dockerfile', import.meta.url),
    'utf8',
  );
  expect(dockerfile).toContain(
    'COPY --chown=0:0 --chmod=0444 deployment/computers/acp-bridge/codex-requirements.toml /etc/codex/requirements.toml',
  );
});

it('refuses Codex read limits that are missing, changed or a link', async () => {
  const { root } = await fixture();
  const message = 'Codex read limits are missing or unsafe.';
  await expect(
    assertCodexReadLimits(join(root, 'missing.toml')),
  ).rejects.toThrow(message);

  const changed = join(root, 'changed.toml');
  await writeFile(changed, 'deny_read = []\n');
  await expect(assertCodexReadLimits(changed)).rejects.toThrow(message);

  const real = join(root, 'real.toml');
  await writeFile(
    real,
    await readFile(
      new URL(
        '../deployment/computers/acp-bridge/codex-requirements.toml',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const link = join(root, 'link.toml');
  let linked = true;
  try {
    await symlink(real, link);
  } catch {
    linked = false;
  }
  if (linked)
    await expect(assertCodexReadLimits(link)).rejects.toThrow(message);
});

it('refuses to start Codex without its read limits and still checks Claude Code managed settings', async () => {
  const f = await fixture();
  vi.stubEnv('WORKSPACE_DIR', f.workspace);
  vi.stubEnv('PROFILES_DIR', f.profiles);
  const bridge = withAcpBridge({ websocket: {} });
  const codex = {
    data: { acp: true, provider: 'codex' },
    close: vi.fn(),
    send: vi.fn(),
  };
  await bridge.websocket.open(codex);
  expect(codex.close).toHaveBeenCalledWith(
    1011,
    'Codex read limits are missing or unsafe.',
  );
  expect(codex.send).not.toHaveBeenCalled();
  expect(codex.data.child).toBeUndefined();

  const claude = {
    data: { acp: true, provider: 'claude' },
    close: vi.fn(),
    send: vi.fn(),
  };
  await bridge.websocket.open(claude);
  expect(claude.close).toHaveBeenCalledWith(
    1011,
    'Coding managed settings are missing or unsafe.',
  );
  expect(claude.send).not.toHaveBeenCalled();
  expect(claude.data.child).toBeUndefined();
});

it('keeps the Codex cache, home and settings folder in the coding storage outside the Files root', async () => {
  const f = await fixture();
  const codex = codingPaths(f.workspace, f.profiles, 'codex-2.2.2');
  await assertPrivateStorage(codex);
  const env = codingEnvironment(codex, 'codex');
  for (const path of [codex.cache, codex.staging, env.HOME, env.CODEX_HOME]) {
    expect(relative(f.workspace, path).startsWith('..')).toBe(true);
    expect(relative(join(f.profiles, '.coding'), path).startsWith('..')).toBe(
      false,
    );
  }
  expect(env.CODEX_HOME).toBe(join(codex.home, '.codex'));
  // One home is shared; the two agents never share an adapter cache.
  expect(codex.home).toBe(f.paths.home);
  expect(codex.cache).not.toBe(f.paths.cache);
  expect(relative(f.paths.root, codex.cache)).toBe(
    join('adapters', 'codex-2.2.2'),
  );
});

it('gives Codex a limited environment that starts in the ask-first preset', async () => {
  const f = await fixture();
  vi.stubEnv('COMPUTER_TOKEN', 'fixture-computer-token-long-enough');
  vi.stubEnv('OPENAI_API_KEY', 'fixture-' + 'value');
  const env = codingEnvironment(f.paths, 'codex');
  expect(env.INITIAL_AGENT_MODE).toBe('read-only');
  expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
  expect(env.COMPUTER_TOKEN).toBeUndefined();
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.NPM_CONFIG_USERCONFIG).toBe('/dev/null');
  // Claude Code's environment is unchanged.
  const claude = codingEnvironment(f.paths);
  expect(claude.CLAUDE_CONFIG_DIR).toBe(join(f.paths.home, '.claude'));
  expect(claude.CODEX_HOME).toBeUndefined();
  expect(claude.INITIAL_AGENT_MODE).toBeUndefined();
});

it('refuses to launch Codex if the coding storage is under the Files root', async () => {
  const f = await fixture();
  vi.stubEnv('WORKSPACE_DIR', f.workspace);
  vi.stubEnv('PROFILES_DIR', f.workspace);
  const socket = {
    data: { acp: true, provider: 'codex' },
    close: vi.fn(),
    send: vi.fn(),
  };
  await withAcpBridge({ websocket: {} }).websocket.open(socket);
  expect(socket.close).toHaveBeenCalledWith(
    1011,
    'Coding storage must stay outside the computer Files root.',
  );
  expect(socket.send).not.toHaveBeenCalled();
  expect(socket.data.child).toBeUndefined();
});

it('rejects a Codex cache symlink that resolves inside the Files root', async () => {
  const f = await fixture();
  const codex = codingPaths(f.workspace, f.profiles, 'codex-2.2.2');
  await assertPrivateStorage(codex);
  await rm(codex.cache, { recursive: true });
  await symlink(
    f.workspace,
    codex.cache,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(assertPrivateStorage(codex)).rejects.toThrow('resolves inside');
});

it('marks the project untrusted in the pinned Codex adapter and refuses drift', () => {
  const source =
    'projects: Object.fromEntries(roots.map((root) => [root, { trust_level: "trusted" }]))';
  const patched = untrustedProjectCodexSettings(source);
  expect(patched).toContain('trust_level: "untrusted"');
  expect(patched).not.toContain('"trusted"');
  expect(() => untrustedProjectCodexSettings('changed loader')).toThrow(
    'Pinned adapter',
  );
  expect(() => untrustedProjectCodexSettings(source + source)).toThrow(
    'Pinned adapter',
  );
});

it('hardens the installed Codex adapter file and leaves Claude Code hardening alone', async () => {
  const { root } = await fixture();
  const file = join(
    root,
    'cache/node_modules/@agentclientprotocol/codex-acp/dist/index.js',
  );
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, '{ trust_level: "trusted" }');
  await hardenAdapter(join(root, 'cache'), 'codex');
  expect(await readFile(file, 'utf8')).toBe('{ trust_level: "untrusted" }');
  // Claude Code's file is not there, so its hardening cannot be applied to a Codex cache.
  await expect(hardenAdapter(join(root, 'cache'))).rejects.toThrow();
});

it('pins Codex to one exact reviewed version with a lockfile', async () => {
  const folder = new URL(
    '../deployment/computers/acp-bridge/adapter-codex/',
    import.meta.url,
  );
  const manifest = JSON.parse(
    await readFile(new URL('package.json', folder), 'utf8'),
  );
  expect(manifest.dependencies).toEqual({
    '@agentclientprotocol/codex-acp': '2.2.2',
  });
  const lock = JSON.parse(
    await readFile(new URL('package-lock.json', folder), 'utf8'),
  );
  expect(
    lock.packages['node_modules/@agentclientprotocol/codex-acp'].version,
  ).toBe('2.2.2');
  const bridge = await readFile(
    new URL('../deployment/computers/acp-bridge/bridge.mjs', import.meta.url),
    'utf8',
  );
  expect(bridge).toContain("'@agentclientprotocol/codex-acp/dist/index.js'");
  expect(bridge).not.toContain('@zed-industries');
});
