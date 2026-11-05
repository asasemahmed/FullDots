// "Set up this server": the same pattern as the guided Docker setup (docker-setup.ts). Each step
// runs a fixed list of ssh commands, shown to the owner before it runs, and only after the request
// repeats exactly those commands. The images are built on the server from the same pinned
// Dockerfiles: the build context (this checkout's deployment/computers folder) travels on ssh's
// stdin, so nothing but ssh is needed here. The supervisor's two tokens also travel on stdin and
// never appear in a command, in the output or in a log.
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import {
  OPENBOT_CONTEXT,
  REMOTE_IMAGES,
  REMOTE_SUPERVISOR,
  REMOTE_SUPERVISOR_PORT,
  SERVER_ID_LABEL,
  type RemoteComputers,
} from './remote-computers.js';
import { UnreadableSecretsError, type RemoteSecrets } from './remote-store.js';
import {
  classifySsh,
  remoteCommand,
  requireAlias,
  sshArgs,
  sshProblemMessage,
  spawnSsh,
  timeoutOptions,
  type SshChild,
  type SshSpawner,
} from './remote-ssh.js';
import { effectiveSshConfig } from './remote-tunnel.js';
import {
  REMOTE_SETUP_STEPS,
  type RemoteSetupJob,
  type RemoteSetupPlan,
  type RemoteSetupStep,
} from '../shared/remote-computer-types.js';

const CONTEXT_DIR = join('deployment', 'computers');
const OUTPUT_TAIL = 4000;
const DETAILS = 'See Technical details for what the server reported.';
const HEALTH_POLLS = 30;

/** What a step sends on ssh's stdin, never in the command line. */
type Stdin = 'context' | 'supervisor-settings';

interface RemoteStepCommand {
  /** The command for the server's shell. */
  remote: string;
  stdin?: Stdin;
  /** A failure that is expected and fine, e.g. removing a supervisor that does not exist. */
  mayFail?: boolean;
  /** Reads which FullDots server record started the supervisor that is there now. */
  reads?: 'server-id';
}

const STDIN_LABEL: Record<Stdin, string> = {
  context: '< deployment/computers (sent as a tar archive)',
  'supervisor-settings': '< supervisor settings (two tokens, never shown)',
};

class StepFailed extends Error {}

/**
 * Where the set-up steps are offered: FullDots runs on the owner's own machine (it runs the
 * owner's ssh). Building the images also needs a checkout with the Dockerfiles.
 */
export function remoteSetupEnabled(options: {
  host: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  inContainer?: boolean;
}): { ssh: boolean; build: boolean } {
  const env = options.env ?? process.env;
  const ssh =
    (env.DOCKER_SETUP ?? 'auto').toLowerCase() !== 'off' &&
    ['127.0.0.1', '::1', 'localhost'].includes(options.host) &&
    !(options.inContainer ?? existsSync('/.dockerenv'));
  return {
    ssh,
    build: ssh && existsSync(join(options.cwd ?? process.cwd(), CONTEXT_DIR)),
  };
}

/** The supervisor's settings, as the env file `docker run --env-file` reads. */
export function supervisorEnv(
  secrets: RemoteSecrets,
  namespace: string,
): string {
  return [
    'PORT=4300',
    `SUPERVISOR_TOKEN=${secrets.supervisorToken}`,
    `COMPUTER_TOKEN=${secrets.computerToken}`,
    `COMPUTER_NAMESPACE=${namespace}`,
    `COMPUTER_IMAGE=${REMOTE_IMAGES.browser}`,
    `COMPUTER_DESKTOP_IMAGE=${REMOTE_IMAGES.desktop}`,
    'COMPUTER_BROWSER_MODE=headed',
    'COMPUTER_NETWORK=',
    'COMPUTER_CPUS=2',
    '',
  ].join('\n');
}

/** The `docker run` that starts the supervisor; the same words the guide gives for a set-up by hand. */
export function supervisorRunWords(serverId: string): string[] {
  return [
    'docker',
    'run',
    '-d',
    '--name',
    REMOTE_SUPERVISOR,
    '--label',
    'fulldots.remote-supervisor=true',
    '--label',
    `${SERVER_ID_LABEL}=${serverId}`,
    '--restart',
    'unless-stopped',
    '--init',
    '--security-opt',
    'no-new-privileges:true',
    '--cap-drop',
    'ALL',
    '--memory',
    '512m',
    '--pids-limit',
    '256',
    '-p',
    `127.0.0.1:${REMOTE_SUPERVISOR_PORT}:4300`,
    '-v',
    '/var/run/docker.sock:/var/run/docker.sock',
    '--env-file',
    '/dev/stdin',
    REMOTE_IMAGES.supervisor,
  ];
}

function build(tag: string, dockerfile: string): RemoteStepCommand {
  return {
    remote: remoteCommand([
      'docker',
      'build',
      '--progress=plain',
      '-t',
      tag,
      '-f',
      `deployment/computers/${dockerfile}`,
      '--build-context',
      `openbot=${OPENBOT_CONTEXT}`,
      '-',
    ]),
    stdin: 'context',
  };
}

function stepCommands(
  step: RemoteSetupStep,
  serverId: string,
): RemoteStepCommand[] {
  switch (step) {
    case 'check-alias':
      return [{ remote: 'true' }];
    case 'check-docker':
      return [
        {
          remote: remoteCommand([
            'docker',
            'version',
            '--format',
            '{{.Server.Version}}',
          ]),
        },
      ];
    case 'build-images':
      return [
        build(REMOTE_IMAGES.supervisor, 'supervisor.Dockerfile'),
        build(REMOTE_IMAGES.browser, 'computer.Dockerfile'),
        build(REMOTE_IMAGES.desktop, 'computer-desktop.Dockerfile'),
      ];
    case 'start-supervisor':
      return [
        {
          remote: remoteCommand([
            'docker',
            'inspect',
            '--format',
            `{{index .Config.Labels "${SERVER_ID_LABEL}"}}`,
            REMOTE_SUPERVISOR,
          ]),
          mayFail: true,
          reads: 'server-id',
        },
        {
          remote: remoteCommand(['docker', 'rm', '-f', REMOTE_SUPERVISOR]),
          mayFail: true,
        },
        {
          remote: remoteCommand(supervisorRunWords(serverId)),
          stdin: 'supervisor-settings',
        },
      ];
  }
}

const NOTES: Record<RemoteSetupStep, { title: string; note: string }> = {
  'check-alias': {
    title: 'Check the alias',
    note: 'Logs in with your ssh config and runs `true`. ssh never asks a question and never accepts an unknown host key: run `ssh <alias> true` once in a terminal first.',
  },
  'check-docker': {
    title: 'Check Docker on the server',
    note: 'Asks the server’s Docker for its version. Changes nothing.',
  },
  'build-images': {
    title: 'Build the images',
    note: 'Builds the supervisor, browser and desktop images on the server from the pinned OpenBot source, the same Dockerfiles this machine uses. The deployment/computers folder of this checkout is sent on standard input as the build context. The first build downloads about a gigabyte and takes several minutes; it keeps running if you close this page.',
  },
  'start-supervisor': {
    title: 'Start the supervisor',
    note: 'Checks which FullDots server started the supervisor that is there, replaces it (Dot computers and their files stay) and starts it bound to 127.0.0.1 on the server, so only ssh reaches it. Its two tokens are made by FullDots, stored encrypted here, and sent on standard input.',
  },
};

/**
 * A minimal POSIX tar of the build context: regular files and folders only, fixed metadata.
 * Symbolic links are skipped, never followed, so nothing outside the folder can be sent.
 */
export function contextTar(root: string): Buffer {
  const base = join(root, CONTEXT_DIR);
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: '0' | '5') => {
    if (Buffer.byteLength(name) > 100)
      throw new Error(`Build context path is too long: ${name}`);
    const block = Buffer.alloc(512, 0);
    block.write(name, 0, 100, 'utf8');
    block.write(type === '5' ? '0000755\0' : '0000644\0', 100, 8, 'ascii');
    block.write('0000000\0', 108, 8, 'ascii');
    block.write('0000000\0', 116, 8, 'ascii');
    block.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    block.write('00000000000\0', 136, 12, 'ascii');
    block.write('        ', 148, 8, 'ascii');
    block.write(type, 156, 1, 'ascii');
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    return block;
  };
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry);
      const name = relative(root, path).split(sep).join('/');
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        blocks.push(header(`${name}/`, 0, '5'));
        walk(path);
      } else if (stat.isFile()) {
        const data = readFileSync(path);
        blocks.push(header(name, data.length, '0'), data);
        const pad = (512 - (data.length % 512)) % 512;
        if (pad) blocks.push(Buffer.alloc(pad, 0));
      }
    }
  };
  blocks.push(
    header('deployment/', 0, '5'),
    header('deployment/computers/', 0, '5'),
  );
  walk(base);
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export interface RemoteSetupOptions {
  remote: RemoteComputers;
  enabled: { ssh: boolean; build: boolean } | boolean;
  cwd?: string;
  namespace?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A command as the owner would type it. Quoting is for reading only: ssh gets an argument array. */
const show = (file: string, args: readonly string[], stdin?: Stdin) =>
  [file, ...args]
    .map((part) =>
      /[\s{}"'#]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part,
    )
    .join(' ') + (stdin ? ` ${STDIN_LABEL[stdin]}` : '');

export class RemoteSetup {
  private job?: RemoteSetupJob;
  /** Set before anything is awaited, so two steps can never run at once. */
  private busy = false;
  private current?: Promise<void>;
  private readonly timeouts = new Map<string, string[]>();
  private readonly cwd: string;
  private readonly spawn: SshSpawner;
  private readonly allowed: { ssh: boolean; build: boolean };

  constructor(private readonly options: RemoteSetupOptions) {
    this.cwd = options.cwd ?? process.cwd();
    this.spawn = options.remote.spawn ?? spawnSsh;
    this.allowed =
      typeof options.enabled === 'boolean'
        ? { ssh: options.enabled, build: options.enabled }
        : options.enabled;
  }

  /** Whether FullDots can run the owner's ssh here for the set-up steps. */
  get enabled() {
    return this.allowed.ssh;
  }
  /** Whether this checkout has the Dockerfiles to build the images. */
  get canBuild() {
    return this.allowed.build;
  }

  lastJob(): RemoteSetupJob | undefined {
    return this.job && { ...this.job };
  }

  private async timeoutsFor(alias: string) {
    let options = this.timeouts.get(alias);
    if (!options) {
      options = timeoutOptions(
        await effectiveSshConfig(this.options.remote.ssh, this.spawn)(alias),
      );
      this.timeouts.set(alias, options);
    }
    return options;
  }

  private async argv(alias: string, command: RemoteStepCommand) {
    return sshArgs(alias, this.options.remote.ssh, {
      timeouts: await this.timeoutsFor(alias),
      remote: command.remote,
    });
  }

  private file() {
    return this.options.remote.ssh.command ?? 'ssh';
  }

  /** The steps and their exact commands for this alias. Runs only `ssh -G`, which connects nowhere. */
  async plans(alias: string): Promise<RemoteSetupPlan[]> {
    requireAlias(alias);
    const serverId = this.options.remote.store.serverId(alias);
    return Promise.all(
      REMOTE_SETUP_STEPS.map(async (step) => ({
        step,
        ...NOTES[step],
        ...(step === 'build-images' && !this.canBuild
          ? {
              note: `${NOTES[step].note} This FullDots does not run from a checkout with deployment/computers, so it cannot send the Dockerfiles: build the images by hand (see the guide).`,
              unavailable: true,
            }
          : {}),
        commands: await Promise.all(
          stepCommands(step, serverId).map(async (command) =>
            show(this.file(), await this.argv(alias, command), command.stdin),
          ),
        ),
      })),
    );
  }

  /** Starts a step once `approved` repeats its commands exactly. Returns at once. */
  async start(
    alias: string,
    step: RemoteSetupStep,
    approved: readonly string[],
  ): Promise<RemoteSetupJob> {
    if (!this.enabled)
      throw new Error('Setting up a server is not available here.');
    requireAlias(alias);
    if (step === 'build-images' && !this.canBuild)
      throw new Error(
        'Building the images needs FullDots to run from a checkout with deployment/computers.',
      );
    if (this.busy || this.job?.state === 'running')
      throw new Error('Another setup step is still running.');
    this.busy = true;
    try {
      const plan = (await this.plans(alias)).find(
        (item) => item.step === step,
      )!;
      if (
        approved.length !== plan.commands.length ||
        approved.some((command, index) => command !== plan.commands[index])
      )
        throw new Error('The approved commands do not match this step.');
      const job: RemoteSetupJob = {
        id: randomUUID(),
        alias,
        step,
        state: 'running',
        output: '',
        message: `${plan.title}…`,
      };
      this.job = job;
      this.current = this.execute(job).finally(() => {
        this.busy = false;
      });
      return { ...job };
    } catch (error) {
      this.busy = false;
      throw error;
    }
  }

  async settled(id: string, ms: number): Promise<RemoteSetupJob | undefined> {
    if (this.job?.id === id && this.job.state === 'running' && this.current) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.current,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
        }),
      ]);
      clearTimeout(timer);
    }
    return this.job?.id === id ? { ...this.job } : undefined;
  }

  private redact(text: string) {
    let out = text;
    for (const secret of this.options.remote.allSecrets())
      out = out.split(secret).join('[redacted]');
    return out;
  }

  /**
   * Keeps the last part of the output. Redacted before the cut and again after it; the cut line is
   * dropped, so a token split by the cut can never show its other half.
   */
  private append(job: RemoteSetupJob, text: string) {
    const whole = this.redact(job.output + text);
    if (whole.length <= OUTPUT_TAIL) {
      job.output = whole;
      return;
    }
    const tail = whole.slice(-OUTPUT_TAIL);
    const newline = tail.indexOf('\n');
    job.output = this.redact(newline >= 0 ? tail.slice(newline + 1) : '');
  }

  private stdinFor(
    alias: string,
    stdin: Stdin | undefined,
  ): Buffer | undefined {
    if (stdin === 'context') return contextTar(this.cwd);
    if (stdin === 'supervisor-settings')
      return Buffer.from(
        supervisorEnv(
          this.options.remote.secrets(alias),
          this.options.namespace ?? 'opendots',
        ),
      );
    return undefined;
  }

  private async run(
    job: RemoteSetupJob,
    command: RemoteStepCommand,
    quiet = false,
  ) {
    const args = await this.argv(job.alias, command);
    if (!quiet)
      this.append(job, `> ${show(this.file(), args, command.stdin)}\n`);
    const input = this.stdinFor(job.alias, command.stdin);
    return new Promise<{ code: number | null; output: string }>((resolve) => {
      let output = '';
      let child: SshChild;
      try {
        child = this.spawn(this.file(), args);
      } catch (error) {
        resolve({
          code: null,
          output:
            error instanceof Error ? error.message : 'ssh could not start.',
        });
        return;
      }
      let done = false;
      const finish = (code: number | null, extra = '') => {
        if (done) return;
        done = true;
        resolve({ code, output: this.redact(output + extra) });
      };
      const collect = (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        output = (output + text).slice(-20_000);
        if (!quiet) this.append(job, text);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.stdin?.on('error', () => undefined);
      child.on('error', (error: Error) => finish(null, error.message));
      // 'close' waits for the output streams to end, so nothing is cut off.
      child.once('close', (code: number | null) => finish(code));
      child.stdin?.end(input);
    });
  }

  private async execute(job: RemoteSetupJob) {
    try {
      job.message = await this.step(job);
      job.state = 'done';
    } catch (error) {
      job.message =
        error instanceof StepFailed
          ? error.message
          : `The step stopped unexpectedly. ${DETAILS}`;
      job.state = 'failed';
    } finally {
      this.options.remote.forget(job.alias);
      // A tunnel opened for this step is stopped again when nothing uses the server.
      this.options.remote.pruneIdle();
    }
  }

  private async step(job: RemoteSetupJob): Promise<string> {
    const { alias } = job;
    const store = this.options.remote.store;
    let notes = '';
    if (job.step === 'start-supervisor') {
      try {
        store.secrets(alias);
      } catch (error) {
        if (!(error instanceof UnreadableSecretsError)) throw error;
        store.reset(alias);
        notes =
          ' The stored tokens could not be decrypted, so FullDots made new ones; the supervisor uses them now.';
      }
    }
    const commands = stepCommands(job.step, store.serverId(alias));
    const results = [];
    for (const command of commands) {
      const result = await this.run(job, command);
      results.push(result);
      if (command.reads === 'server-id' && result.code === 0) {
        const found = result.output.trim().split(/\s+/).pop() ?? '';
        const owner = found ? store.aliasForServerId(found) : undefined;
        if (owner && owner !== alias)
          throw new StepFailed(
            `${alias} is the same server as ${owner}, which FullDots already set up. Use ${owner} for this server; two aliases for one server would replace each other’s tokens.`,
          );
      }
      if (result.code !== 0 && !command.mayFail) {
        // ssh itself exits with 255; anything else is the command on the server.
        const problem =
          result.code === 255 ||
          result.code === null ||
          job.step === 'check-docker'
            ? classifySsh(result.output)
            : 'failed';
        throw new StepFailed(
          problem === 'failed'
            ? job.step === 'build-images'
              ? `The build stopped. ${DETAILS}`
              : `The command failed on ${alias}. ${DETAILS}`
            : sshProblemMessage(problem, alias),
        );
      }
    }
    switch (job.step) {
      case 'check-alias':
        return `ssh to ${alias} works.`;
      case 'check-docker':
        return `Docker ${results[0]!.output.trim().split(/\s+/)[0] ?? ''} answers on ${alias}.`;
      case 'build-images':
        return `The images are built on ${alias}.`;
      case 'start-supervisor':
        return (await this.waitForSupervisor(alias)) + notes;
    }
  }

  private async waitForSupervisor(alias: string): Promise<string> {
    const sleep = this.options.sleep ?? delay;
    for (let attempt = 0; attempt < HEALTH_POLLS; attempt++) {
      try {
        const origin = await this.options.remote.supervisorOrigin(alias);
        const response = await (this.options.fetch ?? fetch)(
          `${origin}/health`,
          {
            signal: AbortSignal.timeout(3000),
          },
        );
        if (response.ok)
          return `The supervisor runs on ${alias}, bound to the server’s loopback. Turn a computer on from its Computer panel.`;
      } catch {
        // Still starting.
      }
      await sleep(1000);
    }
    throw new StepFailed(
      `The supervisor did not answer on ${alias}. Check \`ssh ${alias} docker logs ${REMOTE_SUPERVISOR}\`.`,
    );
  }
}
