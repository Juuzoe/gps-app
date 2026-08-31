import type { LatLng, LegReport, ProgressFn, RouteResult } from './types'
import { MI, cumulativeMeters } from './geo'
import { parseInput } from './parse'
import { determineState, refineWaypoints, resolveWaypoints, type ResolvedWaypoint } from './resolve'
import { RoadSource } from './roadsource'
import { loadStatePolygon } from './statepoly'
import { routeChain, type OsrmRoute } from './osrm'
import { refMatcher, streetNameRegex } from './refs'

export interface BuildOptions {
  /** Two-letter state override; otherwise inferred from the input. */
  state?: string
  onProgress?: ProgressFn
}

/** Parse instructions, resolve them against OSM, route with OSRM, validate. */
export async function buildRoute(input: string, options: BuildOptions = {}): Promise<RouteResult> {
  const progress: ProgressFn = options.onProgress ?? (() => {})

  progress({ phase: 'parse', message: 'Reading instructions…', ratio: 0.02 })
  const parsed = parseInput(input)
  if (parsed.legs.length === 0) {
    throw new Error('No drivable instructions found. Paste a turns list or a permit route table.')
  }

  progress({ phase: 'state', message: 'Working out the state…', ratio: 0.06 })
  const state = await determineState(parsed, options.state)
  await loadStatePolygon(state)

  const source = new RoadSource(state)
  const resolved = await resolveWaypoints(source, parsed, progress)

  const usable = () => resolved.waypoints.filter((w) => w.status === 'ok' || w.status === 'approx')
  let chain = usable()
  if (chain.length < 2) {
    throw new Error(
      ['Not enough of the route could be located to build a drivable path.', ...resolved.errors, ...resolved.warnings].join(' '),
    )
  }

  progress({ phase: 'route', message: `Routing ${chain.length} waypoints…`, ratio: 0.82 })
  const pairProblems: string[] = []
  // The instructions' own mileage for each waypoint interval — routeChain uses
  // it to arbitrate between snap variants (see osrm.ts).
  const targetsFor = (ch: ResolvedWaypoint[]): (number | undefined)[] => {
    const out: (number | undefined)[] = []
    for (let i = 0; i + 1 < ch.length; i++) {
      const from = Math.max(0, ch[i].legAfter)
      const to = Math.min(parsed.legs.length - 1, ch[i + 1].legBefore)
      let sum = 0
      for (let k = from; k <= to; k++) sum += parsed.legs[k]?.claimedMiles ?? 0
      out.push(sum > 0 ? sum : undefined)
    }
    return out
  }
  // A via candidate pins a leg back onto its instructed road when routing
  // shortcuts off it (see routeChain). Candidates are the road's own points
  // farthest from the straight line between the two junctions, one per side —
  // for a loop road those are the two arcs, and the claimed mileage picks
  // between them.
  const viaFor = (ch: ResolvedWaypoint[]) => async (i: number): Promise<LatLng[]> => {
    const from = Math.max(0, ch[i].legAfter)
    const to = Math.min(parsed.legs.length - 1, ch[i + 1].legBefore)
    if (from !== to) return []
    const leg = parsed.legs[from]
    if (leg.kind !== 'road' || !leg.roads.length || leg.claimedMiles <= 2) return []
    const a = ch[i].pos
    const b = ch[i + 1].pos
    const mid = { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }
    const radius = Math.max(8_000, leg.claimedMiles * MI * 0.75)
    await source.ensureMany(leg.roads.map((r) => ({ ref: r, scope: { kind: 'near' as const, center: mid, radiusM: radius } })))
    const net = source.netFor(leg.roads)
    // Signed offset from the a→b chord, in metres; the extreme on each side.
    const kx = Math.cos((mid.lat * Math.PI) / 180) * 111_320
    const abx = (b.lng - a.lng) * kx
    const aby = (b.lat - a.lat) * 110_540
    const len = Math.hypot(abx, aby) || 1
    let hi: { p: LatLng; d: number } | undefined
    let lo: { p: LatLng; d: number } | undefined
    for (const p of net.nodePos.values()) {
      const d = ((p.lng - a.lng) * kx * aby - (p.lat - a.lat) * 110_540 * abx) / len
      if (d > (hi?.d ?? 0)) hi = { p, d }
      if (d < (lo?.d ?? 0)) lo = { p, d }
    }
    // A via less than 1.5km off the chord adds nothing the direct route lacks.
    return [hi, lo].filter((x): x is { p: LatLng; d: number } => !!x && Math.abs(x.d) > 1500).map((x) => x.p)
  }

  let osrm = await routeChain(
    chain.map((w) => ({ pos: w.pos, bearing: w.bearing })),
    (i, msg) => pairProblems.push(`Segment ${i + 1}: ${msg}`),
    targetsFor(chain),
    viaFor(chain),
  )

  // Zero routed distance across every segment means the routing service was
  // unreachable, not that the route resolved wrongly — say so, instead of
  // letting the wrong-place verdict blame the resolution.
  if (osrm.distance === 0 && chain.length >= 2) {
    throw new Error(
      'The routing service (OSRM) is unreachable right now. The junctions resolved fine and are cached — retry in a minute and the route will build without refetching.',
    )
  }

  progress({ phase: 'validate', message: 'Checking the route against the instructions…', ratio: 0.88 })
  let reports = legReports(parsed, chain, osrm)
  // Credit miles routed on matching roads only up to the instruction's claim,
  // and charge for overshoot: the old sum of matched miles literally rewarded
  // wrong-carriageway detours, because 25 wrong miles of I-40 outscored the
  // correct 11.
  const score = (rs: LegReport[]) =>
    rs.reduce((s, r) => {
      const routed = r.routedMiles ?? 0
      const cap = r.claimedMiles > 0 ? r.claimedMiles : routed
      return s + (r.refMatch ?? 1) * Math.min(routed, cap) - 0.7 * Math.max(0, routed - (cap * 1.25 + 1))
    }, 0)

  // Snap refinement runs only when validation says a snap went wrong. Most
  // builds route correctly straight from the raw junction points, so most
  // builds never pay for the refinement geometry at all.
  const needsRefine =
    pairProblems.length > 0 ||
    reports.some((r) => r.status === 'warn' || (r.refMatch !== undefined && r.refMatch < 0.85))
  if (needsRefine) {
    await refineWaypoints(source, parsed, resolved, progress)
    const chainR = usable()
    try {
      const osrmR = await routeChain(chainR.map((w) => ({ pos: w.pos, bearing: w.bearing })), undefined, targetsFor(chainR), viaFor(chainR))
      const reportsR = legReports(parsed, chainR, osrmR)
      if (score(reportsR) >= score(reports)) {
        osrm = osrmR
        reports = reportsR
        chain = chainR
      }
    } catch {
      /* keep the unrefined route */
    }
  }

  // One retry: the worst-matching junction swaps to its next-best candidate.
  const worst = reports
    .filter(
      (r) =>
        r.status !== 'skipped' &&
        (r.refMatch ?? 1) < 0.45 &&
        r.claimedMiles > 2 &&
        // Matching mileage means the junction is right and OSM is merely
        // missing ref tags — a re-route would change nothing, and it costs a
        // full extra OSRM round trip on every build of such a route.
        (r.routedMiles === undefined || Math.abs(r.routedMiles - r.claimedMiles) > Math.max(2, r.claimedMiles * 0.2)),
    )
    .sort((a, b) => (a.refMatch ?? 1) - (b.refMatch ?? 1))[0]
  if (worst) {
    const wpIdx = resolved.waypoints.findIndex(
      (w) => (w.legAfter === worst.leg.index || w.legBefore === worst.leg.index) && w.alternates.length > 0,
    )
    if (wpIdx >= 0) {
      const original = resolved.waypoints[wpIdx].pos
      resolved.waypoints[wpIdx].pos = resolved.waypoints[wpIdx].alternates[0]
      const chain2 = usable()
      try {
        const osrm2 = await routeChain(chain2.map((w) => ({ pos: w.pos, bearing: undefined })), undefined, targetsFor(chain2), viaFor(chain2))
        const reports2 = legReports(parsed, chain2, osrm2)
        if (score(reports2) > score(reports)) {
          osrm = osrm2
          reports = reports2
          chain = chain2
        } else {
          resolved.waypoints[wpIdx].pos = original
        }
      } catch {
        resolved.waypoints[wpIdx].pos = original
      }
    }
  }

  const geometry = osrm.geometry
  const latlngs = geometry.map(([lng, lat]) => ({ lat, lng }))
  const cumulative = cumulativeMeters(latlngs)

  // Geometry ranges per waypoint pair → attributed to the first spanned leg.
  const legGeometry: RouteResult['legGeometry'] = []
  let acc = 0
  let gi = 0
  for (let i = 0; i < osrm.legs.length; i++) {
    const from = gi
    acc += osrm.legs[i].distance
    while (gi < cumulative.length - 1 && cumulative[gi] < acc - 1) gi++
    legGeometry.push({ legIndex: chain[i].legAfter, from, to: gi })
  }

  const warnings = [...resolved.warnings, ...pairProblems]
  for (const r of reports) {
    if (r.status === 'warn' && r.note) warnings.push(`${r.leg.label}: ${r.note}`)
  }
  const claimed = parsed.claimedTotalMiles
  const routedMi = osrm.distance / MI
  if (claimed) {
    const diff = Math.abs(routedMi - claimed)
    // A wildly wrong total is not a mileage quibble — it means the route
    // resolved in the wrong place (wrong state, wrong border, dropped tail).
    // One such route shipped as "clean" at 32.9 mi against 325 claimed; a
    // partial answer must never be allowed to read as a complete one.
    if (diff > Math.max(claimed * 0.3, 40)) {
      resolved.errors.push(
        `Routed ${routedMi.toFixed(1)} mi against ${claimed.toFixed(1)} mi claimed — the route almost certainly resolved in the wrong place. Treat it as unresolved, not as a shorter route.`,
      )
    } else if (diff > Math.max(claimed * 0.12, 8)) {
      warnings.push(
        `Routed total ${routedMi.toFixed(1)} mi differs from the instructions' ${claimed.toFixed(1)} mi. Check the flagged legs.`,
      )
    }
  }

  progress({ phase: 'done', message: 'Route ready', ratio: 1 })
  return {
    parsed,
    state,
    waypoints: resolved.waypoints,
    geometry,
    cumulative,
    totalMeters: osrm.distance,
    durationSec: osrm.duration,
    legReports: reports,
    legGeometry,
    warnings,
    errors: resolved.errors,
  }
}

/** Compare each routed segment's OSM refs/names against the instructed road. */
function legReports(
  parsed: ReturnType<typeof parseInput>,
  chain: ResolvedWaypoint[],
  osrm: OsrmRoute,
): LegReport[] {
  const reports: LegReport[] = parsed.legs.map((leg) => ({
    leg,
    claimedMiles: leg.claimedMiles,
    status: 'skipped',
    note: 'not reached by any routed segment',
  }))

  for (let i = 0; i < osrm.legs.length && i < chain.length - 1; i++) {
    const spanFrom = Math.max(0, chain[i].legAfter)
    const spanTo = Math.min(parsed.legs.length - 1, chain[i + 1].legBefore)
    const spanned = parsed.legs.slice(spanFrom, spanTo + 1)
    if (!spanned.length) continue
    const matchers = spanned.flatMap((l) =>
      l.kind === 'street'
        ? [new RegExp(streetNameRegex(l.streetName ?? l.label), 'i')]
        : l.roads.map(refMatcher),
    )
    let matched = 0
    let denominator = 0
    for (const step of osrm.legs[i].steps) {
      const text = `${step.ref ?? ''};${step.name ?? ''}`
      const isConnector = !step.ref && step.distance < 1600
      if (isConnector) continue
      denominator += step.distance
      if (matchers.some((m) => m.test(text))) matched += step.distance
    }
    const refMatch = denominator > 0 ? matched / denominator : undefined
    const legDistMi = osrm.legs[i].distance / MI
    const share = spanned.reduce((s, l) => s + l.claimedMiles, 0)
    for (const leg of spanned) {
      const r = reports[leg.index]
      const portion = share > 0 ? leg.claimedMiles / share : 1 / spanned.length
      r.routedMiles = (r.routedMiles ?? 0) + legDistMi * portion
      r.refMatch = refMatch
      r.status = 'ok'
      r.note = undefined
      if (spanned.length > 1) {
        r.status = 'warn'
        r.note = 'shared segment; a junction nearby was not pinned'
      }
    }
  }

  for (const r of reports) {
    if (r.status === 'skipped') continue
    const distCorroborates =
      r.routedMiles !== undefined &&
      r.claimedMiles > 0 &&
      Math.abs(r.routedMiles - r.claimedMiles) <= Math.max(2, r.claimedMiles * 0.2)
    if ((r.refMatch ?? 1) < 0.45 && r.claimedMiles > 2 && distCorroborates) {
      // rural FM/county roads often carry no ref tags in OSM — the matching
      // mileage says the road is right even though the refs are silent
      r.note = 'OSM carries few ref tags here; mileage confirms the road'
    } else if ((r.refMatch ?? 1) < 0.45 && r.claimedMiles > 2) {
      r.status = 'warn'
      r.note = `routed roads match the instruction poorly (${Math.round((r.refMatch ?? 0) * 100)}%)`
    } else if (
      r.routedMiles !== undefined &&
      r.claimedMiles > 0.5 &&
      Math.abs(r.routedMiles - r.claimedMiles) > Math.max(3, r.claimedMiles * 0.35)
    ) {
      if (r.status === 'ok') {
        r.status = 'warn'
        r.note =
          r.routedMiles > r.claimedMiles * 3 && r.claimedMiles <= 3
            ? `claimed ${r.claimedMiles.toFixed(1)} mi, routed ${r.routedMiles.toFixed(1)}: OSM likely marks this road gated or restricted, so routing detours around it`
            : `claimed ${r.claimedMiles.toFixed(1)} mi, routed ${r.routedMiles.toFixed(1)} mi`
      }
    }
  }
  return reports
}
