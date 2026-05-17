import "./style.css";
import type { SnailLaunchSettings } from "./vite-env";

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing #app");

app.innerHTML = `
  <div class="launcher hub">
    <header class="hub-header">
      <div class="brand-mark" aria-hidden="true">🖥️</div>
      <h1>ScreenFlavor</h1>
      <p class="tagline">Desktop screen games you play over your own workspace.</p>
    </header>

    <section class="game-grid" aria-label="Choose a game">
      <article class="game-card" data-game="snail">
        <div class="game-icon" aria-hidden="true">🐌</div>
        <h2>The Snail</h2>
        <p class="game-blurb">
          A snail appears on your screen and slowly homes in on your cursor. If it touches you, you lose. The snail
          stays <strong>above your other apps</strong> so you can always keep an eye on it.
        </p>

        <fieldset class="snail-settings">
          <legend class="snail-settings-legend">Snail options</legend>

          <p class="snail-look-note">
            <strong>Look:</strong> classic snail for now. Different snail characters will be added when the art is ready.
          </p>

          <div class="snail-setting-block">
            <label class="snail-setting-label" for="snail-size">Size <span class="snail-value" id="snail-size-val">100%</span></label>
            <input type="range" id="snail-size" min="50" max="160" value="100" step="1" />
          </div>

          <div class="snail-setting-block">
            <label class="snail-setting-label" for="snail-speed">Speed <span class="snail-value" id="snail-speed-val">100%</span></label>
            <input type="range" id="snail-speed" min="25" max="220" value="100" step="1" />
          </div>
        </fieldset>

        <button type="button" class="btn-play game-start">Play</button>
      </article>

      <article class="game-card" data-game="goblin">
        <div class="game-icon" aria-hidden="true">🧌</div>
        <h2>The Goblin</h2>
        <p class="game-blurb">
          A goblin scampers around your screen and starts <strong>leaving real .txt files on your Desktop</strong>
          — silly names, goblin ASCII art, the works. One file at a time, spaced by a random wait (15s, 45s, 1 min,
          or 2 min — never less than 10s or more than 3 min between drops). He keeps going until you stop him; the
          files he left stay until you delete them yourself.
        </p>
        <button type="button" class="btn-play" id="goblin-start">Play</button>
      </article>

      <article class="game-card" data-game="egg">
        <div class="game-icon" aria-hidden="true">🥚</div>
        <h2>The Egg</h2>
        <p class="game-blurb">
          An egg sits on your desktop for <strong>one minute</strong>, then hatches into a duck. The duck grows through
          three life stages (about five minutes each). It leaves poops to sweep away with your cursor and, once
          grown, lays eggs that hatch into ducks that <strong>grow up, stay on screen, and lay their own eggs</strong>.
          When the duck becomes old, the <strong>last minute</strong> is a frozen,
          glowing build-up, then a firework finale. <strong>Tiny worms</strong> wriggle out sometimes — the
          <strong>three closest birds</strong> (the duck and any hatched chicks) sprint to eat them. Each poop needs <strong>three passes</strong> with your cursor (move over it, away, and repeat) before it goes away.
        </p>
        <button type="button" class="btn-play" id="egg-start">Play</button>
      </article>
    </section>

    <div class="last-run" id="last-run" aria-live="polite"></div>

    <div class="hub-footer">
      <p class="hub-footer-meta"><span id="app-version" class="app-version"></span> · Updates: <strong>Help</strong> → <strong>Check for Updates…</strong></p>
      <button type="button" class="btn-quit" id="btn-quit">Quit ScreenFlavor</button>
    </div>
  </div>
`;

const lastRun = document.querySelector<HTMLDivElement>("#last-run");
const btnQuit = document.querySelector<HTMLButtonElement>("#btn-quit");
const snailCard = document.querySelector<HTMLElement>('[data-game="snail"]');
const snailPlay = snailCard?.querySelector<HTMLButtonElement>(".game-start");
const appVersionEl = document.querySelector<HTMLSpanElement>("#app-version");
const snailSize = document.querySelector<HTMLInputElement>("#snail-size");
const snailSpeed = document.querySelector<HTMLInputElement>("#snail-speed");
const snailSizeVal = document.querySelector<HTMLSpanElement>("#snail-size-val");
const snailSpeedVal = document.querySelector<HTMLSpanElement>("#snail-speed-val");
const goblinStart = document.querySelector<HTMLButtonElement>("#goblin-start");
const eggStart = document.querySelector<HTMLButtonElement>("#egg-start");

if (
  !lastRun ||
  !btnQuit ||
  !snailPlay ||
  !goblinStart ||
  !eggStart ||
  !appVersionEl ||
  !snailSize ||
  !snailSpeed ||
  !snailSizeVal ||
  !snailSpeedVal
) {
  throw new Error("Launcher DOM missing");
}

function syncRangeLabel(input: HTMLInputElement, out: HTMLSpanElement) {
  out.textContent = `${input.value}%`;
}

snailSize.addEventListener("input", () => syncRangeLabel(snailSize, snailSizeVal));
snailSpeed.addEventListener("input", () => syncRangeLabel(snailSpeed, snailSpeedVal));

void window.screenFlavor.getAppVersion().then((v) => {
  appVersionEl.textContent = `v${v}`;
});

snailPlay.addEventListener("click", async () => {
  const settings: SnailLaunchSettings = {
    sizePercent: Number(snailSize.value),
    speedPercent: Number(snailSpeed.value),
  };
  await window.screenFlavor.startGame("snail", settings);
});

goblinStart.addEventListener("click", async () => {
  await window.screenFlavor.startGame("goblin");
});

eggStart.addEventListener("click", async () => {
  await window.screenFlavor.startGame("egg");
});

btnQuit.addEventListener("click", async () => {
  await window.screenFlavor.quitApp();
});

window.screenFlavor.onLastRun(({ seconds, gameId, dropped }) => {
  if (gameId === "egg") {
    const s = seconds.toFixed(1);
    if (seconds <= 0.05) {
      lastRun.textContent = "";
      return;
    }
    lastRun.textContent = `The Egg — last run: ${s}s on the clock (Ctrl+Shift+Q stops early).`;
    return;
  }
  if (gameId === "goblin") {
    const n = typeof dropped === "number" ? dropped : 0;
    if (n <= 0) {
      lastRun.textContent = "The Goblin — he didn't get a chance to drop anything.";
    } else if (n === 1) {
      lastRun.textContent = "The Goblin — he left 1 .txt file on your Desktop.";
    } else {
      lastRun.textContent = `The Goblin — he left ${n} .txt files on your Desktop.`;
    }
    return;
  }
  const s = seconds.toFixed(1);
  if (seconds <= 0.05) {
    lastRun.textContent = "";
    return;
  }
  if (gameId === "snail") {
    lastRun.textContent = `The Snail — last run: you survived ${s}s.`;
    return;
  }
  lastRun.textContent = `Last run: ${s}s.`;
});
