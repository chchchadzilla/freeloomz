// The capture engine. Runs in the control window, takes orders from the
// main process (`engine:cmd`) and streams encoded video to it about once a
// second (`rec:chunk`), so nothing piles up in memory however long the
// recording gets.

import { pickMimeType } from '../../shared/naming.js';
import { Stopwatch } from '../../shared/time.js';

const api = /** @type {any} */ (window).freeloomz;

/** @param {string | null | undefined} deviceId */
const exactDevice = (deviceId) => (deviceId ? { deviceId: { exact: deviceId } } : {});

/**
 * getUserMedia that falls back to the default device when the remembered
 * one has been unplugged.
 * @param {MediaStreamConstraints} constraints
 * @param {MediaStreamConstraints} fallback
 */
async function getMedia(constraints, fallback) {
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError') {
      return navigator.mediaDevices.getUserMedia(fallback);
    }
    throw err;
  }
}

export class CaptureEngine {
  constructor() {
    /** @type {MediaStream[]} */ this.inputs = [];
    /** @type {MediaStream | null} */ this.stream = null;
    /** @type {MediaRecorder | null} */ this.recorder = null;
    /** @type {AudioContext | null} */ this.audio = null;
    /** @type {GainNode | null} */ this.micGain = null;
    /** @type {AnalyserNode | null} */ this.analyser = null;
    this.stopwatch = new Stopwatch(() => performance.now());
    this.mime = '';
    this.options = /** @type {any} */ ({});
    this.writes = Promise.resolve();
    this.failed = false;
    this.stopping = false;
  }

  /**
   * Opens the screen / camera / microphone and gets everything ready, so
   * that `start()` is instant. Permission prompts and "device busy" errors
   * happen here — before the countdown, not after.
   */
  async prepare(o) {
    this.release();
    this.options = o;
    const notices = [];
    /** @type {MediaStreamTrack} */ let video;
    /** @type {MediaStreamTrack | null} */ let systemAudio = null;

    if (o.mode === 'camera') {
      const base = { width: { ideal: o.width }, height: { ideal: o.height }, frameRate: { ideal: o.fps } };
      const cam = await getMedia({ video: { ...base, ...exactDevice(o.cameraDeviceId) } }, { video: base });
      this.inputs.push(cam);
      video = cam.getVideoTracks()[0];
    } else {
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: /** @type {any} */ ({
          frameRate: { ideal: o.fps, max: o.fps },
          width: { max: o.width },
          height: { max: o.height },
          // Without this the pointer is left out of the recording.
          cursor: 'always',
        }),
        audio: Boolean(o.systemAudio),
      });
      this.inputs.push(display);
      video = display.getVideoTracks()[0];
      if (o.systemAudio) {
        systemAudio = display.getAudioTracks()[0] ?? null;
        // A missing OS permission yields a track that is already dead.
        if (!systemAudio || systemAudio.readyState === 'ended') {
          systemAudio = null;
          notices.push('Computer sound could not be captured, so this recording has microphone audio only.');
        }
      }
    }
    if (!video) throw new Error('Nothing to record: no video source is available.');
    if ('contentHint' in video && o.mode !== 'camera') video.contentHint = 'detail'; // favour sharp text over smooth motion

    /** @type {MediaStream | null} */ let mic = null;
    if (o.micEnabled) {
      const base = {
        echoCancellation: Boolean(o.echoCancellation),
        noiseSuppression: Boolean(o.noiseSuppression),
        autoGainControl: Boolean(o.autoGainControl),
      };
      try {
        mic = await getMedia({ audio: { ...base, ...exactDevice(o.micDeviceId) } }, { audio: base });
        this.inputs.push(mic);
        mic.getAudioTracks()[0]?.addEventListener('ended', () => {
          if (this.stopping || !this.recorder) return;
          api.send('engine:event', {
            type: 'warning',
            message: 'Your microphone was disconnected. The recording continues without narration.',
          });
        });
      } catch (err) {
        // Recording a silent tutorial by accident is worse than not starting.
        const why = err?.name === 'NotAllowedError' ? 'Freeloomz is not allowed to use the microphone' : 'The microphone could not be opened';
        const error = new Error(`${why}. Fix it, or switch the microphone off to record without narration.`);
        error.name = err?.name === 'NotAllowedError' ? 'MicBlocked' : 'MicUnavailable';
        throw error;
      }
    }

    /** @type {MediaStreamTrack | null} */ let audioTrack = null;
    if (mic || systemAudio) {
      // Mix every sound source into one track; MediaRecorder records one.
      const ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
      this.audio = ctx;
      const out = ctx.createMediaStreamDestination();
      if (mic) {
        const source = ctx.createMediaStreamSource(mic);
        this.micGain = ctx.createGain();
        this.micGain.gain.value = o.micMuted ? 0 : 1;
        source.connect(this.micGain).connect(out);
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 512;
        source.connect(this.analyser);
      }
      if (systemAudio) ctx.createMediaStreamSource(new MediaStream([systemAudio])).connect(out);
      if (ctx.state !== 'running') await ctx.resume().catch(() => {});
      audioTrack = out.stream.getAudioTracks()[0];
    }

    this.stream = new MediaStream(audioTrack ? [video, audioTrack] : [video]);
    this.mime = pickMimeType((m) => MediaRecorder.isTypeSupported(m), Boolean(audioTrack));
    if (!this.mime) throw new Error('This computer has no video encoder Freeloomz can use.');

    const size = video.getSettings();
    return {
      mime: this.mime,
      hasAudio: Boolean(audioTrack),
      width: size.width ?? o.width,
      height: size.height ?? o.height,
      notice: notices.join(' ') || null,
    };
  }

  async start() {
    if (!this.stream) throw new Error('Not prepared');
    const o = this.options;
    const recorder = new MediaRecorder(this.stream, {
      mimeType: this.mime,
      videoBitsPerSecond: o.videoBitsPerSecond,
      audioBitsPerSecond: o.audioBitsPerSecond,
    });
    this.recorder = recorder;
    this.writes = Promise.resolve();
    this.failed = false;
    this.stopping = false;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      // Chained so chunks reach the disk strictly in order.
      this.writes = this.writes.then(async () => {
        if (this.failed) return;
        try {
          await api.invoke('rec:chunk', await event.data.arrayBuffer());
        } catch (err) {
          this.failed = true;
          api.send('engine:event', { type: 'error', message: `could not save to disk (${err?.message ?? err})` });
        }
      });
    };
    recorder.onerror = (event) => {
      if (this.stopping) return;
      api.send('engine:event', { type: 'error', message: /** @type {any} */ (event).error?.message ?? 'encoder error' });
    };
    // The screen was unplugged, the camera was pulled, or the OS revoked access.
    const video = this.stream.getVideoTracks()[0];
    video.onended = () => {
      if (this.stopping) return;
      api.send('engine:event', {
        type: 'ended',
        message: 'Recording was stopped and saved because the screen or camera became unavailable.',
      });
    };

    const started = new Promise((resolve, reject) => {
      recorder.addEventListener('start', () => resolve(undefined), { once: true });
      recorder.addEventListener('error', (e) => reject(/** @type {any} */ (e).error ?? new Error('The recorder failed to start')), { once: true });
    });
    recorder.start(1000);
    await started;
    this.stopwatch.reset();
    this.stopwatch.start();
    return { mime: recorder.mimeType };
  }

  pause() {
    if (this.recorder?.state === 'recording') {
      this.recorder.pause();
      this.stopwatch.pause();
    }
  }

  resume() {
    if (this.recorder?.state === 'paused') {
      this.recorder.resume();
      this.stopwatch.start();
    }
  }

  /** Stops, waits until the last chunk is safely on disk, reports the length. */
  async stop() {
    const recorder = this.recorder;
    this.stopping = true;
    this.stopwatch.pause();
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        recorder.addEventListener('stop', () => resolve(undefined), { once: true });
        recorder.stop();
      });
    }
    await this.writes;
    this.recorder = null;
    return { durationMs: Math.round(this.stopwatch.elapsedMs), failed: this.failed };
  }

  /** @param {{ muted: boolean }} o */
  setMicMuted({ muted }) {
    if (this.micGain && this.audio) this.micGain.gain.setTargetAtTime(muted ? 0 : 1, this.audio.currentTime, 0.015);
  }

  /** Lets go of the screen, camera and microphone. */
  release() {
    this.stopping = true;
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.recorder = null;
    for (const stream of this.inputs) for (const track of stream.getTracks()) track.stop();
    this.inputs = [];
    this.stream = null;
    this.micGain = null;
    this.analyser = null;
    if (this.audio) this.audio.close().catch(() => {});
    this.audio = null;
  }
}

const COMMANDS = new Set(['prepare', 'start', 'pause', 'resume', 'stop', 'setMicMuted', 'release']);

/** Wires the engine to the main process. */
export function connectEngine() {
  const engine = new CaptureEngine();
  api.on('engine:cmd', async ({ id, name, args }) => {
    try {
      if (!COMMANDS.has(name)) throw new Error(`Unknown engine command: ${name}`);
      const result = await engine[name](args);
      api.send('engine:reply', { id, ok: true, result: result ?? null });
    } catch (err) {
      api.send('engine:reply', { id, ok: false, error: { name: err?.name ?? 'Error', message: err?.message ?? String(err) } });
    }
  });
  return engine;
}

/**
 * Live microphone level for the idle screen, so you can see you are being
 * heard before you hit record. Holds the mic only while it is on screen.
 */
export class MicMonitor {
  /** @param {(level: number) => void} onLevel 0..1 */
  constructor(onLevel) {
    this.onLevel = onLevel;
    /** @type {MediaStream | null} */ this.stream = null;
    /** @type {AudioContext | null} */ this.ctx = null;
    this.raf = 0;
    this.key = '';
    this.generation = 0;
  }

  /** @param {{ enabled: boolean, deviceId: string | null }} o */
  async update({ enabled, deviceId }) {
    const key = enabled ? `on:${deviceId ?? ''}` : 'off';
    if (key === this.key) return;
    this.key = key;
    const generation = ++this.generation;
    this._close();
    if (!enabled) return;
    try {
      const stream = await getMedia({ audio: exactDevice(deviceId) }, { audio: true });
      if (generation !== this.generation) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.stream = stream;
      this.ctx = new AudioContext();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let smoothed = 0;
      const tick = () => {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const v of samples) peak = Math.max(peak, Math.abs(v));
        // Fast attack, slow release reads like a real level meter.
        smoothed = peak > smoothed ? peak : smoothed * 0.9;
        this.onLevel(Math.min(1, smoothed * 2.2));
        this.raf = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      this.onLevel(0);
    }
  }

  _close() {
    cancelAnimationFrame(this.raf);
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
    this.onLevel(0);
  }
}
