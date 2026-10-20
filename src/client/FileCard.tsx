import { FileText } from 'lucide-react';
import type { PaneItem, SavedFile, SavedPage } from './chat-turns';
import { FileKindIcon } from './file-icons';
import { openPageLink } from './page-navigation';
import { fileHash } from './file-links';
import { ResultCard } from './ResultCard';
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

const inSpace = (space: string) => (space ? ` · in ${space}` : '');

/**
 * A file a Dot saved or changed in a Space. Clicking it shows the file beside the chat; without a
 * chat to show it in, it opens the file in its Space.
 */
export function FileCard({
  file,
  onOpen,
}: {
  file: SavedFile;
  onOpen?: (item: PaneItem) => void;
}) {
  const hash = fileHash(file.spaceId, file.id);
  return (
    <ResultCard
      icon={<FileKindIcon kind={file.kind} size={20} />}
      title={file.name}
      meta={`${file.updated ? 'Updated · ' : ''}${KIND_LABELS[file.kind]} · ${formatBytes(file.size)}${inSpace(file.space)}`}
      href={hash}
      onOpen={() =>
        onOpen
          ? onOpen({ type: 'file', spaceId: file.spaceId, id: file.id })
          : openPageLink(hash)
      }
    />
  );
}

/** A page a Dot created or edited. Clicking it previews the page beside the chat. */
export function PageCard({
  page,
  onOpen,
}: {
  page: SavedPage;
  onOpen?: (item: PaneItem) => void;
}) {
  const hash = `#/spaces/${page.spaceId}/pages/${page.id}`;
  return (
    <ResultCard
      icon={<FileText size={20} aria-hidden="true" />}
      title={page.title || 'Untitled page'}
      meta={`Page · ${page.updated ? 'edited' : 'created'}${inSpace(page.space)}`}
      href={hash}
      onOpen={() =>
        onOpen
          ? onOpen({ type: 'page', spaceId: page.spaceId, id: page.id })
          : openPageLink(hash)
      }
    />
  );
}
