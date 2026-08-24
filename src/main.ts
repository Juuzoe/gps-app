import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./styles.css";

import type { BorderStep, GpsFix, NavRoute } from "./types";
import { parseInstructions } from "./parser";
import { resolveAnchors, GazetteerError } from "./gazetteer";
import { getRoute } from "./router";
import { alignRoute } from "./aligner";
import { Simulator } from "./gps";
import { indexAtDist } from "./geo";
import { renderSteps, renderTotals, updateHud, type HudRefs } from "./ui";

const DEFAULT_INPUT = `{
  "turns": [
    "Border Start: Indiana - I-70",
    "I-70 (58.3 mi)",
    "I-57 (5.1 mi)",
    "I-70 W toward St Louis (78.3 mi)",
    "I-55 (2.1 mi)",
    "I-55/I-70 (6.1 mi)",
    "I-255 Exit 10 toward I-270 (15.2 mi)",
    "I-255/US-50 (3.5 mi)",
    "I-255 S / US-50 W (3.0 mi)",
    "Border End: Missouri - I-255"
  ]
}`;

const ACCENT = "#3fb6dc";
const TRAVELED = "#79828f";
const CASING = "#05080d";

const qs = new URLSearchParams(location.search);
const captureMode = qs.get("capture") === "1";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const els = {
  input: $<HTMLTextAreaElement>("input"),
  inputBox: $<HTMLDetailsElement>("input-box"),
  build: $<HTMLButtonElement>("build"),
  parseErrors: $<HTMLUListElement>("parse-errors"),
  totals: $("totals"),
  steps: $("steps"),
  play: $<HTMLButtonElement>("play"),
  speed: $<HTMLSelectElement>("speed"),
  follow: $<HTMLButtonElement>("follow"),
  restart: $<HTMLButtonElement>("restart"),
  hud: $("hud"),
  banner: $("banner"),
  loading: $("loading"),
  controls: $("controls"),
};

const hudRefs: HudRefs = {
  hud: els.hud,
  shields: $("hud-shields"),
  mph: $("hud-mph"),
  nextDist: $("hud-next-dist"),
  nextText: $("hud-next-text"),
  eta: $("hud-eta"),
  coord: $("hud-coord"),
  odo: $("hud-odo"),
  progressFill: $("progress-fill"),
  gpsDot: $("gps-dot"),
};

const ICONS = {
  play: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M6 3.6 L16 10 L6 16.4 Z" fill="currentColor"/></svg>`,
  pause: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><rect x="4.5" y="3.5" width="3.6" height="13" fill="currentColor"/><rect x="11.9" y="3.5" width="3.6" height="13" fill="currentColor"/></svg>`,
  restart: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M10 3 a7 7 0 1 0 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M17 3 v4.2 h-4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  follow: `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><circle cx="10" cy="10" r="3" fill="currentColor"/><path d="M10 1.5 V5 M10 15 V18.5 M1.5 10 H5 M15 10 H18.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};

// ---------------------------------------------------------------------------
// Map

const map = L.map("map", {
  zoomControl: true,
  attributionControl: true,
  fadeAnimation: !captureMode,
  zoomAnimation: !captureMode,
});
map.setView([39.0, -89.0], 6);

const cartoLayer = L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    subdomains: "abcd",
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
);
cartoLayer.addTo(map);

// Failed tiles retry twice with backoff (rate limits, flaky network) before
// counting toward the basemap swap. The swap never happens in capture mode:
// a recording must keep one consistent basemap.
let tileErrors = 0;
let swapped = false;
let pendingTileRetries = 0;
cartoLayer.on("tileerror", (e) => {
  const img = (e as L.TileErrorEvent).tile as HTMLImageElement;
  const attempt = Number(img.dataset.retry ?? "0");
  if (attempt < 2) {
    img.dataset.retry = String(attempt + 1);
    img.dataset.baseSrc ??= img.src;
    pendingTileRetries += 1;
    window.setTimeout(() => {
      const done = () => {
        img.removeEventListener("load", done);
        img.removeEventListener("error", done);
        pendingTileRetries -= 1;
      };
      img.addEventListener("load", done);
      img.addEventListener("error", done);
      const base = img.dataset.baseSrc!;
      img.src = base + (base.includes("?") ? "&" : "?") + "retry=" + (attempt + 1);
    }, 400 * (attempt + 1));
    return;
  }
  tileErrors += 1;
  if (!captureMode && tileErrors > 6 && !swapped) {
    swapped = true;
    map.removeLayer(cartoLayer);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    showBanner("info", "Dark basemap unreachable, using the standard OpenStreetMap tiles.");
  }
});

// ---------------------------------------------------------------------------
// App state

type Layers = {
  casing: L.Polyline;
  remaining: L.Polyline;
  traveled: L.Polyline;
  vehicle: L.Marker;
  flags: L.Marker[];
};

let nav: NavRoute | null = null;
let sim: Simulator | null = null;
let layers: Layers | null = null;
let stepRows = new Map<number, HTMLElement>();
let follow = true;
let dirty = true;
let lastStepIdx = -9;
let vehRotEl: HTMLElement | null = null;

function showBanner(kind: "info" | "warn" | "error", text: string): void {
  els.banner.className = `banner banner-${kind}`;
  els.banner.innerHTML = "";
  const span = document.createElement("span");
  span.textContent = text;
  const close = document.createElement("button");
  close.className = "banner-close";
  close.setAttribute("aria-label", "Dismiss message");
  close.textContent = "×";
  close.addEventListener("click", () => (els.banner.hidden = true));
  els.banner.append(span, close);
  els.banner.hidden = false;
}

function clearLayers(): void {
  if (!layers) return;
  for (const l of [layers.casing, layers.remaining, layers.traveled, layers.vehicle, ...layers.flags]) {
    map.removeLayer(l);
  }
  layers = null;
}

function lineFlag(state: string, road: string, pos: L.LatLngExpression): L.Marker {
  const icon = L.divIcon({
    className: "line-flag-wrap",
    html: `<div class="line-flag"><span class="lf-state">${state}</span><span class="lf-road">${road}</span></div><div class="lf-pin"></div>`,
    iconSize: [70, 46],
    iconAnchor: [35, 46],
  });
  return L.marker(pos, { icon, interactive: false, keyboard: false });
}

function buildLayers(n: NavRoute): Layers {
  const pts = n.route.latlngs.map((p) => [p.lat, p.lng]) as [number, number][];
  const casing = L.polyline(pts, { color: CASING, weight: 9, opacity: 0.9, interactive: false });
  const remaining = L.polyline(pts, { color: ACCENT, weight: 4.5, opacity: 1, interactive: false, className: "route-line" });
  const traveled = L.polyline([], { color: TRAVELED, weight: 4.5, opacity: 0.95, interactive: false });

  const startStep = n.parsed.find((s): s is BorderStep => s.kind === "border-start");
  const endStep = n.parsed.find((s): s is BorderStep => s.kind === "border-end");
  const flags = [
    lineFlag(startStep?.stateAbbrev ?? "GO", startStep?.roads[0]?.raw ?? "", [n.start.marker.lat, n.start.marker.lng]),
    lineFlag(endStep?.stateAbbrev ?? "END", endStep?.roads[0]?.raw ?? "", [n.end.marker.lat, n.end.marker.lng]),
  ];

  const vehicle = L.marker([pts[0]![0], pts[0]![1]], {
    interactive: false,
    keyboard: false,
    zIndexOffset: 900,
    icon: L.divIcon({
      className: "veh-wrap",
      html: `<div class="veh-pulse"></div><div class="veh-rot"><svg viewBox="0 0 24 24" width="27" height="27" aria-hidden="true"><path d="M12 2.4 L18.4 20 L12 16.2 L5.6 20 Z" fill="#efa22f" stroke="#141a22" stroke-width="1.3" stroke-linejoin="round"/></svg></div>`,
      iconSize: [48, 48],
      iconAnchor: [24, 24],
    }),
  });

  casing.addTo(map);
  remaining.addTo(map);
  traveled.addTo(map);
  flags.forEach((f) => f.addTo(map));
  vehicle.addTo(map);
  vehRotEl = vehicle.getElement()?.querySelector(".veh-rot") as HTMLElement | null;
  return { casing, remaining, traveled, vehicle, flags };
}

/** One-time route reveal: dash the line in, then hand off to the simulator. */
function revealRoute(onDone: () => void): void {
  const path = layers?.remaining.getElement() as SVGPathElement | null;
  if (!path || reducedMotion || captureMode) {
    onDone();
    return;
  }
  try {
    const len = path.getTotalLength();
    path.style.strokeDasharray = `${len}`;
    path.style.strokeDashoffset = `${len}`;
    path.getBoundingClientRect();
    path.style.transition = "stroke-dashoffset 1s cubic-bezier(0.23, 1, 0.32, 1)";
    path.style.strokeDashoffset = "0";
    window.setTimeout(() => {
      path.style.transition = "";
      path.style.strokeDasharray = "";
      path.style.strokeDashoffset = "";
      onDone();
    }, 1050);
  } catch {
    onDone();
  }
}

function highlightStep(parsedIndex: number): void {
  for (const [idx, row] of stepRows) {
    row.classList.toggle("current", idx === parsedIndex);
  }
  const row = stepRows.get(parsedIndex);
  row?.scrollIntoView({ block: "nearest", behavior: captureMode ? "auto" : "smooth" });
}

function maybeFollow(fix: GpsFix): void {
  if (!follow) return;
  const pos = L.latLng(fix.lat, fix.lng);
  const p = map.latLngToContainerPoint(pos);
  const size = map.getSize();
  const mx = size.x * 0.26;
  const my = size.y * 0.26;
  if (p.x < mx || p.x > size.x - mx || p.y < my || p.y > size.y - my) {
    map.panTo(pos, { animate: !reducedMotion && !captureMode, duration: 0.6 });
  }
}

function applyFix(fix: GpsFix, ts: number, force: boolean): void {
  if (!nav || !layers) return;
  layers.vehicle.setLatLng([fix.lat, fix.lng]);
  if (vehRotEl) vehRotEl.style.transform = `rotate(${fix.headingDeg.toFixed(1)}deg)`;

  if (force || ts - lastTrail > 120) {
    lastTrail = ts;
    const i = indexAtDist(nav.route.cum, fix.odometerM);
    const pts = nav.route.latlngs.slice(0, i + 1).map((p) => [p.lat, p.lng]) as [number, number][];
    pts.push([fix.lat, fix.lng]);
    layers.traveled.setLatLngs(pts);
  }
  if (force || ts - lastHud > 100) {
    lastHud = ts;
    updateHud(hudRefs, fix, nav);
  }
  if (fix.stepIndex !== lastStepIdx) {
    lastStepIdx = fix.stepIndex;
    highlightStep(fix.stepIndex);
  }
  if (force || ts - lastCam > 350) {
    lastCam = ts;
    maybeFollow(fix);
  }
  syncPlayButton();
}

// ---------------------------------------------------------------------------
// Simulation loop

let lastTs = 0;
let lastHud = 0;
let lastTrail = 0;
let lastCam = 0;

function frame(ts: number): void {
  const dt = lastTs ? (ts - lastTs) / 1000 : 0;
  lastTs = ts;
  if (sim && nav && layers) {
    const wasPlaying = sim.playing;
    sim.advance(dt);
    if (wasPlaying || dirty) {
      applyFix(sim.fix(), ts, dirty);
      dirty = false;
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

let playBtnState = "";
function syncPlayButton(): void {
  const playing = sim?.playing ?? false;
  const done = sim?.done ?? false;
  const key = `${playing}-${done}`;
  if (key === playBtnState) return;
  playBtnState = key;
  els.play.innerHTML = playing ? ICONS.pause : ICONS.play;
  els.play.setAttribute("aria-label", playing ? "Pause" : done ? "Replay" : "Play");
  els.play.title = playing ? "Pause (space)" : "Play (space)";
}

function setPlaying(on: boolean): void {
  if (!sim) return;
  if (on && sim.done) sim.seekMeters(0);
  sim.playing = on;
  dirty = true;
}

// ---------------------------------------------------------------------------
// Build pipeline

async function buildFromText(text: string): Promise<void> {
  els.parseErrors.hidden = true;
  els.parseErrors.innerHTML = "";
  els.banner.hidden = true;
  els.loading.hidden = false;
  els.hud.hidden = true;
  els.controls.classList.remove("ready");

  try {
    const { steps, errors } = parseInstructions(text);
    const start = steps.find((s): s is BorderStep => s.kind === "border-start");
    const end = steps.find((s): s is BorderStep => s.kind === "border-end");
    const fatal = !start || !end || steps.filter((s) => s.kind === "step").length === 0;

    if (errors.length > 0) {
      els.parseErrors.innerHTML = errors.map((e) => `<li>${e}</li>`).join("");
      els.parseErrors.hidden = false;
      if (fatal) {
        els.inputBox.open = true;
        throw new Error("The instructions could not be parsed into a route.");
      }
    }

    const anchors = resolveAnchors(start!, end!);
    const route = await getRoute(anchors.start, anchors.end);
    const alignment = alignRoute(steps, route);
    const claimedTotalMeters = steps.reduce(
      (sum, s) => sum + (s.kind === "step" ? s.claimedMeters ?? 0 : 0),
      0,
    );
    nav = { parsed: steps, route, alignment, start: anchors.start, end: anchors.end, claimedTotalMeters };

    clearLayers();
    layers = buildLayers(nav);
    stepRows = renderSteps(els.steps, nav, (m) => {
      sim?.seekMeters(m);
      dirty = true;
    });
    renderTotals(els.totals, nav);

    sim = new Simulator(nav);
    sim.multiplier = Number(els.speed.value) || 50;
    lastStepIdx = -9;

    map.fitBounds(L.latLngBounds(nav.route.latlngs.map((p) => [p.lat, p.lng]) as [number, number][]), {
      padding: [46, 46],
      animate: false,
    });

    els.loading.hidden = true;
    els.hud.hidden = false;
    els.controls.classList.add("ready");
    dirty = true;

    if (route.source === "fallback") {
      showBanner("warn", "Routing servers are unreachable. Showing the embedded snapshot of this route.");
    }

    revealRoute(() => {
      if (!captureMode) setPlaying(true);
    });
  } catch (e) {
    els.loading.hidden = true;
    const msg = e instanceof GazetteerError || e instanceof Error ? e.message : String(e);
    showBanner("error", msg);
    els.inputBox.open = true;
  }
}

// ---------------------------------------------------------------------------
// Controls

els.play.addEventListener("click", () => setPlaying(!(sim?.playing ?? false)));
els.restart.addEventListener("click", () => {
  sim?.seekMeters(0);
  setPlaying(true);
});
els.speed.addEventListener("change", () => {
  if (sim) sim.multiplier = Number(els.speed.value) || 50;
});
els.follow.addEventListener("click", () => {
  follow = !follow;
  els.follow.setAttribute("aria-pressed", String(follow));
  if (follow) dirty = true;
});
map.on("dragstart", () => {
  if (follow) {
    follow = false;
    els.follow.setAttribute("aria-pressed", "false");
  }
});

$("progress").addEventListener("click", (e) => {
  if (!sim) return;
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  sim.seekFrac((e.clientX - rect.left) / rect.width);
  dirty = true;
});

window.addEventListener("keydown", (e) => {
  if (e.key !== " ") return;
  const t = e.target as HTMLElement;
  if (t.closest("textarea, input, select, button, [role=button]")) return;
  e.preventDefault();
  setPlaying(!(sim?.playing ?? false));
});

els.build.addEventListener("click", () => void buildFromText(els.input.value));
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    void buildFromText(els.input.value);
  }
});

els.restart.innerHTML = ICONS.restart;
els.follow.innerHTML = ICONS.follow;
syncPlayButton();

// ---------------------------------------------------------------------------
// Boot + capture hooks for scripts/record-gif.mjs

els.input.value = DEFAULT_INPUT;
if (captureMode) document.documentElement.classList.add("capture");

const readyPromise = buildFromText(DEFAULT_INPUT);

declare global {
  interface Window {
    __gpsPath: {
      ready: Promise<void>;
      build: (text: string) => Promise<void>;
      seekFrac: (f: number) => void;
      setView: (lat: number, lng: number, zoom: number) => void;
      cam: (frac: number, zoom: number) => void;
      state: () => { built: boolean; totalM: number; playing: boolean };
      tilesReady: () => Promise<void>;
      mapIdle: () => boolean;
    };
  }
}

window.__gpsPath = {
  ready: readyPromise,
  build: buildFromText,
  seekFrac: (f) => {
    sim?.seekFrac(f);
    dirty = true;
  },
  setView: (lat, lng, zoom) => map.setView([lat, lng], zoom, { animate: false }),
  cam: (frac, zoom) => {
    if (!sim) return;
    sim.forceLiveSpeed = frac > 0.0005 && frac < 0.9995;
    sim.seekFrac(frac);
    const fix = sim.fix();
    map.setView([fix.lat, fix.lng], zoom, { animate: false });
    if (nav && layers) applyFix(fix, performance.now(), true);
  },
  state: () => ({
    built: !!nav,
    totalM: nav?.route.totalMeters ?? 0,
    playing: sim?.playing ?? false,
  }),
  // True only when every tile in view is fully loaded and no retry is pending.
  // The recorders poll this before every screenshot so no frame ships half-drawn.
  mapIdle: () =>
    document.querySelectorAll(".leaflet-tile:not(.leaflet-tile-loaded)").length === 0 &&
    pendingTileRetries === 0,
  tilesReady: () =>
    new Promise<void>((resolveReady) => {
      const active = swapped ? null : cartoLayer;
      if (!active || !active.isLoading()) {
        resolveReady();
        return;
      }
      const timer = setTimeout(() => resolveReady(), 2000);
      active.once("load", () => {
        clearTimeout(timer);
        resolveReady();
      });
    }),
};
