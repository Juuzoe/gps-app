import type { EndpointSpec, Leg, LatLng, ParsedRoute, ProgressFn, RoadRef, Waypoint } from './types'
import { CARDINAL_BEARING, MI, bearing, bearingDiff, fastDist } from './geo'
import {
  fetchExitNodesNear,
  fetchIntersections,
  fetchRoadEdge,
  fetchStreetWays,
  geocodeCity,
  roadExists,
} from './overpass'
import { pickBorderCrossing } from './statepoly'
import { discover, junctionCandidates, type Bounds, type DiscoverEdgeSpec, type DiscoverPairSpec, type JunctionPoint } from './discover'
import { RoadSource, legRadius } from './roadsource'
import { RoadNet } from './roadnet'
import { streetNameRegex } from './refs'
import { resolvePlace, statesBetween, stateInfo, placeName } from './states'

/**
 * Waypoint resolution: instructions + OSM data → an ordered chain of points.
 *
 * The primary path never downloads road geometry to FIND junctions — Overpass
 * is asked for the meeting places themselves (see discover.ts), which turns
 * resolution into a couple of small round trips regardless of route length or
 * shape. Geometry is then fetched only in ~2km discs around the chosen points,
 * for carriageway snapping and short walks. The old geometry-intersection
 * path survives as a per-pair fallback for whatever discovery misses.
 */

export interface ResolvedWaypoint extends Waypoint {
  /** Alternate junction candidates, best-first, for validation retries. */
  alternates: LatLng[]
}

export interface ResolveOutput {
  waypoints: ResolvedWaypoint[]
  warnings: string[]
  errors: string[]
}

export async function determineState(parsed: ParsedRoute, override?: string): Promise<string> {
  if (override) return override
  if (parsed.stateHint) return parsed.stateHint
  const a = parsed.origin.type === 'border' ? resolvePlace(parsed.origin.place) : undefined
  const b = parsed.destination.type === 'border' ? resolvePlace(parsed.destination.place) : undefined
  if (a && b) {
    const candidates = statesBetween(a, b)
    if (candidates.length === 1) return candidates[0]
    if (candidates.length > 1) {
      const road = parsed.origin.type === 'border' ? parsed.origin.road : parsed.legs[0]?.roads[0]
      if (road) {
        for (const c of candidates) {
          // A probe that cannot reach OSM must not sink the build; the first
          // candidate is the better guess than no route at all.
          try {
            if (await roadExists(c, road)) return c
          } catch {
            break
          }
        }
      }
      return candidates[0]
    }
  }
  throw new Error(
    'Could not work out which state this route crosses. Add a border start/end, or pick the state manually.',
  )
}

function endpointRoads(spec: EndpointSpec): RoadRef[] {
  if (spec.type === 'border') return spec.road ? [spec.road] : []
  if (spec.type === 'offset') return [spec.road, spec.ofA, spec.ofB]
  return []
}

/** Roads a transition needs, excluding those shared by both legs (concurrency). */
function transitionRefs(a: Leg, b: Leg): { aRefs: RoadRef[]; bRefs: RoadRef[] } {
  const aKeys = new Set(a.roads.map((r) => r.key))
  const bKeys = new Set(b.roads.map((r) => r.key))
  const aOnly = a.roads.filter((r) => !bKeys.has(r.key))
  const bOnly = b.roads.filter((r) => !aKeys.has(r.key))
  return { aRefs: aOnly.length ? aOnly : a.roads, bRefs: bOnly.length ? bOnly : b.roads }
}

export async function resolveWaypoints(
  source: RoadSource,
  parsed: ParsedRoute,
  progress: ProgressFn,
): Promise<ResolveOutput> {
  const warnings: string[] = []
  const errors: string[] = []
  const legs = parsed.legs
  const state = source.state
  if (legs.length === 0) {
    return { waypoints: [], warnings, errors: ['No drivable legs found in the input.'] }
  }

  const wp: ResolvedWaypoint[] = []
  const streetKey = (leg: Leg) => `street:${leg.index}`
  const mk = (p: Omit<ResolvedWaypoint, 'alternates'> & { alternates?: LatLng[] }): ResolvedWaypoint => ({
    alternates: [], ...p,
  })
  const step = (i: number) => 0.4 + 0.35 * (i / Math.max(1, legs.length))

  /* ---------------- discovery: every junction and border in 1-3 requests --- */
  const pairSpecs: DiscoverPairSpec[] = []
  for (let k = 0; k < legs.length - 1; k++) {
    const a = legs[k]
    const b = legs[k + 1]
    if (a.kind !== 'road' || b.kind !== 'road') continue
    const { aRefs, bRefs } = transitionRefs(a, b)
    pairSpecs.push({ id: `pair:${k}`, a: aRefs, b: bRefs })
  }
  const edgeSpecs: DiscoverEdgeSpec[] = []
  const origin = parsed.origin
  const dest = parsed.destination
  const originRoad =
    origin.type === 'border' ? origin.road ?? (legs[0].kind === 'road' ? legs[0].roads[0] : undefined) : undefined
  const destRoad =
    dest.type === 'border'
      ? dest.road ?? (legs[legs.length - 1].kind === 'road' ? legs[legs.length - 1].roads[0] : undefined)
      : undefined
  if (originRoad) edgeSpecs.push({ id: 'edge:o', road: originRoad })
  if (destRoad && destRoad.key !== originRoad?.key) edgeSpecs.push({ id: 'edge:d', road: destRoad })

  // Lookups that do not depend on discovery run alongside it instead of
  // serially after it: the offset-origin intersection and the destination
  // geocode each cost a round trip of their own.
  const originIsectPromise =
    origin.type === 'offset'
      ? (() => {
          const anchorRef = legs
            .filter((l) => l.kind === 'road')
            .flatMap((l) => l.roads)
            .find((rd) => rd.key !== origin.road.key && rd.key !== origin.ofA.key && rd.key !== origin.ofB.key)
          return fetchIntersections(state, origin.ofA, origin.ofB, anchorRef)
        })()
      : undefined
  // A rejection before its await site is reached is otherwise unhandled and
  // kills the whole build (fatally, under node) — the await's own try/catch
  // still sees the error.
  originIsectPromise?.catch(() => {})
  const destCityPromise = dest.type === 'city' ? geocodeCity(dest.name, state).catch(() => undefined) : undefined

  // Two rounds, because the endpoints bound the search for everything else.
  //
  // Round 1 resolves the border endpoints (statewide, unavoidable — a border
  // is by definition at the state's edge). Round 2 then looks for junctions
  // only inside the box those endpoints span, padded for the route's own
  // wandering. A scan's cost tracks the area it covers: measured on three
  // panhandle roads, statewide Texas took 43.3s against 24.2s for the
  // corridor. Nothing here is tuned to a particular route — the bound comes
  // from the route's own ends.
  progress({ phase: 'fetch', message: 'Locating the route endpoints…', ratio: 0.1 })
  const edgeDisc = edgeSpecs.length
    ? await discover(state, [], edgeSpecs, (done, total) =>
        progress({
          phase: 'fetch',
          message: `Locating endpoints… (${done} of ${total})`,
          ratio: 0.1 + 0.1 * (total ? done / total : 1),
        }),
      )
    : { pairs: new Map(), edges: new Map(), failedChunks: 0 }

  // Bound each junction search by the route's own chain arithmetic: the
  // junction after leg k is at most the claimed mileage of legs 0..k from the
  // origin anchor, and of legs k+1..end from the destination anchor. Reaches
  // are padded ×1.3 + 20km because claimed mileage can be wrong, and a
  // junction that still escapes its box merely falls to the per-pair
  // fallback rather than being lost. Near an anchor the box is a few tens of
  // km; far from every anchor it degrades honestly to statewide. Nothing here
  // is tuned to a route — only its own claimed numbers bound it.
  let originAnchor: LatLng | undefined
  let destAnchor: LatLng | undefined
  for (const spec of edgeSpecs) {
    const sweep = edgeDisc.edges.get(spec.id)
    if (!sweep || !sweep.pts.length || sweep.capped) continue
    const place = resolvePlace(spec.id === 'edge:o' ? (origin as { place: string }).place : (dest as { place: string }).place)
    if (!place) continue
    const bc = await pickBorderCrossing(sweep.pts, state, place)
    if (!bc) continue
    if (spec.id === 'edge:o') originAnchor = bc.pos
    else destAnchor = bc.pos
  }
  if (!destAnchor && destCityPromise) destAnchor = (await destCityPromise) ?? undefined

  const sb = stateInfo(state)?.bbox
  const boxArea = (b: Bounds) => Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))
  const discBox = (p: LatLng, miles: number): Bounds => {
    const reach = miles * MI * 1.3 + 20_000
    const dLat = reach / 110_540
    const dLng = reach / (Math.cos((p.lat * Math.PI) / 180) * 111_320)
    return [p.lat - dLat, p.lng - dLng, p.lat + dLat, p.lng + dLng]
  }
  const cumBefore: number[] = []
  {
    let acc = 0
    for (const l of legs) {
      acc += l.claimedMiles || 0
      cumBefore.push(acc)
    }
  }
  const totalMi = cumBefore[cumBefore.length - 1] ?? 0
  const pairBounds = new Map<string, Bounds>()
  if ((originAnchor || destAnchor) && totalMi > 0 && sb) {
    for (const spec of pairSpecs) {
      const k = Number(spec.id.split(':')[1])
      const discs: Bounds[] = []
      if (originAnchor) discs.push(discBox(originAnchor, cumBefore[k] ?? totalMi))
      if (destAnchor) discs.push(discBox(destAnchor, totalMi - (cumBefore[k] ?? 0)))
      // Intersect the discs' boxes with each other and the state box.
      let box: Bounds = [...sb]
      for (const b of discs) {
        box = [Math.max(box[0], b[0]), Math.max(box[1], b[1]), Math.min(box[2], b[2]), Math.min(box[3], b[3])]
      }
      // Inverted box = the claimed mileages contradict each other; trust
      // neither and search statewide for this pair.
      if (box[0] >= box[2] || box[1] >= box[3]) continue
      if (boxArea(box) < boxArea(sb) * 0.9) pairBounds.set(spec.id, box)
    }
  }
  const bounds = pairBounds.size ? pairBounds : undefined

  progress({ phase: 'fetch', message: `Locating ${pairSpecs.length} junctions…`, ratio: 0.2 })
  const disc = await discover(
    state,
    pairSpecs,
    [],
    (done, total) =>
      progress({
        phase: 'fetch',
        message: total > 1 ? `Locating junctions… (${done} of ${total} lookups)` : 'Locating junctions…',
        ratio: 0.2 + 0.15 * (total ? done / total : 1),
      }),
    bounds,
  )
  for (const [k, v] of edgeDisc.edges) disc.edges.set(k, v)
  disc.failedChunks += edgeDisc.failedChunks
  if (disc.failedChunks > 0) {
    warnings.push(`${disc.failedChunks} junction lookup(s) fell back to slower per-road fetching.`)
  }

  /* ---------------- origin ---------------- */
  let prev: LatLng | undefined

  if (origin.type === 'border') {
    const place = resolvePlace(origin.place)
    if (place && originRoad) {
      const sweep = disc.edges.get('edge:o')
      const bc =
        sweep && sweep.pts.length && !sweep.capped ? await pickBorderCrossing(sweep.pts, state, place) : undefined
      let edge = bc?.pos
      if (!edge) {
        try {
          edge = await borderPoint(source, state, originRoad, place, progress)
        } catch (e) {
          if (isCancel(e)) throw e
        }
      }
      if (edge) {
        prev = edge
        if (bc && !bc.verified && place !== 'MX' && place !== 'CA_INTL') {
          warnings.push(`The ${placeName(place)} outline was unavailable; the border start is a directional estimate.`)
        }
        wp.push(mk({
          pos: prev, legBefore: -1, legAfter: 0,
          label: `${placeName(place)} line · ${originRoad.label}`,
          status: bc && !bc.verified && place !== 'MX' && place !== 'CA_INTL' ? 'approx' : 'ok',
          kind: 'origin',
        }))
      }
    }
    if (!prev) {
      warnings.push(`Could not pin the ${placeName(resolvePlace(origin.place) ?? origin.place)} border start; starting at the first junction instead.`)
    }
  } else if (origin.type === 'offset') {
    progress({ phase: 'resolve', message: `Locating ${origin.ofA.label} & ${origin.ofB.label}…`, ratio: 0.38 })
    // The intersection query has been running alongside discovery; its result
    // is every point where the two roads meet, plus centres of the next
    // distinct road in the itinerary to choose between them (a business route
    // pairs with its parent in several towns).
    try {
      const { nodes, anchorCenters } = await originIsectPromise!
      if (nodes.length) {
        const junction = anchorCenters.length
          ? nodes.reduce((best, n) => {
              const d = (p: LatLng) => Math.min(...anchorCenters.map((c) => fastDist(p, c)))
              return d(n) < d(best) ? n : best
            })
          : nodes[0]
        await source.ensureSoft(
          [origin.road],
          { kind: 'near', center: junction, radiusM: Math.max(10_000, origin.miles * MI * 1.6) },
          progress,
        )
        const hint = origin.dir ? CARDINAL_BEARING[origin.dir] : undefined
        prev = source.netFor([origin.road]).walkAlong(junction, origin.miles * MI, hint) ?? junction
        wp.push(mk({ pos: prev, legBefore: -1, legAfter: 0, label: `Origin · ${origin.road.label}`, status: 'ok', kind: 'origin' }))
      }
    } catch (e) {
      if (isCancel(e)) throw e
    }
    if (!prev) {
      warnings.push(`Could not locate the ${origin.ofA.label} & ${origin.ofB.label} intersection; starting at the first junction instead.`)
    }
  } else if (origin.type === 'city') {
    const city = await geocodeCity(origin.name, state)
    if (city && legs[0].kind === 'road') {
      await source.ensureSoft(legs[0].roads, { kind: 'near', center: city, radiusM: 60_000 }, progress)
      const snap = source.netFor(legs[0].roads).nearest(city, 60_000)
      if (snap) {
        prev = snap.pos
        wp.push(mk({ pos: snap.pos, legBefore: -1, legAfter: 0, label: `${origin.name} · ${legs[0].label}`, status: 'approx', kind: 'origin' }))
      }
    }
    if (!prev) warnings.push(`Could not geocode origin “${origin.name}”; starting at the first junction instead.`)
  }

  /* ---------------- junctions: collect, then choose globally ---------------- */
  // Candidate CHOICE is a chain problem, not a per-pair one: a greedy pick that
  // is slightly off shifts the distance baseline for every later leg, and the
  // errors compound. So candidates are collected first, then a small dynamic
  // program picks the sequence that best agrees with ALL the claimed
  // distances at once — anchored at the origin and, when known, at the
  // destination border, so the chain is pinned from both ends.

  // The destination border point is cheap to compute now (its centres came
  // back with discovery) and anchors the end of the chain.
  let earlyDest: LatLng | undefined
  if (dest.type === 'border' && destRoad) {
    const place = resolvePlace(dest.place)
    const sweep = disc.edges.get(destRoad.key === originRoad?.key ? 'edge:o' : 'edge:d')
    if (place && sweep && sweep.pts.length && !sweep.capped) {
      earlyDest = (await pickBorderCrossing(sweep.pts, state, place))?.pos
    }
  }

  interface PairEntry {
    cands: JunctionPoint[]
    exits: LatLng[]
  }
  const perPair: (PairEntry | undefined)[] = []
  let greedyPrev = prev

  for (let k = 0; k < legs.length - 1; k++) {
    const a = legs[k]
    const b = legs[k + 1]
    progress({ phase: 'resolve', message: `Locating ${a.label} → ${b.label}…`, ratio: step(k) })

    // Street legs are fetched by name around the current position.
    for (const leg of [a, b]) {
      if (leg.kind === 'street' && !source.netByKey(streetKey(leg))) {
        const center = greedyPrev ?? wp[0]?.pos
        if (!center) { source.adopt(streetKey(leg), leg.label, []); continue }
        try {
          const ways = await fetchStreetWays(
            streetNameRegex(leg.streetName ?? leg.label),
            center,
            Math.max(8_000, (a.claimedMiles + 2) * MI * 1.6),
          )
          source.adopt(streetKey(leg), leg.label, ways)
        } catch (e) {
          if (isCancel(e)) throw e
          source.adopt(streetKey(leg), leg.label, [])
        }
      }
    }

    const minGap = a.claimedMiles > 0 ? Math.min(400, a.claimedMiles * MI * 0.5) : 400
    let candidates: JunctionPoint[] = []
    const discovered = disc.pairs.get(`pair:${k}`)
    if (discovered) candidates = junctionCandidates(discovered)
    if (greedyPrev) candidates = candidates.filter((c) => fastDist(c.pos, greedyPrev!) > minGap)
    if (candidates.length === 0) {
      // Fallback: the old geometry-intersection path, scoped to this pair.
      candidates = await pairFallback(source, state, a, b, greedyPrev, minGap, streetKey, progress)
    }
    if (candidates.length === 0) {
      perPair.push(undefined)
      continue
    }

    // Exit numbers break ties; only fetched when there is a tie to break.
    let exits: LatLng[] = []
    if (candidates.length > 1 && a.exitAtEnd && a.kind === 'road' && a.roads.length) {
      const center = candidates.reduce(
        (acc, c) => ({ lat: acc.lat + c.pos.lat / candidates.length, lng: acc.lng + c.pos.lng / candidates.length }),
        { lat: 0, lng: 0 },
      )
      try {
        exits = await fetchExitNodesNear(a.roads[0], a.exitAtEnd, center, 150_000)
      } catch (e) {
        if (isCancel(e)) throw e
      }
    }
    perPair.push({ cands: candidates.slice(0, 8), exits })

    // Advance a provisional position so later fallbacks and minGap filters
    // have something local to work from; the DP below makes the real choice.
    const targetM = a.claimedMiles > 0 ? a.claimedMiles * MI : undefined
    greedyPrev = candidates.reduce((best, c) => {
      const cost = (p: JunctionPoint) =>
        greedyPrev && targetM !== undefined
          ? Math.abs(fastDist(greedyPrev, p.pos) * 1.15 - targetM)
          : greedyPrev
            ? fastDist(greedyPrev, p.pos)
            : 0
      return cost(c) < cost(best) ? c : best
    }).pos
  }

  // Viterbi over each contiguous run of pairs that have candidates.
  const edgeCost = (from: LatLng | undefined, to: LatLng, claimedMiles: number, dir?: keyof typeof CARDINAL_BEARING): number => {
    if (!from) return 0
    const d = fastDist(from, to)
    let err = claimedMiles > 0 ? Math.abs(d * 1.15 - claimedMiles * MI) : d * 0.15
    if (dir) {
      const diff = bearingDiff(bearing(from, to), CARDINAL_BEARING[dir])
      if (diff > 110) err += 60_000
    }
    return err
  }
  const chosen: (JunctionPoint | undefined)[] = perPair.map(() => undefined)
  const altOf: LatLng[][] = perPair.map(() => [])
  let runStart = 0
  while (runStart < perPair.length) {
    if (!perPair[runStart]) { runStart++; continue }
    let runEnd = runStart
    while (runEnd + 1 < perPair.length && perPair[runEnd + 1]) runEnd++
    const startAnchor = runStart === 0 ? prev : undefined
    const endAnchor = runEnd === perPair.length - 1 ? earlyDest : undefined
    const dp: number[][] = []
    const back: number[][] = []
    for (let k = runStart; k <= runEnd; k++) {
      const e = perPair[k]!
      const leg = legs[k]
      const row: number[] = []
      const brow: number[] = []
      for (let i = 0; i < e.cands.length; i++) {
        const c = e.cands[i]
        const bonus = e.exits.some((p) => fastDist(p, c.pos) < 2500) ? -30_000 : 0
        if (k === runStart) {
          row.push(edgeCost(startAnchor, c.pos, leg.claimedMiles, leg.dir) + bonus)
          brow.push(-1)
        } else {
          let best = Infinity
          let bj = 0
          const prevE = perPair[k - 1]!
          for (let j = 0; j < prevE.cands.length; j++) {
            const v = dp[k - 1 - runStart][j] + edgeCost(prevE.cands[j].pos, c.pos, leg.claimedMiles, leg.dir)
            if (v < best) { best = v; bj = j }
          }
          row.push(best + bonus)
          brow.push(bj)
        }
      }
      dp.push(row)
      back.push(brow)
    }
    // terminal: pull the run toward the destination anchor along the last leg
    const lastRow = dp[dp.length - 1]
    const lastE = perPair[runEnd]!
    let endBest = 0
    let endVal = Infinity
    for (let i = 0; i < lastRow.length; i++) {
      const t = endAnchor
        ? edgeCost(lastE.cands[i].pos, endAnchor, legs[legs.length - 1].claimedMiles, legs[legs.length - 1].dir)
        : 0
      if (lastRow[i] + t < endVal) { endVal = lastRow[i] + t; endBest = i }
    }
    // backtrack
    let idx = endBest
    for (let k = runEnd; k >= runStart; k--) {
      const e = perPair[k]!
      chosen[k] = e.cands[idx]
      altOf[k] = e.cands.filter((_, i) => i !== idx).slice(0, 3).map((c) => c.pos)
      idx = back[k - runStart][idx]
    }
    runStart = runEnd + 1
  }

  // Discard junctions the claimed mileage cannot support.
  //
  // The chain solver must pick something from every non-empty candidate list,
  // so when the real junction is absent from OSM it settles for the least-bad
  // candidate — which can sit at the far end of a long road. One permit turns
  // off Spur 57 after 0.3 mi, Spur 57 runs ten miles, and OSM records no
  // connection at all between it and the road the permit turns onto, so the
  // chain routed ten miles up the spur and back.
  //
  // The claimed mileage is the instruction's own statement of how far apart
  // consecutive junctions are, so a candidate many times farther than that is
  // not evidence of a junction. Dropping it hands the pair to the existing
  // "never meet" path: the turn is flagged and bridged, which is both honest
  // and shorter than the detour. The allowance is deliberately loose (3x plus
  // 8km) because source mileages are approximate; this catches misplacement,
  // not imprecision.
  {
    let ref = prev
    for (let k = 0; k < chosen.length; k++) {
      const c = chosen[k]
      if (!c) continue
      const claimedM = (legs[k]?.claimedMiles ?? 0) * MI
      if (ref && claimedM > 0) {
        const gap = fastDist(ref, c.pos)
        if (gap > claimedM * 3 + 8_000) {
          chosen[k] = undefined
          altOf[k] = []
          continue
        }
      }
      ref = c.pos
    }
  }

  // Emit waypoints in route order.
  for (let k = 0; k < legs.length - 1; k++) {
    const a = legs[k]
    const b = legs[k + 1]
    const pick = chosen[k]
    if (!pick) {
      if (a.kind !== 'road' && b.kind !== 'road') continue
      const msg = `${a.label} and ${b.label} never meet in ${placeName(state)}`
      const tiny = a.claimedMiles + b.claimedMiles <= 20
      wp.push(mk({
        pos: prev ?? { lat: 0, lng: 0 }, legBefore: k, legAfter: k + 1,
        label: `${a.label} → ${b.label}`, status: tiny ? 'skipped' : 'failed', note: msg, kind: 'junction',
      }))
      if (tiny) {
        warnings.push(`${msg} on the map data; the short ${a.label} → ${b.label} turn is bridged by the fastest road.`)
      } else {
        errors.push(`${msg}. Check the instruction; routing bridges this gap by the fastest road.`)
      }
      continue
    }
    prev = pick.pos
    wp.push(mk({
      pos: pick.pos, legBefore: k, legAfter: k + 1,
      label: `${a.label} → ${b.label}`,
      status: pick.exact ? 'ok' : 'approx',
      kind: 'junction',
      alternates: altOf[k],
    }))
  }

  // Snap-refinement geometry is NOT fetched here. Junction points are already
  // on the roads (shared nodes) or within a few hundred metres of them; the
  // engine routes first and calls refineWaypoints() only when validation says
  // a snap actually went wrong — so clean builds never pay for it.

  /* ---------------- destination ---------------- */
  const last = legs[legs.length - 1]
  let destPos: LatLng | undefined
  let destLabel = 'Destination'
  let destStatus: Waypoint['status'] = 'ok'
  progress({ phase: 'resolve', message: 'Locating the destination…', ratio: 0.85 })

  const lastNet = () =>
    last.kind === 'street' ? source.netByKey(streetKey(last)) ?? new RoadNet(last.label, []) : source.netFor(last.roads)

  if (dest.type === 'border') {
    const place = resolvePlace(dest.place)
    if (place && destRoad) {
      destPos = earlyDest
      if (!destPos) {
        const sweep = disc.edges.get(destRoad.key === originRoad?.key ? 'edge:o' : 'edge:d')
        if (sweep && sweep.pts.length && !sweep.capped) {
          destPos = (await pickBorderCrossing(sweep.pts, state, place))?.pos
        }
      }
      if (!destPos) {
        try {
          destPos = await borderPoint(source, state, destRoad, place, progress)
        } catch (e) {
          if (isCancel(e)) throw e
        }
      }
      if (destPos) destLabel = `${placeName(place)} line · ${destRoad.label}`
    }
  } else if (dest.type === 'city') {
    destLabel = dest.name
    if (prev && last.claimedMiles > 0) {
      await source.ensureSoft(
        last.roads,
        { kind: 'near', center: prev, radiusM: Math.min(200_000, Math.max(15_000, last.claimedMiles * MI * 1.5)) },
        progress,
      )
      const hint = last.dir ? CARDINAL_BEARING[last.dir] : undefined
      destPos = lastNet().walkAlong(prev, last.claimedMiles * MI, hint)
      destStatus = 'approx'
    }
    if (!destPos) {
      const city = await destCityPromise
      if (city) {
        await source.ensureSoft(last.roads, { kind: 'near', center: city, radiusM: 60_000 }, progress)
        destPos = lastNet().nearest(city, 60_000)?.pos ?? city
      }
      destStatus = 'approx'
    }
  } else if (dest.type === 'offset') {
    // Same one-shot intersection lookup as the origin; the nearest meeting
    // point to where the route already is disambiguates between towns.
    try {
      const { nodes } = await fetchIntersections(state, dest.ofA, dest.ofB)
      if (nodes.length && prev) {
        const junction = nodes.reduce((best, n) => (fastDist(n, prev!) < fastDist(best, prev!) ? n : best))
        await source.ensureSoft(
          [dest.road],
          { kind: 'near', center: junction, radiusM: Math.max(10_000, dest.miles * MI * 1.6) },
          progress,
        )
        destPos =
          source.netFor([dest.road]).walkAlong(junction, dest.miles * MI, dest.dir ? CARDINAL_BEARING[dest.dir] : undefined) ??
          junction
        destLabel = `Destination · ${dest.road.label}`
      }
    } catch (e) {
      if (isCancel(e)) throw e
    }
  } else if (prev && last.claimedMiles > 0) {
    await source.ensureSoft(
      last.roads,
      { kind: 'near', center: prev, radiusM: Math.min(200_000, Math.max(15_000, last.claimedMiles * MI * 1.5)) },
      progress,
    )
    const hint = last.dir ? CARDINAL_BEARING[last.dir] : undefined
    destPos = lastNet().walkAlong(prev, last.claimedMiles * MI, hint)
    destLabel = `End of ${last.label}`
    destStatus = 'approx'
  }

  // Last resort: estimate from the final leg's claimed distance. An
  // approximate end beats dropping the whole last leg.
  if (!destPos && prev && last.claimedMiles > 0) {
    await source.ensureSoft(
      last.roads,
      { kind: 'near', center: prev, radiusM: Math.min(200_000, Math.max(15_000, last.claimedMiles * MI * 1.5)) },
      progress,
    )
    const hint = last.dir ? CARDINAL_BEARING[last.dir] : undefined
    destPos = lastNet().walkAlong(prev, last.claimedMiles * MI, hint)
    if (destPos) {
      destStatus = 'approx'
      destLabel = `End of ${last.label} (estimated)`
      warnings.push(
        `Could not confirm the destination against OSM; it is estimated ${last.claimedMiles.toFixed(1)} mi along ${last.label}.`,
      )
    }
  }

  if (destPos) {
    wp.push(mk({ pos: destPos, legBefore: legs.length - 1, legAfter: legs.length, label: destLabel, status: destStatus, kind: 'destination' }))
  } else {
    errors.push('Could not resolve the destination. The route ends at the last resolvable junction.')
  }

  return { waypoints: wp, warnings: [...source.errors, ...warnings], errors }
}

/**
 * Snap refinement, run by the engine only when validation shows a snap went
 * wrong: fetch ~2km of geometry around each chosen point, snap to the correct
 * carriageway, and nudge past the interchange. Off the critical path because
 * the majority of builds route correctly from the raw junction points, and
 * this was a 20-60s network phase every one of them paid.
 */
export async function refineWaypoints(
  source: RoadSource,
  parsed: ParsedRoute,
  out: ResolveOutput,
  progress: ProgressFn,
): Promise<void> {
  const legs = parsed.legs
  const streetKey = (leg: Leg) => `street:${leg.index}`
  const wp = out.waypoints

  const entries: { ref: RoadRef; scope: { kind: 'near'; center: LatLng; radiusM: number } }[] = []
  for (const w of wp) {
    if (w.status !== 'ok' && w.status !== 'approx') continue
    const around = new Map<string, RoadRef>()
    for (const li of [w.legBefore, w.legAfter]) {
      const leg = legs[li]
      if (leg && leg.kind === 'road') for (const r of leg.roads) around.set(r.key, r)
    }
    for (const r of around.values()) entries.push({ ref: r, scope: { kind: 'near', center: w.pos, radiusM: 2500 } })
  }
  if (entries.length) {
    progress({ phase: 'fetch', message: 'Fetching geometry around the junctions…', ratio: 0.9 })
    await source.ensureManySoft(entries, progress)
  }

  const usable = wp.filter((w) => w.status === 'ok' || w.status === 'approx')
  for (let i = 0; i < usable.length; i++) {
    const here = usable[i]
    const next = usable[i + 1]
    const before = usable[i - 1]
    const travel = next ? bearing(here.pos, next.pos) : before ? bearing(before.pos, here.pos) : undefined
    if (travel === undefined) continue
    here.bearing = travel
    const targetLeg = legs[Math.min(here.legAfter, legs.length - 1)]
    const net =
      targetLeg.kind === 'street'
        ? source.netByKey(streetKey(targetLeg))
        : source.netFor(targetLeg.roads)
    if (!net || net.empty) continue
    const snapped = net.snapForBearing(here.pos, travel, 260)
    if (snapped && snapped.distM < 600) {
      here.pos = snapped.pos
      here.bearing = bearingDiff(snapped.tangent, travel) <= 90 ? snapped.tangent : (snapped.tangent + 180) % 360
      if (here.kind === 'junction') {
        const nudgeM = Math.min(350, Math.max(80, targetLeg.claimedMiles * MI * 0.3))
        const nudged = net.walkAlong(here.pos, nudgeM, here.bearing)
        if (nudged && fastDist(nudged, here.pos) < 900) here.pos = nudged
      }
    }
  }
}

/**
 * Old geometry-intersection junction finding, kept as a per-pair fallback for
 * whatever server-side discovery misses (a failed chunk, or map data quirks).
 */
async function pairFallback(
  source: RoadSource,
  state: string,
  a: Leg,
  b: Leg,
  prev: LatLng | undefined,
  minGap: number,
  streetKey: (leg: Leg) => string,
  progress: ProgressFn,
): Promise<JunctionPoint[]> {
  const { aRefs, bRefs } = transitionRefs(a, b)
  const roadRefs = [...(a.kind === 'road' ? aRefs : []), ...(b.kind === 'road' ? bRefs : [])]
  try {
    if (roadRefs.length) {
      if (prev && a.claimedMiles > 0) {
        await source.ensureSoft(roadRefs, { kind: 'near', center: prev, radiusM: legRadius(a.claimedMiles) }, progress)
      }
      const missing = roadRefs.filter((r) => source.isEmpty(r) && !source.hasStatewide(r))
      if (missing.length) await source.ensureSoft(missing, { kind: 'state', code: state }, progress)
    }
  } catch (e) {
    if (isCancel(e)) throw e
  }
  const netA = a.kind === 'street' ? source.netByKey(streetKey(a)) ?? new RoadNet(a.label, []) : source.netFor(aRefs)
  const netB = b.kind === 'street' ? source.netByKey(streetKey(b)) ?? new RoadNet(b.label, []) : source.netFor(bRefs)
  if (netA.empty || netB.empty) return []
  let cands = netA.junctionsWith(netB)
  if (prev) cands = cands.filter((c) => fastDist(c.pos, prev!) > minGap)
  if (cands.length === 0) {
    cands = netA.junctionsWith(netB, 900)
    if (prev) cands = cands.filter((c) => fastDist(c.pos, prev!) > minGap)
  }
  return cands.map((c) => ({ pos: c.onOther, exact: c.kind === 'shared' || c.gapM < 120 }))
}

/**
 * Where a road crosses into the neighbouring place — fallback for when the
 * discovery query's centre sweep came back empty.
 */
async function borderPoint(
  source: RoadSource,
  state: string,
  road: RoadRef,
  place: string,
  progress: ProgressFn,
): Promise<LatLng | undefined> {
  const edge = await fetchRoadEdge(state, road, place).catch(() => undefined)
  if (edge) {
    await source.ensureSoft([road], { kind: 'near', center: edge, radiusM: 40_000 }, progress)
    return source.net(road).nearest(edge, 30_000)?.pos ?? edge
  }
  await source.ensureSoft([road], { kind: 'state', code: state }, progress)
  const net = source.net(road)
  if (net.empty) return undefined
  const eps = net.endpoints().map((e) => e.pos)
  return (await pickBorderCrossing(eps, state, place))?.pos
}

function isCancel(e: unknown): boolean {
  return e instanceof Error && e.name === 'CancelledError'
}

export { RoadSource, endpointRoads }
