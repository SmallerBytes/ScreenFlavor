import "./style.css";

document.documentElement.classList.add("overlay");
document.body.classList.add("overlay");

const root = document.querySelector<HTMLDivElement>("#overlay-root");
if (!root) throw new Error("Missing #overlay-root");

const HIT_DISTANCE = 28;
const SNAIL_SPEED_PX_PER_SEC = 52;
const MIN_SPAWN_SEPARATION = 220;
const WARMUP_MS = 450;

root.innerHTML = `
  <div class="overlay-stage" id="stage">
    <div class="snail" id="snail" aria-hidden="true">🐌</div>
  </div>
  <div class="hud" id="hud">Starting…</div>
  <div class="lose-banner" id="lose" hidden>
    <div class="lose-inner">
      <h2>Caught!</h2>
      <p>The snail reached your cursor. Hang on — you will return to the menu shortly.</p>
    </div>
  </div>
`;

const snailEl = document.querySelector<HTMLDivElement>("#snail");
const hudEl = document.querySelector<HTMLDivElement>("#hud");
const loseEl = document.querySelector<HTMLDivElement>("#lose");
const stageEl = document.querySelector<HTMLDivElement>("#stage");

if (!snailEl || !hudEl || !loseEl || !stageEl) {
  throw new Error("Overlay DOM missing");
}

let cursor = { x: 0, y: 0 };
let hasLiveCursor = false;

const unsubCursor = window.screenFlavor.onCursor((pos) => {
  cursor = pos;
  hasLiveCursor = true;
  tryBegin();
});

function edgeSpawn(w: number, h: number, margin: number) {
  const edge = Math.floor(Math.random() * 4);
  const spanX = Math.max(0, w - 2 * margin);
  const spanY = Math.max(0, h - 2 * margin);
  if (edge === 0) return { x: margin + Math.random() * spanX, y: margin };
  if (edge === 1) return { x: w - margin, y: margin + Math.random() * spanY };
  if (edge === 2) return { x: margin + Math.random() * spanX, y: h - margin };
  return { x: margin, y: margin + Math.random() * spanY };
}

function spawnAwayFrom(target: { x: number; y: number }) {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const margin = Math.max(24, Math.min(80, Math.floor(Math.min(w, h) * 0.06)));

  for (let i = 0; i < 96; i++) {
    const s = edgeSpawn(w, h, margin);
    if (Math.hypot(s.x - target.x, s.y - target.y) >= MIN_SPAWN_SEPARATION) {
      return s;
    }
  }

  const cornerX = target.x > w * 0.5 ? margin : w - margin;
  const cornerY = target.y > h * 0.5 ? margin : h - margin;
  return {
    x: Math.min(w - margin, Math.max(margin, cornerX)),
    y: Math.min(h - margin, Math.max(margin, cornerY)),
  };
}

let snail = { x: 0, y: 0 };
let start = 0;
let ended = false;
let raf = 0;
let last = performance.now();
let playing = false;

function layoutSnail() {
  snailEl.style.left = `${snail.x}px`;
  snailEl.style.top = `${snail.y}px`;
}

function endGame() {
  if (ended) return;
  ended = true;
  cancelAnimationFrame(raf);
  unsubCursor();
  const survived = Math.max(0, (performance.now() - start) / 1000);
  loseEl.hidden = false;
  window.setTimeout(() => {
    void window.screenFlavor.notifyGameOver(survived);
  }, 1600);
}

function tick(now: number) {
  if (ended || !playing) return;
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  const dx = cursor.x - snail.x;
  const dy = cursor.y - snail.y;
  const dist = Math.hypot(dx, dy);

  const warmup = now - start < WARMUP_MS;

  if (!warmup && Number.isFinite(dist) && dist <= HIT_DISTANCE) {
    layoutSnail();
    endGame();
    return;
  }

  if (dist > 0.5 && Number.isFinite(dist)) {
    const step = Math.min(SNAIL_SPEED_PX_PER_SEC * dt, dist);
    snail.x += (dx / dist) * step;
    snail.y += (dy / dist) * step;
  }

  layoutSnail();

  const t = (now - start) / 1000;
  hudEl.textContent = warmup
    ? `${Math.max(0, (WARMUP_MS - (now - start)) / 1000).toFixed(1)}s — get ready…`
    : `${t.toFixed(1)}s — the snail is patient`;

  raf = requestAnimationFrame(tick);
}

function tryBegin() {
  if (playing || ended) return;
  if (!hasLiveCursor) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w < 64 || h < 64) return;

  playing = true;
  snail = spawnAwayFrom(cursor);
  last = performance.now();
  start = last;
  layoutSnail();
  snailEl.style.visibility = "visible";
  hudEl.textContent = "0.0s — get ready…";
  raf = requestAnimationFrame(tick);
}

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(tryBegin);
});

window.addEventListener(
  "resize",
  () => {
    if (!playing || ended) return;
    snail.x = Math.min(window.innerWidth - 40, Math.max(40, snail.x));
    snail.y = Math.min(window.innerHeight - 40, Math.max(40, snail.y));
    layoutSnail();
  },
  { passive: true },
);
