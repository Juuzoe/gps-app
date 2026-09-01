# Route Navigator — project documentation

Last updated: 2026-09-01
Repository: https://github.com/Juuzoe/gps-app (branch `main`)
Live: https://gps-app-blush.vercel.app

---

## 1. What it does

Turns written route instructions into a drivable navigation route on a map,
with live GPS following and a first-person drive view.

It is built for oversize/overweight permit routes. A permit tells a driver
which roads to take and for how many miles, but not where those roads
actually are. This app resolves every instruction against OpenStreetMap,
finds each junction, builds the route line, checks the result against the
instructions, and then navigates it.

The current build is scoped to **Texas**. The engine itself is state-generic
and tested in 20 states; the scope is a single constant (see §8).

## 2. What it accepts

Three input shapes, detected automatically. Paste as text, or load a file.

**1. Turns JSON** — the format from the original project brief:

```json
{ "turns": [
  "Border Start: Oklahoma - I-40",
  "I-40 W (91 mi)",
  "FM-2575 (4 mi)",
  "Border End: New Mexico - US-380"
] }
```

Comments and trailing commas are tolerated. A bare array works too.

**2. TxDMV permit route tables** — pasted straight out of the permit PDF:

```
Origin: IH0040 OK Line
88.40 IH40 w Take Exit 87 toward FM-2373 88.40 01:20
2.50 IH40NFR w Continue straight on FM2575 w 91.20 00:03
```

**3. Plain lines** — one instruction per line in the turns style.

### Paste damage the parser handles

Real users copy from PDFs, and PDF viewers mangle tables differently. All of
the following are handled and covered by an offline test (`npm run test:parse`):

- Wrapped continuation lines
- Columns glued onto the text ("...FM2575 w 91.20 00:03")
- `< 0.1` distances
- **Cell-split pastes** — macOS Preview and Safari copy each table cell onto
  its own line, so one row arrives as five. This broke a client's paste
  completely; rows are now reassembled mechanically (a mileage cell opens a
  row, the time cell closes it).
- Converted turns exports that keep the permit's connector rows verbatim
  (`IH10 Ramp W (0.40 mi)`), detached frontage codes (`IH35 WFR`), TxDOT long
  forms (`IHHIGHWAY-35-FRONTAGE-ROAD`), and permit-style endpoint lines
  (`Route Start: BU0059T, 2.3 mi SW of BU0059T & US0059`).

### TxDOT road code conventions

The parser and the OSM query layer both understand Texas's naming, which
differs from what OSM stores:

| Permit code | OSM ref |
|---|---|
| `SH46` | `TX 46` |
| `SL289` | `TX 289 Loop` or `Loop 289` |
| `SS247` | `Spur 247` |
| `FM1216` / `RM1216` | either spelling accepted |
| `BU0059T` | `US 59 Bus` |
| `BI20B` | `I 20 Bus` |
| `IH35WWFR` | I-35W frontage road |

## 3. How it works

**Parse** → instructions normalize into legs, with their claimed mileage and
direction.

**Resolve** → the geographic core. For each pair of consecutive roads, the app
finds where they meet. It does *not* download road geometry to do this;
Overpass is asked for the meeting places directly:

- `node(w.a)(w.b)` returns shared nodes (at-grade crossings, concurrencies)
- `way.b(around.a:900)` returns B's ways near A as centre points
  (grade-separated interchanges, terminus merges)

Every transition of a route goes into a small number of batched queries, so a
build costs a handful of round trips regardless of route length.

Junction candidates are then chosen by a chain solver (Viterbi over the whole
route) that scores each candidate against the instruction's own claimed
mileage and compass direction, anchored at both endpoints.

**Route** → the waypoint chain goes to OSRM. Because a junction waypoint sits
*between* the carriageways of a divided highway, the nearest-edge snap can
land on the wrong side and send the route to the next crossover and back. The
router is therefore run under multiple snap variants, and any leg that misses
its claimed mileage is rebuilt pair-by-pair with the claim as the judge.

**Validate** → every routed segment's OSM refs are compared against the
instructed road. Mismatched legs are flagged with a match percentage; claimed
vs routed distance is reported per leg and in total.

**Drive** → device GPS or the built-in simulator feed the same navigation
loop: progress, next-maneuver distance, off-route detection with one-tap
reroute, first-person camera.

### The design rule the engine is built on

> A partial or failed answer must never become a fact.

This is the single principle behind most of the engine's defensive code, and
every violation of it produced a real bug:

- Clipping results to the state outline is **strict**. An earlier version
  returned unclipped points "so callers still had data", which turned "this
  road is not in this state" into "all of it is" and sent a Virginia route to
  Kentucky.
- Overpass reports its own timeouts as HTTP 200 with a `remark`. Taken at face
  value that reads as "this road does not exist", so junctions silently
  vanished. Now detected, retried, and never cached.
- A capped result list cannot support an extremal conclusion. A truncated
  sweep once moved a border endpoint 70 miles inland.
- A junction candidate many times farther than the instruction's own claimed
  mileage is not evidence of a junction. One permit leaves Spur 57 after 0.3
  mi; OSM records no connection there at all, and the solver settled for a
  candidate 10 miles up the road. Such candidates are now discarded and the
  turn is flagged instead.
- A failed network probe says nothing about the thing being probed. A probe
  failure during state inference once sent an Oklahoma→New Mexico route to
  Colorado.

When something cannot be resolved, the app degrades loudly: the leg is
flagged, the gap is bridged by the fastest road, and the user is told. It
never silently draws a wrong route.

## 4. Verification

### Route accuracy — real TxDMV permits

Tested against the five real permits supplied with the brief, in both
dialects, on live OSM data:

| Permit | Legs | Claimed | Routed | Delta |
|---|---|---|---|---|
| TX_1 (Victoria → NM line) | 29 | 581.9 mi | 599.7 mi | +17.8 |
| TX_2 (I-30 → Laredo) | 9 | 612.3 mi | 600.7 mi | −11.7 |
| TX_3 (US-285 → Pecos) | 12 | 129.6 mi | 129.7 mi | **+0.1** |
| TX_4 (I-35W → I-20) | 7 | 211.8 mi | 219.3 mi | +7.5 |
| TX_5 (I-40 → US-380) | 9 | 314.6 mi | 316.4 mi | +1.9 |
| TX_5 as turns JSON | 9 | 314.1 mi | 315.1 mi | +1.0 |

Permit mileages are themselves approximate, so small deltas are expected.

### Generality — the engine is not tuned to Texas

Blind fixtures in 20 other states, including Canadian and Mexican border
crossings. Examples: Arizona I-40 delta −0.5 mi, Oklahoma I-40 delta −7.8 mi,
Ohio delta 0.1 mi, Washington delta 0.3 mi, Virginia delta 2.7 mi.

### Parsing — offline, no network

`npm run test:parse` checks that every paste dialect of each permit produces
identical legs to the curated fixture. All five permits pass in both the
clean and cell-split forms.

### UI

Verified in the production bundle: build/cancel, sample loading, drive
simulator, off-route detection and return, first-person toggle, dark/light
basemap, mobile layout at 375 px with no horizontal scroll, and correct
error text for unparseable input.

## 5. Known limitations (honest list)

**OSM data gaps.** Some turns a permit describes do not exist in
OpenStreetMap's data. Verified examples:

- Victoria: OSM's US-59 Business stub ends more than 3 km from Loop 463 —
  they never touch, so that turn cannot be resolved.
- Pecos area: Spur 57 and FM-1927 share no nodes in OSM.
- Odessa: several city streets on the permit's detour are not mapped with
  their permit names.

In every case the leg is flagged in the UI and the gap is bridged by the
shortest road. These are data limitations, not engine failures, and they
would be fixed by editing OpenStreetMap or by using a commercial road
network.

**Frontage roads and gated segments.** OSM sometimes marks a road as
restricted, so routing detours around it. The app detects this pattern and
labels the leg rather than pretending the detour was intended.

**Permit mileages are hints.** A wrong figure in the source flags a leg; it
never breaks the route.

## 6. Performance — and the one real problem

The engine is efficient: a build is a handful of round trips, junction search
is bounded by the route's own claimed mileage, results are cached in the
browser (IndexedDB), and fetching starts as soon as pasted input parses.

**The bottleneck is entirely the free public infrastructure.** The app depends
on volunteer-run servers shared with the whole world:

- Overpass (road data) — measured 26–70 seconds for one real query
- OSRM (routing) — usually fast, but goes down in waves

Measured during testing on 2026-08-27 to 2026-09-01:

- Six of seven public Overpass instances unreachable worldwide on one day
- A trivial no-op query queued 5–14 seconds on the surviving server
- OSRM went down four separate times during a single day of testing
- A cold TX_1 build on the live site: resolution succeeded in ~10 minutes,
  then OSRM went down mid-build and the app reported it honestly

There is **no public US-hosted Overpass instance** — verified; the public
network is German, French, Russian, Austrian, Japanese and Taiwanese. Only
three instances carry planet data *and* send the CORS headers a browser
needs, and all three are now in the app's mirror pool with automatic health
probing, a per-host circuit breaker, and honest reporting in the UI.

### What actually fixes it

**Option A — self-host on a US server.** The Texas OSM extract is 0.67 GB.
On a US virtual server (~$12–25/month, ~8 GB RAM, a couple of hours to
import), those 26–70 second queries become 0.2–1 second. Cold builds drop
from ~15 minutes to roughly 10–30 seconds. This generalizes to all 48 states
later. The client's contract already includes a server.

**Option B — precompute Texas, serve as static files.** Because this build is
locked to one state, junctions need not be discovered live at all. Process
the extract once into an index of "road A × road B → intersection point",
host it as static files on the existing domain (US CDN, no monthly cost), and
builds drop to seconds with no Overpass dependency. Cost: about a day of
development, plus a re-run every few months as OSM changes.

**Not recommended: Google or Mapbox.** Neither offers a "where do these two
roads intersect" query. Adopting them would mean rebuilding the resolution
layer around intersection geocoding, paying per request, and getting worse
results on rural farm-to-market roads.

## 7. Deployment

The app is **static files only** — no server component, no database, no build
step for the host.

```
npm install
npm run dev            # development server, http://localhost:5174
npm run build          # production bundle written to dist/
npm run test:parse     # offline parser checks
npm run test:routes    # fixture suite against live OSM data
```

Upload the contents of `dist/` to any static host (Vercel, Netlify, cPanel,
nginx). On Vercel the project auto-detects Vite; production deploys from
`main`.

Runtime data services, all over HTTPS: OpenStreetMap via Overpass, routing via
public OSRM, basemaps by CARTO, geocoding via Nominatim. To move to a private
server, change the endpoint lists in `src/engine/overpass.ts` and
`src/engine/osrm.ts` — nothing else changes.

## 8. Codebase

19 commits, ~5,800 lines of TypeScript, three runtime dependencies
(`react`, `react-dom`, `maplibre-gl`). No paid APIs, no API keys.

```
src/engine/     parsing, OSM resolution, routing, validation — no DOM, runs in node
  parse.ts      instruction dialects, permit tables, paste repair      (525 lines)
  refs.ts       TxDOT ↔ OSM road-reference conventions                 (182)
  discover.ts   server-side junction discovery                         (385)
  resolve.ts    waypoint resolution, chain solver                      (819)
  overpass.ts   OSM client: mirrors, health, caching, breaker          (645)
  osrm.ts       routing with claimed-mileage arbitration               (292)
  statepoly.ts  state outlines, strict clipping, border crossings      (157)
  roadnet.ts    road graph, junction geometry                          (415)
  engine.ts     pipeline orchestration and validation                  (313)
src/app/        React UI: map (MapLibre GL), panel, drive mode, simulator
scripts/        test harnesses
fixtures/       38 test inputs: real permits, 20-state synthetics, paste dialects
```

**Scope control:** `LOCKED_STATE` in `src/app/config.ts` is the only thing
making this build Texas-specific. Set it to another state code to lock there,
or to `undefined` to enable all 48 states with a state picker in the UI.
Locking also skips the state-inference lookups on every build.

**Sample routes** in the UI picker are development-only — they sit behind
`import.meta.env.DEV`, so the shipped bundle contains no route data at all.

## 9. Recommended next steps

1. **Fix the data source.** Option A or B in §6. This is the only remaining
   substantive issue, and it is infrastructure, not code. Everything users
   perceive as "the app is slow" or "it doesn't work" traces to it.
2. **Verify deployments by commit.** Vercel keeps every build at its own URL;
   testing an old one looks exactly like a bug that was already fixed. Quick
   check: paste the TX_1 turns JSON and read the chip — 31 legs is current.
3. **Milestones two and three** (California, then the other 47 states) need no
   engine work; flip `LOCKED_STATE` and extend the fixture suite.
