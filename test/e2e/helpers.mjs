// Shared plumbing for the end-to-end tests: launch the real app, drive it,
// and inspect what it recorded.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';
import { parseProbe } from '../../src/shared/ffargs.js';

const require = createRequire(import.meta.url);
export const root = path.join(import.meta.dirname, '../..');
export const ffmpeg = /** @type {string} */ (require('ffmpeg-static'));
export const artifacts = process.env.E2E_ARTIFACTS || path.join(root, 'test-results');
fs.mkdirSync(artifacts, { recursive: true });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Starts a private X server when there is no display (CI, containers).
 * Returns a cleanup function.
 */
export async function ensureDisplay({ width = 1920, height = 1080 } = {}) {
  if (process.platform !== 'linux' || (process.env.DISPLAY && !process.env.E2E_OWN_DISPLAY)) return () => {};
  const number = 90 + Math.floor(Math.random() * 400);
  const display = `:${number}`;
  const procs = [spawn('Xvfb', [display, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp'], { stdio: 'ignore' })];
  await sleep(800);
  // A window manager and compositor make it behave like a real desktop
  // (always-on-top, transparent windows). Optional: skipped if missing.
  for (const helper of ['openbox', 'xcompmgr']) {
    if (spawnSync('which', [helper]).status === 0) {
      procs.push(spawn(helper, [], { stdio: 'ignore', env: { ...process.env, DISPLAY: display } }));
    }
  }
  await sleep(500);
  process.env.DISPLAY = display;
  return () => {
    for (const p of procs.reverse()) p.kill();
  };
}

/**
 * @param {{ fakeDevices?: boolean, settings?: any, name: string }} o
 */
export async function launchApp({ fakeDevices = true, settings, name }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `freeloomz-e2e-${name}-`));
  const userData = path.join(dir, 'userdata');
  const recordings = path.join(dir, 'recordings');
  fs.mkdirSync(userData, { recursive: true });
  if (settings) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));

  // Set FREELOOMZ_APP_BINARY to test a packaged build instead of the source
  // tree (e.g. dist/linux-unpacked/freeloomz).
  const binary = process.env.FREELOOMZ_APP_BINARY;
  const args = binary ? ['--no-sandbox'] : ['.', '--no-sandbox'];
  // Chromium's fake devices give us a camera and a microphone on machines
  // that have neither. (They also replace the screen with a test pattern,
  // which is why real screen capture gets its own test without them.)
  if (fakeDevices) args.push('--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream');

  const app = await electron.launch({
    args,
    ...(binary ? { executablePath: path.resolve(root, binary) } : {}),
    cwd: root,
    env: { ...process.env, FREELOOMZ_E2E: '1', FREELOOMZ_USER_DATA: userData, FREELOOMZ_RECORDINGS: recordings },
  });
  const logs = [];
  app.process().stderr?.on('data', (d) => logs.push(String(d)));

  /** The control panel page. */
  const control = await waitFor(async () => app.windows().find((w) => w.url().includes('/control/index.html')), 20_000, 'control window');
  await control.waitForSelector('#recordButton', { state: 'attached' });

  const main = {
    state: () => app.evaluate(() => /** @type {any} */ (globalThis).__freeloomz.controller.snapshot()),
    command: (name, arg) =>
      app.evaluate((_electron, [n, a]) => /** @type {any} */ (globalThis).__freeloomz.controller.command(n, a), [name, arg]),
    settings: () => app.evaluate(() => /** @type {any} */ (globalThis).__freeloomz.settings.get()),
    update: (patch) => app.evaluate((_electron, p) => /** @type {any} */ (globalThis).__freeloomz.settings.update(p), patch),
    controlVisible: () =>
      app.evaluate(() => {
        const w = /** @type {any} */ (globalThis).__freeloomz.windows.control;
        return Boolean(w && !w.isDestroyed() && w.isVisible());
      }),
    bubbleBounds: () =>
      app.evaluate(() => {
        const w = /** @type {any} */ (globalThis).__freeloomz.windows.bubble;
        return w && !w.isDestroyed() ? w.getBounds() : null;
      }),
    memory: () =>
      app.evaluate(({ app: a }) => {
        const metrics = a.getAppMetrics();
        return Math.round(metrics.reduce((sum, m) => sum + m.memory.workingSetSize, 0) / 1024); // MB
      }),
    waitForStatus: (status, timeout = 30_000) =>
      waitFor(async () => ((await main.state()).status === status ? true : null), timeout, `status "${status}"`),
  };

  const bubblePage = () => app.windows().find((w) => w.url().includes('/bubble/index.html'));
  const close = async () => {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { app, control, main, bubblePage, recordings, userData, dir, logs, close };
}

/**
 * Polls until `fn` returns something truthy.
 * @template T
 * @param {() => Promise<T | null | undefined | false>} fn
 * @param {number} timeoutMs
 * @param {string} what
 * @returns {Promise<T>}
 */
export async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Duration, codecs, size and chapter count of a media file. */
export function probeFile(file) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', file], { encoding: 'utf8' });
  return parseProbe(result.stderr);
}

/**
 * Extracts one frame as raw RGB.
 * @param {string} file
 * @param {number} atSec
 * @returns {{ width: number, height: number, pixel: (x: number, y: number) => [number, number, number] }}
 */
export function grabFrame(file, atSec) {
  const info = probeFile(file);
  const { width, height } = info.video;
  const result = spawnSync(
    ffmpeg,
    ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { maxBuffer: width * height * 3 + 1024 },
  );
  const data = result.stdout;
  if (data.length < width * height * 3) throw new Error(`Could not read a frame at ${atSec}s from ${file}: ${result.stderr}`);
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = (Math.round(y) * width + Math.round(x)) * 3;
      return [data[i], data[i + 1], data[i + 2]];
    },
  };
}

/** Saves a frame as PNG for a human to look at. */
export function saveFrame(file, atSec, out) {
  spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-ss', String(atSec), '-i', file, '-frames:v', '1', out]);
}

/** Mean volume of the audio track in dBFS (−91 is digital silence). */
export function meanVolume(file) {
  const result = spawnSync(ffmpeg, ['-hide_banner', '-nostdin', '-i', file, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(result.stderr);
  return match ? Number(match[1]) : null;
}

/** Latest finished recording in a folder. */
export function newestRecording(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => path.join(dir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}
