import { useEffect, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpRight,
  BookOpen,
  ExternalLink,
  FileText,
  Monitor,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Dot, Result, Status } from '../shared/types';
import { Mascot, dotLook } from './Mascot';
import { ComputerPanel } from './ComputerPanel';
import { FilePane } from './FilePane';
import { PagePane } from './PagePane';
import type { PaneItem } from './chat-turns';
export function ResultPane({
  latest,
  status,
  dotState,
  onClose,
  dots,
  defaultDotId,
  threadId,
  item,
}: {
  dots: Dot[];
  defaultDotId: string;
  /** The open conversation, for the computer's Replay tab. */
  threadId?: string;
  /** A file or page the owner opened from the chat; it gets its own tab and is shown first. */
  item?: PaneItem;
  latest?: Result | null;
  status?: Status;
  dotState: string;
  onClose: () => void;
}) {
  const [resultTab, setResultTab] = useState<'Brief' | 'Computer' | 'Item'>(
    item ? 'Item' : 'Computer',
  );
  // Opening another file or page from the chat brings its tab forward.
  useEffect(() => {
    if (item) setResultTab('Item');
  }, [item?.type, item?.spaceId, item?.id]);
  const [computerDotId, setComputerDotId] = useState(defaultDotId);
  const computerDot =
    dots.find((dot) => dot.id === computerDotId) ??
    dots.find((dot) => dot.id === defaultDotId) ??
    dots[0];
  return (
    <aside className="result-pane">
      <div className="pane-header">
        <div className="pane-tabs">
          <button
            className={resultTab === 'Brief' ? 'selected' : ''}
            onClick={() => setResultTab('Brief')}
          >
            <BookOpen size={15} />
            Brief
          </button>
          {item && (
            <button
              className={resultTab === 'Item' ? 'selected' : ''}
              onClick={() => setResultTab('Item')}
            >
              <FileText size={15} /> {item.type === 'page' ? 'Page' : 'File'}
            </button>
          )}
          <button
            className={resultTab === 'Computer' ? 'selected' : ''}
            onClick={() => setResultTab('Computer')}
          >
            <Monitor size={15} /> {computerDot?.name ?? 'Dot'}’s computer
          </button>
        </div>
        <button
          className="icon-button"
          aria-label="Close result panel"
          onClick={() => onClose()}
        >
          <X size={16} />
        </button>
      </div>
      {resultTab === 'Item' && item ? (
        item.type === 'page' ? (
          <PagePane spaceId={item.spaceId} pageId={item.id} />
        ) : (
          <FilePane spaceId={item.spaceId} fileId={item.id} />
        )
      ) : resultTab === 'Computer' ? (
        <>
          {computerDot ? (
            <ComputerPanel
              key={computerDot.id}
              dot={computerDot}
              dots={dots}
              onSelectDot={setComputerDotId}
              threadId={threadId}
            />
          ) : (
            <p className="computer-panel">
              Create a Dot to give it a computer.
            </p>
          )}
        </>
      ) : latest ? (
        <div className="result-content">
          <div className="result-meta">
            <span className="eyebrow">
              {latest.sample ? 'FICTIONAL SAMPLE BRIEF' : 'RESEARCH BRIEF'}
            </span>
            <button
              className="icon-button"
              aria-label="Download brief"
              onClick={() => {
                const blob = new Blob(
                  [
                    latest.text +
                      '\n\nSources\n' +
                      latest.sources
                        .map((s) => `${s.title}: ${s.url}`)
                        .join('\n'),
                  ],
                  { type: 'text/plain' },
                );
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = 'opendots-brief.txt';
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              <ArrowDownToLine size={16} />
            </button>
          </div>
          {latest.sample && (
            <div className="sample-note">
              An example of what Dot can do. The findings and sources below are
              invented.
            </div>
          )}
          <article className="brief">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                img: ({ alt }) => (
                  <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>
                ),
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {latest.text}
            </ReactMarkdown>
          </article>
          <section className="sources">
            <h3>
              Source notes <span>{latest.sources.length}</span>
            </h3>
            {latest.sources.map((source) =>
              latest.sample ? (
                <div className="source-card" key={source.url}>
                  <span className="source-icon">
                    <BookOpen size={15} />
                  </span>
                  <div>
                    <strong>{source.title}</strong>
                    <p>{source.excerpt}</p>
                    <small>Fictional source · not a live link</small>
                  </div>
                </div>
              ) : (
                <a
                  className="source-card"
                  href={source.url}
                  key={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="source-icon">
                    <ExternalLink size={15} />
                  </span>
                  <div>
                    <strong>{source.title}</strong>
                    <p>{source.excerpt}</p>
                    <small>{new URL(source.url).hostname}</small>
                  </div>
                  <ArrowUpRight size={15} />
                </a>
              ),
            )}
          </section>
        </div>
      ) : (
        <div className="pane-empty">
          <Mascot
            hero
            identity={defaultDotId}
            {...dotLook(dots.find((dot) => dot.id === defaultDotId))}
            name={dots.find((dot) => dot.id === defaultDotId)?.name}
            state={dotState}
          />
          <h3>A little space for your findings.</h3>
          <p>
            {status === 'failed'
              ? 'Resolve the error and retry to create a research brief.'
              : 'Your brief and sources will appear here after a successful run.'}
          </p>
        </div>
      )}
    </aside>
  );
}
