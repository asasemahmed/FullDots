import { useEffect, useState } from 'react';
import { api } from './api';

interface ConnectedApp {
  id: string;
  toolkit: string;
  status: string;
}

/** Apps connected for the owner. The list is the slug and status only. */
export function ComposioAccounts() {
  const [accounts, setAccounts] = useState<ConnectedApp[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');

  useEffect(() => {
    let live = true;
    api<{ accounts: ConnectedApp[] }>('/composio/accounts')
      .then((data) => {
        if (live) setAccounts(data.accounts);
      })
      .catch(() => {
        if (live) setError('Could not load connected apps.');
      });
    return () => {
      live = false;
    };
  }, []);

  const disconnect = async (id: string) => {
    setPending(id);
    setError('');
    try {
      await api(`/composio/accounts/${encodeURIComponent(id)}`, 'DELETE');
      setAccounts(
        (current) => current?.filter((account) => account.id !== id) ?? null,
      );
    } catch {
      setError(
        'Could not disconnect that app. A key you typed still works at the app until you rotate it there.',
      );
    } finally {
      setPending('');
    }
  };

  return (
    <div className="config-note">
      <strong>Apps connected for you</strong>
      {error ? <p>{error}</p> : null}
      {accounts && accounts.length === 0 ? <p>No apps connected yet.</p> : null}
      {accounts?.map((account) => (
        <p key={account.id}>
          {account.toolkit} · {account.status}{' '}
          <button
            type="button"
            className="mp-linkbtn"
            disabled={pending === account.id}
            onClick={() => void disconnect(account.id)}
          >
            Disconnect
          </button>
        </p>
      ))}
      <p>
        Disconnecting removes the app from Composio. A key you typed still works
        at the app until you rotate it there.
      </p>
    </div>
  );
}
