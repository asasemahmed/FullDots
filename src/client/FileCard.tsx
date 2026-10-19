import { ExternalLink } from 'lucide-react';
import type { SavedFile } from './chat-turns';
import { FileKindIcon } from './file-icons';
import { openPageLink } from './page-navigation';
import { fileHash } from './file-links';
import { formatBytes } from '../shared/space-files';

const KIND_LABELS: Record<SavedFile['kind'], string> = {
  csv: 'Table',
  markdown: 'Document',
  html: 'Web page',
  text: 'Text',
  json: 'JSON',
  image: 'Image',
  pdf: 'PDF',
  download: 'File',
};

/**
 * A file a Dot saved in a Space. Opens the viewer in the app; the small link opens it in a new
 * window, so the chat stays where it is.
 */
export function FileCard({ file }: { file: SavedFile }) {
  const hash = fileHash(file.spaceId, file.id);
  return (
    <div className="file-card">
      <button
        type="button"
        className="file-card-main"
        onClick={() => openPageLink(hash)}
        aria-label={`Open ${file.name}`}
      >
        <span className="file-card-icon">
          <FileKindIcon kind={file.kind} size={20} />
        </span>
        <span className="file-card-text">
          <span className="file-card-name">{file.name}</span>
          <span className="file-card-meta">
            {KIND_LABELS[file.kind]} · {formatBytes(file.size)}
            {file.space ? ` · in ${file.space}` : ''}
          </span>
        </span>
      </button>
      <a
        className="file-card-new"
        href={hash}
        target="_blank"
        rel="noreferrer"
        aria-label={`Open ${file.name} in a new window`}
        title="Open in a new window"
      >
        <ExternalLink size={15} aria-hidden="true" />
      </a>
    </div>
  );
}
