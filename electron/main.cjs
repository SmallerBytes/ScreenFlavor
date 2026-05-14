const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
} = require("electron");
const path = require("node:path");

const appIcon = path.join(__dirname, "icon.png");

/** @type {BrowserWindow | null} */
let launcher = null;
/** @type {BrowserWindow | null} */
let overlay = null;
/** @type {NodeJS.Timeout | null} */
let cursorTimer = null;
/** @type {string | null} */
let activeGameId = null;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

function devUrl(page) {
  const base = process.env.VITE_DEV_SERVER_URL.replace(/\/$/, "");
  return `${base}${page}`;
}

function distFile(file) {
  return path.join(__dirname, "..", "dist", file);
}

function unionDisplayBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function stopCursorPoll() {
  if (cursorTimer) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
}

function registerGameShortcuts() {
  globalShortcut.register("CommandOrControl+Shift+Q", () => {
    endGameFromShortcut();
  });
}

function unregisterGameShortcuts() {
  globalShortcut.unregister("CommandOrControl+Shift+Q");
}

function endGameFromShortcut() {
  stopCursorPoll();
  unregisterGameShortcuts();
  activeGameId = null;
  if (overlay) {
    overlay.close();
    overlay = null;
  }
  if (launcher && !launcher.isDestroyed()) {
    launcher.show();
  }
}

function createLauncher() {
  launcher = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: false,
    maximizable: false,
    title: "ScreenFlavor",
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    launcher.loadURL(devUrl("/index.html"));
  } else {
    launcher.loadFile(distFile("index.html"));
  }
}

/** @param {string} gameId */
function overlayEntryForGame(gameId) {
  if (gameId === "snail") return { html: "overlay.html", pollCursor: true };
  return null;
}

/** @param {string} gameId */
function createOverlay(gameId) {
  const entry = overlayEntryForGame(gameId);
  if (!entry) return;

  activeGameId = gameId;
  const bounds = unionDisplayBounds();
  overlay = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    fullscreen: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  if (isDev) {
    overlay.loadURL(devUrl(`/${entry.html}`));
  } else {
    overlay.loadFile(distFile(entry.html));
  }

  overlay.once("ready-to-show", () => {
    overlay.show();
    overlay.setIgnoreMouseEvents(true, { forward: true });
  });

  overlay.on("closed", () => {
    overlay = null;
    stopCursorPoll();
    unregisterGameShortcuts();
    activeGameId = null;
    if (launcher && !launcher.isDestroyed()) {
      launcher.show();
    }
  });

  if (entry.pollCursor) {
    const tickMs = 1000 / 60;
    overlay.webContents.once("did-finish-load", () => {
      if (!overlay || overlay.isDestroyed()) return;
      cursorTimer = setInterval(() => {
        if (!overlay || overlay.isDestroyed()) return;
        const pt = screen.getCursorScreenPoint();
        const rel = { x: pt.x - bounds.x, y: pt.y - bounds.y };
        overlay.webContents.send("cursor", rel);
      }, tickMs);
    });
  }

  registerGameShortcuts();
}

ipcMain.handle("game:start", (_e, gameId) => {
  if (typeof gameId !== "string" || !overlayEntryForGame(gameId)) {
    return false;
  }
  if (overlay && !overlay.isDestroyed()) {
    return false;
  }
  if (launcher && !launcher.isDestroyed()) {
    launcher.hide();
  }
  createOverlay(gameId);
  return true;
});

ipcMain.handle("game:over", (_e, seconds) => {
  const gameId = activeGameId;
  stopCursorPoll();
  unregisterGameShortcuts();
  activeGameId = null;
  if (overlay && !overlay.isDestroyed()) {
    overlay.close();
  }
  if (launcher && !launcher.isDestroyed()) {
    launcher.show();
    launcher.webContents.send("last-run", { seconds, gameId });
  }
  return true;
});

ipcMain.handle("app:quit", () => {
  app.quit();
});

app.whenReady().then(() => {
  createLauncher();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopCursorPoll();
  globalShortcut.unregisterAll();
});
