import { useId } from 'react';
import {
  Check,
  PenLine,
  Plug,
  ShieldCheck,
  ShieldOff,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type {
  ApprovalMode,
  ConnectorToolInfo,
  ConnectorView,
  ToolOverride,
} from '../shared/types';
import { ConnectorLogo } from './connector-logos';
import './dot-permissions.css';
import { connectorTitle } from './ConnectorGallery';

export interface GrantInput {
  connectorId: string;
  /** '*' = every read-only tool; a list names tools explicitly. */
  tools: '*' | string[];
  overrides?: Record<string, ToolOverride>;
}

export const WRITE_WARNING = 'This can change things outside FullDots';
export const DESTRUCTIVE_WARNING = 'These can delete or overwrite data';
export const NOT_CONNECTED_HINT = 'Not connected yet';
export const NO_CONNECTORS_HINT =
  'No connectors yet. Add one in Settings → Connectors.';

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

/** A grant for exactly these names: a set equal to the read-only tools collapses to `'*'`. */
function grantFromNames(
  grant: GrantInput,
  tools: ConnectorToolInfo[],
  next: Set<string>,
): GrantInput {
  const readOnly = tools.filter((item) => item.readOnly).map((t) => t.name);
  const onlyReadOnly =
    next.size === readOnly.length && readOnly.every((name) => next.has(name));
  return { ...grant, tools: onlyReadOnly ? '*' : [...next] };
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
  return grantFromNames(grant, tools, next);
}

/** The grant after ticking every read-only tool, keeping whatever else is ticked. */
export function selectAllReads(
  grant: GrantInput,
  tools: ConnectorToolInfo[],
): GrantInput {
  const next = grantedNames(grant, tools);
  for (const tool of tools) if (tool.readOnly) next.add(tool.name);
  return grantFromNames(grant, tools, next);
}

type ToolGroupKind = 'reads' | 'writes' | 'destructive';

const TOOL_GROUPS: {
  kind: ToolGroupKind;
  title: string;
  caption?: string;
}[] = [
  { kind: 'reads', title: 'Reads' },
  { kind: 'writes', title: 'Changes data', caption: WRITE_WARNING },
  { kind: 'destructive', title: 'Destructive', caption: DESTRUCTIVE_WARNING },
];

function toolKind(tool: ConnectorToolInfo): ToolGroupKind {
  if (tool.readOnly) return 'reads';
  return tool.destructive ? 'destructive' : 'writes';
}

function ToolGroup({
  connectorId,
  kind,
  title,
  caption,
  tools,
  allTools,
  grant,
  names,
  onChange,
}: {
  connectorId: string;
  kind: ToolGroupKind;
  title: string;
  caption?: string;
  tools: ConnectorToolInfo[];
  allTools: ConnectorToolInfo[];
  grant: GrantInput;
  names: Set<string>;
  onChange: (grant: GrantInput) => void;
}) {
  const headingId = useId();
  const missingReads =
    kind === 'reads' && tools.some((tool) => !names.has(tool.name));
  return (
    <div className="dp-tool-group" role="group" aria-labelledby={headingId}>
      <div className="dp-tool-head">
        <span className={`dp-dot dp-dot-${kind}`} aria-hidden="true" />
        <span className="dp-tool-title" id={headingId}>
          {title}
        </span>
        {caption && <span className="dp-tool-caption">{caption}</span>}
        {missingReads && (
          <button
            type="button"
            className="dp-link"
            onClick={() => onChange(selectAllReads(grant, allTools))}
          >
            Select all reads
          </button>
        )}
      </div>
      <div className="dp-tool-grid">
        {tools.map((tool) => (
          <label
            className="dp-tool"
            data-kind={kind}
            key={`${connectorId}:${tool.toolName}`}
            title={tool.description || undefined}
          >
            <input
              type="checkbox"
              className="dp-check"
              checked={names.has(tool.name)}
              onChange={(event) =>
                onChange(
                  toggleTool(grant, allTools, tool.name, event.target.checked),
                )
              }
            />
            <span className="dp-tool-text">
              <code>{tool.name}</code>
              {tool.description && (
                <span className="dp-tool-desc">{tool.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
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
  const labelId = useId();
  const enabled = connectors.filter((connector) => connector.enabled);
  const replace = (connectorId: string, grant: GrantInput | undefined) =>
    onChange([
      ...value.filter((item) => item.connectorId !== connectorId),
      ...(grant ? [grant] : []),
    ]);
  return (
    <div className="cn-grants dp-root dp-grants">
      <span className="field-label" id={labelId}>
        Connectors
      </span>
      {enabled.length === 0 ? (
        <div className="dp-empty">
          <span className="dp-empty-icon" aria-hidden="true">
            <Plug size={18} strokeWidth={1.8} />
          </span>
          <p>
            {connectors.length === 0
              ? NO_CONNECTORS_HINT
              : 'All connectors are turned off. Turn one on in Settings → Connectors.'}
          </p>
        </div>
      ) : (
        <ul className="dp-connectors" aria-labelledby={labelId}>
          {enabled.map((connector) => (
            <ConnectorRow
              key={connector.id}
              connector={connector}
              grant={value.find((item) => item.connectorId === connector.id)}
              onReplace={(grant) => replace(connector.id, grant)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ConnectorRow({
  connector,
  grant,
  onReplace,
}: {
  connector: ConnectorView;
  grant: GrantInput | undefined;
  onReplace: (grant: GrantInput | undefined) => void;
}) {
  const uid = useId();
  const nameId = `${uid}-name`;
  const switchId = `${uid}-switch`;
  const hintId = `${uid}-hint`;
  const connected = connector.status.state === 'connected';
  const tools = connector.status.tools;
  const names = grantedNames(grant, tools);
  const allowed = tools.filter((tool) => names.has(tool.name)).length;
  const hint = !connected
    ? NOT_CONNECTED_HINT
    : grant
      ? `${allowed} of ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'} allowed`
      : 'Off';
  return (
    <li
      className="dp-connector"
      data-connector={connector.name}
      data-on={grant ? 'true' : 'false'}
    >
      <div className="dp-connector-head">
        <ConnectorLogo
          presetId={connector.presetId}
          name={connector.name}
          url={connector.url}
          transport={connector.transport}
          size={40}
        />
        <div className="dp-connector-id">
          <span className="dp-connector-name" id={nameId}>
            {connectorTitle(connector)}
          </span>
          <span className="dp-connector-hint" id={hintId}>
            {connected && (
              <span className="dp-dot dp-dot-live" aria-hidden="true" />
            )}
            {hint}
          </span>
        </div>
        <label className="dp-switch" htmlFor={switchId}>
          <input
            id={switchId}
            type="checkbox"
            role="switch"
            className="dp-sr"
            checked={!!grant}
            aria-labelledby={`${switchId}-text ${nameId}`}
            aria-describedby={hintId}
            onChange={(event) =>
              onReplace(
                event.target.checked
                  ? { connectorId: connector.id, tools: '*' }
                  : undefined,
              )
            }
          />
          <span className="dp-switch-track" aria-hidden="true" />
          <span className="dp-switch-text" id={`${switchId}-text`}>
            Use this connector
          </span>
        </label>
      </div>
      {grant && connected && (
        <div className="dp-tools">
          {tools.length === 0 && (
            <p className="dp-tools-empty">This connector offers no tools.</p>
          )}
          {TOOL_GROUPS.map((group) => {
            const groupTools = tools.filter(
              (tool) => toolKind(tool) === group.kind,
            );
            if (groupTools.length === 0) return null;
            return (
              <ToolGroup
                key={group.kind}
                connectorId={connector.id}
                {...group}
                tools={groupTools}
                allTools={tools}
                grant={grant}
                names={names}
                onChange={onReplace}
              />
            );
          })}
        </div>
      )}
    </li>
  );
}

const APPROVAL_OPTIONS: {
  value: ApprovalMode;
  title: string;
  description: string;
  icon: LucideIcon;
  recommended?: boolean;
}[] = [
  {
    value: 'sensitive',
    title: 'Ask before sensitive actions',
    description:
      'Sending, paying, deleting and destructive commands wait for you.',
    icon: ShieldCheck,
    recommended: true,
  },
  {
    value: 'writes',
    title: 'Ask before any change',
    description: 'Anything that changes data waits for you.',
    icon: PenLine,
  },
  {
    value: 'off',
    title: 'Never ask',
    description:
      'The Dot acts without asking. Password and code steps still come to you.',
    icon: ShieldOff,
  },
];

export function ApprovalModeField({
  value,
  onChange,
}: {
  value: ApprovalMode;
  onChange: (value: ApprovalMode) => void;
}) {
  const uid = useId();
  const labelId = `${uid}-label`;
  return (
    <div className="dp-root dp-approval-field">
      <span className="field-label" id={labelId}>
        Approvals
      </span>
      <div
        className="dp-approval"
        id="dot-approval-mode"
        role="radiogroup"
        aria-labelledby={labelId}
      >
        {APPROVAL_OPTIONS.map((option) => {
          const selected = option.value === value;
          const descId = `${uid}-${option.value}-desc`;
          const Icon = option.icon;
          return (
            <label
              className="dp-option"
              data-selected={selected ? 'true' : 'false'}
              data-mode={option.value}
              key={option.value}
            >
              <input
                type="radio"
                className="dp-sr"
                name={`${uid}-approval`}
                value={option.value}
                checked={selected}
                aria-describedby={descId}
                onChange={() => onChange(option.value)}
              />
              <span className="dp-option-top">
                <span className="dp-option-icon" aria-hidden="true">
                  <Icon size={18} strokeWidth={1.8} />
                </span>
                {option.recommended && (
                  <span className="dp-chip">Recommended</span>
                )}
                <span className="dp-radio" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
              </span>
              <span className="dp-option-title">{option.title}</span>
              <span className="dp-option-desc" id={descId}>
                {option.description}
              </span>
            </label>
          );
        })}
      </div>
      {value === 'off' && (
        <p className="dp-warning" role="alert">
          <TriangleAlert size={16} strokeWidth={1.9} aria-hidden="true" />
          <span>
            The Dot will send, pay, delete and publish without asking. Handoff
            for passwords and codes still applies.
          </span>
        </p>
      )}
    </div>
  );
}
