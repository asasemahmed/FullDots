// How FullDots calls ssh for computers on the owner's own server. The owner names an alias from
// their own ssh config and nothing else: keys, passwords and passphrases stay with ssh. Every call is
// an argument array (never a shell), the alias always comes after `--`, and batch mode with strict
// host key checking is always on, so ssh never prompts and never accepts an unknown host key.
import { spawn, type ChildProcess } from 'node:child_process';

/** Letters, digits, dot, dash and underscore; never a leading dash, so it cannot read as an option. */
const ALIAS = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

export function validAlias(alias: unknown): alias is string {
  return typeof alias === 'string' && ALIAS.test(alias);
}

export function requireAlias(alias: unknown): string {
  if (!validAlias(alias))
    throw new Error(
      'Use the name of a Host from your ssh config: letters, digits, dot, dash and underscore, not starting with a dash.',
    );
  return alias;
}

/** Always on: ssh must never ask a question or trust a host key it has not seen. */
export const FIXED_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
] as const;

/** Used only where the owner's alias leaves the value at ssh's own default. */
export const DEFAULT_TIMEOUTS = {
  ConnectTimeout: '10',
  ServerAliveInterval: '15',
  ServerAliveCountMax: '3',
} as const;

/** ssh's built-in values, as `ssh -G` prints them when nothing set the option. */
const SSH_BUILT_IN: Record<keyof typeof DEFAULT_TIMEOUTS, string> = {
  ConnectTimeout: 'none',
  ServerAliveInterval: '0',
  ServerAliveCountMax: '3',
};

export interface SshSettings {
  /** The ssh program. Default `ssh` from PATH. */
  command?: string;
  /** An ssh config file to use instead of the owner's own (`-F`). Default: ssh's usual files. */
  configFile?: string;
}

/** The process FullDots starts. A seam for tests: no test starts a real ssh. */
export type SshChild = Pick<
  ChildProcess,
  'pid' | 'stdin' | 'stdout' | 'stderr' | 'kill' | 'once' | 'on'
> & { exitCode: number | null };

export type SshSpawner = (file: string, args: readonly string[]) => SshChild;

export const spawnSsh: SshSpawner = (file, args) =>
  spawn(file, [...args], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as SshChild;

/**
 * The full argument list for one ssh call: the config file, the fixed options, the timeouts the
 * alias did not set, the caller's own options, then `--`, the alias and the remote command.
 */
export function sshArgs(
  alias: string,
  settings: SshSettings,
  options: {
    timeouts?: readonly string[];
    extra?: readonly string[];
    remote?: string;
  } = {},
): string[] {
  requireAlias(alias);
  return [
    ...(settings.configFile ? ['-F', settings.configFile] : []),
    ...FIXED_OPTIONS,
    ...(options.timeouts ?? []),
    ...(options.extra ?? []),
    '--',
    alias,
    ...(options.remote ? [options.remote] : []),
  ];
}

/**
 * `-o` options for the timeouts this alias leaves at ssh's built-in value, read from `ssh -G`
 * output (which prints the effective config without connecting). A value the owner set wins.
 */
export function timeoutOptions(effective: string): string[] {
  const values = new Map<string, string>();
  for (const line of effective.split(/\r?\n/)) {
    const space = line.indexOf(' ');
    if (space > 0)
      values.set(line.slice(0, space).toLowerCase(), line.slice(space + 1));
  }
  const options: string[] = [];
  for (const [name, fallback] of Object.entries(DEFAULT_TIMEOUTS) as [
    keyof typeof DEFAULT_TIMEOUTS,
    string,
  ][]) {
    const value = values.get(name.toLowerCase());
    if (value === undefined || value === SSH_BUILT_IN[name])
      options.push('-o', `${name}=${fallback}`);
  }
  return options;
}

/** Why an ssh call failed, from what ssh printed. Never carries the output itself. */
export type SshProblem =
  | 'host_key_unknown'
  | 'host_key_changed'
  | 'refused'
  | 'alias_unknown'
  | 'unreachable'
  | 'docker_missing'
  | 'docker_denied'
  | 'docker_down'
  | 'failed';

export function classifySsh(stderr: string): SshProblem {
  const text = stderr.toLowerCase();
  if (text.includes('remote host identification has changed'))
    return 'host_key_changed';
  if (
    text.includes('host key verification failed') ||
    /no [a-z0-9-]{1,20} host key is known/.test(text)
  )
    return 'host_key_unknown';
  if (text.includes('permission denied (') || text.includes('too many auth'))
    return 'refused';
  if (
    text.includes('could not resolve hostname') ||
    text.includes('name or service not known') ||
    text.includes('nodename nor servname')
  )
    return 'alias_unknown';
  if (
    [
      'connection timed out',
      'connection refused',
      'no route to host',
      'network is unreachable',
      'operation timed out',
      'connection closed',
      'connection reset',
      'timeout, server',
    ].some((needle) => text.includes(needle))
  )
    return 'unreachable';
  if (text.includes('docker: not found') || text.includes('docker: command'))
    return 'docker_missing';
  if (text.includes('permission denied while trying to connect to the docker'))
    return 'docker_denied';
  if (text.includes('cannot connect to the docker daemon'))
    return 'docker_down';
  return 'failed';
}

/** What to tell the owner for each problem: what was found, then the step that fixes it. */
export function sshProblemMessage(problem: SshProblem, alias: string): string {
  switch (problem) {
    case 'host_key_unknown':
      return `ssh does not know the host key of ${alias}. Run \`ssh ${alias} true\` once in a terminal and check the key, then try again. FullDots never accepts a host key on its own.`;
    case 'host_key_changed':
      return `The host key of ${alias} changed since you last connected. Check with your server provider before you trust it, then update known_hosts by hand.`;
    case 'refused':
      return `${alias} refused the ssh login. Check that \`ssh ${alias} true\` works in a terminal without a password prompt (use a key or ssh-agent).`;
    case 'alias_unknown':
      return `${alias} could not be found. Check the Host and HostName lines in your ssh config.`;
    case 'unreachable':
      return `${alias} did not answer over ssh. Check that the server is on and that its firewall allows ssh from here.`;
    case 'docker_missing':
      return `Docker is not installed on ${alias}. Install Docker Engine there, then check again.`;
    case 'docker_denied':
      return `The ssh user on ${alias} cannot use Docker. Add it to the docker group (sudo usermod -aG docker $USER), log in again, then check again.`;
    case 'docker_down':
      return `Docker is not running on ${alias}. Start it (sudo systemctl start docker), then check again.`;
    case 'failed':
      return `ssh to ${alias} failed. Run \`ssh ${alias} true\` in a terminal to see why.`;
  }
}

/** One word for a POSIX shell on the server: ssh joins the remote command with spaces. */
export const shellQuote = (word: string) =>
  /^[A-Za-z0-9_./:=@%+,-]+$/.test(word)
    ? word
    : `'${word.replace(/'/g, `'\\''`)}'`;

export const remoteCommand = (words: readonly string[]) =>
  words.map(shellQuote).join(' ');
