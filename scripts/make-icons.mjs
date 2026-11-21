// Renders the app, tray and README artwork from SVG. Run with `npm run icons`
// after changing the brand mark; the generated PNGs are committed, so
// building the app never needs this script.
//
// Needs a Chromium for rasterising: set CHROME_PATH, or have Playwright's
// browsers installed.

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.join(import.meta.dirname, '..');
const LIME = '#c6ff3d';
const CORAL = '#ff4d5e';

/** The mark: the two o's of "freeloomz" — a lens ring and a record dot. */
const mark = ({ ring = LIME, dot = CORAL, cx1, cx2, cy, r, stroke }) => `
  <circle cx="${cx1}" cy="${cy}" r="${r - stroke / 2}" fill="none" stroke="${ring}" stroke-width="${stroke}"/>
  <circle cx="${cx2}" cy="${cy}" r="${r}" fill="${dot}"/>`;

const appIcon = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#20242e"/><stop offset="1" stop-color="#08090c"/>
    </linearGradient>
    <radialGradient id="glow" cx="28%" cy="22%" r="75%">
      <stop offset="0" stop-color="${LIME}" stop-opacity=".16"/><stop offset="1" stop-color="${LIME}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="glow2" cx="80%" cy="85%" r="60%">
      <stop offset="0" stop-color="${CORAL}" stop-opacity=".20"/><stop offset="1" stop-color="${CORAL}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="204" fill="url(#bg)"/>
  <rect x="64" y="64" width="896" height="896" rx="204" fill="url(#glow)"/>
  <rect x="64" y="64" width="896" height="896" rx="204" fill="url(#glow2)"/>
  <rect x="65.5" y="65.5" width="893" height="893" rx="202.5" fill="none" stroke="#fff" stroke-opacity=".08" stroke-width="3"/>
  ${mark({ cx1: 329, cx2: 695, cy: 512, r: 165, stroke: 62 })}
</svg>`;

const trayMono = (color) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
  ${mark({ ring: color, dot: color, cx1: 4.7, cx2: 13.3, cy: 9, r: 4, stroke: 1.7 })}
</svg>`;

const trayColor = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
  ${mark({ cx1: 4.7, cx2: 13.3, cy: 9, r: 4, stroke: 1.8 })}
</svg>`;

const trayRecording = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 18" width="18" height="18">
  <circle cx="9" cy="9" r="6.2" fill="${CORAL}"/>
</svg>`;

// The wordmark is laid out by the browser (not hand-positioned), exactly like
// the one in the app's title bar: the two o's are a ring and a dot sitting
// on the baseline at the height of a lowercase letter.
const wordmark = (text) => `
<div id="wm" style="display:inline-flex;align-items:baseline;padding:28px 24px;
  font:800 120px Inter,'Segoe UI',system-ui,sans-serif;letter-spacing:-0.045em;color:${text};line-height:1">
  <span>freel</span>
  <span style="display:inline-block;box-sizing:border-box;width:.56em;height:.56em;margin:0 .03em 0 .035em;
    border:.145em solid ${LIME};border-radius:50%"></span>
  <span style="display:inline-block;width:.56em;height:.56em;margin-right:.025em;background:${CORAL};border-radius:50%"></span>
  <span>mz</span>
</div>`;

/** @type {{ file: string, svg: string, size?: [number, number], scale?: number, element?: string }[]} */
const jobs = [
  { file: 'build/icon.png', svg: appIcon, size: [1024, 1024] },
  { file: 'assets/icon.png', svg: appIcon, size: [1024, 1024], scale: 0.25 },
  { file: 'assets/trayTemplate.png', svg: trayMono('#000'), size: [18, 18] },
  { file: 'assets/trayTemplate@2x.png', svg: trayMono('#000'), size: [18, 18], scale: 2 },
  { file: 'assets/tray.png', svg: trayColor, size: [18, 18], scale: 32 / 18 },
  { file: 'assets/tray@2x.png', svg: trayColor, size: [18, 18], scale: 64 / 18 },
  { file: 'assets/tray-rec.png', svg: trayRecording, size: [18, 18], scale: 32 / 18 },
  { file: 'assets/tray-rec@2x.png', svg: trayRecording, size: [18, 18], scale: 64 / 18 },
  { file: 'assets/tray-rec-mac.png', svg: trayRecording, size: [18, 18] },
  { file: 'assets/tray-rec-mac@2x.png', svg: trayRecording, size: [18, 18], scale: 2 },
  { file: 'docs/wordmark-dark.png', svg: wordmark('#f4f5f7'), element: '#wm', scale: 2 },
  { file: 'docs/wordmark-light.png', svg: wordmark('#0b0c10'), element: '#wm', scale: 2 },
];

/**
 * Packs PNG images into a Windows .ico (Vista+ icons may hold PNGs as-is).
 * @param {{ size: number, png: Buffer }[]} images
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 means 256)
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const executablePath = process.env.CHROME_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
try {
  for (const job of jobs) {
    const [w, h] = job.size ?? [1200, 400];
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: job.scale ?? 1 });
    const page = await context.newPage();
    await page.setContent(`<html><body style="margin:0;background:transparent">${job.svg}</body></html>`);
    const out = path.join(root, job.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (job.element) await page.locator(job.element).screenshot({ path: out, omitBackground: true });
    else await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
    await context.close();
    console.log('wrote', job.file);
  }
  // Windows icon: the app icon at every size Windows asks for.
  const icoImages = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) {
    const context = await browser.newContext({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: size / 1024 });
    const page = await context.newPage();
    await page.setContent(`<html><body style="margin:0;background:transparent">${appIcon}</body></html>`);
    icoImages.push({ size, png: await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } }) });
    await context.close();
  }
  fs.writeFileSync(path.join(root, 'assets/icon.ico'), packIco(icoImages));
  console.log('wrote assets/icon.ico');
} finally {
  await browser.close();
}
