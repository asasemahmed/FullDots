import { openPageLink } from './page-navigation';
import { Fragment, type ReactNode } from 'react';
import { PhoneOff } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AssistantMessage, Message } from '@ag-ui/core';
import type { Approval, CallReceipt, Dot } from '../shared/types';
import { voiceReceiptMessagePrefix } from '../shared/voice-receipt';
import { TURN_SOURCE_LABELS } from '../shared/step-label';
import { ComputerActivity } from './ComputerActivity';
import { ApprovalCard, type DecideApproval } from './ApprovalCard';
import { FileCard } from './FileCard';
import { describeComputerSteps } from './ComputerToolCard';
import {
  buildTranscriptItems,
  toolResults,
  type SavedFile,
} from './chat-turns';
import { AddressedLine, AuthoredBubble } from './room/AuthorBubble';
import { EarlierAttempts } from './message-actions/EarlierAttempts';
import { foldRetries } from './message-actions/retries';
import type { BubbleInfo } from './message-actions/useMessageActions';
import { BandItem } from './lanes/BandItem';
import { BuiltFrom, DelegatedWork } from './lanes/DelegatedResults';
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
function Bubble({
  role,
  content,
  messageId,
  actions,
}: {
  role: string;
  content: string;
  messageId?: string;
  /** The message actions toolbar, shown on hover or keyboard focus. */
  actions?: ReactNode;
}) {
  return (
    <div className={`chat-bubble ${role}`} data-message-id={messageId}>
      <Markdown content={content} />
      {actions}
    </div>
  );
}
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
  onOpenFile,
  onTakeOver,
  approvals,
  onDecide,
  group,
  bubbleActions,
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
  /** Shows a file a Dot saved beside the chat. */
  onOpenFile?: (file: SavedFile) => void;
  /** Opens the computer side panel and takes control, from a handoff card. */
  onTakeOver?: () => Promise<void>;
  /** Live approval rows by id, for the status of each approval card. */
  approvals?: ReadonlyMap<string, Approval>;
  /** Answers a pending approval card. */
  onDecide?: DecideApproval;
  /** Group chat attribution: who wrote a reply, and the Dots owner messages were addressed to. */
  group?: {
    authorOf(messageId: string): Dot | undefined;
    dot(id: string): Dot | undefined;
  };
  /** The actions toolbar of each text bubble (pin, retry, branch, edit, copy). */
  bubbleActions?: (bubble: BubbleInfo) => ReactNode;
}) {
  const results = toolResults(allMessages ?? messages);
  // A retried message's earlier answers fold under it; nothing is dropped.
  const folded = foldRetries(messages);
  const items = buildTranscriptItems(folded.messages, calls, results);
  const lastActivity = items.findLastIndex((item) => item.kind === 'activity');
  const lastUser = items.findLastIndex(
    (item) =>
      item.kind === 'event' || (item.kind === 'bubble' && item.role === 'user'),
  );
  // The reply that follows a "Delegated work" turn is built from those results.
  const builtFrom = new Map<number, string>();
  let delivered: string | undefined;
  items.forEach((item, index) => {
    if (item.kind === 'event')
      delivered = item.source === 'delegation' ? item.ref : undefined;
    else if (item.kind === 'bubble' && item.role === 'user')
      delivered = undefined;
    else if (item.kind === 'bubble' && delivered) {
      builtFrom.set(index, delivered);
      delivered = undefined;
    }
  });
  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case 'receipt':
            return <Receipt key={item.key} call={item.call} />;
          case 'bubble': {
            const earlier = folded.earlier.get(item.messageId);
            const author =
              item.role === 'assistant'
                ? group?.authorOf(item.messageId)
                : undefined;
            const to = item.to ? group?.dot(item.to) : undefined;
            if (to && item.repeat)
              return <AddressedLine key={item.key} to={to} repeat />;
            const bubble = (
              <Bubble
                role={item.role}
                content={item.content}
                messageId={item.messageId}
                actions={bubbleActions?.(item)}
              />
            );
            return (
              <Fragment key={item.key}>
                {to && !author && <AddressedLine to={to} />}
                {author ? (
                  <AuthoredBubble author={author}>{bubble}</AuthoredBubble>
                ) : (
                  bubble
                )}
                {builtFrom.has(index) && (
                  <BuiltFrom refId={builtFrom.get(index)!} />
                )}
                {earlier && (
                  <EarlierAttempts count={earlier.length}>
                    {earlier.map((attempt) => (
                      <ChatTranscript
                        key={attempt[0].id}
                        messages={attempt}
                        calls={[]}
                        allMessages={allMessages ?? messages}
                        dotName={dotName}
                        renderTools={renderTools}
                        approvals={approvals}
                        bubbleActions={bubbleActions}
                        group={group}
                      />
                    ))}
                  </EarlierAttempts>
                )}
              </Fragment>
            );
          }
          case 'event': {
            const line = (
              <div
                key={item.key}
                className="chat-event"
                data-source={item.source}
              >
                <span className="chat-event-label">
                  {TURN_SOURCE_LABELS[item.source]}
                </span>
                <Markdown content={item.content} />
              </div>
            );
            // Teammates' results show as their cards, when the lanes know them.
            return item.source === 'delegation' && item.ref ? (
              <DelegatedWork key={item.key} refId={item.ref} fallback={line} />
            ) : (
              line
            );
          }
          case 'band':
            return (
              <BandItem key={item.key} calls={item.calls} results={results} />
            );
          case 'tools':
            return (
              <Fragment key={item.key}>{renderTools?.(item.message)}</Fragment>
            );
          case 'file':
            return (
              <FileCard key={item.key} file={item.file} onOpen={onOpenFile} />
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
                onTakeOver={onTakeOver}
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
