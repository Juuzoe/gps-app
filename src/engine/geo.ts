import type { LatLng } from './types'

const R = 6371008.8
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export const MI = 1609.344

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

/** Initial bearing a→b in degrees [0, 360). */
export function bearing(a: LatLng, b: LatLng): number {
  const φ1 = rad(a.lat)
  const φ2 = rad(b.lat)
  const dλ = rad(b.lng - a.lng)
  const y = Math.sin(dλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

export function bearingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

export const CARDINAL_BEARING: Record<string, number> = {
  n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315,
}

/** Fast planar approximation for short distances (meters). */
export function fastDist(a: LatLng, b: LatLng): number {
  const kx = Math.cos(rad((a.lat + b.lat) / 2)) * 111320
  const dx = (a.lng - b.lng) * kx
  const dy = (a.lat - b.lat) * 110540
  return Math.sqrt(dx * dx + dy * dy)
}

export function cumulativeMeters(line: LatLng[]): number[] {
  const out = new Array<number>(line.length)
  out[0] = 0
  for (let i = 1; i < line.length; i++) out[i] = out[i - 1] + fastDist(line[i - 1], line[i])
  return out
}

export interface Projection {
  point: LatLng
  /** Meters from query point to the polyline. */
  dist: number
  /** Index of segment start vertex. */
  seg: number
  /** Fraction along that segment. */
  t: number
  /** Meters along the polyline at the projection. */
  along: number
}

/** Nearest point on a polyline (planar approx; fine at road scale). */
export function projectOnLine(p: LatLng, line: LatLng[], cum?: number[]): Projection {
  let best: Projection = { point: line[0], dist: fastDist(p, line[0]), seg: 0, t: 0, along: 0 }
  const kx = Math.cos(rad(p.lat)) * 111320
  const ky = 110540
  const px = p.lng * kx
  const py = p.lat * ky
  for (let i = 0; i < line.length - 1; i++) {
    const ax = line[i].lng * kx, ay = line[i].lat * ky
    const bx = line[i + 1].lng * kx, by = line[i + 1].lat * ky
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2
    t = Math.max(0, Math.min(1, t))
    const qx = ax + t * dx, qy = ay + t * dy
    const d = Math.sqrt((px - qx) ** 2 + (py - qy) ** 2)
    if (d < best.dist) {
      const point = { lat: qy / ky, lng: qx / kx }
      const segLen = Math.sqrt(len2)
      best = { point, dist: d, seg: i, t, along: (cum ? cum[i] : 0) + t * segLen }
    }
  }
  return best
}

/** Point at a given distance (meters) along a polyline; clamps to ends. */
export function pointAlong(line: LatLng[], cum: number[], m: number): LatLng {
  if (m <= 0) return line[0]
  const total = cum[cum.length - 1]
  if (m >= total) return line[line.length - 1]
  let lo = 0, hi = cum.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= m) lo = mid
    else hi = mid
  }
  const t = (m - cum[lo]) / Math.max(1e-9, cum[lo + 1] - cum[lo])
  return {
    lat: line[lo].lat + t * (line[lo + 1].lat - line[lo].lat),
    lng: line[lo].lng + t * (line[lo + 1].lng - line[lo].lng),
  }
}

/** Bearing of the polyline at a given along-distance, averaged over a window. */
export function bearingAlong(line: LatLng[], cum: number[], m: number, windowM = 300): number {
  const a = pointAlong(line, cum, Math.max(0, m - windowM / 2))
  const b = pointAlong(line, cum, Math.min(cum[cum.length - 1], m + windowM / 2))
  return bearing(a, b)
}

export function bboxOf(points: LatLng[]): { minLat: number; minLng: number; maxLat: number; maxLng: number } {
  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat
    if (p.lat > maxLat) maxLat = p.lat
    if (p.lng < minLng) minLng = p.lng
    if (p.lng > maxLng) maxLng = p.lng
  }
  return { minLat, minLng, maxLat, maxLng }
}

/** Destination point given start, bearing (deg) and distance (m). */
export function offset(p: LatLng, bearingDeg: number, m: number): LatLng {
  const δ = m / R
  const θ = rad(bearingDeg)
  const φ1 = rad(p.lat)
  const λ1 = rad(p.lng)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ))
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2))
  return { lat: deg(φ2), lng: deg(λ2) }
}
