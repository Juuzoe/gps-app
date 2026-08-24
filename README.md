# GPS Path

Turn a written list of highway turns into a route you can drive on a real map.

Feed it this:

```json
{
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
}
```

You get a routed drive from the Indiana state line near Terre Haute to the Jefferson Barracks Bridge outside St. Louis: 171.5 miles of real road geometry, a turn list, a vehicle that drives it, and a per-step comparison of what the instructions claim against what the road network says.

The whole app compiles into one HTML file you can email or drop on any static host.

## Run it

```bash
npm install
```

```bash
npm run build
```

That writes `dist/gps-path.html`. Open it from disk, or serve it. Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Rebuild on save, serve http://localhost:5173 |
| `npm run check` | Typecheck with no emit |
| `npm run gif` | Record `dist/demo.gif` in headless Edge or Chrome |
| `npm run video` | Record `dist/demo.mp4` through the bundled ffmpeg |
| `npm run anchors` | Re-derive the border coordinates from live map data |
| `npm run fallback` | Refresh the embedded offline route snapshot |

The page needs network for map tiles and routing. When both routing servers fail, it falls back to a snapshot of the demo route baked into the bundle.

## Input format

Paste a `turns` array, a bare JSON array, or one instruction per line. The parser tolerates `//` comments and trailing commas, so you can paste straight from a chat message.

Each line names one or more roads and, in parentheses, how far you stay on them:

```
I-255 Exit 10 toward I-270 (15.2 mi)
```

`I-70`, `US 50`, `IL-15` all parse. So do direction suffixes (`I-70 W`), slash-joined concurrencies (`I-55/I-70`), `Exit 10`, and `toward St Louis`.

Two lines carry the endpoints:

```
Border Start: Indiana - I-70
Border End: Missouri - I-255
```

Name the state on the far side of the line, and the road that crosses it.

## How it works

**Parse.** [`src/parser.ts`](src/parser.ts) pulls road references, stated miles, exit numbers and destinations out of each line. Stated miles enter the pipeline as claims, never as truth.

**Anchor.** [`src/gazetteer.ts`](src/gazetteer.ts) turns the two border lines into coordinates. Indiana and Missouri both border Illinois, so the resolver picks the pair of crossings that agree on one traversed state, then aims the end point past the line so the bridge gets driven rather than clipped.

**Route.** [`src/router.ts`](src/router.ts) asks OSRM for driving geometry, passing an approach bearing at each anchor so the route snaps to the westbound carriageway instead of the one across the median. Two public servers, then the offline snapshot.

**Audit.** [`src/aligner.ts`](src/aligner.ts) maps every instruction onto a slice of the polyline. Where a road reference proves a step (the I-255 merge), it pins the boundary. Where the stated distance lands near a physical fork, it snaps. Everything else it distributes by stated distance and marks with `≈`. A step that misses its claim by more than 2 miles and 15 percent gets flagged in the list and counted in the totals.

**Drive.** [`src/gps.ts`](src/gps.ts) moves a vehicle along the polyline at 65 mph, from ×1 to ×250, emitting position, heading, speed, odometer and the current instruction.

**Show.** [`src/main.ts`](src/main.ts) and [`src/ui.ts`](src/ui.ts) draw the Leaflet map, the route, the traveled trail, state line flags and the heads-up display with highway shields, next maneuver and time left.

## Adding routes beyond the demo

The gazetteer ships with the two crossings this demo needs. You have two ways to go further.

Append coordinates to a border line and skip the lookup:

```
Border Start: Indiana - I-70 @39.4367,-87.5312
```

Or add an entry to [`src/data/border-crossings.json`](src/data/border-crossings.json). [`scripts/derive-anchors.mjs`](scripts/derive-anchors.mjs) shows how the shipped ones came to be: route across a border with OSRM, then bisect the geometry against Nominatim reverse geocoding until the state name flips.

## Known limits

Instruction distances are often wrong. That is the point of the audit, and the demo route proves it: the first leg claims 58.3 miles and drives 63.2.

OSRM reports road references only at maneuvers. A concurrency that starts and ends mid-highway, like the 5 miles of I-57 overlap at Effingham, leaves no trace in the route data. The engine estimates those boundaries from the stated distances and marks them `≈` rather than pretending to confirm them.

## Scripting the page

`window.__gpsPath` exposes `build`, `cam`, `seekFrac`, `state`, `tilesReady` and `mapIdle`. Load the page with `?capture=1` to disable animation and autoplay. The recorders in [`scripts/`](scripts) use both to step through frames one at a time.
