import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, Server } from 'lucide-react';
import { api } from '../api';
import type { ComputerStatus } from '../../shared/computer-types';
import type {
  ComputerMoveResult,
  RemoteCheckResult,
  RemoteSetupJob,
  RemoteSetupPlan,
  RemoteSetupStep,
} from '../../shared/remote-computer-types';

const POLL_MS = 1500;
/** The same rule the server applies: a Host from the owner's ssh config, never an option. */
export const ALIAS_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,99}$/;

/** What the server found for a computer on the owner's server, with the step that fixes it. */
export function RemoteCheckNote({ check }: { check?: RemoteCheckResult }) {
  if (!check || check.check === 'ready') return null;
  return (
    <div className="cp-remote-check" role="status">
      <p>{check.message}</p>
      {check.command && (
        <pre>
          <code>{check.command}</code>
        </pre>
      )}
    </div>
  );
}

/** Commands a move left for a server FullDots could not reach. */
export function Leftovers({ commands }: { commands?: string[] }) {
  if (!commands?.length) return null;
  return (
    <div className="cp-remote-check" role="status">
      <p>
        The old server did not answer, so its computer may still be there. Once
        it is back, remove it by hand (its files stay in their volumes):
      </p>
      <pre>
        <code>{commands.join('\n')}</code>
      </pre>
    </div>
  );
}

/** A Dot's own server: blank means the default from Settings → Computers. */
export function ServerField({
  id,
  dotId,
  status,
  disabled,
  onChanged,
}: {
  id: string;
  dotId: string;
  status: ComputerStatus;
  disabled: boolean;
  onChanged: () => void;
}) {
  const own = status.server?.own ? (status.server.alias ?? '') : '';
  const [value, setValue] = useState(own);
  const [note, setNote] = useState('');
  const [leftover, setLeftover] = useState<string[]>();
  const [saving, setSaving] = useState(false);
  useEffect(() => setValue(own), [own]);
  const trimmed = value.trim();
  const valid = !trimmed || ALIAS_PATTERN.test(trimmed);
  const save = async () => {
    setSaving(true);
    setNote('');
    setLeftover(undefined);
    try {
      const result = await api<ComputerMoveResult>(
        `/dots/${encodeURIComponent(dotId)}/computer/server`,
        'PUT',
        { alias: trimmed || null },
      );
      setLeftover(result.leftover);
      setNote(result.moved ? 'Saved.' : 'Nothing changed.');
      onChanged();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };
  const where =
    status.server?.where === 'remote'
      ? `Runs on ${status.server.alias ?? 'your server (no alias set)'}`
      : 'Runs on this machine';
  return (
    <div className="cp-field">
      <label htmlFor={id}>Server (ssh alias)</label>
      <div className="cp-remote-row">
        <input
          id={id}
          type="text"
          value={value}
          placeholder="Default"
          spellCheck={false}
          autoComplete="off"
          aria-describedby={`${id}-help`}
          aria-invalid={!valid}
          disabled={disabled || saving}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="button"
          className="cp-btn"
          disabled={disabled || saving || !valid || trimmed === own}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <p id={`${id}-help`} className="cp-hint">
        {where}. Leave blank to use the default from Settings → Computers. A Dot
        moves only when its computer is gone from the old place.
      </p>
      {!valid && (
        <p className="cp-hint" role="alert">
          Use letters, digits, dot, dash and underscore, not starting with a
          dash.
        </p>
      )}
      {note && (
        <p className="cp-hint" role="status">
          {note}
        </p>
      )}
      <Leftovers commands={leftover} />
    </div>
  );
}

/**
 * "Set up this server": each step shows the exact ssh commands first and runs only after the owner
 * allows it; the server refuses commands that differ. A long build keeps running while the card
 * shows its last line.
 */
export function RemoteSetupCard({ alias }: { alias: string }) {
  const [plans, setPlans] = useState<RemoteSetupPlan[]>([]);
  const [job, setJob] = useState<RemoteSetupJob>();
  const [asking, setAsking] = useState<RemoteSetupStep>();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const result = await api<{
        plans: RemoteSetupPlan[];
        job?: RemoteSetupJob;
      }>(`/computers/remote/setup?alias=${encodeURIComponent(alias)}`);
      setPlans(result.plans);
      setJob(result.job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load.');
    }
  }, [alias]);
  useEffect(() => {
    void load();
  }, [load]);
  const running = job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);
  const asked = plans.find((plan) => plan.step === asking);
  const allow = async (plan: RemoteSetupPlan) => {
    setSending(true);
    setError('');
    try {
      setJob(
        await api<RemoteSetupJob>(
          `/computers/remote/setup/${plan.step}`,
          'POST',
          {
            alias,
            approve: plan.commands,
          },
        ),
      );
      setAsking(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start.');
    } finally {
      setSending(false);
    }
  };
  const lastLine = job?.output.trim().split('\n').at(-1) ?? '';
  return (
    <section
      className="cp-docker cp-remote-setup"
      aria-labelledby="remote-setup-title"
    >
      <h4 id="remote-setup-title">
        <Server size={14} aria-hidden="true" /> Set up {alias}
      </h4>
      <p>
        Run the steps in order. Nothing runs on the server until you allow it.
      </p>
      {asked ? (
        <div className="cp-docker-ask" role="group" aria-label={asked.title}>
          <p>{asked.note}</p>
          <strong>FullDots will run these commands:</strong>
          <pre>
            <code>{asked.commands.join('\n')}</code>
          </pre>
          <div className="cp-docker-buttons">
            <button
              type="button"
              className="cp-btn cp-btn-primary"
              disabled={sending}
              onClick={() => void allow(asked)}
            >
              {sending ? 'Starting…' : 'Allow and run'}
            </button>
            <button
              type="button"
              className="cp-btn"
              disabled={sending}
              onClick={() => setAsking(undefined)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <ol className="cp-remote-steps">
          {plans.map((plan) => (
            <li key={plan.step}>
              <button
                type="button"
                className="cp-link"
                disabled={running}
                onClick={() => {
                  setError('');
                  setAsking(plan.step);
                }}
              >
                {plan.title}
              </button>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="cp-docker-error" role="alert">
          {error}
        </p>
      )}
      {job && job.alias === alias && (
        <div
          className={`cp-docker-job${job.state === 'failed' ? ' is-failed' : ''}`}
          role="status"
          aria-live="polite"
        >
          <p>
            {running && (
              <LoaderCircle className="cp-spin" size={13} aria-hidden="true" />
            )}
            {job.message}
          </p>
          {running && lastLine && (
            <p className="cp-docker-hint">
              <code>{lastLine.slice(0, 160)}</code>
            </p>
          )}
          {job.state === 'failed' && job.output && (
            <details>
              <summary>Technical details</summary>
              <pre>
                <code>{job.output}</code>
              </pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
