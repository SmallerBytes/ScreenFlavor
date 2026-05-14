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
          A snail appears on your screen and slowly homes in on your cursor. If it touches you, you lose.
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
          A goblin dashes in from the edge of your desktop, nudges a real shortcut to a new spot (Windows), then
          dares you to click him. Spank him and he plummets off-screen.
        </p>
        <button type="button" class="btn-play" id="goblin-start">Play</button>
      </article>
    </section>

    <p class="hint">
      While <strong>The Snail</strong> runs, your mouse still reaches apps underneath.
      <strong>The Goblin</strong> only captures clicks on the goblin so you can swat him; desktop icon shuffle is
      Windows-only.
      Press <strong>Ctrl+Shift+Q</strong> (Mac: <strong>Cmd+Shift+Q</strong>) anytime to stop.
    </p>

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

if (
  !lastRun ||
  !btnQuit ||
  !snailPlay ||
  !goblinStart ||
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

btnQuit.addEventListener("click", async () => {
  await window.screenFlavor.quitApp();
});

window.screenFlavor.onLastRun(({ seconds, gameId }) => {
  const s = seconds.toFixed(1);
  if (seconds <= 0.05) {
    lastRun.textContent = "";
    return;
  }
  if (gameId === "snail") {
    lastRun.textContent = `The Snail — last run: you survived ${s}s.`;
    return;
  }
  if (gameId === "goblin") {
    if (seconds < 0) {
      lastRun.textContent = `The Goblin — he got away after ${(-seconds).toFixed(1)}s. Try again!`;
    } else {
      lastRun.textContent = `The Goblin — spanked in ${s}s!`;
    }
    return;
  }
  lastRun.textContent = `Last run: ${s}s.`;
});
