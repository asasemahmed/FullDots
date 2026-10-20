// Mission control: every Dot at a glance. Its character shows what it is doing (working while it
// holds a turn, waiting when something needs the owner, paused, idle), with the chat it works in,
// its queue, what waits for the owner and today's tokens against its budget.
import { useCallback, useState, type ReactNode } from 'react';
import {
  CircleStop,
  Hourglass,
  Inbox,
  ListTodo,
  MessageSquare,
  Pause,
  Play,
} from 'lucide-react';
import type { LiveEventType } from '../../shared/live-events';
import type { MissionDot, MissionResponse } from '../../shared/inbox';
import type { TurnSource } from '../../shared/types';
import { Mascot, dotColor, dotLook } from '../Mascot';
import { api } from '../api';
import { useLiveRefresh } from '../live-refresh';
import './mission.css';

export const MISSION_EVENTS = [
  'turn.started',
  'turn.finished',
  'task.changed',
  'approval.changed',
  'handoff.changed',
  'inbox.changed',
  'usage.updated',
  'workspace.changed',
] as const satisfies readonly LiveEventType[];

const SOURCE_LABELS: Record<TurnSource | 'chat', string> = {
  chat: 'Chatting',
  task: 'Scheduled task',
  approval: 'After your approval',
  handoff: 'After your take-over',
  trigger: 'Trigger',
  channel: 'Channel message',
  delegation: 'Team work',
  relay: 'Handed the turn in a group chat',
  question: 'After your answer',
};

const STATE_LABELS: Record<MissionDot['state'], string> = {
  working: 'Working',
  'needs-input': 'Needs you',
  paused: 'Paused',
  idle: 'Idle',
};

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

/** What the card says the Dot is doing. */
export function activityLine(dot: MissionDot): string {
  if (dot.activity) {
    const where = `In “${dot.activity.threadTitle}”`;
    return dot.activity.step ? `${where} · ${dot.activity.step}` : where;
  }
  if (dot.waiting.total) {
    const parts = [
      dot.waiting.approvals && plural(dot.waiting.approvals, 'approval'),
      dot.waiting.handoffs &&
        plural(dot.waiting.handoffs, 'computer step', 'computer steps'),
      dot.waiting.questions && plural(dot.waiting.questions, 'question'),
    ].filter(Boolean);
    return `Waiting for you: ${parts.join(', ')}`;
  }
  if (dot.state === 'paused')
    return 'Paused. Background work waits until you resume it.';
  return dot.queued ? 'Up next: its queued work' : 'Ready when you are';
}

/** Tokens today against the daily budget: 0-1, or null without a budget. */
export function budgetShare(usage: MissionDot['usage']): number | null {
  if (!usage.budget) return null;
  return Math.min(1, usage.today / usage.budget);
}

const formatTokens = (value: number) =>
  value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : value >= 10_000
      ? `${Math.round(value / 1000)}k`
      : value.toLocaleString('en-US');

function TokenBar({ dot }: { dot: MissionDot }) {
  const share = budgetShare(dot.usage);
  const label =
    dot.usage.budget === null
      ? `${formatTokens(dot.usage.today)} tokens today · no budget`
      : `${formatTokens(dot.usage.today)} of ${formatTokens(dot.usage.budget)} tokens today`;
  return (
    <div className="mission-tokens">
      <span className="mission-tokens-label">{label}</span>
      {share !== null && (
        <span
          className={`mission-bar ${share >= 1 ? 'is-over' : share >= 0.8 ? 'is-near' : ''}`}
          role="meter"
          aria-label={`${dot.name}: tokens today`}
          aria-valuemin={0}
          aria-valuemax={dot.usage.budget ?? 0}
          aria-valuenow={Math.min(dot.usage.today, dot.usage.budget ?? 0)}
          aria-valuetext={label}
        >
          <span style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      )}
    </div>
  );
}

function CardAction({
  label,
  icon,
  onAction,
  disabled,
  tone = 'plain',
}: {
  label: string;
  icon: ReactNode;
  onAction: () => unknown;
  disabled?: boolean;
  tone?: 'plain' | 'danger';
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={`mission-action ${tone === 'danger' ? 'is-danger' : ''}`}
      disabled={disabled || busy}
      onClick={() => {
        setBusy(true);
        void Promise.resolve(onAction()).finally(() => setBusy(false));
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export interface MissionViewProps {
  mission?: MissionResponse;
  error?: string;
  onOpenChat: (dot: MissionDot) => void;
  onTogglePause: (dot: MissionDot) => Promise<void> | void;
  onStop: (dot: MissionDot) => Promise<void> | void;
  onOpenInbox: () => void;
}

function DotCard({ dot, ...props }: { dot: MissionDot } & MissionViewProps) {
  const headingId = `mission-${dot.id}`;
  return (
    <li
      className={`mission-card is-${dot.state}`}
      style={{
        ['--mission-dot' as string]: `var(--dot-${dotColor(dot)}-base)`,
      }}
      aria-labelledby={headingId}
    >
      <div className="mission-face">
        <Mascot
          hero
          identity={dot.id}
          {...dotLook(dot)}
          name={dot.name}
          state={dot.state}
        />
      </div>
      <div className="mission-body">
        <div className="mission-head">
          <h3 id={headingId}>{dot.name}</h3>
          <span className={`mission-state is-${dot.state}`}>
            {STATE_LABELS[dot.state]}
          </span>
        </div>
        {dot.activity && (
          <span className="mission-source">
            {SOURCE_LABELS[dot.activity.source] ?? 'Working'}
          </span>
        )}
        <p className="mission-activity">{activityLine(dot)}</p>
        <div className="mission-facts">
          <span title="Background tasks waiting to run">
            <ListTodo size={14} aria-hidden="true" />
            {plural(dot.queued, 'queued task')}
          </span>
          {dot.waiting.total > 0 ? (
            <button
              type="button"
              className="mission-waiting"
              onClick={props.onOpenInbox}
            >
              <Inbox size={14} aria-hidden="true" />
              {dot.waiting.total} waiting on you
            </button>
          ) : (
            <span>
              <Hourglass size={14} aria-hidden="true" />
              Nothing waiting on you
            </span>
          )}
        </div>
        <TokenBar dot={dot} />
        <div
          className="mission-actions"
          role="group"
          aria-label={`${dot.name} actions`}
        >
          <CardAction
            label="Open chat"
            icon={<MessageSquare size={14} aria-hidden="true" />}
            onAction={() => props.onOpenChat(dot)}
          />
          <CardAction
            label={dot.paused ? 'Resume' : 'Pause'}
            icon={
              dot.paused ? (
                <Play size={14} aria-hidden="true" />
              ) : (
                <Pause size={14} aria-hidden="true" />
              )
            }
            onAction={() => props.onTogglePause(dot)}
          />
          <CardAction
            label="Stop"
            tone="danger"
            icon={<CircleStop size={14} aria-hidden="true" />}
            disabled={dot.state !== 'working'}
            onAction={() => props.onStop(dot)}
          />
        </div>
      </div>
    </li>
  );
}

export function MissionView(props: MissionViewProps) {
  const { mission } = props;
  const byId = new Map(mission?.dots.map((dot) => [dot.id, dot]));
  const working = mission?.dots.filter((dot) => dot.state === 'working') ?? [];
  const waiting =
    mission?.dots.reduce((total, dot) => total + dot.waiting.total, 0) ?? 0;
  return (
    <main className="main-content mission-view">
      <header className="mission-header">
        <div>
          <h1>Mission control</h1>
          <p>
            {!mission
              ? 'Gathering your Dots…'
              : `${plural(working.length, 'Dot')} working · ${waiting} waiting on you`}
          </p>
        </div>
        {mission?.allPaused && (
          <span className="mission-state is-paused">All Dots paused</span>
        )}
      </header>
      {props.error && (
        <p className="chat-error" role="alert">
          {props.error}
        </p>
      )}
      {mission?.groups.map((group) => {
        const dots = group.dotIds
          .map((id) => byId.get(id))
          .filter((dot): dot is MissionDot => !!dot);
        if (!dots.length) return null;
        return (
          <section
            key={group.id}
            className="mission-group"
            aria-labelledby={`mission-group-${group.id}`}
          >
            <h2 id={`mission-group-${group.id}`}>{group.label}</h2>
            <ul className="mission-grid">
              {dots.map((dot) => (
                <DotCard key={dot.id} dot={dot} {...props} />
              ))}
            </ul>
          </section>
        );
      })}
    </main>
  );
}

/** Mission control wired to the API: live via events, with the slow fallback poll. */
export function MissionPage(props: {
  onOpenThread: (threadId: string) => void;
  onNewChat: (dotId: string) => void;
  onOpenInbox: () => void;
}) {
  const [mission, setMission] = useState<MissionResponse>();
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      setMission(await api<MissionResponse>('/mission'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the Dots.');
    }
  }, []);
  useLiveRefresh(refresh, MISSION_EVENTS);
  const act = async (path: string, body: unknown) => {
    setError('');
    try {
      await api(path, 'POST', body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      await refresh();
    }
  };
  return (
    <MissionView
      mission={mission}
      error={error}
      onOpenInbox={props.onOpenInbox}
      onOpenChat={(dot) =>
        dot.threadId
          ? props.onOpenThread(dot.threadId)
          : props.onNewChat(dot.id)
      }
      onTogglePause={(dot) =>
        act(`/dots/${encodeURIComponent(dot.id)}/pause`, {
          paused: !dot.paused,
        })
      }
      onStop={(dot) => act(`/dots/${encodeURIComponent(dot.id)}/turn/stop`, {})}
    />
  );
}
