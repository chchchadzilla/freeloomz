// Takes the README screenshots from the real app, at twice the size so they
// stay sharp on high-density screens. Run with `npm run screenshots` after
// changing how the control panel looks, then `npm run icons` to rebuild the
// banner that uses them.
//
// Uses Chromium's stand-in camera and microphone, so it works on a machine
// that has neither. On Linux it starts its own virtual display. Needs a
// Chromium for the stand-in desktop: set CHROME_PATH, or have Playwright's
// browsers installed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, _electron as electron } from 'playwright-core';
import { ensureDisplay, sleep } from '../test/e2e/helpers.mjs';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'docs/screenshots');

/** Something pleasant to record: a stand-in desktop with an app on it. */
const desktop = `
<html><body style="margin:0;height:100vh;overflow:hidden;font-family:Inter,system-ui,sans-serif;
  background:radial-gradient(120% 90% at 15% 10%,#2b3a67 0%,#1b1e3a 45%,#0f1020 100%)">
  <div style="position:absolute;left:12vw;top:11vh;width:76vw;height:74vh;border-radius:1.1vw;overflow:hidden;
    background:#f6f7fb;box-shadow:0 3vw 8vw rgba(0,0,0,.55);display:flex">
    <div style="width:17vw;background:#e9ebf3;padding:2.2vw 1.6vw;box-sizing:border-box">
      <div style="height:1.5vw;width:8vw;border-radius:.4vw;background:#3d4a8f"></div>
      ${[70, 55, 62, 48, 58].map((w) => `<div style="margin-top:1.7vw;height:1vw;width:${w}%;border-radius:.5vw;background:#c5c9da"></div>`).join('')}
    </div>
    <div style="flex:1;padding:2.6vw 3vw;box-sizing:border-box">
      <div style="height:2.2vw;width:26vw;border-radius:.5vw;background:#1f2440"></div>
      <div style="margin-top:1vw;height:1vw;width:38vw;border-radius:.5vw;background:#c5c9da"></div>
      <div style="display:flex;gap:1.6vw;margin-top:2.6vw">
        ${['#5b7cfa', '#34c38f', '#f7a94b'].map((c) => `<div style="flex:1;height:11vw;border-radius:.9vw;background:#fff;
          box-shadow:0 .3vw 1.2vw rgba(20,24,60,.10);padding:1.3vw;box-sizing:border-box">
          <div style="height:.9vw;width:45%;border-radius:.45vw;background:#c5c9da"></div>
          <div style="margin-top:1.3vw;height:2.6vw;width:60%;border-radius:.5vw;background:${c}"></div></div>`).join('')}
      </div>
      <div style="margin-top:1.8vw;height:19vw;border-radius:.9vw;background:#fff;box-shadow:0 .3vw 1.2vw rgba(20,24,60,.10);
        display:flex;align-items:flex-end;gap:1.5vw;padding:1.8vw 2.2vw;box-sizing:border-box">
        ${[38, 62, 45, 80, 56, 92, 70, 50, 84, 64].map((h) => `<div style="flex:1;height:${h}%;border-radius:.5vw .5vw 0 0;background:#5b7cfa"></div>`).join('')}
      </div>
    </div>
  </div>
</body></html>`;

/**
 * Runs the app in a fresh profile and hands back the tools to drive it.
 * @param {{ fakeDevices: boolean, settings?: any }} o
 * @param {(tools: { app: import('playwright-core').ElectronApplication, shoot: (name: string) => Promise<void>, until: (test: (s: any) => boolean, what: string) => Promise<void> }) => Promise<void>} task
 */
async function withApp({ fakeDevices, settings }, task) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freeloomz-shots-'));
  const userData = path.join(dir, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  if (settings) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify(settings));
  const app = await electron.launch({
    args: [
      '.',
      '--no-sandbox',
      '--force-device-scale-factor=2',
      // Chromium's stand-in camera and microphone, for machines with neither.
      // (They also replace the screen with a test pattern.)
      ...(fakeDevices ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] : []),
    ],
    cwd: root,
    env: { ...process.env, FREELOOMZ_E2E: '1', FREELOOMZ_USER_DATA: userData, FREELOOMZ_RECORDINGS: path.join(dir, 'recordings') },
  });
  try {
    let page = null;
    for (let i = 0; i < 200 && !page; i++) {
      page = app.windows().find((w) => w.url().includes('/control/index.html')) ?? null;
      if (!page) await sleep(100);
    }
    if (!page) throw new Error('The control window never opened');
    await page.waitForSelector('#recordButton', { state: 'attached' });
    await sleep(1500);
    const state = () => app.evaluate(() => /** @type {any} */ (globalThis).__freeloomz.controller.snapshot());
    await task({
      app,
      shoot: async (name) => {
        // The panel steps out of the way while recording; bring it back to look at.
        await app.evaluate(() => /** @type {any} */ (globalThis).__freeloomz.windows.showControl());
        await sleep(900); // let the fades settle
        await page.screenshot({ path: path.join(out, `${name}.png`) });
        console.log('wrote', `docs/screenshots/${name}.png`);
      },
      until: async (test, what) => {
        for (let i = 0; i < 300; i++) {
          if (test(await state())) return;
          await sleep(100);
        }
        throw new Error(`Timed out waiting for ${what}`);
      },
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Not awaited inside the app: start() only returns once recording is over.
const start = (/** @type {import('playwright-core').ElectronApplication} */ app) =>
  app.evaluate(() => {
    /** @type {any} */ (globalThis).__freeloomz.controller.start();
  });
const call = (/** @type {import('playwright-core').ElectronApplication} */ app, /** @type {string} */ method) =>
  app.evaluate((_electron, name) => /** @type {any} */ (globalThis).__freeloomz.controller[name](), method);

// Twice the window's size has to fit on the display.
const stopDisplay = await ensureDisplay({ width: 3840, height: 2160 });
try {
  // The panel before and during a recording, with camera and microphone on.
  await withApp({ fakeDevices: true }, async ({ app, shoot, until }) => {
    await shoot('ready');
    await start(app);
    await until((s) => s.status === 'recording', 'recording to start');
    await sleep(1200);
    await call(app, 'addMarker');
    await shoot('recording');
    await call(app, 'discard');
    await until((s) => s.status === 'idle', 'the recording to be discarded');
  });

  // The finished recording, made of the real screen so its preview shows
  // something worth looking at.
  const executablePath = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  // An app-style window (no tabs or address bar), then full screen.
  const browser = await chromium.launchPersistentContext('', {
    headless: false,
    executablePath,
    viewport: null,
    args: ['--app=about:blank', '--no-sandbox', '--hide-scrollbars', '--window-position=0,0', '--window-size=3840,2160'],
  });
  try {
    const wallpaper = browser.pages()[0] ?? (await browser.waitForEvent('page'));
    await wallpaper.setContent(desktop);
    await wallpaper.evaluate(() => document.body.addEventListener('click', () => document.documentElement.requestFullscreen(), { once: true }));
    await wallpaper.mouse.click(40, 40);
    await sleep(2500); // past the browser's "press Esc to leave full screen" note
    await withApp({ fakeDevices: false, settings: { mode: 'screen', micEnabled: false, countdown: 0 } }, async ({ app, shoot, until }) => {
      await start(app);
      await until((s) => s.status === 'recording', 'recording to start');
      await sleep(2500);
      await call(app, 'addMarker');
      await sleep(4500);
      await call(app, 'stop');
      await until((s) => s.status === 'idle', 'the recording to be saved');
      await sleep(1500); // the preview frame is grabbed just after saving
      await shoot('wrap');
    });
  } finally {
    await browser.close().catch(() => {});
  }
} finally {
  stopDisplay();
}
