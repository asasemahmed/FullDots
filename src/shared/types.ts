import type { RuleCategory } from './rules.js';
export type Status =
  | 'queued'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
}
/** stopped: the owner stopped it (Stop on its lane, or Stop everything). */
export type DelegationStatus = 'running' | 'done' | 'failed' | 'stopped';
/** Work one Dot handed to a teammate, which runs in a new conversation of the teammate. */
export interface Delegation {
  id: string;
  parentThreadId: string;
  parentDotId: string;
  childThreadId: string;
  childDotId: string;
  /** The background task the teammate's turn runs as. */
  taskId: string;
  /** 1 for a hand-off from an ordinary conversation, 2 for one handed on again. */
  depth: number;
  status: DelegationStatus;
  brief: string;
  deliverable: string;
  result: string | null;
  createdAt: number;
  finishedAt: number | null;
  /**
   * `parentThreadId:parentRunId`: the hand-offs of one turn, whose results go back together.
   * Null for hand-offs made before batching existed.
   */
  batchKey: string | null;
  /** When the teammate's turn started. */
  startedAt: number | null;
  /** When the result reached the Dot that asked (its resume turn ran). */
  deliveredAt: number | null;
  /** The hand-off this one tries again (the owner's Try again on a failed or stopped lane). */
  retryOf: string | null;
  /**
   * Who started it: a Dot's own delegate_to_dot ('dot'), a step of a team run the lead started
   * ('team'), or the owner's message sent straight to a team ('owner').
   */
  origin: DelegationOrigin;
}
export type DelegationOrigin = 'dot' | 'owner' | 'team';
export type TriggerKind = 'webhook' | 'poll';
/** bearer: Authorization header; query: ?token= in the URL; hmac: a signature of the body. */
export type TriggerAuth = 'bearer' | 'query' | 'hmac';
/** Starts work from outside: a webhook call, or a polled connector tool whose answer changed. */
export interface Trigger {
  id: string;
  dotId: string;
  threadId: string;
  kind: TriggerKind;
  name: string;
  /** What the Dot should do when the trigger fires. */
  prompt: string;
  auth: TriggerAuth | null;
  hmacHeader: string | null;
  hmacPrefix: string | null;
  connectorId: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  intervalSeconds: number | null;
  /** JSON path (a.b.0.c) a poll compares; null compares the whole answer. */
  dedupePath: string | null;
  enabled: boolean;
  createdAt: number;
  lastFiredAt: number | null;
  lastPolledAt: number | null;
  lastError: string | null;
  eventCount: number;
}
/** Tokens one Dot used on one UTC day (`YYYY-MM-DD`). */
export interface UsageDay {
  day: string;
  inputTokens: number;
  outputTokens: number;
  turns: number;
  /** Turns whose provider reported no usage; their tokens are not counted. */
  unreportedTurns: number;
}
export interface DotUsage {
  dotId: string;
  /** Tokens today (UTC). */
  today: number;
  /** Tokens this calendar month (UTC). */
  month: number;
  /** Daily token budget; null means none. Over it, background work waits for the next day. */
  budget: number | null;
  /** The last 30 days with any use, newest first. */
  days: UsageDay[];
}
/** once: a single run; repeat: every interval; goal: repeats until the Dot marks it done; event: started by a trigger. */
export type TaskKind = 'once' | 'repeat' | 'goal' | 'event' | 'delegation';
export interface Task {
  id: string;
  prompt: string;
  status: Status;
  intervalSeconds: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
  lease: string | null;
  leaseUntil: number | null;
  kind: TaskKind;
  /** Completed runs so far. */
  runCount: number;
  /** A repeat or goal stops after this many runs; null means no limit. */
  maxRuns: number | null;
  lastRunAt: number | null;
  /** The trigger that created an event task. */
  triggerId: string | null;
  /** How a goal ended, written by the Dot through mark_goal_done. */
  summary: string | null;
}
export interface Source {
  title: string;
  url: string;
  excerpt: string;
}
export interface Result {
  text: string;
  sources: Source[];
  sample: boolean;
  screenshot?: string;
}
export interface Run {
  id: string;
  taskId: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  result: Result | null;
  error: string | null;
}
export interface TaskEvent {
  id: number;
  taskId: string;
  runId: string | null;
  text: string;
  createdAt: number;
}
export interface Memory {
  id: string;
  text: string;
  createdAt: number;
}
export interface Detail {
  task: Task;
  runs: Run[];
  events: TaskEvent[];
}
export interface State {
  settings: Settings;
  tasks: Task[];
  memories: Memory[];
  mode: 'sample' | 'live';
  configured: boolean;
}
export type Action = 'run' | 'pause' | 'cancel';
export interface Space {
  id: string;
  name: string;
  description: string;
  createdAt: number;
}
/** Per-Dot colour palettes. A Dot without one gets a palette derived from its id. */
export const DOT_COLORS = [
  'indigo',
  'mint',
  'coral',
  'lilac',
  'amber',
  'sky',
  'rose',
  'moss',
  'ink',
] as const;
export type DotColor = (typeof DOT_COLORS)[number];
/** The penguin a Dot is drawn as. A Dot without one gets a species derived from its id. */
export const DOT_SPECIES = [
  'emperor',
  'adelie',
  'rockhopper',
  'macaroni',
  'chick',
] as const;
export type DotSpecies = (typeof DOT_SPECIES)[number];
/** What a Dot's penguin wears; unset means nothing. */
export const DOT_GEAR = [
  'none',
  'headphones',
  'glasses',
  'beanie',
  'scarf',
  'bow',
] as const;
export type DotGear = (typeof DOT_GEAR)[number];
export interface Dot {
  id: string;
  /** Default destination for saved pages, not ownership. */
  spaceId: string;
  spaceIds: string[];
  name: string;
  instructions: string;
  researchAllowed: boolean;
  memoryAllowed: boolean;
  createdAt: number;
  /** A paused Dot starts no turns; its scheduled and triggered work waits until it is resumed. */
  paused?: boolean;
  /** Model identifier for this Dot; null uses the server default. */
  model?: string | null;
  /** Provider serving `model` (Settings → Models); null uses the default provider. */
  modelProviderId?: string | null;
  /** When to ask the owner before acting; null/undefined means 'sensitive'. */
  approvalMode?: ApprovalMode | null;
  /** Chosen palette; unset means the palette derived from the id. */
  color?: DotColor;
  /** Chosen penguin; unset means the species derived from the id. */
  species?: DotSpecies;
  /** Chosen accessory; unset means none. */
  gear?: DotGear;
  /** Off by default: when on, the Dot may propose a line for its note, which waits in the inbox. */
  notesProposals?: boolean;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Set on a branch: the conversation and message it was copied from (null: before the first). */
  branchedFrom?: { threadId: string; messageId: string | null };
  /** A team chat: the named team it belongs to (its host `dotId` is the team's lead). */
  teamId?: string;
}
/** A conversation as the sidebar lists it, with activity facts from the server. */
export interface ConversationSummary extends Conversation {
  /** Last time the conversation's history changed (ms); null if never. */
  updatedAt: number | null;
  /** Nothing was ever sent, scheduled, linked or called in it. */
  empty: boolean;
  /** Group chat: the Dots added besides the host (`dotId`), in the order they joined. */
  participantIds?: string[];
  /** A teammate's chat: the chat (and Dot) that handed the work over. The sidebar nests it there. */
  handedBy?: { threadId: string; dotId: string };
  /** A turn is running in it right now. */
  running?: boolean;
}
export interface CallReceipt {
  anchorMessageId?: string | null;
  id: string;
  threadId: string;
  startedAt: number;
  endedAt: number | null;
  status: 'connecting' | 'active' | 'ended' | 'failed';
  transcript: string;
  error: string | null;
}
export interface SetupStatus {
  model: boolean;
  browser: boolean;
  search: boolean;
  voice: boolean;
  missing: string[];
  defaultModel?: string;
}
export interface WorkspaceState {
  spaces: Space[];
  dots: Dot[];
  conversations: ConversationSummary[];
  setup: SetupStatus;
  calls: CallReceipt[];
}

/** Who started a server-side turn. Chat turns have no source metadata. */
export type TurnSource =
  | 'task'
  | 'approval'
  | 'handoff'
  | 'trigger'
  | 'channel'
  | 'delegation'
  /** A Dot passed the baton to another Dot in a group chat (hand_to_dot). */
  | 'relay'
  | 'question';
export const TURN_SOURCES: readonly TurnSource[] = [
  'task',
  'approval',
  'handoff',
  'trigger',
  'channel',
  'delegation',
  'relay',
  'question',
];
export interface TurnMetadata {
  source: TurnSource;
  /** Task id, approval id, handoff id, ... */
  ref?: string;
  /** Kept for existing voice receipts. */
  opendotsSource?: 'voice_receipt';
  /**
   * A teammate's turn on handed-over work: its whole time limit (wrap-up and stop included), used
   * in place of AGENT_TURN_TIMEOUT plus grace. Honoured only with source 'delegation'.
   */
  turnLimitMs?: number;
}
/**
 * An owner message addressed to one Dot of a group chat (`@Name`). `source` stays 'chat', so the
 * turn is treated exactly like a message typed in the chat (approvals, rules, limits).
 */
export interface OwnerTurnMetadata {
  source: 'chat';
  /** The Dot the owner addressed. */
  to: string;
}
export type ApprovalMode = 'sensitive' | 'writes' | 'off';

export type ConnectorTransport = 'http' | 'stdio';
/**
 * How an http connector authenticates. `oauth`: browser authorization, the
 * server sets the Authorization header itself. `token`: headers reference env
 * variables. `none`: no credentials.
 */
export type ConnectorAuth = 'oauth' | 'token' | 'none';
/** A header or env value as stored: a reference to a process env variable, or a literal non-secret. */
export type ConnectorValue = { env: string } | { literal: string };
export interface ConnectorConfig {
  /** 1-40 chars, unique, used in tool names. */
  name: string;
  transport: ConnectorTransport;
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  headers?: Record<string, ConnectorValue>;
  env?: Record<string, ConnectorValue>;
  /** Default: 'token' when an Authorization header is configured, else 'none'. */
  auth?: ConnectorAuth;
  /** 1000..600000, default 30000. */
  callTimeoutMs?: number;
  /** Default true. */
  enabled?: boolean;
  presetId?: string | null;
}
export interface Connector {
  id: string;
  name: string;
  transport: ConnectorTransport;
  url: string | null;
  command: string | null;
  args: string[];
  cwd: string | null;
  headers: Record<string, ConnectorValue>;
  env: Record<string, ConnectorValue>;
  auth: ConnectorAuth;
  callTimeoutMs: number;
  enabled: boolean;
  presetId: string | null;
  createdAt: number;
  updatedAt: number;
}
/** What the API returns: env references say whether the variable is set; values never leave the server. */
export type ConnectorValueView =
  { env: string; set: boolean } | { literal: string };
export interface ConnectorToolInfo {
  /** Raw MCP tool name. */
  name: string;
  /** mcp__<connector>__<tool>, sanitized. */
  toolName: string;
  description: string;
  /** annotations.readOnlyHint === true */
  readOnly: boolean;
  /** annotations.destructiveHint === true */
  destructive: boolean;
  inputSchema: Record<string, unknown>;
}
export type ConnectorState =
  | 'disabled'
  | 'missing_env'
  | 'needs_auth'
  | 'connecting'
  | 'connected'
  | 'error';
export interface ConnectorStatus {
  state: ConnectorState;
  error?: string;
  missing?: string[];
  tools: ConnectorToolInfo[];
  connectedAt?: number;
  /** OAuth connectors: tokens are stored. Never the tokens themselves. */
  authorized?: boolean;
  authorizedAt?: number;
  /** Display only: email or name from the token response's id_token, when present. */
  account?: string;
}
export interface ConnectorView extends Omit<Connector, 'headers' | 'env'> {
  headers: Record<string, ConnectorValueView>;
  env: Record<string, ConnectorValueView>;
  status: ConnectorStatus;
}
export type ToolOverride = 'allow' | 'ask' | 'deny';
export interface DotConnectorGrant {
  dotId: string;
  connectorId: string;
  /** '*' = every read-only tool (default); a list names tools explicitly (non-read-only tools must be listed). */
  tools: '*' | string[];
  overrides: Record<string, ToolOverride>;
  /** "Treat as": tool name to the rule category it is pinned to; absent when none is pinned. */
  categories?: Record<string, RuleCategory>;
}

export type ApprovalStatus =
  'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
export interface Approval {
  id: string;
  threadId: string;
  dotId: string;
  toolCallId: string;
  /** Gated tool name, e.g. computer_exec, mcp__github__create_issue, request_approval. */
  tool: string;
  /** null = summary-only request_approval (advisory). */
  argsHash: string | null;
  /** The Dot's description. */
  summary: string;
  /** "Exact action": JSON or shell command, truncated, secrets masked. */
  argsRedacted: string;
  status: ApprovalStatus;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  consumedAt: number | null;
}
export type HandoffKind = 'credential' | 'two_factor' | 'captcha' | 'other';
export type HandoffStatus = 'waiting' | 'done' | 'dismissed';
export interface Handoff {
  id: string;
  dotId: string;
  threadId: string;
  kind: HandoffKind;
  reason: string;
  status: HandoffStatus;
  createdAt: number;
  finishedAt: number | null;
  /** The computer-side control request id, when the request succeeded. */
  controlRequestId: string | null;
}
/** Tool result shapes the client renders. */
export interface PendingApprovalResult {
  status: 'pending_approval';
  approvalId: string;
  summary: string;
  exact: string;
  advisory?: true;
}
export interface HandoffResult {
  status: 'handoff';
  handoffId: string;
  kind: HandoffKind;
  reason: string;
  /** Tells the model the action did not happen, so it does not report it as done. */
  note?: string;
}
export interface PausedResult {
  paused: 'approval pending' | 'handoff pending' | 'question pending';
  ref: string;
}
export interface ActionAuditEntry {
  id: string;
  dotId: string;
  threadId: string | null;
  tool: string;
  actor: 'owner' | 'agent';
  outcome:
    'pending' | 'succeeded' | 'failed' | 'approved' | 'denied' | 'refused';
  createdAt: number;
}
