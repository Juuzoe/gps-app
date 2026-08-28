import type { Cardinal, RoadRef } from './types'
import { stateInfo } from './states'

/**
 * Road-token normalization.
 *
 * Instructions name roads in two dialects:
 *  - route-list style:  I-70, US-50, TX-46, FM-78, Loop 410
 *  - TxDOT permit codes: IH10, IH35W, US77A, SH46, SL463, SS247, FM1216,
 *    BU59T, BI20B, plus frontage forms (IH10NFR, SL463EFR, IH35WWFR)
 *    and zero-padded forms (IH0035W, US0059, SH0176).
 *
 * OSM tags the same roads as (verified against live data for Texas):
 *  - Interstates            ref="I 10", branch letters kept: "I 35E"
 *  - US routes              ref="US 77", alternates "US 77 Alt"/"US 77 Alternate",
 *                           business "US 59 Bus"
 *  - TX state highways      ref="TX 46"  (not "SH 46")
 *  - State loops            ref="Loop 463" or "TX 289 Loop" (both occur)
 *  - State spurs            ref="Spur 247"
 *  - Farm/Ranch-to-market   ref="FM 1216" / "RM 2355" (prefixes swap between
 *                           the permit and OSM, so both are matched)
 *  - Business interstates   ref="I 20 Bus"
 * Concurrencies are `;`-separated in one ref value, so matching is anchored
 * on `^` / `;` boundaries.
 */

export interface ParsedToken {
  ref?: RoadRef
  frontage?: boolean
  dir?: Cardinal
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function makeRef(raw: string, label: string, alternatives: string[]): RoadRef {
  const body = alternatives.map(esc).join('|')
  return { raw, label, osmRefRegex: `(^|;) ?(${body}) ?(;|$)`, key: alternatives.join('|') }
}

const DIR_WORDS: Record<string, Cardinal> = {
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
}

export function parseCardinal(raw: string | undefined): Cardinal | undefined {
  if (!raw) return undefined
  return DIR_WORDS[raw.trim().toLowerCase()]
}

/**
 * Parse one road token ("IH35WWFR", "I-70", "US0059", "Loop 1910"...).
 * Returns undefined when the token is not a coded road (probably a street name).
 */
export function parseRoadToken(rawIn: string, stateCode?: string): ParsedToken | undefined {
  let raw = rawIn.trim().replace(/[.,;:]+$/, '')
  if (!raw) return undefined

  // "LOOP 1910", "SPUR 247", "BUS 59" word forms
  const word = raw.match(/^(LOOP|LP|SPUR|BUS(?:INESS)?)[ -]?0*(\d+)$/i)
  if (word) {
    const n = word[2]
    const kind = word[1].toUpperCase().startsWith('B') ? 'BUS' : word[1].toUpperCase().startsWith('S') ? 'SPUR' : 'LOOP'
    if (kind === 'LOOP') return { ref: makeRef(rawIn, `Loop ${n}`, [`Loop ${n}`, `TX ${n} Loop`, `TX Loop ${n}`, `SL ${n}`]) }
    if (kind === 'SPUR') return { ref: makeRef(rawIn, `Spur ${n}`, [`Spur ${n}`, `TX ${n} Spur`, `TX Spur ${n}`]) }
    return { ref: makeRef(rawIn, `Bus ${n}`, [`US ${n} Bus`, `US ${n} Business`, `BUS ${n}`]) }
  }

  const m = raw.match(/^([A-Z]{1,4})[ -]?0*(\d+)([A-Z]*)$/i)
  if (!m) return undefined
  const prefix = m[1].toUpperCase()
  const num = m[2]
  let suffix = m[3].toUpperCase()

  let frontage = false
  const fr = suffix.match(/^(.*?)([ENSW])FR$/)
  if (fr) {
    frontage = true
    suffix = fr[1]
  }

  const mk = (label: string, alts: string[]): ParsedToken => ({ ref: makeRef(rawIn, label, alts), frontage })

  switch (prefix) {
    case 'I':
    case 'IH': {
      // Branch letters are real designations (I-35E, I-35W, I-69W)
      const branch = /^[EWNS]$/.test(suffix) ? suffix : ''
      const n = `${num}${branch}`
      return mk(`I-${n}`, [`I ${n}`, `IH ${n}`])
    }
    case 'US': {
      if (suffix === 'A') return mk(`US-${num} Alt`, [`US ${num} Alt`, `US ${num} Alternate`, `US ${num}A`])
      if (suffix === 'B') return mk(`US-${num} Bus`, [`US ${num} Bus`, `US ${num} Business`])
      return mk(`US-${num}`, [`US ${num}`])
    }
    case 'SH':
      return mk(`TX-${num}`, [`TX ${num}`, `SH ${num}`])
    case 'TX':
      return mk(`TX-${num}`, [`TX ${num}`, `SH ${num}`])
    case 'SL':
      return mk(`Loop ${num}`, [`Loop ${num}`, `TX ${num} Loop`, `TX Loop ${num}`, `SL ${num}`])
    case 'SS':
    case 'SP':
      return mk(`Spur ${num}`, [`Spur ${num}`, `TX ${num} Spur`, `TX Spur ${num}`])
    case 'FM':
      return mk(`FM-${num}`, [`FM ${num}`, `RM ${num}`])
    case 'RM':
    case 'RR':
      return mk(`RM-${num}`, [`RM ${num}`, `FM ${num}`])
    case 'BU':
      // BU0059T — trailing letter is a TxDOT city code, dropped for matching
      return mk(`US-${num} Bus`, [`US ${num} Bus`, `US ${num} Business`, `BUS ${num}`])
    case 'BI':
      return mk(`I-${num} Bus`, [`I ${num} Bus`, `I ${num} Business`])
    case 'SR':
      return mk(`SR-${num}`, stateCode ? [`SR ${num}`, `${stateCode} ${num}`] : [`SR ${num}`])
    case 'CR':
      return undefined // county roads resolve by name, not ref
    default: {
      // Two-letter state prefixes from route-list style inputs: "IL-15", "NM-128"
      if (/^[A-Z]{2}$/.test(prefix) && stateInfo(prefix)) {
        return mk(`${prefix}-${num}`, [`${prefix} ${num}`, `SR ${num}`, `SH ${num}`])
      }
      return undefined
    }
  }
}

/**
 * Extract road tokens from a free-text fragment, e.g. "I-255 S / US-50 W"
 * or "IH35W" or "SL338". Splits on `/` and `&`. Returns refs plus any
 * trailing cardinal, or undefined if nothing looks like a coded road.
 */
export function parseRoadList(
  fragment: string,
  stateCode?: string,
): { refs: RoadRef[]; dir?: Cardinal; frontage: boolean } | undefined {
  const parts = fragment.split(/[/&]/).map((p) => p.trim()).filter(Boolean)
  const refs: RoadRef[] = []
  let dir: Cardinal | undefined
  let frontage = false
  for (const part of parts) {
    // strip a trailing direction word: "I-255 S", "US-50 W", "IH35 sw"
    const dm = part.match(/^(.*?)[\s]+(N|S|E|W|NE|NW|SE|SW|north|south|east|west)\.?$/i)
    const core = dm ? dm[1] : part
    if (dm) dir = parseCardinal(dm[2]) ?? dir
    const tok = parseRoadToken(core, stateCode)
    if (tok?.ref) {
      refs.push(tok.ref)
      if (tok.frontage) frontage = true
      if (tok.dir) dir = tok.dir
    }
  }
  if (refs.length === 0) return undefined
  return { refs, dir, frontage }
}

/** JS regex for matching a RoadRef against an OSM ref value (client-side checks). */
export function refMatcher(ref: RoadRef): RegExp {
  return new RegExp(ref.osmRefRegex, 'i')
}

/** Build a case-tolerant OSM name regex for a street name from the permit. */
export function streetNameRegex(name: string): string {
  const words = name.trim().split(/\s+/)
  const alt: Record<string, string> = {
    NORTHWEST: '(NW|N\\.? ?W\\.?|Northwest)', NORTHEAST: '(NE|N\\.? ?E\\.?|Northeast)',
    SOUTHWEST: '(SW|S\\.? ?W\\.?|Southwest)', SOUTHEAST: '(SE|S\\.? ?E\\.?|Southeast)',
    NORTH: '(N|North)', SOUTH: '(S|South)', EAST: '(E|East)', WEST: '(W|West)',
    ROAD: '(Rd|Road)', STREET: '(St|Street)', DRIVE: '(Dr|Drive)', AVENUE: '(Ave|Avenue)',
    BOULEVARD: '(Blvd|Boulevard)', HIGHWAY: '(Hwy|Highway)', PARKWAY: '(Pkwy|Parkway)', LANE: '(Ln|Lane)',
  }
  const parts = words.map((w) => {
    const up = w.toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (alt[up]) return alt[up]
    const ord = up.match(/^(\d+)(ST|ND|RD|TH)$/)
    if (ord) return `${ord[1]}(st|nd|rd|th)`
    return esc(w)
  })
  return parts.join('[ .]*')
}
