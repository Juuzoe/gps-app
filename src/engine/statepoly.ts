import type { LatLng } from './types'
import { stateInfo } from './states'

/**
 * State outlines, used to clip Overpass results to the state actually being
 * routed.
 *
 * Queries are scoped by bounding box because that is what makes them fast, but
 * a bounding box is not a state: the Texas box covers most of eastern New
 * Mexico, so a sweep for US-285 came back 652/710 New Mexican and put the
 * "New Mexico line" 500km inside New Mexico. Clipping to the real outline fixes
 * that while keeping the fast query shape.
 *
 * Outlines come from Nominatim, simplified to ~1km, and are cached — a few
 * hundred points per state, around 16KB for Texas.
 */

type Ring = [number, number][] // [lng, lat]

const polygons = new Map<string, Ring[] | null>()

export async function loadStatePolygon(code: string): Promise<void> {
  if (polygons.has(code)) return
  const name = stateInfo(code)?.name
  if (!name) {
    polygons.set(code, null)
    return
  }
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&country=us&polygon_geojson=1' +
    '&polygon_threshold=0.01&state=' + encodeURIComponent(name)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'roadbook/0.1 (permit route navigator)' } })
    const json: any[] = await res.json()
    const g = json[0]?.geojson
    if (!g) {
      polygons.set(code, null)
      return
    }
    const rings: Ring[] =
      g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((p: Ring[]) => p[0]) : []
    polygons.set(code, rings.length ? rings : null)
  } catch {
    polygons.set(code, null) // fail open: no clipping rather than no route
  }
}

/** True when the outline is unknown — callers then keep everything. */
export function hasStatePolygon(code: string): boolean {
  return !!polygons.get(code)
}

export function isInState(code: string, p: LatLng): boolean {
  const rings = polygons.get(code)
  if (!rings) return true
  for (const ring of rings) if (pointInRing(p, ring)) return true
  return false
}

function pointInRing(p: LatLng, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1]
    const xj = ring[j][0], yj = ring[j][1]
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Minimum distance (m) from a point to the state's outline vertices, or
 *  undefined when the outline is unknown. Vertices are ~1km apart, which is
 *  plenty for choosing between road endpoints hundreds of km apart. */
export function distToStateRing(code: string, p: LatLng): number | undefined {
  const rings = polygons.get(code)
  if (!rings) return undefined
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111320
  let best = Infinity
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      const dx = (p.lng - lng) * kx
      const dy = (p.lat - lat) * 110540
      const d = dx * dx + dy * dy
      if (d < best) best = d
    }
  }
  return Math.sqrt(best)
}

/**
 * The border crossing among candidate points: the one nearest the NEIGHBOUR'S
 * actual outline. Direction-toward-centroid guessing chose Bristol as the
 * "West Virginia end" of I-81 (West Virginia's centroid is west of Virginia,
 * but the road exits northeast), collapsing a 325-mile route to 2 miles.
 * Mexico and Canada have no outline here, so latitude extremes stand in.
 */
export async function pickBorderCrossing(
  pts: LatLng[],
  stateCode: string,
  neighborKey: string,
): Promise<{ pos: LatLng; verified: boolean } | undefined> {
  if (!pts.length) return undefined
  const extreme = (score: (p: LatLng) => number) => pts.reduce((a, b) => (score(b) > score(a) ? b : a))
  if (neighborKey === 'MX') return { pos: extreme((p) => -p.lat), verified: false }
  if (neighborKey === 'CA_INTL') return { pos: extreme((p) => p.lat), verified: false }
  await loadStatePolygon(neighborKey)
  // Candidates are the cloud's cardinal extremes — a border crossing is on the
  // hull of the road's extent by definition.
  const cands = [
    extreme((p) => p.lat),
    extreme((p) => -p.lat),
    extreme((p) => p.lng),
    extreme((p) => -p.lng),
  ]
  if (hasStatePolygon(neighborKey)) {
    let best = cands[0]
    let bestD = Infinity
    for (const c of cands) {
      const d = distToStateRing(neighborKey, c)
      if (d !== undefined && d < bestD) {
        bestD = d
        best = c
      }
    }
    return { pos: best, verified: true }
  }
  // Outline unknown: fall back to the centroid-direction guess, but say so.
  const st = stateInfo(stateCode)
  const nb = stateInfo(neighborKey)
  if (!st || !nb) return undefined
  const dLat = nb.centroid.lat - st.centroid.lat
  const dLng = nb.centroid.lng - st.centroid.lng
  return {
    pos: extreme((p) => (p.lat - st.centroid.lat) * dLat + (p.lng - st.centroid.lng) * dLng),
    verified: false,
  }
}

/**
 * Keep only points inside the state.
 *
 * STRICT: when every point is outside, the answer is an empty list — that is
 * the fact. An earlier version returned the unclipped points "so callers still
 * had data", which converted "this road is not in this state at all" into
 * "all of it is", and sent a Virginia route to Kentucky. Callers that reach a
 * negative or extremal conclusion from an empty result must degrade loudly,
 * not be handed comforting garbage.
 *
 * When the outline is UNKNOWN (Nominatim unreachable) nothing can be clipped;
 * callers can distinguish that case via hasStatePolygon() and should mark
 * conclusions drawn from unclipped data as approximate.
 */
export function clipToState(code: string, pts: LatLng[]): LatLng[] {
  if (!hasStatePolygon(code)) return pts
  return pts.filter((p) => isInState(code, p))
}
