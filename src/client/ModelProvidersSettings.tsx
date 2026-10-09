import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import {
  ModelProviderGallery,
  providerRequest,
  type DefaultModel,
  type ModelProvidersData,
} from './ModelProviderGallery';
import {
  ModelProviderPage,
  type ProviderTarget,
  type ModelsListResult,
} from './ModelProviderPage';
import type { ModelChoice } from './ModelPicker';
import type { ModelProviderView } from '../shared/model-presets';
import './connectors.css';
import './model-providers.css';

export type { ModelProvidersData } from './ModelProviderGallery';

/** Settings > Models: the gallery, and a detail page that takes its place. */
export function ModelProvidersSettings({
  initial,
}: {
  /** Data for the first render (tests, or a parent that already fetched it). */
  initial?: ModelProvidersData;
}) {
  const [data, setData] = useState<ModelProvidersData | undefined>(initial);
  const [loadError, setLoadError] = useState('');
  const [sheet, setSheet] = useState<ProviderTarget | undefined>();
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [defaultError, setDefaultError] = useState('');
  // The gallery stays mounted (hidden) under a detail page, so its search and
  // scroll position are still there on the way back.
  const galleryRef = useRef<HTMLDivElement>(null);
  const galleryScroll = useRef(0);
  const openSheet = (target: ProviderTarget) => {
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
      setData(await providerRequest<ModelProvidersData>('/model-providers'));
      setLoadError('');
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : 'Could not load providers.',
      );
    }
  }, []);
  useEffect(() => {
    if (!initial) void load();
  }, [initial, load]);

  // Count each usable provider's models for the cards. The server keeps these lists for ten
  // minutes, so this is a cache read for any provider looked at recently. One request per
  // provider, once.
  const counted = useRef(new Set<string>());
  const providerIds = data?.providers
    .filter(
      (view) =>
        view.enabled &&
        !view.lastError &&
        (view.key.set || view.key.kind === 'none'),
    )
    .map((view) => view.id)
    .join('|');
  useEffect(() => {
    let active = true;
    for (const id of providerIds ? providerIds.split('|') : []) {
      if (counted.current.has(id)) continue;
      counted.current.add(id);
      void providerRequest<ModelsListResult>(
        `/model-providers/${encodeURIComponent(id)}/models`,
      )
        .then((result) => {
          if (active && !result.error && result.models.length > 0)
            setCounts((current) => ({
              ...current,
              [id]: result.models.length,
            }));
        })
        .catch(() => {});
    }
    return () => {
      active = false;
    };
  }, [providerIds]);

  const upsert = useCallback((view: ModelProviderView) => {
    setData(
      (current) =>
        current && {
          ...current,
          providers: current.providers.some((item) => item.id === view.id)
            ? current.providers.map((item) =>
                item.id === view.id ? view : item,
              )
            : [...current.providers, view],
        },
    );
  }, []);
  const onCount = useCallback((id: string, count: number) => {
    setCounts((current) =>
      current[id] === count ? current : { ...current, [id]: count },
    );
  }, []);

  const changeDefault = async (choice: ModelChoice) => {
    if (!choice.providerId || !choice.model) return;
    setDefaultError('');
    try {
      const result = await providerRequest<{
        defaultModel: DefaultModel | null;
      }>('/model-providers/default', 'PUT', {
        providerId: choice.providerId,
        model: choice.model,
      });
      setData(
        (current) =>
          current && { ...current, defaultModel: result.defaultModel },
      );
    } catch (error) {
      setDefaultError(
        error instanceof Error
          ? error.message
          : 'Could not change the default.',
      );
    }
  };

  const sheetKey = !sheet
    ? ''
    : sheet.kind === 'provider'
      ? `p:${sheet.id}`
      : `n:${sheet.preset.id}`;

  return (
    <div
      className="cn-root cx-root mp-settings"
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
            Loading models…
          </p>
        )}
        {data && (
          <ModelProviderGallery
            providers={data.providers}
            presets={data.presets}
            defaultModel={data.defaultModel}
            counts={counts}
            defaultError={defaultError}
            onOpenProvider={(view) =>
              openSheet({ kind: 'provider', id: view.id })
            }
            onOpenPreset={(preset) => openSheet({ kind: 'preset', preset })}
            onChangeDefault={(choice) => void changeDefault(choice)}
          />
        )}
      </div>
      {sheet && data && (
        <ModelProviderPage
          key={sheetKey}
          target={sheet}
          providers={data.providers}
          presets={data.presets}
          defaultModel={data.defaultModel}
          onClose={() => setSheet(undefined)}
          onSaved={(view, options) => {
            upsert(view);
            // A provider just created: show its own page, and test it there.
            setSheet((current) =>
              current && current.kind === 'preset'
                ? {
                    kind: 'provider',
                    id: view.id,
                    ...(options?.test ? { test: true } : {}),
                  }
                : current,
            );
          }}
          onDeleted={(id) => {
            setData(
              (current) =>
                current && {
                  ...current,
                  providers: current.providers.filter((item) => item.id !== id),
                },
            );
            setCounts(({ [id]: _removed, ...rest }) => rest);
            setSheet(undefined);
          }}
          onDefaultChanged={(value) =>
            setData((current) => current && { ...current, defaultModel: value })
          }
          onReload={() => void load()}
          onCount={onCount}
        />
      )}
    </div>
  );
}
