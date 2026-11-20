// The recording state machine. Every way of controlling a recording — the
// control panel, the camera bubble, the tray, global shortcuts — ends up
// calling a method here, and every window renders the state broadcast from
// here. The actual capture (MediaRecorder) lives in the control window's
// renderer; this class tells it what to do through `engine`.

import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { globalShortcut, powerSaveBlocker, screen } from 'electron';
import { MIN_FREE_BYTES, targetFrameSize, videoBitrate, AUDIO_BITRATE } from '../shared/defaults.js';
import { Stopwatch, formatClock } from '../shared/time.js';
import { RecordingSession, finalizeRecording } from './recording-session.js';

/**
 * @typedef {'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'stopping' | 'finalizing'} Status
 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Controller extends EventEmitter {
  /**
   * @param {object} o
   * @param {import('./settings-store.js').SettingsStore} o.settings
   * @param {import('./windows.js').WindowManager} o.windows
   * @param {import('./library.js').Library} o.library
   * @param {{ call: (name: string, args?: any, timeoutMs?: number) => Promise<any> }} o.engine
   * @param {() => Promise<string>} o.ensureRecordingsDir
   * @param {{ systemAudio: boolean, contentProtection: boolean, overlay: boolean }} o.capabilities
   */
  constructor({ settings, windows, library, engine, ensureRecordingsDir, capabilities }) {
    super();
    this.settings = settings;
    this.windows = windows;
    this.library = library;
    this.engine = engine;
    this.ensureRecordingsDir = ensureRecordingsDir;
    this.capabilities = capabilities;

    /** @type {Status} */
    this.status = 'idle';
    this.stopwatch = new Stopwatch();
    this.micMuted = false;
    this.markers = 0;
    this.freeBytes = /** @type {number | null} */ (null);
    this.bitsPerSecond = 0;
    this.finalizeProgress = /** @type {number | null} */ (null);
    this.error = /** @type {string | null} */ (null);
    this.notice = /** @type {string | null} */ (null);
    this.lastRecording = /** @type {any} */ (null);
    /** Display id the next getDisplayMedia request should be answered with. */
    this.captureDisplayId = /** @type {string | null} */ (null);

    /** @type {RecordingSession | null} */ this.session = null;
    this._abort = /** @type {AbortController | null} */ (null);
    this._ticker = /** @type {NodeJS.Timeout | null} */ (null);
    this._lastHousekeeping = 0;
    this._powerBlocker = /** @type {number | null} */ (null);
    this._controlWasVisible = true;
  }

  get busy() {
    return this.status !== 'idle';
  }

  get isCapturing() {
    return this.status === 'recording' || this.status === 'paused';
  }

  snapshot() {
    return {
      status: this.status,
      elapsedMs: this.stopwatch.elapsedMs,
      micMuted: this.micMuted,
      markers: this.markers,
      drawing: this.windows.drawing,
      freeBytes: this.freeBytes,
      bytesWritten: this.session?.bytesWritten ?? 0,
      bitsPerSecond: this.bitsPerSecond,
      finalizeProgress: this.finalizeProgress,
      error: this.error,
      notice: this.notice,
      lastRecording: this.lastRecording,
    };
  }

  broadcast() {
    const snap = this.snapshot();
    this.windows.broadcast('state', snap);
    this.emit('state', snap);
  }

  /** @param {Status} status */
  _set(status) {
    this.status = status;
    this.broadcast();
  }

  // ------------------------------------------------------------ commands

  /** @param {string} name @param {any} [arg] */
  async command(name, arg) {
    switch (name) {
      case 'toggleRecord':
        return this.isCapturing || this.status === 'countdown' || this.status === 'preparing' ? this.stop() : this.start();
      case 'start':
        return this.start();
      case 'stop':
        return this.stop();
      case 'togglePause':
        return this.togglePause();
      case 'addMarker':
        return this.addMarker(typeof arg === 'string' ? arg : undefined);
      case 'toggleMic':
        return this.toggleMic();
      case 'toggleCamera':
        return this.toggleCamera();
      case 'toggleDraw':
        return this.setDrawing(!this.windows.drawing);
      case 'discard':
        return this.discard();
      case 'dismiss':
        this.error = null;
        this.notice = null;
        this.lastRecording = null;
        return this.broadcast();
      default:
        throw new Error(`Unknown command: ${name}`);
    }
  }

  /** What to capture, worked out from settings and the chosen display. */
  _captureTarget() {
    const s = this.settings.get();
    const display = this.windows.targetDisplay();
    const physW = Math.round(display.size.width * display.scaleFactor);
    const physH = Math.round(display.size.height * display.scaleFactor);
    const frame = s.mode === 'camera' ? targetFrameSize(1920, 1080, s.resolution || 1080) : targetFrameSize(physW, physH, s.resolution);
    const bitrate = videoBitrate(frame.width, frame.height, s.fps, s.quality);
    return { display, frame, bitrate };
  }

  async start() {
    if (this.status !== 'idle') return;
    this.error = null;
    this.notice = null;
    this.lastRecording = null;
    this.markers = 0;
    this.stopwatch.reset();
    this._abort = new AbortController();
    const { signal } = this._abort;
    this._set('preparing');

    try {
      const s = this.settings.get();
      const dir = await this.ensureRecordingsDir();
      this.freeBytes = await freeSpace(dir);
      if (this.freeBytes !== null && this.freeBytes < MIN_FREE_BYTES * 2) {
        throw new Error('There is not enough free disk space to start recording. Free up some space or pick another folder in Settings.');
      }

      const { display, frame, bitrate } = this._captureTarget();
      this.captureDisplayId = String(display.id);
      this.bitsPerSecond = bitrate + AUDIO_BITRATE;

      const prepared = await this.engine.call(
        'prepare',
        {
          mode: s.mode,
          cameraDeviceId: s.cameraDeviceId,
          micDeviceId: s.micDeviceId,
          micEnabled: s.micEnabled,
          micMuted: this.micMuted,
          systemAudio: s.systemAudio && this.capabilities.systemAudio,
          fps: s.fps,
          width: frame.width,
          height: frame.height,
          videoBitsPerSecond: bitrate,
          audioBitsPerSecond: AUDIO_BITRATE,
          noiseSuppression: s.noiseSuppression,
          echoCancellation: s.echoCancellation,
          autoGainControl: s.autoGainControl,
        },
        60_000, // the first run may sit behind an OS permission prompt
      );
      if (signal.aborted) throw new Cancelled();
      if (prepared?.notice) this.notice = prepared.notice;

      if (s.countdown > 0) {
        this._set('countdown');
        const completed = await this.windows.runCountdown(s.countdown, signal);
        if (!completed) throw new Cancelled();
      }

      const control = this.windows.control;
      this._controlWasVisible = Boolean(control && !control.isDestroyed() && control.isVisible());
      if (s.mode !== 'camera') {
        if (s.hideOnRecord) await this.windows.hideControl();
        else if (this.capabilities.contentProtection) control?.setContentProtection(true);
        if (s.cursorHighlight && this.capabilities.overlay) this.windows.showOverlay();
        // Give the window system a moment to actually take our windows off
        // screen before the first frame is captured.
        await delay(s.hideOnRecord ? 280 : 60);
      }
      if (signal.aborted) throw new Cancelled();

      this.session = new RecordingSession({ recordingsDir: dir, mime: prepared.mime });
      await this.session.open();
      await this.engine.call('start');

      this.stopwatch.start();
      this._powerBlocker = powerSaveBlocker.start('prevent-display-sleep');
      this._startTicker();
      this._set('recording');
    } catch (err) {
      await this.engine.call('release').catch(() => {});
      if (this.session) await this.session.discard().catch(() => {});
      this.session = null;
      this._restoreWindows();
      if (!(err instanceof Cancelled)) this.error = friendly(err);
      this._set('idle');
    } finally {
      this._abort = null;
    }
  }

  /**
   * Stops and saves. Also cancels a countdown that is still running.
   * @param {{ reason?: string }} [opts]
   */
  async stop(opts = {}) {
    if (this.status === 'preparing' || this.status === 'countdown') {
      this._abort?.abort();
      return;
    }
    if (!this.isCapturing || !this.session) return;
    const session = this.session;
    this.stopwatch.pause();
    this._stopTicker();
    this._set('stopping');

    let durationMs = this.stopwatch.elapsedMs;
    try {
      const result = await this.engine.call('stop', {}, 20_000);
      if (result && Number.isFinite(result.durationMs) && result.durationMs > 0) durationMs = result.durationMs;
    } catch (err) {
      // The recorder may be gone (window crashed). Whatever reached the disk
      // is still a valid recording, so carry on and finish it.
      console.error('[controller] engine stop failed:', err);
    }
    await this.engine.call('release').catch(() => {});

    this._releasePower();
    if (this.windows.drawing) this.setDrawing(false);
    this.windows.hideOverlay();
    await session.close(durationMs).catch((err) => console.error('[controller] close failed:', err));
    this.session = null;
    this._restoreWindows({ show: true });

    this.finalizeProgress = 0;
    if (opts.reason) this.notice = opts.reason;
    this._set('finalizing');
    try {
      const recording = await finalizeRecording({
        recordingsDir: session.recordingsDir,
        journal: session.journal,
        onProgress: (fraction) => {
          this.finalizeProgress = fraction;
          this.broadcast();
        },
      });
      this.library.remember(recording.path, {
        durationMs: recording.durationMs,
        width: recording.width,
        height: recording.height,
        markers: recording.markers,
        sizeBytes: recording.sizeBytes,
        inspected: true,
      });
      await this.library.makeThumbnail(recording.path, recording.durationMs / 1000);
      this.lastRecording = recording;
    } catch (err) {
      this.error = friendly(err);
    }
    this.finalizeProgress = null;
    this.stopwatch.reset();
    this._set('idle');
    this.emit('saved', this.lastRecording);
  }

  /** Throws the current recording away. */
  async discard() {
    if (this.status === 'preparing' || this.status === 'countdown') {
      this._abort?.abort();
      return;
    }
    if (!this.isCapturing || !this.session) return;
    const session = this.session;
    this.session = null;
    this.stopwatch.pause();
    this._stopTicker();
    this._set('stopping');
    await this.engine.call('stop', {}, 10_000).catch(() => {});
    await this.engine.call('release').catch(() => {});
    this._releasePower();
    this.windows.hideOverlay();
    await session.discard().catch(() => {});
    this._restoreWindows({ show: true });
    this.stopwatch.reset();
    this.markers = 0;
    this._set('idle');
  }

  async togglePause() {
    if (this.status === 'recording') {
      await this.engine.call('pause');
      this.stopwatch.pause();
      this.session?.noteElapsed(this.stopwatch.elapsedMs);
      this._set('paused');
    } else if (this.status === 'paused') {
      await this.engine.call('resume');
      this.stopwatch.start();
      this._set('recording');
    }
  }

  /** @param {string} [label] */
  addMarker(label) {
    if (!this.isCapturing || !this.session) return;
    this.session.addMarker(this.stopwatch.elapsedMs, label);
    this.markers = this.session.journal.markers.length;
    this.broadcast();
  }

  async toggleMic() {
    this.micMuted = !this.micMuted;
    if (this.isCapturing) await this.engine.call('setMicMuted', { muted: this.micMuted }).catch(() => {});
    this.broadcast();
  }

  toggleCamera() {
    const s = this.settings.get();
    if (s.mode !== 'screen+camera') return;
    this.settings.update({ bubble: { visible: !s.bubble.visible } });
  }

  /** @param {boolean} on */
  setDrawing(on) {
    if (on === this.windows.drawing) return;
    if (on && !this.capabilities.overlay) {
      this.notice = 'Drawing on screen needs a desktop with window compositing, which this one does not have.';
      this.broadcast();
      return;
    }
    this.windows.setDrawing(on);
    if (on) {
      // The overlay never takes keyboard focus, so Escape is grabbed
      // globally — but only while drawing.
      try {
        globalShortcut.register('Escape', () => this.setDrawing(false));
      } catch {
        /* another app owns Escape; the on-screen Done button still works */
      }
    } else {
      globalShortcut.unregister('Escape');
      const keep = this.isCapturing && this.settings.get().cursorHighlight && this.capabilities.overlay;
      if (!keep) this.windows.hideOverlay();
    }
    this.broadcast();
  }

  /**
   * Called for every encoded chunk the recorder produces.
   * @param {ArrayBuffer | Uint8Array} data
   */
  async writeChunk(data) {
    if (!this.session) throw new Error('No recording in progress');
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);
    await this.session.write(chunk);
  }

  /** The recorder reports that capture ended on its own. */
  onEngineEvent(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'ended' && this.isCapturing) {
      this.stop({ reason: event.message || 'Recording stopped because the screen or camera became unavailable.' });
    } else if (event.type === 'error' && this.isCapturing) {
      this.stop({ reason: `Recording stopped early: ${event.message ?? 'the recorder reported an error'}.` });
    } else if (event.type === 'warning' && this.isCapturing && typeof event.message === 'string') {
      // Recording carries on, but the user should hear about it — now (they
      // cannot see our window) and again when they are back.
      this.notice = `${event.message} (at ${formatClock(this.stopwatch.elapsedMs)})`;
      this.emit('warning', event.message);
      this.broadcast();
    }
  }

  // ----------------------------------------------------------- internals

  _startTicker() {
    this._stopTicker();
    this._lastHousekeeping = Date.now();
    this._ticker = setInterval(() => {
      this.broadcast();
      if (Date.now() - this._lastHousekeeping >= 5000) {
        this._lastHousekeeping = Date.now();
        this._housekeeping();
      }
    }, 500);
  }

  _stopTicker() {
    if (this._ticker) clearInterval(this._ticker);
    this._ticker = null;
  }

  async _housekeeping() {
    const session = this.session;
    if (!session) return;
    if (this.status === 'recording') session.noteElapsed(this.stopwatch.elapsedMs);
    this.freeBytes = await freeSpace(session.recordingsDir);
    if (this.freeBytes !== null && this.freeBytes < MIN_FREE_BYTES && this.isCapturing) {
      this.stop({ reason: 'Recording was stopped and saved because the disk is almost full.' });
    }
  }

  _releasePower() {
    if (this._powerBlocker !== null && powerSaveBlocker.isStarted(this._powerBlocker)) powerSaveBlocker.stop(this._powerBlocker);
    this._powerBlocker = null;
  }

  /** @param {{ show?: boolean }} [opts] */
  _restoreWindows(opts = {}) {
    const control = this.windows.control;
    if (control && !control.isDestroyed() && this.capabilities.contentProtection) control.setContentProtection(false);
    if (this.windows.drawing) this.setDrawing(false);
    this.windows.hideOverlay();
    if (opts.show || this._controlWasVisible) this.windows.showControl();
  }

  /** Bitrate estimate for the idle screen ("room for about 6 h"). */
  estimateBitsPerSecond() {
    const { bitrate } = this._captureTarget();
    return bitrate + AUDIO_BITRATE;
  }

  displays() {
    const primary = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d, i) => ({
      id: String(d.id),
      label: d.label || `Display ${i + 1}`,
      width: Math.round(d.size.width * d.scaleFactor),
      height: Math.round(d.size.height * d.scaleFactor),
      primary: d.id === primary,
    }));
  }
}

class Cancelled extends Error {}

/**
 * Free bytes on the volume holding `dir`. The folder may not exist yet (it
 * is created on first recording), so walk up to the nearest one that does.
 * @param {string} dir
 */
export async function freeSpace(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 64; i += 1) {
    try {
      const stats = await fsp.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/** Turns browser/OS errors into something a person can act on. */
export function friendly(err) {
  const name = /** @type {any} */ (err)?.name ?? '';
  const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  if (name === 'NotAllowedError' || /Permission denied|NotAllowedError/i.test(message)) {
    return process.platform === 'darwin'
      ? 'Freeloomz was not allowed to record. Open System Settings → Privacy & Security and allow Freeloomz under Screen & System Audio Recording, Camera and Microphone, then try again.'
      : 'Freeloomz was not allowed to use the screen, camera or microphone. Check your system privacy settings and try again.';
  }
  if (name === 'NotFoundError' || /Requested device not found/i.test(message)) {
    return 'The selected camera or microphone could not be found. Pick another one and try again.';
  }
  if (name === 'NotReadableError' || /Could not start (video|audio) source/i.test(message)) {
    return 'The camera or microphone is being used by another app. Close that app and try again.';
  }
  if (/ENOSPC/.test(message)) return 'The disk is full. Free up some space and try again.';
  if (/EACCES|EPERM/.test(message)) return 'Freeloomz cannot write to the recordings folder. Pick another folder in Settings.';
  return message;
}
