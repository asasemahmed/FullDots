import { useMemo, useRef, useState } from 'react';
import {
  FileText,
  Plus,
  Search,
  LayoutGrid,
  List,
  ArrowUpRight,
  Upload,
} from 'lucide-react';
import type { SpaceFile } from '../shared/space-files';
import { formatBytes } from '../shared/space-files';
import { FileKindIcon } from './file-icons';
import type { Page } from '../server/pages';
import type { Space } from '../shared/types';
export function pageExcerpt(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/```[\s\S]*?```/g, 'Code block')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}
export function SpaceLibrary({
  space,
  pages,
  files,
  onPage,
  onFile,
  onUpload,
  onNew,
}: {
  space: Space;
  pages: Page[];
  files: SpaceFile[];
  onPage: (id: string) => void;
  onFile: (id: string) => void;
  onUpload: (files: File[]) => void;
  onNew: () => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const filtered = useMemo(
    () =>
      pages
        .filter((page) =>
          `${page.title} ${page.content}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title)
            : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
        ),
    [pages, query, sort],
  );
  const matchingFiles = useMemo(
    () =>
      files
        .filter((file) =>
          file.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
        )
        .sort(
          (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
        ),
    [files, query],
  );
  return (
    <section
      className={`space-library${dragging ? ' is-dragging' : ''}`}
      aria-label={`${space.name} page library`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length)
          onUpload(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="library-heading">
        <div>
          <span className="library-eyebrow">SPACE</span>
          <h1>{space.name}</h1>
          {space.description && <p>{space.description}</p>}
        </div>
        <div className="library-actions">
          <button
            type="button"
            className="document-secondary"
            onClick={() => picker.current?.click()}
          >
            <Upload size={16} /> Upload files
          </button>
          <button className="document-primary" onClick={onNew}>
            <Plus size={17} /> New page
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose files to upload"
            onChange={(event) => {
              if (event.target.files?.length)
                onUpload(Array.from(event.target.files));
              event.target.value = '';
            }}
          />
        </div>
      </header>
      <div className="library-tools">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label="Search pages and files"
            placeholder="Search pages and files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="library-sort">
          <span className="sr-only">Sort pages</span>
          <select
            aria-label="Sort pages"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recently edited</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
        <div
          className="library-view-toggle"
          role="group"
          aria-label="Library view"
        >
          <button
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>
      <div className="library-section-label">
        <h2>{query ? 'Search results' : 'All pages'}</h2>
        <span>
          {filtered.length} {filtered.length === 1 ? 'page' : 'pages'}
        </span>
      </div>
      {filtered.length ? (
        <div className={`library-pages ${layout}`}>
          {filtered.map((page) => (
            <button
              className="library-page-card"
              key={page.id}
              onClick={() => onPage(page.id)}
            >
              <span className="library-page-icon">
                <FileText size={20} strokeWidth={1.5} />
              </span>
              <div className="library-card-body">
                <h3>{page.title}</h3>
                <p>
                  {pageExcerpt(page.content) ||
                    'An empty page, ready to write.'}
                </p>
                <div className="library-page-meta">
                  <span title={new Date(page.updatedAt).toLocaleString()}>
                    Edited{' '}
                    {new Date(page.updatedAt).toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })}
                  </span>
                  {page.parentId && (
                    <span className="library-parent">
                      {
                        pages.find((parent) => parent.id === page.parentId)
                          ?.title
                      }
                    </span>
                  )}
                </div>
              </div>
              <ArrowUpRight className="library-card-arrow" size={15} />
            </button>
          ))}
        </div>
      ) : !query && files.length ? (
        // Files are already below: a short note instead of a page-sized empty state.
        <p className="library-files-empty">
          No pages yet. Use New page to write one.
        </p>
      ) : (
        <div className="library-empty">
          <FileText size={30} strokeWidth={1.3} />
          <h2>{query ? 'No matching pages' : 'No pages yet'}</h2>
          <p>
            {query
              ? 'Try a different title or phrase.'
              : 'Create your first page to start organizing this Space.'}
          </p>
          {!query && (
            <button className="document-primary" onClick={onNew}>
              <Plus size={16} /> New page
            </button>
          )}
        </div>
      )}
      {(files.length > 0 || dragging) && (
        <>
          <div className="library-section-label">
            <h2>{query ? 'Matching files' : 'Files'}</h2>
            <span>
              {matchingFiles.length}{' '}
              {matchingFiles.length === 1 ? 'file' : 'files'}
            </span>
          </div>
          {matchingFiles.length ? (
            <ul className="library-files">
              {matchingFiles.map((file) => (
                <li key={file.id}>
                  <button type="button" onClick={() => onFile(file.id)}>
                    <span className="library-file-icon">
                      <FileKindIcon kind={file.kind} size={18} />
                    </span>
                    <span className="library-file-name">{file.name}</span>
                    <span className="library-file-meta">
                      {formatBytes(file.size)} ·{' '}
                      {new Date(file.updatedAt).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="library-files-empty">
              {query ? 'No matching files.' : 'Drop files here to add them.'}
            </p>
          )}
        </>
      )}
    </section>
  );
}
