// Records dist/demo.gif by driving the simulation frame by frame in a headless
// system browser through the window.__gpsPath capture API. Camera planning,
// crispness model and page setup live in capture-lib.mjs (shared with the MP4
// recorder). One global rgb565 palette keeps the dark map stable across frames.
//
// Usage: npm run gif
//        node scripts/record-gif.mjs --width 640 --height 400 --fps 18 \
//          --pxscale 1.25 --out demo-small.gif
// env CHROME_PATH overrides browser detection. Requires `npm run build` first.

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import puppeteer from "puppeteer-core";
import {
  ROOT, arg, downscale2x, findBrowser, preparePage, serveDist, setCam, warmTiles,
} from "./capture-lib.mjs";

const require = createRequire(import.meta.url);
const { GIFEncoder, quantize, applyPalette } = require("gifenc");
const { PNG } = require("pngjs");

const WIDTH = Number(arg("width", 960));
const HEIGHT = Number(arg("height", 600));
const FPS = Number(arg("fps", 20));
const PXSCALE = Number(arg("pxscale", 1));
const OUT_NAME = arg("out", "demo.gif");
const WRITE_STILLS = OUT_NAME === "demo.gif";
const HOLD_START = Math.round(FPS * 0.7);
const HOLD_END = Math.round(FPS * 1.2);

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

  console.log("warming tiles");
  await warmTiles(page, plan);

  const frames = [];
  const shoot = async () => {
    const png = PNG.sync.read(await page.screenshot({ type: "png" }));
    frames.push(downscale2x(png.data, png.width, png.height));
  };

  console.log("capturing frames");
  await setCam(page, 0, plan[0].z);
  for (let i = 0; i < HOLD_START; i++) await shoot();
  for (const { f, z } of plan) {
    await setCam(page, f, z);
    await shoot();
  }
  for (let i = 0; i < HOLD_END; i++) await shoot();

  if (WRITE_STILLS) {
    const still = (name, rgba) => {
      const png = new PNG({ width: WIDTH, height: HEIGHT });
      png.data = Buffer.from(rgba);
      writeFileSync(resolve(ROOT, "dist", name), PNG.sync.write(png));
    };
    const at = (f) => {
      let best = 0;
      plan.forEach((p, i) => { if (Math.abs(p.f - f) < Math.abs(plan[best].f - f)) best = i; });
      return frames[HOLD_START + best];
    };
    still("shot-start.png", frames[HOLD_START]);
    still("shot-cruise.png", at(0.4));
    still("shot-stlouis.png", at(0.93));
    still("shot-arrive.png", frames[frames.length - 1]);
  }

  console.log(`encoding ${frames.length} frames`);
  // Global palette from a stride-sampled mix of frames across the drive.
  const picks = [0.15, 0.45, 0.8, 0.97].map((f) => frames[Math.min(frames.length - 1, HOLD_START + Math.round(f * (plan.length - 1)))]);
  const stride = 4 * 3;
  const sampleLen = Math.floor(picks[0].length / stride) * 4;
  const sample = new Uint8Array(sampleLen * picks.length);
  picks.forEach((fr, pi) => {
    for (let i = 0, o = pi * sampleLen; i + 3 < fr.length; i += stride, o += 4) {
      sample[o] = fr[i]; sample[o + 1] = fr[i + 1]; sample[o + 2] = fr[i + 2]; sample[o + 3] = 255;
    }
  });
  const palette = quantize(sample, 256, { format: "rgb565" });

  const gif = GIFEncoder();
  const delay = Math.round(1000 / FPS);
  for (const rgba of frames) {
    const index = applyPalette(rgba, palette, "rgb565");
    gif.writeFrame(index, WIDTH, HEIGHT, { palette, delay });
  }
  gif.finish();

  const out = resolve(ROOT, "dist", OUT_NAME);
  writeFileSync(out, gif.bytes());
  console.log(`wrote ${out} (${(gif.bytes().length / 1024 / 1024).toFixed(1)} MB, ${frames.length} frames, ${WIDTH}x${HEIGHT})`);
} finally {
  await browser.close();
  server.close();
}
