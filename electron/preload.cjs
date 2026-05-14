const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("screenFlavor", {
  startGame: (gameId) => ipcRenderer.invoke("game:start", gameId),
  quitApp: () => ipcRenderer.invoke("app:quit"),
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
