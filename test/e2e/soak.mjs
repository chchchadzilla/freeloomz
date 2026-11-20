// Long-recording soak test: records for several minutes (default 6.5 — past
// the 5-minute cap of the free tools this app replaces) while sampling the
// app's memory, then checks the result.
//
//   npm run test:soak            # 6.5 minutes
//   SOAK_MINUTES=30 npm run test:soak

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { artifacts, ensureDisplay, launchApp, meanVolume, probeFile, sleep } from './helpers.mjs';

const minutes = Number(process.env.SOAK_MINUTES) || 6.5;
const stopDisplay = await ensureDisplay();
const h = await launchApp({ name: 'soak', settings: { countdown: 0 } });
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

try {
  await h.control.locator('#recordButton').click();
  await h.main.waitForStatus('recording', 30_000);
  const startedAt = Date.now();
  log(`recording for ${minutes} min…`);

  /** @type {{ t: number, mb: number, bytes: number }[]} */
  const samples = [];
  while (Date.now() - startedAt < minutes * 60_000) {
    await sleep(15_000);
    const state = await h.main.state();
    assert.equal(state.status, 'recording', `still recording (${state.error ?? state.notice ?? 'no message'})`);
    const sample = { t: Math.round((Date.now() - startedAt) / 1000), mb: await h.main.memory(), bytes: state.bytesWritten };
    samples.push(sample);
    if (samples.length % 4 === 0) log(`t=${sample.t}s  memory=${sample.mb} MB  on disk=${(sample.bytes / 1e6).toFixed(1)} MB  clock=${Math.round(state.elapsedMs / 1000)}s`);
  }

  const wallMs = Date.now() - startedAt;
  const stopAt = Date.now();
  await h.main.command('stop'); // resolves once the file is finished
  await h.main.waitForStatus('idle', 180_000);
  const finalizeMs = Date.now() - stopAt;
  const state = await h.main.state();
  assert.equal(state.error, null);

  const file = state.lastRecording.path;
  const info = probeFile(file);
  const sizeMb = fs.statSync(file).size / 1e6;
  log(`saved ${path.basename(file)}: ${info.durationSec.toFixed(1)}s, ${sizeMb.toFixed(1)} MB, stopped and finished in ${(finalizeMs / 1000).toFixed(1)}s`);

  // Length matches the wall clock: no dropped stretches, no drift.
  assert.ok(Math.abs(info.durationSec * 1000 - wallMs) < 2500, `recorded ${info.durationSec}s over ${wallMs / 1000}s of wall time`);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.audio.codec, 'aac');
  assert.ok(meanVolume(file) > -60, 'audio is present through the file');

  // Memory stays flat: video goes to disk, not into RAM. Compare the average
  // of the last quarter with the first quarter (after warm-up).
  const quarter = Math.max(1, Math.floor(samples.length / 4));
  const avg = (list) => list.reduce((sum, s) => sum + s.mb, 0) / list.length;
  const early = avg(samples.slice(1, 1 + quarter));
  const late = avg(samples.slice(-quarter));
  const growth = late - early;
  log(`memory: early ${early.toFixed(0)} MB → late ${late.toFixed(0)} MB (growth ${growth.toFixed(0)} MB) while ${sizeMb.toFixed(0)} MB went to disk`);
  assert.ok(growth < 120, `memory grew by ${growth.toFixed(0)} MB`);

  // The far end of the file is intact and seekable.
  const { grabFrame } = await import('./helpers.mjs');
  const frame = grabFrame(file, info.durationSec - 2);
  assert.equal(frame.width, info.video.width);

  fs.writeFileSync(
    path.join(artifacts, 'soak.json'),
    JSON.stringify({ minutes, wallMs, durationSec: info.durationSec, sizeMb, finalizeMs, early, late, growth, samples }, null, 2),
  );
  log('SOAK PASSED');
} catch (err) {
  console.error('SOAK FAILED:', err);
  process.exitCode = 1;
} finally {
  await h.close();
  stopDisplay();
}
