import { BrowserWindow, Menu, screen } from 'electron';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUBBLE_MAX, BUBBLE_MIN, BUBBLE_PRESETS } from '../shared/defaults.js';
import { clampToArea, defaultBubblePosition, resizeAroundCenter, shapeRects, snapToCorner } from '../shared/geometry.js';

const here = import.meta.dirname;
const PRELOAD = path.join(here, '../preload/api.cjs');
const page = (name) => path.join(here, `../renderer/${name}/index.html`);

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
/** Whole-window opacity is only available on macOS and Windows. */
const CAN_FADE = !isLinux;
const waylandSession = isLinux && (process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY));
/**
 * True only when running as a native Wayland client, where apps cannot
 * position their own windows. By default Freeloomz runs through XWayland
 * instead (see main.js), which keeps the bubble placeable and on top.
 */
export const isWayland = waylandSession && Boolean(process.env.FREELOOMZ_NATIVE_WAYLAND);

/**
 * Can this desktop show a see-through, click-through window over the whole
 * screen? Windows and macOS always can. On Linux/X11 it takes a compositor:
 * without one a "transparent" window is solid black, which would black out
 * the screen being recorded — so the cursor highlight and drawing are
 * switched off rather than risked.
 */
export function overlaySupported() {
  if (!isLinux) return true;
  if (isWayland) return false; // cannot be positioned or kept on top
  if (waylandSession) return true; // XWayland is always composited
  const compositors = 'picom|compton|xcompmgr|compiz|kwin_x11|gnome-shell|mutter|muffin|gala|budgie-wm|enlightenment|xfwm4';
  try {
    return spawnSync('pgrep', ['-x', compositors], { stdio: 'ignore', timeout: 2000 }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Space around the bubble inside its (transparent) window, for the drop
 * shadow. Linux gets none: there the window itself is cut to the bubble's
 * outline, which works with or without a compositor.
 */
export const BUBBLE_PAD = isLinux ? 0 : 16;

const webPreferences = () => ({
  preload: PRELOAD,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  // The recorder lives in the control window, which is hidden while
  // recording. It must keep running at full speed.
  backgroundThrottling: false,
});

/** Owns every window and knows how to place them. */
export class WindowManager {
  /**
   * @param {{ settings: import('./settings-store.js').SettingsStore, onControlClose: (event: Electron.Event) => void }} o
   */
  constructor({ settings, onControlClose }) {
    this.settings = settings;
    this.onControlClose = onControlClose;
    /** @type {BrowserWindow | null} */ this.control = null;
    /** @type {BrowserWindow | null} */ this.bubble = null;
    /** @type {BrowserWindow | null} */ this.overlay = null;
    /** @type {BrowserWindow | null} */ this.countdown = null;
    this.drawing = false;
    this._cursorTimer = /** @type {NodeJS.Timeout | null} */ (null);
    this._drag = /** @type {{ dx: number, dy: number } | null} */ (null);
    this._bubbleLeaving = /** @type {NodeJS.Timeout | null} */ (null);
    this._fade = 0;
  }

  // ------------------------------------------------------------- helpers

  /** The display the user chose to record (falls back to the primary). */
  targetDisplay() {
    const wanted = this.settings.get().displayId;
    const all = screen.getAllDisplays();
    return all.find((d) => String(d.id) === wanted) ?? screen.getPrimaryDisplay();
  }

  /** @param {string} channel @param {...any} args */
  broadcast(channel, ...args) {
    for (const win of [this.control, this.bubble, this.overlay]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, ...args);
    }
  }

  /** @param {Electron.WebContents | null | undefined} wc */
  owns(wc) {
    if (!wc) return false;
    return [this.control, this.bubble, this.overlay, this.countdown].some(
      (w) => w && !w.isDestroyed() && w.webContents === wc,
    );
  }

  /** @param {Electron.WebContents | null | undefined} wc */
  isControl(wc) {
    return Boolean(wc && this.control && !this.control.isDestroyed() && this.control.webContents === wc);
  }

  // ------------------------------------------------------------- control

  createControl() {
    if (this.control && !this.control.isDestroyed()) return this.control;
    const win = new BrowserWindow({
      width: 420,
      height: 720,
      minWidth: 400,
      minHeight: 640,
      show: false,
      backgroundColor: '#0b0c10',
      title: 'Freeloomz',
      titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 16, y: 17 } }
        : { titleBarOverlay: { color: '#00000000', symbolColor: '#9aa0ac', height: 48 } }),
      autoHideMenuBar: true,
      ...(isLinux ? { icon: path.join(here, '../../assets/icon.png') } : {}),
      webPreferences: webPreferences(),
    });
    win.once('ready-to-show', () => win.show());
    win.on('close', (event) => this.onControlClose(event));
    win.on('closed', () => {
      this.control = null;
    });
    win.loadFile(page('control'));
    this.control = win;
    return win;
  }

  showControl() {
    const win = this.createControl();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible() && CAN_FADE) {
      // Arrive the way everything else in the app does: with a short fade.
      this._fadeWindow(win, 0, 1, 180);
    }
    win.show();
    win.focus();
  }

  /** Hides the control panel; on macOS and Windows it fades out first. */
  async hideControl() {
    const win = this.control;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (CAN_FADE) await this._fadeWindow(win, 1, 0, 140);
    if (win.isDestroyed()) return;
    win.hide();
    if (CAN_FADE) {
      try {
        win.setOpacity(1);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Animates a window's opacity. A newer fade on the same manager wins.
   * @param {BrowserWindow} win @param {number} from @param {number} to @param {number} ms
   */
  _fadeWindow(win, from, to, ms) {
    const token = ++this._fade;
    return new Promise((resolve) => {
      const started = Date.now();
      const step = () => {
        if (win.isDestroyed() || token !== this._fade) return resolve(undefined);
        const t = Math.min(1, (Date.now() - started) / ms);
        const eased = 1 - (1 - t) ** 3; // ease-out
        try {
          win.setOpacity(from + (to - from) * eased);
        } catch {
          return resolve(undefined);
        }
        if (t >= 1) resolve(undefined);
        else setTimeout(step, 14);
      };
      step();
    });
  }

  // -------------------------------------------------------------- bubble

  /** Outer window size for a given bubble diameter. */
  static bubbleWindowSize(size) {
    return size + BUBBLE_PAD * 2;
  }

  _bubbleBounds() {
    const { bubble } = this.settings.get();
    const outer = WindowManager.bubbleWindowSize(bubble.size);
    let pos;
    if (bubble.x === null || bubble.y === null) {
      const area = this.targetDisplay().workArea;
      const inner = defaultBubblePosition(area, bubble.size);
      pos = { x: inner.x - BUBBLE_PAD, y: inner.y - BUBBLE_PAD };
    } else {
      pos = { x: bubble.x - BUBBLE_PAD, y: bubble.y - BUBBLE_PAD };
    }
    const rect = { ...pos, width: outer, height: outer };
    // A saved position may be on a monitor that is no longer plugged in.
    return clampToArea(rect, screen.getDisplayMatching(rect).workArea);
  }

  /** Shows, hides or re-shapes the bubble to match settings. */
  syncBubble() {
    const s = this.settings.get();
    const wanted = s.bubble.visible && s.mode === 'screen+camera';
    if (!wanted) {
      this._dismissBubble();
      return;
    }
    if (this._bubbleLeaving) {
      // Asked back while it was on its way out: cancel the exit.
      clearTimeout(this._bubbleLeaving);
      this._bubbleLeaving = null;
      if (this.bubble && !this.bubble.isDestroyed()) this.bubble.webContents.send('ui:enter');
    }
    if (!this.bubble || this.bubble.isDestroyed()) {
      this._createBubble();
      return;
    }
    const bounds = this.bubble.getBounds();
    const outer = WindowManager.bubbleWindowSize(s.bubble.size);
    if (bounds.width !== outer) {
      const next = clampToArea(resizeAroundCenter(bounds, outer), screen.getDisplayMatching(bounds).workArea);
      this.bubble.setBounds(next);
      this._rememberBubble(next);
    }
    this._applyBubbleShape();
  }

  /** Lets the bubble fade out before its window goes away. */
  _dismissBubble() {
    const win = this.bubble;
    if (!win || win.isDestroyed()) {
      this.bubble = null;
      return;
    }
    if (this._bubbleLeaving) return;
    win.webContents.send('ui:leave');
    this._bubbleLeaving = setTimeout(() => {
      this._bubbleLeaving = null;
      if (!win.isDestroyed()) win.destroy();
      if (this.bubble === win) this.bubble = null;
    }, 200);
  }

  _createBubble() {
    const bounds = this._bubbleBounds();
    const win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      acceptFirstMouse: true,
      title: 'Freeloomz camera',
      webPreferences: webPreferences(),
    });
    // Float above everything, including full-screen apps, on every desktop.
    win.setAlwaysOnTop(true, 'screen-saver', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.once('ready-to-show', () => win.showInactive());
    win.on('closed', () => {
      if (this.bubble === win) this.bubble = null;
    });
    win.loadFile(page('bubble'));
    this.bubble = win;
    this._applyBubbleShape();
  }

  _applyBubbleShape() {
    if (!isLinux || !this.bubble || this.bubble.isDestroyed()) return;
    const { shape, size } = this.settings.get().bubble;
    try {
      this.bubble.setShape(shapeRects(shape, WindowManager.bubbleWindowSize(size), BUBBLE_PAD));
    } catch {
      /* not supported by this window system; the CSS shape still applies */
    }
  }

  /** @param {{ x: number, y: number }} bounds */
  _rememberBubble(bounds) {
    this.settings.update({ bubble: { x: bounds.x + BUBBLE_PAD, y: bounds.y + BUBBLE_PAD } });
  }

  /**
   * Drag handling. The bubble follows the pointer using absolute screen
   * coordinates read here, so it tracks correctly on mixed-DPI setups.
   * @param {'start' | 'move' | 'end'} phase
   */
  dragBubble(phase) {
    const win = this.bubble;
    if (!win || win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (phase === 'start') {
      const b = win.getBounds();
      this._drag = { dx: cursor.x - b.x, dy: cursor.y - b.y };
      return;
    }
    if (!this._drag) return;
    const size = win.getBounds().width;
    const rect = { x: cursor.x - this._drag.dx, y: cursor.y - this._drag.dy, width: size, height: size };
    if (phase === 'move') {
      win.setBounds(rect);
      return;
    }
    this._drag = null;
    const area = screen.getDisplayNearestPoint(cursor).workArea;
    const inner = { x: rect.x + BUBBLE_PAD, y: rect.y + BUBBLE_PAD, width: size - BUBBLE_PAD * 2, height: size - BUBBLE_PAD * 2 };
    const settled = this.settings.get().bubble.snap ? snapToCorner(inner, area) : clampToArea(inner, area);
    const final = { x: settled.x - BUBBLE_PAD, y: settled.y - BUBBLE_PAD, width: size, height: size };
    win.setBounds(final);
    this._rememberBubble(final);
  }

  /** @param {number} newSize */
  setBubbleSize(newSize) {
    const size = Math.round(Math.min(BUBBLE_MAX, Math.max(BUBBLE_MIN, newSize)));
    this.settings.update({ bubble: { size } });
  }

  /** Right-click menu on the bubble. */
  popupBubbleMenu() {
    const win = this.bubble;
    if (!win || win.isDestroyed()) return;
    const b = this.settings.get().bubble;
    const set = (patch) => this.settings.update({ bubble: patch });
    const corner = (h, v) => () => {
      const area = screen.getDisplayMatching(win.getBounds()).workArea;
      const m = 24;
      const x = h === 'left' ? area.x + m : area.x + area.width - b.size - m;
      const y = v === 'top' ? area.y + m : area.y + area.height - b.size - m;
      win.setBounds({ x: x - BUBBLE_PAD, y: y - BUBBLE_PAD, width: win.getBounds().width, height: win.getBounds().height });
      this._rememberBubble(win.getBounds());
    };
    Menu.buildFromTemplate([
      { label: 'Small', type: 'radio', checked: b.size === BUBBLE_PRESETS.small, click: () => this.setBubbleSize(BUBBLE_PRESETS.small) },
      { label: 'Medium', type: 'radio', checked: b.size === BUBBLE_PRESETS.medium, click: () => this.setBubbleSize(BUBBLE_PRESETS.medium) },
      { label: 'Large', type: 'radio', checked: b.size === BUBBLE_PRESETS.large, click: () => this.setBubbleSize(BUBBLE_PRESETS.large) },
      { type: 'separator' },
      { label: 'Circle', type: 'radio', checked: b.shape === 'circle', click: () => set({ shape: 'circle' }) },
      { label: 'Rounded square', type: 'radio', checked: b.shape === 'rounded', click: () => set({ shape: 'rounded' }) },
      { type: 'separator' },
      { label: 'Mirror my video', type: 'checkbox', checked: b.mirror, click: () => set({ mirror: !b.mirror }) },
      { label: 'Snap to corners', type: 'checkbox', checked: b.snap, click: () => set({ snap: !b.snap }) },
      {
        label: 'Move to corner',
        submenu: [
          { label: 'Bottom left', click: corner('left', 'bottom') },
          { label: 'Bottom right', click: corner('right', 'bottom') },
          { label: 'Top left', click: corner('left', 'top') },
          { label: 'Top right', click: corner('right', 'top') },
        ],
      },
      { type: 'separator' },
      { label: 'Hide camera', click: () => set({ visible: false }) },
    ]).popup({ window: win });
  }

  // ----------------------------------------------------------- countdown

  /**
   * Shows a 3-2-1 on the display being recorded. Resolves true when it ran
   * to the end, false when aborted.
   * @param {number} seconds
   * @param {AbortSignal} signal
   */
  runCountdown(seconds, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const area = this.targetDisplay().bounds;
      const size = 260;
      const win = new BrowserWindow({
        x: Math.round(area.x + (area.width - size) / 2),
        y: Math.round(area.y + (area.height - size) / 2),
        width: size,
        height: size,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: webPreferences(),
      });
      this.countdown = win;
      win.setAlwaysOnTop(true, 'screen-saver', 2);
      win.setIgnoreMouseEvents(true);
      if (isLinux) {
        try {
          win.setShape(shapeRects('circle', size, 10));
        } catch {
          /* ignore */
        }
      }
      let timer = null;
      const finish = (completed) => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        if (!win.isDestroyed()) win.destroy();
        if (this.countdown === win) this.countdown = null;
        resolve(completed);
      };
      const onAbort = () => finish(false);
      signal.addEventListener('abort', onAbort, { once: true });
      win.once('ready-to-show', () => {
        if (signal.aborted) return;
        win.showInactive();
        timer = setTimeout(() => finish(true), seconds * 1000);
      });
      win.loadFile(page('countdown'), { query: { seconds: String(seconds) } });
    });
  }

  // ------------------------------------------------------------- overlay

  /** Full-display, click-through layer for the cursor highlight and drawing. */
  showOverlay() {
    if (this.overlay && !this.overlay.isDestroyed()) return this.overlay;
    const display = this.targetDisplay();
    const win = new BrowserWindow({
      ...display.bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      // Without this the first click on the overlay is swallowed on macOS.
      acceptFirstMouse: true,
      alwaysOnTop: true,
      show: false,
      enableLargerThanScreen: true,
      title: 'Freeloomz overlay',
      webPreferences: webPreferences(),
    });
    win.setAlwaysOnTop(true, 'screen-saver', 0);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setIgnoreMouseEvents(true);
    win.once('ready-to-show', () => {
      win.setBounds(display.bounds); // some window managers shrink it to the work area on creation
      win.showInactive();
      this._sendOverlayMode();
    });
    win.on('closed', () => {
      if (this.overlay === win) this.overlay = null;
      this._stopCursorFeed();
    });
    win.loadFile(page('overlay'));
    this.overlay = win;
    this._startCursorFeed();
    return win;
  }

  hideOverlay() {
    this.drawing = false;
    this._stopCursorFeed();
    if (this.overlay && !this.overlay.isDestroyed()) this.overlay.destroy();
    this.overlay = null;
  }

  /** @param {boolean} on */
  setDrawing(on) {
    this.drawing = on;
    if (on) this.showOverlay();
    const win = this.overlay;
    if (!win || win.isDestroyed()) return;
    win.setIgnoreMouseEvents(!on);
    this._sendOverlayMode();
  }

  _sendOverlayMode() {
    const win = this.overlay;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('overlay:mode', {
      drawing: this.drawing,
      highlight: this.settings.get().cursorHighlight,
    });
  }

  _startCursorFeed() {
    this._stopCursorFeed();
    let last = '';
    this._cursorTimer = setInterval(() => {
      const win = this.overlay;
      if (!win || win.isDestroyed()) return;
      if (!this.settings.get().cursorHighlight || this.drawing) return;
      const p = screen.getCursorScreenPoint();
      const b = win.getBounds();
      const key = `${p.x},${p.y}`;
      if (key === last) return;
      last = key;
      win.webContents.send('overlay:cursor', { x: p.x - b.x, y: p.y - b.y });
    }, 16);
  }

  _stopCursorFeed() {
    if (this._cursorTimer) clearInterval(this._cursorTimer);
    this._cursorTimer = null;
  }

  destroyAll() {
    this._stopCursorFeed();
    if (this._bubbleLeaving) clearTimeout(this._bubbleLeaving);
    for (const win of [this.overlay, this.countdown, this.bubble, this.control]) {
      if (win && !win.isDestroyed()) win.destroy();
    }
  }
}
