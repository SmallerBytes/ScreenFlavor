const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenFlavor", {
  startGame: (gameId, snailSettings) =>
    ipcRenderer.invoke("game:start", gameId, snailSettings),
  dropGoblinTxtFile: () => ipcRenderer.invoke("goblin:dropTxtFile"),
  getOverlayBounds: () => ipcRenderer.invoke("overlay:getBounds"),
  getSnailLaunchSettings: () => ipcRenderer.invoke("snail:getLaunchSettings"),
  quitApp: () => ipcRenderer.invoke("app:quit"),
  getAppVersion: () => ipcRenderer.invoke("app:getVersion"),
  onCursor: (handler) => {
    const wrapped = (_e, pos) => handler(pos);
    ipcRenderer.on("cursor", wrapped);
    return () => ipcRenderer.removeListener("cursor", wrapped);
  },
  onLastRun: (handler) => {
    const wrapped = (_e, payload) => handler(payload);
    ipcRenderer.on("last-run", wrapped);
    return () => ipcRenderer.removeListener("last-run", wrapped);
  },
  notifyGameOver: (seconds) => ipcRenderer.invoke("game:over", seconds),
});
