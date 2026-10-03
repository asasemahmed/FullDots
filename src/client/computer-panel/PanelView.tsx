import { useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { Dot } from '../../shared/types';
import type {
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
import { ScreenStage, type PagePosition, type Snapshot } from './ScreenStage';
import { SettingsSheet, type SaveNote } from './SettingsSheet';
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
  navigate: (url: string) => Promise<boolean>;
  act: Act;
  setPermission: (key: PermissionKey, value: boolean) => void;
  retryStream: () => void;
  clickSnapshot: (point: { x: number; y: number }) => void;
  onPhase: (phase: StreamPhase) => void;
  onFrameSize: (size: Frame | undefined) => void;
}

export interface PanelViewProps {
  dot: Dot;
  dots?: readonly Dot[];
  onSelectDot?: (id: string) => void;
  onClose?: () => void;
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
        settingsOpen={settingsOpen}
        settingsDisabled={!status}
        settingsId={settingsId}
        gearRef={gear}
        onToggleSettings={() => setSettingsOpen(!settingsOpen)}
        onStop={actions.stop}
        onClose={onClose}
      />
      <div className="cp-body" hidden={settingsOpen}>
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
            {browser && (
              <>
                <ControlBar
                  dotName={dot.name}
                  human={human}
                  waiting={
                    waiting === 'take' || waiting === 'release'
                      ? waiting
                      : undefined
                  }
                  disabled={busy}
                  onTake={actions.take}
                  onRelease={actions.release}
                />
                <AddressBar
                  disabled={busy || human}
                  placeholder={
                    human
                      ? 'Give control back to open a page'
                      : 'Open a website'
                  }
                  onOpen={actions.navigate}
                />
              </>
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
                  human={human && browser}
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
