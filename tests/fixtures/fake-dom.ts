// A small stand-in for the browser's focus and keyboard behaviour, enough to test focus traps
// without a DOM library: elements with attributes, focus(), Tab moving through the page, and
// keydown bubbling through React's onKeyDown handlers before it reaches the document.
//
// `mountTree` mirrors a react-test-renderer tree into fake elements, so a component's refs (via
// `createNodeMock`) and `document.activeElement` point at the same objects.
import type { ReactElement } from 'react';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

type Props = Record<string, unknown>;
type Listener = (event: FakeKeyEvent) => void;

export interface FakeKeyEvent {
  key: string;
  shiftKey: boolean;
  target: FakeElement;
  defaultPrevented: boolean;
  isComposing: boolean;
  nativeEvent: { isComposing: boolean };
  preventDefault(): void;
  stopPropagation(): void;
}

const NATIVE = new Set(['button', 'select', 'textarea', 'summary', 'iframe']);

export class FakeElement {
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  attrs = new Map<string, string>();
  props: Props = {};
  type = '';
  name = '';
  checked = false;
  disabled = false;
  hidden = false;
  isContentEditable = false;

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  append(...kids: FakeElement[]): this {
    for (const kid of kids) {
      kid.parent = this;
      this.children.push(kid);
    }
    return this;
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  get id(): string {
    return this.attrs.get('id') ?? '';
  }
  get isConnected(): boolean {
    return this.parent
      ? this.parent.isConnected
      : this === this.ownerDocument.body;
  }
  matches(selector: string): boolean {
    if (selector !== ':disabled') return false;
    if (this.disabled) return true;
    for (let node = this.parent; node; node = node.parent)
      if (node.tagName === 'FIELDSET' && node.disabled) return true;
    return false;
  }
  closest(selector: string): FakeElement | null {
    const attr = /^\[([a-z-]+)\]$/.exec(selector)?.[1];
    if (attr && this.attrs.has(attr)) return this;
    return this.parent?.closest(selector) ?? null;
  }
  private get hiddenHere(): boolean {
    return this.hidden || (this.parent?.hiddenHere ?? false);
  }
  getClientRects(): object[] {
    return this.isConnected && !this.hiddenHere ? [{}] : [];
  }
  /** Every element below this one, in document order (the selector is not parsed). */
  querySelectorAll(_selector?: string): FakeElement[] {
    return this.children.flatMap((kid) => [kid, ...kid.querySelectorAll()]);
  }
  contains(other: unknown): boolean {
    for (let node = other as FakeElement | null; node; node = node.parent)
      if (node === this) return true;
    return false;
  }
  compareDocumentPosition(other: FakeElement): number {
    const order = this.ownerDocument.body.querySelectorAll();
    return order.indexOf(other) > order.indexOf(this) ? 4 : 2;
  }
  /** Focusable at all (Tab may still skip it when its tabindex is negative). */
  get focusable(): boolean {
    const tag = this.tagName.toLowerCase();
    const native =
      NATIVE.has(tag) ||
      (tag === 'input' && this.type !== 'hidden') ||
      ((tag === 'a' || tag === 'area') && this.attrs.has('href'));
    return (
      (native || this.attrs.has('tabindex')) &&
      !this.matches(':disabled') &&
      this.getClientRects().length > 0
    );
  }
  focus(): void {
    if (this.focusable) this.ownerDocument.activeElement = this;
  }
  blur(): void {
    if (this.ownerDocument.activeElement === this)
      this.ownerDocument.activeElement = this.ownerDocument.body;
  }
}

export class FakeDocument {
  readonly body: FakeElement = new FakeElement(this, 'BODY');
  /** Enough of <html> for the theme code: a dataset and a style. */
  readonly documentElement = Object.assign(new FakeElement(this, 'HTML'), {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  });
  private active: FakeElement = this.body;
  private listeners = new Set<Listener>();
  /** Mirrors the latest render; called before each key press and each look at the focus. */
  refresh: () => void = () => {};

  /** Like the browser: a focused element that was removed leaves focus on the body. */
  get activeElement(): FakeElement {
    this.refresh();
    if (!this.active.isConnected) this.active = this.body;
    return this.active;
  }
  set activeElement(el: FakeElement) {
    this.active = el;
  }

  createElement(tag: string, attrs: Record<string, string> = {}): FakeElement {
    const el = new FakeElement(this, tag.toUpperCase());
    for (const [key, value] of Object.entries(attrs)) el.attrs.set(key, value);
    return el;
  }
  addEventListener(type: string, listener: Listener): void {
    if (type === 'keydown') this.listeners.add(listener);
  }
  removeEventListener(type: string, listener: Listener): void {
    if (type === 'keydown') this.listeners.delete(listener);
  }
  getElementById(id: string): FakeElement | null {
    return this.body.querySelectorAll().find((el) => el.id === id) ?? null;
  }
  querySelector(): null {
    return null;
  }
  dispatchEvent(): boolean {
    return true;
  }
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * One key press, as the browser and React see it: React's onKeyDown handlers from the focused
   * element up, then the document's listeners, then the default action (Tab moves focus).
   */
  press(key: string, { shiftKey = false } = {}): FakeKeyEvent {
    this.refresh();
    let stopped = false;
    const event: FakeKeyEvent = {
      key,
      shiftKey,
      target: this.activeElement,
      defaultPrevented: false,
      isComposing: false,
      nativeEvent: { isComposing: false },
      preventDefault() {
        event.defaultPrevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
    };
    for (
      let node: FakeElement | null = this.activeElement;
      node && !stopped;
      node = node.parent
    ) {
      const handler = node.props.onKeyDown;
      if (typeof handler === 'function') handler(event);
    }
    if (!stopped) for (const listener of [...this.listeners]) listener(event);
    if (key === 'Tab' && !event.defaultPrevented) this.tabFrom(shiftKey);
    return event;
  }

  /** What the browser does on an unhandled Tab: the next control in the whole page, or none. */
  private tabFrom(back: boolean): void {
    const stops = this.body
      .querySelectorAll()
      .filter(
        (el) => el.focusable && Number(el.getAttribute('tabindex') ?? 0) >= 0,
      );
    const order = this.body.querySelectorAll();
    const at = order.indexOf(this.activeElement);
    const next = back
      ? stops.filter((el) => order.indexOf(el) < at).at(-1)
      : stops.find((el) => order.indexOf(el) > at);
    this.activeElement = next ?? this.body;
  }
}

const ATTRS: Record<string, string> = {
  tabIndex: 'tabindex',
  htmlFor: 'for',
  className: 'class',
};

function isHost(node: ReactTestInstance | string): node is ReactTestInstance {
  return typeof node !== 'string';
}

function hostChildren(inst: ReactTestInstance): ReactTestInstance[] {
  return inst.children
    .filter(isHost)
    .flatMap((kid) =>
      typeof kid.type === 'string' ? [kid] : hostChildren(kid),
    );
}

/**
 * Mirrors what `renderer` shows into `doc.body` (after the elements already there), keeping one
 * fake element per host node across renders. Returns `createNodeMock`'s partner: a lookup from a
 * React element's props to its fake element.
 */
export function mountTree(doc: FakeDocument) {
  const fakes = new WeakMap<ReactTestInstance, FakeElement>();
  const byProps = new WeakMap<object, FakeElement>();
  let mounted: FakeElement[] = [];
  let renderer: ReactTestRenderer | undefined;

  const build = (inst: ReactTestInstance): FakeElement => {
    let el = fakes.get(inst);
    if (!el) {
      el = new FakeElement(doc, String(inst.type).toUpperCase());
      fakes.set(inst, el);
    }
    const props = inst.props as Props;
    el.props = props;
    el.attrs.clear();
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (typeof value === 'function' || key === 'children' || key === 'style')
        continue;
      const name = ATTRS[key] ?? key;
      if (name === 'contentEditable') el.attrs.set('contenteditable', '');
      else el.attrs.set(name, value === true ? '' : String(value));
    }
    el.type = String(props.type ?? (el.tagName === 'INPUT' ? 'text' : ''));
    el.name = String(props.name ?? '');
    el.checked = !!(props.checked ?? props.defaultChecked);
    el.disabled = !!props.disabled;
    el.hidden =
      !!props.hidden ||
      (props.style as { display?: string } | undefined)?.display === 'none';
    for (const kid of el.children) kid.parent = null; // removed ones stay detached
    el.children = [];
    for (const kid of hostChildren(inst)) el.append(build(kid));
    byProps.set(props, el);
    return el;
  };

  const sync = () => {
    if (!renderer) return;
    let roots: ReactTestInstance[];
    try {
      roots = hostChildren(renderer.root);
    } catch {
      roots = []; // unmounted
    }
    for (const el of mounted) el.parent = null;
    doc.body.children = doc.body.children.filter((el) => !mounted.includes(el));
    mounted = roots.map(build);
    doc.body.append(...mounted);
  };
  doc.refresh = sync;

  // The props createNodeMock saw may belong to an earlier render: find the element by its ref,
  // which React 19 passes as a prop and which stays the same object across renders.
  const sameProps = (props: object): FakeElement | undefined => {
    const ref = (props as Props).ref;
    if (!ref) return undefined;
    return doc.body.querySelectorAll().find((el) => el.props.ref === ref);
  };

  return {
    /** Pass to `create(..., { createNodeMock })`. */
    createNodeMock(element: ReactElement): FakeElement {
      let resolved: FakeElement | undefined;
      const resolve = () => {
        if (!resolved) {
          sync();
          const props = element.props as object;
          resolved = byProps.get(props) ?? sameProps(props);
        }
        if (!resolved) throw new Error('no fake element for this ref yet');
        return resolved;
      };
      return new Proxy({} as FakeElement, {
        get(_target, key) {
          const real = resolve();
          const value = Reflect.get(real, key);
          return typeof value === 'function' ? value.bind(real) : value;
        },
      });
    },
    attach(next: ReactTestRenderer) {
      renderer = next;
      sync();
    },
    sync,
    /** The fake element for a rendered host node. */
    el(inst: ReactTestInstance): FakeElement {
      sync();
      const found = fakes.get(inst);
      if (!found) throw new Error('not rendered');
      return found;
    },
  };
}
