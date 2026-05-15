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
const fs = require("node:fs");
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

/** Tracks how many goblin txt files have been written this run (for unique names). */
let goblinDroppedThisRun = 0;

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
  const gameId = activeGameId;
  const dropped = goblinDroppedThisRun;
  stopCursorPoll();
  unregisterGameShortcuts();
  activeGameId = null;
  if (overlay) {
    overlay.close();
    overlay = null;
  }
  if (launcher && !launcher.isDestroyed()) {
    launcher.show();
    launcher.webContents.send("last-run", { seconds: 0, gameId, dropped });
  }
  if (gameId === "goblin") {
    goblinDroppedThisRun = 0;
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
 * NSIS installers from electron-builder accept /currentuser and /allusers; matching
 * the running install scope makes silent upgrades reliable.
 * @returns {string[]}
 */
function nsisSilentInstallArgs() {
  const exe = process.execPath.replace(/\//g, "\\").toLowerCase();
  if (exe.includes("\\appdata\\local\\programs\\")) {
    return ["/S", "/currentuser"];
  }
  if (exe.includes("\\program files\\")) {
    return ["/S", "/allusers"];
  }
  return ["/S"];
}

/**
 * Windows NSIS: run setup silently, then quit this app so files can be replaced.
 * @param {string} setupExePath
 * @param {(o: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>} box
 */
function quitAndRunSilentNsisInstaller(setupExePath, box) {
  const child = spawn(setupExePath, nsisSilentInstallArgs(), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    cwd: path.dirname(setupExePath),
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

    const isWinNsis = process.platform === "win32" && destPath.toLowerCase().endsWith(".exe");

    if (isWinNsis) {
      sendUpdateDownloadProgress({
        percent: 100,
        detailText: "Installing update… ScreenFlavor will close.",
        indeterminate: true,
        applying: true,
      });
      await new Promise((r) => setTimeout(r, 450));
      if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
        updateProgressWindow.removeAllListeners("closed");
        updateProgressWindow.close();
      }
      updateProgressWindow = null;
      quitAndRunSilentNsisInstaller(destPath, box);
    } else {
      if (updateProgressWindow && !updateProgressWindow.isDestroyed()) {
        updateProgressWindow.removeAllListeners("closed");
        updateProgressWindow.close();
      }
      updateProgressWindow = null;
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
        ? `You are running v${currentVersion}. “Download update” downloads and installs in the background, then ScreenFlavor closes. You may see a brief Windows security prompt. When it finishes, open ScreenFlavor again from the Start menu.`
        : `You are running v${currentVersion}. The latest release has no Windows installer file yet (or it is still uploading). Wait for the GitHub Actions “Release artifacts” job to finish, then try again—or open the release page to download manually.`,
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

function showCopyrightFromMenu() {
  const parent = menuParentWindow();
  const opts = {
    type: "info",
    title: "ScreenFlavor",
    message: `Copyright © ${new Date().getFullYear()} Michael Hernandez.`,
    detail:
      "ScreenFlavor was created by Michael Hernandez.\n\nAll rights reserved.",
    buttons: ["OK"],
  };
  if (parent && !parent.isDestroyed()) {
    void dialog.showMessageBox(parent, opts);
  } else {
    void dialog.showMessageBox(opts);
  }
}

function installAppMenu() {
  const isMac = process.platform === "darwin";

  const fileCopyrightSubmenu = /** @type {Electron.MenuItemConstructorOptions[]} */ ([
    {
      label: "Copyright…",
      click: () => showCopyrightFromMenu(),
    },
    { type: "separator" },
  ]);

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
          submenu: [...fileCopyrightSubmenu, { role: "close" }],
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
          submenu: [...fileCopyrightSubmenu, { role: "quit", label: "Exit" }],
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
    height: 880,
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
  if (gameId === "goblin") return { html: "goblin-overlay.html", pollCursor: true };
  if (gameId === "egg") return { html: "egg-overlay.html", pollCursor: true };
  return null;
}

/** @param {string} gameId */
function createOverlay(gameId) {
  const entry = overlayEntryForGame(gameId);
  if (!entry) return;

  activeGameId = gameId;
  if (gameId === "goblin") {
    goblinDroppedThisRun = 0;
  }
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
    // Windows: transparent + resizable default true can draw a real title bar
    // that blocks other apps' caption buttons; this overlay is never resized.
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    thickFrame: false,
    title: "",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.platform === "win32") {
    overlay.removeMenu();
  }

  // Normal Z-order for Goblin & Egg; The Snail stays above other windows so you always see it.
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (gameId === "snail") {
    overlay.setAlwaysOnTop(true, "screen-saver");
  }

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
        const b = overlay.getBounds();
        const rel = { x: pt.x - b.x, y: pt.y - b.y };
        overlay.webContents.send("cursor", rel);
        // Must match `.overlay-exit` in `src/style.css` (bottom/right/size) so the × is clickable while the rest stays click-through.
        const exBottomPad = 8;
        const exRightPad = 10;
        const exW = 40;
        const exH = 36;
        const inExit =
          b.width > 80 &&
          b.height > 80 &&
          rel.x >= b.width - exRightPad - exW &&
          rel.x < b.width &&
          rel.y >= b.height - exBottomPad - exH &&
          rel.y < b.height;
        overlay.setIgnoreMouseEvents(!inExit, { forward: true });
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

ipcMain.handle("overlay:getBounds", () => {
  if (!overlay || overlay.isDestroyed()) return null;
  const b = overlay.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
});

/**
 * Each note is a paired filename + body text (one line or a short poem).
 * The filename ends in .txt and is collision-suffixed (_2, _3, …) on disk if needed.
 * @type {Array<{ name: string; line: string }>}
 */
const GOBLIN_NOTES = [
  { name: "youll_never_catch_me.txt",          line: "You'll never catch me." },
  { name: "i_licked_all_your_shortcuts.txt",   line: "I licked all your shortcuts." },
  { name: "your_desktop_is_mine_now.txt",      line: "Your desktop is mine now." },
  { name: "ill_be_back_with_friends.txt",      line: "I'll be back. With friends." },
  { name: "goblin_law.txt",                    line: "These files are protected by goblin law." },
  { name: "dont_read_this.txt",                line: "Don't read this. Too late." },
  { name: "smelled_like_wifi.txt",             line: "Smelled like wifi. Took it." },
  { name: "tell_no_one.txt",                   line: "Tell no one." },
  { name: "the_deal.txt",                      line: "Touch this file and the deal is off." },
  { name: "you_wont_find_them_all.txt",        line: "I left more. You won't find them all." },
  { name: "goblin_loves_you.txt",              line: "Goblin loves you. (Goblin lies.)" },
  { name: "hiding_in_downloads.txt",           line: "I am hiding in your downloads folder." },
  { name: "catch_me_if_you_can.txt",           line: "Catch me if you can. (You can't.)" },
  { name: "snitches_get_more_files.txt",       line: "Snitches get more files." },
  { name: "bookmarks_for_rocks.txt",           line: "I traded your bookmarks for shiny rocks." },
  { name: "mine_all_mine.txt",                 line: "Mine. All mine." },
  { name: "sneezed_on_keyboard.txt",           line: "I sneezed on your keyboard. You're welcome." },
  { name: "wifi_tastes_weird.txt",             line: "The wifi tastes weird tonight." },
  { name: "goblin_business.txt",               line: "I have very important goblin business to attend to." },
  { name: "do_not_feed_the_goblin.txt",        line: "Do not feed the goblin. (Feed the goblin.)" },
  { name: "your_emails_were_boring.txt",       line: "I read your emails. They were boring." },
  { name: "moved_your_sock_drawer.txt",        line: "I moved your sock drawer. Good luck." },
  { name: "no_refunds.txt",                    line: "Goblin guarantee: zero refunds." },
  { name: "goblin_tax.txt",                    line: "This file pays the goblin tax." },
  { name: "printer_learned_a_word.txt",        line: "I taught your printer a new word." },
  { name: "bookmarks_by_smell.txt",            line: "I rearranged your bookmarks alphabetically. By smell." },
  { name: "still_here.txt",                    line: "Goblin was here. Goblin is also still here." },
  { name: "hide_your_snacks.txt",              line: "Hide your snacks." },
  { name: "one_with_the_desktop.txt",          line: "I am one with the desktop. The desktop is one with me." },
  { name: "shortcuts_taste_better_warm.txt",   line: "These shortcuts taste better warm." },
  { name: "you_voted_goblin.txt",              line: "I voted in your name. You voted Goblin." },
  { name: "knock_knock.txt",                   line: "Knock knock. Goblin." },
  { name: "borrowed_cursor.txt",               line: "I borrowed your cursor. Returning it eventually." },
  { name: "small_note.txt",                    line: "I left a small note. (This one.)" },
  { name: "goblin_council.txt",                line: "Approved by the Goblin Council. I am the Goblin Council." },
  { name: "new_wifi_password.txt",             line: "Your wifi password is now goblin1." },
  { name: "downloads_renamed.txt",             line: "I named your downloads folder 'mine'." },
  { name: "off_and_on_again.txt",              line: "Have you tried turning the goblin off and on again?" },
  { name: "goblin_protocol.txt",               line: "Goblin protocol activated." },
  { name: "overheard_phone_call.txt",          line: "Goblin overheard your phone call." },
  { name: "calendar_forever.txt",              line: "I added myself to your calendar. Forever." },
  { name: "favorites_belong_to_me.txt",        line: "All your favorites are belong to me." },
  { name: "crack_for_a_snack.txt",             line: "Step on a crack, goblin gets a snack." },
  { name: "drew_on_pixels.txt",                line: "I drew on your pixels." },
  { name: "taste_tested_shortcuts.txt",        line: "I taste-tested every shortcut. Some were stale." },
  { name: "you_are_lost_now.txt",              line: "Lost? You are now. — Goblin" },
  { name: "tribute_required.txt",              line: "Goblin demands tribute. Tribute is more files." },
  { name: "unsubscribed_from_boring.txt",      line: "I unsubscribed you from everything boring." },
  { name: "noise_at_3am.txt",                  line: "I am the noise in your speakers at 3am." },
  { name: "dont_give_goblin_tickets.txt",      line: "Goblin tip: never let the goblin hold your tickets." },
  { name: "friends_with_the_trash.txt",        line: "I'm friends with your trash can." },
  { name: "snack_tax.txt",                     line: "Snack tax: one cookie per file." },
  { name: "something_in_downloads.txt",        line: "I tucked something into your downloads." },
  { name: "goblin_endorsed.txt",               line: "Goblin endorsed. Whatever this is." },
  { name: "verbal_contract.txt",               line: "Reading this is a verbal contract." },
  { name: "footprints.txt",                    line: "I left footprints. They are also goblin." },
  { name: "monitor_blink.txt",                 line: "Your monitor blinks. That was me." },
  { name: "trademarked_username.txt",          line: "I trademarked your username." },
  { name: "wallpaper_feelings.txt",            line: "I have feelings about your wallpaper." },
  { name: "file_audit.txt",                    line: "Goblin counted your files. Some are missing." },
  { name: "fonts_by_emotion.txt",              line: "I sorted your fonts by emotion." },
  { name: "recycle_bin_visit.txt",             line: "I went through your recycle bin." },
  { name: "taskbar_review.txt",                line: "I rate your taskbar 7/10. Goblin grading." },
  { name: "in_your_fridge.txt",                line: "I'm in your fridge. (Spiritually.)" },
  { name: "free_advice.txt",                   line: "Free advice: do not hire the goblin." },
  { name: "goblin_parked_in_start_menu.txt",   line: "I parked my goblin in your start menu." },
  { name: "signature_on_file.txt",             line: "Goblin signature on file." },
  { name: "goblin_haiku.txt",                  line: "I wrote you a goblin haiku. It's mean." },
  { name: "goblin_lounge.txt",                 line: "Your Wi-Fi name is now Goblin Lounge." },
  { name: "cursor_haircut.txt",                line: "I gave your cursor a new haircut." },
  { name: "terms_and_conditions.txt",          line: "Goblin terms and conditions apply." },
  { name: "in_the_printer_queue.txt",          line: "I am inside your printer queue." },
  { name: "goblin_owes_nothing.txt",           line: "Goblin owes you nothing." },
  { name: "goblin_labels.txt",                 line: "I labeled your folders in goblin." },
  { name: "mute_is_for_cowards.txt",           line: "Mute is for cowards. — The Goblin" },
  { name: "goblin_oclock.txt",                 line: "I set all your alarms to goblin o'clock." },
  { name: "my_judgement.txt",                  line: "Free with this file: my judgement." },
  { name: "mouse_taught_to_lie.txt",           line: "I taught your mouse to lie." },
  { name: "endorse_chaos.txt",                 line: "Goblin endorses chaos." },
  { name: "battery_full_of_goblin.txt",        line: "Your battery is at 100% goblin." },
  { name: "ringtone_audition.txt",             line: "I auditioned to be your ringtone." },
  { name: "all_keyboards_are_goblin.txt",      line: "All keyboards are goblin keyboards." },
  { name: "drink_water.txt",                   line: "Goblin reminds you to drink water." },
  { name: "firewall_hole.txt",                 line: "I gnawed a hole in your firewall." },
  { name: "cursors_name_is_steve.txt",         line: "I named the cursor Steve. He's mine now." },
  { name: "notification_goblin.txt",           line: "Notification: goblin." },
  { name: "goblin_newsletter.txt",             line: "I subscribed you to the Goblin Newsletter." },
  { name: "opened_all_tabs.txt",               line: "Goblin opened your tabs. All of them." },
  { name: "your_fortune.txt",                  line: "I wrote your fortune. It's goblin." },
  { name: "a_single_sock.txt",                 line: "I left a single sock. You're welcome." },
  { name: "not_a_robot.txt",                   line: "Goblin verifies you are not a robot. (You're a robot.)" },
  { name: "painted_screensaver.txt",           line: "I painted your screensaver. With my paws." },
  { name: "in_your_dock.txt",                  line: "I am in your dock. Wave hi." },
  { name: "long_weird_life.txt",               line: "Goblin wishes you a long and weird life." },
  { name: "for_legal_reasons.txt",             line: "I left this for legal reasons." },
  { name: "no_eula_mentions_me.txt",           line: "I read every EULA. None of them mention me." },
  { name: "desk_review.txt",                   line: "Goblin's review of your desk: cluttered, but fixable with a goblin." },
  { name: "locked_door.txt",                   line: "Don't worry. I locked the door behind me." },
  { name: "reason_battery_dies.txt",           line: "I am the reason your battery dies." },
  { name: "file_your_taxes.txt",               line: "Goblin says: file your taxes. (Goblin will not.)" },
  { name: "i_was_here_again.txt",              line: "I was here again. And again." },
  { name: "snack_negotiation.txt",             line: "Open negotiations: one snack and I leave. (I lie.)" },

  // Short poems (multiline) — same pool as one-liners; file body shows art + verse.
  {
    name: "goblin_sonnet_sort_of.txt",
    line: `Shall I compare thee to a cluttered desk?
Thou art more messy and more full of crumbs.
Rough paws did shake thy keyboard, I confess,
And in thy taskbar, goblin softly hums.`,
  },
  {
    name: "the_cursor_that_ran.txt",
    line: `The cursor ran, the cursor flew,
It thought it knew the screen —
It did not know the goblin crew
Who paint what can't be seen.`,
  },
  {
    name: "wifi_at_midnight.txt",
    line: `At midnight when the router blinks
And every tab forgets to breathe,
A goblin sits on logic's brink
And alphabetizes teeth.`,
  },
  {
    name: "limerick_of_the_shortcut.txt",
    line: `There once was a shortcut so proud
It shouted its name to the crowd —
The goblin ate "Enter,"
Now nothing remembers
What program it pointed to. (Loud.)`,
  },
  {
    name: "haiku_folder.txt",
    line: `Empty folder, hush —
Goblin fills it with a thought
You delete. It stays.`,
  },
  {
    name: "ballad_of_the_desktop.txt",
    line: `They stacked the icons neat in rows,
They named each file with care —
The goblin came on tippy-toes
And breathed a different air.`,
  },
  {
    name: "couplet_tax.txt",
    line: `All files must pay the goblin tax in kind:
One secret, one snack, or peace of mind.`,
  },
  {
    name: "ode_to_the_recycle_bin.txt",
    line: `O bin of echoes, plastic throat,
You hold what users fear to see —
The goblin sorts your deleted note
And wears it like a jubilee.`,
  },
  {
    name: "quatrain_notifications.txt",
    line: `A ping, a pop, a subtle chime,
A number on a corner red —
The goblin sends them all the time
From thoughts inside your goblin head.`,
  },
  {
    name: "villanelle_snippet.txt",
    line: `We do not sleep beneath your keys,
We only rest between your words —
The goblin hums, the goblin sees,
The goblin herds the wild screen-birds.`,
  },
  {
    name: "free_verse_downloads.txt",
    line: `Downloads —
a river
you never finish drinking.

Goblin dips a toe.
The river tastes like "later"
and also like "maybe tomorrow."

Goblin approves.`,
  },
  {
    name: "triolet_printer.txt",
    line: `The printer wakes when no one’s near,
It whispers ink in goblin rhyme —
You’ll never prove the goblin’s here.
The printer wakes when no one’s near;
It prints a line you shouldn’t hear.
You’ll read it anyway. Next time,
The printer wakes when no one’s near,
It whispers ink in goblin rhyme.`,
  },
  {
    name: "cinquain_battery.txt",
    line: `Battery
draining soft, soft, soft —
goblin counts each percent
smiling`,
  },
  {
    name: "riddle_poem.txt",
    line: `I am not in your house, yet I leave tracks,
Not on the floor, but in your stacks.
What am I?

(The goblin. Obviously. Did you guess "the goblin"? Good.)`,
  },
];

const GOBLIN_ASCII = [
  `   ,___,
  ( o.o )
  /  V  \\     "%s"
 (_)   (_)`,
  `    /\\___/\\
   ( ^   ^ )
    >  o  <    "%s"
   /       \\
  (_(_____)_)`,
  `   .-""""-.
  /  o  o  \\
  |   __   |   "%s"
   \\______/`,
  `   _.._
  ( >.< )    "%s"
   \\_-_/`,
  `      .-.
     ( o o )
      | _ |     "%s"
   .='|   |'=.
   |__|___|__|`,
  `   /\\___/\\
  ( =^.^= )    "%s"
   )     (
  (__(_)__)`,
  `      ___
     {o,o}
     /)__)    "%s"
     -"-"-`,
  `    .--.
   |o_o |
   |:_/ |     "%s"
  //   \\ \\
 (|     | )`,
  `    ,
   /(  )\\
  ((    ))   "%s"
   \\(__)/
    || ||`,
  `   ___
  /   \\
 | o o |     "%s"
 |  v  |
  \\___/
  /| |\\`,
];

/** @param {string} line One line, or multiple lines for a poem. */
function buildGoblinFileBody(line) {
  const tmpl = GOBLIN_ASCII[Math.floor(Math.random() * GOBLIN_ASCII.length)];
  const multiline = line.includes("\n");
  const inArt = multiline ? "a goblin poem for you" : line;
  const art = tmpl.replace("%s", inArt);
  const stamp = new Date().toLocaleString();
  const parts = [
    "// Left on your desktop by The Goblin (ScreenFlavor)",
    `// ${stamp}`,
    "",
    art,
    "",
  ];
  if (multiline) {
    parts.push(line.trimEnd());
    parts.push("");
  }
  parts.push("      -- the goblin", "");
  return parts.join("\r\n");
}

/**
 * Pick a non-colliding file name based on the note's preferred name.
 * Adds _2, _3, … on collision so an existing copy is never overwritten.
 * @param {string} desktopDir
 * @param {string} baseName
 * @returns {string}
 */
function pickGoblinFileName(desktopDir, baseName) {
  goblinDroppedThisRun += 1;
  const fullCandidate = path.join(desktopDir, baseName);
  if (!fs.existsSync(fullCandidate)) return baseName;

  const dot = baseName.lastIndexOf(".");
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  for (let i = 2; i < 9999; i++) {
    const candidate = `${stem}_${i}${ext}`;
    if (!fs.existsSync(path.join(desktopDir, candidate))) return candidate;
  }
  // Last resort
  return `${stem}_${Date.now()}_${goblinDroppedThisRun}${ext}`;
}

ipcMain.handle("goblin:dropTxtFile", async () => {
  if (activeGameId !== "goblin") {
    return { ok: false, message: "not_active" };
  }
  let desktopDir;
  try {
    desktopDir = app.getPath("desktop");
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
  if (!desktopDir || !fs.existsSync(desktopDir)) {
    return { ok: false, message: "no_desktop_path" };
  }

  const note = GOBLIN_NOTES[Math.floor(Math.random() * GOBLIN_NOTES.length)];
  const body = buildGoblinFileBody(note.line);
  const name = pickGoblinFileName(desktopDir, note.name);
  const fullPath = path.join(desktopDir, name);

  try {
    await fs.promises.writeFile(fullPath, body, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    // If wx (exclusive) raced with another writer, fall back to a stamped name.
    try {
      const fallback = path.join(
        desktopDir,
        `${name.replace(/\.txt$/i, "")}_${Date.now()}.txt`,
      );
      await fs.promises.writeFile(fallback, body, { encoding: "utf8" });
      return { ok: true, path: fallback, name: path.basename(fallback) };
    } catch (err2) {
      return {
        ok: false,
        message: err2 instanceof Error ? err2.message : String(err2),
      };
    }
  }
  return { ok: true, path: fullPath, name };
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
  const dropped = goblinDroppedThisRun;
  stopCursorPoll();
  unregisterGameShortcuts();
  activeGameId = null;
  if (overlay && !overlay.isDestroyed()) {
    overlay.close();
  }
  if (launcher && !launcher.isDestroyed()) {
    launcher.show();
    launcher.webContents.send("last-run", { seconds, gameId, dropped });
  }
  if (gameId === "goblin") {
    goblinDroppedThisRun = 0;
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
