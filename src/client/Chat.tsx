import { z } from 'zod';
import { PageReviewCard } from './PageReviewCard';
import { pageReviewSchema, pageReviewTool } from '../shared/page-review';
import { contextualMessage, type PageContext } from './page-context';
import { api } from './api';
import type { Page } from '../server/pages';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CopilotChatToolCallsView,
  useRenderTool,
  useHumanInTheLoop,
  useAgent,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import { FilePlus, Clock3, Zap, Phone, PhoneOff } from 'lucide-react';
import { ChatTranscript, isInternalVoiceReceipt } from './ChatTranscript';
import {
  ComputerAutoOpen,
  approvalIds,
  handoffIds,
  isActivityTool,
  isFileCardTool,
  isComputerTool,
  toolResults,
} from './chat-turns';
import type {
  Approval,
  CallReceipt,
  Conversation,
  Dot,
  Handoff,
} from '../shared/types';
import { Mascot } from './Mascot';
import { useVoice } from './useVoice';
import { CallView } from './CallView';
import {
  busyKind,
  threadRunningMessage,
  turnErrorMessage,
} from './chat-errors';
import { useGroupChat } from './room/useGroupChat';
import { useTeamChat } from './teams/useTeamChat';
import { Composer } from './composer/Composer';
import { DotNotesButton } from './DotNotes';
import { useAutoAttach } from './live-attach';
import { pollInterval } from './live-refresh';
import { useLiveEvent, useLiveStatus } from './useLiveEvents';
import { takeOverHere } from './computer-panel/take-over';
import type { Message } from '@ag-ui/core';
import { useMessageActions } from './message-actions/useMessageActions';
import { retryMessage } from './message-actions/retries';
import { branchDraft } from './message-actions/branch-drafts';
import { LanesContext, useLanes } from './lanes/useLanes';
import { StopEverything } from './lanes/StopEverything';
import { isOwnAgentError } from './lanes/lane-model';
import { isLaneTool } from '../shared/lanes';
// These tools draw no UI of their own, so their arguments are not inspected.
const anyArguments = z.looseObject({});
export function Chat({
  thread,
  dot,
  initialPrompt,
  onConsumed,
  voiceReady,
  calls,
  paused,
  onSaved,
  onSchedule,
  onTrigger,
  onComputer,
  dots,
  onOpenThread,
}: {
  thread: Conversation;
  dot: Dot;
  /** Every Dot, for @mentions and the group strip. */
  dots?: Dot[];
  initialPrompt?: string;
  onConsumed: () => void;
  voiceReady: boolean;
  calls: CallReceipt[];
  paused: boolean;
  onSaved: () => void;
  onSchedule: () => void;
  /** Adds a webhook or poll trigger that starts work in this conversation. */
  onTrigger?: () => void;
  onComputer?: () => void;
  /** Opens another conversation: a branch made from this one. */
  onOpenThread?: (id: string) => void;
}) {
  const { agent, isReady } = useAgent({
    agentId: `chat-${thread.id}`,
    runtimeAgentId: dot.id,
    threadId: thread.id,
  });
  const { copilotkit } = useCopilotKit();
  const room = useGroupChat({
    threadId: thread.id,
    host: dot,
    dots: dots ?? [],
  });
  // Work lanes: the teammates working on this chat's hand-offs.
  const lanes = useLanes({
    threadId: thread.id,
    hostDot: dot,
    dots: dots ?? [dot],
    onOpenThread,
    onComputer,
  });
  const teamChat = useTeamChat({ thread, dots: dots ?? [] });
  const [pageContext, setPageContext] = useState<PageContext | null>();
  const [contextError, setContextError] = useState('');
  const [contextAttempt, setContextAttempt] = useState(0);
  const contextReady = pageContext !== undefined;
  useEffect(() => {
    let active = true;
    setPageContext(undefined);
    setContextError('');
    void api<PageContext | null>(
      `/conversations/${thread.id}/page-context`,
      'GET',
      undefined,
      AbortSignal.timeout(10000),
    )
      .then((page) => {
        if (active) setPageContext(page);
      })
      .catch(() => {
        if (active)
          setContextError(
            'Conversation context could not load. Retry before sending your message.',
          );
      });
    return () => {
      active = false;
    };
  }, [thread.id, contextAttempt]);
  // Edit and resend opens a branch with the edited text already in the composer.
  const [draft, setDraft] = useState(() => branchDraft(thread.id) ?? '');
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const voice = useVoice(thread.id, onSaved, agent.messages.at(-1)?.id);
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const autoOpen = useRef(new ComputerAutoOpen());
  // The reason a turn failed, as the server reported it (for example "401 API key expired.").
  const runError = useRef('');
  useEffect(() => {
    const subscription = copilotkit.subscribe({
      // Lanes connect agents of their own; their errors are not this chat's.
      onError: (event) => {
        if (isOwnAgentError(event, agent.agentId))
          setError(event.error.message);
      },
    });
    const events = agent.subscribe({
      onRunErrorEvent: ({ event }) => {
        runError.current = event.message;
        setError(event.message);
      },
    });
    return () => {
      subscription.unsubscribe();
      events.unsubscribe();
    };
  }, [agent, copilotkit]);
  useEffect(() => {
    if (!isReady) return;
    let active = true;
    void copilotkit
      .connectAgent({ agent })
      .then(() => {
        if (active) setLoaded(true);
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          );
      });
    return () => {
      active = false;
    };
  }, [agent, copilotkit, isReady]);
  // Connecting replays the whole stored conversation, so start from an empty list
  // instead of appending the replayed text to the messages already on screen.
  const reconnect = () => {
    agent.setMessages([]);
    return copilotkit.connectAgent({ agent });
  };
  // A turn this page did not start (a resume, a schedule, another tab) streams in as it starts.
  const live = useLiveStatus();
  const attach = useAutoAttach({
    threadId: thread.id,
    agent,
    ready: loaded,
    running,
    reconnect,
  });
  /** Runs the agent on the messages as they are: a new message, or the kept one after a refusal. */
  const runTurn = async () => {
    setError('');
    runError.current = '';
    setRunning(true);
    followOutput.current = true;
    autoOpen.current.beginTurn(agent.messages);
    attach.beginLocalRun();
    try {
      const result = await copilotkit.runAgent({ agent });
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        // Keep the server's reason when it sent one; it is more useful than a generic line.
        throw new Error(turnErrorMessage(runError.current));
      onSaved();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The turn failed. Your conversation remains saved.',
      );
    } finally {
      attach.endLocalRun();
      autoOpen.current.endTurn();
      setRunning(false);
    }
  };
  const send = async (text: string) => {
    if (!text.trim() || running || !loaded || !contextReady || paused) return;
    if (room.threadBusy || room.dispatching) return;
    // A Direct team chat sends the message to every member instead of the lead.
    if (teamChat.direct) {
      setDraft('');
      if (!(await teamChat.dispatch(text))) setDraft(text);
      return;
    }
    // A message that mentions other Dots goes to them, one turn each, after the owner's confirm.
    setDraft('');
    const routed = await room.send(text, contextualMessage(text, pageContext));
    if (routed === 'cancelled') setDraft(text);
    if (routed !== 'host') return;
    agent.addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: contextualMessage(text, pageContext),
    });
    setDraft('');
    await runTurn();
  };
  useEffect(() => {
    if (loaded && contextReady && !paused && initialPrompt && !sent.current) {
      sent.current = true;
      onConsumed();
      void send(initialPrompt);
    }
  }, [loaded, contextReady, paused, initialPrompt]);
  useEffect(() => {
    followOutput.current = true;
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [agent.messages.length, running]);
  // The runtime streams a whole turn into one assistant message, so text and
  // tool calls grow without the message count changing. Keep the newest reply
  // in view while the reader is at the bottom, but never fight a scroll-up.
  const lastMessage = agent.messages.at(-1);
  const growth = `${lastMessage?.id}:${
    typeof lastMessage?.content === 'string' ? lastMessage.content.length : 0
  }:${lastMessage?.role === 'assistant' ? (lastMessage.toolCalls?.length ?? 0) : 0}:${agent.messages.length}`;
  useEffect(() => {
    if (followOutput.current)
      bottom.current?.scrollIntoView({ behavior: 'instant', block: 'end' });
  }, [growth]);
  // Open the computer panel the first time a turn starts using the computer.
  const computerCallCount = agent.messages.reduce(
    (total, message) =>
      total +
      (message.role === 'assistant'
        ? (message.toolCalls?.filter((call) =>
            isComputerTool(call.function.name),
          ).length ?? 0)
        : 0),
    0,
  );
  useEffect(() => {
    if (onComputer && autoOpen.current.shouldOpen(agent.messages)) onComputer();
  }, [computerCallCount, running, agent, onComputer]);
  useEffect(() => {
    if (paused && voice.status !== 'idle') void voice.end();
  }, [paused]);
  // Approval cards show the live state of their approval. Fetch once when the
  // transcript has any, and keep polling while one is still waiting for the owner.
  const [approvals, setApprovals] = useState<Map<string, Approval>>(
    () => new Map(),
  );
  const askedIds = approvalIds(toolResults(agent.messages));
  const idsKey = askedIds.join(',');
  const refreshApprovals = useCallback(async () => {
    try {
      const data = await api<{ approvals: Approval[] }>(
        `/approvals?threadId=${encodeURIComponent(thread.id)}`,
      );
      setApprovals(new Map(data.approvals.map((row) => [row.id, row])));
    } catch {
      // The cards keep their last known state; the next poll retries.
    }
  }, [thread.id]);
  const waitingOnOwner = askedIds.some(
    (id) => (approvals.get(id)?.status ?? 'pending') === 'pending',
  );
  useEffect(() => {
    if (!idsKey) return;
    void refreshApprovals();
    if (!waitingOnOwner) return;
    const timer = setInterval(
      () => void refreshApprovals(),
      pollInterval(live),
    );
    return () => clearInterval(timer);
  }, [idsKey, waitingOnOwner, refreshApprovals, live]);
  useLiveEvent('approval.changed', (event) => {
    if (idsKey && event.threadId === thread.id) void refreshApprovals();
  });
  const decide = async (
    id: string,
    decision: 'approve' | 'deny',
    note?: string,
  ) => {
    try {
      await api(`/approvals/${id}`, 'POST', {
        decision,
        ...(note ? { note } : {}),
      });
      // The server resumes the Dot in this conversation; reconnecting streams that turn live.
      // With the live feed open, its turn.started attaches instead.
      if (live !== 'open') {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await reconnect().catch((e: unknown) =>
          setError(
            e instanceof Error ? e.message : 'Conversation could not connect.',
          ),
        );
      }
    } finally {
      await refreshApprovals();
    }
  };
  // A "Your turn" card waits for the owner on the computer panel. When that handoff
  // finishes (control given back, or dismissed) the server resumes the Dot here, so
  // reconnect to stream the resumed turn.
  const latestHandoff = handoffIds(toolResults(agent.messages)).at(-1);
  const handoffWaiting = useRef(false);
  const handoffFor = useRef<string>(undefined);
  const pollHandoff = useRef<() => void>(undefined);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    if (!latestHandoff) return;
    if (handoffFor.current !== latestHandoff) {
      handoffFor.current = latestHandoff;
      handoffWaiting.current = false;
    }
    let active = true;
    const poll = async () => {
      try {
        const data = await api<{ handoffs: Handoff[] }>(
          `/handoffs?status=waiting&dotId=${encodeURIComponent(dot.id)}`,
        );
        if (!active) return;
        const waiting = data.handoffs.some((row) => row.id === latestHandoff);
        if (handoffWaiting.current && !waiting && liveRef.current !== 'open') {
          await new Promise((resolve) => setTimeout(resolve, 400));
          if (active) await reconnect().catch(() => {});
        }
        handoffWaiting.current = waiting;
      } catch {
        // The next poll retries.
      }
    };
    void poll();
    pollHandoff.current = () => void poll();
    const timer = setInterval(() => void poll(), pollInterval(live));
    return () => {
      active = false;
      pollHandoff.current = undefined;
      clearInterval(timer);
    };
  }, [latestHandoff, dot.id, agent, copilotkit, live]);
  useLiveEvent('handoff.changed', (event) => {
    if (event.threadId === thread.id) pollHandoff.current?.();
  });
  const busy = busyKind(error);
  const busyWithOther = !!busy;
  // Stops the other turn, then sends the kept message once the Dot is free.
  const stopBackground = async () => {
    try {
      // In a group chat the other turn may be another Dot's, in this very chat.
      if (busy === 'thread') await room.stopThread();
      else await api(`/dots/${dot.id}/turn/stop`, 'POST', {});
      setError('');
      setTimeout(() => void runTurn(), 800);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Could not stop the background work.',
      );
    }
  };
  useHumanInTheLoop(
    {
      name: pageReviewTool.name,
      description: pageReviewTool.description,
      parameters: pageReviewSchema,
      // Only this chat's agent: a lane's live view must not answer a teammate's review.
      agentId: agent.agentId,
      render: (props) => (
        <PageReviewCard {...props} threadId={thread.id} onSaved={onSaved} />
      ),
    },
    [thread.id, onSaved, agent.agentId],
  );
  // Computer calls are drawn by ChatTranscript as one compact activity block;
  // this keeps every other tool without its own renderer from being reported
  // as unrendered.
  useRenderTool({ name: '*', render: () => null }, []);
  // Approval and handoff requests are drawn by ChatTranscript as an owner card.
  useRenderTool(
    { name: 'request_approval', parameters: anyArguments, render: () => null },
    [],
  );
  useRenderTool(
    { name: 'request_handoff', parameters: anyArguments, render: () => null },
    [],
  );
  // This page's own turn, or one it attached to.
  const working = running || !!attach.remoteRunId;
  const workingName = (!running && room.runningName) || dot.name;
  const visible = agent.messages.filter(
    (message) =>
      !isInternalVoiceReceipt(message) &&
      ['user', 'assistant'].includes(message.role) &&
      ((typeof message.content === 'string' && message.content.trim()) ||
        (message.role === 'assistant' &&
          message.toolCalls?.some(
            (call) =>
              isActivityTool(call.function.name) ||
              isLaneTool(call.function.name) ||
              call.function.name === 'request_approval' ||
              call.function.name === 'request_handoff' ||
              isFileCardTool(call.function.name) ||
              call.function.name === pageReviewTool.name,
          ))),
  );
  // Retry sends the owner's message again as a new turn; the earlier answer stays (folded).
  const retry = (message: Message) => {
    if (working || !loaded || !contextReady || paused) return;
    agent.addMessage(retryMessage(message, crypto.randomUUID()));
    void runTurn();
  };
  const actions = useMessageActions({
    threadId: thread.id,
    messages: agent.messages,
    visible,
    dotName: dot.name,
    retryBlocked: working
      ? 'Wait for the reply to finish'
      : paused
        ? 'Paused'
        : !loaded || !contextReady
          ? 'Connecting…'
          : undefined,
    onRetry: retry,
    onOpenThread,
    onError: setError,
  });
  return (
    <div className="live-chat">
      <header className="chat-persona">
        <Mascot
          identity={dot.id}
          color={dot.color}
          name={dot.name}
          small
          state={
            lanes.handingOff
              ? 'handing-off'
              : working
                ? 'working'
                : paused
                  ? 'paused'
                  : 'idle'
          }
        />
        <div>
          <strong>{dot.name}</strong>
          <span>
            {paused
              ? dot.paused
                ? 'Paused. Resume it from its menu in the sidebar.'
                : 'Paused'
              : working
                ? 'Thinking…'
                : loaded && contextReady
                  ? 'Here with you'
                  : 'Connecting to your conversation…'}
          </span>
        </div>
        {room.strip}
        <div className="chat-persona-actions">
          <StopEverything lanes={lanes.value} running={lanes.running} />
          <button
            className="icon-button"
            aria-label="Save conversation as page"
            disabled={running}
            onClick={async () => {
              const title = window.prompt('Page title', thread.title);
              if (!title) return;
              try {
                const page = await api<Page>(
                  `/conversations/${thread.id}/page`,
                  'POST',
                  { title },
                );
                location.hash = `/spaces/${page.spaceId}/pages/${page.id}`;
              } catch (e) {
                setError(
                  e instanceof Error
                    ? e.message
                    : 'Could not save conversation.',
                );
              }
            }}
          >
            <FilePlus size={18} />
          </button>
          <button
            className="icon-button"
            aria-label="Schedule a task in this conversation"
            onClick={onSchedule}
          >
            <Clock3 size={18} />
          </button>
          <DotNotesButton dot={dot} />
          {onTrigger && (
            <button
              className="icon-button"
              aria-label="Add a trigger to this conversation"
              title="Start work from a webhook or a connector"
              onClick={onTrigger}
            >
              <Zap size={18} />
            </button>
          )}
          <button
            className={`icon-button ${voice.status === 'active' ? 'on-call' : ''}`}
            aria-label={
              voice.status === 'idle' ? 'Start voice call' : 'End voice call'
            }
            title={
              voiceReady
                ? 'Talk with your Dot'
                : 'Voice setup requires VOICE_API_KEY and VOICE_MODEL'
            }
            disabled={!voiceReady || paused || !loaded || !contextReady}
            onClick={() =>
              voice.status === 'idle' ? void voice.start() : void voice.end()
            }
          >
            {voice.status === 'idle' ? (
              <Phone size={18} />
            ) : (
              <PhoneOff size={18} />
            )}
          </button>
        </div>
      </header>
      {teamChat.banner}
      {pageContext && (
        <div className="page-chat-context">
          Working on{' '}
          <a href={`/#/spaces/${pageContext.spaceId}/pages/${pageContext.id}`}>
            {pageContext.title}
          </a>
        </div>
      )}
      {actions.pinnedBar}
      <div
        className="chat-transcript"
        onScroll={(event) => {
          const element = event.currentTarget;
          followOutput.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <
            160;
        }}
      >
        {!visible.length && (
          <div className="chat-welcome">
            <span className="eyebrow">A LITTLE SPACE TO THINK</span>
            <h1>What’s on your mind?</h1>
            <p>{dot.instructions}</p>
            <p className="muted">
              Your conversation stays with this Dot, across text and calls.
            </p>
          </div>
        )}
        <LanesContext.Provider value={lanes.value}>
          <ChatTranscript
            messages={visible}
            calls={calls}
            allMessages={agent.messages}
            running={running}
            dotName={dot.name}
            onViewComputer={onComputer}
            onTakeOver={
              onComputer
                ? () => takeOverHere({ dotId: dot.id, open: onComputer })
                : undefined
            }
            approvals={approvals}
            onDecide={decide}
            group={room.group}
            bubbleActions={actions.bubbleActions}
            renderTools={(message) => (
              <CopilotChatToolCallsView
                message={message}
                messages={agent.messages}
              />
            )}
          />
        </LanesContext.Provider>
        {lanes.announcer}
        {working && (
          <div className="thinking">
            <span />
            <span />
            <span />
            <span>{workingName} is thinking</span>
          </div>
        )}
        <div ref={bottom} />
      </div>
      {contextError && (
        <div className="chat-error" role="alert">
          {contextError}
          <button onClick={() => setContextAttempt((value) => value + 1)}>
            Retry context
          </button>
        </div>
      )}
      {(error || voice.error) && (
        <div className="chat-error" role="alert">
          {busy === 'thread'
            ? threadRunningMessage(room.runningName)
            : error || voice.error}
          {error && busyWithOther && (
            <>
              <button onClick={() => void runTurn()} disabled={running}>
                Send again
              </button>
              <button onClick={() => void stopBackground()} disabled={running}>
                Stop the other work and send
              </button>
            </>
          )}
          {error && !busyWithOther && (
            <button
              onClick={() => {
                setError('');
                void reconnect()
                  .then(() => setLoaded(true))
                  .catch((e) => setError(e.message));
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      )}
      {room.error && (
        <div className="chat-error" role="alert">
          {busyKind(room.error) === 'thread'
            ? threadRunningMessage(room.runningName)
            : room.error}
          {room.hasPending && (
            <>
              <button onClick={room.retry} disabled={room.dispatching}>
                Send again
              </button>
              {busyKind(room.error) && (
                <button
                  onClick={() => void room.stopAndRetry()}
                  disabled={room.dispatching}
                >
                  Stop the other work and send
                </button>
              )}
            </>
          )}
          <button onClick={room.clearError}>Dismiss</button>
        </div>
      )}
      {room.dialog}
      <CallView
        key={voice.status === 'idle' ? 'idle' : 'call'}
        dot={dot}
        voice={voice}
      />
      <Composer
        mode="chat"
        label="Message your Dot"
        placeholder={teamChat.placeholder ?? `Message ${dot.name}…`}
        value={draft}
        onChange={setDraft}
        onSubmit={(text) => void send(text)}
        canSubmit={
          !running &&
          loaded &&
          contextReady &&
          !paused &&
          !room.threadBusy &&
          !room.dispatching
        }
        triggers={[room.mentionTrigger]}
        submitLabel="Send message"
        running={running}
        onStop={() => copilotkit.stopAgent({ agent })}
        textareaRef={actions.composerRef}
        sourceLink
        note={
          voiceReady
            ? 'Text and voice, one conversation.'
            : 'Text is ready. Voice needs separate server configuration.'
        }
      />
    </div>
  );
}
