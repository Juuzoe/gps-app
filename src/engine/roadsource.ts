import type { LatLng, ProgressFn, RoadRef } from './types'
import { fastDist } from './geo'
import { fetchRoads, normalizeScope, type OverpassWay, type RoadRequest, type Scope } from './overpass'
import { RoadNet } from './roadnet'
import { hasStatePolygon, isInState } from './statepoly'

/**
 * Lazily accumulates road geometry as the route is walked.
 *
 * A leg needs its road only where it travels, so geometry is requested as a
 * disc around the last known position. Discs already covered are skipped, and
 * everything still missing for one step is fetched in a single batched query.
 * Statewide fetches remain available as a fallback for roads a disc missed.
 */

interface Entry {
  ways: OverpassWay[]
  net?: RoadNet
  discs: { center: LatLng; radiusM: number }[]
  statewide: boolean
}

/** How far a scope reaches, for picking the more generous of two. */
function scopeReach(s: Scope): number {
  return s.kind === 'state' ? Infinity : s.radiusM
}

export class RoadSource {
  readonly state: string
  private entries = new Map<string, Entry>()
  private merged = new Map<string, { net: RoadNet; stamp: number }>()
  private stamp = 0
  readonly errors: string[] = []

  constructor(state: string) {
    this.state = state
  }

  private entry(key: string): Entry {
    let e = this.entries.get(key)
    if (!e) this.entries.set(key, (e = { ways: [], discs: [], statewide: false }))
    return e
  }

  private covered(key: string, scope: Scope): boolean {
    const e = this.entries.get(key)
    if (!e) return false
    if (e.statewide) return true
    if (scope.kind === 'state') return false
    return e.discs.some(
      (d) => fastDist(d.center, scope.center) + scope.radiusM <= d.radiusM * 1.02,
    )
  }

  /** Ensure geometry for these roads within `scope`, in one batched request. */
  async ensure(refs: RoadRef[], scope: Scope, progress?: ProgressFn): Promise<void> {
    await this.ensureMany(refs.map((ref) => ({ ref, scope })), progress)
  }

  /**
   * Ensure geometry for roads that each need a different scope, in ONE request.
   * This is the main entry point: a whole route's roads are planned up front
   * and fetched together, because a round trip against a public Overpass
   * mirror costs 15-25s whatever it asks for.
   */
  async ensureMany(entries: RoadRequest[], progress?: ProgressFn): Promise<void> {
    const wanted = new Map<string, RoadRequest>()
    for (const { ref, scope } of entries) {
      const norm = normalizeScope(scope)
      if (this.covered(ref.key, norm)) continue
      const prior = wanted.get(ref.key)
      // One request per road: keep whichever scope reaches furthest.
      if (!prior || scopeReach(norm) > scopeReach(prior.scope)) wanted.set(ref.key, { ref, scope: norm })
    }
    if (wanted.size === 0) return

    const requests = [...wanted.values()]
    const labels = requests.map((r) => r.ref.label).join(', ')
    let result: Map<string, OverpassWay[]>
    try {
      // Chunks land in parallel across mirrors; report the running total so
      // the line visibly moves instead of sitting there like a hang.
      result = await fetchRoads(requests, (doneRoads, totalRoads) =>
        progress?.({
          phase: 'fetch',
          message:
            totalRoads > 5
              ? `Fetched ${doneRoads} of ${totalRoads} roads…`
              : `Fetching ${labels}…`,
        }),
      )
    } catch (e) {
      if (e instanceof Error && e.name === 'CancelledError') throw e
      const msg = `Could not fetch ${labels} from OSM (${e instanceof Error ? e.message : e})`
      if (!this.errors.includes(msg)) this.errors.push(msg)
      throw e
    }
    for (const { ref, scope } of requests) {
      const e = this.entry(ref.key)
      const got = this.clip(result.get(ref.key) ?? [])
      const seen = new Set(e.ways.map((w) => w.id))
      for (const w of got) if (!seen.has(w.id)) e.ways.push(w)
      e.net = undefined // rebuilt on next access
      if (scope.kind === 'state') e.statewide = true
      else e.discs.push({ center: scope.center, radiusM: scope.radiusM })
    }
    this.stamp++

    // A disc that came back empty usually means the claimed mileage put it in
    // the wrong place, not that the road is missing. Widen and ask again.
    //
    // Widening the disc rather than falling back to a statewide bbox is
    // deliberate: measured against a public mirror, discs scale gracefully
    // (200km 15s, 400km 27s) while the equivalent bbox returned a 504 after
    // 51s. An earlier version used the bbox here and spent ten minutes
    // retrying it. Only a disc already at full reach falls back to the bbox.
    const emptied = requests.filter(({ ref, scope }) => scope.kind === 'near' && this.isEmpty(ref))
    if (emptied.length) {
      await this.ensureMany(
        emptied.map(({ ref, scope }) => {
          const radiusM = scope.kind === 'near' ? Math.min(700_000, scope.radiusM * 2.5) : 0
          return scope.kind === 'near' && scope.radiusM < 700_000
            ? { ref, scope: { kind: 'near' as const, center: scope.center, radiusM } }
            : { ref, scope: { kind: 'state' as const, code: this.state } }
        }),
        progress,
      )
    }
  }

  /** Same as ensure(), but a failed fetch degrades instead of throwing. */
  async ensureSoft(refs: RoadRef[], scope: Scope, progress?: ProgressFn): Promise<void> {
    try {
      await this.ensure(refs, scope, progress)
    } catch (e) {
      if (e instanceof Error && e.name === 'CancelledError') throw e
    }
  }

  async ensureManySoft(entries: RoadRequest[], progress?: ProgressFn): Promise<void> {
    try {
      await this.ensureMany(entries, progress)
    } catch (e) {
      if (e instanceof Error && e.name === 'CancelledError') throw e
    }
  }

  /**
   * Drop ways outside the state. Bounding boxes overlap neighbours heavily —
   * the Texas box contains most of eastern New Mexico — and a road carrying the
   * same number on both sides of the line otherwise produces junctions hundreds
   * of miles off route.
   */
  private clip(ways: OverpassWay[]): OverpassWay[] {
    if (!hasStatePolygon(this.state)) return ways
    return ways.filter((w) => {
      const g = w.geometry
      return isInState(this.state, g[g.length >> 1]) || isInState(this.state, g[0])
    })
  }

  /** True when nothing has been loaded for this road yet. */
  isEmpty(ref: RoadRef): boolean {
    return (this.entries.get(ref.key)?.ways.length ?? 0) === 0
  }

  hasStatewide(ref: RoadRef): boolean {
    return this.entries.get(ref.key)?.statewide ?? false
  }

  net(ref: RoadRef): RoadNet {
    const e = this.entry(ref.key)
    if (!e.net) e.net = new RoadNet(ref.label, e.ways)
    return e.net
  }

  /** Combined network for a concurrency (roads signed together). */
  netFor(refs: RoadRef[]): RoadNet {
    if (refs.length === 0) return new RoadNet('?', [])
    if (refs.length === 1) return this.net(refs[0])
    const key = refs.map((r) => r.key).sort().join('+')
    const hit = this.merged.get(key)
    if (hit && hit.stamp === this.stamp) return hit.net
    const ways: OverpassWay[] = []
    const seen = new Set<number>()
    for (const r of refs) {
      for (const w of this.entries.get(r.key)?.ways ?? []) {
        if (!seen.has(w.id)) { seen.add(w.id); ways.push(w) }
      }
    }
    const net = new RoadNet(refs.map((r) => r.label).join('/'), ways)
    this.merged.set(key, { net, stamp: this.stamp })
    return net
  }

  /** Register externally fetched ways (street legs). */
  adopt(key: string, label: string, ways: OverpassWay[]) {
    const e = this.entry(key)
    e.ways = ways
    e.net = new RoadNet(label, ways)
    e.statewide = true
    this.stamp++
  }

  netByKey(key: string): RoadNet | undefined {
    return this.entries.get(key)?.net
  }
}

/**
 * Radius that must contain the junction ending this leg: the claimed distance
 * plus slack for a wrong figure, floored so short legs still pull in their
 * surroundings. Deliberately uncapped below state size — a 233-mile leg needs
 * a 375km reach, and a disc too small to hold its own junction is worse than a
 * large one. Long legs therefore cost about what a statewide fetch used to,
 * while the many short legs cost a fraction of it.
 */
export function legRadius(claimedMiles: number): number {
  const MI = 1609.344
  return Math.min(700_000, Math.max(25_000, claimedMiles * MI * 1.45 + 12_000))
}
