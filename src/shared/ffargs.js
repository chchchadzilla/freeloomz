// ffmpeg argument builders and output parsers. Pure — no process spawning
// here, so every command line can be unit-tested.

const COMMON = ['-hide_banner', '-nostdin', '-y'];
const PROGRESS = ['-progress', 'pipe:1', '-nostats'];
const AAC = ['-c:a', 'aac', '-b:a', '160k', '-ar', '48000'];
// yuv420p + even dimensions = plays everywhere (QuickTime, browsers, phones).
const X264 = (crf) => ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'];
const EVEN = 'pad=ceil(iw/2)*2:ceil(ih/2)*2';

/**
 * Turns the raw streamed recording into a finished, seekable MP4.
 * When the video is already H.264 it is copied bit-for-bit (seconds, even
 * for hour-long recordings); otherwise it is re-encoded.
 * @param {{ input: string, output: string, videoCodec?: string, hasAudio?: boolean, metadataFile?: string }} o
 */
export function finalizeArgs({ input, output, videoCodec, hasAudio = true, metadataFile }) {
  const copyVideo = String(videoCodec ?? '').toLowerCase() === 'h264';
  const args = [...COMMON, ...PROGRESS, '-i', input];
  if (metadataFile) args.push('-f', 'ffmetadata', '-i', metadataFile);
  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', '0:a:0?');
  if (metadataFile) args.push('-map_metadata', '1', '-map_chapters', '1');
  if (copyVideo) args.push('-c:v', 'copy');
  else args.push('-vf', EVEN, ...X264(20));
  if (hasAudio) args.push(...AAC);
  args.push('-movflags', '+faststart', output);
  return args;
}

/**
 * Frame-accurate trim (re-encodes, because cutting compressed video without
 * re-encoding can only cut at keyframes, which are seconds apart).
 * @param {{ input: string, output: string, startSec: number, endSec: number, constantFps?: number }} o
 */
export function trimArgs({ input, output, startSec, endSec, constantFps }) {
  const start = Math.max(0, Number(startSec) || 0);
  const end = Number(endSec);
  const args = [...COMMON, ...PROGRESS];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', input);
  if (Number.isFinite(end) && end > start) args.push('-t', (end - start).toFixed(3));
  const filters = [EVEN];
  if (constantFps) filters.unshift(`fps=${constantFps}`);
  args.push('-map', '0:v:0', '-map', '0:a:0?', '-vf', filters.join(','), ...X264(19), ...AAC);
  // Chapters would point at the wrong moments after a cut.
  args.push('-map_chapters', '-1', '-movflags', '+faststart', output);
  return args;
}

/**
 * Animated GIF with a generated palette (far better colours than ffmpeg's
 * default 256-colour cube).
 * @param {{ input: string, output: string, startSec?: number, endSec?: number, fps?: number, width?: number }} o
 */
export function gifArgs({ input, output, startSec = 0, endSec, fps = 12, width = 960 }) {
  const start = Math.max(0, Number(startSec) || 0);
  const end = Number(endSec);
  const args = [...COMMON, ...PROGRESS];
  if (start > 0) args.push('-ss', start.toFixed(3));
  args.push('-i', input);
  if (Number.isFinite(end) && end > start) args.push('-t', (end - start).toFixed(3));
  const chain =
    `fps=${fps},scale='min(${width},iw)':-2:flags=lanczos,split[a][b];` +
    '[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4';
  args.push('-filter_complex', chain, '-an', '-loop', '0', output);
  return args;
}

/** @param {string} input */
export function probeArgs(input) {
  return ['-hide_banner', '-nostdin', '-i', input];
}

const toSeconds = (h, m, s) => Number(h) * 3600 + Number(m) * 60 + Number(s);

/**
 * Parses what `ffmpeg -i file` prints to stderr.
 * @param {string} text
 */
export function parseProbe(text) {
  const out = {
    durationSec: /** @type {number | null} */ (null),
    video: /** @type {{ codec: string, width: number, height: number, fps: number | null } | null} */ (null),
    audio: /** @type {{ codec: string, sampleRate: number | null } | null} */ (null),
    chapters: 0,
  };
  const dur = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  if (dur) out.durationSec = toSeconds(dur[1], dur[2], dur[3]);
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*Chapter #\d+[:.]\d+/.test(line)) out.chapters += 1;
    const v = /Stream #\d+:\d+.*?: Video: ([a-z0-9_]+)/i.exec(line);
    if (v && !out.video) {
      const size = /,\s*(\d{2,5})x(\d{2,5})[\s,[]/.exec(line);
      const fps = /([\d.]+)\s*fps/.exec(line);
      out.video = {
        codec: v[1].toLowerCase(),
        width: size ? Number(size[1]) : 0,
        height: size ? Number(size[2]) : 0,
        fps: fps ? Number(fps[1]) : null,
      };
    }
    const a = /Stream #\d+:\d+.*?: Audio: ([a-z0-9_]+)/i.exec(line);
    if (a && !out.audio) {
      const rate = /(\d+)\s*Hz/.exec(line);
      out.audio = { codec: a[1].toLowerCase(), sampleRate: rate ? Number(rate[1]) : null };
    }
  }
  return out;
}

/**
 * Reads one chunk of `-progress pipe:1` output and returns seconds encoded so
 * far, or null if the chunk carries no position.
 * @param {string} chunk
 */
export function parseProgressSeconds(chunk) {
  let latest = null;
  const re = /out_time_(?:us|ms)=(-?\d+)/g;
  let m;
  while ((m = re.exec(chunk))) {
    const us = Number(m[1]);
    if (us >= 0) latest = us / 1_000_000; // both keys are microseconds in practice
  }
  return latest;
}
