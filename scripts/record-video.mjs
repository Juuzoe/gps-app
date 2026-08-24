// Records dist/demo.mp4: same deterministic camera as the GIF recorder, but
// piped into ffmpeg (ffmpeg-static) as H.264. Captured at 2x and downscaled by
// ffmpeg with lanczos, so labels stay crisp. Requires `npm run build` first.
//
// Usage: npm run video
//        node scripts/record-video.mjs --width 960 --height 600 --fps 30 \
//          --crf 21 --out demo.mp4

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
import {
  ROOT, arg, findBrowser, preparePage, serveDist, setCam, warmTiles,
} from "./capture-lib.mjs";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const WIDTH = Number(arg("width", 960));
const HEIGHT = Number(arg("height", 600));
const FPS = Number(arg("fps", 30));
const CRF = Number(arg("crf", 21));
const OUT_NAME = arg("out", "demo.mp4");
// PX_KEYS are tuned for a 20 fps cadence; keep on-screen speed equal at other rates.
const PXSCALE = Number(arg("pxscale", 20 / FPS));
const HOLD_START = Math.round(FPS * 0.7);
const HOLD_END = Math.round(FPS * 1.4);

const { server, port } = serveDist();
const browser = await puppeteer.launch({
  executablePath: findBrowser(),
  headless: true,
  args: ["--no-first-run", "--disable-extensions", "--hide-scrollbars"],
});

try {
  const { page, state, plan } = await preparePage(browser, {
    width: WIDTH, height: HEIGHT, port, pxscale: PXSCALE,
  });
  const totalFrames = HOLD_START + plan.length + HOLD_END;
  console.log(
    `route ${(state.totalM / 1609.344).toFixed(1)} mi, ${plan.length} drive frames, ` +
      `${totalFrames} total, ${(totalFrames / FPS).toFixed(1)} s @ ${FPS} fps`,
  );

  const out = resolve(ROOT, "dist", OUT_NAME);
  const ffmpeg = spawn(ffmpegPath, [
    "-y",
    "-f", "image2pipe",
    "-framerate", String(FPS),
    "-i", "pipe:0",
    "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`,
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", String(CRF),
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    out,
  ], { stdio: ["pipe", "ignore", "pipe"] });
  let ffErr = "";
  ffmpeg.stderr.on("data", (d) => { ffErr += d; if (ffErr.length > 20000) ffErr = ffErr.slice(-10000); });
  const ffDone = new Promise((res, rej) => {
    ffmpeg.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}\n${ffErr.slice(-2000)}`))));
    ffmpeg.on("error", rej);
  });

  const writeFrame = (buf) =>
    new Promise((res, rej) => {
      ffmpeg.stdin.write(buf, (e) => (e ? rej(e) : res()));
    });

  console.log("warming tiles");
  await warmTiles(page, plan);

  console.log("capturing frames");
  await setCam(page, 0, plan[0].z);
  const first = await page.screenshot({ type: "png" });
  for (let i = 0; i < HOLD_START; i++) await writeFrame(first);
  let done = 0;
  for (const { f, z } of plan) {
    await setCam(page, f, z);
    await writeFrame(await page.screenshot({ type: "png" }));
    done += 1;
    if (done % 60 === 0) console.log(`  ${done}/${plan.length}`);
  }
  const last = await page.screenshot({ type: "png" });
  for (let i = 0; i < HOLD_END; i++) await writeFrame(last);

  ffmpeg.stdin.end();
  await ffDone;
  const { statSync } = await import("node:fs");
  console.log(`wrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB, ${WIDTH}x${HEIGHT} @ ${FPS} fps)`);
} finally {
  await browser.close();
  server.close();
}
