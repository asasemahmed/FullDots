export type Status =
  'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export interface Settings {
  name: string;
  paused: boolean;
  researchAllowed: boolean;
  memoryAllowed: boolean;
}
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
  learningContainerId?: string | null;
  skillDeliveryEnabled?: boolean;
  /** Model identifier for this Dot; null uses the server default. */
  model?: string | null;
  /** Provider serving `model` (Settings → Models); null uses the default provider. */
  modelProviderId?: string | null;
  /** When to ask the owner before acting; null/undefined means 'sensitive'. */
  approvalMode?: ApprovalMode | null;
}
export interface Conversation {
  id: string;
  dotId: string;
  ownerId: string;
  title: string;
  createdAt: number;
  /** Frozen at creation; null means this conversation does not participate. */
  learningContainerId?: string | null;
}
/** A conversation as the sidebar lists it, with activity facts from the server. */
export interface ConversationSummary extends Conversation {
  /** Last time the conversation's history changed (ms); null if never. */
  updatedAt: number | null;
  /** Nothing was ever sent, scheduled, linked or called in it. */
  empty: boolean;
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
  'task' | 'approval' | 'handoff' | 'trigger' | 'channel' | 'delegation';
export const TURN_SOURCES: readonly TurnSource[] = [
  'task',
  'approval',
  'handoff',
  'trigger',
  'channel',
  'delegation',
];
export interface TurnMetadata {
  source: TurnSource;
  /** Task id, approval id, handoff id, ... */
  ref?: string;
  /** Kept for existing voice receipts. */
  opendotsSource?: 'voice_receipt';
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
  paused: 'approval pending' | 'handoff pending';
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
