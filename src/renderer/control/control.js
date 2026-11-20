// Control panel behaviour. The window is a thin view over two things owned
// by the main process: `settings` (what the user chose) and `state` (what
// the recorder is doing). Every interaction sends a change request; every
// repaint comes from the broadcast that follows.

import { SHORTCUT_ACTIONS, SHORTCUT_LABELS } from '../../shared/defaults.js';
import { formatBytes, formatClock, formatRough, recordingTimeLeftMs } from '../../shared/time.js';
import { enter, leave, stagger, switcher, syncThumb, DURATION, EASE } from '../shared/motion.js';
import { connectEngine, MicMonitor } from './engine.js';

const api = /** @type {any} */ (window).freeloomz;
/** @type {<T extends HTMLElement = HTMLElement>(id: string) => T} */
const $ = (id) => /** @type {any} */ (document.getElementById(id));

/** @type {any} */ let settings;
/** @type {any} */ let state;
/** @type {any} */ let caps;
/** @type {any[]} */ let displays = [];
/** @type {any} */ let permissions = {};
/** @type {Record<string, string>} */ let shortcutErrors = {};
/** @type {any[]} */ let library = [];
/** @type {any[]} */ let orphans = [];
/** @type {MediaDeviceInfo[]} */ let cameras = [];
/** @type {MediaDeviceInfo[]} */ let mics = [];
let recordingsDir = '';
let freeBytes = /** @type {number | null} */ (null);
let estimatedBps = 0;
let currentView = 'record';
/** @type {any} */ let playing = null; // library item open in the player
let exporting = false;
/** Cross-fading panel groups; created in boot(). */
/** @type {ReturnType<typeof switcher>} */ let views;
/** @type {ReturnType<typeof switcher>} */ let stages;
/** Last values written to the DOM, so repaints only touch what changed. */
/** @type {Record<string, any>} */ const painted = {};
/** @param {string} key @param {any} value @param {() => void} paint */
function paintOnce(key, value, paint) {
  if (painted[key] === value) return;
  painted[key] = value;
  paint();
}

connectEngine();
const micMonitor = new MicMonitor((level) => {
  const bars = $('micMeter').children;
  const lit = Math.round(level * bars.length);
  for (let i = 0; i < bars.length; i += 1) bars[i].classList.toggle('on', i < lit);
});

// ---------------------------------------------------------------- helpers

const update = (patch) => api.invoke('settings:update', patch);
const command = (name, arg) => api.invoke('ctl:command', name, arg).catch((err) => toast(cleanError(err)));
const cleanError = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let toastTimer = 0;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  enter(node, { y: 12, easing: EASE.spring });
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => leave(node, { y: 8 }), 2600);
}

/** "Alt+Shift+R" → "⌥ ⇧ R" on macOS, "Alt + Shift + R" elsewhere. */
function prettyShortcut(accelerator) {
  if (!accelerator) return '';
  const mac = caps.platform === 'darwin';
  const names = mac
    ? { Alt: '⌥', Option: '⌥', Shift: '⇧', Command: '⌘', Cmd: '⌘', Control: '⌃', Ctrl: '⌃', CommandOrControl: '⌘', Super: '⌘' }
    : { CommandOrControl: 'Ctrl', Control: 'Ctrl', Super: 'Win', Return: 'Enter' };
  return accelerator
    .split('+')
    .map((part) => names[part] ?? part)
    .join(mac ? ' ' : ' + ');
}

function shortcutKeys(accelerator) {
  const frag = document.createDocumentFragment();
  for (const part of prettyShortcut(accelerator).split(caps.platform === 'darwin' ? ' ' : ' + ')) {
    const kbd = document.createElement('kbd');
    kbd.textContent = part;
    frag.append(kbd, ' ');
  }
  return frag;
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);
const toPatch = (path, value) => path.split('.').reduceRight((acc, key) => ({ [key]: acc }), value);
const dateLabel = (ms) =>
  new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ------------------------------------------------------------------- boot

async function boot() {
  const init = await api.invoke('app:init');
  ({ settings, state, displays, permissions, shortcutErrors, recordingsDir, freeBytes } = init);
  caps = init.capabilities;
  estimatedBps = init.estimatedBitsPerSecond;
  document.body.classList.add(`platform-${caps.platform}`);
  $('aboutVersion').textContent = `Version ${caps.version}`;

  // Sliding highlights for tab bar and segmented controls.
  const sliders = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.segmented, .tabs')]);
  const watcher = new ResizeObserver((entries) => {
    for (const entry of entries) syncThumb(/** @type {HTMLElement} */ (entry.target));
  });
  for (const slider of sliders) {
    slider.prepend(el('span', { class: 'thumb' }));
    watcher.observe(slider); // also fires when a hidden view becomes visible
  }

  views = switcher(['record', 'library', 'settings'].map((v) => $(`view-${v}`)), { y: 8 });
  stages = switcher(['idle', 'live', 'busy', 'wrap'].map((v) => $(`stage-${v}`)), {
    y: 12,
    scale: 0.985,
    // Each screen's contents settle in one after another.
    onEnter: (panel) => stagger(panel.children, { step: 45, max: 6 }),
  });

  bindEvents();
  renderAll();
  refreshDevices();
  refreshLibrary();
  refreshRecovery();

  api.on('state', (next) => {
    const wasBusy = state.status !== 'idle';
    state = next;
    renderState();
    if (wasBusy && next.status === 'idle') refreshEstimates();
  });
  api.on('settings', (next, extra) => {
    settings = next;
    if (extra?.shortcutErrors) shortcutErrors = extra.shortcutErrors;
    renderSettings();
    renderState();
    refreshEstimates();
  });
  api.on('library:changed', refreshLibrary);
  api.on('recovery:changed', refreshRecovery);
  api.on('export:progress', (fraction) => {
    $('exportBar').style.width = `${Math.round(fraction * 100)}%`;
  });

  navigator.mediaDevices.addEventListener('devicechange', refreshDevices);
  // Device names only appear once access has been granted, which happens
  // a moment after launch (mic meter, camera bubble).
  for (const ms of [1200, 3500, 8000]) setTimeout(refreshDevices, ms);
  window.addEventListener('focus', () => {
    refreshDevices();
    refreshPermissions();
  });
  document.addEventListener('visibilitychange', syncMicMonitor);
}

async function refreshEstimates() {
  try {
    const init = await api.invoke('app:init');
    freeBytes = init.freeBytes;
    estimatedBps = init.estimatedBitsPerSecond;
    displays = init.displays;
    recordingsDir = init.recordingsDir;
    renderIdle();
    renderSettings();
  } catch {
    /* window is closing */
  }
}

async function refreshPermissions() {
  permissions = await api.invoke('perm:status').catch(() => permissions);
  renderBanners();
}

async function refreshDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    cameras = devices.filter((d) => d.kind === 'videoinput');
    mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications');
  } catch {
    cameras = [];
    mics = [];
  }
  renderIdle();
}

async function refreshLibrary() {
  try {
    const result = await api.invoke('library:list');
    library = result.items;
    recordingsDir = result.dir;
    freeBytes = result.freeBytes;
    estimatedBps = result.estimatedBitsPerSecond;
  } catch {
    library = [];
  }
  renderLibrary();
  renderState();
  if (playing) {
    const fresh = library.find((item) => item.path === playing.path);
    if (fresh) playing = fresh;
  }
}

async function refreshRecovery() {
  orphans = await api.invoke('recovery:list').catch(() => []);
  renderBanners();
}

// ----------------------------------------------------------------- render

function renderAll() {
  renderSettings();
  renderState();
  renderLibrary();
}

function showView(name) {
  if (name === currentView) return;
  currentView = name;
  views.show($(`view-${name}`));
  for (const tab of $('tabs').querySelectorAll('button')) tab.setAttribute('aria-pressed', String(tab.dataset.view === name));
  syncThumb($('tabs'));
  if (name === 'library') stagger($('libraryList').children);
  syncMicMonitor();
}

function micAvailable() {
  return mics.length > 0;
}

function syncMicMonitor() {
  const wanted =
    state?.status === 'idle' &&
    !state.lastRecording &&
    currentView === 'record' &&
    document.visibilityState === 'visible' &&
    settings.micEnabled &&
    micAvailable();
  micMonitor.update({ enabled: Boolean(wanted), deviceId: settings.micDeviceId });
}

/** Fills a <select> with devices, keeping "system default" first. */
function fillDevices(select, devices, chosen, emptyLabel, kindLabel) {
  select.replaceChildren();
  if (devices.length === 0) {
    select.append(new Option(emptyLabel, ''));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  const named = devices.filter((d) => d.deviceId && d.deviceId !== 'default');
  select.append(new Option(`Default ${kindLabel}`, ''));
  named.forEach((d, i) => select.append(new Option(d.label || `${kindLabel[0].toUpperCase()}${kindLabel.slice(1)} ${i + 1}`, d.deviceId)));
  select.value = named.some((d) => d.deviceId === chosen) ? chosen : '';
}

function renderIdle() {
  if (!settings) return;
  const mode = settings.mode;
  for (const button of document.querySelectorAll('.mode')) {
    button.setAttribute('aria-checked', String(/** @type {HTMLElement} */ (button).dataset.mode === mode));
  }

  // Screen
  $('row-display').hidden = mode === 'camera';
  const displaySelect = /** @type {HTMLSelectElement} */ ($('displaySelect'));
  displaySelect.replaceChildren(
    ...displays.map((d, i) => new Option(`${displays.length > 1 ? `${d.label || `Display ${i + 1}`} · ` : 'Entire screen · '}${d.width}×${d.height}`, d.id)),
  );
  const chosenDisplay = displays.find((d) => d.id === settings.displayId) ?? displays.find((d) => d.primary) ?? displays[0];
  if (chosenDisplay) displaySelect.value = chosenDisplay.id;
  displaySelect.disabled = displays.length < 2;
  $('displayWrap').classList.toggle('static', displays.length < 2);

  // Camera
  $('row-camera').hidden = mode === 'screen';
  fillDevices($('cameraSelect'), cameras, settings.cameraDeviceId, 'No camera found', 'camera');
  const cameraOn = mode === 'camera' || settings.bubble.visible;
  $('cameraSwitch').hidden = mode !== 'screen+camera';
  $('cameraSwitch').setAttribute('aria-checked', String(settings.bubble.visible));
  $('row-camera').classList.toggle('off', !cameraOn || cameras.length === 0);

  // Microphone
  fillDevices($('micSelect'), mics, settings.micDeviceId, 'No microphone found', 'microphone');
  const micOn = settings.micEnabled && micAvailable();
  $('micSwitch').setAttribute('aria-checked', String(micOn));
  /** @type {HTMLButtonElement} */ ($('micSwitch')).disabled = !micAvailable();
  $('row-mic').classList.toggle('off', !micOn);
  $('micMeter').hidden = !micOn;

  // Computer sound
  $('row-system').hidden = !caps.systemAudio || mode === 'camera';
  $('systemSwitch').setAttribute('aria-checked', String(settings.systemAudio));

  // Shutter + summary
  const hint = $('recordHint');
  hint.replaceChildren();
  if (settings.shortcuts.toggleRecord) hint.append(shortcutKeys(settings.shortcuts.toggleRecord), '· ');
  hint.append('no time limit');
  const res = settings.resolution === 0 ? 'Native' : settings.resolution === 2160 ? '4K' : `${settings.resolution}p`;
  const left = freeBytes !== null && estimatedBps > 0 ? ` · room for ${formatRough(recordingTimeLeftMs(freeBytes, estimatedBps))}` : '';
  $('summaryButton').textContent = `${res} · ${settings.fps} fps${left}`;
  syncMicMonitor();
}

/** Keys of the banners currently on screen. */
let bannerKeys = /** @type {string[]} */ ([]);
let bannerSignature = '';

function renderBanners() {
  if (!state) return;
  /** @type {{ key: string, node: HTMLElement }[]} */
  const banners = [];
  const banner = (key, kind, title, text, actions = []) =>
    banners.push({
      key,
      node: el(
        'div',
        { class: `banner ${kind}` },
        el('div', { class: 'body' }, title ? el('b', {}, title) : null, text, actions.length ? el('div', { class: 'actions' }, ...actions) : null),
      ),
    });
  const button = (label, onclick, cls = '') => el('button', { class: `btn small ${cls}`, onclick }, label);

  if (state.error) banner(`error:${state.error}`, 'error', 'That didn’t work', state.error, [button('OK', () => command('dismiss'))]);
  if (state.notice && state.status === 'idle') banner(`notice:${state.notice}`, 'warn', null, state.notice, [button('OK', () => command('dismiss'))]);

  const needs = [];
  if (settings.mode !== 'camera' && permissions.screen && permissions.screen !== 'granted') needs.push(['screen', 'Screen recording']);
  if (settings.mode !== 'screen' && permissions.camera && permissions.camera !== 'granted') needs.push(['camera', 'Camera']);
  if (settings.micEnabled && permissions.microphone && permissions.microphone !== 'granted') needs.push(['microphone', 'Microphone']);
  if (needs.length > 0 && state.status === 'idle') {
    const mac = caps.platform === 'darwin';
    banner(
      `perm:${needs.map((n) => n[0]).join(',')}`,
      'warn',
      'One-time setup',
      mac
        ? 'Your Mac needs your OK before Freeloomz can record. After allowing screen recording, macOS asks you to reopen the app.'
        : 'Windows is blocking access. Turn it on in privacy settings.',
      needs.map(([kind, label]) =>
        button(`Allow ${label.toLowerCase()}`, async () => {
          permissions = await api.invoke('perm:request', kind).catch(() => permissions);
          renderBanners();
        }),
      ),
    );
  }

  for (const orphan of orphans) {
    const about = orphan.durationMs > 0 ? `about ${formatClock(orphan.durationMs)}` : formatBytes(orphan.sizeBytes);
    banner(`orphan:${orphan.id}`, '', 'Unfinished recording found', `From ${dateLabel(orphan.startedAt)} (${about}). It was interrupted before it could be saved.`, [
      button(
        'Recover it',
        async (event) => {
          /** @type {HTMLButtonElement} */ (event.currentTarget).disabled = true;
          /** @type {HTMLButtonElement} */ (event.currentTarget).textContent = 'Recovering…';
          try {
            await api.invoke('recovery:restore', orphan.id);
            toast('Recovered — it’s in your Library');
          } catch (err) {
            toast(cleanError(err).split('\n')[0]);
          }
          refreshRecovery();
        },
        'primary',
      ),
      button('Delete', () => api.invoke('recovery:discard', orphan.id).then(refreshRecovery)),
    ]);
  }

  // This runs on every state tick; leave the DOM alone unless something
  // actually changed (rebuilding would restart animations and drop hover).
  const signature = banners.map((b) => b.key).join('|');
  if (signature === bannerSignature) return;
  bannerSignature = signature;
  const previous = bannerKeys;
  bannerKeys = banners.map((b) => b.key);
  $('banners').replaceChildren(...banners.map((b) => b.node));
  for (const b of banners) if (!previous.includes(b.key)) enter(b.node, { y: -8 });
}

function renderState() {
  if (!state) return;
  const { status } = state;
  const capturing = status === 'recording' || status === 'paused';
  const showWrap = status === 'idle' && Boolean(state.lastRecording);
  const busy = ['preparing', 'countdown', 'stopping', 'finalizing'].includes(status);

  const stage = capturing ? 'live' : busy ? 'busy' : showWrap ? 'wrap' : 'idle';
  stages.show($(`stage-${stage}`), { instant: painted.stage === undefined });
  painted.stage = stage;

  // Title bar keeps the clock visible from any tab.
  const titleStatus = $('titlebarStatus');
  paintOnce('titleShown', capturing, () => (capturing ? enter(titleStatus, { y: 0 }) : leave(titleStatus, { y: 0 })));
  if (capturing) titleStatus.textContent = formatClock(state.elapsedMs, { padMinutes: true });
  titleStatus.classList.toggle('paused', status === 'paused');

  if (capturing) {
    const paused = status === 'paused';
    $('timer').textContent = formatClock(state.elapsedMs, { padMinutes: true });
    $('stage-live').classList.toggle('is-paused', paused);
    $('livePill').classList.toggle('paused', paused);
    paintOnce('pill', paused, () => ($('livePillText').textContent = paused ? 'Paused' : 'Recording'));
    const parts = [formatBytes(state.bytesWritten)];
    if (state.freeBytes !== null && state.bitsPerSecond > 0) {
      parts.push(`room for ${formatRough(recordingTimeLeftMs(state.freeBytes, state.bitsPerSecond))} more`);
    }
    $('liveMeta').textContent = parts.join(' · ');
    paintOnce('pauseIcon', paused, () => {
      $('pauseButton').replaceChildren(icon(paused ? 'play' : 'pause'));
      $('pauseButton').title = paused ? 'Resume' : 'Pause';
    });
    paintOnce('markers', state.markers, () => {
      $('markerCount').hidden = state.markers === 0;
      $('markerCount').textContent = String(state.markers);
      if (state.markers > 0) {
        // A little bounce confirms the marker landed.
        const button = $('markerButton');
        button.classList.remove('bump');
        void button.offsetWidth;
        button.classList.add('bump');
      }
    });

    const micOn = settings.micEnabled && !state.micMuted;
    paintOnce('micChip', `${settings.micEnabled}|${state.micMuted}`, () => {
      $('micChip').classList.toggle('alert', settings.micEnabled && state.micMuted);
      $('micChip').classList.toggle('on', micOn);
      $('micChip').replaceChildren(icon(micOn ? 'mic' : 'mic-off'), el('span', {}, !settings.micEnabled ? 'No mic' : state.micMuted ? 'Muted' : 'Mic on'));
      /** @type {HTMLButtonElement} */ ($('micChip')).disabled = !settings.micEnabled;
    });
    $('cameraChip').hidden = settings.mode !== 'screen+camera';
    $('cameraChip').classList.toggle('on', settings.bubble.visible);
    $('drawChip').hidden = settings.mode === 'camera' || !caps.overlay;
    $('drawChip').classList.toggle('on', state.drawing);
  } else {
    painted.markers = undefined;
  }

  if (busy) {
    const ring = $('busyRing');
    const finalizing = status === 'finalizing' && state.finalizeProgress !== null && state.finalizeProgress > 0;
    ring.classList.toggle('spin', !finalizing);
    $('busyBar').style.strokeDashoffset = finalizing ? String(213.6 * (1 - state.finalizeProgress)) : '';
    const copy = {
      preparing: ['Getting ready…', 'Opening your screen, camera and mic'],
      countdown: ['Here we go', 'Recording starts after the countdown'],
      stopping: ['Saving…', 'Writing the last frames to disk'],
      finalizing: ['Wrapping up…', finalizing ? `${Math.round(state.finalizeProgress * 100)}%` : 'Making it play everywhere'],
    }[status];
    $('busyTitle').textContent = copy[0];
    $('busySub').textContent = copy[1];
    $('cancelButton').hidden = !(status === 'preparing' || status === 'countdown');
  }

  if (showWrap) renderWrap();
  renderBanners();
  syncMicMonitor();
}

function renderWrap() {
  const rec = state.lastRecording;
  const item = library.find((i) => i.path === rec.path);
  const image = /** @type {HTMLImageElement} */ ($('wrapImage'));
  if (item?.thumbnailUrl && image.dataset.src !== item.thumbnailUrl) {
    image.dataset.src = item.thumbnailUrl;
    image.src = item.thumbnailUrl;
  }
  image.hidden = !item?.thumbnailUrl;
  $('wrapDuration').textContent = formatClock(rec.durationMs);
  const name = /** @type {HTMLInputElement} */ ($('wrapName'));
  const fileName = rec.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  if (document.activeElement !== name) name.value = fileName;
  $('wrapMeta').textContent = [formatBytes(rec.sizeBytes), rec.height ? `${rec.width}×${rec.height}` : null, rec.hasAudio ? null : 'no sound']
    .filter(Boolean)
    .join(' · ');
  const chapters = rec.markers?.length ?? 0;
  $('wrapChapters').hidden = chapters === 0;
  $('wrapChapters').querySelector('span').textContent = `Copy ${chapters} chapters`;
}

function renderLibrary() {
  const list = $('libraryList');
  $('libraryEmpty').hidden = library.length > 0;
  list.replaceChildren(
    ...library.map((item) => {
      const meta = [dateLabel(item.modifiedMs), formatBytes(item.sizeBytes)].join(' · ');
      const kind = item.ext === '.gif' ? 'GIF' : item.ext !== '.mp4' ? item.ext.slice(1).toUpperCase() : null;
      return el(
        'button',
        { class: 'item', onclick: () => openPlayer(item) },
        el(
          'div',
          { class: `thumb${item.thumbnailUrl ? '' : ' loading'}` },
          item.thumbnailUrl ? el('img', { src: item.thumbnailUrl, alt: '' }) : null,
          item.durationMs ? el('span', { class: 'duration' }, formatClock(item.durationMs)) : null,
        ),
        el(
          'div',
          { class: 'info' },
          el('b', {}, item.name),
          el('span', {}, meta),
          item.markers?.length ? el('span', { class: 'tag' }, `${item.markers.length} chapters`) : kind ? el('span', { class: 'tag' }, kind) : null,
        ),
      );
    }),
  );
}

function renderSettings() {
  if (!settings) return;
  for (const group of document.querySelectorAll('.segmented[data-setting]')) {
    const g = /** @type {HTMLElement} */ (group);
    const value = String(getPath(settings, g.dataset.setting));
    for (const button of g.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.value === value));
  }
  for (const group of document.querySelectorAll('.segmented')) syncThumb(/** @type {HTMLElement} */ (group));
  for (const toggle of document.querySelectorAll('.switch[data-setting]')) {
    const t = /** @type {HTMLElement} */ (toggle);
    t.setAttribute('aria-checked', String(Boolean(getPath(settings, t.dataset.setting))));
  }
  if (!caps.overlay) {
    const toggle = /** @type {HTMLButtonElement} */ ($('row-highlight').querySelector('.switch'));
    toggle.disabled = true;
    toggle.setAttribute('aria-checked', 'false');
    $('highlightNote').textContent = 'Not available: this desktop has no window compositing';
  }
  $('folderPath').textContent = recordingsDir;
  $('folderPath').title = recordingsDir;

  const list = $('shortcutList');
  if (!list.querySelector('.listening')) {
    list.replaceChildren(
      ...SHORTCUT_ACTIONS.map((action) => {
        const problem = shortcutErrors[action];
        const value = settings.shortcuts[action];
        return el(
          'div',
          { class: 'row' },
          el('span', { class: 'row-label' }, SHORTCUT_LABELS[action], problem ? el('small', {}, problem) : null),
          el(
            'button',
            { class: `shortcut${problem ? ' problem' : ''}`, 'data-action': action, onclick: (e) => listenForShortcut(e.currentTarget, action) },
            value ? prettyShortcut(value) : 'Off',
          ),
        );
      }),
    );
  }
  renderIdle();
}

// -------------------------------------------------------------- shortcuts

const CODE_TO_KEY = {
  Space: 'Space', Enter: 'Return', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Minus: '-', Equal: '=', Backquote: '`', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
};

/** Builds an Electron accelerator from a key press, or null if incomplete. */
function acceleratorFrom(event) {
  let key = null;
  if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  else if (/^Digit\d$/.test(event.code)) key = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) key = event.code;
  else key = CODE_TO_KEY[event.code] ?? null;
  if (!key) return null;
  const mac = caps.platform === 'darwin';
  const mods = [];
  if (event.ctrlKey) mods.push(mac ? 'Control' : 'Ctrl');
  if (event.metaKey) mods.push(mac ? 'Command' : 'Super');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  // A bare letter would fire while typing anywhere on the computer.
  const safeAlone = /^F\d{1,2}$/.test(key);
  if (!safeAlone && !mods.some((m) => m !== 'Shift')) return null;
  return [...mods, key].join('+');
}

async function listenForShortcut(button, action) {
  if (button.classList.contains('listening')) return;
  button.classList.add('listening');
  button.textContent = 'Press keys…';
  await api.invoke('shortcuts:suspend', true);

  const finish = async (value) => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', onBlur);
    button.classList.remove('listening');
    if (value !== undefined) await update({ shortcuts: { [action]: value } });
    shortcutErrors = await api.invoke('shortcuts:suspend', false);
    renderSettings();
  };
  const onBlur = () => finish(undefined);
  const onKey = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.code === 'Escape') return finish(undefined);
    if (event.code === 'Backspace' && !event.ctrlKey && !event.metaKey && !event.altKey) return finish('');
    const accelerator = acceleratorFrom(event);
    if (accelerator) finish(accelerator);
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', onBlur);
}

// ----------------------------------------------------------------- player

function openPlayer(item) {
  playing = item;
  const isGif = item.ext === '.gif';
  const video = /** @type {HTMLVideoElement} */ ($('playerVideo'));
  const gif = /** @type {HTMLImageElement} */ ($('playerGif'));
  video.hidden = isGif;
  gif.hidden = !isGif;
  if (isGif) gif.src = item.url;
  else video.src = item.url;
  /** @type {HTMLInputElement} */ ($('playerName')).value = item.name;
  $('playerMeta').textContent = [
    dateLabel(item.modifiedMs),
    item.durationMs ? formatClock(item.durationMs) : null,
    formatBytes(item.sizeBytes),
    item.height ? `${item.width}×${item.height}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  $('trimPanel').hidden = isGif;
  /** @type {HTMLInputElement} */ ($('trimStart')).value = '0';
  /** @type {HTMLInputElement} */ ($('trimEnd')).value = '1000';
  $('exportProgress').hidden = true;
  renderTrim();

  const chapters = item.markers ?? [];
  $('chapterPanel').hidden = chapters.length === 0 || isGif;
  $('chapterList').replaceChildren(
    ...chapters.map((c) =>
      el(
        'button',
        {
          class: 'chapter',
          onclick: () => {
            video.currentTime = c.timeMs / 1000;
            video.play().catch(() => {});
          },
        },
        el('time', {}, formatClock(c.timeMs)),
        el('span', {}, c.label),
      ),
    ),
  );
  enter($('player'), { y: 18, duration: DURATION.slow });
  stagger($('player').querySelector('.sheet-body').children, { step: 40, max: 5 });
}

async function closePlayer() {
  if (!playing) return;
  playing = null;
  const video = /** @type {HTMLVideoElement} */ ($('playerVideo'));
  video.pause();
  await leave($('player'), { y: 14, duration: DURATION.base });
  video.removeAttribute('src');
  video.load(); // lets go of the file so it can be renamed or deleted
  /** @type {HTMLImageElement} */ ($('playerGif')).removeAttribute('src');
}

function playerDuration() {
  const video = /** @type {HTMLVideoElement} */ ($('playerVideo'));
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : (playing?.durationMs ?? 0) / 1000;
}

function trimRange() {
  const total = playerDuration();
  const a = Number(/** @type {HTMLInputElement} */ ($('trimStart')).value) / 1000;
  const b = Number(/** @type {HTMLInputElement} */ ($('trimEnd')).value) / 1000;
  return { startSec: a * total, endSec: b * total, a, b, total };
}

function renderTrim() {
  const { startSec, endSec, a, b } = trimRange();
  const range = $('trimRange');
  range.style.left = `${a * 100}%`;
  range.style.right = `${(1 - b) * 100}%`;
  $('trimTimes').textContent = `${formatClock(startSec * 1000)} → ${formatClock(endSec * 1000)} · ${formatClock((endSec - startSec) * 1000)}`;
}

async function runExport(kind) {
  if (!playing || exporting) return;
  const { startSec, endSec, total } = trimRange();
  if (kind === 'gif' && endSec - startSec > 60) return toast('GIFs get huge — trim it to under a minute first');
  if (kind === 'trim' && startSec < 0.05 && total - endSec < 0.05) return toast('Drag the handles to pick the part to keep');
  exporting = true;
  $('exportProgress').hidden = false;
  $('exportBar').style.width = '0%';
  $('exportLabel').textContent = kind === 'gif' ? 'Making GIF…' : 'Trimming…';
  for (const id of ['exportTrim', 'exportGif']) /** @type {HTMLButtonElement} */ ($(id)).disabled = true;
  try {
    await api.invoke('library:export', { path: playing.path, kind, startSec, endSec });
    toast(kind === 'gif' ? 'GIF saved to your Library' : 'Trimmed copy saved to your Library');
  } catch (err) {
    const message = cleanError(err);
    if (!/Cancelled/.test(message)) toast(message.split('\n')[0]);
  }
  exporting = false;
  $('exportProgress').hidden = true;
  for (const id of ['exportTrim', 'exportGif']) /** @type {HTMLButtonElement} */ ($(id)).disabled = false;
}

async function renameFrom(input, path, after) {
  const wanted = input.value.trim();
  const current = path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  if (!wanted || wanted === current) {
    input.value = current;
    return;
  }
  try {
    const next = await api.invoke('library:action', 'rename', path, wanted);
    after?.(next);
    await refreshLibrary();
  } catch (err) {
    input.value = current;
    toast(cleanError(err));
  }
}

// ----------------------------------------------------------------- events

function bindEvents() {
  $('tabs').addEventListener('click', (event) => {
    const tab = /** @type {HTMLElement} */ (event.target).closest('button');
    if (tab?.dataset.view) showView(tab.dataset.view);
  });

  // Record: set-up
  for (const button of document.querySelectorAll('.mode')) {
    button.addEventListener('click', () => update({ mode: /** @type {HTMLElement} */ (button).dataset.mode }));
  }
  $('displaySelect').addEventListener('change', (e) => update({ displayId: /** @type {HTMLSelectElement} */ (e.target).value || null }));
  $('cameraSelect').addEventListener('change', (e) => update({ cameraDeviceId: /** @type {HTMLSelectElement} */ (e.target).value || null }));
  $('micSelect').addEventListener('change', (e) => update({ micDeviceId: /** @type {HTMLSelectElement} */ (e.target).value || null }));
  $('cameraSwitch').addEventListener('click', () => update({ bubble: { visible: !settings.bubble.visible } }));
  $('micSwitch').addEventListener('click', () => update({ micEnabled: !settings.micEnabled }));
  $('systemSwitch').addEventListener('click', () => update({ systemAudio: !settings.systemAudio }));
  $('summaryButton').addEventListener('click', () => showView('settings'));
  $('recordButton').addEventListener('click', async () => {
    // Recording with a missing mic would silently produce a mute video.
    if (settings.micEnabled && !micAvailable()) await update({ micEnabled: false });
    command('start');
  });

  // Record: live
  $('pauseButton').addEventListener('click', () => command('togglePause'));
  $('stopButton').addEventListener('click', () => command('stop'));
  $('markerButton').addEventListener('click', () => command('addMarker'));
  $('micChip').addEventListener('click', () => command('toggleMic'));
  $('cameraChip').addEventListener('click', () => command('toggleCamera'));
  $('drawChip').addEventListener('click', () => command('toggleDraw'));
  $('cancelButton').addEventListener('click', () => command('stop'));
  let discardArmed = 0;
  $('discardButton').addEventListener('click', () => {
    // Two clicks instead of a dialog: a dialog would end up in the video.
    if (Date.now() - discardArmed < 4000) {
      discardArmed = 0;
      $('discardButton').textContent = 'Discard this recording';
      command('discard');
    } else {
      discardArmed = Date.now();
      $('discardButton').textContent = 'Click again to throw it away';
      setTimeout(() => {
        if (discardArmed && Date.now() - discardArmed >= 4000) $('discardButton').textContent = 'Discard this recording';
      }, 4100);
    }
  });

  // Record: wrap
  const wrapItem = () => library.find((i) => i.path === state.lastRecording?.path);
  $('wrapThumb').addEventListener('click', () => {
    const item = wrapItem();
    if (item) openPlayer(item);
  });
  $('wrapOpen').addEventListener('click', () => {
    const item = wrapItem();
    if (item) openPlayer(item);
  });
  $('wrapReveal').addEventListener('click', () => api.invoke('library:action', 'reveal', state.lastRecording.path));
  $('wrapChapters').addEventListener('click', async () => {
    const item = wrapItem();
    if (!item?.chapters) return;
    await api.invoke('library:action', 'copyChapters', item.path, item.chapters);
    toast('Chapters copied to your clipboard');
  });
  $('wrapAgain').addEventListener('click', () => command('dismiss'));
  const wrapName = /** @type {HTMLInputElement} */ ($('wrapName'));
  wrapName.addEventListener('change', () => renameFrom(wrapName, state.lastRecording.path));
  wrapName.addEventListener('keydown', (e) => e.key === 'Enter' && wrapName.blur());

  // Library + player
  $('openFolderButton').addEventListener('click', () => api.invoke('library:action', 'openFolder'));
  $('playerClose').addEventListener('click', closePlayer);
  $('playerReveal').addEventListener('click', () => playing && api.invoke('library:action', 'reveal', playing.path));
  $('playerTrash').addEventListener('click', async () => {
    if (!playing) return;
    const { path } = playing;
    await closePlayer();
    try {
      await api.invoke('library:action', 'trash', path);
      toast('Moved to trash');
    } catch (err) {
      toast(cleanError(err));
    }
    refreshLibrary();
  });
  const playerName = /** @type {HTMLInputElement} */ ($('playerName'));
  playerName.addEventListener('change', () => {
    if (!playing) return;
    // The open video holds the file; let go of it for the rename.
    const video = /** @type {HTMLVideoElement} */ ($('playerVideo'));
    const at = video.currentTime;
    video.removeAttribute('src');
    video.load();
    renameFrom(playerName, playing.path, (next) => {
      playing = { ...playing, path: next };
    }).then(() => {
      const fresh = library.find((i) => i.path === playing?.path);
      if (fresh) {
        openPlayer(fresh);
        video.currentTime = at;
      }
    });
  });
  playerName.addEventListener('keydown', (e) => e.key === 'Enter' && playerName.blur());

  const start = /** @type {HTMLInputElement} */ ($('trimStart'));
  const end = /** @type {HTMLInputElement} */ ($('trimEnd'));
  const video = /** @type {HTMLVideoElement} */ ($('playerVideo'));
  start.addEventListener('input', () => {
    if (Number(start.value) > Number(end.value) - 5) start.value = String(Number(end.value) - 5);
    video.currentTime = trimRange().startSec;
    renderTrim();
  });
  end.addEventListener('input', () => {
    if (Number(end.value) < Number(start.value) + 5) end.value = String(Number(start.value) + 5);
    video.currentTime = trimRange().endSec;
    renderTrim();
  });
  video.addEventListener('loadedmetadata', renderTrim);
  $('trimSetStart').addEventListener('click', () => {
    const total = playerDuration();
    if (total > 0) start.value = String(Math.min(Number(end.value) - 5, Math.round((video.currentTime / total) * 1000)));
    renderTrim();
  });
  $('trimSetEnd').addEventListener('click', () => {
    const total = playerDuration();
    if (total > 0) end.value = String(Math.max(Number(start.value) + 5, Math.round((video.currentTime / total) * 1000)));
    renderTrim();
  });
  $('exportTrim').addEventListener('click', () => runExport('trim'));
  $('exportGif').addEventListener('click', () => runExport('gif'));
  $('exportCancel').addEventListener('click', () => api.send('export:cancel'));
  $('copyChapters').addEventListener('click', async () => {
    if (!playing?.chapters) return;
    await api.invoke('library:action', 'copyChapters', playing.path, playing.chapters);
    toast('Chapters copied to your clipboard');
  });

  // Settings
  for (const group of document.querySelectorAll('.segmented[data-setting]')) {
    group.addEventListener('click', (event) => {
      const button = /** @type {HTMLElement} */ (event.target).closest('button');
      if (!button) return;
      const g = /** @type {HTMLElement} */ (group);
      const value = g.dataset.type === 'number' ? Number(button.dataset.value) : button.dataset.value;
      update(toPatch(g.dataset.setting, value));
    });
  }
  for (const toggle of document.querySelectorAll('.switch[data-setting]')) {
    toggle.addEventListener('click', () => {
      const path = /** @type {HTMLElement} */ (toggle).dataset.setting;
      update(toPatch(path, !getPath(settings, path)));
    });
  }
  $('changeFolderButton').addEventListener('click', async () => {
    try {
      const dir = await api.invoke('dialog:pickFolder');
      if (dir) {
        recordingsDir = dir;
        renderSettings();
        refreshLibrary();
        refreshRecovery();
      }
    } catch (err) {
      toast(cleanError(err));
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('player').hidden && !document.querySelector('.listening')) closePlayer();
  });
}

boot().catch((err) => {
  console.error(err);
  document.body.append(el('pre', { class: 'banner error' }, `Freeloomz failed to start:\n${err?.stack ?? err}`));
});
