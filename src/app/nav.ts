import type { LatLng, RouteResult } from '../engine/types'
import { MI, bearing, fastDist, offset, projectOnLine } from '../engine/geo'

/**
 * Navigation state: projects a moving position (device GPS or the simulator)
 * onto the built route, tracks progress, detects off-route.
 */

export interface NavState {
  pos: LatLng
  heading: number
  speedMps: number
  alongM: number
  /** Geometry vertex index at the projection (for progress rendering). */
  geomIndex: number
  offRoute: boolean
  offRouteM: number
  /** Next waypoint (transition) ahead. */
  nextWaypointIdx?: number
  nextLabel?: string
  distToNextM?: number
  remainingM: number
  done: boolean
}

export type NavListener = (s: NavState) => void

export class NavController {
  private route: RouteResult
  private latlngs: LatLng[]
  private listeners = new Set<NavListener>()
  private lastSeg = 0
  private offCount = 0
  /** Along-distances of usable waypoints, for "next maneuver" lookups. */
  private wpAlong: { idx: number; along: number; label: string }[] = []
  state?: NavState

  constructor(route: RouteResult) {
    this.route = route
    this.latlngs = route.geometry.map(([lng, lat]) => ({ lat, lng }))
    route.waypoints.forEach((w, idx) => {
      if (w.status !== 'ok' && w.status !== 'approx') return
      const proj = projectOnLine(w.pos, this.latlngs, route.cumulative)
      this.wpAlong.push({ idx, along: proj.along, label: w.label })
    })
    this.wpAlong.sort((a, b) => a.along - b.along)
  }

  onUpdate(fn: NavListener) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  update(pos: LatLng, headingHint?: number, speedMps = 0) {
    const r = this.route
    // windowed projection: search near the last known segment first
    const W = 2500
    const from = Math.max(0, this.lastSeg - 200)
    const to = Math.min(this.latlngs.length, this.lastSeg + W)
    let proj = projectOnLine(pos, this.latlngs.slice(from, to), r.cumulative.slice(from, to))
    proj = { ...proj, seg: proj.seg + from }
    if (proj.dist > 400) {
      const full = projectOnLine(pos, this.latlngs, r.cumulative)
      if (full.dist < proj.dist) proj = full
    }
    this.lastSeg = proj.seg
    const along = r.cumulative[proj.seg] + proj.t * (r.cumulative[proj.seg + 1] - r.cumulative[proj.seg])

    const offRoute = proj.dist > 140
    this.offCount = offRoute ? this.offCount + 1 : 0

    const next = this.wpAlong.find((w) => w.along > along + 40)
    const heading =
      headingHint ??
      bearing(this.latlngs[proj.seg], this.latlngs[Math.min(proj.seg + 1, this.latlngs.length - 1)])

    const state: NavState = {
      pos,
      heading,
      speedMps,
      alongM: along,
      geomIndex: proj.seg,
      offRoute: this.offCount >= 4,
      offRouteM: proj.dist,
      nextWaypointIdx: next?.idx,
      nextLabel: next?.label,
      distToNextM: next ? next.along - along : undefined,
      remainingM: Math.max(0, r.totalMeters - along),
      done: r.totalMeters - along < 60,
    }
    this.state = state
    for (const fn of this.listeners) fn(state)
  }

  nearestOnRoute(pos: LatLng): LatLng {
    const proj = projectOnLine(pos, this.latlngs, this.route.cumulative)
    return proj.point
  }
}

/* ------------------------------------------------------------------ */

export class Simulator {
  private nav: NavController
  private route: RouteResult
  private latlngs: LatLng[]
  private timer?: number
  private lastT = 0
  alongM = 0
  /** Simulated road speed (m/s) — 62 mph baseline. */
  baseSpeed = 27.7
  multiplier = 20
  wander = false
  private wanderPhase = 0
  running = false

  constructor(nav: NavController, route: RouteResult) {
    this.nav = nav
    this.route = route
    this.latlngs = route.geometry.map(([lng, lat]) => ({ lat, lng }))
  }

  start(fromAlongM = 0) {
    this.alongM = fromAlongM
    this.running = true
    this.lastT = performance.now()
    // setInterval rather than requestAnimationFrame: rAF stops entirely in a
    // hidden tab. setInterval is throttled there too, and Chrome may freeze it
    // outright, so the elapsed time is measured from the clock and clamped —
    // a tab returning after a pause catches up smoothly instead of jumping.
    const tick = () => {
      if (!this.running) return
      const t = performance.now()
      const dt = Math.min(1.5, (t - this.lastT) / 1000)
      this.lastT = t
      this.alongM += this.baseSpeed * this.multiplier * dt
      if (this.alongM >= this.route.totalMeters) {
        this.alongM = this.route.totalMeters
        this.running = false
        window.clearInterval(this.timer)
      }
      const p = this.pointAt(this.alongM)
      const q = this.pointAt(Math.min(this.route.totalMeters, this.alongM + 60))
      let pos = p
      const head = fastDist(p, q) > 1 ? bearing(p, q) : 0
      if (this.wander) {
        this.wanderPhase = Math.min(1, this.wanderPhase + dt * 0.25)
        pos = offset(p, head + 90, 420 * this.wanderPhase)
      } else {
        this.wanderPhase = 0
      }
      this.nav.update(pos, head, this.baseSpeed * this.multiplier)
    }
    this.timer = window.setInterval(tick, 100)
  }

  private pointAt(m: number): LatLng {
    const cum = this.route.cumulative
    let lo = 0
    let hi = cum.length - 1
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1
      if (cum[mid] <= m) lo = mid
      else hi = mid
    }
    const t = (m - cum[lo]) / Math.max(1e-9, cum[lo + 1] - cum[lo])
    const a = this.latlngs[lo]
    const b = this.latlngs[lo + 1]
    return { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) }
  }

  stop() {
    this.running = false
    if (this.timer) window.clearInterval(this.timer)
  }
}

/* ------------------------------------------------------------------ */

export class GpsSource {
  private watchId?: number
  start(nav: NavController, onError: (msg: string) => void) {
    if (!('geolocation' in navigator)) {
      onError('This browser has no geolocation support.')
      return
    }
    this.watchId = navigator.geolocation.watchPosition(
      (p) => {
        nav.update(
          { lat: p.coords.latitude, lng: p.coords.longitude },
          p.coords.heading ?? undefined,
          p.coords.speed ?? 0,
        )
      },
      (err) => onError(err.code === err.PERMISSION_DENIED ? 'Location permission denied — using the simulator instead is fine.' : `GPS error: ${err.message}`),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    )
  }
  stop() {
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId)
  }
}

export const fmtMi = (m: number) => {
  const mi = m / MI
  return mi >= 10 ? mi.toFixed(0) : mi >= 0.2 ? mi.toFixed(1) : `${Math.round(m * 3.281 / 50) * 50} ft`
}
