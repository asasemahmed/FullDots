import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  MessageCircle,
} from 'lucide-react';
import type { Approval, Handoff, Task } from '../shared/types';
import { Mascot } from './Mascot';
export const relative = (value: number) => {
  const minutes = Math.floor((Date.now() - value) / 60000);
  return minutes < 1
    ? 'Just now'
    : minutes < 60
      ? `${minutes}m ago`
      : minutes < 1440
        ? `${Math.floor(minutes / 60)}h ago`
        : new Date(value).toLocaleDateString();
};
export const statusLabel = (task: Task) =>
  task.status === 'completed' && task.nextRunAt
    ? 'Scheduled'
    : task.status.charAt(0).toUpperCase() + task.status.slice(1);
export function Status({ task }: { task: Task }) {
  return (
    <span className={`status ${task.status}`}>
      <span />
      {statusLabel(task)}
    </span>
  );
}

/** A task as the server lists it: `threadId` is the conversation it runs in, when it has one. */
export type ListedTask = Task & { threadId?: string | null };

/** What the owner has to do before this task's conversation can go on. */
export function taskWaits(
  task: ListedTask,
  approvals: Approval[],
  handoffs: Handoff[],
): string[] {
  const threadId = task.threadId;
  if (!threadId) return [];
  return [
    ...(approvals.some((a) => a.threadId === threadId && a.status === 'pending')
      ? ['Waiting for your approval']
      : []),
    ...(handoffs.some((h) => h.threadId === threadId && h.status === 'waiting')
      ? ['Waiting for you on the computer']
      : []),
  ];
}

export function TaskRow({
  task,
  onClick,
  waits = [],
  onWaitingClick,
}: {
  task: Task;
  onClick: () => void;
  waits?: string[];
  onWaitingClick?: () => void;
}) {
  return (
    <button className="task-row" onClick={onClick}>
      <span className="task-row-icon">
        {task.status === 'completed' ? (
          <CheckCheck size={19} />
        ) : task.status === 'running' ? (
          <LoaderCircle className="spin" size={19} />
        ) : (
          <MessageCircle size={19} />
        )}
      </span>
      <div>
        <strong>{task.prompt}</strong>
        <span>
          {task.intervalSeconds
            ? `Repeats every ${task.intervalSeconds < 3600 ? task.intervalSeconds / 60 + ' min' : task.intervalSeconds / 3600 + ' hr'} · `
            : ''}
          {relative(task.updatedAt)}
        </span>
        {waits.map((text) => (
          <span
            key={text}
            className="task-wait"
            role="link"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              onWaitingClick?.();
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              onWaitingClick?.();
            }}
          >
            {text}
          </span>
        ))}
      </div>
      <Status task={task} />
      <ChevronRight size={16} />
    </button>
  );
}
export function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="large-empty">
      <Mascot />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}
