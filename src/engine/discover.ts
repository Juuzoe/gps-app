import type { LatLng, RoadRef } from './types'
import { fastDist } from './geo'
import { mirrorCount, overpassQuery, CancelledError } from './overpass'
import { stateInfo } from './states'
import { clipToState } from './statepoly'

/**
 * Server-side junction discovery.
 *
 * The expensive way to find where road A meets road B is to download both
 * roads' geometry (megabytes, several round trips) and intersect client-side.
 * Overpass can do the intersection itself and return only the meeting places:
 *
 *   node(w.a)(w.b)             — shared nodes (at-grade crossings, and the
 *                                whole cloud of a concurrency)
 *   way.b(around.a:900)        — B's ways near A (grade-separated interchanges
 *                                and terminus merges), as `out center` points
 *
 * One request carries EVERY transition of a route: each road's way-set is
 * declared once and reused across the pairs that touch it, `make` sentinels
 * delimit the per-pair output blocks, and the payload is tens of kilobytes.
 * Measured: four pairs plus an endpoint sweep in a single 129KB / 46s query,
 * against megabytes and a round trip per road before.
 */

const HIGHWAY = '^(motorway|trunk|primary|secondary|tertiary|unclassified)$'

export interface DiscoverPairSpec {
  id: string
  a: RoadRef[]
  b: RoadRef[]
}

export interface DiscoverEdgeSpec {
  id: string
  road: RoadRef
}

export interface PairDiscovery {
  /** Shared-node points — exact meeting places and concurrency clouds. */
  shared: LatLng[]
  /** Centres of B-ways near A — grade-separated interchanges, merges. */
  near: LatLng[]
}

export interface EdgeDiscovery {
  pts: LatLng[]
  /** The sweep returned exactly its cap: the list may be missing exactly the
   *  extreme ways an endpoint decision needs. Extremal conclusions from a
   *  capped list are unsafe — callers must fall back, not guess. */
  capped: boolean
}

export interface DiscoveryOut {
  pairs: Map<string, PairDiscovery>
  edges: Map<string, EdgeDiscovery>
  failedChunks: number
}

/**
 * Roads per query.
 *
 * Query cost is roughly linear in the number of road scans it contains
 * (~15-25s each against a public mirror), and the scans inside one query run
 * in series — a 7-road chunk measured over 90s. Chunks run concurrently, so
 * fewer roads per chunk means more total server work but far less waiting:
 * ten roads as one chunk is ~100s, as four parallel chunks it is ~30s.
 */
const ROADS_PER_CHUNK = 3

/**
 * Roads per query, given how expensive one road's scan is.
 *
 * Each request also pays the mirror's queue wait before it runs — measured at
 * 14s for a no-op query on the busiest day — so the request COUNT matters as
 * much as request size. When a corridor bbox makes scans cheap, pack many
 * roads into few requests; when scans are statewide (~15-25s each), keep
 * chunks small so a query never brushes the server's 150s kill.
 */
function roadsPerChunk(
  state: string,
  globalBox: Bounds | undefined,
  perPair: Map<string, Bounds> | undefined,
  pairs: DiscoverPairSpec[],
): number {
  const sb = stateInfo(state)?.bbox
  if (!sb) return ROADS_PER_CHUNK
  const area = (b: readonly number[]) => Math.max(1e-4, (b[2] - b[0]) * (b[3] - b[1]))
  let ratio = 1
  if (globalBox) ratio = Math.min(1, area(globalBox) / area(sb))
  else if (perPair && pairs.length) {
    let s = 0
    for (const p of pairs) {
      const b = perPair.get(p.id)
      s += b ? Math.min(1, area(b) / area(sb)) : 1
    }
    ratio = s / pairs.length
  } else return ROADS_PER_CHUNK
  const scanCostS = 20 * ratio + 0.5
  return Math.max(ROADS_PER_CHUNK, Math.min(16, Math.floor(80 / scanCostS)))
}

interface Chunk {
  pairs: DiscoverPairSpec[]
  edges: DiscoverEdgeSpec[]
  roads: Map<string, RoadRef>
}

function chunkSpecs(pairs: DiscoverPairSpec[], edges: DiscoverEdgeSpec[], perChunk = ROADS_PER_CHUNK): Chunk[] {
  const chunks: Chunk[] = []
  let cur: Chunk = { pairs: [], edges: [], roads: new Map() }
  const roadsOf = (p: DiscoverPairSpec) => [...p.a, ...p.b]
  const fits = (refs: RoadRef[]) => {
    const added = refs.filter((r) => !cur.roads.has(r.key)).length
    return cur.roads.size + added <= perChunk || cur.roads.size === 0
  }
  const push = () => {
    if (cur.pairs.length || cur.edges.length) chunks.push(cur)
    cur = { pairs: [], edges: [], roads: new Map() }
  }
  // Consecutive pairs share roads (the route is a chain), so filling chunks in
  // order keeps each road's scan inside one query.
  for (const p of pairs) {
    if (!fits(roadsOf(p))) push()
    cur.pairs.push(p)
    for (const r of roadsOf(p)) cur.roads.set(r.key, r)
  }
  for (const e of edges) {
    if (!fits([e.road])) push()
    cur.edges.push(e)
    cur.roads.set(e.road.key, e.road)
  }
  push()
  return chunks
}

function buildChunkQuery(state: string, chunk: Chunk, bbox?: Bounds): string {
  const bb = bbox ?? stateInfo(state)?.bbox
  if (!bb) throw new Error(`No bounding box for ${state}`)
  const B = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`
  const setOf = new Map<string, string>()
  let q = `[out:json][timeout:150];\n`
  let i = 0
  for (const [key, ref] of chunk.roads) {
    const name = `s${i++}`
    setOf.set(key, name)
    q += `way(${B})[highway~"${HIGHWAY}"][ref~"${ref.osmRefRegex}"]->.${name};\n`
  }
  const sideSet = (refs: RoadRef[]): string => {
    if (refs.length === 1) return setOf.get(refs[0].key)!
    const name = `u${i++}`
    q += `(${refs.map((r) => `.${setOf.get(r.key)!};`).join(' ')})->.${name};\n`
    return name
  }
  for (const p of chunk.pairs) {
    const A = sideSet(p.a)
    const Bs = sideSet(p.b)
    q += `make sep k="${p.id}"; out;\n`
    q += `node(w.${A})(w.${Bs}); out qt 1500;\n`
    q += `way.${Bs}(around.${A}:900); out center qt 400;\n`
  }
  for (const e of chunk.edges) {
    q += `make sep k="${e.id}"; out;\n`
    // Effectively uncapped: qt truncation is spatially biased, and dropping a
    // road's westernmost ways moved a border endpoint 70 miles inland. Centres
    // are ~40 bytes each, so even a 4000-way interstate is a small payload.
    q += `.${setOf.get(e.road.key)!} out center qt 4000;\n`
  }
  return q
}

export type Bounds = [number, number, number, number]

function boundsKey(b?: Bounds): string {
  return b ? b.map((v) => v.toFixed(1)).join(',') : 'state'
}

function chunkKey(state: string, chunk: Chunk, bbox?: Bounds): string {
  const parts = [
    ...chunk.pairs.map((p) => `P:${p.a.map((r) => r.key).join('+')}|${p.b.map((r) => r.key).join('+')}`),
    ...chunk.edges.map((e) => `E:${e.road.key}`),
  ]
  return `disc3:${state}:${boundsKey(bbox)}:${parts.sort().join(';')}`
}

const EDGE_CAP = 4000

function parseChunk(state: string, json: any, out: DiscoveryOut) {
  let current: string | undefined
  for (const el of json.elements ?? []) {
    if (el.type === 'sep') {
      current = el.tags?.k
      if (current?.startsWith('edge') && !out.edges.has(current)) out.edges.set(current, { pts: [], capped: false })
      if (current?.startsWith('pair') && !out.pairs.has(current)) out.pairs.set(current, { shared: [], near: [] })
      continue
    }
    if (!current) continue
    if (el.type === 'node' && el.lat !== undefined) {
      out.pairs.get(current)?.shared.push({ lat: el.lat, lng: el.lon })
    } else if (el.type === 'way' && el.center) {
      const p = { lat: el.center.lat, lng: el.center.lon }
      if (current.startsWith('edge')) out.edges.get(current)?.pts.push(p)
      else out.pairs.get(current)?.near.push(p)
    }
  }
  // Clipping is STRICT (see statepoly): junction candidates and endpoints in a
  // neighbouring state are wrong answers, and an empty result after clipping
  // is a real fact the caller must handle, not paper over.
  for (const [k, v] of out.pairs) {
    out.pairs.set(k, { shared: clipToState(state, v.shared), near: clipToState(state, v.near) })
  }
  for (const [k, v] of out.edges) {
    out.edges.set(k, { pts: clipToState(state, v.pts), capped: v.pts.length >= EDGE_CAP })
  }
}

/** Run all chunks concurrently, one lane per mirror. */
export async function discover(
  state: string,
  pairs: DiscoverPairSpec[],
  edges: DiscoverEdgeSpec[],
  onProgress?: (done: number, total: number) => void,
  bbox?: Bounds | Map<string, Bounds>,
): Promise<DiscoveryOut> {
  const out: DiscoveryOut = { pairs: new Map(), edges: new Map(), failedChunks: 0 }
  const perPair = bbox instanceof Map ? bbox : undefined
  const globalBox = bbox instanceof Map ? undefined : bbox
  // The scan box for one query: the union of its pairs' own bounds. Chunks
  // hold consecutive pairs of the chain, so the union stays local. Any pair
  // without bounds (or any edge sweep) makes the chunk statewide.
  const boxOf = (chunk: Chunk): Bounds | undefined => {
    if (globalBox) return globalBox
    if (!perPair || chunk.edges.length) return undefined
    let u: Bounds | undefined
    for (const p of chunk.pairs) {
      const b = perPair.get(p.id)
      if (!b) return undefined
      u = u ? [Math.min(u[0], b[0]), Math.min(u[1], b[1]), Math.max(u[2], b[2]), Math.max(u[3], b[3])] : b
    }
    return u
  }
  const chunks = chunkSpecs(pairs, edges, roadsPerChunk(state, globalBox, perPair, pairs))
  if (chunks.length === 0) return out
  // Up to two concurrent requests per mirror — exactly the documented
  // Overpass courtesy quota — but only when there are chunks queued for them.
  const lanes = Math.min(2 * mirrorCount(), 5, chunks.length)
  let next = 0
  let done = 0
  onProgress?.(0, chunks.length)
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      for (;;) {
        const mine = next++
        if (mine >= chunks.length) return
        try {
          const cbox = boxOf(chunks[mine])
          const json = await overpassQuery(
            buildChunkQuery(state, chunks[mine], cbox),
            chunkKey(state, chunks[mine], cbox),
            150_000,
            lane,
          )
          parseChunk(state, json, out)
        } catch (e) {
          if (e instanceof CancelledError) throw e
          // Retry this chunk one spec at a time before giving up: a failed
          // chunk used to send every pair in it down the geometry fallback —
          // and silently lose its edge sweeps, which is how a border endpoint
          // vanished and sank a whole build during one mirror outage.
          let recovered = 0
          const soloChunks: Chunk[] = [
            ...chunks[mine].pairs.map((p): Chunk => {
              const solo: Chunk = { pairs: [p], edges: [], roads: new Map() }
              for (const r of [...p.a, ...p.b]) solo.roads.set(r.key, r)
              return solo
            }),
            ...chunks[mine].edges.map((e): Chunk => {
              const solo: Chunk = { pairs: [], edges: [e], roads: new Map() }
              solo.roads.set(e.road.key, e.road)
              return solo
            }),
          ]
          for (const solo of soloChunks) {
            try {
              const sbox = boxOf(solo)
              const j = await overpassQuery(
                buildChunkQuery(state, solo, sbox),
                chunkKey(state, solo, sbox),
                90_000,
                lane,
              )
              parseChunk(state, j, out)
              recovered++
            } catch (e2) {
              if (e2 instanceof CancelledError) throw e2
            }
          }
          if (recovered < soloChunks.length) out.failedChunks++
          // ensure the ids exist so callers see "no candidates" rather than
          // "not asked", and fall back per pair
          for (const p of chunks[mine].pairs) if (!out.pairs.has(p.id)) out.pairs.set(p.id, { shared: [], near: [] })
          for (const ed of chunks[mine].edges) if (!out.edges.has(ed.id)) out.edges.set(ed.id, { pts: [], capped: false })
        }
        done++
        onProgress?.(done, chunks.length)
      }
    }),
  )
  return out
}

/* ------------------------------------------------------------------ */
/* candidate extraction                                                */
/* ------------------------------------------------------------------ */

export interface JunctionPoint {
  pos: LatLng
  /** true when backed by a shared OSM node (exact), false for proximity. */
  exact: boolean
}

/**
 * Meeting places from raw discovery points.
 *
 * Points cluster at interchanges. A concurrency returns a long thin cloud of
 * shared nodes; its two ends are where the roads join and part, so elongated
 * clusters contribute their extremes instead of a meaningless centroid.
 */
export function junctionCandidates(d: PairDiscovery): JunctionPoint[] {
  const out: JunctionPoint[] = []
  for (const { pts, exact } of [
    { pts: d.shared, exact: true },
    { pts: d.near, exact: false },
  ]) {
    for (const cluster of clusterPoints(pts, 1500)) {
      const [p, q] = farthestPair(cluster)
      if (fastDist(p, q) > 2500) {
        out.push({ pos: p, exact }, { pos: q, exact })
      } else {
        out.push({ pos: centroid(cluster), exact })
      }
    }
  }
  // exact points shadow proximity points at the same interchange
  return out.filter((c, i) => !out.some((o, j) => j < i && fastDist(o.pos, c.pos) < 1200))
}

function clusterPoints(pts: LatLng[], radiusM: number): LatLng[][] {
  const clusters: LatLng[][] = []
  for (const p of pts) {
    const home = clusters.find((c) => c.some((q) => fastDist(p, q) < radiusM))
    if (home) home.push(p)
    else clusters.push([p])
  }
  // merge clusters that grew into each other
  for (let i = 0; i < clusters.length; i++) {
    for (let j = clusters.length - 1; j > i; j--) {
      if (clusters[i].some((p) => clusters[j].some((q) => fastDist(p, q) < radiusM))) {
        clusters[i].push(...clusters[j])
        clusters.splice(j, 1)
      }
    }
  }
  return clusters
}

function farthestPair(pts: LatLng[]): [LatLng, LatLng] {
  if (pts.length === 1) return [pts[0], pts[0]]
  // pivot heuristic: far from an arbitrary point, then far from that
  let a = pts[0]
  for (const p of pts) if (fastDist(pts[0], p) > fastDist(pts[0], a)) a = p
  let b = pts[0]
  for (const p of pts) if (fastDist(a, p) > fastDist(a, b)) b = p
  return [a, b]
}

function centroid(pts: LatLng[]): LatLng {
  let lat = 0
  let lng = 0
  for (const p of pts) {
    lat += p.lat
    lng += p.lng
  }
  return { lat: lat / pts.length, lng: lng / pts.length }
}
