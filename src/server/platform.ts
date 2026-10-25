import type { DockerSetup } from './docker-setup.js';
import { ComputerService } from './computer-service.js';
import { ChannelService } from './channels/service.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import { runThreadTurn } from './headless.js';
import { setupStatus, type PlatformConfig } from './platform-config.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { SqliteAgentRunner } from './sqlite-runner.js';
import { TurnRegistry } from './turn-registry.js';
import { ConnectorRegistry } from './connectors.js';
import { ConnectorOAuthService } from './connector-oauth.js';
import { ModelProviderRegistry } from './model-providers.js';
import { ResumeQueue } from './resume-queue.js';
import { ApprovalService } from './approval-service.js';
import { HandoffService } from './handoff-service.js';
import { createNotify, type Notify } from './notify.js';
import { TriggerService } from './trigger-service.js';
import { TeamService } from './team-service.js';
import { TeamRunService } from './teams/team-runs.js';
import { StaticReply } from './teams/static-reply.js';
import { GroupChat } from './group-chat.js';
import { runConflict } from './group-routes.js';
import { included } from './mcp-tools.js';
import { EventBus } from './events.js';
import { wireLiveEvents } from './live-wiring.js';
import { InboxService, type FinishedWork } from './inbox-service.js';
import { DotNotesService } from './dot-notes-service.js';
import type { DotAgentServices } from './dot-agent.js';
import type { TurnMetadata } from '../shared/types.js';
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 3600_000;
export class Platform {
  readonly channels: ChannelService;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly runner: SqliteAgentRunner;
  readonly handler: CopilotHonoApp;
  readonly connectors: ConnectorRegistry;
  /** Browser sign-in for connectors; tokens live encrypted in workspace.connectorAuth. */
  readonly oauth: ConnectorOAuthService;
  /** Model providers: the `.env` one plus those stored (encrypted) in the workspace. */
  readonly models: ModelProviderRegistry;
  readonly resumes: ResumeQueue;
  readonly approvals: ApprovalService;
  readonly handoffs: HandoffService;
  readonly notify: Notify;
  readonly triggers: TriggerService;
  readonly team: TeamService;
  /** Named teams' runs: start_team_run, direct dispatch, results and cancel. */
  readonly teamRuns: TeamRunService;
  /** Group chats: participants, the baton tool and the relay cap. */
  readonly group: GroupChat;
  /** The owner's inbox: questions and the results of finished background work. */
  readonly inbox: InboxService;
  /** What a Dot may propose for its note; the owner saves or discards in the inbox. */
  readonly dotNotes: DotNotesService;
  /** The live event feed (GET /api/events): ids and small enums only. */
  readonly events = new EventBus();
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    chatDatabase = ':memory:',
    readonly turns = new TurnRegistry(),
  ) {
    this.models = new ModelProviderRegistry(workspace.modelProviders, {
      env: config,
      processEnv: process.env,
      ...(config.publicOrigin ? { publicOrigin: config.publicOrigin } : {}),
    });
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    turns.setLookups({
      pendingApprovalThreads: () => workspace.approvals.pendingThreadIds(),
      waitingHandoffDots: () => workspace.handoffs.waitingDotIds(),
      openQuestionThreads: () => workspace.inbox.openQuestionThreadIds(),
    });
    this.computers.setHandoffs(workspace.handoffs);
    this.oauth = new ConnectorOAuthService({
      store: workspace.connectorAuth,
      publicOrigin: config.publicOrigin ?? 'http://127.0.0.1:4310',
      serverUrlFor: (id) => workspace.connectors.get(id)?.url,
    });
    this.connectors = new ConnectorRegistry(workspace.connectors, {
      oauth: this.oauth,
      authInfo: (id) => {
        const record = workspace.connectorAuth.get(id);
        return record ? { authorizedAt: record.authorizedAt } : undefined;
      },
      allowStdio: !!config.connectorsAllowStdio,
      resultMaxChars: config.connectorResultMaxChars ?? 20_000,
    });
    this.team = new TeamService({
      workspace,
      store,
      resume: (marker) => void this.resumes.enqueue(marker),
      maxDepth: config.teamMaxDepth ?? 2,
    });
    this.group = new GroupChat({
      workspace,
      resume: (marker) => void this.resumes.enqueue(marker),
      relayMax: config.teamRelayMax ?? 4,
    });
    this.resumes = new ResumeQueue({
      store: workspace.resumes,
      registry: turns,
      onTurnFinished: (listener) =>
        this.events.subscribe('turn.finished', listener),
      batches: this.team.batches(config.teamResultBatchMs ?? 1500),
      isPaused: (dotId) => !!workspace.dot(dotId)?.paused,
      belongs: (marker) => {
        try {
          workspace.requireThread(marker.threadId, marker.dotId);
          return true;
        } catch {
          return false;
        }
      },
      isOverBudget: (dotId) => workspace.usage.overBudgetDots().includes(dotId),
      turn: (threadId, prompt, signal, metadata, dotId) =>
        this.turnAs(threadId, dotId, prompt, signal, metadata),
      onGiveUp: (marker) =>
        workspace.computers.record({
          dotId: marker.dotId,
          threadId: marker.threadId,
          tool: `resume_${marker.kind}`,
          actor: 'agent',
          outcome: 'failed',
        }),
      onDelivered: (marker, text) => {
        // Team results and answered questions finish background work: the owner gets the result.
        if (marker.kind === 'delegation' || marker.kind === 'question')
          this.inbox.finished({
            dotId: marker.dotId,
            threadId: marker.threadId,
            work: marker.kind,
            text,
          });
        // A teammate that waited for the owner reports once its resumed turn is done.
        if (
          marker.kind === 'approval' ||
          marker.kind === 'handoff' ||
          marker.kind === 'question'
        )
          this.team.resumed(
            marker.threadId,
            text,
            this.waitsForOwner(marker.threadId),
          );
        const taskId = workspace.threadTask(marker.threadId);
        if (taskId)
          store.event(
            taskId,
            null,
            `Resumed after the ${marker.kind}: ${text.slice(0, 500)}`,
          );
      },
    });
    const notify = createNotify(
      config.notifyWebhookUrl,
      fetch,
      console.error,
      config.publicOrigin,
    );
    this.notify = notify;
    this.inbox = new InboxService({
      inbox: workspace.inbox,
      resumes: this.resumes,
      dotName: (dotId) => workspace.dot(dotId)?.name,
      notify,
      changed: () => this.events.emit('inbox.changed', {}),
      waitsForOwner: (threadId) => this.waitsForOwner(threadId),
      redact: (text) => this.models.redact(text),
    });
    this.dotNotes = new DotNotesService({
      notes: workspace.notes,
      inbox: workspace.inbox,
      dot: (dotId) => workspace.dot(dotId),
      changed: () => this.events.emit('inbox.changed', {}),
    });
    this.approvals = new ApprovalService({
      approvals: workspace.approvals,
      resumes: this.resumes,
      audit: workspace.computers,
      notify,
      ttlMs: config.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      taskOf: (threadId) => workspace.threadTask(threadId),
      recordTaskEvent: (taskId, text) => store.event(taskId, null, text),
    });
    this.handoffs = new HandoffService({
      handoffs: workspace.handoffs,
      computers: this.computers,
      resumes: this.resumes,
      audit: workspace.computers,
      notify,
    });
    this.triggers = new TriggerService({
      triggers: workspace.triggers,
      createEventTask: (trigger, prompt) => {
        const task = store.createTask(prompt, {
          kind: 'event',
          triggerId: trigger.id,
        });
        workspace.bindTask(task.id, trigger.threadId);
        return task.id;
      },
      connectors: this.connectors,
      isPaused: (dotId) => !!workspace.dot(dotId)?.paused,
      grantAllows: (dotId, connectorId, tool) => {
        const grant = workspace.connectors.grant(dotId, connectorId);
        return !!grant && included(grant, tool);
      },
    });
    // Conversations are stored locally; no hosted thread service is involved.
    this.runner = new SqliteAgentRunner(chatDatabase);
    wireLiveEvents(this.events, {
      store,
      workspace,
      turns,
      runner: this.runner,
    });
    this.events.subscribe('turn.started', ({ threadId, source }) =>
      this.team.started(threadId, source),
    );
    this.teamRuns = new TeamRunService({
      workspace,
      team: this.team,
      resume: (marker) => void this.resumes.enqueue(marker),
      cancelTask: (taskId) => void store.action(taskId, 'cancel'),
      // Direct team chats write the owner's message and the results without a model call.
      post: async ({ threadId, dotId, text, reply, metadata, toolCall }) => {
        await runThreadTurn(
          this.runner,
          new StaticReply(reply, dotId, toolCall),
          threadId,
          text,
          AbortSignal.timeout(30_000),
          metadata,
        );
      },
      onTurnFinished: (listener) =>
        this.events.subscribe('turn.finished', listener),
      turns,
      finished: (threadId, text) =>
        this.finishedWork(threadId, 'delegation', text),
      messages: (threadId) => this.runner.getThreadMessages(threadId),
      // A run log page landed in the team's Space: open pages and the sidebar refetch.
      logged: () => this.events.emit('workspace.changed', {}),
    });
    this.team.setRunHook((delegation) =>
      this.teamRuns.stepFinished(delegation),
    );
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return {
        getOrCreateThread: async () => undefined,
        getThreadMessages: async ({ threadId }) => ({
          messages: this.runner.getThreadMessages(threadId),
        }),
      };
    });
    const runtime = new CopilotRuntime({
      runner: this.runner,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'FullDots owner',
      }),
      agents: async () =>
        Object.fromEntries(
          workspace
            .dots()
            .map((dot) => [
              dot.id,
              new DotAgent(store, workspace, config, dot.id, this.services()),
            ]),
        ),
    });
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
    this.channels = new ChannelService(this, chatDatabase);
  }
  setup() {
    return setupStatus(
      this.config,
      this.models.hasUsableDefault(),
      this.models.defaultLabel(),
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  /** Set by the server entry on a local install: the guided Docker setup the owner and Dots can use. */
  dockerSetup?: DockerSetup;
  /** What every Dot turn shares: the turn lock, connectors, approvals and handoffs. */
  services(): DotAgentServices {
    return {
      turns: this.turns,
      connectors: this.connectors,
      approvals: this.approvals,
      handoffs: this.handoffs,
      models: this.models,
      usage: (dotId, tokens) => this.recordUsage(dotId, tokens),
      team: this.team,
      teamRuns: this.teamRuns,
      group: this.group,
      questions: this.inbox,
      notes: this.dotNotes,
      ...(this.dockerSetup ? { dockerSetup: this.dockerSetup } : {}),
      goals: {
        isOpenGoal: (taskId) => {
          const task = this.store.task(taskId);
          return task?.kind === 'goal' && !task.summary;
        },
        complete: (taskId, summary) =>
          !!this.store.completeGoal(taskId, summary),
      },
    };
  }
  /** True while a thread waits for the owner: a pending approval, a waiting handoff, an open question. */
  waitsForOwner(threadId: string): boolean {
    const { approvals, handoffs, inbox } = this.workspace;
    return (
      approvals.pendingThreadIds().includes(threadId) ||
      handoffs
        .list({ status: 'waiting' })
        .some((handoff) => handoff.threadId === threadId) ||
      !!inbox.openQuestion(threadId)
    );
  }
  /** Records the result of a finished background turn in the inbox (never throws). */
  finishedWork(threadId: string, work: FinishedWork, text: string) {
    try {
      const { dotId } = this.workspace.requireThread(threadId);
      this.inbox.finished({ dotId, threadId, work, text });
    } catch (error) {
      console.error(
        'Inbox result skipped:',
        error instanceof Error ? error.message : 'unknown error',
      );
    }
  }
  /** Adds a finished turn's tokens and warns the owner once a day when a Dot uses a lot. */
  recordUsage(
    dotId: string,
    tokens: { input: number; output: number } | null,
    now = Date.now(),
  ) {
    const usage = this.workspace.usage;
    const total = usage.record(dotId, tokens, now);
    const budget = usage.budget(dotId);
    const warnAt = Math.min(
      this.config.dailyTokenWarn ?? 2_000_000,
      budget ?? Infinity,
    );
    if (total < warnAt || !usage.claimWarning(dotId, now)) return;
    const name = this.workspace.dot(dotId)?.name ?? 'A Dot';
    const reached = budget !== null && total >= budget;
    void this.notify({
      title: reached
        ? `${name} reached its daily token budget`
        : `${name} has used ${total.toLocaleString('en-US')} tokens today`,
      text: reached
        ? `Its background work waits until tomorrow (UTC). Chat still works. Budget: ${budget.toLocaleString('en-US')} tokens.`
        : `That is above the ${warnAt.toLocaleString('en-US')} token warning level. Check its scheduled work if this is unexpected.`,
      url: '/',
    });
  }
  async start() {
    await this.connectors.start();
    await this.channels.start();
    this.approvals.startSweep();
    this.resumes.start();
    this.teamRuns.recover();
    this.triggers.start();
  }
  /** Why a connector tool cannot be polled for this Dot; undefined when it can. */
  pollProblem(dotId: string, connectorId: string, toolName: string) {
    const connector = this.workspace.connectors.get(connectorId);
    if (!connector) return 'Connector not found.';
    const tool = this.connectors
      .toolsCached(connectorId)
      .find((item) => item.name === toolName);
    if (!tool)
      return 'That tool is not available. Check that the connector is connected.';
    if (!tool.readOnly) return 'Only read-only tools can be polled.';
    const grant = this.workspace.connectors.grant(dotId, connectorId);
    if (!grant || !included(grant, tool))
      return 'This Dot is not granted that tool. Grant it in the Dot settings first.';
    return undefined;
  }
  async stop() {
    await this.channels.stop();
    // Open event streams first: they would otherwise hold the HTTP server's close.
    this.events.close();
    this.triggers.stop();
    this.resumes.stop();
    this.approvals.stopSweep();
    await this.connectors.stop();
    this.runner.close();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    return this.workspace.bindThread(randomUUID(), dotId, title);
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    return this.runner
      .getThreadMessages(threadId)
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  async handle(request: Request): Promise<Response> {
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    const conflict = await runConflict(this, request, body);
    if (conflict) return conflict;
    return this.handler.fetch(request);
  }
  /** A server-side turn of the conversation's host Dot. */
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: TurnMetadata | Record<string, unknown>,
  ): Promise<string> {
    const thread = this.workspace.requireThread(threadId);
    return this.turnAs(threadId, thread.dotId, prompt, signal, metadata);
  }
  /**
   * A server-side turn of one Dot in a conversation: its host, or a participant of a group chat.
   * The Dot's own approval mode, rules, pause, budget and turn lock apply, as in any other turn.
   */
  async turnAs(
    threadId: string,
    dotId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: TurnMetadata | Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId, dotId);
    const agent = new DotAgent(
      this.store,
      this.workspace,
      this.config,
      dotId,
      this.services(),
    );
    agent.agentId = dotId;
    return runThreadTurn(
      this.runner,
      agent,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
