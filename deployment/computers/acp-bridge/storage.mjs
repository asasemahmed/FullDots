import { constants } from 'node:fs';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

/** `adapter` is the versioned cache folder name of one coding agent, for example `codex-2.2.2`. */
export function codingPaths(
  workspace = '/workspace',
  profiles = '/profiles',
  adapter = 'claude-0.95.0',
) {
  const root = join(profiles, '.coding');
  return {
    workspace,
    root,
    // One home for every coding agent. Each keeps its own sign-in folder inside it.
    home: join(root, 'home'),
    cache: join(root, 'adapters', adapter),
    staging: join(root, 'adapters', `${adapter}.installing`),
  };
}

/**
 * The only environment a coding worker gets: no computer or supervisor credentials.
 * Every agent's settings and sign-in folder is under the private home, never the Files root.
 */
export function codingEnvironment(paths, provider = 'claude') {
  const base = {
    PATH: process.env.PATH,
    HOME: paths.home,
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
  if (provider === 'codex')
    return {
      ...base,
      CODEX_HOME: join(paths.home, '.codex'),
      // Start in the preset that asks before edits. The app selects it again and checks it.
      INITIAL_AGENT_MODE: 'read-only',
    };
  return { ...base, CLAUDE_CONFIG_DIR: join(paths.home, '.claude') };
}

function inside(root, target) {
  const part = relative(resolve(root), resolve(target));
  return (
    !part ||
    (!isAbsolute(part) &&
      part !== '..' &&
      !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
  );
}

export async function assertPrivateStorage(paths) {
  const workspace = await realpath(paths.workspace);
  for (const path of [paths.root, paths.home, paths.cache, paths.staging]) {
    if (inside(paths.workspace, path))
      throw new Error(
        'Coding storage must stay outside the computer Files root.',
      );
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (inside(workspace, await realpath(path)))
      throw new Error(
        'Coding storage resolves inside the computer Files root.',
      );
  }
  await chmod(paths.root, 0o700);
}

export async function assertPrivateEntry(paths, entry) {
  await assertPrivateStorage(paths);
  if (inside(await realpath(paths.workspace), await realpath(entry)))
    throw new Error('Coding adapter resolves inside the computer Files root.');
}

export async function assertManagedSettings(
  path = '/etc/claude-code/managed-settings.json',
) {
  // One handle for the checks and the read, so the file cannot be swapped in between.
  // O_NOFOLLOW refuses a symlink outright.
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    // Where O_NOFOLLOW is missing, confirm the path is not a link and names the opened file.
    const entry = await lstat(path);
    if (
      entry.isSymbolicLink() ||
      entry.ino !== info.ino ||
      entry.dev !== info.dev
    )
      throw new Error('Coding managed settings are missing or unsafe.');
    const parent = await stat(join(path, '..'));
    const expected = await readFile(
      new URL('./managed-settings.json', import.meta.url),
      'utf8',
    );
    const actual = await handle.readFile('utf8');
    if (
      !info.isFile() ||
      info.uid !== 0 ||
      parent.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (parent.mode & 0o022) !== 0 ||
      actual !== expected
    )
      throw new Error('Coding managed settings are missing or unsafe.');
  } catch {
    throw new Error('Coding managed settings are missing or unsafe.');
  } finally {
    await handle?.close();
  }
}

/** Before the Files API starts, quarantine the earlier unprotected sign-in home without using it. */
export async function prepareCodingStorage() {
  const paths = codingPaths(
    process.env.WORKSPACE_DIR || '/workspace',
    process.env.PROFILES_DIR || '/profiles',
  );
  await assertPrivateStorage(paths);
  const legacy = join(paths.workspace, '.coding-home');
  try {
    await lstat(legacy);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const quarantine = join(paths.root, `legacy-home-${randomUUID()}`);
  await cp(legacy, quarantine, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  await rm(legacy, { recursive: true, force: true });
}
