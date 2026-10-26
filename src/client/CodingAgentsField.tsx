import { useId } from 'react';

export type CodingProviderChoice = 'claude' | 'codex';
const providerLabels: Record<CodingProviderChoice, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
};

export interface CodingAgentsFieldProps {
  enabled: boolean;
  onChange: (value: boolean) => void;
  provider?: CodingProviderChoice;
  onProviderChange?: (value: CodingProviderChoice) => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  onRetry?: () => void;
}

export function CodingAgentsField({
  enabled,
  onChange,
  provider = 'claude',
  onProviderChange,
  loading = false,
  error = null,
  disabled = false,
  onRetry,
}: CodingAgentsFieldProps) {
  const inputId = useId();
  const descId = useId();
  const selectId = useId();
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
      {enabled && onProviderChange && (
        <>
          <label className="dlg-label" htmlFor={selectId}>
            Coding agent
          </label>
          <select
            id={selectId}
            className="dlg-input dlg-select"
            value={provider}
            disabled={isDisabled}
            onChange={(e) =>
              onProviderChange(e.target.value as CodingProviderChoice)
            }
          >
            {(Object.keys(providerLabels) as CodingProviderChoice[]).map(
              (id) => (
                <option key={id} value={id}>
                  {providerLabels[id]}
                </option>
              ),
            )}
          </select>
          <p className="dlg-hint">
            You sign in to the one you choose inside this Dot&apos;s computer.
          </p>
        </>
      )}
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
