// Bundles src/main.ts (+ CSS) with esbuild and inlines everything into one
// self-contained HTML file: dist/gps-path.html (dist/index.html is a copy so
// the dev server has a root page). --watch rebuilds on change, --serve hosts
// dist/ on http://localhost:5173.

import * as esbuild from "esbuild";
import { mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const watchMode = process.argv.includes("--watch");
const serveMode = process.argv.includes("--serve");
const PORT = 5173;

async function bundle() {
  const result = await esbuild.build({
    entryPoints: [resolve(ROOT, "src/main.ts")],
    bundle: true,
    minify: true,
    format: "iife",
    charset: "utf8",
    write: false,
    outdir: resolve(ROOT, "dist"),
    entryNames: "bundle",
    loader: { ".png": "dataurl" },
    logLevel: "warning",
  });

  let js = "";
  let css = "";
  for (const file of result.outputFiles) {
    if (file.path.endsWith(".js")) js = file.text;
    else if (file.path.endsWith(".css")) css = file.text;
  }
  js = js.replace(/<\/script>/g, "<\\/script>");

  const template = readFileSync(resolve(ROOT, "src/index.html"), "utf8");
  const html = template
    .replace("<!--STYLE-->", () => `<style>\n${css}</style>`)
    .replace("<!--SCRIPT-->", () => `<script>\n${js}</script>`);

  mkdirSync(resolve(ROOT, "dist"), { recursive: true });
  writeFileSync(resolve(ROOT, "dist/gps-path.html"), html);
  writeFileSync(resolve(ROOT, "dist/index.html"), html);
  return html.length;
}

const size = await bundle();
console.log(`dist/gps-path.html  ${(size / 1024).toFixed(0)} KB`);

if (watchMode) {
  let timer = null;
  watch(resolve(ROOT, "src"), { recursive: true }, (_event, file) => {
    if (file && file.includes("generated") === false) {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const n = await bundle();
          console.log(`rebuilt ${(n / 1024).toFixed(0)} KB  (${file})`);
        } catch (e) {
          console.error("build failed:", e.message ?? e);
        }
      }, 150);
    }
  });
  console.log("watching src/ for changes");
}

if (serveMode) {
  http
    .createServer((req, res) => {
      const url = (req.url ?? "/").split("?")[0];
      const name = url === "/" ? "index.html" : url.slice(1);
      if (name !== "index.html" && name !== "gps-path.html") {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      try {
        const body = readFileSync(resolve(ROOT, "dist", name));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(body);
      } catch {
        res.writeHead(500);
        res.end("build first");
      }
    })
    .listen(PORT, () => console.log(`serving http://localhost:${PORT}`));
}
