import { HttpAgent } from '@ag-ui/client';
import { EventType, type BaseEvent, type RunAgentInput } from '@ag-ui/core';
import { Observable } from 'rxjs';
import {
  AGENT_MAX_BODY_BYTES,
  createAgentFetch,
  EndpointNotAllowedError,
  redactHeader,
} from './agent-endpoint.js';
import { defaultLimits } from './limits.js';
import type { PlatformConfig } from './platform-config.js';
import type { Store } from './store.js';
import { turnTimers } from './turn-limit.js';
import type { TurnRegistry } from './turn-registry.js';
import type { TurnSource } from '../shared/types.js';
import type { WorkspaceStore } from './workspace.js';

export interface RemoteTurnHost {
  dotId: string;
  workspace: WorkspaceStore;
  store: Store;
  config: PlatformConfig;
  turns?: TurnRegistry;
  source: TurnSource | 'chat';
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  attach(controller: AbortController, agent: { abortRun(): void }): void;
  abort(): void;
}

function safeText(error: unknown, header: string | undefined): string {
  // A fetch failure can quote the URL. Our own sentences and the endpoint check stay.
  if (
    error instanceof EndpointNotAllowedError ||
    (error instanceof Error && error.name === 'Error')
  )
    return redactHeader(error.message, header);
  return 'The agent could not answer.';
}

/**
 * One turn against the Dot's AG-UI endpoint.
 * Pause, stop and the turn time limit abort the request. The remote agent is
 * not given FullDots tools: hand-offs, Spaces and the computer stay on the built-in loop.
 */
export function runRemoteAguiTurn(
  host: RemoteTurnHost,
  input: RunAgentInput,
): Observable<BaseEvent> {
  return new Observable((subscriber) => {
    const controller = new AbortController();
    let subscription: { unsubscribe(): void } | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;
    let release = () => {};
    const timers: ReturnType<typeof setTimeout>[] = [];
    const limits = host.config.limits ?? defaultLimits;
    const turnLimit = turnTimers(limits, input.messages);
    let header: string | undefined;
    try {
      const dot = host.workspace.dot(host.dotId);
      if (!dot?.agentEndpoint)
        throw new Error('This Dot has no agent endpoint.');
      const endpoint = dot.agentEndpoint;
      if (dot.paused)
        throw new Error(
          `${dot.name} is paused. Resume it from its menu in the sidebar to continue.`,
        );
      host.workspace.requireThread(input.threadId, dot.id);
      if (host.workspace.agentAuthUnreadable(dot.id))
        throw new Error(
          'The saved authorization could not be read. Enter it again.',
        );
      header = host.workspace.openAgentAuth(dot.id);
      const agent = new HttpAgent({
        url: endpoint,
        agentId: dot.id,
        ...(header ? { headers: { Authorization: header } } : {}),
        fetch: createAgentFetch({
          allowedHosts: host.config.agentEndpointAllowedHosts,
          ...(host.fetchImpl ? { fetchImpl: host.fetchImpl } : {}),
          timeoutMs: turnLimit?.stopMs,
          maxBodyBytes:
            host.config.limits?.computerResponseBytes ?? AGENT_MAX_BODY_BYTES,
        }),
      });
      host.attach(controller, agent);
      if (host.turns)
        release = host.turns.acquire(
          dot.id,
          input.threadId,
          host.source,
          () => host.abort(),
          input.runId,
        );
      const check = () => {
        const current = host.workspace.dot(dot.id);
        if (
          host.store.settings().paused ||
          !current ||
          current.paused ||
          current.agentEndpoint !== endpoint
        )
          host.abort();
        controller.signal.throwIfAborted();
      };
      check();
      watcher = setInterval(() => {
        try {
          check();
        } catch {
          host.abort();
        }
      }, 100);
      if (turnLimit)
        timers.push(
          setTimeout(() => {
            host.abort();
          }, turnLimit.stopMs),
        );
      subscription = agent
        .run({
          ...input,
          tools: [],
          forwardedProps: {},
        })
        .subscribe({
          next: (event) => {
            subscriber.next(redactEvent(event, header));
          },
          error: (error: unknown) => {
            if (controller.signal.aborted || agentAborted(error)) {
              subscriber.complete();
              return;
            }
            subscriber.next({
              type: EventType.RUN_ERROR,
              message: safeText(error, header),
            } as BaseEvent);
            subscriber.complete();
          },
          complete: () => subscriber.complete(),
        });
    } catch (error) {
      subscriber.next({
        type: EventType.RUN_ERROR,
        message: safeText(error, header),
      } as BaseEvent);
      subscriber.complete();
    }
    return () => {
      release();
      timers.forEach(clearTimeout);
      clearInterval(watcher);
      controller.abort();
      host.abort();
      subscription?.unsubscribe();
    };
  });
}

function agentAborted(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: string }).name === 'AbortError')
  );
}

function redactEvent(event: BaseEvent, header: string | undefined): BaseEvent {
  if (!header) return event;
  return JSON.parse(redactHeader(JSON.stringify(event), header)) as BaseEvent;
}
