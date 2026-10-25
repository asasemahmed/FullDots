import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { AbstractAgent } from '@ag-ui/client';

export const codingWorkerStatusSchema = z.enum([
  'running',
  'completed',
  'cancelled',
  'timed_out',
  'failed',
  'authentication_required',
]);
export type CodingWorkerStatus = z.infer<typeof codingWorkerStatusSchema>;

export const codingAgentProgressSchema = z.object({
  codingSessionId: z.string().min(1).max(200),
  text: z.string().max(40000),
  status: codingWorkerStatusSchema,
});
export type CodingAgentProgress = z.infer<typeof codingAgentProgressSchema>;

const STATUS_LABELS: Record<CodingWorkerStatus, string> = {
  running: 'Running',
  completed: 'Completed',
  cancelled: 'Cancelled',
  timed_out: 'Timed out',
  failed: 'Failed',
  authentication_required: 'Authentication required',
};

export function useCodingProgress(
  agent: Pick<AbstractAgent, 'subscribe'>,
  threadId: string,
): CodingAgentProgress[] {
  const [state, setState] = useState<{
    threadId: string;
    items: CodingAgentProgress[];
  }>({
    threadId,
    items: [],
  });

  useEffect(() => {
    let active = true;
    setState({ threadId, items: [] });

    const settle = (status: 'cancelled' | 'failed') => {
      if (!active) return;
      setState((prev) => {
        if (!active || prev.threadId !== threadId)
          return { threadId, items: [] };
        const next = prev.items.map((i) =>
          i.status === 'running' ? { ...i, status } : i,
        );
        return { threadId, items: next };
      });
    };

    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (!active || !event || event.name !== 'coding_agent_progress') return;
        let raw = event.value;
        if (typeof raw === 'string') {
          try {
            raw = JSON.parse(raw);
          } catch {
            return;
          }
        }
        const parsed = codingAgentProgressSchema.safeParse(raw);
        if (!parsed.success) return;

        setState((prev) => {
          if (!active || prev.threadId !== threadId)
            return { threadId, items: [] };
          const idx = prev.items.findIndex(
            (i) => i.codingSessionId === parsed.data.codingSessionId,
          );
          const next = [...prev.items];
          if (idx >= 0) next[idx] = parsed.data;
          else {
            next.push(parsed.data);
            if (next.length > 10) next.shift();
          }
          return { threadId, items: next };
        });
      },
      onRunFailed: () => settle('failed'),
      onRunFinalized: () => settle('cancelled'),
    });

    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [agent, threadId]);

  return state.threadId === threadId ? state.items : [];
}

export function CodingProgress({
  progress,
}: {
  progress?: CodingAgentProgress[];
}) {
  if (!progress?.length) return null;

  return (
    <section aria-label="Coding worker progress" className="chat-activity">
      {progress.map((item) => (
        <details key={item.codingSessionId} open={item.status === 'running'}>
          <summary className="chat-activity-bar" style={{ cursor: 'pointer' }}>
            <span className="chat-activity-title">Coding worker</span>
            <span className="chat-activity-sep" aria-hidden="true">
              ·
            </span>
            <span
              className={
                item.status === 'failed' || item.status === 'timed_out'
                  ? 'chat-activity-warn'
                  : 'chat-activity-current'
              }
            >
              {STATUS_LABELS[item.status] ?? item.status}
            </span>
          </summary>
          {item.text && (
            <pre
              style={{
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                margin: 0,
                padding: '8px 12px',
              }}
            >
              {item.text}
            </pre>
          )}
        </details>
      ))}
    </section>
  );
}
