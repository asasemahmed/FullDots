import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { Approval, CallReceipt, TurnSource } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { ComputerActivity } from './ComputerActivity';
import { ApprovalCard, type DecideApproval } from './ApprovalCard';
import { describeComputerSteps } from './ComputerToolCard';
import { buildTranscriptItems, toolResults } from './chat-turns';
// These markers only control rendering; they do not confer trust or permissions.
export function isInternalVoiceReceipt(message: Message): boolean {
  const metadata = message.metadata;
  return (
    message.role === 'user' &&
    (message.id.startsWith(voiceReceiptMessagePrefix) ||
      (!!metadata &&
        typeof metadata === 'object' &&
        'opendotsSource' in metadata &&
        metadata.opendotsSource === 'voice_receipt'))
  );
}
function Receipt({ call }: { call: CallReceipt }) {
  return (
    <div className="call-receipt">
      <PhoneOff size={13} />
      <span>
        {call.status === 'failed'
          ? 'Call failed'
          : call.endedAt
            ? `${Math.round((call.endedAt - call.startedAt) / 1000)}s · Call ended`
            : 'Call in progress'}
      </span>
      {call.error && <small>{call.error}</small>}
    </div>
  );
}
function Markdown({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        img: ({ alt }) => <span>{alt}</span>,
        a: ({ href, children }) => (
          <a
            onClick={(event) => {
              if (href?.startsWith('/#/spaces/')) {
                event.preventDefault();
                openPageLink(href);
              }
            }}
            href={href}
            target={href?.startsWith('/#/spaces/') ? undefined : '_blank'}
            rel="noreferrer"
          >
            {children}
          </a>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
function Bubble({ role, content }: { role: string; content: string }) {
  return (
    <div className={`chat-bubble ${role}`}>
      <Markdown content={content} />
    </div>
  );
}
const EVENT_LABELS: Record<TurnSource, string> = {
  task: 'Scheduled task',
  approval: 'Approval decision',
  handoff: 'Owner handoff',
  trigger: 'Trigger',
  channel: 'Message from channel',
  delegation: 'Delegated work',
};
/**
 * Renders the visible conversation. Consecutive `computer_*` and `mcp__*` tool calls of a
 * turn collapse into one compact ComputerActivity block, placed before the
 * assistant's reply; every other tool call is rendered by `renderTools`.
 */
export function ChatTranscript({
  messages,
  calls,
  renderTools,
  allMessages,
  running = false,
  dotName = 'Your Dot',
  onViewComputer,
  approvals,
  onDecide,
}: {
  messages: Message[];
  calls: CallReceipt[];
  /** Renders the UI of non-computer tool calls (an assistant message holding only those calls). */
  renderTools?: (message: AssistantMessage) => ReactNode;
  /** The complete message list, used to find tool results. Defaults to `messages`. */
  allMessages?: Message[];
  /** A run is in progress, so the latest computer block may still be working. */
  running?: boolean;
  dotName?: string;
  /** Opens the computer side panel. */
  onViewComputer?: () => void;
  /** Live approval rows by id, for the status of each approval card. */
  approvals?: ReadonlyMap<string, Approval>;
  /** Answers a pending approval card. */
  onDecide?: DecideApproval;
}) {
  const results = toolResults(allMessages ?? messages);
  const items = buildTranscriptItems(messages, calls, results);
  const lastActivity = items.findLastIndex((item) => item.kind === 'activity');
  const lastUser = items.findLastIndex(
    (item) =>
      item.kind === 'event' || (item.kind === 'bubble' && item.role === 'user'),
  );
  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case 'receipt':
            return <Receipt key={item.key} call={item.call} />;
          case 'bubble':
            return (
              <Bubble key={item.key} role={item.role} content={item.content} />
            );
          case 'event':
            return (
              <div
                key={item.key}
                className="chat-event"
                data-source={item.source}
              >
                <span className="chat-event-label">
                  {EVENT_LABELS[item.source]}
                </span>
                <Markdown content={item.content} />
              </div>
            );
          case 'tools':
            return (
              <Fragment key={item.key}>{renderTools?.(item.message)}</Fragment>
            );
          case 'approval':
            return (
              <ApprovalCard
                key={item.key}
                result={item.result}
                approval={
                  item.result.status === 'pending_approval'
                    ? approvals?.get(item.result.approvalId)
                    : undefined
                }
                onDecide={onDecide}
                onViewComputer={onViewComputer}
              />
            );
          case 'activity': {
            const live = running && index === lastActivity && index > lastUser;
            return (
              <ComputerActivity
                key={item.key}
                steps={describeComputerSteps(
                  item.calls.map((call) => ({
                    id: call.id,
                    name: call.function.name,
                    arguments: call.function.arguments,
                  })),
                  results,
                  live,
                )}
                live={live}
                dotName={dotName}
                onViewLive={onViewComputer}
              />
            );
          }
        }
      })}
    </>
  );
}
