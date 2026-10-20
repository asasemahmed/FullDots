// The team page (#/team/<id>): the team orbiting in its colour, who does what, how it works, its
// recent chats and runs (with their run log pages), its home Space, and "Start team chat".
import { useCallback, useEffect, useState } from 'react';
import {
  Archive,
  Crown,
  FileText,
  FolderPlus,
  MessageSquarePlus,
  MessagesSquare,
  Pencil,
  ShieldCheck,
  Square,
} from 'lucide-react';
import {
  TEAM_MODE_LABELS,
  TEAM_STYLE_LABELS,
  type Team,
  type TeamDetail,
  type TeamRun,
} from '../../shared/teams';
import type { Dot } from '../../shared/types';
import { api } from '../api';
import { Mascot, dotLook } from '../Mascot';
import { useLiveRefresh } from '../live-refresh';
import { StyleDiagram } from './StyleDiagram';
import { TeamOrbit } from './TeamCharacters';
import { TEAM_REFRESH_EVENTS } from './useTeams';
import './teams.css';

const RUN_STATUS: Record<TeamRun['status'], string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Did not finish',
  cancelled: 'Stopped by you',
};

const when = (ms: number) =>
  new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** What the reviewer of a review run said, for the run's row. */
const verdictText = (run: TeamRun, reviewer: string) =>
  !run.reviewerDotId || run.verdict === null
    ? ''
    : run.verdict === 'changes'
      ? `${reviewer} still asked for changes`
      : `Checked by ${reviewer}${run.sentBack ? ' after one send-back' : ''}`;

const openHash = (hash: string) => {
  location.hash = hash;
};

const duration = (run: TeamRun) => {
  if (run.finishedAt === null) return '';
  const seconds = Math.max(
    1,
    Math.round((run.finishedAt - run.createdAt) / 1000),
  );
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
};

export function TeamPage({
  teamId,
  dots,
  working,
  initial,
  onStartChat,
  onEdit,
  onArchive,
  onOpenThread,
}: {
  teamId: string;
  dots: Dot[];
  working?: ReadonlySet<string>;
  /** First render (tests, or a list that already has it). */
  initial?: TeamDetail;
  onStartChat: (team: Team) => void;
  onEdit: (team: Team) => void;
  onArchive: (team: Team) => void;
  onOpenThread: (threadId: string) => void;
}) {
  const [team, setTeam] = useState<TeamDetail | undefined>(initial);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setTeam(await api<TeamDetail>(`/teams/${teamId}`));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the team.');
    }
  }, [teamId]);
  useEffect(() => {
    if (initial?.id !== teamId) setTeam(undefined);
  }, [teamId, initial]);
  useLiveRefresh(load, TEAM_REFRESH_EVENTS);

  if (!team)
    return (
      <main className="main-content team-page">
        {error ? (
          <p className="chat-error" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">Gathering the team…</p>
        )}
      </main>
    );

  const name = (id: string) =>
    dots.find((dot) => dot.id === id)?.name ?? 'A removed Dot';
  const look = (id: string) => dotLook(dots.find((dot) => dot.id === id));
  const memberIds = team.members.map((member) => member.dotId);
  const busy = [team.leadDotId, ...memberIds].some((id) => working?.has(id));
  const createSpace = async () => {
    try {
      await api(`/teams/${team.id}/space`, 'POST', {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the space.');
    }
  };
  const stop = async (run: TeamRun) => {
    try {
      await api(`/teams/runs/${run.id}/cancel`, 'POST', {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not stop the run.');
    }
  };

  return (
    <main
      className="main-content team-page"
      style={
        {
          '--team-color': `var(--dot-${team.color}-base)`,
          '--team-light': `var(--dot-${team.color}-light)`,
        } as never
      }
      aria-labelledby="team-page-title"
    >
      <header className="tp-hero">
        <div className="tp-hero-stage">
          <TeamOrbit
            leadDotId={team.leadDotId}
            memberIds={memberIds}
            dots={dots}
            size="lg"
            working={working}
            label={`${team.name}: ${name(team.leadDotId)} leads${memberIds.length ? ` with ${memberIds.map(name).join(', ')}` : ''}.`}
          />
        </div>
        <div className="tp-hero-text">
          <span className="eyebrow">
            TEAM{busy ? ' · WORKING NOW' : ''}
            {team.archivedAt ? ' · ARCHIVED' : ''}
          </span>
          <h1 id="team-page-title">
            <span className="tp-emoji" aria-hidden>
              {team.emoji}
            </span>
            {team.name}
          </h1>
          {team.description && <p>{team.description}</p>}
          <ul className="tp-chips" aria-label="How this team works">
            <li>
              <StyleDiagram style={team.style} color={team.color} />
              {TEAM_STYLE_LABELS[team.style]}
            </li>
            <li>
              {TEAM_MODE_LABELS[team.mode]}
              {team.mode === 'direct' && team.summarize
                ? ' · lead summarises'
                : ''}
            </li>
            <li>{memberIds.length + 1} Dots</li>
            {team.style === 'review' && team.reviewerDotId && (
              <li>
                <ShieldCheck size={13} aria-hidden /> {name(team.reviewerDotId)}{' '}
                reviews
              </li>
            )}
          </ul>
          <div className="tp-actions">
            <button
              type="button"
              className="primary"
              disabled={!!team.archivedAt}
              onClick={() => onStartChat(team)}
            >
              <MessageSquarePlus size={15} aria-hidden />
              Start team chat
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!!team.archivedAt}
              onClick={() => onEdit(team)}
            >
              <Pencil size={15} aria-hidden />
              Edit
            </button>
            {team.spaceId ? (
              <button
                type="button"
                className="secondary"
                onClick={() => openHash(`#/spaces/${team.spaceId}`)}
              >
                <FileText size={15} aria-hidden />
                Team space
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={!!team.archivedAt}
                onClick={() => void createSpace()}
              >
                <FolderPlus size={15} aria-hidden />
                Create space
              </button>
            )}
            <button
              type="button"
              className="secondary"
              disabled={!!team.archivedAt}
              onClick={() => onArchive(team)}
            >
              <Archive size={15} aria-hidden />
              Archive
            </button>
          </div>
        </div>
      </header>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}

      <div className="tp-grid">
        <section className="tp-card" aria-labelledby="tp-members">
          <h2 id="tp-members">Who does what</h2>
          <ul className="tp-members">
            <li className="tp-member lead">
              <span className="tp-face">
                <Mascot
                  identity={team.leadDotId}
                  {...look(team.leadDotId)}
                  name={name(team.leadDotId)}
                  small
                  decorative
                  state={working?.has(team.leadDotId) ? 'working' : 'idle'}
                />
              </span>
              <span className="tp-member-text">
                <strong>
                  <Crown size={13} aria-hidden /> {name(team.leadDotId)}
                </strong>
                <small>Lead · talks with you and plans the work</small>
              </span>
            </li>
            {team.members.map((member, index) => (
              <li className="tp-member" key={member.dotId}>
                <span className="tp-face">
                  <Mascot
                    identity={member.dotId}
                    {...look(member.dotId)}
                    name={name(member.dotId)}
                    small
                    decorative
                    state={working?.has(member.dotId) ? 'working' : 'idle'}
                  />
                </span>
                <span className="tp-member-text">
                  <strong>
                    {team.style === 'sequential' && (
                      <span className="tp-step">{index + 1}</span>
                    )}
                    {name(member.dotId)}
                  </strong>
                  <small>{member.role || 'No role yet'}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section className="tp-card" aria-labelledby="tp-chats">
          <h2 id="tp-chats">Recent team chats</h2>
          {team.conversations.length ? (
            <ul className="tp-list">
              {team.conversations.map((chat) => (
                <li key={chat.id}>
                  <button
                    type="button"
                    className="tp-link"
                    onClick={() => onOpenThread(chat.id)}
                  >
                    <MessagesSquare size={15} aria-hidden />
                    <span>{chat.title}</span>
                    <small>{when(chat.createdAt)}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              No team chats yet. Start one and {name(team.leadDotId)} brings the
              others in.
            </p>
          )}
        </section>

        <section className="tp-card" aria-labelledby="tp-runs">
          <h2 id="tp-runs">Recent runs</h2>
          {team.runs.length ? (
            <ul className="tp-list">
              {team.runs.map((run) => (
                <li key={run.id} className="tp-run" data-status={run.status}>
                  <span className={`tp-run-dot ${run.status}`} aria-hidden />
                  <span className="tp-run-text">
                    <strong>{RUN_STATUS[run.status]}</strong>
                    <small>
                      {TEAM_STYLE_LABELS[run.style]} · {when(run.createdAt)}
                      {duration(run) ? ` · ${duration(run)}` : ''}
                      {verdictText(run, name(run.reviewerDotId ?? ''))
                        ? ` · ${verdictText(run, name(run.reviewerDotId ?? ''))}`
                        : ''}
                    </small>
                  </span>
                  {run.log && (
                    <button
                      type="button"
                      className="tp-link compact"
                      onClick={() =>
                        openHash(
                          `#/spaces/${run.log!.spaceId}/pages/${run.log!.pageId}`,
                        )
                      }
                    >
                      <FileText size={13} aria-hidden /> Run log
                    </button>
                  )}
                  <button
                    type="button"
                    className="tp-link compact"
                    onClick={() => onOpenThread(run.threadId)}
                  >
                    Open chat
                  </button>
                  {run.status === 'running' && (
                    <button
                      type="button"
                      className="tp-link compact danger"
                      onClick={() => void stop(run)}
                    >
                      <Square size={12} aria-hidden /> Stop
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              Runs appear here once the team gets to work.
            </p>
          )}
        </section>
      </div>
    </main>
  );
}
