// The chat header's group strip: overlapping mini characters of the host and the participants (names
// on hover and focus), a remove button per participant and "+" to add a Dot (the owner confirms).
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Plus, X } from 'lucide-react';
import type { Dot } from '../../shared/types';
import { Mascot, dotPalette, dotLook } from '../Mascot';
import { roleLine } from './mentions';
import './room.css';

export function ParticipantStrip({
  host,
  participants,
  dots,
  runningDotId,
  onAdd,
  onRemove,
  disabled = false,
}: {
  host: Dot;
  participants: readonly Dot[];
  /** Every Dot, for the add menu. */
  dots: readonly Dot[];
  /** The Dot whose turn runs in this chat right now. */
  runningDotId?: string | null;
  onAdd(dotId: string): void;
  onRemove(dotId: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const members = participants.length ? [host, ...participants] : [];
  const candidates = dots.filter(
    (dot) =>
      dot.id !== host.id && !participants.some((item) => item.id === dot.id),
  );
  useEffect(() => {
    if (open) menu.current?.querySelector('button')?.focus();
  }, [open]);
  const close = () => {
    setOpen(false);
    toggle.current?.focus();
  };
  return (
    <div className="fd-room-strip" role="group" aria-label="Dots in this chat">
      {members.length > 0 && (
        <ul className="fd-room-avatars">
          {members.map((dot, index) => {
            const isHost = dot.id === host.id;
            return (
              <li
                key={dot.id}
                className="fd-room-avatar"
                style={
                  {
                    '--fd-author': dotPalette(dot).base,
                    zIndex: members.length - index,
                  } as CSSProperties
                }
                title={isHost ? `${dot.name} (host)` : dot.name}
              >
                <Mascot
                  identity={dot.id}
                  {...dotLook(dot)}
                  name={dot.name}
                  small
                  state={runningDotId === dot.id ? 'working' : 'idle'}
                />
                <span className="fd-room-name">
                  {dot.name}
                  {isHost ? ' (host)' : ''}
                </span>
                {!isHost && (
                  <button
                    type="button"
                    className="fd-room-remove"
                    aria-label={`Remove ${dot.name} from this chat`}
                    disabled={disabled || runningDotId === dot.id}
                    onClick={() => onRemove(dot.id)}
                  >
                    <X size={10} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <button
        ref={toggle}
        type="button"
        className="icon-button fd-room-add"
        aria-label="Add a Dot to this chat"
        title="Add a Dot to this chat"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || !candidates.length}
        onClick={() => setOpen(!open)}
      >
        <Plus size={16} />
      </button>
      {open && (
        <div
          ref={menu}
          id={menuId}
          className="fd-room-menu"
          role="group"
          aria-label="Add a Dot"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
        >
          {candidates.map((dot) => (
            <button
              key={dot.id}
              type="button"
              onClick={() => {
                setOpen(false);
                onAdd(dot.id);
              }}
            >
              <Mascot
                identity={dot.id}
                {...dotLook(dot)}
                name={dot.name}
                small
                decorative
              />
              <span className="fd-mention-text">
                <span className="fd-mention-name">{dot.name}</span>
                <span className="fd-mention-role">
                  {roleLine(dot.instructions)}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
