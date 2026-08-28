import type { LatLng } from './types'
import type { OverpassWay } from './overpass'
import { bearing, bearingDiff, cumulativeMeters, fastDist, haversine } from './geo'

/**
 * A road's statewide network: every mainline way sharing the ref, indexed
 * for nearest-point lookup, junction detection and along-road walking.
 */

export interface NetWay {
  id: number
  nodes: number[]
  pts: LatLng[]
  cum: number[]
  lengthM: number
  oneway: boolean
  tags: Record<string, string>
}

export interface JunctionCandidate {
  pos: LatLng
  onSelf: LatLng
  onOther: LatLng
  kind: 'shared' | 'proximity'
  gapM: number
}

export interface SnapResult {
  pos: LatLng
  wayIdx: number
  ptIdx: number
  distM: number
  tangent: number
  oneway: boolean
}

const CELL = 0.02 // ~2 km

function cellKey(lat: number, lng: number): string {
  return `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`
}

class MinHeap {
  private a: { id: number; d: number }[] = []
  get size() { return this.a.length }
  push(id: number, d: number) {
    const a = this.a
    a.push({ id, d })
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].d <= a[i].d) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): { id: number; d: number } | undefined {
    const a = this.a
    if (!a.length) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < a.length && a[l].d < a[m].d) m = l
        if (r < a.length && a[r].d < a[m].d) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

export class RoadNet {
  readonly label: string
  readonly ways: NetWay[] = []
  readonly nodePos = new Map<number, LatLng>()
  readonly nodeWays = new Map<number, number[]>()
  /** Graph over OSM node ids: consecutive-node edges with lengths. */
  readonly adj = new Map<number, { to: number; w: number }[]>()
  readonly grid = new Map<string, { w: number; i: number }[]>()
  totalLengthM = 0
  /** Node id → component index; componentLength[i] = total meters. */
  readonly componentOf = new Map<number, number>()
  readonly componentLength: number[] = []

  constructor(label: string, ways: OverpassWay[]) {
    this.label = label
    for (const w of ways) {
      if (w.geometry.length < 2 || w.nodes.length !== w.geometry.length) continue
      const cum = cumulativeMeters(w.geometry)
      const nw: NetWay = {
        id: w.id, nodes: w.nodes, pts: w.geometry, cum,
        lengthM: cum[cum.length - 1],
        oneway: w.tags.oneway === 'yes' || w.tags.oneway === '1' || w.tags.highway === 'motorway',
        tags: w.tags,
      }
      const wi = this.ways.length
      this.ways.push(nw)
      this.totalLengthM += nw.lengthM
      for (let i = 0; i < w.nodes.length; i++) {
        const id = w.nodes[i]
        const p = w.geometry[i]
        this.nodePos.set(id, p)
        let list = this.nodeWays.get(id)
        if (!list) this.nodeWays.set(id, (list = []))
        if (!list.includes(wi)) list.push(wi)
        const key = cellKey(p.lat, p.lng)
        let cell = this.grid.get(key)
        if (!cell) this.grid.set(key, (cell = []))
        cell.push({ w: wi, i })
        if (i > 0) {
          const prev = w.nodes[i - 1]
          const len = fastDist(w.geometry[i - 1], p)
          this.edge(prev, id, len)
          this.edge(id, prev, len)
        }
      }
    }
    this.computeComponents()
  }

  private edge(a: number, b: number, w: number) {
    let list = this.adj.get(a)
    if (!list) this.adj.set(a, (list = []))
    list.push({ to: b, w })
  }

  private computeComponents() {
    const seen = new Set<number>()
    for (const start of this.adj.keys()) {
      if (seen.has(start)) continue
      const ci = this.componentLength.length
      let len = 0
      const stack = [start]
      seen.add(start)
      while (stack.length) {
        const n = stack.pop()!
        this.componentOf.set(n, ci)
        for (const e of this.adj.get(n) ?? []) {
          len += e.w / 2 // each undirected edge counted twice
          if (!seen.has(e.to)) {
            seen.add(e.to)
            stack.push(e.to)
          }
        }
      }
      this.componentLength.push(len)
    }
  }

  get empty() { return this.ways.length === 0 }

  /** Nearest way-point to p (expanding grid ring search). */
  nearest(p: LatLng, maxM = 50000): SnapResult | undefined {
    const cLat = Math.floor(p.lat / CELL)
    const cLng = Math.floor(p.lng / CELL)
    let best: SnapResult | undefined
    for (let ring = 0; ring <= Math.ceil(maxM / (CELL * 110540)) + 1; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const cell = this.grid.get(`${cLat + dy}:${cLng + dx}`)
          if (!cell) continue
          for (const { w, i } of cell) {
            const q = this.ways[w].pts[i]
            const d = fastDist(p, q)
            if (!best || d < best.distM) {
              best = { pos: q, wayIdx: w, ptIdx: i, distM: d, tangent: this.tangentAt(w, i), oneway: this.ways[w].oneway }
            }
          }
        }
      }
      if (best && best.distM < (ring - 0.5) * CELL * 110540) break
      if (ring * CELL * 110540 > maxM) break
    }
    return best && best.distM <= maxM ? best : undefined
  }

  private tangentAt(wayIdx: number, ptIdx: number): number {
    const w = this.ways[wayIdx]
    const a = w.pts[Math.max(0, ptIdx - 1)]
    const b = w.pts[Math.min(w.pts.length - 1, ptIdx + 1)]
    return bearing(a, b)
  }

  /**
   * Snap near a point preferring ways drivable in the given travel bearing:
   * one-way ways must point within 100° of it; two-way ways always qualify.
   */
  snapForBearing(p: LatLng, travelBearing: number | undefined, radiusM = 200): SnapResult | undefined {
    const plain = this.nearest(p, radiusM * 6)
    if (travelBearing === undefined) return plain
    const cLat = Math.floor(p.lat / CELL)
    const cLng = Math.floor(p.lng / CELL)
    let best: SnapResult | undefined
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.grid.get(`${cLat + dy}:${cLng + dx}`)
        if (!cell) continue
        for (const { w, i } of cell) {
          const q = this.ways[w].pts[i]
          const d = fastDist(p, q)
          if (d > radiusM) continue
          const tangent = this.tangentAt(w, i)
          if (this.ways[w].oneway && bearingDiff(tangent, travelBearing) > 100) continue
          if (!best || d < best.distM) {
            best = { pos: q, wayIdx: w, ptIdx: i, distM: d, tangent, oneway: this.ways[w].oneway }
          }
        }
      }
    }
    return best ?? plain
  }

  /** Junction candidates with another road's net.
   *
   * `maxPairM` is the mainline-to-mainline distance that counts as an
   * interchange. 260m suits crossings, but a road that TERMINATES into
   * another (I-30 ending into I-40, CA-99 merging into I-5) can leave its
   * last mainline way several hundred metres from the through road, joined
   * only by unnumbered links — callers escalate the radius when the tight
   * pass finds nothing. */
  junctionsWith(other: RoadNet, maxPairM = 260): JunctionCandidate[] {
    const out: JunctionCandidate[] = []
    // 1) Shared nodes — at-grade crossings and concurrency boundaries.
    const shared: number[] = []
    const small = this.nodeWays.size <= other.nodeWays.size ? this : other
    const big = small === this ? other : this
    for (const id of small.nodeWays.keys()) if (big.nodeWays.has(id)) shared.push(id)
    const sharedSet = new Set(shared)
    const boundary: LatLng[] = []
    for (const id of shared) {
      const neighborsOther = (other.adj.get(id) ?? []).map((e) => e.to)
      const neighborsSelf = (this.adj.get(id) ?? []).map((e) => e.to)
      const otherLeaves = neighborsOther.some((n) => !sharedSet.has(n)) || neighborsOther.length <= 1
      const selfLeaves = neighborsSelf.some((n) => !sharedSet.has(n)) || neighborsSelf.length <= 1
      if (otherLeaves && selfLeaves) boundary.push(this.nodePos.get(id)!)
    }
    for (const c of cluster(boundary, 900)) {
      out.push({ pos: c, onSelf: c, onOther: c, kind: 'shared', gapM: 0 })
    }
    // 2) Grade-separated interchanges — proximity between the two nets.
    const pairs: { a: LatLng; b: LatLng; d: number }[] = []
    for (const [key, cell] of small.grid) {
      const otherCell = big.grid.get(key)
      const neighbors: { w: number; i: number }[] = []
      if (otherCell) neighbors.push(...otherCell)
      // include adjacent cells to avoid boundary misses
      const [la, ln] = key.split(':').map(Number)
      for (const [dy, dx] of [[0, 1], [1, 0], [1, 1], [0, -1], [-1, 0], [-1, -1], [1, -1], [-1, 1]]) {
        const c2 = big.grid.get(`${la + dy}:${ln + dx}`)
        if (c2) neighbors.push(...c2)
      }
      if (!neighbors.length) continue
      for (const { w, i } of cell) {
        const p = small.ways[w].pts[i]
        for (const { w: w2, i: i2 } of neighbors) {
          const q = big.ways[w2].pts[i2]
          const d = fastDist(p, q)
          if (d < maxPairM) pairs.push({ a: p, b: q, d })
        }
      }
    }
    pairs.sort((x, y) => x.d - y.d)
    for (const pr of pairs) {
      const mid = { lat: (pr.a.lat + pr.b.lat) / 2, lng: (pr.a.lng + pr.b.lng) / 2 }
      if (out.some((c) => fastDist(c.pos, mid) < 1400)) continue
      const selfPt = small === this ? pr.a : pr.b
      const otherPt = small === this ? pr.b : pr.a
      out.push({ pos: mid, onSelf: selfPt, onOther: otherPt, kind: 'proximity', gapM: pr.d })
    }
    return out
  }

  /**
   * Network distance (meters) between two points snapped onto this net.
   * Returns undefined when they are on disconnected components.
   */
  alongDistance(a: LatLng, b: LatLng): number | undefined {
    const sa = this.nearest(a)
    const sb = this.nearest(b)
    if (!sa || !sb) return undefined
    const start = this.ways[sa.wayIdx].nodes[sa.ptIdx]
    const goal = this.ways[sb.wayIdx].nodes[sb.ptIdx]
    if (start === goal) return 0
    const dist = new Map<number, number>()
    const heap = new MinHeap()
    dist.set(start, 0)
    heap.push(start, 0)
    while (heap.size) {
      const { id, d } = heap.pop()!
      if (id === goal) return d
      if (d > (dist.get(id) ?? Infinity)) continue
      for (const e of this.adj.get(id) ?? []) {
        const nd = d + e.w
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd)
          heap.push(e.to, nd)
        }
      }
    }
    return undefined
  }

  /** One Dijkstra from `from`, reporting network distance to each target. */
  distancesTo(from: LatLng, targets: LatLng[]): (number | undefined)[] {
    const s = this.nearest(from)
    if (!s) return targets.map(() => undefined)
    const start = this.ways[s.wayIdx].nodes[s.ptIdx]
    const goalIds = targets.map((t) => {
      const st = this.nearest(t)
      return st ? this.ways[st.wayIdx].nodes[st.ptIdx] : undefined
    })
    const remaining = new Set(goalIds.filter((g): g is number => g !== undefined))
    const result = new Map<number, number>()
    const dist = new Map<number, number>()
    const heap = new MinHeap()
    dist.set(start, 0)
    heap.push(start, 0)
    while (heap.size && remaining.size) {
      const { id, d } = heap.pop()!
      if (d > (dist.get(id) ?? Infinity)) continue
      if (remaining.has(id)) {
        result.set(id, d)
        remaining.delete(id)
      }
      for (const e of this.adj.get(id) ?? []) {
        const nd = d + e.w
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd)
          heap.push(e.to, nd)
        }
      }
    }
    return goalIds.map((g) => (g === undefined ? undefined : result.get(g)))
  }

  /**
   * Walk `targetM` meters along the net from a point; among nodes at roughly
   * that network distance, pick the one matching the bearing hint if given.
   */
  walkAlong(from: LatLng, targetM: number, bearingHint?: number): LatLng | undefined {
    const s = this.nearest(from)
    if (!s) return undefined
    const start = this.ways[s.wayIdx].nodes[s.ptIdx]
    const slack = Math.max(targetM * 0.3, Math.min(900, Math.max(150, targetM)))
    const dist = new Map<number, number>()
    const heap = new MinHeap()
    dist.set(start, 0)
    heap.push(start, 0)
    let best: { pos: LatLng; err: number } | undefined
    while (heap.size) {
      const { id, d } = heap.pop()!
      if (d > (dist.get(id) ?? Infinity)) continue
      if (d > targetM + slack) continue
      const err = Math.abs(d - targetM)
      if (err <= slack) {
        const pos = this.nodePos.get(id)!
        const ok = bearingHint === undefined || bearingDiff(bearing(from, pos), bearingHint) <= 90
        if (ok && (!best || err < best.err)) best = { pos, err }
      }
      for (const e of this.adj.get(id) ?? []) {
        const nd = d + e.w
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd)
          heap.push(e.to, nd)
        }
      }
    }
    return best?.pos
  }

  /** Degree-1 nodes on substantial components (candidate road ends). */
  endpoints(): { id: number; pos: LatLng }[] {
    const minLen = Math.max(4000, 0.06 * Math.max(...this.componentLength, 0))
    const out: { id: number; pos: LatLng }[] = []
    for (const [id, edges] of this.adj) {
      if (edges.length !== 1) continue
      const ci = this.componentOf.get(id)
      if (ci === undefined || this.componentLength[ci] < minLen) continue
      out.push({ id, pos: this.nodePos.get(id)! })
    }
    return out
  }

  /**
   * The end of this road at a border: for Mexico the southernmost endpoint,
   * for Canada the northernmost, otherwise the endpoint nearest the
   * neighbouring place's centroid.
   */
  borderPoint(neighborKey: string, neighborCentroid?: LatLng): LatLng | undefined {
    const eps = this.endpoints()
    if (!eps.length) return undefined
    if (neighborKey === 'MX') return eps.reduce((a, b) => (a.pos.lat < b.pos.lat ? a : b)).pos
    if (neighborKey === 'CA_INTL') return eps.reduce((a, b) => (a.pos.lat > b.pos.lat ? a : b)).pos
    if (!neighborCentroid) return undefined
    return eps.reduce((a, b) =>
      haversine(a.pos, neighborCentroid) < haversine(b.pos, neighborCentroid) ? a : b,
    ).pos
  }
}

function cluster(points: LatLng[], radiusM: number): LatLng[] {
  const out: LatLng[] = []
  for (const p of points) {
    if (!out.some((c) => fastDist(c, p) < radiusM)) out.push(p)
  }
  return out
}
