# Route navigator

Turns written route instructions into drivable navigation routes on a map, with live GPS and a first-person drive view. Built for oversize/overweight permit routes: give it the coarse turns list from a dispatch sheet or the full route table from a TxDMV single-trip permit, and it produces the route line, checks it against the instructions, and navigates it.

This build is scoped to **Texas**. The engine itself is state-generic — every state is implemented and tested — and the scope is one constant, `LOCKED_STATE` in `src/app/config.ts`. Set it to another state code to lock there instead, or to `undefined` to enable all 48 states with a state picker in the UI. Locking also skips the state-inference lookups on every build.

## What it accepts

Three input shapes, detected automatically: paste as text or load a file:

1. **Turns JSON**

```json
{ "turns": [
  "Border Start: Indiana - I-70",
  "I-70 (58.3 mi)",
  "I-255 Exit 10 toward I-270 (15.2 mi)",
  "Border End: Missouri - I-255"
] }
```

Comments and trailing commas are tolerated. A bare array works too.

2. **TxDMV permit route tables**, pasted straight from the PDF, including the usual copy-paste damage (wrapped lines, glued columns, `< 0.1` distances):

```
Origin: IH0040 OK Line
88.40 IH40 w Take Exit 87 toward FM-2373 88.40 01:20
2.50 IH40NFR w Continue straight on FM2575 w 91.20 00:03
...
```

3. **Plain lines**: one instruction per line in the turns style.

Mileages in the source are treated as hints, not truth. They rank junction candidates but a wrong figure does not break the route; it surfaces as a flag on the leg instead.

## How it works

- **Parse**: instructions normalize into legs. TxDOT codes are understood (`IH10`, `US77A`, `SH46`, `SL463`, `SS247`, `FM1216`, `BU0059T`, `BI20B`, frontage suffixes like `IH35WWFR`, zero-padded forms like `IH0035W`), as are route-list styles (`I-70`, `US-50`, `TX-46`, `Loop 410`). Ramp, connector and frontage rows fold into their parent road; named streets stay as street legs.
- **Resolve**: road geometry is fetched from OpenStreetMap (Overpass API) along the corridor as the route is walked, with the correct Texas ref conventions (`SH46` → `TX 46`, `SL289` → `TX 289 Loop`, `FM`↔`RM` swaps, `Bus`/`Alt` suffixes: all verified against live data). Junctions between consecutive roads are found by shared nodes (at-grade crossings, concurrency boundaries) or proximity clustering (grade-separated interchanges), then ranked by network distance from the previous waypoint against the claimed mileage, compass direction, and exit-number hints. Border endpoints ("NM Line", "Border Start: Indiana"), mid-route origins ("IH0035W, 0.8mi N of IH0035W & SH0183") and city destinations all resolve to coordinates.
- **Route**: the waypoint chain goes to OSRM (car profile) with travel bearings so snapping lands on the correct carriageway. A failed multi-waypoint request degrades to pair-by-pair routing so one bad snap cannot sink the whole route.
- **Validate**: every routed segment's OSM refs are compared with the instructed road. Mismatched legs are flagged with the match percentage; the worst junction is retried with its next-best candidate. Claimed vs routed distance is reported per leg and in total.
- **Drive**: device GPS or the built-in simulator feed the same navigation loop: progress along the route, next-maneuver distance, off-route detection (with rejoin line and one-tap reroute), first-person camera. The simulator has a speed multiplier and a "drift off" toggle to demonstrate off-route behavior.

Unresolvable input degrades instead of failing: an unknown road or a pair of roads that never meet is reported per leg, and routing bridges the gap by the fastest path so a drivable line still renders.

## Running it

```bash
npm install
npm run dev        # http://localhost:5174
npm run build      # production bundle in dist/
npm run test:routes            # run the fixture suite (network required)
npm run test:routes -- tx1     # just fixtures matching "tx1"
```

`fixtures/` holds the test inputs: `own/` are synthetic routes (including deliberate error cases) covering 20 states, `actual/` are real TxDMV permit routes. The harness caches Overpass/OSRM responses in `.cache/`.

The sample routes in the UI's picker are development-only: they sit behind `import.meta.env.DEV`, so `npm run build` leaves them out of the shipped bundle entirely and the picker hides itself.

## Speed

Building a route is dominated by round trips to public Overpass mirrors (15-60s each, whatever you ask for), so the engine is built to need almost none of them:

- **Junctions are found server-side, not client-side.** The expensive way to find where road A meets road B is to download both roads' geometry — megabytes, a round trip per road — and intersect locally. Instead, Overpass is asked for the meeting places themselves: `node(w.a)(w.b)` returns shared nodes, `way.b(around.a:900)` returns B's ways near A as centre points. Transitions are batched into few queries (sentinel-delimited, road sets declared once and reused) that run concurrently. Measured: four junctions plus an endpoint sweep in a single 129KB query. Geometry is then fetched only in ~2km discs around the chosen points, for carriageway snapping — a second, small, batched request.
- **Each search is bounded by the route's own claimed mileage.** Endpoints resolve first; the junction after leg *k* can then be no farther from the origin than the miles claimed for legs 0..*k*, and no farther from the destination than the rest. Scan cost tracks the area covered, and bounding it cut a statewide Texas scan from 43.3s to 24.2s on the same three roads. The bound comes only from the route's own numbers, so nothing is tuned to how a particular route bends; where the numbers are missing or contradictory, the search widens to the state and says so rather than guessing.
- **Dead mirrors are detected, not waited on.** Public mirrors go down for hours (measured: six of seven unreachable worldwide on 2026-08-27). A cheap probe marks failing hosts before real queries go out, so a dead mirror costs about a second instead of a 30-150s connect timeout on every parallel lane; requests are capped at two per mirror, the documented courtesy quota.
- **Never resolve an administrative area.** `area["ISO3166-2"=…]` is the most expensive thing a query can do and what makes mirrors 504. Everything uses a bbox or an `around` disc (spatial index), clipped afterwards to the real state outline, since a bounding box reaches deep into neighbouring states.
- **The instructions arbitrate the routing.** A junction waypoint sits between the carriageways of a divided highway, and a nearest-edge snap can land on the wrong side — the route then runs to the next crossover and back on the right road, which validation cannot catch by road name alone. Every waypoint interval carries the instructions' claimed mileage, so any leg that overshoots its claim is re-routed pair by pair under each snap variant (departure bearing, none, both ends) and the variant that matches the claim wins. One permit leg claimed 11.0 mi: nearest-snap routed 24.8, the arbitrated route 11.4.
- **Failures are failures, not facts.** Overpass reports its own timeouts as HTTP 200 with a `remark`; that is detected and retried on another mirror with backoff, and empty responses are never cached. Anything discovery misses falls back per-pair to geometry intersection, then degrades to a flagged bridge — a slow lookup can cost accuracy flags, never a silent wrong answer.
- **The UI hides the rest.** Fetching starts as soon as pasted input parses (Build adopts the running work), everything is cached (IndexedDB / `.cache`), rebuilds take seconds, and Cancel always works.

**Self-hosting Overpass removes the queue wait entirely**, and is the recommended production setup. On the free public servers, a single trivial query queued 5-14s on a bad day, which sets a floor no client-side change can go under. A private Overpass answers the same query in well under a second. A Texas-only extract needs roughly 20GB of disk and 4-8GB of RAM (a €6-15/month VPS, ~1-2h import); the full US extract wants ~150-200GB and 16-32GB. Point the mirror list in `src/engine/overpass.ts` at the private instance and keep the public ones as fallback — no other change is needed, and states the private server does not hold still work through the public path.

## Data services

Everything runs client-side against public services: OpenStreetMap data via Overpass API, routing via the public OSRM instances (routing.openstreetmap.de, router.project-osrm.org), basemaps by CARTO, geocoding fallback via Nominatim. These are fine for development and demo volumes under their fair-use policies. For production traffic, self-host OSRM (a US extract) and an Overpass instance, or swap the endpoints in `src/engine/osrm.ts` / `src/engine/overpass.ts` for a commercial provider: the rest of the engine does not change.

## Layout

```
src/engine/   parsing, OSM resolution, routing, validation: no DOM, runs in node too
src/app/      React UI: map (MapLibre GL), panel, drive mode, simulator
scripts/      test harness
fixtures/     test inputs and GeoJSON outputs (fixtures/out/)
```
