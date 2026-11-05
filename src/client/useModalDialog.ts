// The one focus trap every modal dialog uses: focus moves in when it opens, Tab and Shift+Tab wrap
// inside it, Escape closes it, and focus goes back to the control that opened it.
import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react';

/** Where focus starts: the first text field or select, the first control, the dialog, an element, or nowhere. */
export type InitialFocus =
  'field' | 'first' | 'dialog' | false | RefObject<HTMLElement | null>;

export interface ModalDialogOptions {
  /** Escape, unless a control inside handled it first (a list closing, say). */
  onClose: () => void;
  /** Default 'field', falling back to the first control and then the dialog itself. */
  initialFocus?: InitialFocus;
}

/** The keys a dialog reacts to; a DOM or a React keyboard event both fit. */
export interface DialogKeyEvent {
  key: string;
  shiftKey: boolean;
  defaultPrevented: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

const CANDIDATES =
  'a[href],area[href],button,input,select,textarea,summary,iframe,[tabindex],[contenteditable]';
const FIELDS = new Set(['input', 'select', 'textarea']);
// Node.DOCUMENT_POSITION_FOLLOWING, without needing the Node global.
const FOLLOWING = 4;

function naturallyFocusable(el: HTMLElement): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href');
  if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
  return (
    tag === 'button' ||
    tag === 'select' ||
    tag === 'textarea' ||
    tag === 'summary' ||
    tag === 'iframe' ||
    el.isContentEditable === true
  );
}

/** Whether Tab can land on the element: focusable, enabled, not inert and rendered. */
export function isTabbable(el: HTMLElement): boolean {
  const index = el.getAttribute('tabindex');
  if (index !== null && Number(index) < 0) return false;
  if (index === null && !naturallyFocusable(el)) return false;
  if (typeof el.matches === 'function' ? el.matches(':disabled') : false)
    return false;
  if (el.closest('[inert]')) return false;
  // Nothing to draw: display none, a hidden panel, a closed <details>.
  return el.getClientRects().length > 0;
}

/** The controls Tab visits inside `root`, in order. A radio group counts once, as the browser does. */
export function tabbableIn(root: HTMLElement): HTMLElement[] {
  const all = [...root.querySelectorAll<HTMLElement>(CANDIDATES)].filter(
    isTabbable,
  );
  const radios = new Map<string, HTMLInputElement>();
  for (const el of all) {
    const input = el as HTMLInputElement;
    if (input.tagName.toLowerCase() !== 'input' || input.type !== 'radio')
      continue;
    if (!input.name) continue;
    const chosen = radios.get(input.name);
    if (!chosen || (!chosen.checked && input.checked))
      radios.set(input.name, input);
  }
  return all.filter((el) => {
    const input = el as HTMLInputElement;
    if (input.tagName.toLowerCase() !== 'input' || input.type !== 'radio')
      return true;
    return !input.name || radios.get(input.name) === input;
  });
}

/**
 * Keeps Tab inside `root`: from the last control to the first, from the first back to the last,
 * and back in when focus has fallen outside (a removed button leaves it on the page body).
 */
export function trapTab(
  root: HTMLElement,
  event: Pick<DialogKeyEvent, 'shiftKey' | 'preventDefault'>,
  active: Element | null,
): void {
  const items = tabbableIn(root);
  const first = items[0];
  const last = items.at(-1);
  if (!first || !last) {
    event.preventDefault();
    root.focus();
    return;
  }
  const back = event.shiftKey;
  if (!active || active === root || !root.contains(active)) {
    event.preventDefault();
    (back ? last : first).focus();
    return;
  }
  const at = items.indexOf(active as HTMLElement);
  // On something Tab skips (the dialog's own heading, an unchecked radio): wrap only when no
  // control lies beyond it in that direction.
  const atEdge =
    at === -1
      ? back
        ? !items.some(
            (item) => item.compareDocumentPosition(active) & FOLLOWING,
          )
        : !items.some(
            (item) => active.compareDocumentPosition(item) & FOLLOWING,
          )
      : back
        ? at === 0
        : at === items.length - 1;
  if (!atEdge) return;
  event.preventDefault();
  (back ? last : first).focus();
}

function initialTarget(
  root: HTMLElement,
  initial: InitialFocus,
): HTMLElement | null {
  if (initial === false) return null;
  if (initial === 'dialog') return root;
  if (typeof initial === 'object') return initial.current ?? root;
  const items = tabbableIn(root);
  const field =
    initial === 'field'
      ? items.find((el) => FIELDS.has(el.tagName.toLowerCase()))
      : undefined;
  return field ?? items[0] ?? root;
}

// Open dialogs, innermost last: only the top one answers keys.
const open: object[] = [];

/** How many dialogs that use this hook are open (for tests). */
export function openDialogCount(): number {
  return open.length;
}

/**
 * Makes `ref` behave as a modal dialog. Spread the returned `onKeyDown` on the dialog element:
 * keys inside it go through React first, so a control that claims Escape (and prevents its
 * default) keeps the dialog open. Keys from outside it (focus left on the page body) are caught
 * on the document. Give the element `tabIndex={-1}` so it can hold focus when it has no controls.
 */
export function useModalDialog(
  ref: RefObject<HTMLElement | null>,
  { onClose, initialFocus = 'field' }: ModalDialogOptions,
): { onKeyDown: (event: ReactKeyboardEvent) => void } {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  const entry = useRef<object>({});
  const first = useRef(initialFocus);

  const handle = (event: DialogKeyEvent): void => {
    if (event.defaultPrevented || open.at(-1) !== entry.current) return;
    const root = ref.current;
    if (!root) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close.current();
    } else if (event.key === 'Tab') {
      trapTab(root, event, root.ownerDocument.activeElement);
    }
  };
  const handleRef = useRef(handle);
  useEffect(() => {
    handleRef.current = handle;
  });

  useEffect(() => {
    const doc = typeof document === 'undefined' ? undefined : document;
    if (!doc) return;
    const me = entry.current;
    const opener = doc.activeElement as HTMLElement | null;
    open.push(me);
    const root = ref.current;
    if (root) initialTarget(root, first.current)?.focus();
    const outside = (event: KeyboardEvent) => {
      const root = ref.current;
      const target = event.target as Node | null;
      // Keys inside the dialog arrive through its own onKeyDown.
      if (root && target && root.contains(target)) return;
      if ((event as { isComposing?: boolean }).isComposing) return;
      handleRef.current(event);
    };
    doc.addEventListener('keydown', outside);
    return () => {
      doc.removeEventListener('keydown', outside);
      const index = open.indexOf(me);
      if (index !== -1) open.splice(index, 1);
      if (
        opener &&
        opener !== doc.body &&
        opener.isConnected !== false &&
        typeof opener.focus === 'function'
      )
        opener.focus();
    };
  }, [ref]);

  return {
    onKeyDown: (event) => {
      if (event.nativeEvent?.isComposing) return;
      handle(event);
    },
  };
}
