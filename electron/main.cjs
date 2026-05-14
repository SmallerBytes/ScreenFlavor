const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  globalShortcut,
  shell,
  Menu,
  dialog,
} = require("electron");
const path = require("node:path");
const { spawn } = require("node:child_process");
const pkg = require(path.join(__dirname, "..", "package.json"));
const {
  resolveRepoSlug,
  checkGitHubLatestRelease,
} = require("./updateCheck.cjs");
const { downloadReleaseInstaller } = require("./downloadUpdate.cjs");

const appIcon = path.join(__dirname, "icon.png");
const releaseProductName =
  (pkg.build && typeof pkg.build.productName === "string" && pkg.build.productName) ||
  pkg.name ||
  "ScreenFlavor";

/** @type {BrowserWindow | null} */
let launcher = null;
/** @type {BrowserWindow | null} */
let overlay = null;
/** @type {NodeJS.Timeout | null} */
let cursorTimer = null;
/** @type {string | null} */
let activeGameId = null;

/**
 * @typedef {{ sizePercent: number; speedPercent: number }} SnailLaunchSettings
 */

/** @type {SnailLaunchSettings | null} */
let pendingSnailSettings = null;

/** @param {unknown} raw @returns {SnailLaunchSettings} */
function normalizeSnailLaunchSettings(raw) {
  const fallback = { sizePercent: 100, speedPercent: 100 };
  if (!raw || typeof raw !== "object") return fallback;
  const o = /** @type {Record<string, unknown>} */ (raw);

  let sizePercent = Number(o.sizePercent);
  if (!Number.isFinite(sizePercent)) sizePercent = fallback.sizePercent;
  sizePercent = Math.min(160, Math.max(50, Math.round(sizePercent)));

  let speedPercent = Number(o.speedPercent);
  if (!Number.isFinite(speedPercent)) speedPercent = fallback.speedPercent;
  speedPercent = Math.min(220, Math.max(25, Math.round(speedPercent)));

  return { sizePercent, speedPercent };
}

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

/** @type {BrowserWindow | null} */
let updateProgressWindow = null;
/** @type {null | (() => void)} */
let cancelActiveDownload = null;

function menuParentWindow() {
  const w = BrowserWindow.getFocusedWindow();
  if (w && !w.isDestroyed()) return w;
  if (launcher && !launcher.isDestroyed()) return launcher;
  return undefined;
}

function sendUpdateDownloadProgress(/** @type {Record<string, unknown>} */ payload) {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.webContents.send("update-download-progress", payload);
  }
}

async function waitForProgressWindowLoad() {
  if (!updateProgressWindow || updateProgressWindow.isDestroyed()) return;
  await new Promise((resolve) => {
    if (!updateProgressWindow.webContents.isLoading()) {
      resolve(null);
      return;
    }
    updateProgressWindow.webContents.once("did-finish-load", resolve);
  });
}

function openUpdateProgressWindow(/** @type {BrowserWindow | undefined} */ parent) {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.removeAllListeners("closed");
    updateProgressWindow.close();
  }
  updateProgressWindow = new BrowserWindow({
    width: 440,
    height: 200,
    parent: parent ?? undefined,
    modal: Boolean(parent),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Downloading update",
    icon: appIcon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "update-progress-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  updateProgressWindow.on("closed", () => {
    updateProgressWindow = null;
    if (cancelActiveDownload) {
      const fn = cancelActiveDownload;
      cancelActiveDownload = null;
      fn();
    }
  });

  updateProgressWindow.loadFile(path.join(__dirname, "update-progress.html"));
  updateProgressWindow.once("ready-to-show", () => {
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
      updateProgressWindow.show();
    }
  });
}

function formatMb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Windows NSIS: run setup silently, then quit this app so files can be replaced.
 * @param {string} setupExePath
 * @param {(o: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>} box
 */
function quitAndRunSilentNsisInstaller(setupExePath, box) {
  const child = spawn(setupExePath, ["/S"], {
    detached: true,
    stdio: "ignore",
  });

  child.once("error", async (err) => {
    await box({
      type: "error",
      title: "Update",
      message: "Could not start the installer.",
      detail: err instanceof Error ? err.message : String(err),
    });
  });

  child.once("spawn", () => {
    child.unref();
    setImmediate(() => app.quit());
  });
}

/**
 * @param {{ url: string; name: string; size: number }} installer
 * @param {BrowserWindow | undefined} parent
 */
async function runInstallerDownloadWithProgress(installer, parent) {
  const safeName =
    installer.name.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").trim() || "ScreenFlavor-update-setup.exe";
  const destPath = path.join(app.getPath("temp"), safeName);

  const box = (/** @type {Electron.MessageBoxOptions} */ o) =>
    parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o);

  openUpdateProgressWindow(parent);
  await waitForProgressWindowLoad();

  const ac = new AbortController();
  cancelActiveDownload = () => {
    ac.abort();
  };

  sendUpdateDownloadProgress({
    percent: 0,
    detailText: "Connecting…",
    indeterminate: installer.size <= 0,
  });

  try {
    await downloadReleaseInstaller(installer.url, destPath, {
      signal: ac.signal,
      expectedSize: installer.size,
      onProgress: ({ received, total }) => {
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
        const detailText =
          total > 0
            ? `${formatMb(received)} / ${formatMb(total)} MB`
            : `${formatMb(received)} MB downloaded`;
        sendUpdateDownloadProgress({
          percent: pct,
          detailText,
          indeterminate: total <= 0 && received > 0,
        });
      },
    });

    cancelActiveDownload = null;
    if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
      updateProgressWindow.removeAllListeners("closed");
      updateProgressWindow.close();
    }
    updateProgressWindow = null;

    const isWinNsis = process.platform === "win32" && destPath.toLowerCase().endsWith(".exe");

    if (isWinNsis) {
      const { response } = await box({
        type: "info",
        title: "Update ready",
        message: "Install this update now? ScreenFlavor will close, then setup will run silently.",
        detail:
          "When installation finishes, open ScreenFlavor again from the Start menu. If Windows asks for permission, allow the installer to run.",
        buttons: ["Install and exit", "Open folder", "Later"],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 0) {
        quitAndRunSilentNsisInstaller(destPath, box);
      } else if (response === 1) {
        shell.showItemInFolder(destPath);
      }
    } else {
      const { response } = await box({
        type: "info",
        title: "Download complete",
        message: "The installer finished downloading.",
        detail: destPath,
        buttons: ["Open", "Show in folder", "Close"],
        defaultId: 0,
      });
      if (response === 0) {
        const err = await shell.openPath(destPath);
        if (err) {
          await box({
            type: "warning",
            message: "Could not open the file automatically.",
            detail: err,
          });
        }
      } else if (response === 1) {
        shell.showItemInFolder(destPath);
      }
    }
  } catch (e) {
    const err = /** @type {{ name?: string; message?: unknown }} */ (e);
    const aborted =
      err?.name === "AbortError" ||
      String(err?.message ?? "").toLowerCase().includes("abort");
    cancelActiveDownload = null;

    if (aborted) {
      sendUpdateDownloadProgress({
        error: "Download canceled.",
      });
      return;
    }

    sendUpdateDownloadProgress({
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

async function runCheckForUpdatesFromMenu() {
  const parent = menuParentWindow();
  const box = (/** @type {Electron.MessageBoxOptions} */ o) =>
    parent ? dialog.showMessageBox(parent, o) : dialog.showMessageBox(o);

  const repo = resolveRepoSlug(pkg);
  if (!repo) {
    await box({
      type: "warning",
      title: "Check for updates",
      message: "Update source is not configured.",
      detail:
        "Add a GitHub repository URL under \"repository\" in package.json, or set the environment variable SCREENFLAVOR_UPDATE_REPO to owner/repo.",
    });
    return;
  }

  const currentVersion = app.getVersion();
  let result;
  try {
    result = await checkGitHubLatestRelease(repo, currentVersion, releaseProductName);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    await box({
      type: "error",
      title: "Check for updates",
      message: "Could not reach GitHub.",
      detail,
    });
    return;
  }

  if (!result.ok) {
    const detail =
      result.error === "github_api" && result.status === 403
        ? "GitHub rate limit or access denied. Try again later."
        : result.message || `HTTP ${result.status ?? ""}`.trim();
    await box({
      type: "error",
      title: "Check for updates",
      message: "GitHub returned an error.",
      detail: detail || "Unknown error.",
    });
    return;
  }

  if (result.updateAvailable && result.latestVersion && result.releaseUrl) {
    const verLabel = result.latestVersion.startsWith("v")
      ? result.latestVersion
      : `v${result.latestVersion}`;
    const hasInstaller = Boolean(result.installer?.url);

    const { response } = await box({
      type: "info",
      title: "Update available",
      message: `A newer release is available (${verLabel}).`,
      detail: hasInstaller
        ? `You are running v${currentVersion}. Download the installer here, or open the release page in your browser.`
        : `You are running v${currentVersion}. No installer file for this system was found on the release. Open the release page to download manually.`,
      buttons: hasInstaller
        ? ["Download update", "Open release page", "Close"]
        : ["Open release page", "Close"],
      defaultId: 0,
      cancelId: hasInstaller ? 2 : 1,
    });

    if (hasInstaller && response === 0 && result.installer) {
      await runInstallerDownloadWithProgress(result.installer, parent);
      return;
    }
    const openPage = hasInstaller ? response === 1 : response === 0;
    if (openPage && result.releaseUrl) {
      try {
        await shell.openExternal(result.releaseUrl);
      } catch {
        await box({
          type: "error",
          title: "Check for updates",
          message: "Could not open the release page.",
        });
      }
    }
    return;
  }

  if (result.note === "no_releases") {
    await box({
      type: "info",
      title: "Check for updates",
      message: "No GitHub releases have been published yet.",
    });
    return;
  }

  await box({
    type: "info",
    title: "Check for updates",
    message: "You are on the latest release.",
    detail: `ScreenFlavor v${currentVersion}`,
  });
}

function installAppMenu() {
  const isMac = process.platform === "darwin";

  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = isMac
    ? [
        {
          label: app.name,
          submenu: [
            { role: "about" },
            { type: "separator" },
            { role: "quit" },
          ],
        },
        {
          label: "File",
          submenu: [{ role: "close" }],
        },
        {
          role: "help",
          submenu: [
            {
              label: "Check for Updates…",
              click: () => void runCheckForUpdatesFromMenu(),
            },
          ],
        },
      ]
    : [
        {
          label: "File",
          submenu: [{ role: "quit", label: "Exit" }],
        },
        {
          role: "help",
          submenu: [
            {
              label: "Check for Updates…",
              click: () => void runCheckForUpdatesFromMenu(),
            },
          ],
        },
      ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createLauncher() {
  launcher = new BrowserWindow({
    width: 480,
    height: 780,
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

ipcMain.handle("snail:getLaunchSettings", () => {
  const raw = pendingSnailSettings;
  pendingSnailSettings = null;
  return normalizeSnailLaunchSettings(raw);
});

ipcMain.handle("game:start", (_e, gameId, snailSettings) => {
  if (typeof gameId !== "string" || !overlayEntryForGame(gameId)) {
    return false;
  }
  if (overlay && !overlay.isDestroyed()) {
    return false;
  }
  if (gameId === "snail") {
    pendingSnailSettings = normalizeSnailLaunchSettings(snailSettings);
  } else {
    pendingSnailSettings = null;
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

ipcMain.handle("app:getVersion", () => app.getVersion());

ipcMain.handle("updates:check", async () => {
  const repo = resolveRepoSlug(pkg);
  if (!repo) {
    return { ok: false, error: "not_configured" };
  }
  const currentVersion = app.getVersion();
  try {
    return await checkGitHubLatestRelease(repo, currentVersion, releaseProductName);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: "network", message };
  }
});

ipcMain.handle("app:openExternal", async (_e, url) => {
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) {
    return false;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.on("update-download-cancel", () => {
  if (cancelActiveDownload) {
    cancelActiveDownload();
  }
});

ipcMain.on("update-progress-close", () => {
  if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
    updateProgressWindow.removeAllListeners("closed");
    updateProgressWindow.close();
  }
  updateProgressWindow = null;
});

app.whenReady().then(() => {
  installAppMenu();
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
