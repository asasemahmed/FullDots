import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dot } from '../shared/types';
import type {
  ComputerAction,
  ComputerPermissions,
  ComputerStatus,
} from '../shared/computer-types';
import { api } from './api';
import type { Frame } from './computer-input';
import type { StreamPhase } from './useComputerStream';
import { PanelView } from './computer-panel/PanelView';
import type { Working } from './computer-panel/PanelHeader';
import type { SaveNote } from './computer-panel/SettingsSheet';
import type { PagePosition, Snapshot } from './computer-panel/ScreenStage';
import {
  currentActivity,
  isUsable,
  type PermissionKey,
} from './computer-panel/model';

const POLL_MS = 4000;
/** While the Dot is acting, the panel looks more often so "Dot is clicking…" is not stale. */
const POLL_ACTIVE_MS = 2000;
const PAGE_READ_MS = 12_000;
const PAGE_READ_ACTIVE_MS = 4000;
const SAVED_NOTE_MS = 2500;

type Outcome = { ok: true; result: unknown } | { ok: false };

/**
 * A Dot's computer: the live screen first, one control for who is driving, and the rest a click
 * away. This component owns the polling and every request; what is drawn lives in `computer-panel/`.
 *
 * `dots` and `onSelectDot` let the settings offer a switch between Dots, and `onClose` adds a close
 * button. Without them the panel is just this one Dot's.
 */
export function ComputerPanel({
  dot,
  dots,
  onSelectDot,
  onClose,
}: {
  dot: Dot;
  dots?: readonly Dot[];
  onSelectDot?: (id: string) => void;
  onClose?: () => void;
}) {
  const [status, setStatus] = useState<ComputerStatus>();
  // When the status was fetched, so "a moment ago" can be judged without reading the clock in render.
  const [statusAt, setStatusAt] = useState(() => Date.now());
  const [clock, setClock] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [page, setPage] = useState<PagePosition>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<Working>();
  const [snapshotError, setSnapshotError] = useState('');
  // The live screen replaces snapshot polling while it works; this is how the panel knows.
  const [stream, setStream] = useState<StreamPhase>({ phase: 'connecting' });
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [frameSize, setFrameSize] = useState<Frame>();
  const [optimistic, setOptimistic] = useState<Partial<ComputerPermissions>>(
    {},
  );
  const [notes, setNotes] = useState<Partial<Record<PermissionKey, SaveNote>>>(
    {},
  );
  const noteTimers = useRef<Partial<Record<PermissionKey, number>>>({});
  const lifecycle = useRef({
    active: false,
    revision: 0,
    busy: false,
    loaded: false,
    running: false,
    streaming: false,
    agentActive: false,
    urlAt: 0,
  });
  const controller = useRef<AbortController | null>(null);
  const base = `/dots/${encodeURIComponent(dot.id)}/computer`;
  const refresh = useCallback(async () => {
    const revision = lifecycle.current.revision;
    const current = () =>
      lifecycle.current.active && revision === lifecycle.current.revision;
    try {
      const next = await api<ComputerStatus>(
        base,
        'GET',
        undefined,
        controller.current?.signal,
      );
      if (!current()) return;
      setStatus(next);
      setStatusAt(Date.now());
      lifecycle.current.loaded = true;
      lifecycle.current.running = next.state === 'running';
      setError('');
      if (
        next.state === 'running' &&
        next.permissions.browser &&
        next.permissions.enabled
      ) {
        if (lifecycle.current.streaming) {
          // The live screen has no address bar, so ask the page where it is now and then.
          const every = lifecycle.current.agentActive
            ? PAGE_READ_ACTIVE_MS
            : PAGE_READ_MS;
          if (Date.now() - lifecycle.current.urlAt > every) {
            lifecycle.current.urlAt = Date.now();
            try {
              const read = await api<{ url?: unknown; title?: unknown }>(
                `${base}/actions`,
                'POST',
                { action: 'read', input: {} },
                controller.current?.signal,
              );
              if (current() && typeof read.url === 'string') {
                const url = read.url;
                const title =
                  typeof read.title === 'string' && read.title.trim()
                    ? read.title
                    : undefined;
                setPage({ url, title });
              }
            } catch {
              // The address is a courtesy; the screen is what matters.
            }
          }
        } else
          try {
            const capture = await api<Snapshot>(
              `${base}/actions`,
              'POST',
              { action: 'screenshot', input: {} },
              controller.current?.signal,
            );
            if (current()) {
              setSnapshot(capture);
              setPage((before) => ({
                url: capture.url,
                title: before?.url === capture.url ? before.title : undefined,
              }));
              setSnapshotError('');
            }
          } catch (cause) {
            if (current()) {
              setSnapshot(undefined);
              setSnapshotError(
                cause instanceof Error
                  ? cause.message
                  : 'Could not refresh the screen.',
              );
            }
          }
      } else {
        setSnapshot(undefined);
        setSnapshotError('');
        setPage(undefined);
      }
    } catch (cause) {
      if (current()) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'Could not load the computer.',
        );
        setSnapshot(undefined);
      }
    }
  }, [base]);
  useEffect(() => {
    lifecycle.current.active = true;
    controller.current = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (
        !document.hidden &&
        !lifecycle.current.busy &&
        (!lifecycle.current.loaded || lifecycle.current.running)
      )
        await refresh();
      if (!cancelled && lifecycle.current.active)
        timer = setTimeout(
          () => void poll(),
          lifecycle.current.agentActive ? POLL_ACTIVE_MS : POLL_MS,
        );
    };
    void poll();
    const timers = noteTimers.current;
    return () => {
      cancelled = true;
      lifecycle.current.active = false;
      lifecycle.current.revision++;
      controller.current?.abort();
      clearTimeout(timer);
      for (const handle of Object.values(timers)) clearTimeout(handle);
    };
  }, [refresh]);
  const run = async (
    endpoint: string,
    body: unknown = {},
    method = 'POST',
  ): Promise<Outcome> => {
    if (lifecycle.current.busy) return { ok: false };
    lifecycle.current.busy = true;
    lifecycle.current.revision++;
    lifecycle.current.urlAt = 0;
    setBusy(true);
    setError('');
    try {
      const result = await api<unknown>(
        `${base}${endpoint}`,
        method,
        body,
        controller.current?.signal,
      );
      if (!lifecycle.current.active) return { ok: false };
      await refresh();
      return { ok: true, result };
    } catch (cause) {
      if (lifecycle.current.active)
        setError(
          cause instanceof Error ? cause.message : 'Computer action failed.',
        );
      return { ok: false };
    } finally {
      lifecycle.current.busy = false;
      if (lifecycle.current.active) setBusy(false);
    }
  };
  /** Runs `run` and shows what it is doing in the header and the control bar. */
  const doing = async <T,>(kind: Working, work: () => Promise<T>) => {
    setWorking(kind);
    try {
      return await work();
    } finally {
      if (lifecycle.current.active) setWorking(undefined);
    }
  };
  const act = async (action: ComputerAction, input: unknown) => {
    const outcome = await run('/actions', { action, input });
    return outcome.ok ? (outcome.result ?? null) : undefined;
  };
  const setPermission = async (key: PermissionKey, value: boolean) => {
    clearTimeout(noteTimers.current[key]);
    setOptimistic((before) => ({ ...before, [key]: value }));
    setNotes((before) => ({ ...before, [key]: 'saving' }));
    const outcome = await run('/permissions', { [key]: value }, 'PATCH');
    if (!lifecycle.current.active) return;
    setOptimistic((before) =>
      Object.fromEntries(
        Object.entries(before).filter(([name]) => name !== key),
      ),
    );
    setNotes((before) => ({
      ...before,
      [key]: outcome.ok ? 'saved' : 'error',
    }));
    if (outcome.ok)
      noteTimers.current[key] = window.setTimeout(
        () =>
          setNotes((before) =>
            Object.fromEntries(
              Object.entries(before).filter(([name]) => name !== key),
            ),
          ),
        SAVED_NOTE_MS,
      );
  };

  const human =
    status?.control?.holder === 'human' && !status.control.transitioning;
  const browser = isUsable(status) && !!status?.permissions.browser;
  const streaming =
    browser &&
    ['connecting', 'live', 'reconnecting', 'paused'].includes(stream.phase);
  const now = Math.max(statusAt, clock);
  const activity = human
    ? undefined
    : currentActivity(status?.audit ?? [], now);
  const agentActive = !!activity;
  useEffect(() => {
    lifecycle.current.streaming = streaming;
  }, [streaming]);
  useEffect(() => {
    lifecycle.current.agentActive = agentActive;
    if (!agentActive) return;
    const timer = setInterval(() => setClock(Date.now()), 1500);
    return () => clearInterval(timer);
  }, [agentActive]);
  // Back to snapshots as soon as the live screen is not there to show the page.
  useEffect(() => {
    if (lifecycle.current.loaded && !streaming) void refresh();
  }, [streaming, refresh]);
  const onPhase = useCallback((phase: StreamPhase) => {
    setStream(phase);
    if (phase.phase === 'live') {
      setSnapshot(undefined);
      setSnapshotError('');
    }
  }, []);

  return (
    <PanelView
      dot={dot}
      dots={dots}
      onSelectDot={onSelectDot}
      onClose={onClose}
      status={status}
      loadFailed={!!error}
      error={error}
      onDismissError={() => setError('')}
      busy={busy}
      working={working}
      stream={stream}
      streamKey={streamAttempt}
      snapshot={snapshot}
      snapshotError={snapshotError}
      page={page}
      activity={activity}
      frameSize={frameSize}
      optimistic={optimistic}
      notes={notes}
      actions={{
        refresh: () => void refresh(),
        start: () => void doing('start', () => run('/start')),
        stop: () => void doing('stop', () => run('/stop')),
        enable: () => {
          const turnOn = async () => {
            const enabled = await run(
              '/permissions',
              { enabled: true },
              'PATCH',
            );
            if (enabled.ok && !lifecycle.current.running) await run('/start');
          };
          // Only a computer that is off is "starting"; a running one just gets its access back.
          void (lifecycle.current.running ? turnOn() : doing('start', turnOn));
        },
        take: () => void doing('take', () => run('/take')),
        release: () => void doing('release', () => run('/release')),
        navigate: async (url) => {
          const outcome = await run('/actions', {
            action: 'navigate',
            input: { url },
          });
          return outcome.ok;
        },
        act,
        setPermission: (key, value) => void setPermission(key, value),
        retryStream: () => {
          setStream({ phase: 'connecting' });
          setStreamAttempt((attempt) => attempt + 1);
        },
        clickSnapshot: (point) => void act('human_click', point),
        onPhase,
        onFrameSize: setFrameSize,
      }}
    />
  );
}
