import "./style.css";

const GOBLIN_TIMEOUT_MS = 88_000;
const HIT_PAD = 14;
const BASE_PX = 78;

function pushHitRegion(el: HTMLElement | null) {
  if (!el || el.classList.contains("goblin--hidden")) {
    window.screenFlavor.setGoblinHitRegion(null);
    return;
  }
  const r = el.getBoundingClientRect();
  window.screenFlavor.setGoblinHitRegion({
    x: window.screenX + r.left - HIT_PAD,
    y: window.screenY + r.top - HIT_PAD,
    w: r.width + HIT_PAD * 2,
    h: r.height + HIT_PAD * 2,
  });
}

function edgeSpawnOffscreen(w: number, h: number, margin: number) {
  const edge = Math.floor(Math.random() * 4);
  const spanX = Math.max(0, w - 2 * margin);
  const spanY = Math.max(0, h - 2 * margin);
  const out = margin + BASE_PX;
  if (edge === 0) return { x: margin + Math.random() * spanX, y: -out };
  if (edge === 1) return { x: w + out, y: margin + Math.random() * spanY };
  if (edge === 2) return { x: margin + Math.random() * spanX, y: h + out };
  return { x: -out, y: margin + Math.random() * spanY };
}

function randomInner(w: number, h: number, margin: number) {
  return {
    x: margin + Math.random() * Math.max(1, w - 2 * margin),
    y: margin + Math.random() * Math.max(1, h - 2 * margin),
  };
}

function run() {
  const root = document.querySelector<HTMLDivElement>("#overlay-root");
  if (!root) throw new Error("Missing #overlay-root");

  root.innerHTML = `
  <div class="overlay-stage" id="stage">
    <div class="goblin goblin--hidden" id="goblin" aria-hidden="true">🧌</div>
  </div>
  <div class="hud" id="hud">The Goblin is scheming…</div>
  <div class="lose-banner" id="end" hidden>
    <div class="lose-inner">
      <h2 id="end-title">Got away!</h2>
      <p id="end-desc">The goblin slipped off your desktop.</p>
    </div>
  </div>`;

  const goblinEl = document.querySelector<HTMLDivElement>("#goblin");
  const hudEl = document.querySelector<HTMLDivElement>("#hud");
  const endEl = document.querySelector<HTMLDivElement>("#end");
  const endTitle = document.querySelector<HTMLHeadingElement>("#end-title");
  const endDesc = document.querySelector<HTMLParagraphElement>("#end-desc");

  if (!goblinEl || !hudEl || !endEl || !endTitle || !endDesc) {
    throw new Error("Goblin overlay DOM missing");
  }

  const half = BASE_PX / 2;
  goblinEl.style.width = `${BASE_PX}px`;
  goblinEl.style.height = `${BASE_PX}px`;
  goblinEl.style.marginLeft = `${-half}px`;
  goblinEl.style.marginTop = `${-half}px`;
  goblinEl.style.fontSize = `${Math.round(BASE_PX * 0.72)}px`;
  goblinEl.style.lineHeight = `${BASE_PX}px`;

  let ended = false;
  let raf = 0;
  const startAll = performance.now();
  let phaseStart = startAll;
  let phase: "wait" | "charge" | "loiter" = "wait";
  let hasShuffled = false;

  const waitMs = 650 + Math.random() * 1400;
  const margin = Math.max(48, Math.min(120, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.08)));

  let entry = { x: 0, y: 0 };
  let target = { x: 0, y: 0 };
  let chargeDuration = 1800;

  function layoutGoblin(x: number, y: number) {
    goblinEl.style.left = `${x}px`;
    goblinEl.style.top = `${y}px`;
  }

  function finish(escaped: boolean, elapsedSec: number) {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    window.screenFlavor.setGoblinHitRegion(null);
    goblinEl.classList.remove("goblin--idle");
    if (escaped) {
      goblinEl.classList.add("goblin--hidden");
      endTitle.textContent = "Got away!";
      endDesc.textContent = "The goblin ran off before you could spank him.";
      endEl.hidden = false;
      window.setTimeout(() => {
        void window.screenFlavor.notifyGameOver(-Math.max(0.01, elapsedSec));
      }, 1200);
    }
  }

  let winNotified = false;
  function notifyWin(elapsed: number) {
    if (winNotified) return;
    winNotified = true;
    void window.screenFlavor.notifyGameOver(Math.max(0.05, elapsed));
  }

  goblinEl.addEventListener(
    "pointerdown",
    (ev) => {
      if (ended || phase === "wait" || goblinEl.classList.contains("goblin--hidden")) return;
      ev.preventDefault();
      ev.stopPropagation();
      ended = true;
      cancelAnimationFrame(raf);
      window.screenFlavor.setGoblinHitRegion(null);
      goblinEl.classList.remove("goblin--idle");
      goblinEl.classList.add("goblin--falling");
      const elapsed = (performance.now() - startAll) / 1000;
      const onDone = () => {
        goblinEl.removeEventListener("transitionend", onDone);
        notifyWin(elapsed);
      };
      goblinEl.addEventListener("transitionend", onDone);
      window.setTimeout(() => notifyWin(elapsed), 950);
    },
    { capture: true },
  );

  async function tick(now: number) {
    if (ended) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const elapsed = (now - startAll) / 1000;

    if (phase === "wait") {
      if (now - phaseStart >= waitMs) {
        phase = "charge";
        phaseStart = now;
        entry = edgeSpawnOffscreen(w, h, margin);
        target = randomInner(w, h, margin);
        const dist = Math.hypot(target.x - entry.x, target.y - entry.y);
        chargeDuration = Math.min(3200, Math.max(1100, (dist / 420) * 1000));
        goblinEl.classList.remove("goblin--hidden");
        layoutGoblin(entry.x, entry.y);
        hudEl.textContent = "Here he comes…";
      } else {
        hudEl.textContent = `${((waitMs - (now - phaseStart)) / 1000).toFixed(1)}s — watch the desktop…`;
      }
    }

    if (phase === "charge") {
      const t = Math.min(1, (now - phaseStart) / chargeDuration);
      const x = entry.x + (target.x - entry.x) * t;
      const y = entry.y + (target.y - entry.y) * t;
      layoutGoblin(x, y);
      pushHitRegion(goblinEl);

      if (!hasShuffled && t >= 0.68) {
        hasShuffled = true;
        void window.screenFlavor.shuffleDesktopIcon().then((res) => {
          if (ended) return;
          if (res.ok) {
            hudEl.textContent = "He moved a desktop icon! Click him to spank him off!";
          } else if (res.skipped) {
            hudEl.textContent = "Click the goblin to spank him off! (Icon shuffle is Windows-only.)";
          } else {
            hudEl.textContent =
              "Click the goblin to spank him off! (Could not nudge a desktop icon — Windows may be blocking it.)";
          }
        });
      }

      if (t >= 1) {
        phase = "loiter";
        phaseStart = now;
        layoutGoblin(target.x, target.y);
        goblinEl.classList.add("goblin--idle");
      }
    }

    if (phase === "loiter") {
      pushHitRegion(goblinEl);
      hudEl.textContent = `${elapsed.toFixed(1)}s — spank the goblin!`;
      if (now - startAll >= GOBLIN_TIMEOUT_MS) {
        finish(true, (now - startAll) / 1000);
        return;
      }
    }

    if (!ended) {
      raf = requestAnimationFrame(tick);
    }
  }

  raf = requestAnimationFrame(tick);

  window.addEventListener(
    "resize",
    () => {
      if (ended || phase === "wait") return;
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      const gx = parseFloat(goblinEl.style.left) || 0;
      const gy = parseFloat(goblinEl.style.top) || 0;
      layoutGoblin(Math.min(iw - margin, Math.max(margin, gx)), Math.min(ih - margin, Math.max(margin, gy)));
    },
    { passive: true },
  );
}

void run();
