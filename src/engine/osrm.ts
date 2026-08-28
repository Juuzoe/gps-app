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
  for (const base of MIRRORS) {
    try {
      const res = await fetch(`${base}/route/v1/driving/${coords}?${params}`, {
        headers: { 'User-Agent': 'roadbook/0.1 (permit route navigator)' },
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
      }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('OSRM request failed')
}

/**
 * Route the chain with a robustness ladder: one multi-waypoint request first;
 * on failure, pair-by-pair (dropping bearings, then the pair's own hints)
 * so a single bad snap cannot sink the whole route.
 */
export async function routeChain(
  points: RoutePoint[],
  onPairProblem?: (index: number, message: string) => void,
): Promise<OsrmRoute> {
  try {
    return await osrmRoute(points, true)
  } catch {
    /* bearings can make individual snaps unroutable */
  }
  try {
    // One cheap retry before paying for N pairwise requests: most full-chain
    // failures are a single bearing-constrained snap, not a broken chain.
    return await osrmRoute(points, false)
  } catch {
    /* fall through to pairwise */
  }

  // Pairwise, but CONCURRENT: 29 sequential requests took the better part of
  // a minute; four lanes bring it to a few seconds. Results are stitched in
  // order afterwards, and a dead pair degrades to a straight jump (flagged).
  const segs: (OsrmRoute | undefined)[] = new Array(points.length - 1)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, points.length - 1)) }, async () => {
      for (;;) {
        const i = next++
        if (i >= points.length - 1) return
        const pair = [points[i], points[i + 1]]
        for (const attempt of [() => osrmRoute(pair, true), () => osrmRoute(pair, false)]) {
          try {
            segs[i] = await attempt()
            break
          } catch (e) {
            onPairProblem?.(i, e instanceof Error ? e.message : String(e))
          }
        }
      }
    }),
  )

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
