import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseProbe, parseProgressSeconds, probeArgs } from '../shared/ffargs.js';

let cachedPath = /** @type {string | null} */ (null);

/** Absolute path of the bundled ffmpeg binary. */
export function ffmpegPath() {
  if (cachedPath) return cachedPath;
  if (process.env.FREELOOMZ_FFMPEG) {
    cachedPath = process.env.FREELOOMZ_FFMPEG;
    return cachedPath;
  }
  const require = createRequire(import.meta.url);
  /** @type {string} */
  const bundled = require('ffmpeg-static');
  // Inside a packaged app the binary lives next to the archive, not in it:
  // executables cannot be run from inside app.asar.
  cachedPath = bundled.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return cachedPath;
}

/**
 * Runs ffmpeg to completion.
 * @param {string[]} args
 * @param {{ totalSec?: number | null, onProgress?: (fraction: number) => void, signal?: AbortSignal, allowFailure?: boolean }} [opts]
 * @returns {Promise<{ code: number | null, stderr: string }>}
 */
export function runFfmpeg(args, opts = {}) {
  const { totalSec, onProgress, signal, allowFailure = false } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let settled = false;

    const onAbort = () => child.kill();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (!onProgress || !(totalSec > 0)) return;
      const seconds = parseProgressSeconds(chunk);
      if (seconds !== null) onProgress(Math.min(1, Math.max(0, seconds / totalSec)));
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000); // keep the tail only
    });

    const finish = (/** @type {Error | null} */ err, /** @type {number | null} */ code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve({ code, stderr });
    };

    child.on('error', (err) => finish(new Error(`Could not run ffmpeg (${ffmpegPath()}): ${err.message}`), null));
    child.on('close', (code) => {
      if (signal?.aborted) return finish(new Error('Cancelled'), code);
      if (code !== 0 && !allowFailure) {
        const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
        return finish(new Error(`ffmpeg failed (exit ${code}):\n${tail}`), code);
      }
      finish(null, code);
    });
  });
}

/**
 * Reads duration, codecs and frame size of a media file.
 * @param {string} file
 */
export async function probe(file) {
  // `ffmpeg -i file` with no output exits non-zero by design; the stream
  // description it prints first is what we are after.
  const { stderr } = await runFfmpeg(probeArgs(file), { allowFailure: true });
  return parseProbe(stderr);
}
