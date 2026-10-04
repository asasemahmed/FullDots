import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { MoreHorizontal } from 'lucide-react';

export interface RowMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  onSelect: () => void;
}

/**
 * A small "..." actions menu. The popup is portalled to <body> so scrolling
 * lists and the mobile drawer's transform can never clip or offset it.
 */
export function RowMenu({
  label,
  items,
  className = '',
  onOpenChange,
}: {
  label: string;
  items: RowMenuItem[];
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const change = useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const close = useCallback(
    (restoreFocus: boolean) => {
      change(false);
      if (restoreFocus) trigger.current?.focus();
    },
    [change],
  );
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const anchor = trigger.current.getBoundingClientRect();
    const { width, height } = menu.current.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(anchor.right - width, innerWidth - width - 8),
    );
    const below = anchor.bottom + 4;
    const top =
      below + height > innerHeight - 8
        ? Math.max(8, anchor.top - height - 4)
        : below;
    setPosition({ top, left });
    menu.current.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menu.current?.contains(target) && !trigger.current?.contains(target))
        change(false);
    };
    const dismiss = () => change(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
    };
  }, [open, change]);
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [
      ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ??
        []),
    ];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      entries[(to + entries.length) % entries.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(index + 1);
    else if (event.key === 'ArrowUp') move(index - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(-1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      // Claimed here so the mobile drawer's own Escape handler stays out of it.
      event.preventDefault();
      event.stopPropagation();
      close(true);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`sb-icon sb-more ${open ? 'open' : ''} ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close(false) : change(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            change(true);
          }
        }}
      >
        <MoreHorizontal size={16} aria-hidden />
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="sb-menu"
            role="menu"
            aria-label={label}
            style={{ top: position.top, left: position.left }}
            onKeyDown={keys}
          >
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`sb-menu-item ${item.danger ? 'danger' : ''}`}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
