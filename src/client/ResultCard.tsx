import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';

/**
 * A clickable card for something a Dot made in a Space (a file or a page). The main button shows it
 * beside the chat; the small link opens it in a new window.
 */
export function ResultCard({
  icon,
  title,
  meta,
  href,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  /** Where the new-window link and the click (when nothing shows it beside the chat) go. */
  href: string;
  onOpen: () => void;
}) {
  return (
    <div className="file-card">
      <button
        type="button"
        className="file-card-main"
        onClick={onOpen}
        aria-label={`Open ${title}`}
      >
        <span className="file-card-icon">{icon}</span>
        <span className="file-card-text">
          <span className="file-card-name">{title}</span>
          <span className="file-card-meta">{meta}</span>
        </span>
      </button>
      <a
        className="file-card-new"
        href={href}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${title} in a new window`}
        title="Open in a new window"
      >
        <ExternalLink size={15} aria-hidden="true" />
      </a>
    </div>
  );
}
