const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updateProgress", {
  onProgress: (handler) => {
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on("update-download-progress", wrapped);
    return () => ipcRenderer.removeListener("update-download-progress", wrapped);
  },
  cancelDownload: () => ipcRenderer.send("update-download-cancel"),
  closeWindow: () => ipcRenderer.send("update-progress-close"),
});
