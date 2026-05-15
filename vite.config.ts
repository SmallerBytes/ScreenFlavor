import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: ".",
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5188,
    strictPort: true,
    watch: {
      ignored: ["**/release/**", "**/node_modules/**"],
      awaitWriteFinish: {
        stabilityThreshold: 250,
        pollInterval: 50,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        overlay: resolve(__dirname, "overlay.html"),
        goblinOverlay: resolve(__dirname, "goblin-overlay.html"),
        eggOverlay: resolve(__dirname, "egg-overlay.html"),
      },
    },
  },
});
