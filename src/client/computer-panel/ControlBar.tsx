import { Hand, LoaderCircle, Undo2 } from 'lucide-react';
import type { Working } from './PanelHeader';

/**
 * The one control that matters while watching: who is driving.
 *
 * Handing control over takes a moment, because the Dot finishes what it is doing first, so the
 * waiting state is its own line rather than a disabled button.
 */
export function ControlBar({
  dotName,
  human,
  waiting,
  disabled,
  onTake,
  onRelease,
}: {
  dotName: string;
  /** The owner holds control. */
  human: boolean;
  waiting?: Extract<Working, 'take' | 'release'>;
  disabled: boolean;
  onTake: () => void;
  onRelease: () => void;
}) {
  if (waiting)
    return (
      <div className="cp-control cp-control-waiting" role="status">
        <LoaderCircle className="cp-spin" size={15} aria-hidden="true" />
        <span>
          {waiting === 'take'
            ? `Waiting for ${dotName} to pause…`
            : `Handing control back to ${dotName}…`}
        </span>
      </div>
    );
  if (human)
    return (
      <div className="cp-control cp-control-human">
        <button
          type="button"
          className="cp-btn cp-btn-primary cp-btn-block"
          onClick={onRelease}
          disabled={disabled}
        >
          <Undo2 size={15} aria-hidden="true" />
          Give control back
        </button>
        <p className="cp-hint">
          Click and type directly on the screen. Shift+Esc to stop typing.
        </p>
      </div>
    );
  return (
    <div className="cp-control cp-control-bot">
      <span className="cp-control-who">{dotName} is in control</span>
      <button
        type="button"
        className="cp-btn"
        onClick={onTake}
        disabled={disabled}
      >
        <Hand size={14} aria-hidden="true" />
        Take control
      </button>
    </div>
  );
}
