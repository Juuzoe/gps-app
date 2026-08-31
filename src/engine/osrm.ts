import type { LatLng } from './types'

/** OSRM /route client with mirror fallback (public instances, fair use). */

export interface OsrmStep {
  distance: number
  name: string
  ref?: string
}

export interface OsrmLeg {
  distance: number
  duration: number
  steps: OsrmStep[]
}

export interface OsrmRoute {
  geometry: [number, number][]
  distance: number
  duration: number
  legs: OsrmLeg[]
  /** Where OSRM snapped each input waypoint, as [lng, lat]. */
  snapped?: [number, number][]
}

const MIRRORS = [
  'https://routing.openstreetmap.de/routed-car',
  'https://router.project-osrm.org',
]

export interface RoutePoint {
  pos: LatLng
  bearing?: number
}

export async function osrmRoute(points: RoutePoint[], useBearings = true): Promise<OsrmRoute> {
  if (points.length < 2) throw new Error('Need at least two waypoints')
  const coords = points.map((p) => `${p.pos.lng.toFixed(6)},${p.pos.lat.toFixed(6)}`).join(';')
  let params = 'overview=full&geometries=geojson&steps=true'
  if (useBearings && points.some((p) => p.bearing !== undefined)) {
    const bearings = points
      .map((p) => (p.bearing === undefined ? '' : `${Math.round(p.bearing)},80`))
      .join(';')
    const radiuses = points.map((p) => (p.bearing === undefined ? 'unlimited' : '1500')).join(';')
    params += `&bearings=${bearings}&radiuses=${radiuses}`
  }
  let lastErr: unknown
  // Two passes: OSRM mirrors flake for seconds at a time, and one transient
  // 'fetch failed' must cost a retry, not the segment it was carrying.
  for (const base of [...MIRRORS, ...MIRRORS]) {
    if (lastErr) await new Promise((r) => setTimeout(r, 1200))
    try {
      const res = await fetch(`${base}/route/v1/driving/${coords}?${params}`, {
        headers: { 'User-Agent': 'route-navigator/1.0 (oversize permit routing)' },
        signal: AbortSignal.timeout(60_000),
      })
      const json: any = await res.json()
      if (json.code !== 'Ok' || !json.routes?.length) {
        lastErr = new Error(`OSRM: ${json.code ?? res.status}${json.message ? ` — ${json.message}` : ''}`)
        continue
      }
      const r = json.routes[0]
      return {
        geometry: r.geometry.coordinates as [number, number][],
        distance: r.distance,
        duration: r.duration,
        legs: (r.legs ?? []).map((l: any) => ({
          distance: l.distance,
          duration: l.duration,
          steps: (l.steps ?? []).map((s: any) => ({ distance: s.distance, name: s.name ?? '', ref: s.ref })),
        })),
        snapped: (json.waypoints ?? []).map((w: any) => w.location as [number, number]),
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('OSRM request failed')
}

/**
 * Route the chain against the instructions, not just against the road graph.
 *
 * A junction waypoint sits between carriageways, so OSRM's nearest-edge snap
 * can land on the wrong side of a divided highway; the route then runs to the
 * next crossover and back, adding miles on the RIGHT road (one permit leg
 * claimed 11.0 mi and routed 24.8). A departure bearing prevents that, but a
 * bearing constraint at a corner can also hunt up to its snap radius and pick
 * a worse edge, breaking a leg that was fine without it — and which legs each
 * mode breaks varies junction by junction.
 *
 * The instructions themselves settle it: each pair of waypoints has a claimed
 * mileage, so the chain is routed both ways, any leg that overshoots its
 * claim is rebuilt pair-by-pair under each bearing variant, and the variant
 * whose length matches the claim wins. Failures fall down the same ladder,
 * so a transient error costs a retry, never the bearing protection of every
 * other waypoint (which is exactly what the old all-or-nothing fallback did).
 */
export async function routeChain(
  points: RoutePoint[],
  onPairProblem?: (index: number, message: string) => void,
  targetsMi?: (number | undefined)[],
  viaCandidates?: (index: number) => Promise<LatLng[]>,
): Promise<OsrmRoute> {
  const MI = 1609.344
  const target = (i: number) => {
    const t = targetsMi?.[i]
    return t !== undefined && t > 0.5 ? t : undefined
  }
  // A leg has resolved somewhere wrong when it overshoots its own claim by
  // more than the claim's usual slack. Undershoot is not a snap symptom.
  // Overshoot means a snap resolved somewhere wrong; undershoot means the
  // path between two RIGHT points took a shortcut off the instructed road —
  // a loop bypass collapses to the straight road through town, for example.
  const off = (legMi: number, t: number) => legMi - t > t * 0.6 + 2 || t - legMi > Math.max(2, t * 0.45)
  const suspect = (r: OsrmRoute): number[] => {
    const out: number[] = []
    for (let i = 0; i < r.legs.length; i++) {
      const t = target(i)
      if (t !== undefined && off(r.legs[i].distance / MI, t)) out.push(i)
    }
    return out
  }
  const misfit = (r: OsrmRoute): number => {
    let m = 0
    for (let i = 0; i < r.legs.length; i++) {
      const t = target(i)
      if (t !== undefined) m += Math.max(0, r.legs[i].distance / MI - (t * 1.25 + 1))
    }
    return m
  }

  let withB: OsrmRoute | undefined
  let noB: OsrmRoute | undefined
  try { withB = await osrmRoute(points, true) } catch { /* ladder continues */ }
  if (!withB || suspect(withB).length > 0) {
    try { noB = await osrmRoute(points, false) } catch { /* ladder continues */ }
  }
  const base =
    withB && noB ? (misfit(withB) <= misfit(noB) ? withB : noB) : withB ?? noB
  if (base && suspect(base).length === 0) return base

  // Pairwise: each pair independently, under each bearing variant, judged by
  // its claimed mileage. Four lanes keep 30 pairs to a few seconds.
  const segs: (OsrmRoute | undefined)[] = new Array(points.length - 1)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, points.length - 1)) }, async () => {
      for (;;) {
        const i = next++
        if (i >= points.length - 1) return
        const startOnly: RoutePoint[] = [points[i], { pos: points[i + 1].pos }]
        const variants: (() => Promise<OsrmRoute>)[] = [
          () => osrmRoute(startOnly, true),
          () => osrmRoute([points[i], points[i + 1]], false),
          () => osrmRoute([points[i], points[i + 1]], true),
        ]
        const t = target(i)
        let best: OsrmRoute | undefined
        let firstErr: string | undefined
        for (const v of variants) {
          try {
            const r = await v()
            if (t === undefined) { best = r; break }
            if (!best || Math.abs(r.distance / MI - t) < Math.abs(best.distance / MI - t)) best = r
            if (Math.abs(r.distance / MI - t) <= Math.max(1, t * 0.25)) break
          } catch (e) {
            firstErr ??= e instanceof Error ? e.message : String(e)
          }
        }
        // Still far from the claim with the right endpoints: the path between
        // them has abandoned the instructed road for a shortcut. A via point
        // taken from the instructed road's own geometry pins the route back
        // onto it; the claim stays the judge of whether that helped.
        if (best && t !== undefined && off(best.distance / MI, t) && viaCandidates) {
          try {
            for (const v of await viaCandidates(i)) {
              try {
                  const withVia = await osrmRoute([points[i], { pos: v }, points[i + 1]], false)
                const merged: OsrmRoute = {
                  geometry: withVia.geometry,
                  distance: withVia.distance,
                  duration: withVia.duration,
                  legs: [{
                    distance: withVia.legs.reduce((sm, l) => sm + l.distance, 0),
                    duration: withVia.legs.reduce((sm, l) => sm + l.duration, 0),
                    steps: withVia.legs.flatMap((l) => l.steps),
                  }],
                  snapped: withVia.snapped,
                }
                if (Math.abs(merged.distance / MI - t) < Math.abs(best.distance / MI - t)) best = merged
              } catch { /* this via failed; the next may not */ }
            }
          } catch { /* via lookup failed; the flagged direct route stands */ }
        }
        if (!best && firstErr) onPairProblem?.(i, firstErr)
        segs[i] = best
      }
    }),
  )

  // The public OSRM instances flake in waves of seconds; a pair that ran
  // inside a wave failed for being unlucky, not for being unroutable. One
  // more sweep after a pause turns a blip into a delay instead of a hole in
  // the route — six consecutive segments once died to a single wave.
  if (segs.some((s0) => !s0)) {
    await new Promise((r) => setTimeout(r, 4000))
    for (let i = 0; i < segs.length; i++) {
      if (segs[i]) continue
      const t = target(i)
      for (const v of [() => osrmRoute([points[i], { pos: points[i + 1].pos }], true), () => osrmRoute([points[i], points[i + 1]], false)]) {
        try {
          const r = await v()
          if (!segs[i] || (t !== undefined && Math.abs(r.distance / MI - t) < Math.abs(segs[i]!.distance / MI - t))) segs[i] = r
          if (t === undefined || Math.abs(r.distance / MI - t) <= Math.max(1, t * 0.25)) break
        } catch { /* still down; the straight-line bridge below reports it */ }
      }
    }
  }

  // Neighbouring pairs can snap the shared waypoint to different places (the
  // whole point of the variants); where they landed far apart, re-route the
  // left pair onto the right pair's snap so the stitched line is continuous.
  const gapM = (a: [number, number], b: [number, number]) => {
    const kx = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180)) * 111_320
    return Math.hypot((a[0] - b[0]) * kx, (a[1] - b[1]) * 110_540)
  }
  for (let i = 0; i + 1 < segs.length; i++) {
    const L = segs[i]
    const R = segs[i + 1]
    if (!L || !R) continue
    const lEnd = L.geometry[L.geometry.length - 1]
    const rStart = R.geometry[0]
    if (lEnd && rStart && gapM(lEnd, rStart) > 300) {
      try {
        segs[i] = await osrmRoute(
          [points[i], { pos: { lat: rStart[1], lng: rStart[0] } }],
          points[i].bearing !== undefined,
        )
      } catch { /* keep the gap; the flagged jog beats losing the pair */ }
    }
  }

  const legs: OsrmLeg[] = []
  const geometry: [number, number][] = []
  let distance = 0
  let duration = 0
  for (let i = 0; i < points.length - 1; i++) {
    let seg = segs[i]
    if (!seg) {
      onPairProblem?.(i, 'No drivable path found for this segment')
      const line: [number, number][] = [
        [points[i].pos.lng, points[i].pos.lat],
        [points[i + 1].pos.lng, points[i + 1].pos.lat],
      ]
      seg = { geometry: line, distance: 0, duration: 0, legs: [{ distance: 0, duration: 0, steps: [] }] }
    }
    const start = geometry.length > 0 ? 1 : 0
    geometry.push(...seg.geometry.slice(start))
    legs.push(...seg.legs)
    distance += seg.distance
    duration += seg.duration
  }
  return { geometry, distance, duration, legs }
}
