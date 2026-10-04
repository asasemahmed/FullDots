import { useEffect, useState } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import type { Space } from '../shared/types';
import type { Page } from '../server/pages';
import { api } from './api';

export function SpaceNav({
  space,
  active,
  pageId,
  collapsed = false,
  onOpen,
}: {
  space: Space;
  active: boolean;
  pageId?: string;
  /** Slim icon-only sidebar: just the Space, no page tree. */
  collapsed?: boolean;
  onOpen: (pageId?: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pages, setPages] = useState<Page[]>([]);
  const [error, setError] = useState('');
  // Following a link into this Space opens its tree so the page is visible.
  useEffect(() => {
    if (active && pageId) setExpanded(true);
  }, [active, pageId]);
  const showPages = expanded && !collapsed;
  useEffect(() => {
    if (!showPages) return;
    let current = true;
    const load = async () => {
      try {
        const next = await api<Page[]>(`/spaces/${space.id}/pages`);
        if (current) {
          setPages(next);
          setError('');
        }
      } catch {
        if (current) setError('Could not load pages.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [showPages, space.id]);
  const branches = (parentId: string | null, depth = 0): React.ReactNode =>
    pages
      .filter((page) => page.parentId === parentId)
      .map((page) => (
        <div key={page.id}>
          <button
            type="button"
            className={`sb-row sb-page ${active && pageId === page.id ? 'active' : ''}`}
            style={{ paddingLeft: 30 + Math.min(depth, 4) * 12 }}
            aria-current={active && pageId === page.id ? 'page' : undefined}
            title={page.title}
            onClick={() => onOpen(page.id)}
          >
            <FileText size={14} aria-hidden />
            <span className="sb-text">{page.title}</span>
          </button>
          {branches(page.id, depth + 1)}
        </div>
      ));
  return (
    <div className="sb-space">
      <div className="sb-space-row">
        <button
          type="button"
          className="sb-icon sb-space-toggle"
          aria-label={`${expanded ? 'Collapse' : 'Expand'} ${space.name}`}
          aria-expanded={expanded}
          aria-controls={`space-pages-${space.id}`}
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={expanded ? 'turned' : ''}
          />
        </button>
        <button
          type="button"
          className={`sb-row ${active && !pageId ? 'active' : ''}`}
          aria-current={active && !pageId ? 'page' : undefined}
          aria-label={collapsed ? space.name : undefined}
          title={collapsed ? space.name : undefined}
          onClick={() => onOpen()}
        >
          <Folder size={16} aria-hidden />
          <span className="sb-text">{space.name}</span>
        </button>
      </div>
      {showPages && (
        <div id={`space-pages-${space.id}`} className="sb-pages">
          {error ? (
            <p className="sb-note error" role="status">
              {error}
            </p>
          ) : (
            branches(null)
          )}
          {!error && !pages.length && <p className="sb-note">No pages yet</p>}
        </div>
      )}
    </div>
  );
}
