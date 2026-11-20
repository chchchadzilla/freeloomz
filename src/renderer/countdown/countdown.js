// 3… 2… 1… The main process owns the real timer; this just draws it.

const total = Math.max(1, Number(new URLSearchParams(location.search).get('seconds')) || 3);
const digit = document.getElementById('digit');
const sweep = document.getElementById('sweep');
const disc = document.querySelector('.disc');
const EXIT_SECONDS = 0.24;
const CIRCUMFERENCE = 678.6;
const startedAt = performance.now();
let shown = -1;

function frame() {
  const elapsed = (performance.now() - startedAt) / 1000;
  const remaining = Math.max(1, Math.ceil(total - elapsed));
  if (remaining !== shown) {
    shown = remaining;
    digit.textContent = String(remaining);
    digit.classList.remove('pop');
    void digit.offsetWidth; // restart the animation
    digit.classList.add('pop');
  }
  sweep.style.strokeDashoffset = String(CIRCUMFERENCE * Math.min(1, elapsed / total));
  if (elapsed >= total - EXIT_SECONDS) disc.classList.add('out');
  if (elapsed < total) requestAnimationFrame(frame);
}
frame();
