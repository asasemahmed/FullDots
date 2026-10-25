import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export function codingPaths(workspace = '/workspace', profiles = '/profiles') {
  const root = join(profiles, '.coding');
  return {
    workspace,
    root,
    home: join(root, 'home'),
    cache: join(root, 'adapters', 'claude-0.95.0'),
    staging: join(root, 'adapters', 'claude-0.95.0.installing'),
  };
}

export function codingEnvironment(paths) {
  return {
    PATH: process.env.PATH,
    HOME: paths.home,
    CLAUDE_CONFIG_DIR: join(paths.home, '.claude'),
    LANG: 'C.UTF-8',
    TERM: 'xterm-256color',
    NPM_CONFIG_USERCONFIG: '/dev/null',
  };
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
  try {
    const info = await lstat(path);
    const parent = await stat(join(path, '..'));
    const expected = await readFile(
      new URL('./managed-settings.json', import.meta.url),
      'utf8',
    );
    const actual = await readFile(path, 'utf8');
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      parent.uid !== 0 ||
      (info.mode & 0o022) !== 0 ||
      (parent.mode & 0o022) !== 0 ||
      actual !== expected
    )
      throw new Error('Coding managed settings are missing or unsafe.');
  } catch {
    throw new Error('Coding managed settings are missing or unsafe.');
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
