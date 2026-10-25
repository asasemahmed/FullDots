import { useId, useReducer, useRef, useState } from 'react';
import { LoaderCircle, Search } from 'lucide-react';
import { api } from './api';
import { LOCAL_PROGRAMS_DOCS_URL, registryAddPlan } from './registry-connector';
import type { ConnectorDraft } from './ConnectorSheet';
import type { RegistrySearchResult, RegistryServer } from '../shared/registry';

export const REGISTRY_HOST = 'registry.modelcontextprotocol.io';

/** Remote and Local program badges, from the server's endpoints and packages. */
export function registryBadges(server: RegistryServer): string[] {
  const badges: string[] = [];
  if (server.remotes.length) badges.push('Remote');
  if (server.packages.length) badges.push('Local program');
  return badges;
}

export const registryTitle = (server: RegistryServer): string =>
  server.title || server.name;

export interface DiscoverState {
  /** The text the current results answer. */
  query: string;
  servers: RegistryServer[];
  nextCursor?: string;
  phase: 'idle' | 'searching' | 'loading-more' | 'done' | 'error';
  error?: string;
}

export type DiscoverAction =
  | { type: 'search'; query: string }
  | { type: 'more' }
  | { type: 'result'; result: RegistrySearchResult; append: boolean }
  | { type: 'fail'; message: string };

export const initialDiscover: DiscoverState = {
  query: '',
  servers: [],
  phase: 'idle',
};

/** A new search clears the list; "Load more" adds the next page to it. */
export function discoverReducer(
  state: DiscoverState,
  action: DiscoverAction,
): DiscoverState {
  switch (action.type) {
    case 'search':
      return { query: action.query, servers: [], phase: 'searching' };
    case 'more':
      return { ...state, phase: 'loading-more', error: undefined };
    case 'result': {
      const next: DiscoverState = {
        query: state.query,
        servers: action.append
          ? [...state.servers, ...action.result.servers]
          : action.result.servers,
        phase: 'done',
      };
      if (action.result.nextCursor) next.nextCursor = action.result.nextCursor;
      return next;
    }
    case 'fail':
      return { ...state, phase: 'error', error: action.message };
  }
}

/**
 * The Add control for one result. Its only action is `onAdd`, which opens the
 * connector form; nothing is saved or connected until the owner presses Save there.
 */
export function AddAction({
  server,
  allowStdio,
  onAdd,
}: {
  server: RegistryServer;
  allowStdio: boolean;
  onAdd: (draft: ConnectorDraft) => void;
}) {
  const plan = registryAddPlan(server, allowStdio);
  if (plan.kind === 'draft')
    return (
      <div className="cg-registry-action">
        <button
          type="button"
          className="cs-btn cs-btn-primary"
          onClick={() => onAdd(plan.draft)}
        >
          Add
        </button>
        <span className="cs-muted">
          Opens the connector form to review. Nothing is saved or connected
          until you press Save.
        </span>
      </div>
    );
  if (plan.kind === 'local-off')
    return (
      <div className="cg-registry-action">
        <button type="button" className="cs-btn" disabled>
          Add
        </button>
        <span className="cg-card-note">
          {plan.reason}{' '}
          <a
            className="cs-link"
            href={LOCAL_PROGRAMS_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            Read the docs
          </a>
        </span>
      </div>
    );
  return <p className="cg-card-note">{plan.reason}</p>;
}

export function RegistryCard({
  server,
  allowStdio = false,
  onAdd,
}: {
  server: RegistryServer;
  allowStdio?: boolean;
  onAdd?: ((draft: ConnectorDraft) => void) | undefined;
}) {
  const title = registryTitle(server);
  return (
    <li className="cg-card" data-registry={server.name}>
      <div className="cg-card-head">
        <div className="cg-card-id">
          <p className="cg-registry-name">{title}</p>
          <span className="cg-sub" title={server.name}>
            {server.name}
          </span>
        </div>
      </div>
      <p className="cg-desc">{server.description}</p>
      <div className="cg-card-foot">
        {registryBadges(server).map((badge) => (
          <span className="cg-chip" key={badge}>
            {badge}
          </span>
        ))}
        <span className="cg-count">v{server.version}</span>
        {server.repository && (
          <a
            className="cs-link cg-registry-link"
            href={server.repository.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            Repository
          </a>
        )}
      </div>
      {onAdd && (
        <AddAction server={server} allowStdio={allowStdio} onAdd={onAdd} />
      )}
    </li>
  );
}

/** Settings > Connectors > Discover: search the public MCP registry. Read-only; nothing is installed. */
export function RegistryDiscover({
  enabled,
  allowStdio = false,
  onAdd,
}: {
  enabled: boolean;
  /** CONNECTORS_ALLOW_STDIO: whether a local program can be added from here. */
  allowStdio?: boolean;
  /** Opens the connector form for a result. Without it, results have no Add control. */
  onAdd?: ((draft: ConnectorDraft) => void) | undefined;
}) {
  const [text, setText] = useState('');
  const [state, dispatch] = useReducer(discoverReducer, initialDiscover);
  const latest = useRef(0);
  const inputId = useId();

  const request = (query: string, cursor?: string) => {
    const id = ++latest.current;
    const params = new URLSearchParams({ q: query });
    if (cursor) params.set('cursor', cursor);
    api<RegistrySearchResult>(`/connectors/registry/search?${params}`)
      .then((result) => {
        if (id === latest.current)
          dispatch({ type: 'result', result, append: !!cursor });
      })
      .catch((error: unknown) => {
        if (id === latest.current)
          dispatch({
            type: 'fail',
            message:
              error instanceof Error
                ? error.message
                : 'Could not search the registry.',
          });
      });
  };

  // Not a <form>: this sits inside the Settings dialog's form, and a nested form's submit
  // reloads the page (or saves and closes Settings) instead of searching.
  const submit = () => {
    const query = text.trim();
    if (!query) return;
    dispatch({ type: 'search', query });
    request(query);
  };

  const more = () => {
    if (!state.nextCursor) return;
    dispatch({ type: 'more' });
    request(state.query, state.nextCursor);
  };

  if (!enabled)
    return (
      <section className="cg-section" aria-labelledby={`${inputId}-title`}>
        <h4 className="cg-heading" id={`${inputId}-title`}>
          Discover servers
        </h4>
        <p className="cg-note" role="note">
          Searching the public MCP registry is off. To turn it on, set
          CONNECTORS_REGISTRY_SEARCH=true in the server&apos;s .env file and
          restart FullDots. Each search sends the text you type to{' '}
          {REGISTRY_HOST}.
        </p>
      </section>
    );

  const busy = state.phase === 'searching' || state.phase === 'loading-more';
  return (
    <section className="cg-section" aria-labelledby={`${inputId}-title`}>
      <h4 className="cg-heading" id={`${inputId}-title`}>
        Discover servers
      </h4>
      <p className="cs-muted">
        Search the public MCP registry by server name. Each search sends the
        text you type to {REGISTRY_HOST}. Add opens a server as a connector for
        you to review; nothing is saved until you choose Save.
      </p>
      <div className="cg-discover-form" role="search">
        <div className="cg-search">
          <Search size={15} aria-hidden="true" />
          <input
            id={inputId}
            type="search"
            value={text}
            maxLength={100}
            placeholder="Search by server name"
            aria-label="Search the MCP registry by server name"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              submit();
            }}
          />
        </div>
        <button
          type="button"
          className="cs-btn cs-btn-primary"
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          Search
        </button>
      </div>

      {state.phase === 'idle' && (
        <p className="cg-lead">
          Search for a server by name, for example a service you use.
        </p>
      )}
      {state.phase === 'searching' && (
        <p className="cg-loading" role="status">
          <LoaderCircle size={14} className="cx-spin" aria-hidden="true" />
          Searching the registry…
        </p>
      )}
      {state.phase === 'error' && (
        <div className="cg-error" role="alert">
          <span>{state.error}</span>
        </div>
      )}
      {state.phase !== 'idle' &&
        state.phase !== 'searching' &&
        state.servers.length === 0 &&
        state.phase !== 'error' && (
          <p className="cg-empty">
            No server has a name matching &ldquo;{state.query}&rdquo;. The
            registry matches part of a server name, not its description.
          </p>
        )}
      {state.servers.length > 0 && (
        <ul className="cg-grid" aria-label="Registry results">
          {state.servers.map((server) => (
            <RegistryCard
              key={server.name}
              server={server}
              allowStdio={allowStdio}
              {...(onAdd ? { onAdd } : {})}
            />
          ))}
        </ul>
      )}
      {state.nextCursor && (
        <div className="cg-discover-more">
          <button
            type="button"
            className="cs-btn"
            disabled={busy}
            onClick={more}
          >
            {state.phase === 'loading-more' ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </section>
  );
}
