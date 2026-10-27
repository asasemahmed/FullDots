import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot } from '../../shared/types';
import type {
  ComputerKind,
  ComputerPermissions,
  ComputerStatus,
} from '../../shared/computer-types';
import type { Frame } from '../computer-input';
import type { StreamPhase } from '../useComputerStream';
import '../computer-panel.css';
import { AddressBar } from './AddressBar';
import { ControlBar } from './ControlBar';
import { EmptyState } from './EmptyState';
import { MoreTools } from './MoreTools';
import { PanelHeader, type Working } from './PanelHeader';
import { ReplayPanel } from './ReplayView';
import { ScreenStage, type PagePosition, type Snapshot } from './ScreenStage';
import { SettingsSheet, type SaveNote } from './SettingsSheet';
import { TakeoverBanner } from './TakeoverBanner';
import {
  ActivityTool,
  FilesTool,
  KeyboardTool,
  TerminalTool,
  type Act,
  type Blocked,
} from './Tools';
import {
  isUsable,
  panelPhase,
  readMorePrefs,
  writeMorePrefs,
  type Activity,
  type MoreTool,
  type PermissionKey,
} from './model';

export interface PanelActions {
  refresh: () => void;
  start: () => void;
  stop: () => void;
  /** Turns computer access on, then starts the computer unless it is already running. */
  enable: () => void;
  take: () => void;
  release: () => void;
  /** Turns down the Dot's request for help, so it carries on without it. */
  dismissHandoff: (id: string) => void;
  navigate: (url: string) => Promise<boolean>;
  act: Act;
  setPermission: (key: PermissionKey, value: boolean | ComputerKind) => void;
  retryStream: () => void;
  clickSnapshot: (point: { x: number; y: number }) => void;
  onPhase: (phase: StreamPhase) => void;
  onFrameSize: (size: Frame | undefined) => void;
}

export type PanelTab = 'live' | 'replay';

export interface PanelViewProps {
  dot: Dot;
  dots?: readonly Dot[];
  onSelectDot?: (id: string) => void;
  onClose?: () => void;
  /** The open conversation, whose browser steps the Replay tab shows. */
  threadId?: string;
  /** Opens on the Replay tab instead of the live screen. */
  initialView?: PanelTab;
  status?: ComputerStatus;
  /** Whether the first load failed, as opposed to still being under way. */
  loadFailed: boolean;
  error: string;
  onDismissError: () => void;
  busy: boolean;
  working?: Working;
  stream: StreamPhase;
  streamKey: number;
  snapshot?: Snapshot;
  snapshotError: string;
  page?: PagePosition;
  activity?: Activity;
  frameSize?: Frame;
  optimistic: Partial<ComputerPermissions>;
  notes: Partial<Record<PermissionKey, SaveNote>>;
  actions: PanelActions;
}

/**
 * The computer panel, top to bottom: who and whether it is on, the screen, who is driving, an
 * address bar, and the rest folded away. Everything here is drawn from props, so each state of the
 * panel can be rendered on its own.
 */
export function PanelView({
  dot,
  dots,
  onSelectDot,
  onClose,
  threadId,
  initialView = 'live',
  status,
  loadFailed,
  error,
  onDismissError,
  busy,
  working,
  stream,
  streamKey,
  snapshot,
  snapshotError,
  page,
  activity,
  frameSize,
  optimistic,
  notes,
  actions,
}: PanelViewProps) {
  const settingsId = useId();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [more, setMore] = useState(readMorePrefs);
  const [tab, setTab] = useState<PanelTab>(initialView);
  const tabsId = useId();
  const gear = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (settingsOpen) sheet.current?.focus();
    else if (wasOpen.current) gear.current?.focus();
    wasOpen.current = settingsOpen;
  }, [settingsOpen]);

  const phase = panelPhase(status, loadFailed);
  const usable = isUsable(status);
  const permissions = status?.permissions;
  const kind = permissions?.kind ?? 'browser';
  const isDesktop = kind === 'desktop';
  const screenAvailable =
    usable && (isDesktop ? !!permissions?.desktop : !!permissions?.browser);
  const browser = usable && !!permissions?.browser;
  const control = status?.control;
  const human = control?.holder === 'human' && !control.transitioning;
  const waiting: Working | undefined =
    working === 'take' || working === 'release'
      ? working
      : control?.transitioning
        ? control.holder === 'human'
          ? 'release'
          : 'take'
        : undefined;
  const handoff = status?.handoff;
  const needsYou = !!handoff && control?.holder !== 'human';
  const openSettings = () => setSettingsOpen(true);
  const blockedFor = (
    permission: 'files' | 'shell',
    thing: string,
  ): Blocked | undefined =>
    phase === 'disabled'
      ? {
          message: `Computer access is off, so ${thing} cannot be used.`,
          settings: true,
        }
      : !usable
        ? { message: `Start the computer to use ${thing}.`, settings: false }
        : !permissions?.[permission]
          ? {
              message:
                permission === 'shell'
                  ? 'The terminal is off. Turn on Shell in settings to run commands here.'
                  : 'Files are off. Turn them on in settings to use them here.',
              settings: true,
            }
          : undefined;
  const chooseMore = (open: boolean, tool: MoreTool) => {
    setMore({ open, tool });
    writeMorePrefs({ open, tool });
  };

  return (
    <section
      className="cp-panel"
      aria-label={`${dot.name}'s computer`}
      aria-busy={busy}
    >
      <PanelHeader
        dot={dot}
        phase={phase}
        working={working}
        needsYou={needsYou && phase === 'running'}
        settingsOpen={settingsOpen}
        settingsDisabled={!status}
        settingsId={settingsId}
        gearRef={gear}
        onToggleSettings={() => setSettingsOpen(!settingsOpen)}
        onStop={actions.stop}
        onClose={onClose}
      />
      <div className="cp-body" hidden={settingsOpen}>
        {phase === 'running' && screenAvailable && human && !waiting && (
          <TakeoverBanner
            dotId={dot.id}
            dotName={dot.name}
            reason={handoff?.reason}
            disabled={busy}
            onRelease={actions.release}
          />
        )}
        {status?.configured && (
          <div
            className="cp-segments cp-view-tabs"
            role="tablist"
            aria-label="Screen"
            onKeyDown={(event) => {
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              const next: PanelTab =
                event.key === 'Home'
                  ? 'live'
                  : event.key === 'End'
                    ? 'replay'
                    : tab === 'live'
                      ? 'replay'
                      : 'live';
              setTab(next);
              document.getElementById(`${tabsId}-${next}`)?.focus();
            }}
          >
            {(['live', 'replay'] as const).map((name) => (
              <button
                key={name}
                id={`${tabsId}-${name}`}
                type="button"
                role="tab"
                aria-selected={tab === name}
                aria-controls={`${tabsId}-${name}-panel`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
              >
                {name === 'live' ? 'Live' : 'Replay'}
              </button>
            ))}
          </div>
        )}
        {status?.configured && tab === 'replay' && (
          <div
            id={`${tabsId}-replay-panel`}
            role="tabpanel"
            aria-labelledby={`${tabsId}-replay`}
          >
            <ReplayPanel
              dotId={dot.id}
              dotName={dot.name}
              threadId={threadId}
              onJumpToLive={() => setTab('live')}
              onOpenSettings={openSettings}
            />
          </div>
        )}
        <div
          className="cp-live"
          id={`${tabsId}-live-panel`}
          role={status?.configured ? 'tabpanel' : undefined}
          aria-labelledby={status?.configured ? `${tabsId}-live` : undefined}
          hidden={!!status?.configured && tab !== 'live'}
        >
          {error && phase !== 'unreachable' && (
            <div className="cp-alert" role="alert">
              <span>{error}</span>
              <button
                type="button"
                className="cp-icon-btn"
                aria-label="Dismiss message"
                onClick={onDismissError}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )}
          {phase === 'running' && status ? (
            <>
              <ScreenStage
                dotId={dot.id}
                dotName={dot.name}
                screenAvailable={screenAvailable}
                isDesktop={isDesktop}
                browser={browser}
                human={human}
                typeChars={status.limits?.typeChars ?? 16_000}
                streamKey={streamKey}
                stream={stream}
                snapshot={snapshot}
                snapshotError={snapshotError}
                page={page}
                activity={activity}
                busy={busy}
                onPhase={actions.onPhase}
                onFrameSize={actions.onFrameSize}
                onRetryStream={actions.retryStream}
                onClickSnapshot={actions.clickSnapshot}
                onOpenSettings={openSettings}
              />
              {screenAvailable && (
                <ControlBar
                  dotName={dot.name}
                  human={human}
                  waiting={
                    waiting === 'take' || waiting === 'release'
                      ? waiting
                      : undefined
                  }
                  disabled={busy}
                  handoff={handoff}
                  onTake={actions.take}
                  onDismiss={
                    handoff
                      ? () => actions.dismissHandoff(handoff.id)
                      : undefined
                  }
                />
              )}
              {browser && (
                <AddressBar
                  disabled={busy || human}
                  placeholder={
                    human
                      ? `Hand back to ${dot.name} to open a page`
                      : 'Open a website'
                  }
                  onOpen={actions.navigate}
                />
              )}
            </>
          ) : (
            <EmptyState
              phase={phase === 'running' ? 'loading' : phase}
              dotName={dot.name}
              status={status}
              error={error}
              working={working}
              onStart={actions.start}
              onEnable={actions.enable}
              onRetry={actions.refresh}
            />
          )}
        </div>
        {status?.configured && (
          <MoreTools
            open={more.open}
            tool={more.tool}
            onToggle={() => chooseMore(!more.open, more.tool)}
            onTool={(tool) => chooseMore(true, tool)}
            panels={{
              files: (
                <FilesTool
                  blocked={blockedFor('files', 'files')}
                  busy={busy}
                  fileChars={status.limits?.fileChars ?? 100_000}
                  act={actions.act}
                  onOpenSettings={openSettings}
                />
              ),
              terminal: (
                <TerminalTool
                  dotName={dot.name}
                  blocked={blockedFor('shell', 'the terminal')}
                  busy={busy}
                  commandChars={status.limits?.commandChars ?? 8000}
                  act={actions.act}
                  onOpenSettings={openSettings}
                />
              ),
              activity: (
                <ActivityTool dotName={dot.name} audit={status.audit} />
              ),
              keyboard: (
                <KeyboardTool
                  human={human && screenAvailable}
                  busy={busy}
                  dims={frameSize ?? snapshot}
                  typeChars={status.limits?.typeChars ?? 16_000}
                  act={actions.act}
                />
              ),
            }}
          />
        )}
      </div>
      {status && (
        <SettingsSheet
          id={settingsId}
          dot={dot}
          dots={dots}
          status={status}
          optimistic={optimistic}
          notes={notes}
          busy={busy}
          working={working}
          hidden={!settingsOpen}
          sheetRef={sheet}
          onSelectDot={onSelectDot}
          onSetPermission={actions.setPermission}
          onStart={actions.start}
          onStop={actions.stop}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </section>
  );
}
