// One animation loop for every penguin on the page. A character draws only while it is on screen
// and the tab is visible, small ones at the frame rate their state needs, and a change of state
// blends from the frame that is showing. With reduced motion each state is drawn once, at rest.
import {
  PENGUIN_STATES,
  easeOutQuint,
  lerpPose,
  penguinMarkup,
  poseAt,
  restPose,
  type PenguinLook,
  type PenguinState,
  type PenguinVariant,
  type Pose,
  type StateDef,
} from './engine';

export interface LiveOptions {
  look: PenguinLook;
  state: PenguinState;
  variant: PenguinVariant;
  /** Large characters run at full frame rate and their eyes follow the pointer when idle. */
  large: boolean;
  rim: boolean;
}

const live = new Set<LiveDot>();
let frame = 0;
let pointer: [number, number] | null = null;

const reducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

let observer: IntersectionObserver | undefined;
function watch(dot: LiveDot) {
  if (typeof IntersectionObserver === 'undefined') return;
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries)
      for (const dot of live)
        if (dot.el === entry.target) dot.visible = entry.isIntersecting;
  });
  observer.observe(dot.el);
}

function onPointer(event: PointerEvent) {
  pointer = [event.clientX, event.clientY];
}

function loop(now: number) {
  frame = 0;
  if (!document.hidden) for (const dot of live) dot.tick(now);
  if (live.size && !reducedMotion()) frame = requestAnimationFrame(loop);
}
function start() {
  if (!frame && live.size && !reducedMotion())
    frame = requestAnimationFrame(loop);
}

export class LiveDot {
  visible = true;
  private options: LiveOptions;
  private t0: number;
  private from: Pose | null = null;
  private changeAt = 0;
  private last: Pose;
  private lastDraw = 0;
  private markup = '';
  private gaze: [number, number] = [0, 0];

  constructor(
    readonly el: SVGSVGElement,
    private readonly id: string,
    options: LiveOptions,
  ) {
    this.options = options;
    const def = PENGUIN_STATES[options.state] as StateDef;
    // A character that appears already in a state starts settled, so a list of finished Dots does
    // not all burst into confetti at once.
    this.t0 = performance.now() - def.rest * 1000;
    this.last = restPose(options.state);
    if (live.size === 0) addEventListener('pointermove', onPointer);
    live.add(this);
    watch(this);
    start();
  }

  update(options: LiveOptions) {
    const previous = this.options;
    this.options = options;
    if (options.state !== previous.state) {
      const now = performance.now();
      this.from = this.last;
      this.changeAt = now;
      this.t0 = now;
    }
    this.lastDraw = 0;
    if (reducedMotion()) this.draw(restPose(options.state));
    else start();
  }

  destroy() {
    live.delete(this);
    observer?.unobserve(this.el);
    if (live.size === 0) removeEventListener('pointermove', onPointer);
  }

  tick(now: number) {
    if (!this.visible) return;
    const { state, large } = this.options;
    const def = PENGUIN_STATES[state] as StateDef;
    if (now - this.lastDraw < 1000 / (large ? 60 : def.fps)) return;
    this.lastDraw = now;
    let pose = poseAt(state, (now - this.t0) / 1000, {
      gaze: large ? this.followGaze() : null,
    });
    if (this.from) {
      const k = (now - this.changeAt) / (def.morph * 1000);
      if (k < 1) pose = lerpPose(this.from, pose, easeOutQuint(k));
      else this.from = null;
    }
    this.last = pose;
    this.draw(pose);
  }

  private followGaze(): [number, number] {
    if (!pointer) return this.gaze;
    const box = this.el.getBoundingClientRect();
    const reach = Math.max(box.width, 1) * 0.9;
    const target: [number, number] = [
      Math.max(
        -1,
        Math.min(1, (pointer[0] - (box.left + box.width / 2)) / reach),
      ) * 3.4,
      Math.max(
        -1,
        Math.min(1, (pointer[1] - (box.top + box.height * 0.52)) / reach),
      ) * 2.8,
    ];
    this.gaze = [
      this.gaze[0] + (target[0] - this.gaze[0]) * 0.18,
      this.gaze[1] + (target[1] - this.gaze[1]) * 0.18,
    ];
    return this.gaze;
  }

  private draw(pose: Pose) {
    const { look, variant, rim } = this.options;
    const markup = penguinMarkup(look, pose, variant, { id: this.id, rim });
    if (markup === this.markup) return;
    this.markup = markup;
    this.el.innerHTML = markup;
  }
}
