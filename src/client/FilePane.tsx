import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { api } from './api';
import { FileViewer } from './FileViewer';
import { fileHash } from './file-links';
import { openPageLink } from './page-navigation';
import type { SpaceFile } from '../shared/space-files';

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
    api<SpaceFile>(
      `/spaces/${spaceId}/files/${fileId}`,
      'GET',
      undefined,
      controller.signal,
    )
      .then((file) => setState({ phase: 'ready', file }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            phase: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Could not load the file.',
          });
      });
    return () => controller.abort();
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
