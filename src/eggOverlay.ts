import "./style.css";
import { wireOverlayExit } from "./overlayExit";

type Vec = { x: number; y: number };

const EGG_INCUBATE_MS = 60_000;
/** Progressive cracks for the last ~20s before hatch. */
const CRACK_START_MS = 40_000;
const STAGE_MS = 5 * 60_000;
const LAID_EGG_HATCH_MS = 75_000;
const DUCK_PX = 76;
const DUCKLING_PX = 50;
const WALK_SPEED = 62;
const DUCKLING_WALK = 44;
const SWEEP_RADIUS = 48;
const MAX_POOPS = 40;
const POOP_PASSES_TO_CLEAR = 3;
const WORM_EAT_RADIUS = 38;
const WORM_CHASE_SPEED = 78;
/** Time per growth tier for hatched ducks (chick → juvenile → adult); they stay for the whole run. */
const DUCKLING_GROWTH_PHASE_MS = 22_000;
/** Old duck stands still and glows for the last minute before fireworks. */
const PRE_EXPLODE_CHARGE_MS = 60_000;

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function randomInner(w: number, h: number, margin: number): Vec {
  return {
    x: margin + Math.random() * Math.max(1, w - 2 * margin),
    y: margin + Math.random() * Math.max(1, h - 2 * margin),
  };
}

function run() {
  document.documentElement.classList.add("overlay", "egg");
  document.body.classList.add("overlay", "egg");

  const root = document.querySelector<HTMLDivElement>("#overlay-root");
  if (!root) throw new Error("Missing #overlay-root");

  root.innerHTML = `
    <button type="button" class="overlay-exit" id="overlay-exit" aria-label="Exit to menu">×</button>
    <div class="overlay-stage egg-stage" id="stage">
      <div class="egg-layer" id="egg-layer" aria-hidden="true">
        <div class="egg-main" id="egg">🥚</div>
        <p class="egg-hud" id="egg-hud">The Egg — hatching soon…</p>
      </div>
      <div class="duck-layer" id="duck-layer" hidden>
        <div class="duck" id="duck" aria-hidden="true">🐤</div>
      </div>
      <div class="fireworks-root" id="fx-root" aria-hidden="true"></div>
    </div>
    <div class="egg-meta-hud" id="meta-hud"></div>
  `;

  const stageEl = document.querySelector<HTMLDivElement>("#stage");
  const eggLayer = document.querySelector<HTMLDivElement>("#egg-layer");
  const eggEl = document.querySelector<HTMLDivElement>("#egg");
  const eggHud = document.querySelector<HTMLParagraphElement>("#egg-hud");
  const duckLayer = document.querySelector<HTMLDivElement>("#duck-layer");
  const duckEl = document.querySelector<HTMLDivElement>("#duck");
  const fxRoot = document.querySelector<HTMLDivElement>("#fx-root");
  const metaHud = document.querySelector<HTMLDivElement>("#meta-hud");

  if (!stageEl || !eggLayer || !eggEl || !eggHud || !duckLayer || !duckEl || !fxRoot || !metaHud) {
    throw new Error("Egg overlay DOM missing");
  }

  const sessionStart = performance.now();
  let duckHatchAt: number | null = null;
  let cursor: Vec = { x: 0, y: 0 };
  let hasCursor = false;

  const margin = Math.max(56, Math.min(120, Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.09)));
  const halfD = DUCK_PX / 2;

  let duckPos: Vec = {
    x: window.innerWidth * 0.5,
    y: window.innerHeight * 0.5,
  };
  let duckTarget: Vec = randomInner(window.innerWidth, window.innerHeight, margin);

  type Poop = {
    el: HTMLDivElement;
    x: number;
    y: number;
    passes: number;
    cursorInside: boolean;
  };
  const poops: Poop[] = [];

  type LaidEgg = { el: HTMLDivElement; x: number; y: number; laidAt: number; hatched: boolean };
  const laidEggs: LaidEgg[] = [];

  type Duckling = {
    id: number;
    el: HTMLDivElement;
    pos: Vec;
    target: Vec;
    born: number;
    /** When this bird will lay an egg; 0 until juvenile+. */
    nextLayAt: number;
  };
  const ducklings: Duckling[] = [];
  let nextDucklingId = 1;

  type Worm = {
    el: HTMLDivElement;
    x: number;
    y: number;
    chasers: Array<"duck" | number>;
  };
  const worms: Worm[] = [];

  let nextPoopAt = 0;
  let nextLayAt = 0;
  let nextWormAt = 0;
  let boomTriggered = false;
  let ended = false;
  let raf = 0;
  let lastTs = performance.now();

  const unsub = window.screenFlavor.onCursor((p) => {
    cursor = p;
    hasCursor = true;
  });

  function layoutDuck(p: Vec) {
    duckEl.style.left = `${p.x}px`;
    duckEl.style.top = `${p.y}px`;
  }

  function duckStage(now: number): 0 | 1 | 2 | 3 | 4 {
    if (duckHatchAt === null) return 0;
    const t = now - duckHatchAt;
    if (t >= 3 * STAGE_MS) return 4;
    if (t >= 2 * STAGE_MS) return 3;
    if (t >= STAGE_MS) return 2;
    return 1;
  }

  function syncDuckEmoji(st: 1 | 2 | 3) {
    duckEl.classList.remove("duck--prime", "duck--elder");
    if (st === 1) {
      duckEl.textContent = "🐤";
      duckEl.style.fontSize = `${Math.round(DUCK_PX * 0.72)}px`;
      duckEl.style.lineHeight = `${DUCK_PX}px`;
      return;
    }
    if (st === 2) {
      duckEl.textContent = "🦆";
      duckEl.classList.add("duck--prime");
      duckEl.style.fontSize = `${Math.round(DUCK_PX * 0.8)}px`;
      duckEl.style.lineHeight = `${DUCK_PX}px`;
      return;
    }
    duckEl.textContent = "🦆";
    duckEl.classList.add("duck--elder");
    duckEl.style.fontSize = `${Math.round(DUCK_PX * 0.64)}px`;
    duckEl.style.lineHeight = `${DUCK_PX}px`;
  }

  function ducklingLifeStage(ageMs: number): 1 | 2 | 3 {
    if (ageMs < DUCKLING_GROWTH_PHASE_MS) return 1;
    if (ageMs < 2 * DUCKLING_GROWTH_PHASE_MS) return 2;
    return 3;
  }

  function syncDuckling(d: Duckling, now: number) {
    const age = now - d.born;
    const st = ducklingLifeStage(age);
    const px =
      st === 1 ? DUCKLING_PX : st === 2 ? Math.round(DUCKLING_PX * 1.14) : Math.round(DUCKLING_PX * 0.92);
    const half = px / 2;
    d.el.style.width = `${px}px`;
    d.el.style.height = `${px}px`;
    d.el.style.marginLeft = `${-half}px`;
    d.el.style.marginTop = `${-half}px`;
    d.el.style.fontSize = `${Math.round(px * 0.72)}px`;
    d.el.style.lineHeight = `${px}px`;
    const tier =
      st === 1 ? "duckling--chick" : st === 2 ? "duckling--juvenile" : "duckling--elder";
    d.el.className = `duckling ${tier}`;
    if (st === 1) {
      d.el.textContent = "🐤";
    } else if (st === 2) {
      d.el.textContent = "🐥";
    } else {
      d.el.textContent = "🦆";
    }
  }

  function syncEggCrack(elapsed: number) {
    eggEl.className = "egg-main";
    if (elapsed < CRACK_START_MS) return;
    const u = (elapsed - CRACK_START_MS) / (EGG_INCUBATE_MS - CRACK_START_MS);
    if (u < 0.34) eggEl.classList.add("egg--crack1");
    else if (u < 0.67) eggEl.classList.add("egg--crack2");
    else eggEl.classList.add("egg--crack3", "egg--shake");
  }

  function spawnPoop() {
    if (poops.length >= MAX_POOPS) {
      const old = poops.shift();
      old?.el.remove();
    }
    const el = document.createElement("div");
    el.className = "poop";
    el.textContent = "💩";
    const ox = rand(-28, 28);
    const oy = rand(18, 42);
    const x = Math.min(window.innerWidth - 24, Math.max(24, duckPos.x + ox));
    const y = Math.min(window.innerHeight - 24, Math.max(24, duckPos.y + oy));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    stageEl.appendChild(el);
    poops.push({ el, x, y, passes: 0, cursorInside: false });
  }

  function spawnLaidEgg(from: Vec) {
    const el = document.createElement("div");
    el.className = "laid-egg";
    el.textContent = "🥚";
    const ox = rand(-40, 40);
    const oy = rand(28, 55);
    const x = Math.min(window.innerWidth - 30, Math.max(30, from.x + ox));
    const y = Math.min(window.innerHeight - 30, Math.max(30, from.y + oy));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    stageEl.appendChild(el);
    laidEggs.push({ el, x, y, laidAt: performance.now(), hatched: false });
  }

  function spawnDuckling(at: Vec) {
    const el = document.createElement("div");
    el.className = "duckling duckling--chick";
    el.textContent = "🐤";
    el.setAttribute("aria-hidden", "true");
    const half = DUCKLING_PX / 2;
    el.style.width = `${DUCKLING_PX}px`;
    el.style.height = `${DUCKLING_PX}px`;
    el.style.marginLeft = `${-half}px`;
    el.style.marginTop = `${-half}px`;
    el.style.fontSize = `${Math.round(DUCKLING_PX * 0.72)}px`;
    el.style.lineHeight = `${DUCKLING_PX}px`;
    const pos = { ...at };
    layoutMini(el, pos);
    stageEl.appendChild(el);
    ducklings.push({
      id: nextDucklingId++,
      el,
      pos,
      target: randomInner(window.innerWidth, window.innerHeight, margin),
      born: performance.now(),
      nextLayAt: 0,
    });
  }

  function layoutMini(el: HTMLElement, p: Vec) {
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
  }

  function assignWormChasers(worm: Worm) {
    type Ent = { kind: "duck"; dist: number } | { kind: "duckling"; id: number; dist: number };
    const list: Ent[] = [{ kind: "duck", dist: Math.hypot(duckPos.x - worm.x, duckPos.y - worm.y) }];
    for (const d of ducklings) {
      list.push({
        kind: "duckling",
        id: d.id,
        dist: Math.hypot(d.pos.x - worm.x, d.pos.y - worm.y),
      });
    }
    list.sort((a, b) => a.dist - b.dist);
    worm.chasers = [];
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const e = list[i];
      worm.chasers.push(e.kind === "duck" ? "duck" : e.id);
    }
  }

  function spawnWorm(now: number) {
    if (worms.length > 0) return;
    const p = randomInner(window.innerWidth, window.innerHeight, margin + 24);
    const el = document.createElement("div");
    el.className = "worm";
    el.textContent = "🪱";
    el.setAttribute("aria-hidden", "true");
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    stageEl.appendChild(el);
    const worm: Worm = { el, x: p.x, y: p.y, chasers: [] };
    assignWormChasers(worm);
    worms.push(worm);
    nextWormAt = now + rand(14_000, 32_000);
  }

  function eatWorm(worm: Worm) {
    const ix = worms.indexOf(worm);
    if (ix < 0) return;
    worm.el.classList.add("worm--eaten");
    window.setTimeout(() => worm.el.remove(), 220);
    worms.splice(ix, 1);
  }

  function clearWorms() {
    for (const w of worms) {
      w.el.remove();
    }
    worms.length = 0;
  }

  function tryWormEaten() {
    for (let wi = worms.length - 1; wi >= 0; wi--) {
      const w = worms[wi];
      for (const c of w.chasers) {
        let dist: number;
        if (c === "duck") {
          dist = Math.hypot(duckPos.x - w.x, duckPos.y - w.y);
        } else {
          const dl = ducklings.find((b) => b.id === c);
          dist = dl ? Math.hypot(dl.pos.x - w.x, dl.pos.y - w.y) : Infinity;
        }
        if (dist < WORM_EAT_RADIUS) {
          eatWorm(w);
          return;
        }
      }
    }
  }

  function sweepPoops() {
    if (!hasCursor) return;
    for (let i = poops.length - 1; i >= 0; i--) {
      const p = poops[i];
      const inside = Math.hypot(cursor.x - p.x, cursor.y - p.y) <= SWEEP_RADIUS;
      if (inside && !p.cursorInside) {
        p.passes += 1;
        p.el.classList.remove("poop--pass-1", "poop--pass-2");
        if (p.passes === 1) p.el.classList.add("poop--pass-1");
        if (p.passes === 2) p.el.classList.add("poop--pass-2");
      }
      p.cursorInside = inside;
      if (p.passes >= POOP_PASSES_TO_CLEAR) {
        p.el.classList.add("poop--swept");
        window.setTimeout(() => p.el.remove(), 280);
        poops.splice(i, 1);
      }
    }
  }

  function hatchFromLaidEgg(egg: LaidEgg) {
    if (egg.hatched) return;
    egg.hatched = true;
    egg.el.classList.add("laid-egg--hatch");
    window.setTimeout(() => {
      egg.el.remove();
      const idx = laidEggs.indexOf(egg);
      if (idx >= 0) laidEggs.splice(idx, 1);
      spawnDuckling({ x: egg.x, y: egg.y });
    }, 650);
  }

  function triggerFireworks(at: Vec) {
    boomTriggered = true;
    duckEl.classList.remove("duck--pre-explode");
    duckLayer.hidden = true;
    const burst = document.createElement("div");
    burst.className = "firework-burst";
    burst.style.left = `${at.x}px`;
    burst.style.top = `${at.y}px`;
    const sparks = ["✨", "🎆", "⭐", "💥", "🌟", "✨", "🎇", "💫"];
    for (let i = 0; i < 14; i++) {
      const s = document.createElement("span");
      s.className = "firework-spark";
      s.textContent = sparks[i % sparks.length];
      const ang = (Math.PI * 2 * i) / 14;
      const d = rand(72, 168);
      s.style.setProperty("--tx", `${Math.cos(ang) * d}px`);
      s.style.setProperty("--ty", `${Math.sin(ang) * d - 48}px`);
      burst.appendChild(s);
    }
    fxRoot.appendChild(burst);
    window.setTimeout(finishRun, 2600);
  }

  function finishRun() {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    unsub();
    const seconds = (performance.now() - sessionStart) / 1000;
    void window.screenFlavor.notifyGameOver(seconds);
  }

  function exitToMenu() {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    unsub();
    const seconds = Math.max(0, (performance.now() - sessionStart) / 1000);
    void window.screenFlavor.notifyGameOver(seconds);
  }

  wireOverlayExit(exitToMenu);

  function tick(now: number) {
    if (ended) return;
    const dt = Math.min(0.05, (now - lastTs) / 1000);
    lastTs = now;
    const elapsed = now - sessionStart;

    if (duckHatchAt === null) {
      syncEggCrack(elapsed);
      const left = Math.max(0, (EGG_INCUBATE_MS - elapsed) / 1000);
      eggHud.textContent =
        left > 0.5
          ? `The Egg — cracks spread… ${left.toFixed(0)}s`
          : "The Egg — hatching…";
      if (elapsed >= EGG_INCUBATE_MS) {
        duckHatchAt = now;
        eggLayer.hidden = true;
        duckLayer.hidden = false;
        duckPos = {
          x: window.innerWidth * 0.5,
          y: window.innerHeight * 0.5,
        };
        duckTarget = randomInner(window.innerWidth, window.innerHeight, margin);
        syncDuckEmoji(1);
        duckEl.style.width = `${DUCK_PX}px`;
        duckEl.style.height = `${DUCK_PX}px`;
        duckEl.style.marginLeft = `${-halfD}px`;
        duckEl.style.marginTop = `${-halfD}px`;
        layoutDuck(duckPos);
        nextPoopAt = now + rand(4000, 10_000);
        nextLayAt = now + STAGE_MS + rand(3000, 12_000);
        nextWormAt = now + rand(10_000, 22_000);
      }
      raf = requestAnimationFrame(tick);
      return;
    }

    const st = duckStage(now);
    if (st === 1) syncDuckEmoji(1);
    else if (st === 2) syncDuckEmoji(2);
    else if (st === 3) syncDuckEmoji(3);

    const explodeAt = duckHatchAt + 3 * STAGE_MS;
    const preExploding =
      !boomTriggered && now >= explodeAt - PRE_EXPLODE_CHARGE_MS && now < explodeAt;

    if (preExploding) {
      if (worms.length) clearWorms();
      duckEl.classList.add("duck--pre-explode");
      const sec = Math.max(0, (explodeAt - now) / 1000);
      metaHud.textContent = `The duck stops — bursting glow… ${sec.toFixed(1)}s`;
    } else {
      duckEl.classList.remove("duck--pre-explode");
      metaHud.textContent =
        st === 1
          ? "Chick — sweep poops (three passes each). Tiny worms appear; the three closest birds run to eat them."
          : st === 2
            ? "Young duck — bright colors; worms for snacks (three closest birds). Laid eggs hatch into ducks that grow up and lay more."
            : st === 3
              ? "Old duck — the flock keeps growing. Grand finale soon…"
              : "";
    }

    if (st === 4 && !boomTriggered) {
      triggerFireworks({ ...duckPos });
      raf = requestAnimationFrame(tick);
      return;
    }

    if (!boomTriggered && !preExploding) {
      const wormDuck = worms.find((w) => w.chasers.includes("duck")) ?? null;
      if (wormDuck) {
        const wx = wormDuck.x - duckPos.x;
        const wy = wormDuck.y - duckPos.y;
        const dist = Math.hypot(wx, wy);
        if (dist > 0.5) {
          const step = Math.min(dist, WORM_CHASE_SPEED * dt);
          duckPos.x += (wx / dist) * step;
          duckPos.y += (wy / dist) * step;
        }
        layoutDuck(duckPos);
      } else {
        const dx = duckTarget.x - duckPos.x;
        const dy = duckTarget.y - duckPos.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 8) {
          duckPos = duckTarget;
          duckTarget = randomInner(window.innerWidth, window.innerHeight, margin);
          duckEl.classList.toggle("duck--flip");
        } else {
          const step = Math.min(dist, WALK_SPEED * dt);
          duckPos = {
            x: duckPos.x + (dx / dist) * step,
            y: duckPos.y + (dy / dist) * step,
          };
        }
        layoutDuck(duckPos);
      }

      if (now >= nextPoopAt) {
        spawnPoop();
        nextPoopAt = now + rand(7000, 18_000);
      }

      if (worms.length === 0 && now >= nextWormAt) {
        spawnWorm(now);
      }

      if ((st === 2 || st === 3) && now >= nextLayAt) {
        spawnLaidEgg(duckPos);
        nextLayAt = now + rand(18_000, 38_000);
      }
    }

    for (const egg of laidEggs) {
      if (!egg.hatched && now - egg.laidAt >= LAID_EGG_HATCH_MS) {
        hatchFromLaidEgg(egg);
      }
    }

    for (const d of ducklings) {
      syncDuckling(d, now);
      const dlStage = ducklingLifeStage(now - d.born);
      if (
        !boomTriggered &&
        !preExploding &&
        dlStage >= 2
      ) {
        if (d.nextLayAt === 0) {
          d.nextLayAt = now + rand(10_000, 24_000);
        } else if (now >= d.nextLayAt) {
          spawnLaidEgg(d.pos);
          d.nextLayAt = now + rand(24_000, 48_000);
        }
      }
      const wormDl = worms.find((w) => w.chasers.includes(d.id)) ?? null;
      if (wormDl) {
        const wx = wormDl.x - d.pos.x;
        const wy = wormDl.y - d.pos.y;
        const ddist = Math.hypot(wx, wy);
        if (ddist > 0.5) {
          const s = Math.min(ddist, WORM_CHASE_SPEED * dt);
          d.pos.x += (wx / ddist) * s;
          d.pos.y += (wy / ddist) * s;
        }
      } else {
        const vx = d.target.x - d.pos.x;
        const vy = d.target.y - d.pos.y;
        const ddist = Math.hypot(vx, vy);
        if (ddist < 6) {
          d.target = randomInner(window.innerWidth, window.innerHeight, margin);
        } else {
          const s = Math.min(ddist, DUCKLING_WALK * dt);
          d.pos.x += (vx / ddist) * s;
          d.pos.y += (vy / ddist) * s;
        }
      }
      layoutMini(d.el, d.pos);
    }

    tryWormEaten();

    sweepPoops();

    raf = requestAnimationFrame(tick);
  }

  raf = requestAnimationFrame(tick);

  window.addEventListener(
    "resize",
    () => {
      duckPos.x = Math.min(window.innerWidth - margin, Math.max(margin, duckPos.x));
      duckPos.y = Math.min(window.innerHeight - margin, Math.max(margin, duckPos.y));
      duckTarget.x = Math.min(window.innerWidth - margin, Math.max(margin, duckTarget.x));
      duckTarget.y = Math.min(window.innerHeight - margin, Math.max(margin, duckTarget.y));
      layoutDuck(duckPos);
      for (const d of ducklings) {
        d.pos.x = Math.min(window.innerWidth - margin, Math.max(margin, d.pos.x));
        d.pos.y = Math.min(window.innerHeight - margin, Math.max(margin, d.pos.y));
        d.target.x = Math.min(window.innerWidth - margin, Math.max(margin, d.target.x));
        d.target.y = Math.min(window.innerHeight - margin, Math.max(margin, d.target.y));
        layoutMini(d.el, d.pos);
      }
    },
    { passive: true },
  );

  window.addEventListener("beforeunload", () => {
    ended = true;
    cancelAnimationFrame(raf);
    unsub();
  });
}

void run();
