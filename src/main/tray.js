import { Menu, Tray, nativeImage, shell } from 'electron';
import path from 'node:path';
import { formatClock } from '../shared/time.js';

const assets = path.join(import.meta.dirname, '../../assets');
const isMac = process.platform === 'darwin';

/** @param {string} name */
function icon(name) {
  const image = nativeImage.createFromPath(path.join(assets, name));
  if (isMac && name.includes('Template')) image.setTemplateImage(true);
  return image;
}

/**
 * Menu-bar / system-tray icon: the always-reachable remote control, and the
 * way to stop a recording while the main window is hidden.
 */
export class AppTray {
  /**
   * @param {{ controller: import('./controller.js').Controller, windows: import('./windows.js').WindowManager, settings: import('./settings-store.js').SettingsStore, getRecordingsDir: () => string, quit: () => void }} o
   */
  constructor({ controller, windows, settings, getRecordingsDir, quit }) {
    this.controller = controller;
    this.windows = windows;
    this.settings = settings;
    this.getRecordingsDir = getRecordingsDir;
    this.quit = quit;
    this.idleIcon = icon(isMac ? 'trayTemplate.png' : 'tray.png');
    // The macOS menu bar wants an 18pt image; other trays a 32px one.
    this.recIcon = icon(isMac ? 'tray-rec-mac.png' : 'tray-rec.png');
    /** @type {Tray | null} */
    this.tray = null;
    this._menuKey = '';
    try {
      this.tray = new Tray(this.idleIcon);
      this.tray.setToolTip('Freeloomz');
      // Windows: left-click stops a recording or opens the window; the menu
      // is on right-click. On macOS a click opens the menu itself, so a
      // click action there would fire on the way to "Pause" — menu only.
      if (process.platform === 'win32') {
        this.tray.on('click', () => {
          if (this.controller.isCapturing) this.controller.stop();
          else this.windows.showControl();
        });
      }
      this.update(controller.snapshot());
    } catch (err) {
      // Some Linux desktops have no tray at all. Not fatal.
      console.warn('[tray] unavailable:', err);
    }
  }

  /** @param {ReturnType<import('./controller.js').Controller['snapshot']>} state */
  update(state) {
    if (!this.tray || this.tray.isDestroyed()) return;
    const capturing = state.status === 'recording' || state.status === 'paused';
    const s = this.settings.get();
    const sc = s.shortcuts;

    if (isMac) this.tray.setTitle(capturing ? ` ${formatClock(state.elapsedMs, { padMinutes: true })}` : '');
    this.tray.setToolTip(
      capturing
        ? `Freeloomz — ${state.status === 'paused' ? 'paused' : 'recording'} ${formatClock(state.elapsedMs)}`
        : 'Freeloomz',
    );

    // Rebuilding the menu closes it if it is open, so only do it when
    // something other than the clock changed.
    const key = [state.status, state.micMuted, state.drawing, s.bubble.visible, s.mode, JSON.stringify(sc)].join('|');
    if (key === this._menuKey) return;
    this._menuKey = key;
    this.tray.setImage(capturing ? this.recIcon : this.idleIcon);

    const cmd = (name) => () => this.controller.command(name).catch((err) => console.error('[tray]', err));
    const accel = (a) => (a ? { accelerator: a } : {});
    const busy = state.status === 'stopping' || state.status === 'finalizing' || state.status === 'preparing';

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        capturing || state.status === 'countdown'
          ? { label: state.status === 'countdown' ? 'Cancel countdown' : 'Stop and save', click: cmd('stop'), ...accel(sc.toggleRecord) }
          : { label: 'Start recording', click: cmd('start'), enabled: !busy, ...accel(sc.toggleRecord) },
        {
          label: state.status === 'paused' ? 'Resume' : 'Pause',
          click: cmd('togglePause'),
          enabled: capturing,
          ...accel(sc.togglePause),
        },
        { label: 'Add chapter marker', click: cmd('addMarker'), enabled: capturing, ...accel(sc.addMarker) },
        { type: 'separator' },
        {
          label: 'Camera bubble',
          type: 'checkbox',
          checked: s.bubble.visible && s.mode === 'screen+camera',
          enabled: s.mode === 'screen+camera',
          click: cmd('toggleCamera'),
          ...accel(sc.toggleCamera),
        },
        { label: 'Mute microphone', type: 'checkbox', checked: state.micMuted, enabled: capturing, click: cmd('toggleMic'), ...accel(sc.toggleMic) },
        { label: 'Draw on screen', type: 'checkbox', checked: state.drawing, click: cmd('toggleDraw'), ...accel(sc.toggleDraw) },
        { type: 'separator' },
        { label: 'Open Freeloomz', click: () => this.windows.showControl() },
        { label: 'Open recordings folder', click: () => shell.openPath(this.getRecordingsDir()) },
        { type: 'separator' },
        { label: 'Quit Freeloomz', click: () => this.quit() },
      ]),
    );
  }

  destroy() {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }
}
