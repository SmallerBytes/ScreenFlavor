import "./style.css";

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
        <button type="button" class="btn-play game-start">Play</button>
      </article>

      <article class="game-card game-card--soon" aria-disabled="true">
        <div class="game-icon" aria-hidden="true">✨</div>
        <h2>More flavors</h2>
        <p class="game-blurb">Additional screen games will land here over time.</p>
        <button type="button" class="btn-soon" disabled>Coming soon</button>
      </article>
    </section>

    <p class="hint">
      While a game runs, your mouse still reaches apps underneath.
      Press <strong>Ctrl+Shift+Q</strong> (Mac: <strong>Cmd+Shift+Q</strong>) anytime to stop.
    </p>

    <div class="last-run" id="last-run" aria-live="polite"></div>

    <div class="hub-footer">
      <button type="button" class="btn-quit" id="btn-quit">Quit ScreenFlavor</button>
    </div>
  </div>
`;

const lastRun = document.querySelector<HTMLDivElement>("#last-run");
const btnQuit = document.querySelector<HTMLButtonElement>("#btn-quit");
const snailCard = document.querySelector<HTMLElement>('[data-game="snail"]');
const snailPlay = snailCard?.querySelector<HTMLButtonElement>(".game-start");

if (!lastRun || !btnQuit || !snailPlay) {
  throw new Error("Launcher DOM missing");
}

snailPlay.addEventListener("click", async () => {
  await window.screenFlavor.startGame("snail");
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
  lastRun.textContent = `Last run: ${s}s.`;
});
