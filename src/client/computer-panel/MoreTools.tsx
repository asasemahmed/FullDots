import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { MORE_TOOLS, MORE_TOOL_LABELS, type MoreTool } from './model';

/**
 * Files, terminal, activity and precise controls, folded away until wanted.
 *
 * Every panel stays mounted, only hidden, so a half-written command or file is still there when the
 * viewer comes back to it.
 */
export function MoreTools({
  open,
  tool,
  panels,
  onToggle,
  onTool,
}: {
  open: boolean;
  tool: MoreTool;
  panels: Record<MoreTool, ReactNode>;
  onToggle: () => void;
  onTool: (tool: MoreTool) => void;
}) {
  const id = useId();
  const regionId = `${id}-region`;
  const tabId = (name: MoreTool) => `${id}-tab-${name}`;
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const index = MORE_TOOLS.indexOf(tool);
    let next: number | undefined;
    if (event.key in keys)
      next = (index + keys[event.key] + MORE_TOOLS.length) % MORE_TOOLS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = MORE_TOOLS.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    const name = MORE_TOOLS[next];
    onTool(name);
    document.getElementById(tabId(name))?.focus();
  };
  return (
    <section className="cp-more" data-open={open}>
      <button
        type="button"
        className="cp-more-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={onToggle}
      >
        <span>More tools</span>
        <small>Files, terminal, activity</small>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      <div id={regionId} className="cp-more-region" hidden={!open}>
        <div
          className="cp-segments"
          role="tablist"
          aria-label="More tools"
          onKeyDown={move}
        >
          {MORE_TOOLS.map((name) => (
            <button
              key={name}
              id={tabId(name)}
              type="button"
              role="tab"
              aria-selected={tool === name}
              aria-controls={`${id}-panel-${name}`}
              tabIndex={tool === name ? 0 : -1}
              onClick={() => onTool(name)}
            >
              {MORE_TOOL_LABELS[name]}
            </button>
          ))}
        </div>
        {MORE_TOOLS.map((name) => (
          <div
            key={name}
            id={`${id}-panel-${name}`}
            role="tabpanel"
            aria-labelledby={tabId(name)}
            hidden={tool !== name}
          >
            {panels[name]}
          </div>
        ))}
      </div>
    </section>
  );
}
