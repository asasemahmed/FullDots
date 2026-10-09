import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { api } from './api';
import { ConnectorGallery } from './ConnectorGallery';
import { ConnectorSheet, type SheetTarget } from './ConnectorSheet';
import { useConnectorAuth } from './useConnectorAuth';
import type { ConnectorPreset } from '../shared/connector-presets';
import type { ConnectorView } from '../shared/types';
import './connectors.css';

// The pieces moved into their own files; these names stay importable from here.
export { STDIO_OFF_NOTE, StatusPill, knownEnv } from './ConnectorGallery';
export {
  ConnectorForm,
  ConnectorRequestError,
  connectorRequest,
  connectorToDraft,
  draftToBody,
  emptyDraft,
  presetToDraft,
  secretNameMessage,
  validateDraft,
  type ConnectorDraft,
  type ValueKind,
  type ValueRow,
} from './ConnectorSheet';

export interface ConnectorsData {
  connectors: ConnectorView[];
  presets: ConnectorPreset[];
  allowStdio: boolean;
}

const RUNNING = ['starting', 'waiting', 'finishing'];

/** Settings > Connectors: the gallery, and a detail page that takes its place. */
export function ConnectorsSettings({
  initial,
}: {
  /** Data for the first render (tests, or a parent that already fetched it). */
  initial?: ConnectorsData;
}) {
  const [data, setData] = useState<ConnectorsData | undefined>(initial);
  const [loadError, setLoadError] = useState('');
  const [sheet, setSheet] = useState<SheetTarget | undefined>();
  // The gallery stays mounted (hidden) under a detail page, so its search,
  // filter and scroll position are all still there on the way back.
  const galleryRef = useRef<HTMLDivElement>(null);
  const galleryScroll = useRef(0);
  const openSheet = (target: SheetTarget) => {
    if (!sheet && galleryRef.current)
      galleryScroll.current = galleryRef.current.scrollTop;
    setSheet(target);
  };
  useLayoutEffect(() => {
    if (!sheet && galleryRef.current)
      galleryRef.current.scrollTop = galleryScroll.current;
  }, [sheet]);

  const load = useCallback(async () => {
    try {
      setData(await api<ConnectorsData>('/connectors'));
      setLoadError('');
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Could not load connectors.',
      );
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  /** Replace a connector in the list, or add it when it is new. */
  const upsert = useCallback((view: ConnectorView) => {
    setData(
      (current) =>
        current && {
          ...current,
          connectors: current.connectors.some((item) => item.id === view.id)
            ? current.connectors.map((item) =>
                item.id === view.id ? view : item,
              )
            : [...current.connectors, view],
        },
    );
  }, []);

  const auth = useConnectorAuth({ onConnected: upsert });
  const connectingId =
    RUNNING.includes(auth.state.phase) && auth.state.phase !== 'starting'
      ? auth.state.connectorId
      : undefined;

  const close = () => {
    setSheet(undefined);
    auth.reset();
  };

  return (
    <div
      className="cn-root cx-root"
      onKeyDown={(event) => {
        // These fields live inside the settings form: Enter must not submit it.
        // It presses the nearest primary button instead (never a link or a card).
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          event.target
            .closest('[data-enter]')
            ?.querySelector<HTMLButtonElement>(
              'button[data-primary]:not(:disabled)',
            )
            ?.click();
        }
      }}
    >
      <div className="cg-scroll" ref={galleryRef} hidden={!!sheet}>
        {loadError && (
          <div className="cg-error" role="alert">
            <span>{loadError}</span>
            <button type="button" className="cs-btn cs-btn-sm" onClick={load}>
              Try again
            </button>
          </div>
        )}
        {!data && !loadError && (
          <p className="cg-loading" role="status">
            Loading connectors…
          </p>
        )}
        {data && (
          <ConnectorGallery
            connectors={data.connectors}
            presets={data.presets}
            allowStdio={data.allowStdio}
            {...(connectingId ? { connectingId } : {})}
            onOpenConnector={(connector) =>
              openSheet({ kind: 'connector', id: connector.id })
            }
            onConnect={(connector) => {
              // The sign-in window opens inside this click, before anything is awaited.
              auth.start(() => connector.id);
              openSheet({ kind: 'connector', id: connector.id });
            }}
            onOpenPreset={(preset) => openSheet({ kind: 'preset', preset })}
            onCustom={() => openSheet({ kind: 'custom' })}
          />
        )}
      </div>
      {sheet && data && (
        <ConnectorSheet
          target={sheet}
          connectors={data.connectors}
          presets={data.presets}
          allowStdio={data.allowStdio}
          auth={auth}
          onClose={close}
          onSaved={(view) => {
            upsert(view);
            // A connector created from a preset or the form: show its own page.
            setSheet((current) =>
              current && current.kind !== 'connector'
                ? { kind: 'connector', id: view.id }
                : current,
            );
          }}
          onDeleted={(id) => {
            setData(
              (current) =>
                current && {
                  ...current,
                  connectors: current.connectors.filter(
                    (item) => item.id !== id,
                  ),
                },
            );
            setSheet(undefined);
          }}
        />
      )}
    </div>
  );
}
