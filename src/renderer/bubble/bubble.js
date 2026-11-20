// The camera bubble: a round, always-on-top window showing your webcam.
// It is a real window sitting on your screen, so whatever you see is exactly
// what ends up in the recording.

import { BUBBLE_PRESETS } from '../../shared/defaults.js';

const api = /** @type {any} */ (window).freeloomz;
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));
const video = /** @type {HTMLVideoElement} */ ($('video'));

/** @type {any} */ let settings;
/** @type {any} */ let state;
/** @type {MediaStream | null} */ let stream = null;
let openedDevice = /** @type {string | null | undefined} */ (undefined);
let opening = 0;

function applyLook() {
  const { bubble } = settings;
  const pad = Math.max(0, Math.round((window.innerWidth - bubble.size) / 2));
  document.documentElement.style.setProperty('--pad', `${pad}px`);
  document.body.classList.toggle('flat', pad === 0);
  document.body.classList.toggle('mirror', bubble.mirror);
  document.body.classList.toggle('rounded', bubble.shape === 'rounded');
}

function applyState() {
  const capturing = state.status === 'recording' || state.status === 'paused';
  document.body.classList.toggle('capturing', capturing);
  document.body.classList.toggle('is-paused', state.status === 'paused');
  $('paused').hidden = state.status !== 'paused';
  $('recordButton').title = capturing ? 'Stop and save' : 'Start recording';
  $('pauseButton').hidden = !capturing;
  $('pauseButton').title = state.status === 'paused' ? 'Resume' : 'Pause';
  $('pauseIcon').setAttribute('d', state.status === 'paused' ? 'M8 5.5v13l11-6.5z' : 'M8.5 5v14M15.5 5v14');
}

function showPlaceholder(text) {
  $('placeholderText').textContent = text;
  $('placeholder').hidden = false;
  document.body.classList.remove('live');
  video.hidden = true;
}

async function openCamera(force = false) {
  const wanted = settings.cameraDeviceId;
  if (!force && stream && openedDevice === wanted) return;
  const attempt = ++opening;
  closeCamera();
  const base = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  try {
    let next;
    try {
      next = await navigator.mediaDevices.getUserMedia({ video: wanted ? { ...base, deviceId: { exact: wanted } } : base });
    } catch (err) {
      // The remembered camera is gone: use whichever one is there.
      if (!wanted || (err?.name !== 'OverconstrainedError' && err?.name !== 'NotFoundError')) throw err;
      next = await navigator.mediaDevices.getUserMedia({ video: base });
    }
    if (attempt !== opening) {
      for (const t of next.getTracks()) t.stop();
      return;
    }
    stream = next;
    openedDevice = wanted;
    video.srcObject = stream;
    video.hidden = false;
    $('placeholder').hidden = true;
    // Fade the picture up only once real frames are arriving.
    const reveal = () => document.body.classList.add('live');
    video.addEventListener('playing', reveal, { once: true });
    video.addEventListener('loadeddata', reveal, { once: true });
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      showPlaceholder('Camera disconnected');
      stream = null;
    });
  } catch (err) {
    if (attempt !== opening) return;
    stream = null;
    openedDevice = undefined;
    const name = err?.name;
    showPlaceholder(
      name === 'NotAllowedError' ? 'Camera access is blocked' : name === 'NotReadableError' ? 'Camera is in use by another app' : 'No camera found',
    );
  }
}

function closeCamera() {
  if (stream) for (const track of stream.getTracks()) track.stop();
  stream = null;
  video.srcObject = null;
  document.body.classList.remove('live');
}

// ------------------------------------------------------------ interaction

function bindDrag() {
  const bubble = $('bubble');
  let dragging = false;
  let queued = false;
  bubble.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || /** @type {HTMLElement} */ (event.target).closest('.controls')) return;
    dragging = true;
    bubble.setPointerCapture(event.pointerId);
    document.body.classList.add('dragging');
    api.send('bubble:drag', 'start');
  });
  bubble.addEventListener('pointermove', () => {
    if (!dragging || queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (dragging) api.send('bubble:drag', 'move');
    });
  });
  const end = (event) => {
    if (!dragging) return;
    dragging = false;
    if (bubble.hasPointerCapture(event.pointerId)) bubble.releasePointerCapture(event.pointerId);
    document.body.classList.remove('dragging');
    api.send('bubble:drag', 'end');
  };
  bubble.addEventListener('pointerup', end);
  bubble.addEventListener('pointercancel', end);
}

function bindControls() {
  const bubble = $('bubble');
  // Buttons appear after a short rest, not on a fly-by.
  let hoverTimer = 0;
  bubble.addEventListener('pointerenter', () => {
    hoverTimer = window.setTimeout(() => document.body.classList.add('hover'), 350);
  });
  bubble.addEventListener('pointerleave', () => {
    clearTimeout(hoverTimer);
    document.body.classList.remove('hover');
  });

  $('recordButton').addEventListener('click', () => api.invoke('ctl:command', 'toggleRecord'));
  $('pauseButton').addEventListener('click', () => api.invoke('ctl:command', 'togglePause'));

  bubble.addEventListener('dblclick', (event) => {
    if (/** @type {HTMLElement} */ (event.target).closest('.controls')) return;
    const sizes = Object.values(BUBBLE_PRESETS);
    const next = sizes.find((s) => s > settings.bubble.size) ?? sizes[0];
    api.invoke('settings:update', { bubble: { size: next } });
  });

  let wheelAt = 0;
  bubble.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      if (Date.now() - wheelAt < 40) return;
      wheelAt = Date.now();
      api.send('bubble:resize', event.deltaY < 0 ? 16 : -16);
    },
    { passive: false },
  );

  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    api.send('bubble:menu');
  });
}

async function boot() {
  const init = await api.invoke('app:init');
  settings = init.settings;
  state = init.state;
  document.body.classList.toggle('wayland', Boolean(init.capabilities.wayland));
  applyLook();
  applyState();
  if (!init.capabilities.wayland) bindDrag();
  bindControls();
  openCamera();

  api.on('settings', (next) => {
    settings = next;
    applyLook();
    openCamera();
  });
  api.on('state', (next) => {
    state = next;
    applyState();
  });
  // The main process gives the bubble a moment to bow out before closing it.
  api.on('ui:leave', () => document.body.classList.add('leaving'));
  api.on('ui:enter', () => document.body.classList.remove('leaving'));
  window.addEventListener('resize', applyLook);
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (!stream) openCamera(true);
  });
}

boot();
