import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUpDown,
  Check,
  Copy,
  Download,
  ExternalLink,
  LoaderCircle,
  Pencil,
  Trash2,
} from 'lucide-react';
import { api } from './api';
import { CSV_ROW_LIMIT, parseCsv, sortRows } from './csv';
import { fetchSpaceFile, fileHash, saveBlob } from './space-files-api';
import { TEXT_KINDS, formatBytes, type SpaceFile } from '../shared/space-files';

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; blob: Blob; text?: string };

/** A text file's contents, capped so a huge one cannot freeze the page. */
const TEXT_PREVIEW_CHARS = 2_000_000;

/** Fetches a file's bytes, and its text for the kinds that are shown as text. */
function useFileContent(file: SpaceFile): Loaded {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ state: 'loading' });
    fetchSpaceFile(file.spaceId, file.id, controller.signal)
      .then(async (blob) => {
        const text = TEXT_KINDS.includes(file.kind)
          ? await blob.slice(0, TEXT_PREVIEW_CHARS).text()
          : undefined;
        if (!controller.signal.aborted)
          setLoaded({
            state: 'ready',
            blob,
            ...(text === undefined ? {} : { text }),
          });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoaded({
            state: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load the file.',
          });
      });
    return () => controller.abort();
    // A rename or move does not change the bytes, so only the file itself and its content matter.
  }, [file.spaceId, file.id, file.sha256, file.kind]);
  return loaded;
}

/** A blob address for an image or PDF, released when the viewer goes away. */
function useObjectUrl(blob: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return;
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function CsvTable({ text, tab }: { text: string; tab: boolean }) {
  const parsed = useMemo(() => parseCsv(text, tab ? '\t' : ','), [text, tab]);
  const [sort, setSort] = useState<{
    column: number;
    direction: 'asc' | 'desc';
  }>();
  const [header = [], ...body] = useMemo(() => {
    const [first = [], ...rest] = parsed.rows;
    return [
      first,
      ...(sort ? sortRows(rest, sort.column, sort.direction) : rest),
    ];
  }, [parsed, sort]);
  if (!parsed.rows.length)
    return <p className="file-empty">This file is empty.</p>;
  return (
    <>
      <div className="file-table-wrap">
        <table className="file-table">
          <thead>
            <tr>
              {header.map((cell, column) => (
                <th
                  key={column}
                  aria-sort={
                    sort?.column === column
                      ? sort.direction === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort(
                        sort?.column === column && sort.direction === 'asc'
                          ? { column, direction: 'desc' }
                          : { column, direction: 'asc' },
                      )
                    }
                  >
                    {cell || `Column ${column + 1}`}
                    <ArrowUpDown size={12} aria-hidden="true" />
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((line, index) => (
              <tr key={index}>
                {line.map((cell, column) => (
                  <td key={column}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="file-note">
        {body.length.toLocaleString()} {body.length === 1 ? 'row' : 'rows'}
        {parsed.omitted > 0 &&
          `, and ${parsed.omitted.toLocaleString()} more not shown (the first ${CSV_ROW_LIMIT.toLocaleString()} are). Download the file to see them all.`}
      </p>
    </>
  );
}

function Preview({ file, loaded }: { file: SpaceFile; loaded: Loaded }) {
  const blob = loaded.state === 'ready' ? loaded.blob : undefined;
  const url = useObjectUrl(
    file.kind === 'image' || file.kind === 'pdf' ? blob : undefined,
  );
  if (loaded.state === 'loading')
    return (
      <div className="file-state" role="status">
        <LoaderCircle className="cp-spin" size={20} aria-hidden="true" />{' '}
        Loading…
      </div>
    );
  if (loaded.state === 'error')
    return (
      <div className="file-state" role="alert">
        {loaded.message}
      </div>
    );
  const text = loaded.text ?? '';
  const truncated = (blob?.size ?? 0) > TEXT_PREVIEW_CHARS;
  switch (file.kind) {
    case 'csv':
      return <CsvTable text={text} tab={file.mediaType.includes('tab')} />;
    case 'markdown':
      return (
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
            {text}
          </ReactMarkdown>
        </article>
      );
    case 'json': {
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not valid JSON: shown as it is.
      }
      return (
        <>
          <pre className="file-text">{pretty}</pre>
          {truncated && (
            <p className="file-note">Showing the start of a large file.</p>
          )}
        </>
      );
    }
    case 'text':
      return (
        <>
          <pre className="file-text">{text}</pre>
          {truncated && (
            <p className="file-note">Showing the start of a large file.</p>
          )}
        </>
      );
    case 'image':
      return url ? (
        <div className="file-image">
          <img src={url} alt={file.name} />
        </div>
      ) : null;
    case 'pdf':
      return url ? (
        <iframe className="file-pdf" src={url} title={file.name} />
      ) : null;
    default:
      return (
        <div className="file-state">
          There is no preview for this kind of file. Download it to open it.
        </div>
      );
  }
}

/**
 * One file of a Space, shown by what it is: a table for CSV, rendered Markdown, text, an image or a
 * PDF. Anything else is a download. The bytes are fetched with the owner token and shown from a
 * blob, so nothing in a stored file ever runs.
 */
export function FileViewer({
  file,
  onBack,
  onChanged,
  onDeleted,
}: {
  file: SpaceFile;
  onBack: () => void;
  onChanged: (file: SpaceFile) => void;
  onDeleted: (id: string) => void;
}) {
  const loaded = useFileContent(file);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(file.name);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => setName(file.name), [file.name]);

  const run = async (work: () => Promise<void>) => {
    setError('');
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That did not work.');
    }
  };
  const rename = () =>
    run(async () => {
      if (name.trim() && name !== file.name)
        onChanged(
          await api<SpaceFile>(
            `/spaces/${file.spaceId}/files/${file.id}`,
            'PATCH',
            { name },
          ),
        );
      setRenaming(false);
    });
  const download = () =>
    run(async () =>
      saveBlob(
        loaded.state === 'ready'
          ? loaded.blob
          : await fetchSpaceFile(file.spaceId, file.id),
        file.name,
      ),
    );
  const remove = () =>
    run(async () => {
      if (!window.confirm(`Delete "${file.name}"? This can't be undone.`))
        return;
      await api(`/spaces/${file.spaceId}/files/${file.id}`, 'DELETE');
      onDeleted(file.id);
    });
  const copy = async () => {
    if (loaded.state !== 'ready' || loaded.text === undefined) return;
    await navigator.clipboard?.writeText(loaded.text).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="file-viewer" aria-label={`File ${file.name}`}>
      <header className="file-header">
        <button type="button" className="file-back" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> All pages and files
        </button>
        <div className="file-title">
          {renaming ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void rename();
              }}
            >
              <input
                aria-label="File name"
                value={name}
                maxLength={200}
                autoFocus
                onChange={(event) => setName(event.target.value)}
              />
              <button type="submit" className="document-primary">
                Save
              </button>
              <button type="button" onClick={() => setRenaming(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <>
              <h1>{file.name}</h1>
              <span className="file-meta">
                {formatBytes(file.size)} ·{' '}
                {new Date(file.updatedAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            </>
          )}
        </div>
        <div className="file-actions">
          {TEXT_KINDS.includes(file.kind) && (
            <button
              type="button"
              onClick={() => void copy()}
              disabled={loaded.state !== 'ready'}
            >
              {copied ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <Copy size={15} aria-hidden="true" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          <button type="button" onClick={() => void download()}>
            <Download size={15} aria-hidden="true" /> Download
          </button>
          <a
            className="file-link"
            href={fileHash(file.spaceId, file.id)}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={15} aria-hidden="true" /> New window
          </a>
          <button type="button" onClick={() => setRenaming(true)}>
            <Pencil size={15} aria-hidden="true" /> Rename
          </button>
          <button
            type="button"
            className="file-danger"
            onClick={() => void remove()}
          >
            <Trash2 size={15} aria-hidden="true" /> Delete
          </button>
        </div>
      </header>
      {error && (
        <div className="document-load-error" role="alert">
          {error}
        </div>
      )}
      <div className="file-body">
        <Preview file={file} loaded={loaded} />
      </div>
    </section>
  );
}
