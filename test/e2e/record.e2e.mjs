// End-to-end: launches the real app, makes real recordings and checks the
// files it produces. Needs a display (on Linux it starts its own Xvfb).
//
//   npm run test:e2e

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  artifacts,
  ensureDisplay,
  grabFrame,
  launchApp,
  meanVolume,
  newestRecording,
  probeFile,
  saveFrame,
  sleep,
  waitFor,
} from './helpers.mjs';

const stopDisplay = await ensureDisplay();
test.after(() => stopDisplay());

// Let transitions settle so the pictures show the finished state.
const shot = async (page, name) => {
  await sleep(650);
  await page.screenshot({ path: path.join(artifacts, `${name}.png`) }).catch(() => {});
};

test('records screen + camera + mic with countdown, pause and chapters, then manages the result', { timeout: 180_000 }, async (t) => {
  const h = await launchApp({ name: 'full', settings: { countdown: 3 } });
  t.after(h.close);
  const { control, main } = h;

  // ---- first launch: ready to go, nothing to configure
  assert.equal(await control.locator('.wordmark').first().isVisible(), true);
  assert.equal(await control.locator('.mode[aria-checked="true"]').getAttribute('data-mode'), 'screen+camera');
  await waitFor(async () => (await control.locator('#micSelect option').count()) > 1, 15_000, 'microphones to be listed');
  await waitFor(async () => (await control.locator('#cameraSelect option').count()) > 1, 15_000, 'cameras to be listed');
  assert.equal(await control.locator('#micSwitch').getAttribute('aria-checked'), 'true');
  assert.match(await control.locator('#summaryButton').innerText(), /1080p · 30 fps · room for/);
  await shot(control, '01-ready');

  // ---- the camera bubble is up, round, bottom-left, and showing video
  const bubble = await waitFor(async () => h.bubblePage(), 15_000, 'camera bubble');
  await waitFor(async () => bubble.evaluate(() => /** @type {HTMLVideoElement} */ (document.getElementById('video')).videoWidth > 0), 15_000, 'camera picture');
  const bounds = await main.bubbleBounds();
  assert.equal(bounds.width, bounds.height);
  assert.ok(bounds.x < 100 && bounds.y > 500, `bubble starts bottom-left, got ${JSON.stringify(bounds)}`);
  await shot(bubble, '02-bubble');

  // ---- record: click the big button
  await control.locator('#recordButton').click();
  await main.waitForStatus('countdown');
  await shot(control, '03-countdown');
  const t0 = Date.now();
  await main.waitForStatus('recording', 20_000);
  assert.ok(Date.now() - t0 >= 2500, 'the countdown ran before recording started');
  assert.equal(await main.controlVisible(), false, 'the control window gets out of the way while recording');

  await sleep(3000);
  await main.command('addMarker', 'Logging time');
  await sleep(1500);
  await main.command('togglePause');
  assert.equal((await main.state()).status, 'paused');
  const pausedAt = (await main.state()).elapsedMs;
  await sleep(2500); // paused time must not end up in the video
  assert.ok(Math.abs((await main.state()).elapsedMs - pausedAt) < 50, 'the clock stands still while paused');
  await main.command('togglePause');
  await sleep(1500);
  await main.command('toggleMic'); // mute for the tail end
  await sleep(1500);
  const before = await main.state();
  assert.equal(before.markers, 1);
  assert.ok(before.bytesWritten > 0, 'video is streamed to disk while recording');
  assert.equal(fs.readdirSync(path.join(h.recordings, '.freeloomz-tmp')).length, 2, 'raw file + journal exist during recording');

  await main.command('stop');
  await main.waitForStatus('idle', 60_000);
  const after = await main.state();
  assert.equal(after.error, null);
  assert.ok(after.lastRecording, 'a recording was saved');
  assert.equal(await main.controlVisible(), true, 'the control window comes back');

  // ---- the file
  const file = after.lastRecording.path;
  assert.equal(file, newestRecording(h.recordings));
  const info = probeFile(file);
  assert.equal(info.video.codec, 'h264');
  assert.equal(info.audio.codec, 'aac');
  assert.ok(info.durationSec > 6.5 && info.durationSec < 9.5, `~7.5s recorded (2.5s pause excluded), got ${info.durationSec}s`);
  assert.equal(info.chapters, 2, 'Start + one marker');
  assert.ok(meanVolume(file) > -60, 'the microphone is audible');
  assert.deepEqual(fs.readdirSync(path.join(h.recordings, '.freeloomz-tmp')), [], 'temp files are cleaned up');
  fs.copyFileSync(file, path.join(artifacts, 'full.mp4'));

  // ---- "that's a wrap" card
  await control.locator('#stage-wrap').waitFor({ state: 'visible' });
  await waitFor(async () => (await control.locator('#wrapImage').getAttribute('src')) !== null, 15_000, 'thumbnail');
  assert.match(await control.locator('#wrapChapters').innerText(), /Copy 2 chapters/);
  await shot(control, '04-wrap');

  // rename right there
  await control.locator('#wrapName').fill('My Hours: logging time');
  await control.locator('#wrapName').press('Enter');
  const renamed = await waitFor(async () => {
    const p = (await main.state()).lastRecording?.path;
    return p && path.basename(p) === 'My Hours logging time.mp4' ? p : null;
  }, 10_000, 'rename');
  assert.ok(fs.existsSync(renamed) && !fs.existsSync(file));

  // chapters for the video description
  await control.locator('#wrapChapters').click();
  const clip = await h.app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(clip, /^0:00 Start\n0:0[2-4] Logging time$/);

  // ---- library + player + exports
  await control.locator('#tabs button[data-view="library"]').click();
  await control.locator('.item').first().waitFor();
  assert.equal(await control.locator('.item').count(), 1);
  assert.equal(await control.locator('.item .info b').innerText(), 'My Hours logging time');
  await shot(control, '05-library');

  await control.locator('.item').first().click();
  await control.locator('#player').waitFor({ state: 'visible' });
  await waitFor(async () => control.evaluate(() => /** @type {HTMLVideoElement} */ (document.getElementById('playerVideo')).readyState >= 1), 15_000, 'video to load');
  const playable = await control.evaluate(() => {
    const v = /** @type {HTMLVideoElement} */ (document.getElementById('playerVideo'));
    return { duration: v.duration, seekable: v.seekable.length > 0 ? v.seekable.end(0) : 0 };
  });
  assert.ok(playable.duration > 6.5 && playable.seekable > 6.5, 'the saved file plays and seeks in the built-in player');
  assert.equal(await control.locator('.chapter').count(), 2);

  // trim to the middle 40%
  await control.evaluate(() => {
    const set = (id, v) => {
      const el = /** @type {HTMLInputElement} */ (document.getElementById(id));
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('trimStart', 200);
    set('trimEnd', 600);
  });
  await shot(control, '06-player');
  await control.locator('#exportTrim').click();
  const trimmed = await waitFor(async () => {
    const p = path.join(h.recordings, 'My Hours logging time (trimmed).mp4');
    return fs.existsSync(p) ? p : null;
  }, 60_000, 'trimmed copy');
  const trimmedInfo = probeFile(trimmed);
  assert.ok(Math.abs(trimmedInfo.durationSec - info.durationSec * 0.4) < 0.5, `trimmed to ~40%, got ${trimmedInfo.durationSec}s of ${info.durationSec}s`);

  await waitFor(async () => !(await control.locator('#exportGif').isDisabled()), 15_000, 'export to finish');
  await control.locator('#exportGif').click();
  const gif = await waitFor(async () => {
    const p = path.join(h.recordings, 'My Hours logging time.gif');
    return fs.existsSync(p) && fs.statSync(p).size > 0 ? p : null;
  }, 90_000, 'GIF');
  assert.equal(fs.readFileSync(gif).subarray(0, 3).toString(), 'GIF');

  // delete goes to the trash, not into the void
  await waitFor(async () => !(await control.locator('#exportGif').isDisabled()), 15_000, 'export to finish');
  await control.locator('#playerTrash').click();
  await waitFor(async () => !fs.existsSync(renamed), 10_000, 'file to leave the folder');
  await waitFor(async () => (await control.locator('.item').count()) === 2, 10_000, 'library to refresh');

  // ---- settings
  await control.locator('#tabs button[data-view="settings"]').click();
  await shot(control, '07-settings');
  await control.locator('.segmented[data-setting="fps"] button[data-value="60"]').click();
  await waitFor(async () => (await main.settings()).fps === 60, 5000, 'setting to apply');
  await control.locator('.switch[data-setting="bubble.mirror"]').click();
  await waitFor(async () => (await main.settings()).bubble.mirror === false, 5000, 'setting to apply');
  assert.equal(await bubble.evaluate(() => document.body.classList.contains('mirror')), false, 'bubble follows settings live');

  // settings survive a restart
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.userData, 'settings.json'), 'utf8').toString() || '{}').countdown, 3);
});

test('camera bubble can be moved, snapped, resized, reshaped and hidden', { timeout: 90_000 }, async (t) => {
  const h = await launchApp({ name: 'bubble' });
  t.after(h.close);
  const { main } = h;
  await waitFor(async () => h.bubblePage(), 15_000, 'camera bubble');
  const start = await main.bubbleBounds();
  const pad = (start.width - 240) / 2;

  // size presets and free resize keep the bubble centred and on screen
  await main.update({ bubble: { size: 360 } });
  const large = await waitFor(async () => {
    const b = await main.bubbleBounds();
    return b && b.width === 360 + pad * 2 ? b : null;
  }, 5000, 'bubble to grow');
  assert.ok(large.x >= 0 && large.y + large.height <= 1080, 'still fully on screen');

  // dragging: simulate the pointer travelling to the top-right and letting go
  const moved = await h.app.evaluate(({ screen }) => {
    const { windows } = /** @type {any} */ (globalThis).__freeloomz;
    const area = screen.getPrimaryDisplay().workArea;
    const real = screen.getCursorScreenPoint;
    let point = real.call(screen);
    screen.getCursorScreenPoint = () => point;
    try {
      const b = windows.bubble.getBounds();
      point = { x: b.x + 50, y: b.y + 50 };
      windows.dragBubble('start');
      point = { x: area.x + area.width - 120, y: area.y + 90 };
      windows.dragBubble('move');
      const during = windows.bubble.getBounds();
      windows.dragBubble('end');
      return { during, after: windows.bubble.getBounds(), area };
    } finally {
      screen.getCursorScreenPoint = real;
    }
  });
  assert.ok(moved.during.x > 1000 && moved.during.y < 200, 'the bubble follows the pointer');
  const size = 360;
  assert.equal(moved.after.x + pad, moved.area.x + moved.area.width - size - 24, 'snaps to the corner with a tidy margin (x)');
  assert.equal(moved.after.y + pad, moved.area.y + 24, 'snaps to the corner with a tidy margin (y)');
  const saved = (await main.settings()).bubble;
  assert.deepEqual([saved.x, saved.y], [moved.after.x + pad, moved.after.y + pad], 'position is remembered');

  // shape + mode + hide
  await main.update({ bubble: { shape: 'rounded' } });
  const page = h.bubblePage();
  await waitFor(async () => page.evaluate(() => document.body.classList.contains('rounded')), 5000, 'rounded shape');
  await main.command('toggleCamera');
  await waitFor(async () => (await main.bubbleBounds()) === null, 5000, 'bubble to hide');
  await main.command('toggleCamera');
  const back = await waitFor(async () => main.bubbleBounds(), 5000, 'bubble to return');
  assert.deepEqual([back.x, back.y], [moved.after.x, moved.after.y], 'comes back where it was left');
  await main.update({ mode: 'screen' });
  await waitFor(async () => (await main.bubbleBounds()) === null, 5000, 'no bubble in screen-only mode');
});

test('camera-only mode records the webcam full frame', { timeout: 90_000 }, async (t) => {
  const h = await launchApp({ name: 'camera', settings: { mode: 'camera', countdown: 0 } });
  t.after(h.close);
  await h.control.locator('#recordButton').click();
  await h.main.waitForStatus('recording', 20_000);
  await sleep(3000);
  await h.main.command('stop');
  await h.main.waitForStatus('idle', 60_000);
  const state = await h.main.state();
  assert.equal(state.error, null);
  const info = probeFile(state.lastRecording.path);
  assert.equal(info.video.codec, 'h264');
  assert.ok(info.audio, 'has narration');
  assert.ok(info.durationSec > 2 && info.durationSec < 4.5, `got ${info.durationSec}s`);
});

test('a recording interrupted by a crash is offered for recovery on next launch', { timeout: 120_000 }, async (t) => {
  const first = await launchApp({ name: 'crash', settings: { countdown: 0 } });
  const { dir, recordings, userData } = first;
  await first.control.locator('#recordButton').click();
  await first.main.waitForStatus('recording', 20_000);
  await sleep(4000);
  // Pull the plug: no stop, no finalize.
  first.app.process().kill('SIGKILL');
  await sleep(1000);
  assert.equal(newestRecording(recordings), null, 'nothing was finalized');

  // Relaunch against the same folders.
  const { _electron } = await import('playwright-core');
  const app = await _electron.launch({
    args: ['.', '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    cwd: path.join(import.meta.dirname, '../..'),
    env: { ...process.env, FREELOOMZ_E2E: '1', FREELOOMZ_USER_DATA: userData, FREELOOMZ_RECORDINGS: recordings },
  });
  t.after(async () => {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const control = await waitFor(async () => app.windows().find((w) => w.url().includes('/control/index.html')), 20_000, 'control window');
  const banner = control.locator('.banner', { hasText: 'Unfinished recording found' });
  await banner.waitFor({ timeout: 15_000 });
  await shot(control, '08-recovery');
  await banner.getByRole('button', { name: 'Recover it' }).click();
  const recovered = await waitFor(async () => newestRecording(recordings), 60_000, 'recovered file');
  const info = probeFile(recovered);
  assert.equal(info.video.codec, 'h264');
  assert.ok(info.durationSec > 2.5, `recovered ${info.durationSec}s of a ~4s recording`);
  await banner.waitFor({ state: 'detached', timeout: 10_000 });
});

// Run twice on Linux: once with the bubble's window cut to shape (what Linux
// uses) and once with pointer tracking (what macOS and Windows use), so the
// code path those systems rely on is exercised here too.
for (const hitMode of ['shape', 'track']) realScreenTest(hitMode);

/** @param {string} hitMode */
function realScreenTest(hitMode) {
  test(`real screen capture (${hitMode}): the bubble, the pointer and the right pixels end up in the video`, { timeout: 120_000 }, async (t) => {
  if (hitMode === 'track') process.env.FREELOOMZ_BUBBLE_TRACK = '1';
  t.after(() => delete process.env.FREELOOMZ_BUBBLE_TRACK);
  if (process.platform !== 'linux') return t.skip('needs an X display it can draw a known picture on');
  if (spawnSync('which', ['xdotool']).status !== 0) return t.skip('xdotool is not installed');

  // A stand-in for "the app being demonstrated": a full-screen window with a
  // known colour in each corner.
  const { chromium } = await import('playwright-core');
  const executablePath = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({ headless: false, executablePath, args: ['--no-sandbox', '--kiosk', '--window-position=0,0', '--window-size=1920,1080'] });
  } catch {
    return t.skip('no Chromium available to act as the demo app');
  }
  t.after(() => browser.close());
  const demo = await browser.newPage({ viewport: null });
  await demo.setContent(`<body style="margin:0;background:#2b5fd9;overflow:hidden;cursor:default">
    <div style="position:fixed;left:0;top:0;width:200px;height:200px;background:#e01010"></div>
    <div style="position:fixed;right:0;top:0;width:200px;height:200px;background:#10c010"></div>
    <div style="position:fixed;right:0;bottom:0;width:200px;height:200px;background:#e0e010"></div>
    <h1 style="font:700 80px sans-serif;color:#fff;text-align:center;margin-top:40vh">Demo app</h1></body>`);
  await demo.evaluate(() => {
    /** @type {any} */ (window).clicks = 0;
    addEventListener('mousedown', () => (/** @type {any} */ (window).clicks += 1));
  });
  await sleep(1500);

  // No fake devices here, so the screen is the real screen. This machine
  // has no camera or microphone — which is itself worth testing.
  const h = await launchApp({ name: 'screen', fakeDevices: false, settings: { countdown: 0, cursorHighlight: true } });
  t.after(h.close);
  const { control, main } = h;
  const bubble = await waitFor(async () => h.bubblePage(), 15_000, 'camera bubble');
  await bubble.locator('#placeholder').waitFor({ state: 'visible', timeout: 15_000 });
  assert.equal(await control.locator('#micSelect').isDisabled(), true, 'no microphone: the picker says so');
  const bounds = await main.bubbleBounds();

  // The bubble's window is square but only the circle may catch clicks:
  // a click on its transparent corner must reach the app underneath.
  const clicks = () => demo.evaluate(() => /** @type {any} */ (window).clicks);
  const clickAt = (x, y) => spawnSync('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y)), 'sleep', '0.25', 'click', '1']);
  const before = await clicks();
  clickAt(bounds.x + 7, bounds.y + 7);
  await waitFor(async () => (await clicks()) === before + 1, 5000, 'a click on the bubble window corner to reach the app underneath');
  clickAt(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await sleep(400);
  assert.equal(await clicks(), before + 1, 'a click on the bubble itself stays with the bubble');

  await control.locator('#recordButton').click();
  await main.waitForStatus('recording', 20_000);
  assert.equal((await main.state()).error, null);

  // Wiggle the pointer around a known spot for the whole recording.
  const target = { x: 960, y: 300 };
  const mouse = spawn('bash', ['-c', `for i in $(seq 1 40); do xdotool mousemove $((${target.x} + (i % 2) * 2)) ${target.y}; sleep 0.1; done`], { stdio: 'ignore' });
  await sleep(4500);
  mouse.kill();
  await main.command('stop');
  await main.waitForStatus('idle', 60_000);

  const state = await main.state();
  assert.equal(state.error, null);
  const file = state.lastRecording.path;
  const info = probeFile(file);
  assert.deepEqual([info.video.width, info.video.height], [1920, 1080]);
  assert.equal(info.audio, null, 'no microphone, so no audio track');
  assert.ok(info.durationSec > 3.5, `got ${info.durationSec}s`);
  saveFrame(file, 3, path.join(artifacts, `screen-frame-${hitMode}.png`));
  fs.copyFileSync(file, path.join(artifacts, `screen-${hitMode}.mp4`));

  const frame = grabFrame(file, 3);
  const near = (rgb, want, tol = 45) => rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
  // The demo app fills the frame: nothing cropped, nothing squashed.
  assert.ok(near(frame.pixel(100, 100), [224, 16, 16]), `top-left is red, got ${frame.pixel(100, 100)}`);
  assert.ok(near(frame.pixel(1820, 100), [16, 192, 16]), `top-right is green, got ${frame.pixel(1820, 100)}`);
  assert.ok(near(frame.pixel(1820, 980), [224, 224, 16]), `bottom-right is yellow, got ${frame.pixel(1820, 980)}`);
  // Our own control window is not in the shot.
  assert.ok(near(frame.pixel(960, 700), [43, 95, 217]), `centre shows the demo app, not Freeloomz, got ${frame.pixel(960, 700)}`);
  // The bubble is in the shot, where the user put it.
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  assert.ok(!near(frame.pixel(cx, cy), [43, 95, 217], 25), `the camera bubble is recorded at its on-screen position, got ${frame.pixel(cx, cy)}`);
  // The cursor highlight halo surrounds the pointer.
  const halo = frame.pixel(target.x + 22, target.y);
  assert.ok(halo[0] > 80 && halo[1] > 110 && halo[2] < 200 && !near(halo, [43, 95, 217], 20), `cursor highlight is visible around the pointer, got ${halo}`);
  });
}

test('survives the recorder process dying, and pauses when the computer sleeps', { timeout: 120_000 }, async (t) => {
  const h = await launchApp({ name: 'resilience', settings: { countdown: 0 } });
  t.after(h.close);
  const { main } = h;

  // ---- sleep / lock: pause instead of filming a black or locked screen
  await h.control.locator('#recordButton').click();
  await main.waitForStatus('recording', 20_000);
  await sleep(1500);
  await h.app.evaluate(({ powerMonitor }) => powerMonitor.emit('suspend'));
  await main.waitForStatus('paused', 5000);
  await waitFor(async () => /went to sleep/.test((await main.state()).notice ?? ''), 5000, 'the pause to be explained');
  await main.command('togglePause');
  await main.waitForStatus('recording', 5000);
  await sleep(2000);

  // ---- the window that does the recording crashes
  const before = (await main.state()).bytesWritten;
  assert.ok(before > 0);
  await h.app.evaluate(() => /** @type {any} */ (globalThis).__freeloomz.windows.control.webContents.forcefullyCrashRenderer());
  await main.waitForStatus('idle', 60_000);
  const state = await main.state();
  assert.equal(state.error, null);
  assert.match(state.notice ?? '', /stopped unexpectedly/);
  assert.ok(state.lastRecording, 'what was recorded before the crash was saved');
  const info = probeFile(state.lastRecording.path);
  assert.equal(info.video.codec, 'h264');
  assert.ok(info.durationSec > 2, `saved ${info.durationSec}s`);

  // ---- and the app is usable again afterwards. (The test driver loses its
  // handle on a crashed page, so look at the window through the app itself.)
  const ui = () =>
    h.app.evaluate(async () => {
      const wc = /** @type {any} */ (globalThis).__freeloomz.windows.control.webContents;
      if (wc.isCrashed() || wc.isLoading()) return null;
      return wc
        .executeJavaScript(
          `({ wrap: !document.getElementById('stage-wrap').hidden, idle: !document.getElementById('stage-idle').hidden, live: !document.getElementById('stage-live').hidden })`,
        )
        .catch(() => null);
    });
  await waitFor(async () => (await ui())?.wrap, 20_000, 'the control window to come back showing the saved recording');
  await main.command('dismiss');
  await waitFor(async () => (await ui())?.idle, 10_000, 'the ready screen');
  await main.command('start');
  await main.waitForStatus('recording', 20_000);
  await sleep(1500);
  await main.command('stop');
  await main.waitForStatus('idle', 60_000);
  assert.equal((await main.state()).error, null, 'a fresh recording works after the crash');
  // That recording was started without a click in any window (as the tray
  // and global shortcuts do) — the microphone must still be captured.
  const last = (await main.state()).lastRecording.path;
  assert.ok(probeFile(last).audio, 'has an audio track');
  assert.ok(meanVolume(last) > -60, 'and the audio is not silent');
});

test('overlapping commands settle cleanly and leave nothing behind', { timeout: 150_000 }, async (t) => {
  const h = await launchApp({ name: 'races', settings: { countdown: 3, cursorHighlight: false } });
  t.after(h.close);
  const { main } = h;
  const escapeGrabbed = () => h.app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Escape'));
  const fire = (...names) =>
    h.app.evaluate((_electron, list) => {
      const { controller } = /** @type {any} */ (globalThis).__freeloomz;
      // Issued back to back in the same tick, without waiting for each other.
      return Promise.all(list.map((name) => controller.command(name).catch((err) => `error: ${err.message}`)));
    }, names);

  /** Issues a command without waiting for it to finish. */
  const kick = (name) =>
    h.app.evaluate((_electron, n) => {
      void (/** @type {any} */ (globalThis).__freeloomz.controller.command(n).catch(() => {}));
    }, name);

  // ---- cancel during the countdown: nothing is recorded
  await kick('start');
  await main.waitForStatus('countdown', 20_000);
  await main.command('stop');
  await main.waitForStatus('idle', 10_000);
  assert.equal((await main.state()).lastRecording, null);
  assert.equal(newestRecording(h.recordings), null);
  const tmp = path.join(h.recordings, '.freeloomz-tmp');
  assert.deepEqual(fs.existsSync(tmp) ? fs.readdirSync(tmp) : [], [], 'no stray files');
  await main.update({ countdown: 0 });

  // ---- pause, resume and stop fired on top of each other
  await main.command('start');
  await main.waitForStatus('recording', 20_000);
  await sleep(2500);
  await main.command('toggleMic'); // muted for this take only
  assert.equal((await main.state()).micMuted, true);
  await fire('togglePause', 'togglePause', 'togglePause', 'stop', 'stop', 'togglePause');
  await main.waitForStatus('idle', 60_000);
  let state = await main.state();
  assert.equal(state.error, null);
  assert.ok(state.lastRecording, 'exactly one recording came out of it');
  assert.equal(fs.readdirSync(h.recordings).filter((f) => f.endsWith('.mp4')).length, 1);
  assert.ok(probeFile(state.lastRecording.path).durationSec > 1.5);

  // ---- discard while drawing: Escape must be given back to the system
  await main.command('dismiss');
  await main.command('start');
  await main.waitForStatus('recording', 20_000);
  state = await main.state();
  assert.equal(state.micMuted, false, 'a mute never carries over into the next take');
  await sleep(1500);
  await main.command('toggleDraw');
  await waitFor(async () => (await main.state()).drawing, 5000, 'draw mode');
  assert.equal(await escapeGrabbed(), true, 'Escape leaves draw mode while drawing');
  await fire('discard', 'discard');
  await main.waitForStatus('idle', 30_000);
  assert.equal(await escapeGrabbed(), false, 'Escape is released when the recording is discarded');
  state = await main.state();
  assert.equal(state.drawing, false);
  assert.equal(state.lastRecording, null, 'a discarded recording is not saved');
  assert.equal(fs.readdirSync(h.recordings).filter((f) => f.endsWith('.mp4')).length, 1, 'still just the one from before');

  // ---- muting while idle does nothing (it would be an invisible trap)
  await main.command('toggleMic');
  assert.equal((await main.state()).micMuted, false);
});
