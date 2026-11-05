/** Where Dot computers run: Docker on this machine, or the owner's own server reached over ssh. */
export type ComputerWhere = 'local' | 'remote';

/** The server checks, in the order FullDots makes them. The first that fails is what the owner sees. */
export const REMOTE_CHECKS = [
  'alias_not_set',
  'ssh_failed',
  'docker_unreachable',
  'images_missing',
  'supervisor_not_running',
  'computer_stopped',
  'computer_unsafe',
  'not_ready',
] as const;
export type RemoteCheck = (typeof REMOTE_CHECKS)[number] | 'ready';

export interface RemoteCheckResult {
  /** The ssh alias checked; absent when none is set. */
  alias?: string;
  check: RemoteCheck;
  /** What was found and the step that fixes it. */
  message: string;
  /** A command the owner can run by hand, when one helps. */
  command?: string;
}

/** The steps of setting up a server. Each runs a fixed list of commands, shown before it runs. */
export const REMOTE_SETUP_STEPS = [
  'check-alias',
  'check-docker',
  'build-images',
  'start-supervisor',
] as const;
export type RemoteSetupStep = (typeof REMOTE_SETUP_STEPS)[number];

export interface RemoteSetupPlan {
  step: RemoteSetupStep;
  title: string;
  note: string;
  /** The exact commands, as the owner would type them. */
  commands: string[];
  /** True when this FullDots cannot run the step (building needs a checkout). */
  unavailable?: boolean;
}

export interface RemoteSetupJob {
  id: string;
  alias: string;
  step: RemoteSetupStep;
  state: 'running' | 'done' | 'failed';
  /** The last part of the output, with every token removed. */
  output: string;
  message: string;
}

export interface RemoteComputersStatus {
  /** False when FullDots cannot run ssh for the owner here (in a container, or bound to the network). */
  enabled: boolean;
  /** Whether this FullDots can send the Dockerfiles to build the images. */
  canBuild: boolean;
  where: ComputerWhere;
  alias?: string;
  /** Every alias in use: the default and those Dots use on their own. */
  servers: string[];
  job?: RemoteSetupJob;
}

/** What a move to another server left behind on a server FullDots could not reach. */
export interface ComputerMoveResult {
  moved: boolean;
  /** Commands that remove what may be left, to run once that server is back. */
  leftover?: string[];
}
