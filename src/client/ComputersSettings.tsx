import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import type {
  ComputerMoveResult,
  ComputerWhere,
  RemoteCheckResult,
  RemoteComputersStatus,
} from '../shared/remote-computer-types';
import { SupervisorTokens } from './computer-panel/SupervisorTokens';
import {
  ALIAS_PATTERN,
  Leftovers,
  RemoteCheckNote,
  RemoteSetupCard,
} from './computer-panel/RemoteServer';

const GUIDE_URL =
  'https://github.com/asasemahmed/FullDots/blob/main/docs/REMOTE-COMPUTERS.md';

/**
 * Settings → Computers: where Dot computers run. "Your server" takes only the name of a Host from
 * the owner's own ssh config; FullDots never asks for a key, a password or a passphrase.
 */
export function ComputersSettings() {
  const [status, setStatus] = useState<RemoteComputersStatus>();
  const [where, setWhere] = useState<ComputerWhere>('local');
  const [alias, setAlias] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [leftover, setLeftover] = useState<string[]>();
  const [check, setCheck] = useState<RemoteCheckResult>();
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api<RemoteComputersStatus>('/computers/remote');
      setStatus(next);
      setWhere(next.where);
      setAlias(next.alias ?? '');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not load.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const trimmed = alias.trim();
  const valid = ALIAS_PATTERN.test(trimmed);
  const changed =
    !!status &&
    (where !== status.where ||
      (where === 'remote' && trimmed !== (status.alias ?? '')));
  const saved = !!status && status.where === 'remote' && !!status.alias;

  const save = async () => {
    setSaving(true);
    setMessage('');
    setLeftover(undefined);
    setCheck(undefined);
    try {
      const result = await api<ComputerMoveResult>('/computers/remote', 'PUT', {
        where,
        ...(where === 'remote' || trimmed ? { alias: trimmed } : {}),
      });
      setLeftover(result.leftover);
      setMessage('Saved.');
      await load();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const runCheck = async () => {
    if (!status?.alias) return;
    setChecking(true);
    try {
      setCheck(
        await api<RemoteCheckResult>('/computers/remote/check', 'POST', {
          alias: status.alias,
        }),
      );
    } catch (cause) {
      setCheck({
        alias: status.alias,
        check: 'ssh_failed',
        message: cause instanceof Error ? cause.message : 'Could not check.',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <section
      className="cp-remote-settings"
      aria-labelledby="computers-where-title"
    >
      <h3 id="computers-where-title">Where computers run</h3>
      <p className="cp-hint">
        Each Dot’s computer is a Docker container. It can run on this machine,
        or on a Linux server you own that FullDots reaches over ssh. With your
        server, nothing on it is reachable except ssh.{' '}
        <a href={GUIDE_URL} target="_blank" rel="noreferrer">
          How it works
        </a>
      </p>
      <fieldset className="cp-remote-where">
        <legend className="sr-only">Where computers run</legend>
        <label className="permission-row">
          <input
            type="radio"
            name="computers-where"
            value="local"
            checked={where === 'local'}
            onChange={() => setWhere('local')}
          />
          <span>
            <strong>This machine</strong>
            <small>Docker on the computer FullDots runs on. The default.</small>
          </span>
        </label>
        <label className="permission-row">
          <input
            type="radio"
            name="computers-where"
            value="remote"
            checked={where === 'remote'}
            onChange={() => setWhere('remote')}
          />
          <span>
            <strong>Your server (SSH)</strong>
            <small>
              A Linux server you own, reached only over ssh. FullDots stays
              here.
            </small>
          </span>
        </label>
      </fieldset>
      {where === 'remote' && (
        <div className="cp-field">
          <label htmlFor="computers-alias">ssh alias</label>
          <input
            id="computers-alias"
            type="text"
            value={alias}
            placeholder="my-vps"
            spellCheck={false}
            autoComplete="off"
            aria-describedby="computers-alias-help"
            aria-invalid={!!trimmed && !valid}
            onChange={(event) => setAlias(event.target.value)}
          />
          <p id="computers-alias-help" className="cp-hint">
            The name of a Host in your own ssh config, nothing else. FullDots
            never asks for or stores a key, password or passphrase. Run{' '}
            <code>ssh {trimmed || 'my-vps'} true</code> once in a terminal first
            to check the host key yourself.
          </p>
          {!!trimmed && !valid && (
            <p className="cp-hint" role="alert">
              Use letters, digits, dot, dash and underscore, not starting with a
              dash.
            </p>
          )}
        </div>
      )}
      <div className="cp-actions">
        <button
          type="button"
          className="cp-btn cp-btn-primary"
          disabled={!changed || saving || (where === 'remote' && !valid)}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && status?.where === 'remote' && (
          <button
            type="button"
            className="cp-btn"
            disabled={checking}
            onClick={() => void runCheck()}
          >
            {checking ? 'Checking…' : 'Check the server'}
          </button>
        )}
      </div>
      {message && (
        <p className="cp-hint" role="status">
          {message}
        </p>
      )}
      <Leftovers commands={leftover} />
      {check &&
        (check.check === 'ready' ? (
          <p className="cp-hint" role="status">
            {check.message}
          </p>
        ) : (
          <RemoteCheckNote check={check} />
        ))}
      {saved && status?.alias && status.enabled && (
        <RemoteSetupCard alias={status.alias} />
      )}
      {saved && status?.alias && <SupervisorTokens alias={status.alias} />}
      {saved && status && !status.enabled && (
        <p className="cp-hint">
          Setting up a server from here works only where FullDots runs on your
          own machine from a checkout. Follow the guide to set it up by hand.
        </p>
      )}
    </section>
  );
}
