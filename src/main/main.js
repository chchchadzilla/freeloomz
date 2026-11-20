import {
  app,
  clipboard,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
  systemPreferences,
  webContents,
} from 'electron';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { SHORTCUT_ACTIONS } from '../shared/defaults.js';
import { chaptersText } from '../shared/time.js';
import { gifArgs, trimArgs } from '../shared/ffargs.js';
import { uniquePath } from '../shared/naming.js';
import { SettingsStore, retryWhileBusy } from './settings-store.js';
import { WindowManager, isWayland, overlaySupported } from './windows.js';
import { Controller, freeSpace, friendly } from './controller.js';
import { Library, isInside } from './library.js';
import { AppTray } from './tray.js';
import { probe, runFfmpeg } from './ffmpeg.js';
import { discardOrphan, finalizeRecording, findOrphans } from './recording-session.js';

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';
const E2E = Boolean(process.env.FREELOOMZ_E2E);

// Recording can be started from a global shortcut or the tray, i.e. without
// a click inside a window — audio must be allowed to start regardless.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// On Linux, run through X11/XWayland: native Wayland does not let an app
// place its own windows or keep them on top, and the camera bubble needs both.
if (process.platform === 'linux' && !process.env.FREELOOMZ_NATIVE_WAYLAND) {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}

// Tests point the app at throwaway folders.
if (process.env.FREELOOMZ_USER_DATA) app.setPath('userData', process.env.FREELOOMZ_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(boot).catch((err) => {
    console.error(err);
    dialog.showErrorBox('Freeloomz could not start', String(err?.stack ?? err));
    app.exit(1);
  });
}

/** macOS can capture what the computer is playing from 14.2 on; Windows always can. */
function systemAudioSupported() {
  if (isWin) return true;
  if (!isMac) return false;
  const [major, minor = 0] = process.getSystemVersion().split('.').map(Number);
  return major > 14 || (major === 14 && minor >= 2);
}

async function boot() {
  const userData = app.getPath('userData');
  const settings = new SettingsStore(path.join(userData, 'settings.json'));
  const library = new Library({
    indexFile: path.join(userData, 'library.json'),
    thumbsDir: path.join(userData, 'thumbnails'),
  });

  const capabilities = {
    platform: process.platform,
    systemAudio: systemAudioSupported(),
    // Windows can hide our own window from the capture; elsewhere the
    // window is simply moved out of the way while recording.
    contentProtection: isWin,
    // Cursor highlight and on-screen drawing need a see-through overlay.
    overlay: overlaySupported(),
    wayland: isWayland,
    version: app.getVersion(),
  };

  const getRecordingsDir = () =>
    process.env.FREELOOMZ_RECORDINGS || settings.get().recordingsDir || path.join(app.getPath('videos'), 'Freeloomz');
  const ensureRecordingsDir = async () => {
    const dir = getRecordingsDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.access(dir, fs.constants.W_OK);
    return dir;
  };

  let quitting = false;
  const quit = () => {
    quitting = true;
    app.quit();
  };

  const windows = new WindowManager({
    settings,
    onControlClose: (event) => {
      if (quitting) return;
      if (controller.busy || isMac) {
        // Never lose a recording to a stray click on the close button.
        event.preventDefault();
        windows.hideControl();
      } else {
        quit();
      }
    },
  });

  // ---------------------------------------------------------- engine RPC
  // The recorder runs in the control window. These calls tell it what to do
  // and wait for its answer.
  let rpcSeq = 0;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  const engine = {
    /** @param {string} name @param {any} [args] @param {number} [timeoutMs] */
    call(name, args = {}, timeoutMs = 15_000) {
      const win = windows.createControl();
      return new Promise((resolve, reject) => {
        const id = ++rpcSeq;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The recorder did not respond (${name}).`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        const send = () => win.webContents.send('engine:cmd', { id, name, args });
        if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
        else send();
      });
    },
  };
  ipcMain.on('engine:reply', (event, reply) => {
    if (!windows.isControl(event.sender)) return;
    const entry = pending.get(reply?.id);
    if (!entry) return;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok) entry.resolve(reply.result);
    else {
      const err = new Error(reply.error?.message ?? 'Recorder error');
      err.name = reply.error?.name ?? 'Error';
      entry.reject(err);
    }
  });

  const controller = new Controller({ settings, windows, library, engine, ensureRecordingsDir, capabilities });
  ipcMain.on('engine:event', (event, payload) => {
    if (windows.isControl(event.sender)) controller.onEngineEvent(payload);
  });

  // The recorder lives in the control window. If that window's process dies
  // mid-recording, everything already written is still a good recording:
  // save it, and bring the window back.
  app.on('render-process-gone', (_event, wc, details) => {
    if (!windows.isControl(wc)) return;
    console.error('[main] control window process gone:', details.reason);
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('The recorder stopped unexpectedly.'));
      pending.delete(id);
    }
    const reload = () => {
      if (!wc.isDestroyed()) wc.reload();
    };
    if (controller.isCapturing) {
      controller
        .stop({ reason: 'The recorder stopped unexpectedly. Everything up to that moment was saved.' })
        .finally(reload);
    } else {
      reload();
    }
  });

  // Something the user must know about while the window is out of sight.
  controller.on('warning', (message) => {
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title: 'Freeloomz', body: message, silent: true }).show();
    } catch {
      /* notifications are best-effort */
    }
  });

  // Closing the lid or locking the screen mid-recording: pause rather than
  // record a black screen or a lock screen. Resuming is left to the user.
  const pauseForAbsence = (why) => {
    if (controller.status !== 'recording') return;
    controller
      .togglePause()
      .then(() => {
        controller.notice = `Paused because ${why}. Press resume when you are ready.`;
        controller.broadcast();
      })
      .catch((err) => console.error('[main] could not pause:', err));
  };
  powerMonitor.on('suspend', () => pauseForAbsence('the computer went to sleep'));
  powerMonitor.on('lock-screen', () => pauseForAbsence('the screen was locked'));

  // ------------------------------------------------------------ security
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    callback(windows.owns(wc) && (permission === 'media' || permission === 'display-capture'));
  });
  ses.setPermissionCheckHandler((wc, permission) => {
    if (permission !== 'media' && permission !== 'display-capture') return false;
    return wc ? windows.owns(wc) : true;
  });
  app.on('web-contents-created', (_event, wc) => {
    wc.on('will-navigate', (event) => event.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // Answers getDisplayMedia() from the recorder with the display the user
  // picked — no system picker in the way.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      // Only the recorder itself may capture the screen.
      const requester = request.frame ? webContents.fromFrame(request.frame) : null;
      if (!windows.isControl(requester)) return callback(/** @type {any} */ (null));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      const wanted = controller.captureDisplayId ?? String(screen.getPrimaryDisplay().id);
      let source = sources.find((s) => s.display_id && s.display_id === wanted);
      if (!source) {
        // Some platforms do not report display ids; fall back to position.
        const index = screen.getAllDisplays().findIndex((d) => String(d.id) === wanted);
        source = sources[index] ?? sources[0];
      }
      if (!source) return callback(/** @type {any} */ (null));
      /** @type {Electron.Streams} */
      const streams = { video: source };
      if (request.audioRequested && capabilities.systemAudio) streams.audio = 'loopback';
      callback(streams);
    } catch (err) {
      console.error('[capture] could not list screens:', err);
      callback(/** @type {any} */ (null));
    }
  });

  // ----------------------------------------------------------- shortcuts
  /** @type {Record<string, string>} */
  let shortcutErrors = {};
  /** @type {Record<string, string>} */
  let registeredShortcuts = {};
  let shortcutsSuspended = false;
  const registerShortcuts = () => {
    for (const accelerator of Object.values(registeredShortcuts)) globalShortcut.unregister(accelerator);
    registeredShortcuts = {};
    shortcutErrors = {};
    if (shortcutsSuspended) return;
    const wanted = settings.get().shortcuts;
    const seen = new Set();
    for (const action of SHORTCUT_ACTIONS) {
      const accelerator = wanted[action];
      if (!accelerator) continue;
      if (seen.has(accelerator)) {
        shortcutErrors[action] = 'Already used by another action';
        continue;
      }
      seen.add(accelerator);
      try {
        const ok = globalShortcut.register(accelerator, () => {
          controller.command(action).catch((err) => console.error('[shortcut]', err));
        });
        if (ok) registeredShortcuts[action] = accelerator;
        else shortcutErrors[action] = 'In use by another app';
      } catch {
        shortcutErrors[action] = 'Not a valid shortcut';
      }
    }
  };
  registerShortcuts();

  // ---------------------------------------------------------------- tray
  const tray = new AppTray({ controller, windows, settings, getRecordingsDir, quit });
  controller.on('state', (state) => tray.update(state));

  // ------------------------------------------------------- settings sync
  let lastShortcuts = JSON.stringify(settings.get().shortcuts);
  let lastDir = getRecordingsDir();
  settings.on('change', (value) => {
    windows.syncBubble();
    windows.broadcast('settings', value);
    tray.update(controller.snapshot());
    const sc = JSON.stringify(value.shortcuts);
    if (sc !== lastShortcuts) {
      lastShortcuts = sc;
      registerShortcuts();
      windows.control?.webContents.send('settings', value, { shortcutErrors });
    }
    if (getRecordingsDir() !== lastDir) {
      lastDir = getRecordingsDir();
      windows.control?.webContents.send('library:changed');
      windows.control?.webContents.send('recovery:changed');
    }
    if (controller.isCapturing) {
      // Toggling the cursor highlight mid-recording takes effect right away.
      if (value.cursorHighlight && capabilities.overlay) windows.showOverlay();
      else if (!windows.drawing) windows.hideOverlay();
    }
  });
  library.on('updated', () => windows.control?.webContents.send('library:changed'));
  controller.on('saved', () => windows.control?.webContents.send('library:changed'));

  // ---------------------------------------------------------------- IPC
  const fromControl = (event) => {
    if (!windows.isControl(event.sender)) throw new Error('Not allowed from this window');
  };
  const fromOurs = (event) => {
    if (!windows.owns(event.sender)) throw new Error('Not allowed from this window');
  };
  /** Only files directly inside the recordings folder may be touched. */
  const checkedPath = (file) => {
    if (typeof file !== 'string' || !isInside(file, getRecordingsDir())) throw new Error('That file is not in the recordings folder.');
    return file;
  };

  const permissionStatus = () => {
    if (!isMac && !isWin) return { screen: 'granted', camera: 'granted', microphone: 'granted' };
    return {
      screen: systemPreferences.getMediaAccessStatus('screen'),
      camera: systemPreferences.getMediaAccessStatus('camera'),
      microphone: systemPreferences.getMediaAccessStatus('microphone'),
    };
  };

  ipcMain.handle('app:init', async (event) => {
    fromOurs(event);
    const dir = getRecordingsDir();
    return {
      settings: settings.get(),
      state: controller.snapshot(),
      capabilities,
      displays: controller.displays(),
      permissions: permissionStatus(),
      shortcutErrors,
      recordingsDir: dir,
      freeBytes: await freeSpace(dir),
      estimatedBitsPerSecond: controller.estimateBitsPerSecond(),
    };
  });

  ipcMain.handle('settings:update', (event, patch) => {
    fromOurs(event);
    // The bubble may only change its own look; everything else is the
    // control panel's business.
    const safe = windows.isControl(event.sender) ? patch : { bubble: patch?.bubble };
    return settings.update(safe);
  });

  ipcMain.handle('ctl:command', async (event, name, arg) => {
    fromOurs(event);
    await controller.command(String(name), arg);
    return controller.snapshot();
  });

  ipcMain.handle('rec:chunk', (event, data) => {
    fromControl(event);
    return controller.writeChunk(data);
  });

  ipcMain.handle('perm:status', (event) => {
    fromControl(event);
    return permissionStatus();
  });

  ipcMain.handle('perm:request', async (event, kind) => {
    fromControl(event);
    if (isMac && (kind === 'camera' || kind === 'microphone')) {
      const status = systemPreferences.getMediaAccessStatus(kind);
      if (status === 'not-determined') await systemPreferences.askForMediaAccess(kind);
      else if (status !== 'granted') {
        await shell.openExternal(
          `x-apple.systempreferences:com.apple.preference.security?Privacy_${kind === 'camera' ? 'Camera' : 'Microphone'}`,
        );
      }
    } else if (isMac && kind === 'screen') {
      // Asking for the list of screens makes macOS add Freeloomz to the
      // Screen Recording list (and prompt the first time).
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }).catch(() => {});
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    } else if (isWin && (kind === 'camera' || kind === 'microphone')) {
      await shell.openExternal(`ms-settings:privacy-${kind === 'camera' ? 'webcam' : 'microphone'}`);
    }
    return permissionStatus();
  });

  ipcMain.handle('dialog:pickFolder', async (event) => {
    fromControl(event);
    const result = await dialog.showOpenDialog(windows.control, {
      title: 'Where should recordings be saved?',
      defaultPath: getRecordingsDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    const dir = result.filePaths[0];
    try {
      await fsp.access(dir, fs.constants.W_OK);
    } catch {
      throw new Error('Freeloomz cannot write to that folder. Please pick another one.');
    }
    settings.update({ recordingsDir: dir });
    return dir;
  });

  const toItem = (item) => ({
    ...item,
    url: pathToFileURL(item.path).href,
    thumbnailUrl: item.thumbnail ? `${pathToFileURL(item.thumbnail).href}?v=${Math.round(item.sizeBytes)}` : null,
    chapters: chaptersText(item.markers, item.durationMs ?? 0),
  });

  ipcMain.handle('library:list', async (event) => {
    fromControl(event);
    const dir = getRecordingsDir();
    const items = await library.list(dir);
    return {
      dir,
      items: items.map(toItem),
      freeBytes: await freeSpace(dir),
      estimatedBitsPerSecond: controller.estimateBitsPerSecond(),
    };
  });

  ipcMain.handle('library:action', async (event, action, file, arg) => {
    fromControl(event);
    if (action === 'openFolder') {
      const dir = await ensureRecordingsDir();
      await shell.openPath(dir);
      return null;
    }
    const target = checkedPath(file);
    switch (action) {
      case 'reveal':
        shell.showItemInFolder(target);
        return null;
      case 'open': {
        const failure = await shell.openPath(target);
        if (failure) throw new Error(failure);
        return null;
      }
      case 'trash':
        await retryWhileBusy(() => shell.trashItem(target));
        library.forget(target);
        if (controller.lastRecording?.path === target) controller.command('dismiss');
        return null;
      case 'rename': {
        const next = await library.rename(target, String(arg ?? ''));
        if (controller.lastRecording?.path === target) {
          controller.lastRecording = { ...controller.lastRecording, path: next };
          controller.broadcast();
        }
        return next;
      }
      case 'copyPath':
        clipboard.writeText(target);
        return null;
      case 'copyChapters':
        clipboard.writeText(String(arg ?? ''));
        return null;
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  });

  /** @type {AbortController | null} */
  let exportAbort = null;
  ipcMain.on('export:cancel', (event) => {
    if (windows.isControl(event.sender)) exportAbort?.abort();
  });
  ipcMain.handle('library:export', async (event, request) => {
    fromControl(event);
    if (exportAbort) throw new Error('Another export is still running.');
    const input = checkedPath(request?.path);
    const kind = request?.kind === 'gif' ? 'gif' : 'trim';
    const info = await probe(input);
    const total = info.durationSec ?? 0;
    const startSec = Math.max(0, Number(request?.startSec) || 0);
    const endSec = Math.min(total || Infinity, Number(request?.endSec) > startSec ? Number(request.endSec) : total);
    if (!(endSec > startSec)) throw new Error('The end must come after the start.');
    const dir = path.dirname(input);
    const base = path.basename(input, path.extname(input));
    const exists = (p) => fs.existsSync(p);
    const output =
      kind === 'gif'
        ? uniquePath(dir, base, '.gif', exists, path.join)
        : uniquePath(dir, `${base} (trimmed)`, '.mp4', exists, path.join);
    const staged = path.join(dir, `.freeloomz-export-${Date.now()}${path.extname(output)}`);
    const args =
      kind === 'gif'
        ? gifArgs({ input, output: staged, startSec, endSec })
        : trimArgs({ input, output: staged, startSec, endSec, constantFps: request?.constantFps ? 30 : undefined });
    exportAbort = new AbortController();
    try {
      await runFfmpeg(args, {
        totalSec: endSec - startSec,
        signal: exportAbort.signal,
        onProgress: (fraction) => windows.control?.webContents.send('export:progress', fraction),
      });
      await retryWhileBusy(() => fsp.rename(staged, output));
      return output;
    } catch (err) {
      await fsp.rm(staged, { force: true }).catch(() => {});
      throw err;
    } finally {
      exportAbort = null;
      windows.control?.webContents.send('library:changed');
    }
  });

  // Unfinished recordings (crash, power cut).
  const listOrphans = async () => {
    const orphans = await findOrphans(getRecordingsDir(), controller.session?.journal.id ?? null);
    return orphans.map((o) => ({
      id: o.journal.id,
      startedAt: o.journal.startedAt,
      durationMs: o.journal.durationMs,
      sizeBytes: o.sizeBytes,
    }));
  };
  ipcMain.handle('recovery:list', (event) => {
    fromControl(event);
    return listOrphans();
  });
  const findOrphan = async (id) => {
    const orphans = await findOrphans(getRecordingsDir(), controller.session?.journal.id ?? null);
    const match = orphans.find((o) => o.journal.id === id);
    if (!match) throw new Error('That recording is no longer there.');
    return match.journal;
  };
  ipcMain.handle('recovery:restore', async (event, id) => {
    fromControl(event);
    const journal = await findOrphan(String(id));
    try {
      const recording = await finalizeRecording({ recordingsDir: getRecordingsDir(), journal });
      library.remember(recording.path, {
        durationMs: recording.durationMs,
        width: recording.width,
        height: recording.height,
        markers: recording.markers,
        sizeBytes: recording.sizeBytes,
        inspected: true,
      });
      await library.makeThumbnail(recording.path, recording.durationMs / 1000);
      return recording.path;
    } catch (err) {
      throw new Error(friendly(err));
    } finally {
      windows.control?.webContents.send('library:changed');
      windows.control?.webContents.send('recovery:changed');
    }
  });
  ipcMain.handle('recovery:discard', async (event, id) => {
    fromControl(event);
    await discardOrphan(getRecordingsDir(), await findOrphan(String(id)));
    windows.control?.webContents.send('recovery:changed');
    return null;
  });

  // While the user is typing a new shortcut, the old ones must not fire.
  ipcMain.handle('shortcuts:suspend', (event, suspended) => {
    fromControl(event);
    shortcutsSuspended = Boolean(suspended);
    registerShortcuts();
    return shortcutErrors;
  });

  // Camera bubble.
  ipcMain.on('bubble:drag', (event, phase) => {
    if (windows.bubble && event.sender === windows.bubble.webContents) windows.dragBubble(phase);
  });
  ipcMain.on('bubble:resize', (event, delta) => {
    if (windows.bubble && event.sender === windows.bubble.webContents && Number.isFinite(delta)) {
      windows.setBubbleSize(settings.get().bubble.size + delta);
    }
  });
  ipcMain.on('bubble:menu', (event) => {
    if (windows.bubble && event.sender === windows.bubble.webContents) windows.popupBubbleMenu();
  });
  ipcMain.on('overlay:exit', (event) => {
    if (windows.overlay && event.sender === windows.overlay.webContents) controller.setDrawing(false);
  });

  // ------------------------------------------------------- app lifecycle
  if (isMac) {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ]),
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  app.on('second-instance', () => windows.showControl());
  app.on('activate', () => windows.showControl());
  app.on('window-all-closed', () => {
    /* the tray keeps the app alive; quitting is explicit */
  });
  app.on('before-quit', (event) => {
    quitting = true;
    if (controller.isCapturing) {
      // Quit was requested mid-recording: save first, then quit.
      event.preventDefault();
      controller.stop().finally(() => app.quit());
    } else if (controller.status === 'stopping' || controller.status === 'finalizing') {
      event.preventDefault();
      controller.once('saved', () => app.quit());
    }
  });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    settings.flush();
    library.flush();
    tray.destroy();
  });
  screen.on('display-removed', () => windows.syncBubble());

  windows.createControl();
  windows.syncBubble();

  if (E2E) {
    /** @type {any} */ (globalThis).__freeloomz = { controller, windows, settings, library, getRecordingsDir };
  }
}
