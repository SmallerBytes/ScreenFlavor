"use strict";

const fs = require("fs");
const path = require("path");

/**
 * @param {string} url
 * @param {string} destPath
 * @param {{ signal?: AbortSignal; expectedSize?: number; onProgress?: (p: { received: number; total: number }) => void }} opts
 */
async function downloadReleaseInstaller(url, destPath, opts) {
  const { signal, expectedSize = 0, onProgress } = opts;

  const res = await fetch(url, {
    headers: {
      Accept: "*/*",
      "User-Agent": "ScreenFlavor-update-download",
    },
    redirect: "follow",
    signal,
  });

  if (!res.ok) {
    throw new Error(`Download failed (HTTP ${res.status})`);
  }

  const headerLen = parseInt(res.headers.get("content-length") || "0", 10) || 0;
  const totalBytes = headerLen > 0 ? headerLen : expectedSize > 0 ? expectedSize : 0;

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("No download body");
  }

  await fs.promises.mkdir(path.dirname(destPath), { recursive: true }).catch(() => {});

  const ws = fs.createWriteStream(destPath, { flags: "w" });
  let received = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const buf = Buffer.from(value);
      await new Promise((resolve, reject) => {
        ws.write(buf, (err) => (err ? reject(err) : resolve(null)));
      });
      received += buf.length;
      onProgress?.({ received, total: totalBytes });
    }
    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve(null)));
    });
  } catch (e) {
    ws.destroy();
    await fs.promises.unlink(destPath).catch(() => {});
    throw e;
  }
}

module.exports = { downloadReleaseInstaller };
