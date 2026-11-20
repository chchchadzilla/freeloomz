// Integration tests for the on-disk recording pipeline, using the real
// bundled ffmpeg: write chunks the way the recorder does, then finalize and
// check the finished file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

import { runFfmpeg, probe } from '../../src/main/ffmpeg.js';
import {
  RecordingSession,
  finalizeRecording,
  findOrphans,
  discardOrphan,
  tmpDirFor,
} from '../../src/main/recording-session.js';
import { Library, isInside } from '../../src/main/library.js';
import { SettingsStore } from '../../src/main/settings-store.js';
import { trimArgs, gifArgs } from '../../src/shared/ffargs.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeloomz-test-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/**
 * Builds a "live" stream like MediaRecorder's: no duration in the header, not
 * seekable. Returns it as a buffer.
 * @param {'h264' | 'vp9'} codec
 * @param {number} seconds
 */
async function makeRawStream(codec, seconds, { audio = true } = {}) {
  const ext = codec === 'h264' ? 'mkv' : 'webm';
  const file = path.join(tmpRoot, `src-${codec}-${seconds}-${audio}.${ext}`);
  const video = codec === 'h264' ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] : ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'];
  await runFfmpeg([
    '-hide_banner', '-nostdin', '-y',
    '-f', 'lavfi', '-i', `testsrc2=size=640x360:rate=30:duration=${seconds}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-c:a', 'libopus'] : []),
    ...video,
    '-live', '1', // header written without duration/cues, like a live recording
    '-f', ext === 'mkv' ? 'matroska' : 'webm', file,
  ]);
  return fsp.readFile(file);
}

/**
 * @param {string} dir
 * @param {string} mime
 * @param {Buffer} data
 * @param {{ markers?: { timeMs: number, label?: string }[], durationMs?: number, chunkSize?: number }} [opts]
 */
async function recordInto(dir, mime, data, { markers = [], durationMs = 0, chunkSize = 64 * 1024 } = {}) {
  const session = new RecordingSession({ recordingsDir: dir, mime });
  await session.open();
  for (let i = 0; i < data.length; i += chunkSize) await session.write(data.subarray(i, i + chunkSize));
  for (const m of markers) session.addMarker(m.timeMs, m.label);
  return { session, close: () => session.close(durationMs) };
}

test('H.264 recording is finalized to a seekable MP4 without re-encoding, with chapters', async () => {
  const dir = path.join(tmpRoot, 'h264');
  const data = await makeRawStream('h264', 6);
  const { session, close } = await recordInto(dir, 'video/x-matroska;codecs=avc1,opus', data, {
    durationMs: 6000,
    markers: [{ timeMs: 2000, label: 'Second part' }, { timeMs: 4000 }],
  });
  assert.equal(session.bytesWritten, data.length);
  assert.ok(session.chunks > 1, 'written in several chunks');

  // The raw stream really is duration-less, like MediaRecorder output.
  assert.equal((await probe(session.rawPath)).durationSec, null);
  await close();

  const progress = [];
  const result = await finalizeRecording({ recordingsDir: dir, journal: session.journal, onProgress: (f) => progress.push(f) });

  assert.equal(path.extname(result.path), '.mp4');
  assert.equal(path.dirname(result.path), dir);
  assert.ok(Math.abs(result.durationMs - 6000) < 250, `duration ${result.durationMs}`);
  assert.equal(result.width, 640);
  assert.equal(result.height, 360);
  assert.equal(result.hasAudio, true);
  assert.deepEqual(result.markers.map((m) => m.timeMs), [0, 2000, 4000]);

  const info = await probe(result.path);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.audio.codec, 'aac');
  assert.equal(info.chapters, 3);
  assert.ok(progress.length > 0 && progress.every((f) => f >= 0 && f <= 1));

  // moov atom before mdat = starts playing immediately when streamed.
  const head = await fsp.readFile(result.path).then((b) => b.subarray(0, 4096).toString('latin1'));
  assert.ok(head.includes('moov'), 'faststart: moov atom is at the front');

  // Temp files are cleaned up.
  assert.deepEqual(await fsp.readdir(tmpDirFor(dir)), []);
});

test('VP9 recording is transcoded to H.264 MP4', async () => {
  const dir = path.join(tmpRoot, 'vp9');
  const data = await makeRawStream('vp9', 3);
  const { session, close } = await recordInto(dir, 'video/webm;codecs=vp9,opus', data, { durationMs: 3000 });
  await close();
  const result = await finalizeRecording({ recordingsDir: dir, journal: session.journal });
  const info = await probe(result.path);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.audio.codec, 'aac');
  assert.ok(Math.abs(info.durationSec - 3) < 0.25);
  assert.equal(info.chapters, 0);
});

test('video-only recording finalizes without an audio track', async () => {
  const dir = path.join(tmpRoot, 'silent');
  const data = await makeRawStream('h264', 2, { audio: false });
  const { session, close } = await recordInto(dir, 'video/x-matroska;codecs=avc1', data, { durationMs: 2000 });
  await close();
  const result = await finalizeRecording({ recordingsDir: dir, journal: session.journal });
  assert.equal(result.hasAudio, false);
  assert.equal((await probe(result.path)).audio, null);
});

test('finished recordings never overwrite each other', async () => {
  const dir = path.join(tmpRoot, 'unique');
  const data = await makeRawStream('h264', 2);
  const paths = [];
  for (let i = 0; i < 2; i += 1) {
    const session = new RecordingSession({ recordingsDir: dir, mime: 'video/x-matroska;codecs=avc1,opus', now: new Date(2026, 0, 2, 3, 4, 5) });
    await session.open();
    await session.write(data);
    await session.close(2000);
    paths.push((await finalizeRecording({ recordingsDir: dir, journal: session.journal })).path);
  }
  assert.equal(path.basename(paths[0]), 'Freeloomz 2026-01-02 at 03.04.05.mp4');
  assert.equal(path.basename(paths[1]), 'Freeloomz 2026-01-02 at 03.04.05 (2).mp4');
});

test('an interrupted recording is found and can be recovered', async () => {
  const dir = path.join(tmpRoot, 'crash');
  const data = await makeRawStream('h264', 4);
  // Simulate a crash: chunks were written, the app died before close().
  // Cut the stream mid-file too — the tail of a crashed recording is ragged.
  const { session } = await recordInto(dir, 'video/x-matroska;codecs=avc1,opus', data.subarray(0, Math.floor(data.length * 0.8)));
  session.noteElapsed(3200);

  const orphans = await findOrphans(dir);
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].journal.id, session.journal.id);
  assert.equal(orphans[0].journal.closed, false);
  assert.ok(orphans[0].sizeBytes > 0);
  assert.deepEqual(await findOrphans(dir, session.journal.id), [], 'the active recording is not an orphan');

  const result = await finalizeRecording({ recordingsDir: dir, journal: orphans[0].journal });
  const info = await probe(result.path);
  assert.equal(info.video.codec, 'h264');
  assert.ok(info.durationSec > 2 && info.durationSec < 4.2, `recovered ${info.durationSec}s`);
  assert.deepEqual(await findOrphans(dir), []);
});

test('a recording that cannot be processed is rescued, not deleted', async () => {
  const dir = path.join(tmpRoot, 'broken');
  const garbage = Buffer.alloc(200_000, 7);
  const { session, close } = await recordInto(dir, 'video/webm;codecs=vp9,opus', garbage, { durationMs: 5000 });
  await close();
  await assert.rejects(
    finalizeRecording({ recordingsDir: dir, journal: session.journal }),
    (/** @type {any} */ err) => {
      assert.match(err.message, /Your recording is safe/);
      assert.ok(fs.existsSync(err.rescuedPath));
      assert.equal(fs.statSync(err.rescuedPath).size, garbage.length);
      assert.match(path.basename(err.rescuedPath), /\(unprocessed\)\.webm$/);
      return true;
    },
  );
});

test('empty and discarded recordings leave nothing behind', async () => {
  const dir = path.join(tmpRoot, 'empty');
  const empty = new RecordingSession({ recordingsDir: dir, mime: 'video/webm' });
  await empty.open();
  await empty.close(0);
  await assert.rejects(finalizeRecording({ recordingsDir: dir, journal: empty.journal }), /Nothing was recorded/);

  const dropped = new RecordingSession({ recordingsDir: dir, mime: 'video/webm' });
  await dropped.open();
  await dropped.write(Buffer.from('abc'));
  await dropped.discard();

  const orphan = new RecordingSession({ recordingsDir: dir, mime: 'video/webm' });
  await orphan.open();
  await orphan.write(Buffer.from('abc'));
  assert.equal((await findOrphans(dir)).length, 1);
  await discardOrphan(dir, orphan.journal);
  assert.deepEqual(await findOrphans(dir), []);
  assert.deepEqual((await fsp.readdir(tmpDirFor(dir))).filter((n) => !n.startsWith(orphan.journal.id)), []);
});

test('findOrphans ignores journals that point outside the temp folder', async () => {
  const dir = path.join(tmpRoot, 'traversal');
  await fsp.mkdir(tmpDirFor(dir), { recursive: true });
  await fsp.writeFile(path.join(dir, 'victim.mp4'), 'important');
  await fsp.writeFile(
    path.join(tmpDirFor(dir), 'evil.json'),
    JSON.stringify({ id: 'evil', rawFile: '../victim.mp4', baseName: 'x', mime: 'video/webm', startedAt: 1, durationMs: 0, markers: [] }),
  );
  assert.deepEqual(await findOrphans(dir), []);
  assert.equal(await fsp.readFile(path.join(dir, 'victim.mp4'), 'utf8'), 'important');
});

test('library lists recordings with duration and thumbnail, and renames safely', async () => {
  const dir = path.join(tmpRoot, 'library');
  const data = await makeRawStream('h264', 3);
  const { session, close } = await recordInto(dir, 'video/x-matroska;codecs=avc1,opus', data, { durationMs: 3000 });
  await close();
  const result = await finalizeRecording({ recordingsDir: dir, journal: session.journal });
  await fsp.writeFile(path.join(dir, 'notes.txt'), 'not a video');

  const library = new Library({ indexFile: path.join(tmpRoot, 'lib', 'index.json'), thumbsDir: path.join(tmpRoot, 'lib', 'thumbs') });
  const updated = once(library, 'updated');
  const first = await library.list(dir);
  assert.equal(first.length, 1, 'only video files are listed; the temp folder is skipped');
  assert.equal(first[0].durationMs, null, 'unknown until inspected');

  // Background inspection fills in the details, then announces it.
  await updated;
  const [item] = await library.list(dir);
  assert.ok(Math.abs(item.durationMs - 3000) < 250);
  assert.equal(item.width, 640);
  assert.ok(item.thumbnail && fs.statSync(item.thumbnail).size > 500, 'thumbnail was generated');

  const renamed = await library.rename(result.path, 'My Hours: getting started?');
  assert.equal(path.basename(renamed), 'My Hours getting started.mp4');
  assert.ok(fs.existsSync(renamed) && !fs.existsSync(result.path));
  const [after] = await library.list(dir);
  assert.equal(after.name, 'My Hours getting started');
  assert.ok(after.thumbnail, 'thumbnail follows the rename');
  await assert.rejects(library.rename(renamed, '???'), /no usable characters/);

  // Changing only the capitalisation is a rename, not a name clash.
  const recased = await library.rename(renamed, 'MY HOURS getting started');
  assert.equal(path.basename(recased), 'MY HOURS getting started.mp4');
  const back = await library.rename(recased, 'My Hours getting started');
  assert.equal(back, renamed);

  library.flush();
  assert.ok(fs.existsSync(path.join(tmpRoot, 'lib', 'index.json')));

  // Trim + GIF exports work on the finished file.
  const trimmed = path.join(dir, 'trimmed.mp4');
  await runFfmpeg(trimArgs({ input: renamed, output: trimmed, startSec: 0.5, endSec: 2 }));
  assert.ok(Math.abs((await probe(trimmed)).durationSec - 1.5) < 0.2);
  const gif = path.join(dir, 'clip.gif');
  await runFfmpeg(gifArgs({ input: renamed, output: gif, startSec: 0, endSec: 1, width: 320 }));
  assert.equal((await fsp.readFile(gif)).subarray(0, 3).toString(), 'GIF');
});

test('isInside only accepts files directly in the folder', () => {
  const dir = path.join(tmpRoot, 'x');
  assert.equal(isInside(path.join(dir, 'a.mp4'), dir), true);
  assert.equal(isInside(path.join(dir, '..', 'a.mp4'), dir), false);
  assert.equal(isInside(path.join(dir, 'sub', 'a.mp4'), dir), false);
  assert.equal(isInside(dir, dir), false);
  assert.equal(isInside('/etc/passwd', dir), false);
});

test('SettingsStore persists, validates and survives a corrupt file', async () => {
  const file = path.join(tmpRoot, 'settings', 'settings.json');
  const store = new SettingsStore(file);
  let changes = 0;
  store.on('change', () => (changes += 1));
  store.update({ fps: 60, bubble: { size: 300 } });
  store.update({ fps: 60 }); // no-op
  assert.equal(changes, 1);
  store.flush();
  assert.equal(new SettingsStore(file).get().fps, 60);
  assert.equal(new SettingsStore(file).get().bubble.size, 300);

  await fsp.writeFile(file, '{ this is not json');
  assert.equal(new SettingsStore(file).get().fps, 30, 'falls back to defaults');
});
