import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';
import { FileViewer } from './FileViewer';
import { fileHash } from './file-links';
import { openPageLink } from './page-navigation';
import type { SpaceFile } from '../shared/space-files';

/** How often an open file is read again, so an edit the Dot makes shows up without reopening it. */
const REFRESH_MS = 3000;

type State =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; file: SpaceFile };

/** A file a Dot saved, shown beside the chat so the owner never has to go looking for it in a Space. */
export function FilePane({
  spaceId,
  fileId,
}: {
  spaceId: string;
  fileId: string;
}) {
  const [state, setState] = useState<State>({ phase: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    setState({ phase: 'loading' });
    const load = async () => {
      try {
        const file = await api<SpaceFile>(
          `/spaces/${spaceId}/files/${fileId}`,
          'GET',
          undefined,
          controller.signal,
        );
        // Only a changed file replaces the one shown, so the preview does not reload for nothing.
        setState((previous) =>
          previous.phase === 'ready' &&
          previous.file.sha256 === file.sha256 &&
          previous.file.name === file.name
            ? previous
            : { phase: 'ready', file },
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((previous) =>
          previous.phase === 'ready'
            ? previous
            : {
                phase: 'error',
                message:
                  error instanceof Error
                    ? error.message
                    : 'Could not load the file.',
              },
        );
      }
    };
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [spaceId, fileId]);

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
  return (
    <FileViewer
      key={state.file.id}
      file={state.file}
      variant="pane"
      onOpenInSpace={() => openPageLink(fileHash(spaceId, fileId))}
    />
  );
}
