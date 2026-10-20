import { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, Pencil } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api } from './api';
import { openPageLink } from './page-navigation';
import type { Page } from '../server/pages';

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; page: Page };

/** How often an open page is read again, so an edit the Dot makes shows up without reopening it. */
const REFRESH_MS = 3000;

/**
 * A page a Dot wrote, previewed beside the chat. Editing happens in the Space, one click away, so
 * there is one editor and no second copy to save.
 */
export function PagePane({
  spaceId,
  pageId,
}: {
  spaceId: string;
  pageId: string;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  useEffect(() => {
    let current = true;
    setState({ phase: 'loading' });
    const load = async () => {
      try {
        const page = await api<Page>(`/spaces/${spaceId}/pages/${pageId}`);
        if (current) setState({ phase: 'ready', page });
      } catch (error) {
        if (current)
          setState((previous) =>
            previous.phase === 'ready'
              ? previous
              : {
                  phase: 'error',
                  message:
                    error instanceof Error
                      ? error.message
                      : 'Could not load the page.',
                },
          );
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [spaceId, pageId]);

  if (state.phase === 'loading')
    return (
      <div className="file-state" role="status">
        <LoaderCircle className="cp-spin" size={20} aria-hidden="true" />{' '}
        Loading…
      </div>
    );
  if (state.phase === 'error')
    return (
      <div className="file-state" role="alert">
        {state.message}
      </div>
    );
  const { page } = state;
  const hash = `#/spaces/${spaceId}/pages/${pageId}`;
  return (
    <section className="file-viewer is-pane" aria-label={`Page ${page.title}`}>
      <header className="file-header">
        <div className="file-title">
          <h1>{page.title || 'Untitled page'}</h1>
          <span className="file-meta">
            Edited{' '}
            {new Date(page.updatedAt).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })}
          </span>
        </div>
        <div className="file-actions">
          <button type="button" onClick={() => openPageLink(hash)}>
            <Pencil size={15} aria-hidden="true" /> Open and edit
          </button>
          <a className="file-link" href={hash} target="_blank" rel="noreferrer">
            <ExternalLink size={15} aria-hidden="true" /> New window
          </a>
        </div>
      </header>
      <div className="file-body">
        {page.content.trim() ? (
          <article className="file-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ alt }) => <span>{alt}</span>,
                a: ({ href, children }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {page.content}
            </ReactMarkdown>
          </article>
        ) : (
          <p className="file-empty">This page is empty.</p>
        )}
      </div>
    </section>
  );
}
