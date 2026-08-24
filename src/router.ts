import type { FlatStep, LatLng, ResolvedAnchor, RouteData } from "./types";
import { buildCum, haversineM } from "./geo";
import { normalizeRefKey } from "./parser";
import fallbackData from "./generated/fallback-route.json";

type OsrmStepRaw = {
  distance: number;
  name?: string;
  ref?: string;
  mode?: string;
  geometry: { coordinates: [number, number][] };
  maneuver: { type: string; modifier?: string };
};

type OsrmResponse = {
  code: string;
  routes?: {
    distance: number;
    legs: { steps: OsrmStepRaw[] }[];
  }[];
  waypoints?: { location: [number, number] }[];
};

const SERVERS = [
  { label: "router.project-osrm.org", base: "https://router.project-osrm.org" },
  { label: "routing.openstreetmap.de", base: "https://routing.openstreetmap.de/routed-car" },
];

function osrmUrl(base: string, start: ResolvedAnchor, end: ResolvedAnchor): string {
  const coords = `${start.point.lng},${start.point.lat};${end.point.lng},${end.point.lat}`;
  let url = `${base}/route/v1/driving/${coords}?overview=false&steps=true&geometries=geojson&alternatives=false`;
  if (start.bearing !== undefined || end.bearing !== undefined) {
    const b = (a?: number) => (a === undefined ? "" : `${Math.round(a)},60`);
    url += `&bearings=${b(start.bearing)};${b(end.bearing)}`;
  }
  return url;
}

async function fetchJson(url: string, timeoutMs: number): Promise<OsrmResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as OsrmResponse;
  } finally {
    clearTimeout(timer);
  }
}

function flatten(json: OsrmResponse, source: RouteData["source"], serverLabel: string): RouteData {
  const route = json.routes?.[0];
  if (json.code !== "Ok" || !route) throw new Error(`OSRM returned ${json.code}`);

  const latlngs: LatLng[] = [];
  const flatSteps: FlatStep[] = [];

  for (const leg of route.legs) {
    for (const step of leg.steps) {
      const startIdx = Math.max(0, latlngs.length - 1);
      for (const [lng, lat] of step.geometry.coordinates) {
        const prev = latlngs[latlngs.length - 1];
        if (!prev || prev.lat !== lat || prev.lng !== lng) latlngs.push({ lat, lng });
      }
      if (latlngs.length < 2) continue;
      const endIdx = latlngs.length - 1;
      if (step.distance <= 0 && endIdx <= startIdx) continue;
      flatSteps.push({
        refs: (step.ref ?? "")
          .split(";")
          .map((r) => normalizeRefKey(r))
          .filter(Boolean),
        name: step.name ?? "",
        distance: step.distance,
        isRamp: /ramp/i.test(step.maneuver.type),
        startIdx: latlngs.length === step.geometry.coordinates.length ? 0 : startIdx,
        endIdx,
        startM: 0,
        endM: 0,
      });
    }
  }

  if (latlngs.length < 2) throw new Error("OSRM route has no geometry");
  const cum = buildCum(latlngs);
  for (const fs of flatSteps) {
    fs.startM = cum[fs.startIdx]!;
    fs.endM = cum[fs.endIdx]!;
  }
  return {
    latlngs,
    cum,
    totalMeters: cum[cum.length - 1]!,
    flatSteps,
    source,
    serverLabel,
  };
}

function fallbackMatches(start: ResolvedAnchor, end: ResolvedAnchor): boolean {
  const wps = (fallbackData as unknown as OsrmResponse).waypoints;
  if (!wps || wps.length < 2) return false;
  const near = (wp: { location: [number, number] }, a: ResolvedAnchor) =>
    haversineM({ lat: wp.location[1], lng: wp.location[0] }, a.point) < 2500;
  return near(wps[0]!, start) && near(wps[wps.length - 1]!, end);
}

export async function getRoute(start: ResolvedAnchor, end: ResolvedAnchor): Promise<RouteData> {
  const failures: string[] = [];
  for (const server of SERVERS) {
    try {
      const json = await fetchJson(osrmUrl(server.base, start, end), 12000);
      return flatten(json, "live", server.label);
    } catch (e) {
      failures.push(`${server.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (fallbackMatches(start, end)) {
    return flatten(fallbackData as unknown as OsrmResponse, "fallback", "embedded snapshot");
  }
  throw new Error(
    `Routing failed. ${failures.join("; ")}. ` +
      `The embedded offline snapshot only covers the demo route (Indiana I-70 to Missouri I-255).`,
  );
}
