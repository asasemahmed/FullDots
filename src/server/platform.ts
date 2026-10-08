import { ComputerService } from './computer-service.js';
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
import { ResumeQueue } from './resume-queue.js';
import { ApprovalService } from './approval-service.js';
import { HandoffService } from './handoff-service.js';
import { createNotify } from './notify.js';
import type { DotAgentServices } from './dot-agent.js';
import type { TurnMetadata } from '../shared/types.js';
const DEFAULT_APPROVAL_TTL_MS = 7 * 24 * 3600_000;
export class Platform {
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly runner: SqliteAgentRunner;
  readonly handler: CopilotHonoApp;
  readonly connectors: ConnectorRegistry;
  readonly resumes: ResumeQueue;
  readonly approvals: ApprovalService;
  readonly handoffs: HandoffService;
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    chatDatabase = ':memory:',
    readonly turns = new TurnRegistry(),
  ) {
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    turns.setLookups({
      pendingApprovalThreads: () => workspace.approvals.pendingThreadIds(),
      waitingHandoffDots: () => workspace.handoffs.waitingDotIds(),
    });
    this.computers.setHandoffs(workspace.handoffs);
    this.connectors = new ConnectorRegistry(workspace.connectors, {
      allowStdio: !!config.connectorsAllowStdio,
      resultMaxChars: config.connectorResultMaxChars ?? 20_000,
    });
    this.resumes = new ResumeQueue({
      store: workspace.resumes,
      registry: turns,
      turn: (threadId, prompt, signal, metadata) =>
        this.turn(threadId, prompt, signal, metadata),
      onGiveUp: (marker) =>
        workspace.computers.record({
          dotId: marker.dotId,
          threadId: marker.threadId,
          tool: `resume_${marker.kind}`,
          actor: 'agent',
          outcome: 'failed',
        }),
      onDelivered: (marker, text) => {
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
    // Conversations are stored locally; no hosted thread service is involved.
    this.runner = new SqliteAgentRunner(chatDatabase);
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
  }
  setup() {
    return setupStatus(this.config);
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  /** What every Dot turn shares: the turn lock, connectors, approvals and handoffs. */
  services(): DotAgentServices {
    return {
      turns: this.turns,
      connectors: this.connectors,
      approvals: this.approvals,
      handoffs: this.handoffs,
    };
  }
  async start() {
    await this.connectors.start();
    this.approvals.startSweep();
    this.resumes.start();
  }
  async stop() {
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
    return this.handler.fetch(request);
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: TurnMetadata | Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    const thread = this.workspace.requireThread(threadId);
    const agent = new DotAgent(
      this.store,
      this.workspace,
      this.config,
      thread.dotId,
      this.services(),
    );
    agent.agentId = thread.dotId;
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
