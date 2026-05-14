import "./style.css";
import type { SnailLaunchSettings } from "./vite-env";

document.documentElement.classList.add("overlay");
document.body.classList.add("overlay");

const WARMUP_MS = 450;

function defaults(): SnailLaunchSettings {
  return { sizePercent: 100, speedPercent: 100 };
}

async function run() {
  let settings: SnailLaunchSettings;
  try {
    settings = await window.screenFlavor.getSnailLaunchSettings();
  } catch {
    settings = defaults();
  }

  const sizeFactor = settings.sizePercent / 100;
  const basePx = 72 * sizeFactor;
  const fontPx = 56 * sizeFactor;
  const half = basePx / 2;
  const hitDistance = Math.max(18, Math.min(52, 28 * sizeFactor));
  const snailSpeedPxPerSec = 52 * (settings.speedPercent / 100);
  const minSpawnSeparation = Math.round(200 + 50 * sizeFactor);
  const edgePad = Math.max(24, Math.floor(half * 1.1));

  const root = document.querySelector<HTMLDivElement>("#overlay-root");
  if (!root) throw new Error("Missing #overlay-root");

  root.innerHTML = `
  <div class="overlay-stage" id="stage">
    <div class="snail" id="snail" aria-hidden="true"></div>
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

  if (!snailEl || !hudEl || !loseEl) {
    throw new Error("Overlay DOM missing");
  }

  const snailDom = snailEl;
  const hudDom = hudEl;
  const loseDom = loseEl;

  snailDom.textContent = "🐌";
  snailDom.style.width = `${basePx}px`;
  snailDom.style.height = `${basePx}px`;
  snailDom.style.marginLeft = `${-half}px`;
  snailDom.style.marginTop = `${-half}px`;
  snailDom.style.fontSize = `${fontPx}px`;
  snailDom.style.lineHeight = `${basePx}px`;

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
      if (Math.hypot(s.x - target.x, s.y - target.y) >= minSpawnSeparation) {
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
    snailDom.style.left = `${snail.x}px`;
    snailDom.style.top = `${snail.y}px`;
  }

  function endGame() {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    unsubCursor();
    const survived = Math.max(0, (performance.now() - start) / 1000);
    loseDom.hidden = false;
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

    if (!warmup && Number.isFinite(dist) && dist <= hitDistance) {
      layoutSnail();
      endGame();
      return;
    }

    if (dist > 0.5 && Number.isFinite(dist)) {
      const step = Math.min(snailSpeedPxPerSec * dt, dist);
      snail.x += (dx / dist) * step;
      snail.y += (dy / dist) * step;
    }

    layoutSnail();

    const t = (now - start) / 1000;
    hudDom.textContent = warmup
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
    snailDom.style.visibility = "visible";
    hudDom.textContent = "0.0s — get ready…";
    raf = requestAnimationFrame(tick);
  }

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(tryBegin);
  });

  window.addEventListener(
    "resize",
    () => {
      if (!playing || ended) return;
      snail.x = Math.min(window.innerWidth - edgePad, Math.max(edgePad, snail.x));
      snail.y = Math.min(window.innerHeight - edgePad, Math.max(edgePad, snail.y));
      layoutSnail();
    },
    { passive: true },
  );
}

void run();
