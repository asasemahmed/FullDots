import type {
  ApprovalMode,
  ConnectorToolInfo,
  ConnectorView,
  ToolOverride,
} from '../shared/types';

export interface GrantInput {
  connectorId: string;
  /** '*' = every read-only tool; a list names tools explicitly. */
  tools: '*' | string[];
  overrides?: Record<string, ToolOverride>;
}

export const WRITE_WARNING = 'This can change things outside FullDots';
export const NOT_CONNECTED_HINT = 'Connect it in Settings to choose tools';

/** Tool names a grant currently allows, given the connector's tool list. */
export function grantedNames(
  grant: GrantInput | undefined,
  tools: ConnectorToolInfo[],
): Set<string> {
  if (!grant) return new Set();
  if (grant.tools === '*')
    return new Set(tools.filter((tool) => tool.readOnly).map((t) => t.name));
  return new Set(grant.tools);
}

/**
 * The grant after ticking or unticking one tool. Ticking a non-read-only tool
 * (or unticking a read-only one) turns `'*'` into an explicit list; a list that
 * equals exactly the read-only tools collapses back to `'*'`.
 */
export function toggleTool(
  grant: GrantInput,
  tools: ConnectorToolInfo[],
  tool: string,
  on: boolean,
): GrantInput {
  const next = grantedNames(grant, tools);
  if (on) next.add(tool);
  else next.delete(tool);
  const readOnly = tools.filter((item) => item.readOnly).map((t) => t.name);
  const onlyReadOnly =
    next.size === readOnly.length && readOnly.every((name) => next.has(name));
  return { ...grant, tools: onlyReadOnly ? '*' : [...next] };
}

export function DotConnectorGrants({
  connectors,
  value,
  onChange,
}: {
  connectors: ConnectorView[];
  value: GrantInput[];
  onChange: (value: GrantInput[]) => void;
}) {
  const enabled = connectors.filter((connector) => connector.enabled);
  if (enabled.length === 0) return null;
  const replace = (connectorId: string, grant: GrantInput | undefined) =>
    onChange([
      ...value.filter((item) => item.connectorId !== connectorId),
      ...(grant ? [grant] : []),
    ]);
  return (
    <div className="cn-grants">
      <span className="field-label">Connectors</span>
      {enabled.map((connector) => {
        const grant = value.find((item) => item.connectorId === connector.id);
        const connected = connector.status.state === 'connected';
        const tools = connector.status.tools;
        const names = grantedNames(grant, tools);
        return (
          <fieldset
            className="cn-fieldset"
            key={connector.id}
            data-connector={connector.name}
          >
            <legend>{connector.name}</legend>
            <label className="cn-check">
              <input
                type="checkbox"
                checked={!!grant}
                onChange={(event) =>
                  replace(
                    connector.id,
                    event.target.checked
                      ? { connectorId: connector.id, tools: '*' }
                      : undefined,
                  )
                }
              />
              <span>Use this connector</span>
            </label>
            {!connected && <p className="cn-note">{NOT_CONNECTED_HINT}</p>}
            {connected &&
              tools.map((tool) => (
                <label className="cn-check cn-tool" key={tool.toolName}>
                  <input
                    type="checkbox"
                    checked={names.has(tool.name)}
                    disabled={!grant}
                    onChange={(event) =>
                      grant &&
                      replace(
                        connector.id,
                        toggleTool(
                          grant,
                          tools,
                          tool.name,
                          event.target.checked,
                        ),
                      )
                    }
                  />
                  <span>
                    <code>{tool.name}</code>
                    {tool.readOnly && <span className="cn-tag">read-only</span>}
                    {tool.destructive && (
                      <span className="cn-tag cn-tag-destructive">
                        destructive
                      </span>
                    )}
                    {!tool.readOnly && (
                      <small className="cn-warn">{WRITE_WARNING}</small>
                    )}
                  </span>
                </label>
              ))}
          </fieldset>
        );
      })}
    </div>
  );
}

const APPROVAL_OPTIONS: { value: ApprovalMode; label: string }[] = [
  { value: 'sensitive', label: 'Ask before sensitive actions (recommended)' },
  { value: 'writes', label: 'Ask before anything that changes data' },
  { value: 'off', label: 'Never ask' },
];

export function ApprovalModeField({
  value,
  onChange,
}: {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void;
}) {
  return (
    <>
      <label className="field-label" htmlFor="dot-approval-mode">
        Approvals
      </label>
      <select
        id="dot-approval-mode"
        value={value}
        onChange={(event) => onChange(event.target.value as ApprovalMode)}
      >
        {APPROVAL_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {value === 'off' && (
        <p className="cn-approval-warning" role="alert">
          The Dot will send, pay, delete and publish without asking. Handoff for
          passwords and codes still applies.
        </p>
      )}
    </>
  );
}
