import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { ComputerService } from '../computer-service.js';
import type { ApprovalService } from '../approval-service.js';
import {
  codingProgress,
  type CodingProgressSnapshot,
} from './coding-progress.js';
import {
  CodingBridgeError,
  CodingModeError,
  CodingTaskBusyError,
} from './acp-policy.js';
import { codingPermission, type HandoffStarter } from '../approval-gate.js';
import {
  authenticationRequired,
  codingProviders,
  connectCodingBridge,
  runAcp,
  type AcpRunOptions,
} from './acp-client.js';

export interface CodingToolDeps {
  store: Store;
  workspace: WorkspaceStore;
  computer: ComputerService;
  approvals: ApprovalService;
  handoffs: HandoffStarter;
  dotId: string;
  threadId: string;
  signal: AbortSignal;
  check: () => void;
  progress: (value: CodingProgressSnapshot) => void;
  timeoutMs?: number;
  connect?: typeof connectCodingBridge;
  run?: (options: AcpRunOptions) => ReturnType<typeof runAcp>;
}

export async function codingTools(deps: CodingToolDeps) {
  const { store, workspace, dotId, threadId } = deps;
  if (
    !store.codingSessions.enabled(dotId) ||
    !deps.computer.configured ||
    workspace.dot(dotId)?.paused ||
    !workspace.computers.permissions(dotId).enabled
  )
    return [];
  try {
    await deps.computer.codingTarget(dotId, deps.signal);
  } catch {
    return [];
  }
  return [
    defineTool({
      name: 'delegate_to_coding_agent',
      description:
        'Give a coding task to a worker inside this Dot’s computer. It streams progress and asks the owner about each requested permission. Sign-in requires the owner. Do not send credentials in the task. A stopped or interrupted session must be reviewed before retrying.',
      parameters: z
        .object({ task: z.string().trim().min(1).max(20_000) })
        .strict(),
      execute: async ({ task }) => {
        deps.check();
        if (!store.codingSessions.enabled(dotId))
          throw new Error('Coding agents are disabled.');
        const controller = new AbortController();
        const timeout = AbortSignal.timeout(deps.timeoutMs ?? 600_000);
        const signal = AbortSignal.any([
          deps.signal,
          controller.signal,
          timeout,
        ]);
        const target = await deps.computer.codingTarget(dotId, signal);
        // Read once per task: a change made while it runs applies to the next task.
        const provider = store.codingSessions.provider(dotId);
        const label = codingProviders[provider].label;
        let session;
        try {
          session = store.codingSessions.start(dotId, threadId, provider);
        } catch (error) {
          if (error instanceof CodingTaskBusyError)
            return { status: 'busy', message: error.message };
          throw error;
        }
        const buffered = codingProgress(session.id, deps.progress);
        let bridge: Awaited<ReturnType<typeof connectCodingBridge>> | undefined;
        let checking = false;
        let result = '';
        const progress = (text: string) => {
          if (!signal.aborted) buffered.write(target.redact(text));
        };
        const watcher = setInterval(() => {
          try {
            deps.check();
            if (
              !store.codingSessions.enabled(dotId) ||
              !workspace.computers.permissions(dotId).enabled
            )
              controller.abort();
          } catch {
            controller.abort();
          }
          if (checking || signal.aborted) return;
          checking = true;
          void deps.computer
            .status(dotId)
            .then((status) => {
              if (
                status.state !== 'running' ||
                status.control?.holder === 'human' ||
                status.control?.requested
              )
                controller.abort();
            })
            .catch(() => controller.abort())
            .finally(() => {
              checking = false;
            });
        }, 1000);
        watcher.unref();
        try {
          progress(
            '\nCoding agent is connecting inside this Dot’s computer.\n',
          );
          bridge = await (deps.connect ?? connectCodingBridge)(
            target,
            signal,
            provider,
          );
          const response = await (deps.run ?? runAcp)({
            target: bridge.stream,
            provider,
            task,
            signal,
            session: (id) => store.codingSessions.attach(session.id, id),
            permission: (request, modes, permissionSignal) =>
              codingPermission(
                {
                  dotId,
                  threadId,
                  approvals: deps.approvals,
                  workspace,
                  signal: AbortSignal.any([signal, permissionSignal]),
                  modes,
                  redact: target.redact,
                },
                request,
              ),
            update: ({ update }) => {
              if (
                update.sessionUpdate === 'agent_message_chunk' &&
                update.content.type === 'text'
              ) {
                result = (result + target.redact(update.content.text)).slice(
                  0,
                  20_000,
                );
                progress(update.content.text);
              } else if (update.sessionUpdate === 'tool_call' && update.title) {
                progress(`\nCoding agent: ${update.title.slice(0, 240)}\n`);
              }
            },
          });
          signal.throwIfAborted();
          store.codingSessions.finish(
            session.id,
            response.stopReason === 'cancelled' ? 'cancelled' : 'completed',
          );
          return {
            status:
              response.stopReason === 'cancelled' ? 'cancelled' : 'completed',
            codingSessionId: session.id,
            result,
            stopReason: response.stopReason,
          };
        } catch (error) {
          if (signal.aborted) {
            const timedOut =
              timeout.aborted && signal.reason === timeout.reason;
            store.codingSessions.finish(
              session.id,
              timedOut ? 'timed_out' : 'cancelled',
            );
            return {
              status: timedOut ? 'timed_out' : 'cancelled',
              codingSessionId: session.id,
              message: `Coding work ${timedOut ? 'timed out' : 'stopped'}. Review the workspace before retrying; completed edits are retained.`,
            };
          }
          if (authenticationRequired(error)) {
            store.codingSessions.finish(session.id, 'authentication_required');
            bridge?.close();
            const handoff = await deps.handoffs.start({
              dotId,
              threadId,
              kind: 'credential',
              reason:
                provider === 'codex'
                  ? `Sign in to ${label} in this Dot’s computer, with an API key or your ChatGPT account. Credentials stay inside the computer.`
                  : `Sign in to ${label} in this Dot’s computer. Credentials stay inside the computer.`,
            });
            return {
              status: 'handoff',
              handoffId: handoff.id,
              reason: handoff.reason,
            };
          }
          store.codingSessions.finish(session.id, 'failed');
          return {
            status: 'failed',
            codingSessionId: session.id,
            message:
              error instanceof CodingBridgeError ||
              error instanceof CodingModeError
                ? error.message
                : 'The coding worker could not finish. Check that the computer image includes the coding bridge. Review existing edits before retrying.',
          };
        } finally {
          clearInterval(watcher);
          bridge?.close();
          buffered.finish(
            store.codingSessions.get(session.id)?.status ?? 'failed',
          );
        }
      },
    }),
  ];
}
