import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  DEFAULT_SETTINGS,
  sanitizeSettings,
  mergeSettings,
  targetFrameSize,
  videoBitrate,
  BUBBLE_MIN,
  BUBBLE_MAX,
} from '../../src/shared/defaults.js';
import {
  formatClock,
  formatBytes,
  normalizeMarkers,
  chaptersText,
  ffmetadata,
  Stopwatch,
  recordingTimeLeftMs,
} from '../../src/shared/time.js';
import { recordingBaseName, sanitizeFileName, uniquePath, rawExtensionFor, pickMimeType } from '../../src/shared/naming.js';
import { clampToArea, defaultBubblePosition, snapToCorner, resizeAroundCenter, shapeRects } from '../../src/shared/geometry.js';
import { finalizeArgs, trimArgs, gifArgs, parseProbe, parseProgressSeconds } from '../../src/shared/ffargs.js';

// ---------------------------------------------------------------- settings

test('sanitizeSettings returns full defaults for garbage input', () => {
  for (const junk of [null, undefined, 42, 'nope', [], { bubble: 7, shortcuts: 'x' }]) {
    assert.deepEqual(sanitizeSettings(junk), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  }
});

test('sanitizeSettings keeps valid values and rejects invalid ones', () => {
  const s = sanitizeSettings({
    mode: 'screen',
    fps: 60,
    resolution: 999, // not an allowed value
    quality: 'ultra', // not an allowed value
    countdown: 5,
    micEnabled: 'yes', // wrong type
    recordingsDir: '/tmp/out',
    bubble: { size: 5000, shape: 'hexagon', mirror: false, x: 10.6, y: Number.NaN },
    shortcuts: { toggleRecord: 'Ctrl+Alt+9', togglePause: '', bogus: 'X' },
    injected: true,
  });
  assert.equal(s.mode, 'screen');
  assert.equal(s.fps, 60);
  assert.equal(s.resolution, 1080);
  assert.equal(s.quality, 'high');
  assert.equal(s.countdown, 5);
  assert.equal(s.micEnabled, true);
  assert.equal(s.recordingsDir, '/tmp/out');
  assert.equal(s.bubble.size, BUBBLE_MAX);
  assert.equal(s.bubble.shape, 'circle');
  assert.equal(s.bubble.mirror, false);
  assert.equal(s.bubble.x, 11);
  assert.equal(s.bubble.y, null);
  assert.equal(s.shortcuts.toggleRecord, 'Ctrl+Alt+9');
  assert.equal(s.shortcuts.togglePause, '', 'empty string disables a shortcut');
  assert.equal('bogus' in s.shortcuts, false);
  assert.equal('injected' in s, false);
  assert.equal(sanitizeSettings({ bubble: { size: 1 } }).bubble.size, BUBBLE_MIN);
});

test('mergeSettings patches nested objects without dropping siblings', () => {
  const base = sanitizeSettings({ bubble: { size: 300, mirror: false } });
  const next = mergeSettings(base, { bubble: { x: 40, y: 50 }, fps: 60 });
  assert.equal(next.bubble.size, 300);
  assert.equal(next.bubble.mirror, false);
  assert.equal(next.bubble.x, 40);
  assert.equal(next.fps, 60);
  assert.equal(next.shortcuts.toggleRecord, DEFAULT_SETTINGS.shortcuts.toggleRecord);
});

test('targetFrameSize caps height, keeps aspect ratio, returns even numbers, never upscales', () => {
  assert.deepEqual(targetFrameSize(1920, 1080, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(targetFrameSize(3840, 2160, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(targetFrameSize(1280, 720, 1080), { width: 1280, height: 720 });
  assert.deepEqual(targetFrameSize(1365, 767, 0), { width: 1364, height: 766 });
  const mbp = targetFrameSize(3024, 1964, 1080); // 14" MacBook Pro panel
  assert.equal(mbp.height, 1080);
  assert.equal(mbp.width % 2, 0);
  assert.ok(Math.abs(mbp.width / mbp.height - 3024 / 1964) < 0.01);
  assert.deepEqual(targetFrameSize(0, 0, 1080), { width: 1920, height: 1080 });
});

test('videoBitrate grows with pixels and quality and stays in sane bounds', () => {
  const std = videoBitrate(1920, 1080, 30, 'standard');
  const high = videoBitrate(1920, 1080, 30, 'high');
  const max = videoBitrate(1920, 1080, 30, 'max');
  assert.ok(std < high && high < max);
  assert.ok(high >= 6_000_000 && high <= 9_000_000, `1080p30 high was ${high}`);
  assert.ok(videoBitrate(1280, 720, 30, 'high') < high);
  assert.ok(videoBitrate(1920, 1080, 60, 'high') > high);
  assert.ok(videoBitrate(7680, 4320, 60, 'max') <= 60_000_000);
  assert.ok(videoBitrate(320, 200, 15, 'standard') >= 1_500_000);
});

// -------------------------------------------------------------------- time

test('formatClock', () => {
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatClock(83_000), '1:23');
  assert.equal(formatClock(83_999), '1:23');
  assert.equal(formatClock(3_723_000), '1:02:03');
  assert.equal(formatClock(59_000, { padMinutes: true }), '00:59');
  assert.equal(formatClock(-5), '0:00');
  assert.equal(formatClock(Number.NaN), '0:00');
});

test('formatBytes and recordingTimeLeftMs', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.00 GB');
  assert.equal(formatBytes(-1), '—');
  // 1 GB at 8 Mbit/s is ~17.9 minutes.
  const ms = recordingTimeLeftMs(1024 ** 3, 8_000_000);
  assert.ok(ms > 17 * 60_000 && ms < 18 * 60_000);
  assert.equal(recordingTimeLeftMs(0, 8_000_000), 0);
});

test('normalizeMarkers sorts, de-duplicates, clips and adds a 0:00 chapter', () => {
  const markers = [
    { timeMs: 65_000, label: 'Invoices' },
    { timeMs: 12_000 },
    { timeMs: 12_400 }, // double press
    { timeMs: 999_999, label: 'after the end' },
    { timeMs: -1 },
  ];
  const out = normalizeMarkers(markers, 120_000);
  assert.deepEqual(out, [
    { timeMs: 0, label: 'Start' },
    { timeMs: 12_000, label: 'Chapter 2' },
    { timeMs: 65_000, label: 'Invoices' },
  ]);
  assert.deepEqual(normalizeMarkers([], 60_000), []);
  assert.deepEqual(normalizeMarkers(/** @type {any} */ (null), 60_000), []);
  assert.equal(normalizeMarkers([{ timeMs: 300, label: 'Intro' }], 60_000)[0].timeMs, 0);
});

test('chaptersText matches the format video hosts parse', () => {
  const text = chaptersText([{ timeMs: 75_000, label: 'Log time' }, { timeMs: 3_700_000, label: 'Reports' }], 4_000_000);
  assert.equal(text, '0:00 Start\n1:15 Log time\n1:01:40 Reports');
});

test('ffmetadata writes contiguous chapters and escapes special characters', () => {
  const doc = ffmetadata([{ timeMs: 10_000, label: 'A=B; #1' }], 30_000, 'My video');
  assert.match(doc, /^;FFMETADATA1\ntitle=My video\n/);
  assert.match(doc, /START=0\nEND=10000\ntitle=Start/);
  assert.match(doc, /START=10000\nEND=30000\ntitle=A\\=B\\; \\#1/);
  assert.equal(ffmetadata([], 30_000).includes('[CHAPTER]'), false);
});

test('Stopwatch excludes paused time', () => {
  let now = 1000;
  const sw = new Stopwatch(() => now);
  assert.equal(sw.elapsedMs, 0);
  sw.start();
  now += 5000;
  assert.equal(sw.elapsedMs, 5000);
  sw.pause();
  now += 60_000; // paused for a minute
  assert.equal(sw.elapsedMs, 5000);
  assert.equal(sw.running, false);
  sw.start();
  sw.start(); // idempotent
  now += 2500;
  assert.equal(sw.elapsedMs, 7500);
  sw.reset();
  assert.equal(sw.elapsedMs, 0);
});

// ------------------------------------------------------------------ naming

test('recordingBaseName is sortable and filesystem-safe', () => {
  const name = recordingBaseName(new Date(2026, 10, 20, 9, 5, 7));
  assert.equal(name, 'Freeloomz 2026-11-20 at 09.05.07');
  assert.equal(sanitizeFileName(name), name);
});

test('sanitizeFileName strips characters that are illegal on any OS', () => {
  assert.equal(sanitizeFileName('My Hours: intro / part 1?'), 'My Hours intro part 1');
  assert.equal(sanitizeFileName('  trailing dots... '), 'trailing dots');
  assert.equal(sanitizeFileName('CON'), 'CON_');
  assert.equal(sanitizeFileName('<>:"/\\|?*'), '');
  assert.equal(sanitizeFileName('x'.repeat(500)).length, 120);
});

test('uniquePath appends a counter until the name is free', () => {
  const taken = new Set([path.join('/v', 'a.mp4'), path.join('/v', 'a (2).mp4')]);
  const p = uniquePath('/v', 'a', '.mp4', (f) => taken.has(f), path.join);
  assert.equal(p, path.join('/v', 'a (3).mp4'));
  assert.equal(uniquePath('/v', 'b', '.mp4', () => false, path.join), path.join('/v', 'b.mp4'));
});

test('pickMimeType prefers H.264 and falls back gracefully', () => {
  const all = () => true;
  assert.equal(pickMimeType(all, true), 'video/webm;codecs=h264,opus');
  assert.equal(pickMimeType(all, false), 'video/webm;codecs=h264');
  const noH264 = (m) => !/h264|avc1/.test(m);
  assert.equal(pickMimeType(noH264, true), 'video/webm;codecs=vp9,opus');
  assert.equal(pickMimeType(() => false, true), '');
  assert.equal(rawExtensionFor('video/x-matroska;codecs=avc1,opus'), '.mkv');
  assert.equal(rawExtensionFor('video/webm;codecs=vp9'), '.webm');
});

// ---------------------------------------------------------------- geometry

const AREA = { x: 0, y: 0, width: 1920, height: 1040 };

test('defaultBubblePosition is the bottom-left corner with a margin', () => {
  assert.deepEqual(defaultBubblePosition(AREA, 240), { x: 24, y: 1040 - 240 - 24 });
  // Secondary display to the left of the primary one.
  assert.deepEqual(defaultBubblePosition({ x: -1280, y: 100, width: 1280, height: 700 }, 200), { x: -1256, y: 576 });
});

test('clampToArea keeps the bubble on screen', () => {
  assert.deepEqual(clampToArea({ x: -50, y: 5000, width: 240, height: 240 }, AREA), { x: 0, y: 800, width: 240, height: 240 });
  assert.deepEqual(clampToArea({ x: 100, y: 100, width: 240, height: 240 }, AREA), { x: 100, y: 100, width: 240, height: 240 });
});

test('snapToCorner snaps near corners and leaves the middle alone', () => {
  const near = snapToCorner({ x: 1650, y: 30, width: 240, height: 240 }, AREA);
  assert.deepEqual([near.x, near.y], [1920 - 240 - 24, 24]);
  const middle = snapToCorner({ x: 800, y: 400, width: 240, height: 240 }, AREA);
  assert.deepEqual([middle.x, middle.y], [800, 400]);
  const offscreen = snapToCorner({ x: 5000, y: 5000, width: 240, height: 240 }, AREA);
  assert.deepEqual([offscreen.x, offscreen.y], [1920 - 240 - 24, 1040 - 240 - 24]);
});

test('resizeAroundCenter keeps the centre fixed', () => {
  const r = resizeAroundCenter({ x: 100, y: 100, width: 200, height: 200 }, 300);
  assert.deepEqual(r, { x: 50, y: 50, width: 300, height: 300 });
});

test('shapeRects covers a circle: right area, symmetric, inside the window', () => {
  const size = 240;
  const rects = shapeRects('circle', size);
  const area = rects.reduce((sum, r) => sum + r.width * r.height, 0);
  const ideal = Math.PI * (size / 2) ** 2;
  assert.ok(Math.abs(area - ideal) / ideal < 0.02, `area off by ${(area / ideal - 1) * 100}%`);
  for (const r of rects) {
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= size && r.y + r.height <= size);
    assert.equal(r.x, size - (r.x + r.width), 'strip is horizontally centred');
  }
  assert.equal(rects.reduce((sum, r) => sum + r.height, 0), size, 'no gaps between strips');

  const rounded = shapeRects('rounded', size);
  const roundedArea = rounded.reduce((sum, r) => sum + r.width * r.height, 0);
  assert.ok(roundedArea > area && roundedArea < size * size);
  assert.ok(shapeRects('circle', 240, 12).every((r) => r.x >= 12 && r.y >= 12 && r.x + r.width <= 228));
  assert.deepEqual(shapeRects('circle', 0), []);
});

// ------------------------------------------------------------------ ffmpeg

test('finalizeArgs copies H.264 video and re-encodes anything else', () => {
  const copy = finalizeArgs({ input: 'in.mkv', output: 'out.mp4', videoCodec: 'h264' });
  assert.deepEqual(copy.slice(copy.indexOf('-c:v'), copy.indexOf('-c:v') + 2), ['-c:v', 'copy']);
  assert.ok(copy.includes('+faststart'));
  assert.ok(copy.includes('aac'));
  assert.equal(copy.at(-1), 'out.mp4');
  assert.equal(copy.includes('libx264'), false);

  const transcode = finalizeArgs({ input: 'in.webm', output: 'out.mp4', videoCodec: 'vp9' });
  assert.ok(transcode.includes('libx264'));
  assert.ok(transcode.includes('yuv420p'));

  const silent = finalizeArgs({ input: 'in.mkv', output: 'out.mp4', videoCodec: 'h264', hasAudio: false });
  assert.equal(silent.includes('aac'), false);
  assert.equal(silent.includes('0:a:0?'), false);

  const chapters = finalizeArgs({ input: 'in.mkv', output: 'out.mp4', videoCodec: 'h264', metadataFile: 'meta.txt' });
  assert.ok(chapters.join(' ').includes('-f ffmetadata -i meta.txt'));
  assert.ok(chapters.join(' ').includes('-map_chapters 1'));
});

test('trimArgs seeks before the input and limits the duration', () => {
  const args = trimArgs({ input: 'a.mp4', output: 'b.mp4', startSec: 12.5, endSec: 72.25 });
  const s = args.join(' ');
  assert.ok(s.indexOf('-ss 12.500') < s.indexOf('-i a.mp4'));
  assert.ok(s.includes('-t 59.750'));
  assert.ok(s.includes('libx264'));
  assert.ok(s.includes('-map_chapters -1'));
  assert.equal(trimArgs({ input: 'a.mp4', output: 'b.mp4', startSec: 0, endSec: 10 }).includes('-ss'), false);
  assert.ok(trimArgs({ input: 'a', output: 'b', startSec: 0, endSec: 10, constantFps: 30 }).join(' ').includes('fps=30,'));
});

test('gifArgs builds a palette pipeline', () => {
  const s = gifArgs({ input: 'a.mp4', output: 'a.gif', startSec: 2, endSec: 8 }).join(' ');
  assert.ok(s.includes('palettegen') && s.includes('paletteuse'));
  assert.ok(s.includes('-ss 2.000') && s.includes('-t 6.000'));
  assert.ok(s.endsWith('a.gif'));
});

test('parseProbe reads duration, streams and chapters from ffmpeg output', () => {
  const text = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'out.mp4':
  Duration: 00:01:06.03, start: 0.000000, bitrate: 393 kb/s
  Chapters:
    Chapter #0:0: start 0.000000, end 10.000000
    Chapter #0:1: start 10.000000, end 66.000000
  Stream #0:0[0x1](eng): Video: h264 (Constrained Baseline) (avc1 / 0x31637661), yuv420p(tv, smpte170m, progressive), 1662x1078, 279 kb/s, SAR 1:1 DAR 16:9, 29.97 fps, 30 tbr, 16k tbn (default)
  Stream #0:1[0x2](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 105 kb/s (default)
At least one output file must be specified`;
  const p = parseProbe(text);
  assert.ok(Math.abs(p.durationSec - 66.03) < 1e-9);
  assert.deepEqual(p.video, { codec: 'h264', width: 1662, height: 1078, fps: 29.97 });
  assert.deepEqual(p.audio, { codec: 'aac', sampleRate: 48000 });
  assert.equal(p.chapters, 2);

  const raw = parseProbe(`  Duration: N/A, start: 0.000000, bitrate: N/A
  Stream #0:0(eng): Audio: opus, 48000 Hz, stereo, fltp (default)
  Stream #0:1(eng): Video: vp9 (Profile 0), yuv420p(tv), 1920x1080, SAR 1:1 DAR 16:9, 30 tbr, 1k tbn (default)`);
  assert.equal(raw.durationSec, null);
  assert.equal(raw.video.codec, 'vp9');
  assert.equal(raw.video.width, 1920);
  assert.equal(raw.audio.codec, 'opus');
  assert.equal(parseProbe('no such file').video, null);
});

test('parseProgressSeconds returns the latest position', () => {
  assert.equal(parseProgressSeconds('frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2500000\n'), 2.5);
  assert.equal(parseProgressSeconds('out_time_ms=4000000\n'), 4);
  assert.equal(parseProgressSeconds('out_time_us=-9223372036854775807\n'), null);
  assert.equal(parseProgressSeconds('frame=1\n'), null);
});
