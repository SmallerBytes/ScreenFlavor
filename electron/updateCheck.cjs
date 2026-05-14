"use strict";

/**
 * Resolve "owner/repo" for GitHub Releases API.
 * Override with env SCREENFLAVOR_UPDATE_REPO=owner/repo
 * @param {Record<string, unknown>} pkg package.json object
 */
function resolveRepoSlug(pkg) {
  const env = process.env.SCREENFLAVOR_UPDATE_REPO;
  if (env && typeof env === "string") {
    const s = env.trim();
    if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  }
  return githubRepoFromPackage(pkg);
}

/** @param {Record<string, unknown>} pkg */
function githubRepoFromPackage(pkg) {
  const r = pkg.repository;
  const url = typeof r === "string" ? r : r && typeof r === "object" && "url" in r ? r.url : null;
  if (!url || typeof url !== "string") return null;
  const cleaned = url.replace(/\.git$/i, "").replace(/^git\+/, "");
  const m = cleaned.match(/github\.com\/([^/]+\/[^/]+)$/i);
  return m ? m[1] : null;
}

function parseSemverCore(version) {
  const v = String(version).trim().replace(/^v/i, "");
  const core = v.split("-")[0];
  const parts = core.split(".").map((p) => parseInt(p, 10));
  if (parts.length < 1 || parts.some((n) => Number.isNaN(n))) return null;
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

/** @returns {-1 | 0 | 1} */
function compareSemver(a, b) {
  const pa = parseSemverCore(a);
  const pb = parseSemverCore(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * @param {unknown[]} assets GitHub release assets
 * @param {string} platform `process.platform`
 * @param {string} productName e.g. from electron-builder productName
 * @returns {{ url: string; name: string; size: number } | null}
 */
function pickInstallerFromReleaseAssets(assets, platform, productName) {
  if (!Array.isArray(assets)) return null;
  const lower = (s) => String(s).toLowerCase();
  const prod = lower(productName || "app");

  if (platform === "win32") {
    const exes = assets.filter((a) => a && typeof a === "object" && a.name && lower(a.name).endsWith(".exe"));
    const filtered = exes.filter((a) => {
      const n = lower(a.name);
      if (n.includes("blockmap")) return false;
      if (n.includes("__uninstaller")) return false;
      if (n.endsWith("uninstall.exe")) return false;
      return true;
    });
    if (filtered.length === 0) return null;

    const score = (name) => {
      const n = lower(name);
      let s = 0;
      if (n.includes("setup")) s += 10;
      if (n.includes(prod)) s += 5;
      if (n.includes("x64") || n.includes("win64")) s += 2;
      return s;
    };

    const sorted = [...filtered].sort((a, b) => {
      const ds = score(b.name) - score(a.name);
      if (ds !== 0) return ds;
      return (Number(b.size) || 0) - (Number(a.size) || 0);
    });

    const pick = sorted[0];
    if (!pick?.browser_download_url || typeof pick.browser_download_url !== "string") return null;
    return {
      url: pick.browser_download_url,
      name: String(pick.name),
      size: Number(pick.size) || 0,
    };
  }

  if (platform === "darwin") {
    const dmg = assets.find((a) => a && typeof a === "object" && a.name && lower(a.name).endsWith(".dmg"));
    if (dmg?.browser_download_url && typeof dmg.browser_download_url === "string" && dmg.name) {
      return {
        url: dmg.browser_download_url,
        name: String(dmg.name),
        size: Number(dmg.size) || 0,
      };
    }
  }

  if (platform === "linux") {
    const img = assets.find(
      (a) => a && typeof a === "object" && a.name && lower(a.name).endsWith(".appimage"),
    );
    if (img?.browser_download_url && typeof img.browser_download_url === "string" && img.name) {
      return {
        url: img.browser_download_url,
        name: String(img.name),
        size: Number(img.size) || 0,
      };
    }
  }

  return null;
}

/**
 * @param {string} repo owner/name
 * @param {string} currentVersion from Electron app.getVersion()
 * @param {string} [productName] for matching release assets
 */
async function checkGitHubLatestRelease(repo, currentVersion, productName) {
  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "ScreenFlavor-update-check",
  };

  let res = await fetch(url, { headers });

  if (res.status === 404) {
    return {
      ok: true,
      updateAvailable: false,
      currentVersion,
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      note: "no_releases",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      error: "github_api",
      status: res.status,
      message: await res.text().catch(() => ""),
    };
  }

  let data = await res.json();

  /** Wait for CI to attach assets right after a release is published. */
  const tagName = typeof data.tag_name === "string" ? data.tag_name : "";
  const tagCore = tagName.replace(/^v/i, "");
  const newerThanCurrent = tagCore ? compareSemver(tagCore, currentVersion) === 1 : false;
  let retries = 0;
  const maxAssetRetries = 6;
  const retryMs = 2000;
  while (
    retries < maxAssetRetries &&
    newerThanCurrent &&
    !data.draft &&
    Array.isArray(data.assets) &&
    data.assets.length === 0
  ) {
    retries++;
    await new Promise((r) => setTimeout(r, retryMs));
    res = await fetch(url, { headers });
    if (!res.ok) break;
    data = await res.json();
  }
  const tag = typeof data.tag_name === "string" ? data.tag_name : "";
  const latestVersion = tag.replace(/^v/i, "") || tag || null;
  const cmp = latestVersion ? compareSemver(latestVersion, currentVersion) : 0;
  const updateAvailable = cmp === 1;

  const assets = Array.isArray(data.assets) ? data.assets : [];
  const pname = typeof productName === "string" && productName.trim() ? productName.trim() : "ScreenFlavor";
  const installer = pickInstallerFromReleaseAssets(assets, process.platform, pname);

  return {
    ok: true,
    updateAvailable,
    currentVersion,
    latestVersion,
    releaseUrl: typeof data.html_url === "string" ? data.html_url : null,
    releaseName: typeof data.name === "string" ? data.name : null,
    installer,
  };
}

module.exports = {
  resolveRepoSlug,
  checkGitHubLatestRelease,
  pickInstallerFromReleaseAssets,
};
