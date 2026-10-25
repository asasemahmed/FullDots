// What each Dot is doing right now, for its sidebar row: working (it holds a turn) or needs-input
// (an approval, a takeover or a question waits for the owner), how many things wait for the owner,
// and the latest computer step. Read from GET /api/mission, again whenever the live feed says a
// turn or something waiting for the owner changed.
import { useCallback, useState } from 'react';
import type { MissionResponse } from '../../shared/inbox';
import { api } from '../api';
import { useLiveRefresh } from '../live-refresh';

export type DotLiveState = 'working' | 'needs-input';

export interface DotLive {
  /** Unset while the Dot is idle or paused. */
  state?: DotLiveState;
  /** Approvals, hand-offs and questions of this Dot waiting for the owner. */
  waiting: number;
  /** The latest computer step of the turn it holds, e.g. "navigate · Pricing". */
  step: string | null;
}

const EVENTS = [
  'turn.started',
  'turn.finished',
  'approval.changed',
  'handoff.changed',
  'inbox.changed',
  'workspace.changed',
] as const;

/** Dot id to its live state; Dots that are idle or paused are left out. */
export function liveStates(
  mission: Pick<MissionResponse, 'dots'>,
): Map<string, DotLiveState> {
  const states = new Map<string, DotLiveState>();
  for (const dot of mission.dots)
    if (dot.state === 'working' || dot.state === 'needs-input')
      states.set(dot.id, dot.state);
  return states;
}

/** Dot id to what its row shows; Dots with nothing going on and nothing waiting are left out. */
export function liveDots(
  mission: Pick<MissionResponse, 'dots'>,
): Map<string, DotLive> {
  const states = liveStates(mission);
  const live = new Map<string, DotLive>();
  for (const dot of mission.dots) {
    const state = states.get(dot.id);
    const waiting = dot.waiting?.total ?? 0;
    if (state || waiting)
      live.set(dot.id, {
        ...(state ? { state } : {}),
        waiting,
        step: state === 'working' ? (dot.activity?.step ?? null) : null,
      });
  }
  return live;
}

export function useDotLive(): ReadonlyMap<string, DotLive> {
  const [live, setLive] = useState<ReadonlyMap<string, DotLive>>(
    () => new Map(),
  );
  const refresh = useCallback(async () => {
    try {
      setLive(liveDots(await api<MissionResponse>('/mission')));
    } catch {
      // The rows keep their last known state; the next event or poll retries.
    }
  }, []);
  useLiveRefresh(refresh, EVENTS);
  return live;
}
