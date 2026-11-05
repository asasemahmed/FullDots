// The owner's one confirm before a Dot joins a chat: mentions never add a Dot by themselves.
import { useEffect, useRef } from 'react';
import type { Dot } from '../../shared/types';
import { Mascot, dotLook } from '../Mascot';
import { useModalDialog } from '../useModalDialog';
import './room.css';

export function AddDotDialog({
  dot,
  onAdd,
  onCancel,
  busy = false,
}: {
  dot: Pick<Dot, 'id' | 'name' | 'color'>;
  onAdd(): void;
  onCancel(): void;
  busy?: boolean;
}) {
  const add = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  // Escape cancels, Tab stays inside, and focus goes back to the composer afterwards.
  const modal = useModalDialog(dialog, {
    onClose: onCancel,
    initialFocus: false,
  });
  useEffect(() => {
    // After the keypress that sent the message has settled, so the composer does not take it back.
    const timer = setTimeout(() => add.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);
  const titleId = `fd-add-dot-${dot.id}`;
  return (
    <div
      className="fd-add-dot-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialog}
        className="fd-add-dot"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-text`}
        tabIndex={-1}
        onKeyDown={modal.onKeyDown}
      >
        <Mascot
          identity={dot.id}
          {...dotLook(dot)}
          name={dot.name}
          state="receiving"
          decorative
        />
        <h2 id={titleId}>Add {dot.name} to this chat?</h2>
        <p id={`${titleId}-text`}>It will see the whole conversation.</p>
        <div className="fd-add-dot-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={add}
            type="button"
            className="primary"
            disabled={busy}
            onClick={onAdd}
          >
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
