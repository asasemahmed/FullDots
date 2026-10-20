import { mergePageSnapshot } from './page-snapshots';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Page } from '../server/pages';
import type { Space, WorkspaceState } from '../shared/types';
import { api } from './api';
import { SpaceLibrary } from './SpaceLibrary';
import { PageDocument } from './PageDocument';
import { PageOutline } from './PageOutline';
import { FileViewer } from './FileViewer';
import { uploadSpaceFile } from './space-files-api';
import type { SpaceFile } from '../shared/space-files';
export function SpaceWorkspace({
  space,
  pageId,
  fileId,
  workspace,
  paused,
  onPage,
  onFile,
  onDirty,
  onRefresh,
  onSchedule,
  onThread,
  onSettings,
  onCreateDot,
}: {
  space: Space;
  pageId?: string;
  /** The file open in the viewer instead of a page. */
  fileId?: string;
  workspace: WorkspaceState;
  paused: boolean;
  onPage: (id?: string) => void;
  onFile: (id: string) => void;
  onDirty: (value: boolean) => void;
  onRefresh: () => void;
  onSchedule: (threadId: string) => void;
  onThread: (threadId: string) => void;
  onSettings: () => void;
  onCreateDot: () => void;
}) {
  const [pages, setPages] = useState<Page[]>([]);
  const [files, setFiles] = useState<SpaceFile[]>([]);
  const removed = useRef(new Set<string>());
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [outline, setOutline] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [next, nextFiles] = await Promise.all([
          api<Page[]>(`/spaces/${space.id}/pages`),
          api<SpaceFile[]>(`/spaces/${space.id}/files`),
        ]);
        if (active) {
          setPages((previous) =>
            mergePageSnapshot(previous, next, removed.current),
          );
          setFiles(nextFiles);
          setLoaded(true);
          setError('');
        }
      } catch (e) {
        if (active)
          setError(e instanceof Error ? e.message : 'Could not load pages.');
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [space.id]);
  const page = pages.find((item) => item.id === pageId);
  const saved = useCallback(
    (next: Page) =>
      setPages((previous) =>
        previous.map((item) =>
          item.id === next.id && item.revision < next.revision ? next : item,
        ),
      ),
    [],
  );
  const deleted = useCallback((id: string) => {
    removed.current.add(id);
    setPages((previous) => {
      const parentId =
        previous.find((item) => item.id === id)?.parentId ?? null;
      return previous
        .filter((item) => item.id !== id)
        .map((item) => (item.parentId === id ? { ...item, parentId } : item));
    });
  }, []);
  const create = async (parentId: string | null) => {
    try {
      const next = await api<Page>(`/spaces/${space.id}/pages`, 'POST', {
        title: 'Untitled page',
        content: '',
        parentId,
      });
      setPages((previous) => [...previous, next]);
      onPage(next.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create page.');
    }
  };
  const file = files.find((item) => item.id === fileId);
  const upload = async (picked: File[]) => {
    setError('');
    for (const item of picked) {
      try {
        const saved = await uploadSpaceFile(space.id, item);
        setFiles((previous) => [...previous, saved]);
      } catch (e) {
        setError(
          `${item.name}: ${e instanceof Error ? e.message : 'Could not upload the file.'}`,
        );
      }
    }
  };
  return (
    <main
      aria-label="Space documents"
      className={`spaces-surface ${pageId ? 'writing' : 'library'}`}
    >
      {error && (
        <div className="document-load-error" role="alert">
          {error}
        </div>
      )}
      {fileId ? (
        file ? (
          <FileViewer
            key={file.id}
            file={file}
            onBack={() => onPage()}
            onChanged={(next) =>
              setFiles((previous) =>
                previous.map((item) => (item.id === next.id ? next : item)),
              )
            }
            onDeleted={(id) => {
              setFiles((previous) => previous.filter((item) => item.id !== id));
              onPage();
            }}
          />
        ) : (
          <div className="library-empty">
            <h2>{loaded ? 'File not found' : 'Loading file…'}</h2>
            {loaded && (
              <button className="document-primary" onClick={() => onPage()}>
                Back to all pages
              </button>
            )}
          </div>
        )
      ) : !pageId ? (
        <SpaceLibrary
          space={space}
          pages={pages}
          files={files}
          onPage={onPage}
          onFile={onFile}
          onUpload={(picked) => void upload(picked)}
          onNew={() => void create(null)}
        />
      ) : page ? (
        <div className="space-writing-layout">
          {outline && (
            <PageOutline
              pages={pages}
              selected={page.id}
              onPage={(id) => {
                onPage(id);
                if (window.innerWidth < 760) setOutline(false);
              }}
              onNew={() => void create(null)}
              onClose={() => setOutline(false)}
            />
          )}
          <PageDocument
            key={page.id}
            page={page}
            pages={pages}
            workspace={workspace}
            paused={paused}
            onHome={() => onPage()}
            onOutline={() => setOutline(!outline)}
            onSubpage={() => void create(page.id)}
            onDirty={onDirty}
            onSaved={saved}
            onDeleted={deleted}
            onRefresh={onRefresh}
            onSchedule={onSchedule}
            onThread={onThread}
            onSettings={onSettings}
            onCreateDot={onCreateDot}
          />
        </div>
      ) : (
        <div className="library-empty">
          <h2>{loaded ? 'Page not found' : 'Loading page…'}</h2>
          {loaded && (
            <button className="document-primary" onClick={() => onPage()}>
              Back to all pages
            </button>
          )}
        </div>
      )}
    </main>
  );
}
