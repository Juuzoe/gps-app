// Fetches the demo route (Indiana I-70 line to Missouri I-255 line) from OSRM
// with the same parameters the app uses, slims the response, and embeds it as
// src/generated/fallback-route.json so the page still works when the routing
// servers are unreachable. Also prints the step table for eyeballing refs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MI = 1609.344;

const crossings = JSON.parse(
  readFileSync(resolve(ROOT, "src/data/border-crossings.json"), "utf8"),
);
const startEntry = crossings.find((c) => c.road === "I70" && c.states.includes("IN"));
const endEntry = crossings.find((c) => c.road === "I255" && c.states.includes("MO"));
if (!startEntry || !endEntry) throw new Error("expected demo crossings in border-crossings.json");

function destination(a, bearing, distM) {
  const R = 6371008.8;
  const rad = (d) => (d * Math.PI) / 180;
  const deg = (r) => (r * 180) / Math.PI;
  const br = rad(bearing);
  const dr = distM / R;
  const lat1 = rad(a.lat);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br),
  );
  const lng2 =
    rad(a.lng) +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

const start = startEntry.crossing;
const startBearing = startEntry.states[0] === "IN" ? startEntry.bearingAtoB : (startEntry.bearingAtoB + 180) % 360;
const endBearing = endEntry.states[0] === "IL" ? endEntry.bearingAtoB : (endEntry.bearingAtoB + 180) % 360;
const end = destination(endEntry.crossing, endBearing, 450);

const coords = `${start.lng},${start.lat};${end.lng},${end.lat}`;
const url =
  `https://router.project-osrm.org/route/v1/driving/${coords}` +
  `?overview=false&steps=true&geometries=geojson&alternatives=false` +
  `&bearings=${Math.round(startBearing)},60;${Math.round(endBearing)},60`;

console.log(url);
const res = await fetch(url, { headers: { "User-Agent": "gps-path-demo/0.1" } });
const json = await res.json();
if (json.code !== "Ok") throw new Error(`OSRM: ${json.code} ${json.message ?? ""}`);

const route = json.routes[0];
const slim = {
  code: "Ok",
  routes: [
    {
      distance: route.distance,
      duration: route.duration,
      legs: route.legs.map((leg) => ({
        steps: leg.steps.map((s) => ({
          distance: s.distance,
          duration: s.duration,
          name: s.name,
          ref: s.ref,
          mode: s.mode,
          maneuver: { type: s.maneuver.type, modifier: s.maneuver.modifier },
          geometry: {
            coordinates: s.geometry.coordinates.map(([lng, lat]) => [
              +lng.toFixed(5),
              +lat.toFixed(5),
            ]),
          },
        })),
      })),
    },
  ],
  waypoints: json.waypoints.map((w) => ({ location: w.location })),
};

const out = resolve(ROOT, "src/generated/fallback-route.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(slim));

console.log(`total: ${(route.distance / MI).toFixed(1)} mi, ${(route.duration / 60).toFixed(0)} min (OSRM), steps:`);
for (const leg of route.legs) {
  for (const s of leg.steps) {
    const miles = (s.distance / MI).toFixed(1).padStart(6);
    console.log(`${miles} mi  ref=[${s.ref ?? ""}]  name=[${s.name ?? ""}]  ${s.maneuver.type}${s.maneuver.modifier ? "/" + s.maneuver.modifier : ""}`);
  }
}
console.log(`wrote ${out} (${(JSON.stringify(slim).length / 1024).toFixed(0)} KB)`);
