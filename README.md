# Roadbook

Turns written route instructions into drivable navigation routes on a map, with live GPS and a first-person drive view. Built for oversize/overweight permit routes: give it the coarse turns list from a dispatch sheet or the full route table from a TxDMV single-trip permit, and it produces the route line, checks it against the instructions, and navigates it.

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

`fixtures/` holds the test inputs: `own/` are synthetic routes (including deliberate error cases), `actual/` are real TxDMV permit routes. The harness caches Overpass/OSRM responses in `.cache/`.

## Speed

Building a route is dominated by round trips to public Overpass mirrors (15-60s each, whatever you ask for), so the engine is built to need almost none of them:

- **Junctions are found server-side, not client-side.** The expensive way to find where road A meets road B is to download both roads' geometry — megabytes, a round trip per road — and intersect locally. Instead, Overpass is asked for the meeting places themselves: `node(w.a)(w.b)` returns shared nodes, `way.b(around.a:900)` returns B's ways near A as centre points. Every transition of a route, plus its border endpoints, goes into one query (sentinel-delimited, road sets declared once and reused), chunked only when a route touches more than ~7 distinct roads, chunks running concurrently one lane per mirror. Measured: four junctions plus an endpoint sweep in a single 129KB query. Geometry is then fetched only in ~2km discs around the chosen points, for carriageway snapping — a second, small, batched request.
- **A cold build is therefore a few round trips regardless of route length or shape.** There are no corridor heuristics to mis-place: nothing is tuned to how any particular route bends.
- **Never resolve an administrative area.** `area["ISO3166-2"=…]` is the most expensive thing a query can do and what makes mirrors 504. Everything uses a bbox or an `around` disc (spatial index), clipped afterwards to the real state outline, since a bounding box reaches deep into neighbouring states.
- **Failures are failures, not facts.** Overpass reports its own timeouts as HTTP 200 with a `remark`; that is detected and retried on another mirror with backoff, and empty responses are never cached. Anything discovery misses falls back per-pair to geometry intersection, then degrades to a flagged bridge — a slow lookup can cost accuracy flags, never a silent wrong answer.
- **The UI hides the rest.** Fetching starts as soon as pasted input parses (Build adopts the running work), everything is cached (IndexedDB / `.cache`), rebuilds take seconds, and Cancel always works.

**Self-hosting Overpass removes the round-trip cost entirely**, and is the recommended production setup.

## Data services

Everything runs client-side against public services: OpenStreetMap data via Overpass API, routing via the public OSRM instances (routing.openstreetmap.de, router.project-osrm.org), basemaps by CARTO, geocoding fallback via Nominatim. These are fine for development and demo volumes under their fair-use policies. For production traffic, self-host OSRM (a US extract) and an Overpass instance, or swap the endpoints in `src/engine/osrm.ts` / `src/engine/overpass.ts` for a commercial provider: the rest of the engine does not change.

## Layout

```
src/engine/   parsing, OSM resolution, routing, validation: no DOM, runs in node too
src/app/      React UI: map (MapLibre GL), panel, drive mode, simulator
scripts/      test harness
fixtures/     test inputs and GeoJSON outputs (fixtures/out/)
```
