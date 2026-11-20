// Time formatting and chapter helpers. Pure.

/**
 * 83_000 -> "1:23", 3_723_000 -> "1:02:03".
 * @param {number} ms
 * @param {{ padMinutes?: boolean }} [opts] padMinutes: "01:23" (for timers)
 */
export function formatClock(ms, opts = {}) {
  const total = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${opts.padMinutes ? String(m).padStart(2, '0') : m}:${ss}`;
}

/** @param {number} bytes */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

/**
 * Rough recording time left on disk at a given bitrate.
 * @param {number} freeBytes
 * @param {number} bitsPerSecond
 */
export function recordingTimeLeftMs(freeBytes, bitsPerSecond) {
  if (!(freeBytes > 0) || !(bitsPerSecond > 0)) return 0;
  return Math.floor((freeBytes * 8) / bitsPerSecond) * 1000;
}

/** "about 3 h", "about 25 min" */
export function formatRough(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes >= 120) return `about ${Math.floor(minutes / 60)} h`;
  if (minutes >= 1) return `about ${minutes} min`;
  return 'under a minute';
}

/**
 * @typedef {{ timeMs: number, label?: string }} Marker
 */

/**
 * Sorts markers, drops ones outside the recording, removes near-duplicates
 * and makes sure there is a chapter at 0:00. Returns [] when there are no
 * user markers (a lone "Start" chapter is noise).
 * @param {Marker[]} markers
 * @param {number} durationMs
 * @returns {{ timeMs: number, label: string }[]}
 */
export function normalizeMarkers(markers, durationMs) {
  const clean = (Array.isArray(markers) ? markers : [])
    .filter((m) => m && Number.isFinite(m.timeMs) && m.timeMs >= 0 && (!(durationMs > 0) || m.timeMs < durationMs))
    .map((m) => ({ timeMs: Math.floor(m.timeMs), label: String(m.label ?? '').trim() }))
    .sort((a, b) => a.timeMs - b.timeMs);
  if (clean.length === 0) return [];

  const out = [];
  for (const m of clean) {
    const prev = out[out.length - 1];
    if (prev && m.timeMs - prev.timeMs < 1000) continue; // double-press
    out.push(m);
  }
  if (out[0].timeMs >= 1000) out.unshift({ timeMs: 0, label: 'Start' });
  else out[0].timeMs = 0;

  let n = 0;
  return out.map((m) => {
    n += 1;
    return { timeMs: m.timeMs, label: m.label || (m.timeMs === 0 ? 'Start' : `Chapter ${n}`) };
  });
}

/**
 * Chapter list in the format YouTube (and most video hosts) parse from a
 * description: one "m:ss Title" per line, first at 0:00.
 * @param {Marker[]} markers
 * @param {number} durationMs
 */
export function chaptersText(markers, durationMs) {
  return normalizeMarkers(markers, durationMs)
    .map((m) => `${formatClock(m.timeMs)} ${m.label}`)
    .join('\n');
}

/**
 * ffmpeg FFMETADATA1 document carrying chapters, so players show them.
 * @param {Marker[]} markers
 * @param {number} durationMs
 * @param {string} [title]
 */
export function ffmetadata(markers, durationMs, title) {
  const esc = (s) => String(s).replace(/([=;#\\\n])/g, '\\$1');
  const lines = [';FFMETADATA1'];
  if (title) lines.push(`title=${esc(title)}`);
  const chapters = normalizeMarkers(markers, durationMs);
  chapters.forEach((c, i) => {
    const end = i + 1 < chapters.length ? chapters[i + 1].timeMs : Math.max(c.timeMs + 1, Math.floor(durationMs));
    lines.push('', '[CHAPTER]', 'TIMEBASE=1/1000', `START=${c.timeMs}`, `END=${end}`, `title=${esc(c.label)}`);
  });
  return `${lines.join('\n')}\n`;
}

/**
 * Tracks recorded time across pauses. Uses an injectable clock so it can be
 * tested without waiting.
 */
export class Stopwatch {
  /** @param {() => number} [now] */
  constructor(now = () => Date.now()) {
    this._now = now;
    this._accumulated = 0;
    this._startedAt = /** @type {number | null} */ (null);
  }
  start() {
    if (this._startedAt === null) this._startedAt = this._now();
  }
  pause() {
    if (this._startedAt !== null) {
      this._accumulated += this._now() - this._startedAt;
      this._startedAt = null;
    }
  }
  reset() {
    this._accumulated = 0;
    this._startedAt = null;
  }
  get running() {
    return this._startedAt !== null;
  }
  get elapsedMs() {
    return this._accumulated + (this._startedAt !== null ? this._now() - this._startedAt : 0);
  }
}
