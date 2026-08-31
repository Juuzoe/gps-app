import type { LatLng, RoadRef } from './types'
import { stateInfo } from './states'
import { clipToState } from './statepoly'

/**
 * Overpass client.
 *
 * Two rules keep this fast enough to use interactively:
 *
 *  1. Never use `area["ISO3166-2"=…]`. Resolving an administrative area is by
 *     far the most expensive part of a query and is what makes public mirrors
 *     return 504s. A plain bbox hits the spatial index instead — measured on
 *     US-87 in Texas: bbox 17s / 0.17MB against area 49s / timeout.
 *  2. Fetch the corridor, not the state. A leg needs its road for the few tens
 *     of miles it actually travels, so requests are scoped to a disc around the
 *     known position wherever possible. Statewide US-87 is 1.8MB; the 45km disc
 *     the leg uses is 0.17MB.
 *
 * Requests for several roads are unioned into ONE query, so a build costs a
 * couple of round trips rather than one per road.
 */

export interface OverpassWay {
  id: number
  nodes: number[]
  geometry: LatLng[]
  tags: Record<string, string>
}

export interface Cache {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
}

export class MemoryCache implements Cache {
  private m = new Map<string, string>()
  async get(k: string) { return this.m.get(k) }
  async set(k: string, v: string) { this.m.set(k, v) }
}

// Browsers need CORS, which the overpass-api.de family and the VK mirror
// serve; node can also use mirrors that omit CORS headers.
const IN_BROWSER = typeof document !== 'undefined'
const MIRRORS = IN_BROWSER
  ? [
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
    ]
  : [
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass-api.de/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
      'https://z.overpass-api.de/api/interpreter',
    ]

const UA = 'route-navigator/1.0 (oversize permit routing)'
// Ref-carrying roads never sit below `unclassified`; named local streets are
// fetched separately by fetchStreetWays, which does not filter on class.
const HIGHWAY = '^(motorway|trunk|primary|secondary|tertiary|unclassified)$'

let cache: Cache = new MemoryCache()
export function setCache(c: Cache) { cache = c }

/** Aborts every in-flight request; used by the UI's cancel button. */
let inflight = new Set<AbortController>()
export function abortAll() {
  for (const c of inflight) c.abort()
  inflight.clear()
  // Requests queued for a mirror slot are not in flight yet; reject them too
  // or a cancelled build would wait on the queue forever.
  for (const s of mirrorSlots) {
    for (const w of s.q.splice(0)) w.no(new CancelledError())
  }
}

/** Start at whichever mirror answered last, so a dead one costs one timeout. */
let preferredMirror = (() => {
  try {
    const v = typeof localStorage !== 'undefined' ? localStorage.getItem('rb-mirror') : null
    return v ? Math.min(Number(v) || 0, MIRRORS.length - 1) : 0
  } catch {
    return 0
  }
})()

export class OverpassError extends Error {}

/**
 * Per-mirror circuit breaker.
 *
 * Public mirrors go down for hours at a time. Without this, every request
 * still tried a dead host first and paid its full timeout — with several
 * lanes running, that is minutes of pure waiting per build. A mirror that
 * fails is skipped for a cooldown, unless every mirror is failing, in which
 * case they are all retried rather than declaring defeat.
 */
const mirrorDownUntil = new Array(MIRRORS.length).fill(0)
const MIRROR_COOLDOWN_MS = 600_000

function mirrorOrder(start: number): number[] {
  const now = Date.now()
  const all = MIRRORS.map((_, i) => (start + i) % MIRRORS.length)
  const live = all.filter((i) => mirrorDownUntil[i] <= now)
  const dead = all.filter((i) => !live.includes(i))
  // Two passes over the live mirrors before touching dead ones: when a single
  // survivor is carrying everything, its transient failure should be retried
  // there — marching into known-dead hosts just converts one hiccup into a
  // parade of connect timeouts and then a failed build.
  return live.length ? [...live, ...live, ...dead] : all
}

/** How many mirrors are answering right now, for the UI's honesty note. */
export function mirrorHealth(): { live: number; total: number } {
  const now = Date.now()
  return { live: mirrorDownUntil.filter((t) => t <= now).length, total: MIRRORS.length }
}

/**
 * Preflight: probe every mirror with a trivial query before real ones go out.
 *
 * A dead mirror fails a probe in seconds, but fails a real query only after a
 * TCP connect timeout the browser stretches to 30-150s. Without this, a build
 * that starts while mirrors are down parks its parallel lanes on the dead
 * hosts and looks frozen — one observed build sat at "1 of 7 lookups" for two
 * minutes for exactly this reason. Probes re-run at most every 90s, cost ~1s
 * when everything is healthy, and recover a mirror within one interval.
 */
const PROBE_INTERVAL_MS = 90_000
const PROBE_TIMEOUT_MS = 8_000
let lastProbe = 0
let probeRun: Promise<void> | undefined

function ensureMirrorsProbed(): Promise<void> {
  if (Date.now() - lastProbe < PROBE_INTERVAL_MS) return probeRun ?? Promise.resolve()
  lastProbe = Date.now()
  probeRun = Promise.all(
    MIRRORS.map(async (url, i) => {
      const ctrl = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, PROBE_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method: 'POST',
          body: 'data=' + encodeURIComponent('[out:json][timeout:5];out count;'),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
          signal: ctrl.signal,
        })
        if (res.ok) mirrorDownUntil[i] = 0
        else if (res.status >= 500 || res.status === 429) mirrorDownUntil[i] = Date.now() + MIRROR_COOLDOWN_MS
      } catch {
        // Only a probe that failed on its own merits marks the mirror down; an
        // external abort (user cancelled) says nothing about the host.
        if (timedOut || !ctrl.signal.aborted) mirrorDownUntil[i] = Date.now() + MIRROR_COOLDOWN_MS
      } finally {
        clearTimeout(timer)
      }
    }),
  ).then(() => undefined)
  return probeRun
}

/**
 * At most two in-flight requests per mirror — the documented Overpass courtesy
 * quota. This used to be implicit in lane-to-mirror assignment; now that every
 * lane prefers whichever mirrors are alive, the limit must be enforced here or
 * five lanes hammer the one surviving host and trade timeouts for 429s.
 */
const PER_MIRROR = 2
const mirrorSlots = MIRRORS.map(() => ({ n: 0, q: [] as { ok: () => void; no: (e: Error) => void }[] }))

function acquireSlot(i: number): Promise<void> {
  const s = mirrorSlots[i]
  if (s.n < PER_MIRROR) {
    s.n++
    return Promise.resolve()
  }
  return new Promise((ok, no) => s.q.push({ ok, no }))
}

function releaseSlot(i: number) {
  const s = mirrorSlots[i]
  const next = s.q.shift()
  if (next) next.ok()
  else s.n = Math.max(0, s.n - 1)
}

/** Low-level query entry for other modules (discovery layer). */
export function overpassQuery(query: string, cacheKey: string, timeoutMs = 90_000, startMirror?: number): Promise<any> {
  return overpass(query, cacheKey, timeoutMs, startMirror)
}

export function mirrorCount(): number {
  return MIRRORS.length
}

async function overpass(query: string, cacheKey: string, timeoutMs = 90_000, startMirror?: number): Promise<any> {
  const hit = await cache.get(cacheKey)
  if (hit) return JSON.parse(hit)
  await ensureMirrorsProbed()
  let lastErr: unknown
  const order = mirrorOrder(startMirror ?? preferredMirror)
  for (let attempt = 0; attempt < order.length; attempt++) {
    const idx = order[attempt]
    const url = MIRRORS[idx]
    await acquireSlot(idx)
    const ctrl = new AbortController()
    inflight.add(ctrl)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; ctrl.abort() }, timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        signal: ctrl.signal,
      })
      const text = await res.text()
      if (!res.ok || text.trimStart().startsWith('<')) {
        lastErr = new OverpassError(`${res.status} from ${new URL(url).host}`)
        if (res.status >= 500) mirrorDownUntil[idx] = Date.now() + MIRROR_COOLDOWN_MS
        await backoff(attempt)
        continue
      }
      const json = JSON.parse(text)
      // Overpass reports its own timeouts as HTTP 200 with a `remark` and no
      // elements. Taken at face value that reads as "this road does not exist",
      // which is how whole junctions silently went missing.
      if (typeof json.remark === 'string' && /error|timed out|runtime/i.test(json.remark)) {
        lastErr = new OverpassError(`${json.remark.trim()} (${new URL(url).host})`)
        await backoff(attempt)
        continue
      }
      preferredMirror = idx
      mirrorDownUntil[idx] = 0
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem('rb-mirror', String(idx))
      } catch { /* storage unavailable */ }
      // Never cache an empty response. Overpass returns 200 with no elements
      // for queries that failed server-side, and caching that turns one bad
      // moment into a permanent wrong answer. Count queries return an element,
      // so they still cache normally.
      if (!Array.isArray(json.elements) || json.elements.length > 0) {
        await cache.set(cacheKey, text)
      }
      return json
    } catch (e) {
      lastErr = timedOut ? new OverpassError(`timed out on ${new URL(url).host}`) : e
      // A timeout or a transport error means this host is not answering now.
      mirrorDownUntil[idx] = Date.now() + MIRROR_COOLDOWN_MS
      // An abort means either our timeout (try the next mirror) or the user
      // cancelling the build (stop immediately).
      if (!timedOut && e instanceof Error && e.name === 'AbortError') throw new CancelledError()
      if (e instanceof CancelledError) throw e
    } finally {
      clearTimeout(timer)
      inflight.delete(ctrl)
      releaseSlot(idx)
    }
  }
  throw lastErr instanceof Error ? lastErr : new OverpassError('request failed')
}

/** A struggling mirror needs a moment, and hammering it is impolite besides. */
function backoff(attempt: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.min(8000, 1500 * (attempt + 1))))
}

export class CancelledError extends Error {
  constructor() { super('Build cancelled') }
}

function toWays(elements: any[]): OverpassWay[] {
  const out: OverpassWay[] = []
  for (const el of elements ?? []) {
    if (el.type !== 'way' || !el.geometry) continue
    out.push({
      id: el.id,
      nodes: el.nodes ?? [],
      geometry: el.geometry.map((g: any) => ({ lat: g.lat, lng: g.lon })),
      tags: el.tags ?? {},
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* scoped, batched road fetching                                       */
/* ------------------------------------------------------------------ */

export type Scope =
  | { kind: 'state'; code: string }
  | { kind: 'near'; center: LatLng; radiusM: number }

export interface RoadRequest {
  ref: RoadRef
  scope: Scope
}

const RADIUS_LADDER = [25, 50, 100, 200, 400, 700].map((km) => km * 1000)

/**
 * Snap a scope to a coarse grid so that near-identical requests share a cache
 * entry. Without this, a disc centred on a resolved position gets a slightly
 * different key on every run — positions shift by metres, and the whole route
 * is re-fetched. Radii only ever round up, so coverage is never reduced.
 */
export function normalizeScope(s: Scope): Scope {
  if (s.kind === 'state') return s
  const q = 0.05
  return {
    kind: 'near',
    center: { lat: Math.round(s.center.lat / q) * q, lng: Math.round(s.center.lng / q) * q },
    radiusM: RADIUS_LADDER.find((r) => r >= s.radiusM) ?? RADIUS_LADDER[RADIUS_LADDER.length - 1],
  }
}

function scopeKey(s: Scope): string {
  return s.kind === 'state'
    ? `st:${s.code}`
    : `nr:${s.center.lat.toFixed(2)},${s.center.lng.toFixed(2)}:${Math.round(s.radiusM / 1000)}`
}

function scopeClause(s: Scope): string {
  if (s.kind === 'near') {
    return `way(around:${Math.round(s.radiusM)},${s.center.lat.toFixed(5)},${s.center.lng.toFixed(5)})`
  }
  const bb = stateInfo(s.code)?.bbox
  if (!bb) throw new OverpassError(`No bounding box known for ${s.code}`)
  return `way(${bb[0]},${bb[1]},${bb[2]},${bb[3]})`
}

const cacheKeyFor = (r: RoadRequest) => `w3:${r.ref.key}:${scopeKey(r.scope)}`

/**
 * Fetch several roads in a single request. Cached entries are served without
 * hitting the network; only the misses are unioned into one query.
 */
export type FetchProgress = (doneRoads: number, totalRoads: number) => void

export async function fetchRoads(
  requests: RoadRequest[],
  onProgress?: FetchProgress,
  startMirror?: number,
): Promise<Map<string, OverpassWay[]>> {
  const out = new Map<string, OverpassWay[]>()
  const misses: RoadRequest[] = []
  for (const r of requests) {
    const hit = await cache.get(cacheKeyFor(r))
    if (hit) mergeInto(out, r.ref.key, toWays(JSON.parse(hit).elements))
    else misses.push(r)
  }
  if (misses.length === 0) return out

  // A union has a practical size limit: 13 roads at once made mirrors time out
  // and retry for minutes, while chunks of this size come back in 20-40s.
  //
  // Chunks run CONCURRENTLY, one lane per mirror, at most one request per
  // mirror at a time (the documented Overpass courtesy limit is two slots per
  // IP per endpoint, so one is comfortably polite). Serial chunks left three
  // healthy mirrors idle while the user watched one crawl.
  const CHUNK = 5
  if (misses.length > CHUNK) {
    const chunks: RoadRequest[][] = []
    for (let i = 0; i < misses.length; i += CHUNK) chunks.push(misses.slice(i, i + CHUNK))
    const lanes = Math.min(3, MIRRORS.length, chunks.length)
    let next = 0
    let doneRoads = 0
    onProgress?.(0, misses.length)
    await Promise.all(
      Array.from({ length: lanes }, async (_, lane) => {
        for (;;) {
          const mine = next++
          if (mine >= chunks.length) return
          const part = await fetchRoads(chunks[mine], undefined, (preferredMirror + lane) % MIRRORS.length)
          for (const [k, v] of part) mergeInto(out, k, v)
          doneRoads += chunks[mine].length
          onProgress?.(doneRoads, misses.length)
        }
      }),
    )
    return out
  }
  onProgress?.(0, misses.length)

  const parts = misses.map((r) => `${scopeClause(r.scope)}[highway~"${HIGHWAY}"][ref~"${r.ref.osmRefRegex}"];`)
  const query = `[out:json][timeout:90];(${parts.join('')});out geom;`
  const key = 'batch:' + misses.map(cacheKeyFor).sort().join('|')
  let json: any
  try {
    json = await overpass(query, key, 75_000, startMirror)
  } catch (e) {
    // One big union can exceed a mirror's limits where two halves succeed.
    if (misses.length < 2 || (e instanceof Error && e.name === 'CancelledError')) throw e
    const mid = Math.ceil(misses.length / 2)
    const [a, b] = await Promise.all([
      fetchRoads(misses.slice(0, mid), undefined, startMirror),
      fetchRoads(misses.slice(mid), undefined, startMirror),
    ])
    for (const [k, v] of a) mergeInto(out, k, v)
    for (const [k, v] of b) mergeInto(out, k, v)
    return out
  }
  const ways = toWays(json.elements)

  // The union response is undivided, so ways are attributed back to the roads
  // that asked for them. A way on a concurrency belongs to several, correctly.
  const perRoad = new Map<string, OverpassWay[]>()
  for (const r of misses) if (!perRoad.has(r.ref.key)) perRoad.set(r.ref.key, [])
  for (const w of ways) {
    const ref = w.tags.ref ?? ''
    for (const r of misses) {
      if (new RegExp(r.ref.osmRefRegex, 'i').test(ref)) perRoad.get(r.ref.key)!.push(w)
    }
  }
  for (const r of misses) {
    const got = perRoad.get(r.ref.key) ?? []
    // Deliberately not cached when empty: an empty answer is far more often a
    // query that failed than a road that does not exist, and caching it makes
    // the failure permanent. Re-asking costs one query per build at worst.
    if (got.length) await cache.set(cacheKeyFor(r), JSON.stringify({ elements: got.map(unWay) }))
    mergeInto(out, r.ref.key, got)
  }
  return out
}

function unWay(w: OverpassWay) {
  return {
    type: 'way', id: w.id, nodes: w.nodes, tags: w.tags,
    geometry: w.geometry.map((p) => ({ lat: p.lat, lon: p.lng })),
  }
}

function mergeInto(map: Map<string, OverpassWay[]>, key: string, ways: OverpassWay[]) {
  const cur = map.get(key)
  if (!cur) { map.set(key, ways); return }
  const seen = new Set(cur.map((w) => w.id))
  for (const w of ways) if (!seen.has(w.id)) cur.push(w)
}

export function pickExtreme(ptsIn: LatLng[], stateCode: string, neighborKey: string): LatLng | undefined {
  // A bbox query reaches into neighbouring states, so drop anything outside
  // this one before taking the extreme — otherwise the "state line" lands deep
  // inside the neighbour.
  const pts = clipToState(stateCode, ptsIn)
  if (!pts.length) return undefined
  if (neighborKey === 'MX') return extreme(pts, (p) => -p.lat)
  if (neighborKey === 'CA_INTL') return extreme(pts, (p) => p.lat)
  const st = stateInfo(stateCode)
  const nb = stateInfo(neighborKey)
  if (!st || !nb) return undefined
  const dLat = nb.centroid.lat - st.centroid.lat
  const dLng = nb.centroid.lng - st.centroid.lng
  const len = Math.hypot(dLat, dLng) || 1
  return extreme(pts, (p) => ((p.lat - st.centroid.lat) * dLat + (p.lng - st.centroid.lng) * dLng) / len)
}


/**
 * Where a road reaches the state line, as a coordinate.
 *
 * Uses `out ids center` — one point per way instead of full geometry, so a
 * statewide sweep of I-10 costs 0.33MB rather than 2.4MB — then picks the
 * extreme in the direction of the neighbouring place.
 */
export async function fetchRoadEdge(
  stateCode: string,
  ref: RoadRef,
  neighborKey: string,
): Promise<LatLng | undefined> {
  const bb = stateInfo(stateCode)?.bbox
  if (!bb) return undefined
  const q =
    `[out:json][timeout:120];way(${bb[0]},${bb[1]},${bb[2]},${bb[3]})` +
    `[highway~"${HIGHWAY}"][ref~"${ref.osmRefRegex}"];out ids center;`
  const json = await overpass(q, `edge2:${stateCode}:${ref.key}`, 90_000)
  const pts: LatLng[] = (json.elements ?? [])
    .filter((e: any) => e.center)
    .map((e: any) => ({ lat: e.center.lat, lng: e.center.lon }))
  const clipped = clipToState(stateCode, pts)
  const { pickBorderCrossing } = await import('./statepoly')
  return (await pickBorderCrossing(clipped, stateCode, neighborKey))?.pos
}

function extreme(pts: LatLng[], score: (p: LatLng) => number): LatLng {
  let best = pts[0]
  let bestScore = score(pts[0])
  for (const p of pts) {
    const s = score(p)
    if (s > bestScore) { best = p; bestScore = s }
  }
  return best
}

/**
 * Where two roads meet, plus way-centres of an anchor road to pick between
 * several meeting places (business routes pair with their parent in many
 * towns). One round trip, a few KB — against the two statewide full-geometry
 * fetches (megabytes, 504-prone) this replaces.
 */
export async function fetchIntersections(
  stateCode: string,
  refA: RoadRef,
  refB: RoadRef,
  anchor?: RoadRef,
): Promise<{ nodes: LatLng[]; anchorCenters: LatLng[] }> {
  const bb = stateInfo(stateCode)?.bbox
  if (!bb) return { nodes: [], anchorCenters: [] }
  const box = `${bb[0]},${bb[1]},${bb[2]},${bb[3]}`
  let q =
    `[out:json][timeout:90];` +
    `way(${box})[highway~"${HIGHWAY}"][ref~"${refA.osmRefRegex}"]->.a;` +
    `way(${box})[highway~"${HIGHWAY}"][ref~"${refB.osmRefRegex}"]->.b;` +
    `node(w.a)(w.b);out;`
  if (anchor) q += `way(${box})[highway~"${HIGHWAY}"][ref~"${anchor.osmRefRegex}"];out ids center;`
  const key = `isect:${stateCode}:${refA.key}x${refB.key}:${anchor?.key ?? ''}`
  const json = await overpass(q, key, 75_000)
  const nodes: LatLng[] = []
  const anchorCenters: LatLng[] = []
  for (const el of json.elements ?? []) {
    if (el.type === 'node') nodes.push({ lat: el.lat, lng: el.lon })
    else if (el.type === 'way' && el.center) anchorCenters.push({ lat: el.center.lat, lng: el.center.lon })
  }
  return { nodes, anchorCenters }
}

/** Cheap existence probe, used to disambiguate which state a route crosses.
 *
 * Returns centres and clips them to the real state outline rather than
 * counting inside the bbox: Kentucky's bounding box overlaps the corner of
 * Virginia where I-81 runs, so a bare count said I-81 "exists in Kentucky"
 * and sent a whole route to the wrong state. */
export async function roadExists(stateCode: string, ref: RoadRef): Promise<boolean> {
  const bb = stateInfo(stateCode)?.bbox
  if (!bb) return false
  const { loadStatePolygon } = await import('./statepoly')
  await loadStatePolygon(stateCode)
  // Sample in id order, never `qt`: quadtile order is spatially biased, so a
  // capped sample of a long road collapses onto one corner of the bbox — and
  // a bbox corner can lie OUTSIDE the state. The Texas box's west edge sits
  // exactly on Albuquerque, so a qt sample of I-40 returned 200 New Mexican
  // ways, the clip rejected them all, and "I-40 is not in Texas" got cached.
  // The count output makes the response non-empty even for a road the state
  // does not have, so the honest negative is cacheable too.
  const q =
    `[out:json][timeout:60];way(${bb[0]},${bb[1]},${bb[2]},${bb[3]})` +
    `[highway~"${HIGHWAY}"][ref~"${ref.osmRefRegex}"]->.r;.r out count;.r out center 200;`
  const json = await overpass(q, `exists5:${stateCode}:${ref.key}`, 60_000)
  const pts: LatLng[] = (json.elements ?? [])
    .filter((e: any) => e.center)
    .map((e: any) => ({ lat: e.center.lat, lng: e.center.lon }))
  if (!pts.length) return false
  const { hasStatePolygon, isInState } = await import('./statepoly')
  if (hasStatePolygon(stateCode)) return pts.some((p) => isInState(stateCode, p))
  // Outline unknown (its service unreachable): being unable to clip must not
  // manufacture existence from bbox-corner leakage, so accept only samples
  // well inside the bbox — neighbouring states reach at most a fraction of a
  // degree past a border into the box.
  const inset = 0.25
  return pts.some(
    (p) =>
      p.lat > bb[0] + inset && p.lat < bb[2] - inset && p.lng > bb[1] + inset && p.lng < bb[3] - inset,
  )
}

/** Exit (motorway_junction) nodes with a given ref, near a point. */
export async function fetchExitNodesNear(
  ref: RoadRef,
  exitRef: string,
  center: LatLng,
  radiusM: number,
): Promise<LatLng[]> {
  const q =
    `[out:json][timeout:60];way(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lng.toFixed(5)})` +
    `[highway~"^(motorway|trunk)$"][ref~"${ref.osmRefRegex}"]->.rd;` +
    `node(w.rd)[highway=motorway_junction][ref="${exitRef.replace(/"/g, '')}"];out;`
  const key = `exit3:${ref.key}:${exitRef}:${scopeKey({ kind: 'near', center, radiusM })}`
  const json = await overpass(q, key, 45_000)
  return (json.elements ?? []).filter((e: any) => e.type === 'node').map((e: any) => ({ lat: e.lat, lng: e.lon }))
}

/** Named local streets near a point (permit legs that run on city streets). */
export async function fetchStreetWays(nameRegex: string, center: LatLng, radiusM: number): Promise<OverpassWay[]> {
  const q =
    `[out:json][timeout:90];` +
    `way(around:${Math.round(radiusM)},${center.lat.toFixed(5)},${center.lng.toFixed(5)})` +
    `[highway][name~"${nameRegex}",i];out geom;`
  const key = `street3:${nameRegex}:${scopeKey({ kind: 'near', center, radiusM })}`
  const json = await overpass(q, key, 60_000)
  return toWays(json.elements)
}

/** Geocode a city inside a state (fallback for city destinations). */
export async function geocodeCity(name: string, stateCode: string): Promise<LatLng | undefined> {
  const key = `city:${stateCode}:${name.toLowerCase()}`
  const hit = await cache.get(key)
  if (hit) return JSON.parse(hit)
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=' +
    encodeURIComponent(`${name}, ${stateCode}`)
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    const json: any[] = await res.json()
    if (!json.length) return undefined
    const p = { lat: parseFloat(json[0].lat), lng: parseFloat(json[0].lon) }
    await cache.set(key, JSON.stringify(p))
    return p
  } catch {
    return undefined
  }
}
