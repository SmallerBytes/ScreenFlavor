import "./style.css";
import { wireOverlayExit } from "./overlayExit";

const BASE_PX = 78;
const WALK_SPEED = 96; // px/sec across the desktop while wandering

type Vec = { x: number; y: number };

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function edgeSpawnOffscreen(w: number, h: number, margin: number): Vec {
  const edge = Math.floor(Math.random() * 4);
  const spanX = Math.max(0, w - 2 * margin);
  const spanY = Math.max(0, h - 2 * margin);
  const out = margin + BASE_PX;
  if (edge === 0) return { x: margin + Math.random() * spanX, y: -out };
  if (edge === 1) return { x: w + out, y: margin + Math.random() * spanY };
  if (edge === 2) return { x: margin + Math.random() * spanX, y: h + out };
  return { x: -out, y: margin + Math.random() * spanY };
}

function randomInner(w: number, h: number, margin: number): Vec {
  return {
    x: margin + Math.random() * Math.max(1, w - 2 * margin),
    y: margin + Math.random() * Math.max(1, h - 2 * margin),
  };
}

function spawnPaperPuff(stage: HTMLElement, at: Vec) {
  const puff = document.createElement("div");
  puff.className = "paper-drop";
  puff.textContent = "📄";
  puff.style.left = `${at.x}px`;
  puff.style.top = `${at.y + 22}px`;
  stage.appendChild(puff);
  // Use the longest CSS animation duration (1100ms) to clean up.
  window.setTimeout(() => {
    puff.remove();
  }, 1400);
}

function run() {
  const root = document.querySelector<HTMLDivElement>("#overlay-root");
  if (!root) throw new Error("Missing #overlay-root");

  root.innerHTML = `
  <button type="button" class="overlay-exit" id="overlay-exit" aria-label="Exit to menu">×</button>
  <div class="overlay-stage" id="stage">
    <div class="goblin goblin--passive goblin--hidden" id="goblin" aria-hidden="true">🧌</div>
  </div>`;

  const stageEl = document.querySelector<HTMLDivElement>("#stage");
  const goblinEl = document.querySelector<HTMLDivElement>("#goblin");

  if (!stageEl || !goblinEl) {
    throw new Error("Goblin overlay DOM missing");
  }

  const half = BASE_PX / 2;
  goblinEl.style.width = `${BASE_PX}px`;
  goblinEl.style.height = `${BASE_PX}px`;
  goblinEl.style.marginLeft = `${-half}px`;
  goblinEl.style.marginTop = `${-half}px`;
  goblinEl.style.fontSize = `${Math.round(BASE_PX * 0.72)}px`;
  goblinEl.style.lineHeight = `${BASE_PX}px`;

  const margin = Math.max(64, Math.min(140, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.1)));

  let pos: Vec = edgeSpawnOffscreen(window.innerWidth, window.innerHeight, margin);
  let target: Vec = randomInner(window.innerWidth, window.innerHeight, margin);

  function layoutGoblin(p: Vec) {
    goblinEl.style.left = `${p.x}px`;
    goblinEl.style.top = `${p.y}px`;
  }

  function pickTarget(): Vec {
    return randomInner(window.innerWidth, window.innerHeight, margin);
  }

  layoutGoblin(pos);
  goblinEl.classList.remove("goblin--hidden");

  // One .txt at a time. After each drop completes, wait a random stagger
  // (15s, 45s, 1m, or 2m) — always at least 10s and never more than 3 minutes.
  const STAGGER_CHOICES_MS = [15_000, 45_000, 60_000, 120_000] as const;
  const MIN_GAP_MS = 10_000;
  const MAX_GAP_MS = 3 * 60_000;

  let pendingDrop = false;
  let stopped = false;
  const sessionStart = performance.now();

  function nextDropDelayMs(): number {
    const raw = STAGGER_CHOICES_MS[Math.floor(Math.random() * STAGGER_CHOICES_MS.length)];
    return Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, raw));
  }

  function scheduleDrop() {
    if (stopped) return;
    window.setTimeout(() => {
      if (stopped) return;
      pendingDrop = true;
    }, nextDropDelayMs());
  }

  function performDrop() {
    pendingDrop = false;
    if (stageEl) spawnPaperPuff(stageEl, pos);
    void window.screenFlavor
      .dropGoblinTxtFile()
      .then((res) => {
        if (!res.ok) {
          console.warn("[goblin] drop failed:", res.message || "unknown");
        }
      })
      .catch((e) => {
        console.warn("[goblin] drop threw:", e);
      })
      .finally(() => {
        scheduleDrop();
      });
  }

  scheduleDrop();

  let raf = 0;
  let lastTs = performance.now();

  function tick(now: number) {
    if (stopped) return;
    const dt = Math.min(0.05, (now - lastTs) / 1000);
    lastTs = now;

    const dx = target.x - pos.x;
    const dy = target.y - pos.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 6) {
      pos = target;
      target = pickTarget();
      // Tiny pause feel — mirror the goblin a bit.
      goblinEl.classList.toggle("goblin--mirror");
    } else {
      const step = Math.min(dist, WALK_SPEED * dt);
      pos = { x: pos.x + (dx / dist) * step, y: pos.y + (dy / dist) * step };
    }

    layoutGoblin(pos);

    if (pendingDrop) {
      performDrop();
    }

    raf = requestAnimationFrame(tick);
  }

  raf = requestAnimationFrame(tick);

  wireOverlayExit(() => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    const elapsed = Math.max(0, (performance.now() - sessionStart) / 1000);
    void window.screenFlavor.notifyGameOver(elapsed);
  });

  window.addEventListener(
    "resize",
    () => {
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      pos.x = Math.min(iw - margin, Math.max(margin, pos.x));
      pos.y = Math.min(ih - margin, Math.max(margin, pos.y));
      target.x = Math.min(iw - margin, Math.max(margin, target.x));
      target.y = Math.min(ih - margin, Math.max(margin, target.y));
      layoutGoblin(pos);
    },
    { passive: true },
  );

  window.addEventListener("beforeunload", () => {
    stopped = true;
    cancelAnimationFrame(raf);
  });
}

run();
