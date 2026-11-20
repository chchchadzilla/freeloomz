// Window geometry for the camera bubble. Pure.

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 */

export const BUBBLE_MARGIN = 24;

/**
 * Keeps `rect` fully inside `area` (as far as its size allows).
 * @param {Rect} rect
 * @param {Rect} area
 * @returns {Rect}
 */
export function clampToArea(rect, area) {
  const maxX = area.x + Math.max(0, area.width - rect.width);
  const maxY = area.y + Math.max(0, area.height - rect.height);
  return {
    ...rect,
    x: Math.round(Math.min(maxX, Math.max(area.x, rect.x))),
    y: Math.round(Math.min(maxY, Math.max(area.y, rect.y))),
  };
}

/**
 * Bottom-left corner of the work area — out of the way of the Windows
 * notification area and of most apps' primary buttons.
 * @param {Rect} area
 * @param {number} size outer window size
 * @returns {{ x: number, y: number }}
 */
export function defaultBubblePosition(area, size, margin = BUBBLE_MARGIN) {
  return {
    x: Math.round(area.x + margin),
    y: Math.round(area.y + area.height - size - margin),
  };
}

/**
 * Snaps a dropped bubble to the nearest corner when it lands close to one;
 * otherwise leaves it where it was dropped (clamped on-screen).
 * @param {Rect} rect
 * @param {Rect} area
 * @param {{ margin?: number, threshold?: number }} [opts]
 * @returns {Rect}
 */
export function snapToCorner(rect, area, opts = {}) {
  const margin = opts.margin ?? BUBBLE_MARGIN;
  const threshold = opts.threshold ?? 90;
  const clamped = clampToArea(rect, area);
  const left = area.x + margin;
  const right = area.x + area.width - rect.width - margin;
  const top = area.y + margin;
  const bottom = area.y + area.height - rect.height - margin;
  const nearX = Math.abs(clamped.x - left) <= Math.abs(clamped.x - right) ? left : right;
  const nearY = Math.abs(clamped.y - top) <= Math.abs(clamped.y - bottom) ? top : bottom;
  if (Math.abs(clamped.x - nearX) <= threshold && Math.abs(clamped.y - nearY) <= threshold) {
    return clampToArea({ ...clamped, x: nearX, y: nearY }, area);
  }
  return clamped;
}

/**
 * Resizes around the rect's centre so the bubble grows in place.
 * @param {Rect} rect
 * @param {number} newSize
 * @returns {Rect}
 */
export function resizeAroundCenter(rect, newSize) {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return {
    x: Math.round(cx - newSize / 2),
    y: Math.round(cy - newSize / 2),
    width: newSize,
    height: newSize,
  };
}

/**
 * Horizontal strips approximating the bubble's outline, for
 * BrowserWindow.setShape on Linux where transparent windows need a
 * compositor. `inset` is the padding between the window edge and the shape.
 * @param {'circle' | 'rounded'} shape
 * @param {number} windowSize
 * @param {number} [inset]
 * @returns {Rect[]}
 */
export function shapeRects(shape, windowSize, inset = 0) {
  const size = windowSize - inset * 2;
  if (size <= 0) return [];
  const radius = shape === 'circle' ? size / 2 : Math.min(size / 2, Math.round(size * 0.18));
  /** @type {Rect[]} */
  const rects = [];
  for (let row = 0; row < size; row += 1) {
    const y = row + 0.5;
    let cut = 0;
    if (y < radius) cut = radius - Math.sqrt(Math.max(0, radius * radius - (radius - y) ** 2));
    else if (y > size - radius) cut = radius - Math.sqrt(Math.max(0, radius * radius - (y - (size - radius)) ** 2));
    // A pixel belongs to the shape when its centre does.
    const x0 = Math.max(0, Math.ceil(cut - 0.5));
    const width = size - 2 * x0;
    if (width <= 0) continue;
    const last = rects[rects.length - 1];
    if (last && last.x === inset + x0 && last.width === width && last.y + last.height === inset + row) {
      last.height += 1; // merge identical neighbouring strips
    } else {
      rects.push({ x: inset + x0, y: inset + row, width, height: 1 });
    }
  }
  return rects;
}

/**
 * Is a point (relative to the bubble window's top-left) on the visible
 * bubble, as opposed to the transparent area around it? The bubble's window
 * is square; only the shape drawn inside it should catch clicks.
 * @param {number} x
 * @param {number} y
 * @param {number} windowSize
 * @param {number} pad   transparent margin between window edge and bubble
 * @param {'circle' | 'rounded'} shape
 * @param {number} [slack] extra pixels of forgiveness around the edge
 */
export function pointInBubble(x, y, windowSize, pad, shape, slack = 2) {
  const size = windowSize - pad * 2;
  if (size <= 0) return false;
  const lx = x - pad;
  const ly = y - pad;
  if (lx < -slack || ly < -slack || lx > size + slack || ly > size + slack) return false;
  const radius = shape === 'circle' ? size / 2 : Math.min(size / 2, Math.round(size * 0.18));
  // Distance to the nearest corner-circle centre; zero along the straight edges.
  const dx = Math.max(radius - lx, 0, lx - (size - radius));
  const dy = Math.max(radius - ly, 0, ly - (size - radius));
  return dx * dx + dy * dy <= (radius + slack) ** 2;
}
