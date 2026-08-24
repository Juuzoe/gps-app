// Shared pieces of the demo recorders (GIF and MP4): camera planning over the
// route, browser discovery, page setup against a throwaway server for the
// built single-file app, and the 2x box downscale.

import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// route fraction -> zoom. Flat spans are integer zooms (crisp native tiles);
// the gaps between them are kept short so fractional zoom, where Leaflet
// scales and swaps tilesets, lasts a fraction of a second on screen.
export const ZOOM_KEYS = [
  [0, 13], [0.004, 13],
  [0.045, 10.2],
  [0.12, 9], [0.72, 9],
  [0.755, 10], [0.855, 10],
  [0.885, 11], [0.945, 11],
  [0.968, 12], [1, 12],
];

// route fraction -> camera pan speed in screen px per frame (at the reference
// 20 fps cadence; scale with pxscale for other frame rates).
export const PX_KEYS = [
  [0, 8], [0.045, 12], [0.12, 22], [0.72, 22],
  [0.8, 15], [0.895, 12], [0.945, 11], [0.975, 9], [1, 8],
];

const smootherstep = (t) => t * t * t * (t * (6 * t - 15) + 10);

export function interpKeys(keys, x) {
  if (x <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [xa, ya] = keys[i - 1];
    const [xb, yb] = keys[i];
    if (x <= xb) return ya + (yb - ya) * smootherstep((x - xa) / (xb - xa || 1));
  }
  return keys[keys.length - 1][1];
}

// Mid-route latitude is close enough across the corridor (38.5..39.4 deg).
const M_PER_PX = (zoom) => (40075016.686 * Math.cos((38.97 * Math.PI) / 180)) / (256 * 2 ** zoom);

export function planDrive(totalM, pxscale = 1) {
  const plan = [];
  let f = 0;
  while (f < 1 && plan.length < 1500) {
    const z = interpKeys(ZOOM_KEYS, f);
    plan.push({ f, z });
    const px = interpKeys(PX_KEYS, f) * pxscale;
    f += (px * M_PER_PX(z)) / totalM;
  }
  plan.push({ f: 1, z: interpKeys(ZOOM_KEYS, 1) });
  return plan;
}

export function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`No Edge/Chrome found. Set CHROME_PATH. Tried:\n${candidates.join("\n")}`);
  return hit;
}

export function serveDist() {
  const html = readFileSync(resolve(ROOT, "dist/gps-path.html"));
  const server = http
    .createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    })
    .listen(0);
  return { server, port: server.address().port };
}

/** Opens the capture page, waits for the route, returns { page, state, plan }. */
export async function preparePage(browser, { width, height, port, pxscale }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 2 });
  await page.goto(`http://127.0.0.1:${port}/?capture=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction("window.__gpsPath !== undefined", { timeout: 20000 });
  await page.evaluate(() => window.__gpsPath.ready);
  const state = await page.evaluate(() => window.__gpsPath.state());
  if (!state.built) throw new Error("route failed to build in the capture page");
  const plan = planDrive(state.totalM, pxscale);
  return { page, state, plan };
}

export async function setCam(page, f, z) {
  await page.evaluate((ff, zz) => window.__gpsPath.cam(ff, zz), f, z);
  await page.evaluate(() => window.__gpsPath.tilesReady());
  // Hold the frame until every tile in view is loaded (retries included), so
  // no capture ships with half-drawn tiles. Give up after 3 s and shoot anyway.
  await page
    .waitForFunction("window.__gpsPath.mapIdle ? window.__gpsPath.mapIdle() : true", {
      polling: 60,
      timeout: 3000,
    })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 40));
}

export async function warmTiles(page, plan) {
  for (let i = 0; i <= 30; i++) {
    const { f, z } = plan[Math.min(plan.length - 1, Math.round((i / 30) * (plan.length - 1)))];
    await setCam(page, f, z);
  }
}

export function downscale2x(src, w, h) {
  const ow = w >> 1;
  const oh = h >> 1;
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    const r0 = y * 2 * w * 4;
    const r1 = r0 + w * 4;
    for (let x = 0; x < ow; x++) {
      const a = r0 + x * 8;
      const b = r1 + x * 8;
      const o = (y * ow + x) * 4;
      for (let c = 0; c < 4; c++) {
        out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2;
      }
    }
  }
  return out;
}
