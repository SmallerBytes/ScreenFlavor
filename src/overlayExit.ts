/** Fixed bottom-right × — must match hit zone in `electron/main.cjs` cursor poll. */
export function wireOverlayExit(onExit: () => void) {
  document.querySelector<HTMLButtonElement>("#overlay-exit")?.addEventListener("click", () => {
    onExit();
  });
}
