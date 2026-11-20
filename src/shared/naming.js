// File naming helpers. Pure.

const pad = (n) => String(n).padStart(2, '0');

/**
 * "Freeloomz 2026-11-20 at 14.32.05" — sorts chronologically and is valid on
 * every filesystem (no colons).
 * @param {Date} [date]
 */
export function recordingBaseName(date = new Date()) {
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const t = `${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
  return `Freeloomz ${d} at ${t}`;
}

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/**
 * Makes a user-typed name safe to use as a file name on Windows, macOS and
 * Linux. Returns '' when nothing usable is left.
 * @param {string} name
 */
export function sanitizeFileName(name) {
  let s = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, ''); // Windows strips trailing dots/spaces
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (RESERVED.test(s)) s = `${s}_`;
  return s;
}

/**
 * First of "base.ext", "base (2).ext", "base (3).ext"… that is free.
 * @param {string} dir
 * @param {string} base file name without extension
 * @param {string} ext  with leading dot
 * @param {(path: string) => boolean} exists
 * @param {(...parts: string[]) => string} join
 */
export function uniquePath(dir, base, ext, exists, join) {
  let candidate = join(dir, `${base}${ext}`);
  for (let n = 2; exists(candidate) && n < 10_000; n += 1) {
    candidate = join(dir, `${base} (${n})${ext}`);
  }
  return candidate;
}

/**
 * Container extension for a MediaRecorder MIME type.
 * @param {string} mime
 */
export function rawExtensionFor(mime) {
  const m = String(mime).toLowerCase();
  if (m.includes('matroska')) return '.mkv';
  if (m.includes('mp4')) return '.mp4';
  return '.webm';
}

/**
 * Picks the best supported recording format. H.264 first: it can be put into
 * an MP4 without re-encoding the video, so finishing a long recording takes
 * seconds instead of minutes.
 * @param {(mime: string) => boolean} isSupported
 * @param {boolean} hasAudio
 */
export function pickMimeType(isSupported, hasAudio) {
  const audio = hasAudio ? ',opus' : '';
  const candidates = [
    `video/webm;codecs=h264${audio}`,
    `video/x-matroska;codecs=avc1${audio}`,
    `video/webm;codecs=vp9${audio}`,
    `video/webm;codecs=vp8${audio}`,
    'video/webm',
  ];
  return candidates.find((c) => isSupported(c)) ?? '';
}
