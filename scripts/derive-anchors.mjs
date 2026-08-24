// One-time helper: derives precise state-border crossing points for the demo
// gazetteer by routing across each border with OSRM and bisecting the geometry
// against Nominatim reverse geocoding (state flip). Writes src/data/border-crossings.json.
//
// Nominatim usage policy: max 1 req/sec, identify the app via User-Agent.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "gps-path-demo/0.1 (internal route-engine dev)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return await res.json();
      console.error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      console.error(`fetch failed (${e.message}) for ${url}`);
    }
    await sleep(1500);
  }
  throw new Error(`giving up on ${url}`);
}

async function osrmRoute(points) {
  const coords = points.map(([lat, lng]) => `${lng},${lat}`).join(";");
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  const json = await getJson(url);
  if (json.code !== "Ok") throw new Error(`OSRM: ${json.code}`);
  // geojson coords are [lng, lat]
  return json.routes[0].geometry.coordinates.map(([lng, lat]) => [lat, lng]);
}

async function stateAt([lat, lng]) {
  await sleep(1100);
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=5&lat=${lat}&lon=${lng}`;
  const json = await getJson(url);
  return json?.address?.state ?? null;
}

function bearing([lat1, lng1], [lat2, lng2]) {
  const toRad = Math.PI / 180;
  const dLng = (lng2 - lng1) * toRad;
  const y = Math.sin(dLng) * Math.cos(lat2 * toRad);
  const x =
    Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

// Binary search along the polyline for the point where address.state flips.
async function findCrossing(geometry, fromState, toState) {
  let lo = 0;
  let hi = geometry.length - 1;
  const sLo = await stateAt(geometry[lo]);
  const sHi = await stateAt(geometry[hi]);
  console.log(`  endpoints: ${sLo} -> ${sHi} (${geometry.length} pts)`);
  if (sLo !== fromState || sHi !== toState) {
    throw new Error(`route does not span ${fromState}->${toState} (got ${sLo}->${sHi})`);
  }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const s = await stateAt(geometry[mid]);
    console.log(`  bisect idx ${mid}: ${s}`);
    if (s === fromState) lo = mid;
    else hi = mid;
  }
  const crossing = [
    (geometry[lo][0] + geometry[hi][0]) / 2,
    (geometry[lo][1] + geometry[hi][1]) / 2,
  ];
  const brg = bearing(geometry[Math.max(0, lo - 2)], geometry[Math.min(geometry.length - 1, hi + 2)]);
  return { crossing, bearingAtoB: Math.round(brg) };
}

const out = [];

console.log("Crossing 1: I-70, Indiana -> Illinois (near Terre Haute)");
{
  const geom = await osrmRoute([
    [39.466, -87.414], // Terre Haute, IN (I-70)
    [39.391, -87.694], // Marshall, IL (I-70)
  ]);
  const { crossing, bearingAtoB } = await findCrossing(geom, "Indiana", "Illinois");
  console.log("  => crossing:", crossing, "bearing:", bearingAtoB);
  out.push({
    states: ["IN", "IL"],
    road: "I70",
    label: "I-70 @ Indiana/Illinois line (Terre Haute)",
    crossing: { lat: +crossing[0].toFixed(6), lng: +crossing[1].toFixed(6) },
    bearingAtoB,
  });
}

console.log("Crossing 2: I-255, Illinois -> Missouri (Jefferson Barracks Bridge)");
{
  const geom = await osrmRoute([
    [38.52, -90.21], // Dupo, IL side
    [38.46, -90.305], // Oakville, MO side
  ]);
  const { crossing, bearingAtoB } = await findCrossing(geom, "Illinois", "Missouri");
  console.log("  => crossing:", crossing, "bearing:", bearingAtoB);
  out.push({
    states: ["IL", "MO"],
    road: "I255",
    label: "I-255 @ Jefferson Barracks Bridge (Mississippi River)",
    crossing: { lat: +crossing[0].toFixed(6), lng: +crossing[1].toFixed(6) },
    bearingAtoB,
  });
}

const file = resolve(ROOT, "src/data/border-crossings.json");
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}`);
