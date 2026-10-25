import { defineTool } from '@copilotkit/runtime/v2';
import { z } from 'zod';
import type { Store } from '../store.js';
import type { WorkspaceStore } from '../workspace.js';
import type { ComputerService } from '../computer-service.js';
import type { ApprovalService } from '../approval-service.js';
import { codingPermission, type HandoffStarter } from '../approval-gate.js';
import {
  authenticationRequired,
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
  progress: (text: string) => void;
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
        const signal = AbortSignal.any([
          deps.signal,
          controller.signal,
          AbortSignal.timeout(600_000),
        ]);
        const target = await deps.computer.codingTarget(dotId, signal);
        const session = store.codingSessions.start(dotId, threadId, 'claude');
        let bridge: Awaited<ReturnType<typeof connectCodingBridge>> | undefined;
        let checking = false;
        let result = '';
        let streamed = 0;
        const progress = (text: string) => {
          if (signal.aborted || streamed >= 40_000) return;
          const safe = target
            .redact(text)
            .slice(0, Math.min(2000, 40_000 - streamed));
          streamed += safe.length;
          deps.progress(safe);
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
          bridge = await (deps.connect ?? connectCodingBridge)(target, signal);
          const response = await (deps.run ?? runAcp)({
            target: bridge.stream,
            provider: 'claude',
            task,
            signal,
            session: (id) => store.codingSessions.attach(session.id, id),
            permission: (request) =>
              codingPermission(
                {
                  dotId,
                  threadId,
                  approvals: deps.approvals,
                  workspace,
                  signal,
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
            store.codingSessions.finish(session.id, 'cancelled');
            return {
              status: 'cancelled',
              codingSessionId: session.id,
              message:
                'Coding work stopped. Review the workspace before retrying; completed edits are retained.',
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
                'Sign in to Claude Code in this Dot’s computer. Credentials stay inside the computer.',
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
              'The coding worker could not finish. Check that the computer image includes the coding bridge. Review existing edits before retrying.',
          };
        } finally {
          clearInterval(watcher);
          bridge?.close();
        }
      },
    }),
  ];
}
