import { useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api } from '../api';

/**
 * The supervisor's tokens for a server set up by hand: shown once, pasted from an existing
 * supervisor, or replaced. FullDots otherwise sends them only over ssh, on standard input.
 */
export function SupervisorTokens({ alias }: { alias: string }) {
  const [shown, setShown] = useState<{ envFile: string; command: string }>();
  const [confirming, setConfirming] = useState(false);
  const [pasting, setPasting] = useState(false);
  const [supervisorToken, setSupervisorToken] = useState('');
  const [computerToken, setComputerToken] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNote('');
    try {
      await action();
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="cp-docker cp-remote-setup"
      aria-labelledby="tokens-title"
    >
      <h4 id="tokens-title">
        <KeyRound size={14} aria-hidden="true" /> Supervisor tokens for {alias}
      </h4>
      <p>
        Start the supervisor above and you never need these. For a supervisor
        you start by hand, FullDots can show its settings once, or use tokens
        you already have.
      </p>
      {shown ? (
        <div
          className="cp-docker-ask"
          role="group"
          aria-label="Supervisor settings"
        >
          <p>
            Save this as <code>supervisor.env</code> on a machine only you use,
            run the command, then delete the file. It is not shown again.
          </p>
          <pre>
            <code>{shown.envFile}</code>
          </pre>
          <pre>
            <code>{shown.command}</code>
          </pre>
          <button
            type="button"
            className="cp-btn"
            onClick={() => setShown(undefined)}
          >
            Hide
          </button>
        </div>
      ) : confirming ? (
        <div
          className="cp-docker-ask"
          role="alertdialog"
          aria-label="Show the tokens"
        >
          <p>
            These two tokens let anyone who can reach the supervisor or a
            computer on {alias} use them. They are shown once; to see them again
            you make new ones, which stops the old ones.
          </p>
          <div className="cp-docker-buttons">
            <button
              type="button"
              className="cp-btn cp-btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setShown(
                    await api<{ envFile: string; command: string }>(
                      '/computers/remote/tokens/reveal',
                      'POST',
                      { alias },
                    ),
                  );
                  setConfirming(false);
                })
              }
            >
              Show once
            </button>
            <button
              type="button"
              className="cp-btn"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : pasting ? (
        <form
          className="cp-docker-ask"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api('/computers/remote/tokens', 'PUT', {
                alias,
                supervisorToken,
                computerToken,
              });
              setSupervisorToken('');
              setComputerToken('');
              setPasting(false);
              setNote('Saved. FullDots uses these tokens for this server now.');
            });
          }}
        >
          <label className="cp-field">
            <span>SUPERVISOR_TOKEN</span>
            <input
              type="password"
              autoComplete="off"
              value={supervisorToken}
              onChange={(event) => setSupervisorToken(event.target.value)}
            />
          </label>
          <label className="cp-field">
            <span>COMPUTER_TOKEN</span>
            <input
              type="password"
              autoComplete="off"
              value={computerToken}
              onChange={(event) => setComputerToken(event.target.value)}
            />
          </label>
          <div className="cp-docker-buttons">
            <button
              type="submit"
              className="cp-btn cp-btn-primary"
              disabled={busy}
            >
              Save tokens
            </button>
            <button
              type="button"
              className="cp-btn"
              onClick={() => setPasting(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="cp-docker-buttons">
          <button
            type="button"
            className="cp-link"
            onClick={() => setConfirming(true)}
          >
            Show the supervisor settings once
          </button>
          <button
            type="button"
            className="cp-link"
            onClick={() => setPasting(true)}
          >
            Use my own tokens
          </button>
          <button
            type="button"
            className="cp-link"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api('/computers/remote/tokens/reset', 'POST', { alias });
                setNote(
                  'New tokens made. Run Start the supervisor again; computers are replaced on their next start and keep their files.',
                );
              })
            }
          >
            Make new tokens
          </button>
        </div>
      )}
      {note && (
        <p className="cp-hint" role="status">
          {note}
        </p>
      )}
    </section>
  );
}
