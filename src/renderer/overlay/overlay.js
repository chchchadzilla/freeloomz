// Transparent layer over the display being recorded. Two jobs:
//  • a soft halo that follows the pointer, so viewers never lose it;
//  • freehand drawing, for circling and pointing at things mid-explanation.
// Normally clicks pass straight through it; only draw mode catches them.

const api = /** @type {any} */ (window).freeloomz;
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('ink'));
const ctx = canvas.getContext('2d');
const halo = document.getElementById('halo');
const toolbar = document.getElementById('toolbar');

const COLORS = ['#ff4d5e', '#c6ff3d', '#ffc24b', '#4cc3ff', '#ffffff'];
let color = COLORS[0];
let drawing = false;
/** @type {{ color: string, points: { x: number, y: number }[] }[]} */
let strokes = [];
/** @type {{ color: string, points: { x: number, y: number }[] } | null} */
let active = null;

function resize() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  redraw();
}

/** @param {{ color: string, points: { x: number, y: number }[] }} stroke */
function paint(stroke) {
  const { points } = stroke;
  if (points.length === 0) return;
  const trace = () => {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
    // Curve through the midpoints: smooth lines from a jittery mouse.
    for (let i = 1; i < points.length - 1; i += 1) {
      const mx = (points[i].x + points[i + 1].x) / 2;
      const my = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, mx, my);
    }
    if (points.length > 1) ctx.lineTo(points.at(-1).x, points.at(-1).y);
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Dark edge first, so the ink reads on light and dark backgrounds alike.
  trace();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
  ctx.lineWidth = 9;
  ctx.stroke();
  trace();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = 5;
  ctx.stroke();
}

function redraw() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  for (const stroke of strokes) paint(stroke);
  if (active) paint(active);
}

function renderColors() {
  const holder = document.getElementById('colors');
  holder.replaceChildren(
    ...COLORS.map((c) => {
      const button = document.createElement('button');
      button.style.setProperty('--c', c);
      button.setAttribute('aria-pressed', String(c === color));
      button.title = 'Pen colour';
      button.addEventListener('click', () => {
        color = c;
        renderColors();
      });
      return button;
    }),
  );
}

canvas.addEventListener('pointerdown', (event) => {
  if (!drawing || event.button !== 0) return;
  canvas.setPointerCapture(event.pointerId);
  active = { color, points: [{ x: event.clientX, y: event.clientY }] };
  redraw();
});
canvas.addEventListener('pointermove', (event) => {
  if (!active) return;
  active.points.push({ x: event.clientX, y: event.clientY });
  redraw();
});
const endStroke = () => {
  if (!active) return;
  strokes.push(active);
  active = null;
  redraw();
};
canvas.addEventListener('pointerup', endStroke);
canvas.addEventListener('pointercancel', endStroke);

document.getElementById('undoButton').addEventListener('click', () => {
  strokes.pop();
  redraw();
});
document.getElementById('clearButton').addEventListener('click', () => {
  strokes = [];
  redraw();
});
document.getElementById('doneButton').addEventListener('click', () => api.send('overlay:exit'));
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.send('overlay:exit');
});

let highlight = false;
api.on('overlay:mode', (mode) => {
  const wasDrawing = drawing;
  drawing = Boolean(mode.drawing);
  highlight = Boolean(mode.highlight);
  document.body.classList.toggle('drawing', drawing);
  toolbar.hidden = !drawing;
  if (!highlight || drawing) halo.classList.remove('on');
  if (wasDrawing && !drawing) {
    // Annotations belong to the moment; they would only get stale. Let the
    // ink fade out rather than blink off.
    canvas.classList.add('fading');
    setTimeout(() => {
      strokes = [];
      active = null;
      redraw();
      canvas.classList.remove('fading');
    }, 240);
  } else if (drawing) {
    canvas.classList.remove('fading');
  }
});
api.on('overlay:cursor', ({ x, y }) => {
  if (!highlight || drawing) return;
  halo.hidden = false;
  halo.style.transform = `translate(${x}px, ${y}px)`;
  halo.classList.add('on');
});

window.addEventListener('resize', resize);
renderColors();
resize();
