// Dot computers on the owner's own server. The supervisor and every computer run there, bound to
// the server's loopback; FullDots reaches them only through the ssh tunnel in remote-tunnel.ts.
// Everything here fails closed: an unreachable server is an error, never a reason to use this
// machine's Docker instead, and a container that is not exactly what FullDots expects is refused,
// never repaired. FullDots never removes a computer on the server on its own.
import type { ComputerStore } from './computer-store.js';
import { ComputerError } from './computer-errors.js';
import type { RemoteStore, RemoteSecrets } from './remote-store.js';
import {
  remoteCommand,
  requireNamespace,
  sshProblemMessage,
  type SshProblem,
  type SshSettings,
  type SshSpawner,
  validAlias,
} from './remote-ssh.js';
import {
  RemoteTunnel,
  TunnelError,
  type TunnelOptions,
} from './remote-tunnel.js';
import type {
  RemoteCheck,
  RemoteCheckResult,
} from '../shared/remote-computer-types.js';

/** The images FullDots builds on the server, the same tags compose.computers.yml builds here. */
export const REMOTE_IMAGES = {
  supervisor: 'opendots-supervisor:b6932d3-desktop1',
  browser: 'opendots-computer:b6932d3-acp5',
  desktop: 'opendots-computer-desktop:b6932d3-desk1',
} as const;
export const OPENBOT_CONTEXT =
  'https://github.com/CopilotKit/OpenBot.git#b6932d31a8d6e7896c15139dfc27a6c6911deb27';
export const REMOTE_SUPERVISOR = 'fulldots-computer-supervisor';
/** The supervisor's port on the server's loopback. */
export const REMOTE_SUPERVISOR_PORT = 4312;
/** The label that names which FullDots server record started the supervisor. */
export const SERVER_ID_LABEL = 'fulldots.server-id';
const OWNER_LABEL = 'openbot.supervisor';
const BOT_LABEL = 'openbot.bot-id';
const NAMESPACE_LABEL = 'openbot.namespace';
const KIND_LABEL = 'fulldots.computer.kind';
/** Server-wide facts are asked again after this long. Computer facts are asked before every use. */
const SERVER_CHECK_MS = 5000;

/** A container FullDots refuses to use. It is never repaired automatically. */
export class UnsafeComputerError extends ComputerError {}

export type DotTarget =
  { where: 'local' } | { where: 'remote'; alias: string | undefined };

/** What the server's Docker reports about a container, without its environment. */
export interface ContainerFacts {
  image?: unknown;
  labels?: Record<string, string> | null;
  running?: unknown;
  health?: unknown;
  capDrop?: unknown;
  capAdd?: unknown;
  securityOpt?: unknown;
  memory?: unknown;
  pidsLimit?: unknown;
  privileged?: unknown;
  networkMode?: unknown;
  pidMode?: unknown;
  ipcMode?: unknown;
  usernsMode?: unknown;
  utsMode?: unknown;
  cgroupnsMode?: unknown;
  /** The daemon's own default cgroup namespace mode (private on cgroup v2, host on v1). */
  cgroupnsDefault?: unknown;
  sysctls?: unknown;
  devices?: unknown;
  runtime?: unknown;
  portBindings?: unknown;
  ports?: unknown;
  mounts?: unknown;
}

const LOOPBACK = new Set(['127.0.0.1', '::1']);

interface Binding {
  container: string;
  ip: string;
  port: string;
}

/** Every published binding; an empty address means every address. */
function bindings(facts: ContainerFacts): Binding[] {
  const out: Binding[] = [];
  for (const table of [facts.portBindings, facts.ports]) {
    if (!table || typeof table !== 'object') continue;
    for (const [container, list] of Object.entries(
      table as Record<string, unknown>,
    )) {
      if (!Array.isArray(list)) continue;
      for (const binding of list) {
        const item =
          binding && typeof binding === 'object'
            ? (binding as { HostIp?: unknown; HostPort?: unknown })
            : {};
        out.push({
          container,
          ip: typeof item.HostIp === 'string' ? item.HostIp : '',
          port: typeof item.HostPort === 'string' ? item.HostPort : '',
        });
      }
    }
  }
  return out;
}

/** Whether a container publishes this host port for its API on the server's loopback. */
export function publishesOnLoopback(
  facts: ContainerFacts,
  containerPort: string,
  hostPort: number,
): boolean {
  return bindings(facts).some(
    (binding) =>
      binding.container === containerPort &&
      LOOPBACK.has(binding.ip) &&
      binding.port === String(hostPort),
  );
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.map(String) : [];
const isEmpty = (value: unknown) =>
  value === null ||
  value === undefined ||
  (Array.isArray(value) && value.length === 0);

/**
 * The hardening every container FullDots uses must keep. Any value other than the default the
 * supervisor (or the setup step) creates is refused.
 */
function hardening(
  facts: ContainerFacts,
  allowedMounts: (mount: {
    type?: string;
    name?: string;
    source?: string;
    destination?: string;
  }) => boolean,
): string | undefined {
  if (facts.privileged !== false) return 'it runs privileged';
  if (!['', 'default', 'bridge'].includes(String(facts.networkMode ?? '')))
    return `it uses the ${String(facts.networkMode)} network instead of the default bridge`;
  const published = bindings(facts).filter(
    (binding) => !LOOPBACK.has(binding.ip),
  );
  if (published.length)
    return `it publishes a port on ${published[0]!.ip || 'every address'}`;
  if (!strings(facts.capDrop).some((cap) => cap.toUpperCase() === 'ALL'))
    return 'it does not drop all capabilities';
  if (!isEmpty(facts.capAdd)) return 'it adds capabilities';
  const options = strings(facts.securityOpt);
  if (
    !options.some((option) =>
      [
        'no-new-privileges',
        'no-new-privileges:true',
        'no-new-privileges=true',
      ].includes(option),
    )
  )
    return 'it allows new privileges';
  if (options.some((option) => /unconfined|label[:=]disable/i.test(option)))
    return 'it turns off a security profile';
  if (String(facts.pidMode ?? '') !== '')
    return 'it shares a process namespace';
  if (!['', 'private', 'shareable'].includes(String(facts.ipcMode ?? '')))
    return 'it shares an IPC namespace';
  if (String(facts.usernsMode ?? '') !== '')
    return 'it changes the user namespace';
  if (String(facts.utsMode ?? '') !== '')
    return 'it shares the host name namespace';
  if (
    !['', String(facts.cgroupnsDefault ?? 'private')].includes(
      String(facts.cgroupnsMode ?? ''),
    )
  )
    return 'it changes the cgroup namespace';
  if (
    facts.sysctls &&
    typeof facts.sysctls === 'object' &&
    Object.keys(facts.sysctls).length
  )
    return 'it sets kernel parameters';
  if (!isEmpty(facts.devices)) return 'it has host devices';
  if (!['', 'runc'].includes(String(facts.runtime ?? '')))
    return `it uses the ${String(facts.runtime)} runtime`;
  const mounts = Array.isArray(facts.mounts)
    ? (facts.mounts as {
        type?: string;
        name?: string;
        source?: string;
        destination?: string;
      }[])
    : [];
  const bad = mounts.find((mount) => !allowedMounts(mount));
  if (bad)
    return bad.type === 'bind'
      ? `it mounts ${bad.source ?? 'a host path'} from the server`
      : 'it has a mount FullDots does not create';
  if (!(typeof facts.memory === 'number' && facts.memory > 0))
    return 'it has no memory limit';
  if (!(typeof facts.pidsLimit === 'number' && facts.pidsLimit > 0))
    return 'it has no process limit';
  return undefined;
}

/** Why a computer container must not be used, or undefined when it is safe. */
export function unsafeReason(
  facts: ContainerFacts,
  expected: {
    image: string;
    kind: 'browser' | 'desktop';
    namespace: string;
    dotId: string;
  },
): string | undefined {
  const labels = facts.labels ?? {};
  if (labels[OWNER_LABEL] !== 'true')
    return 'it was not created by the computer supervisor';
  if ((labels[NAMESPACE_LABEL] ?? 'openbot') !== expected.namespace)
    return 'it belongs to another deployment';
  if (labels[BOT_LABEL] !== expected.dotId) return 'it belongs to another Dot';
  if (facts.image !== expected.image)
    return `it runs ${typeof facts.image === 'string' ? facts.image : 'an unknown image'} instead of ${expected.image}`;
  if ((labels[KIND_LABEL] ?? 'browser') !== expected.kind)
    return `it is a ${labels[KIND_LABEL] ?? 'browser'} computer, not a ${expected.kind} one`;
  // Only its own two named volumes, each at its own path, named the way the supervisor names them.
  const own: Record<string, string> = {
    '/profiles': `${expected.namespace}-profile-${expected.dotId}`,
    '/workspace': `${expected.namespace}-workspace-${expected.dotId}`,
  };
  return hardening(
    facts,
    (mount) =>
      mount.type === 'volume' &&
      own[mount.destination ?? ''] !== undefined &&
      mount.name === own[mount.destination ?? ''],
  );
}

/** Why the supervisor container must not be used, or undefined when it is the one FullDots starts. */
export function supervisorUnsafeReason(
  facts: ContainerFacts,
): string | undefined {
  if (facts.image !== REMOTE_IMAGES.supervisor)
    return `it runs ${typeof facts.image === 'string' ? facts.image : 'an unknown image'} instead of ${REMOTE_IMAGES.supervisor}`;
  if (facts.labels?.['fulldots.remote-supervisor'] !== 'true')
    return 'it was not started by FullDots';
  if (!publishesOnLoopback(facts, '4300/tcp', REMOTE_SUPERVISOR_PORT))
    return `it is not published on 127.0.0.1:${REMOTE_SUPERVISOR_PORT}`;
  // Exactly one bind: the Docker socket it exists to hold.
  return hardening(
    facts,
    (mount) =>
      mount.type === 'bind' &&
      mount.source === '/var/run/docker.sock' &&
      mount.destination === '/var/run/docker.sock',
  );
}

/** The container a Dot's computer has; the same rule the supervisor and the app use. */
export const containerName = (namespace: string, dotId: string) =>
  `${namespace}-computer-${dotId}`;

/** The command that removes a Dot's leftover computer by hand. Its files stay in their volumes. */
export function removeCommand(
  target: DotTarget,
  namespace: string,
  dotId: string,
): string {
  const words = ['docker', 'rm', '-f', containerName(namespace, dotId)];
  return target.where === 'remote' && target.alias
    ? `ssh ${target.alias} ${remoteCommand(words)}`
    : remoteCommand(words);
}

/** Which status check a tunnel problem belongs to. */
export function checkFor(problem: SshProblem | 'tunnel_down'): RemoteCheck {
  if (['docker_missing', 'docker_denied', 'docker_down'].includes(problem))
    return 'docker_unreachable';
  if (problem === 'image_missing') return 'images_missing';
  return 'ssh_failed';
}

export interface RemoteComputersOptions {
  store: RemoteStore;
  computers: Pick<ComputerStore, 'server'>;
  ssh?: SshSettings;
  spawn?: SshSpawner;
  namespace?: string;
  /** Builds the tunnel for a server. A seam for tests. */
  tunnel?: (alias: string, options: TunnelOptions) => RemoteTunnel;
  log?: (message: string) => void;
}

export class RemoteComputers {
  private readonly tunnels = new Map<string, RemoteTunnel>();
  private readonly serverChecks = new Map<
    string,
    { at: number; result: RemoteCheckResult | undefined }
  >();
  private inUse: () => Iterable<string> = () => [];
  readonly namespace: string;

  private readonly namespaceValid: boolean;

  constructor(private readonly options: RemoteComputersOptions) {
    this.namespace = options.namespace ?? 'opendots';
    try {
      requireNamespace(this.namespace);
      this.namespaceValid = true;
    } catch {
      // Not fatal for the app: computers on this machine refuse it too. Remote use is refused.
      this.namespaceValid = false;
    }
  }

  get ssh(): SshSettings {
    return this.options.ssh ?? {};
  }
  get spawn(): SshSpawner | undefined {
    return this.options.spawn;
  }
  get store(): RemoteStore {
    return this.options.store;
  }

  /** Tells which aliases a Dot or the default still uses, so idle tunnels can be stopped. */
  setUsage(inUse: () => Iterable<string>) {
    this.inUse = inUse;
  }

  defaults() {
    return this.options.store.defaults();
  }

  setDefaults(where: 'local' | 'remote', alias: string | undefined) {
    this.options.store.setDefaults(where, alias);
    this.forget();
  }

  /** Where this Dot's computer lives: its own alias wins over the default. */
  target(dotId: string): DotTarget {
    const own = this.options.computers.server(dotId);
    if (own) return { where: 'remote', alias: own };
    const defaults = this.options.store.defaults();
    return defaults.where === 'remote'
      ? { where: 'remote', alias: defaults.alias }
      : { where: 'local' };
  }

  secrets(alias: string): RemoteSecrets {
    return this.options.store.secrets(alias);
  }

  /** Every token FullDots made for any server, for redaction. */
  allSecrets(): string[] {
    const secrets: string[] = [];
    for (const alias of this.options.store.servers()) {
      try {
        const { supervisorToken, computerToken } = this.secrets(alias);
        secrets.push(supervisorToken, computerToken);
      } catch {
        // A server whose tokens no longer decrypt has nothing to redact.
      }
    }
    return secrets;
  }

  tunnel(alias: string): RemoteTunnel {
    let tunnel = this.tunnels.get(alias);
    if (!tunnel || tunnel.state === 'stopped') {
      const options: TunnelOptions = {
        settings: this.ssh,
        namespace: this.namespace,
        supervisorImage: REMOTE_IMAGES.supervisor,
        ...(this.options.spawn ? { spawn: this.options.spawn } : {}),
        ...(this.options.log ? { log: this.options.log } : {}),
      };
      tunnel = this.options.tunnel
        ? this.options.tunnel(alias, options)
        : new RemoteTunnel(alias, options);
      this.tunnels.set(alias, tunnel);
    }
    return tunnel;
  }

  /** The aliases of the tunnels FullDots runs now. */
  open(): string[] {
    return [...this.tunnels.entries()]
      .filter(([, tunnel]) => tunnel.state !== 'stopped')
      .map(([alias]) => alias);
  }

  /** Opens the tunnel or explains, in one sentence with the fix, why it cannot. */
  async ready(
    alias: string | undefined,
    options: { force?: boolean } = {},
  ): Promise<RemoteTunnel> {
    if (!alias || !validAlias(alias))
      throw new ComputerError(
        503,
        'No server is set for this Dot’s computer. Type the ssh alias of your server in Settings → Computers.',
      );
    if (!this.namespaceValid)
      throw new ComputerError(503, 'Invalid computer namespace.');
    const tunnel = this.tunnel(alias);
    try {
      await tunnel.ready(options);
      return tunnel;
    } catch (error) {
      throw new ComputerError(
        503,
        error instanceof TunnelError
          ? error.message
          : sshProblemMessage('unreachable', alias),
        { cause: error },
      );
    }
  }

  /** The supervisor's address on this machine, through the tunnel. */
  async supervisorOrigin(alias: string | undefined): Promise<string> {
    const tunnel = await this.ready(alias);
    return `http://127.0.0.1:${await tunnel.bridge('supervisor', REMOTE_SUPERVISOR_PORT)}`;
  }

  /** Why calls to this server fail right now, if the tunnel knows. */
  down(alias: string): string | undefined {
    const tunnel = this.tunnels.get(alias);
    if (!tunnel || tunnel.state === 'up' || tunnel.state === 'idle')
      return undefined;
    const problem = tunnel.problem ?? 'unreachable';
    return `${sshProblemMessage(problem, alias)} FullDots keeps trying to reconnect.`;
  }

  /** Why calls through this local port fail right now, when it is a tunnel port that is down. */
  downAt(port: number): string | undefined {
    for (const [alias, tunnel] of this.tunnels)
      if (tunnel.bridgeAt(port)) return this.down(alias);
    return undefined;
  }

  private async facts(
    tunnel: RemoteTunnel,
    name: string,
  ): Promise<ContainerFacts | undefined> {
    let answer: unknown;
    try {
      answer = await tunnel.request('inspect', name);
    } catch (error) {
      throw new ComputerError(
        503,
        error instanceof Error ? error.message : 'The server did not answer.',
      );
    }
    const facts =
      answer && typeof answer === 'object'
        ? (answer as { facts?: unknown; error?: unknown })
        : {};
    if (facts.error)
      throw new ComputerError(503, `Docker on ${tunnel.alias} did not answer.`);
    return facts.facts && typeof facts.facts === 'object'
      ? (facts.facts as ContainerFacts)
      : undefined;
  }

  /**
   * The local address of one Dot's computer, checked before every use: the supervisor's answer must
   * name a port the container itself publishes on the server's loopback for its API, and the
   * container must still be the hardened one FullDots expects. The relay checks the same port
   * against the same Dot again on the server before it connects.
   */
  async origin(
    alias: string,
    dotId: string,
    state: { port?: number; url?: string },
    kind: 'browser' | 'desktop',
  ): Promise<string> {
    const port = state.port;
    if (!port)
      throw new ComputerError(
        502,
        'Computer endpoint is not bound to this Dot.',
      );
    const url = new URL(state.url ?? `http://127.0.0.1:${port}`);
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.port !== String(port) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new ComputerError(
        502,
        'Computer endpoint is not bound to this Dot.',
      );
    const tunnel = await this.ready(alias);
    const name = containerName(this.namespace, dotId);
    const facts = await this.facts(tunnel, name);
    // Gone, or stopping right now: not unsafe, just not running.
    if (!facts || facts.running !== true)
      throw new ComputerError(409, 'Start this Dot’s computer first.');
    const reason = unsafeReason(facts, {
      image: REMOTE_IMAGES[kind],
      kind,
      namespace: this.namespace,
      dotId,
    });
    if (reason)
      throw new UnsafeComputerError(
        502,
        `FullDots will not use this computer on ${alias}: ${reason}. It is not repaired automatically. Remove it by hand (its files stay): ${removeCommand({ where: 'remote', alias }, this.namespace, dotId)}`,
      );
    if (!publishesOnLoopback(facts, '4100/tcp', port))
      throw new ComputerError(
        502,
        'Computer endpoint is not bound to this Dot.',
      );
    const local = await tunnel.bridge(dotId, port);
    if (!this.ownsPort(alias, dotId, local, port))
      throw new ComputerError(
        502,
        'Computer endpoint is not bound to this Dot.',
      );
    return `http://127.0.0.1:${local}`;
  }

  /**
   * Whether a local tunnel port belongs to this Dot on this server and leads to the port its
   * container was just seen publishing, and to nothing else.
   */
  ownsPort(
    alias: string,
    dotId: string,
    local: number,
    remotePort: number,
  ): boolean {
    const bridge = this.tunnels.get(alias)?.bridgeAt(local);
    return bridge?.owner === dotId && bridge.remotePort === remotePort;
  }

  /**
   * The first server-wide check that fails, in the order of the guide, or undefined when ssh,
   * Docker, the images and the supervisor are all fine. Cached for a few seconds; `force` (an
   * explicit check) asks again and retries problems that do not retry on their own.
   */
  async serverCheck(
    alias: string | undefined,
    options: { force?: boolean } = {},
  ): Promise<RemoteCheckResult | undefined> {
    if (!alias || !validAlias(alias))
      return {
        check: 'alias_not_set',
        message:
          'No server is set. Type the ssh alias of your server in Settings → Computers.',
      };
    if (!this.namespaceValid)
      return {
        alias,
        check: 'ssh_failed',
        message:
          'COMPUTER_NAMESPACE is invalid: use letters, digits, dash and underscore, starting with a letter or digit.',
      };
    const cached = this.serverChecks.get(alias);
    if (!options.force && cached && Date.now() - cached.at < SERVER_CHECK_MS)
      return cached.result;
    const result = await this.checkServer(alias, !!options.force);
    this.serverChecks.set(alias, { at: Date.now(), result });
    return result;
  }

  /** Forgets cached checks, e.g. after a setup step. */
  forget(alias?: string) {
    if (alias) this.serverChecks.delete(alias);
    else this.serverChecks.clear();
  }

  private async checkServer(
    alias: string,
    force: boolean,
  ): Promise<RemoteCheckResult | undefined> {
    const tunnel = this.tunnel(alias);
    try {
      await tunnel.ready({ force });
    } catch (error) {
      const problem =
        error instanceof TunnelError ? error.problem : 'unreachable';
      const check = checkFor(problem);
      return {
        alias,
        check,
        message:
          error instanceof Error
            ? error.message
            : sshProblemMessage('failed', alias),
        ...(check === 'ssh_failed'
          ? { command: `ssh ${alias} true` }
          : check === 'docker_unreachable'
            ? { command: `ssh ${alias} docker info` }
            : {}),
      };
    }
    try {
      const missing: string[] = [];
      for (const image of [REMOTE_IMAGES.browser, REMOTE_IMAGES.desktop]) {
        const answer = (await tunnel.request('image', image)) as {
          id?: unknown;
        };
        if (typeof answer?.id !== 'string') missing.push(image);
      }
      if (missing.length)
        return {
          alias,
          check: 'images_missing',
          message: `The computer images are not on ${alias} yet (${missing.join(', ')}). Run Build the images in Settings → Computers → Set up this server.`,
        };
      const supervisor = await this.facts(tunnel, REMOTE_SUPERVISOR);
      if (!supervisor || supervisor.running !== true)
        return {
          alias,
          check: 'supervisor_not_running',
          message: `The computer supervisor is not running on ${alias}. Run Start the supervisor in Settings → Computers → Set up this server.`,
          command: `ssh ${alias} docker logs --tail 20 ${REMOTE_SUPERVISOR}`,
        };
      const reason = supervisorUnsafeReason(supervisor);
      if (reason)
        return {
          alias,
          check: 'supervisor_not_running',
          message: `FullDots will not use the supervisor on ${alias}: ${reason}. Run Start the supervisor again to replace it.`,
        };
      const serverId = supervisor.labels?.[SERVER_ID_LABEL];
      if (serverId !== this.options.store.serverId(alias)) {
        const other = serverId
          ? this.options.store.aliasForServerId(serverId)
          : undefined;
        return {
          alias,
          check: 'supervisor_not_running',
          message: other
            ? `${alias} and ${other} are the same server, and its supervisor was started for ${other}. Use one alias for a server: point this Dot at ${other}.`
            : `The supervisor on ${alias} was not started by FullDots for this alias, so it does not know this alias’s tokens. Run Start the supervisor to replace it.`,
        };
      }
    } catch (error) {
      return {
        alias,
        check: 'ssh_failed',
        message:
          error instanceof Error
            ? error.message
            : sshProblemMessage('failed', alias),
        command: `ssh ${alias} true`,
      };
    }
    return undefined;
  }

  /** Stops the tunnels no Dot and no default uses any more. */
  prune(inUse: Iterable<string>) {
    const keep = new Set(inUse);
    for (const [alias, tunnel] of this.tunnels)
      if (!keep.has(alias)) {
        tunnel.stop();
        this.tunnels.delete(alias);
      }
  }

  /** Stops tunnels a check or a setup step opened for a server nothing uses. */
  pruneIdle() {
    this.prune(this.inUse());
  }

  /** Closes a Dot's tunnel ports on a server it no longer uses. */
  release(alias: string, dotId: string) {
    this.tunnels.get(alias)?.release(dotId);
  }

  /** Stops every ssh process FullDots started. */
  stop() {
    for (const tunnel of this.tunnels.values()) tunnel.stop();
    this.tunnels.clear();
  }
}
