// One motion vocabulary for the whole app. Every appearance and
// disappearance — a tab, a sheet, a toast, a banner — goes through `enter`
// and `leave`, so timing and feel are identical everywhere instead of being
// re-invented per component.
//
// Rules of the house:
//  • things arrive: fade in while settling a few pixels upward, gently;
//  • things leave: fade out faster than they arrived, and never block;
//  • only opacity and transform are animated (cheap, never janky);
//  • people who asked their OS for less motion get plain cross-fades.

export const DURATION = { fast: 130, base: 220, slow: 380 };
export const EASE = {
  /** Decelerating — for anything arriving. */
  out: 'cubic-bezier(0.22, 1, 0.36, 1)',
  /** Accelerating — for anything leaving. */
  in: 'cubic-bezier(0.5, 0, 0.75, 0)',
  /** A touch of overshoot — for things that should feel physical. */
  spring: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
};

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** @param {Element} el */
function cancelAll(el) {
  for (const animation of el.getAnimations()) animation.cancel();
}

/**
 * Reveals an element.
 * @param {HTMLElement} el
 * @param {{ y?: number, scale?: number, duration?: number, delay?: number, easing?: string }} [o]
 */
export function enter(el, o = {}) {
  const { y = 10, scale = 1, duration = DURATION.base, delay = 0, easing = EASE.out } = o;
  cancelAll(el);
  el.hidden = false;
  const from = reduced() ? { opacity: 0 } : { opacity: 0, transform: `translateY(${y}px) scale(${scale})` };
  const to = reduced() ? { opacity: 1 } : { opacity: 1, transform: 'translateY(0) scale(1)' };
  return el.animate([from, to], { duration, delay, easing, fill: 'backwards' });
}

/**
 * Hides an element; resolves once it is gone. Safe to call on something
 * already hidden.
 * @param {HTMLElement} el
 * @param {{ y?: number, scale?: number, duration?: number }} [o]
 */
export async function leave(el, o = {}) {
  if (el.hidden) return;
  const { y = -6, scale = 1, duration = DURATION.fast } = o;
  cancelAll(el);
  const to = reduced() ? { opacity: 0 } : { opacity: 0, transform: `translateY(${y}px) scale(${scale})` };
  const animation = el.animate([{ opacity: 1 }, to], { duration, easing: EASE.in, fill: 'forwards' });
  try {
    await animation.finished;
  } catch {
    return; // interrupted by a newer transition, which now owns the element
  }
  el.hidden = true;
  animation.cancel();
}

/**
 * Shows exactly one of a set of sibling panels, cross-fading between them.
 * Calling `show` with the panel that is already up does nothing, so it is
 * safe to call on every state update; rapid changes settle on the last one.
 * @param {HTMLElement[]} panels
 * @param {{ y?: number, scale?: number, onEnter?: (panel: HTMLElement) => void }} [o]
 */
export function switcher(panels, o = {}) {
  let current = panels.find((p) => !p.hidden) ?? null;
  let wanted = current;
  let running = false;

  async function run() {
    if (running) return;
    running = true;
    while (wanted !== current) {
      const next = wanted;
      if (current) await leave(current, { y: -4, scale: o.scale ? 1 / o.scale : 1 });
      // Something newer may have been asked for while the old one left.
      if (next !== wanted) continue;
      for (const p of panels) if (p !== next) p.hidden = true;
      if (next) {
        enter(next, { y: o.y ?? 10, scale: o.scale ?? 1 });
        o.onEnter?.(next);
      }
      current = next;
    }
    running = false;
  }

  return {
    /** @param {HTMLElement | null} panel @param {{ instant?: boolean }} [opts] */
    show(panel, opts = {}) {
      if (panel === wanted) return false;
      wanted = panel;
      if (opts.instant) {
        for (const p of panels) {
          cancelAll(p);
          p.hidden = p !== panel;
        }
        current = panel;
        return true;
      }
      run();
      return true;
    },
    get current() {
      return wanted;
    },
  };
}

/**
 * Reveals a list's children one after another — a quick cascade, capped so
 * a long list never keeps you waiting.
 * @param {Iterable<Element>} children
 * @param {{ step?: number, max?: number }} [o]
 */
export function stagger(children, o = {}) {
  const { step = 34, max = 8 } = o;
  let i = 0;
  for (const child of children) {
    const node = /** @type {HTMLElement} */ (child);
    if (node.hidden) continue; // hidden on purpose; not ours to reveal
    enter(node, { y: 8, delay: Math.min(i, max) * step });
    i += 1;
  }
}

/**
 * Slides the highlight of a segmented control or tab bar under its active
 * button. The control needs a `.thumb` element and `position: relative`.
 * @param {HTMLElement} container
 * @param {string} [activeSelector]
 */
export function syncThumb(container, activeSelector = '[aria-pressed="true"]') {
  const thumb = /** @type {HTMLElement | null} */ (container.querySelector(':scope > .thumb'));
  const active = /** @type {HTMLElement | null} */ (container.querySelector(`:scope > ${activeSelector}`));
  if (!thumb) return;
  if (!active || active.offsetWidth === 0) {
    if (!active) thumb.style.opacity = '0';
    return; // hidden right now; will be synced when it becomes visible
  }
  // First placement should not animate in from the corner.
  const first = !thumb.dataset.placed;
  if (first) thumb.style.transition = 'none';
  thumb.style.opacity = '1';
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.height = `${active.offsetHeight}px`;
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  if (first) {
    thumb.dataset.placed = '1';
    void thumb.offsetWidth; // flush, then re-enable transitions
    thumb.style.transition = '';
  }
}
