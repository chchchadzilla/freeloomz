// Shared constants and settings schema. Pure — runs in the main process,
// in renderers and in plain Node (unit tests).

export const APP_NAME = 'Freeloomz';

export const MODES = /** @type {const} */ (['screen+camera', 'screen', 'camera']);
export const RESOLUTIONS = /** @type {const} */ ([720, 1080, 1440, 2160, 0]); // 0 = native
export const FRAME_RATES = /** @type {const} */ ([15, 30, 60]);
export const QUALITIES = /** @type {const} */ (['standard', 'high', 'max']);
export const COUNTDOWNS = /** @type {const} */ ([0, 3, 5, 10]);
export const BUBBLE_SHAPES = /** @type {const} */ (['circle', 'rounded']);

export const BUBBLE_MIN = 96;
export const BUBBLE_MAX = 640;
export const BUBBLE_PRESETS = { small: 160, medium: 240, large: 360 };

/** Stop recording (safely) when the disk has less than this left. */
export const MIN_FREE_BYTES = 300 * 1024 * 1024;

export const SHORTCUT_ACTIONS = /** @type {const} */ ([
  'toggleRecord',
  'togglePause',
  'addMarker',
  'toggleCamera',
  'toggleMic',
  'toggleDraw',
]);

export const SHORTCUT_LABELS = {
  toggleRecord: 'Start / stop recording',
  togglePause: 'Pause / resume',
  addMarker: 'Add chapter marker',
  toggleCamera: 'Show / hide camera bubble',
  toggleMic: 'Mute / unmute microphone',
  toggleDraw: 'Draw on screen',
};

export const DEFAULT_SETTINGS = Object.freeze({
  mode: 'screen+camera',
  /** Electron display id as a string, or null for the primary display. */
  displayId: null,
  /** deviceId from enumerateDevices, or null for the system default. */
  cameraDeviceId: null,
  micDeviceId: null,
  micEnabled: true,
  systemAudio: false,
  /** Maximum output height in pixels; 0 keeps the display's native size. */
  resolution: 1080,
  fps: 30,
  quality: 'high',
  countdown: 3,
  hideOnRecord: true,
  cursorHighlight: false,
  noiseSuppression: true,
  echoCancellation: true,
  autoGainControl: true,
  /** Absolute folder path, or null for the platform's Videos/Movies folder. */
  recordingsDir: null,
  bubble: Object.freeze({
    visible: true,
    size: BUBBLE_PRESETS.medium,
    shape: 'circle',
    mirror: true,
    snap: true,
    /** Screen coordinates of the bubble's top-left, or null for the default corner. */
    x: null,
    y: null,
  }),
  shortcuts: Object.freeze({
    toggleRecord: 'Alt+Shift+R',
    togglePause: 'Alt+Shift+P',
    addMarker: 'Alt+Shift+K',
    toggleCamera: 'Alt+Shift+C',
    toggleMic: 'Alt+Shift+M',
    toggleDraw: 'Alt+Shift+D',
  }),
});

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const strOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
const finiteOrNull = (value) => (Number.isFinite(value) ? Math.round(value) : null);

/**
 * Turns anything (an old settings file, a partial patch, garbage) into a
 * complete, valid settings object. Unknown keys are dropped; invalid values
 * fall back to defaults. Never throws.
 * @param {any} raw
 */
export function sanitizeSettings(raw) {
  const d = DEFAULT_SETTINGS;
  const r = raw && typeof raw === 'object' ? raw : {};
  const rb = r.bubble && typeof r.bubble === 'object' ? r.bubble : {};
  const rs = r.shortcuts && typeof r.shortcuts === 'object' ? r.shortcuts : {};

  const size = Number.isFinite(rb.size)
    ? Math.min(BUBBLE_MAX, Math.max(BUBBLE_MIN, Math.round(rb.size)))
    : d.bubble.size;

  /** @type {Record<string, string>} */
  const shortcuts = {};
  for (const action of SHORTCUT_ACTIONS) {
    const v = rs[action];
    // An empty string means "no shortcut" and is a valid choice.
    shortcuts[action] = typeof v === 'string' && v.length <= 64 ? v : d.shortcuts[action];
  }

  return {
    mode: oneOf(r.mode, MODES, d.mode),
    displayId: strOrNull(r.displayId),
    cameraDeviceId: strOrNull(r.cameraDeviceId),
    micDeviceId: strOrNull(r.micDeviceId),
    micEnabled: bool(r.micEnabled, d.micEnabled),
    systemAudio: bool(r.systemAudio, d.systemAudio),
    resolution: oneOf(r.resolution, RESOLUTIONS, d.resolution),
    fps: oneOf(r.fps, FRAME_RATES, d.fps),
    quality: oneOf(r.quality, QUALITIES, d.quality),
    countdown: oneOf(r.countdown, COUNTDOWNS, d.countdown),
    hideOnRecord: bool(r.hideOnRecord, d.hideOnRecord),
    cursorHighlight: bool(r.cursorHighlight, d.cursorHighlight),
    noiseSuppression: bool(r.noiseSuppression, d.noiseSuppression),
    echoCancellation: bool(r.echoCancellation, d.echoCancellation),
    autoGainControl: bool(r.autoGainControl, d.autoGainControl),
    recordingsDir: strOrNull(r.recordingsDir),
    bubble: {
      visible: bool(rb.visible, d.bubble.visible),
      size,
      shape: oneOf(rb.shape, BUBBLE_SHAPES, d.bubble.shape),
      mirror: bool(rb.mirror, d.bubble.mirror),
      snap: bool(rb.snap, d.bubble.snap),
      x: finiteOrNull(rb.x),
      y: finiteOrNull(rb.y),
    },
    shortcuts,
  };
}

/**
 * Applies a (possibly nested) patch on top of current settings and sanitizes
 * the result.
 * @param {any} current
 * @param {any} patch
 */
export function mergeSettings(current, patch) {
  const p = patch && typeof patch === 'object' ? patch : {};
  return sanitizeSettings({
    ...current,
    ...p,
    bubble: { ...(current?.bubble ?? {}), ...(p.bubble ?? {}) },
    shortcuts: { ...(current?.shortcuts ?? {}), ...(p.shortcuts ?? {}) },
  });
}

/**
 * Output frame size for a display, capped to `maxHeight` and rounded down to
 * even numbers (H.264 needs even dimensions). Never upscales.
 * @param {number} width  display width in physical pixels
 * @param {number} height display height in physical pixels
 * @param {number} maxHeight 0 = native
 */
export function targetFrameSize(width, height, maxHeight) {
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2);
  if (!(width > 0) || !(height > 0)) return { width: 1920, height: 1080 };
  const scale = maxHeight > 0 ? Math.min(1, maxHeight / height) : 1;
  return { width: even(width * scale), height: even(height * scale) };
}

/**
 * Target video bitrate (bits/s) for screen content. Screen recordings are
 * mostly static, so encoders usually land well under this.
 * @param {number} width
 * @param {number} height
 * @param {number} fps
 * @param {string} quality
 */
export function videoBitrate(width, height, fps, quality) {
  const bitsPerPixel = { standard: 0.07, high: 0.12, max: 0.2 }[quality] ?? 0.12;
  // 60 fps does not need double the bits: consecutive frames are more alike.
  const fpsFactor = fps >= 60 ? 1.5 : fps <= 15 ? 0.7 : 1;
  const raw = width * height * 30 * bitsPerPixel * fpsFactor;
  return Math.round(Math.min(60_000_000, Math.max(1_500_000, raw)) / 100_000) * 100_000;
}

export const AUDIO_BITRATE = 160_000;
