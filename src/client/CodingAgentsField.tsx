import { useId } from 'react';

export interface CodingAgentsFieldProps {
  enabled: boolean;
  onChange: (value: boolean) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onRetry?: () => void;
}

export function CodingAgentsField({
  enabled,
  onChange,
  loading = false,
  error = null,
  disabled = false,
  onRetry,
}: CodingAgentsFieldProps) {
  const inputId = useId();
  const descId = useId();
  const isDisabled = disabled || loading || Boolean(error);

  return (
    <>
      <label className="dlg-switch-row" htmlFor={inputId}>
        <span className="dlg-switch-text">
          <strong>Coding agents</strong>
          <small id={descId}>
            Run a coding worker in this Dot&apos;s computer. Requires a running
            computer and separate sign-in. You approve the worker&apos;s
            permission requests.
          </small>
        </span>
        <input
          id={inputId}
          type="checkbox"
          role="switch"
          className="dlg-sr"
          checked={enabled}
          disabled={isDisabled}
          aria-checked={enabled}
          aria-busy={loading}
          aria-describedby={descId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="dlg-switch-track" aria-hidden="true" />
      </label>
      {loading && (
        <p className="dlg-hint" role="status" aria-live="polite">
          Loading coding agent settings…
        </p>
      )}
      {error && (
        <div className="dlg-error" role="alert">
          <span>{error}</span>
          {onRetry && (
            <button type="button" className="dlg-btn" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </>
  );
}
