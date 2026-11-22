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

const dataUri = (/** @type {string} */ file) => `data:image/png;base64,${fs.readFileSync(path.join(root, file)).toString('base64')}`;
const FONT = "Inter,'Segoe UI',system-ui,sans-serif";

/** The wordmark as inline HTML, sized by the font-size of its container. */
const inlineWordmark = `
  <span style="display:inline-flex;align-items:baseline;font-weight:800;letter-spacing:-0.045em;line-height:1">
    <span>freel</span>
    <span style="display:inline-block;box-sizing:border-box;width:.56em;height:.56em;margin:0 .03em 0 .035em;
      border:.145em solid ${LIME};border-radius:50%"></span>
    <span style="display:inline-block;width:.56em;height:.56em;margin-right:.025em;background:${CORAL};border-radius:50%"></span>
    <span>mz</span>
  </span>`;

/**
 * The README banner and the link-preview card: the pitch on the left, the
 * real app on the right. Screenshots come from `npm run screenshots`.
 * @param {{ width: number, height: number, radius: number, shot: number, mark: number, headline: number, bubble: number }} o
 */
const banner = ({ width, height, radius, shot, mark, headline, bubble }) => `
<div id="banner" style="position:relative;width:${width}px;height:${height}px;overflow:hidden;border-radius:${radius}px;
  font-family:${FONT};color:#f2f3f5;background:linear-gradient(135deg,#171a22 0%,#0b0c10 55%,#08090c 100%)">
  <div style="position:absolute;inset:0;background:
    radial-gradient(60% 80% at 8% 0%,rgba(198,255,61,.13),transparent 62%),
    radial-gradient(55% 75% at 96% 100%,rgba(255,77,94,.20),transparent 60%)"></div>
  <div style="position:absolute;inset:0;background:url(${dataUri('src/renderer/shared/noise.png')});opacity:.22;mix-blend-mode:overlay"></div>

  <div style="position:absolute;left:${Math.round(width * 0.055)}px;top:0;bottom:0;width:${Math.round(width * 0.5)}px;
    display:flex;flex-direction:column;justify-content:center">
    <div style="align-self:flex-start;padding:7px 14px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.14em;
      color:${LIME};background:rgba(198,255,61,.10);box-shadow:inset 0 0 0 1px rgba(198,255,61,.28)">FREE &nbsp;·&nbsp; OPEN SOURCE &nbsp;·&nbsp; NO TIME LIMIT</div>
    <div style="margin-top:26px;font-size:${mark}px">${inlineWordmark}</div>
    <div style="margin-top:26px;font-size:${headline}px;font-weight:700;letter-spacing:-.02em;line-height:1.16;white-space:nowrap">
      Record your screen and your face.<br/><span style="color:#979eab">For as long as you like.</span></div>
    <div style="margin-top:22px;display:flex;gap:10px;font-size:15px;font-weight:600;color:#c9ced8">
      ${['No account', 'No watermark', 'Stays on your computer'].map((t) => `<span style="padding:8px 14px;border-radius:10px;
        background:rgba(255,255,255,.055);box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)">${t}</span>`).join('')}
    </div>
  </div>

  <div style="position:absolute;right:${Math.round(width * 0.06)}px;top:${Math.round(height * 0.1)}px;width:${Math.round(shot * 1.72)}px;height:${height}px">
    <img src="${dataUri('docs/screenshots/ready.png')}" style="position:absolute;left:0;top:${Math.round(height * 0.07)}px;width:${shot}px;
      border-radius:16px;transform:rotate(-5deg);opacity:.9;
      box-shadow:0 0 0 1px rgba(255,255,255,.10),0 30px 60px rgba(0,0,0,.55)"/>
    <img src="${dataUri('docs/screenshots/recording.png')}" style="position:absolute;right:0;top:0;width:${shot}px;
      border-radius:16px;transform:rotate(3deg);
      box-shadow:0 0 0 1px rgba(255,255,255,.12),0 2px 0 rgba(255,255,255,.05) inset,0 40px 80px rgba(0,0,0,.65)"/>
    <!-- The camera bubble: the round window that rides along in every recording. -->
    <svg viewBox="0 0 120 120" style="position:absolute;left:${Math.round(shot * bubble)}px;top:${Math.round(height * 0.5)}px;
      width:${Math.round(shot * 0.5)}px;height:${Math.round(shot * 0.5)}px;filter:drop-shadow(0 18px 30px rgba(0,0,0,.6))">
      <defs>
        <linearGradient id="bub" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#46506a"/><stop offset="1" stop-color="#1a1d29"/></linearGradient>
        <clipPath id="clip"><circle cx="60" cy="60" r="54"/></clipPath>
      </defs>
      <circle cx="60" cy="60" r="54" fill="url(#bub)"/>
      <g clip-path="url(#clip)" fill="#d7dbe6">
        <circle cx="60" cy="50" r="19"/>
        <path d="M22 120c0-25 17-39 38-39s38 14 38 39z"/>
      </g>
      <circle cx="60" cy="60" r="56" fill="none" stroke="#fff" stroke-opacity=".92" stroke-width="4"/>
      <circle cx="98" cy="22" r="9" fill="${CORAL}" stroke="#0b0c10" stroke-width="3"/>
    </svg>
  </div>
  <div style="position:absolute;inset:0;border-radius:${radius}px;box-shadow:inset 0 0 0 1px rgba(255,255,255,.09)"></div>
</div>`;

const glyphs = {
  windows: '<path d="M2 3.5 10.5 2.3v8.2H2zM11.7 2.1 22 .7v9.8H11.7zM2 11.7h8.5v8.2L2 18.7zM11.7 11.7H22v9.8l-10.3-1.4z" transform="translate(0 .9)" fill="currentColor"/>',
  terminal: '<path d="M4 6.5 9.5 12 4 17.5M12 18h8" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
  code: '<path d="M8.5 6.5 3 12l5.5 5.5M15.5 6.5 21 12l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
};

/**
 * A README button. They are images so they look the same in GitHub's light
 * and dark themes; the README wraps each in a link.
 * @param {{ label: string, glyph: keyof typeof glyphs, primary?: boolean }} o
 */
const button = ({ label, glyph, primary = false }) => `
<div id="btn" style="display:inline-flex;align-items:center;gap:11px;height:52px;padding:0 24px 0 20px;box-sizing:border-box;
  border-radius:14px;font:700 17px ${FONT};letter-spacing:-.01em;white-space:nowrap;
  ${
    primary
      ? `color:#0b0c10;background:linear-gradient(180deg,#d9ff7a 0%,${LIME} 55%,#b2ec26 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.65),inset 0 0 0 1px rgba(11,12,16,.10)`
      : 'color:#f2f3f5;background:linear-gradient(180deg,#1d2029 0%,#14161c 100%);box-shadow:inset 0 1px 0 rgba(255,255,255,.08),inset 0 0 0 1px rgba(255,255,255,.14)'
  }">
  <svg viewBox="0 0 24 24" width="20" height="20">${glyphs[glyph]}</svg><span>${label}</span>
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
  { file: 'docs/banner.webp', svg: banner({ width: 1280, height: 520, radius: 28, shot: 258, mark: 98, headline: 34, bubble: -0.2 }), size: [1400, 700], element: '#banner', scale: 2 },
  // Upload as the repository's social preview (Settings > General); GitHub wants 1280x640.
  { file: 'docs/social-preview.jpg', svg: banner({ width: 1280, height: 640, radius: 0, shot: 300, mark: 104, headline: 36, bubble: -0.03 }), size: [1400, 800], element: '#banner' },
  { file: 'docs/button-windows.png', svg: button({ label: 'Install on Windows', glyph: 'windows', primary: true }), element: '#btn', scale: 2 },
  { file: 'docs/button-mac-linux.png', svg: button({ label: 'macOS & Linux', glyph: 'terminal' }), element: '#btn', scale: 2 },
  { file: 'docs/button-source.png', svg: button({ label: 'Build from source', glyph: 'code' }), element: '#btn', scale: 2 },
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
    if (job.file.endsWith('.jpg')) await page.locator(job.element ?? 'body').screenshot({ path: out, type: 'jpeg', quality: 92 });
    else if (job.file.endsWith('.webp')) {
      // Chromium only saves PNG and JPEG; WebP keeps the transparent corners
      // at a tenth of the PNG's size, so re-encode in the page.
      const png = await page.locator(job.element ?? 'body').screenshot({ omitBackground: true });
      const webp = await page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        return canvas.toDataURL('image/webp', 0.9).split(',')[1];
      }, png.toString('base64'));
      fs.writeFileSync(out, Buffer.from(webp, 'base64'));
    }
    else if (job.element) await page.locator(job.element).screenshot({ path: out, omitBackground: true });
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
