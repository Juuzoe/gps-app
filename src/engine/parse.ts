import type { Cardinal, EndpointSpec, Instruction, Leg, ParsedRoute, RoadRef } from './types'
import { parseCardinal, parseRoadList, parseRoadToken } from './refs'
import { resolvePlace, statesBetween } from './states'

/**
 * Input parsing. Three accepted shapes, sniffed automatically:
 *  1. turns JSON  — {"turns": ["Border Start: Indiana - I-70", "I-70 (58.3 mi)", ...]}
 *     (bare arrays and loose JSON with comments/trailing commas also accepted)
 *  2. permit text — the route table of a TxDMV oversize permit, pasted as-is,
 *     including PDF-extraction artifacts (wrapped lines, glued columns)
 *  3. plain lines — one instruction per line in the turns style
 */

const cleanJson = (s: string) =>
  s
    .replace(/\/\/[^\n"]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([\]}])/g, '$1')

export function parseInput(text: string): ParsedRoute {
  const trimmed = text.trim()
  // 1) JSON?
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const j = JSON.parse(cleanJson(trimmed))
      const turns: unknown = Array.isArray(j) ? j : j.turns ?? j.route ?? j.instructions
      if (Array.isArray(turns) && turns.every((t) => typeof t === 'string')) {
        return parseTurnLines(turns as string[], 'turns-json')
      }
    } catch {
      /* fall through to text handling */
    }
  }
  // 2) permit table?
  const lines = trimmed.split(/\r?\n/)
  const permitScore = lines.filter((l) =>
    /^\s*(\d+\.\d+|<\s*0\.1)\s+\S/.test(l) || /Loaded Route|Route Description|Origin:|Destination:/i.test(l),
  ).length
  if (permitScore >= 3) return parsePermitText(lines)
  // 3) plain lines
  return parseTurnLines(lines.filter((l) => l.trim().length > 0), 'lines')
}

/* ------------------------------------------------------------------ */
/* turns-style lines                                                   */
/* ------------------------------------------------------------------ */

function parseTurnLines(items: string[], format: 'turns-json' | 'lines'): ParsedRoute {
  const instructions: Instruction[] = []
  let origin: EndpointSpec = { type: 'unknown', raw: '' }
  let destination: EndpointSpec = { type: 'unknown', raw: '' }
  const problems: string[] = []

  items.forEach((rawItem, index) => {
    const raw = rawItem.trim().replace(/^"|"$|,$/g, '').trim()
    if (!raw) return
    const border = raw.match(/^Border\s+(Start|End)\s*:\s*([^-–]+?)\s*[-–]\s*(.+)$/i)
    if (border) {
      const place = border[2].trim()
      const roadList = parseRoadList(border[3])
      const spec: EndpointSpec = { type: 'border', place, road: roadList?.refs[0] }
      if (border[1].toLowerCase() === 'start') origin = spec
      else destination = spec
      instructions.push({
        index, raw, kind: border[1].toLowerCase() === 'start' ? 'origin' : 'destination',
        roads: roadList?.refs ?? [], dir: roadList?.dir, problems: [],
      })
      return
    }
    const inst = parseTurnItem(raw, index)
    instructions.push(inst)
    if (inst.kind === 'turn' && inst.roads.length === 0 && !inst.streetName) {
      inst.problems.push('No road recognized in this line')
    }
  })

  const legs = legsFromTurnInstructions(instructions)
  const stateHint = inferStateFromBorders(origin, destination, legs)
  const claimed = legs.reduce((s, l) => s + (l.claimedMiles || 0), 0)
  return {
    format, instructions, legs, origin, destination, stateHint,
    claimedTotalMiles: claimed > 0 ? claimed : undefined, problems,
  }
}

/** "I-255 Exit 10 toward I-270 (15.2 mi)" → roads/exit/toward/miles. */
function parseTurnItem(raw: string, index: number): Instruction {
  let body = raw
  let miles: number | undefined
  const mi = body.match(/\(([\d.]+)\s*mi(les)?\.?\)/i)
  if (mi) {
    miles = parseFloat(mi[1])
    body = body.replace(mi[0], '').trim()
  }
  let exitRef: string | undefined
  const ex = body.match(/\bExit\s+(\d+[A-Z]?)\b/i)
  if (ex) {
    exitRef = ex[1]
    body = body.replace(ex[0], '').trim()
  }
  let toward: string | undefined
  const tw = body.match(/\btoward\s+(.+)$/i)
  if (tw) {
    toward = tw[1].trim()
    body = body.slice(0, tw.index).trim()
  }
  const roadList = parseRoadList(body)
  const inst: Instruction = {
    index, raw, kind: 'turn',
    roads: roadList?.refs ?? [],
    dir: roadList?.dir,
    isFrontage: roadList?.frontage,
    exitRef, toward, miles, problems: [],
  }
  if (!roadList) {
    const name = body.replace(/\s+[nsew]{1,2}$/i, '').trim()
    if (/^[A-Za-z0-9' .-]{3,}$/.test(name) && /[A-Za-z]{3}/.test(name)) inst.streetName = titleCase(name)
  }
  return inst
}

function legsFromTurnInstructions(instructions: Instruction[]): Leg[] {
  const legs: Leg[] = []
  for (const inst of instructions) {
    if (inst.kind !== 'turn') continue
    if (inst.roads.length === 0 && !inst.streetName) continue
    const prev = legs[legs.length - 1]
    // The exit named on this line is the exit taken FROM the previous road.
    if (inst.exitRef && prev && !prev.exitAtEnd) prev.exitAtEnd = inst.exitRef
    if (inst.toward && prev && !prev.towardAtEnd) prev.towardAtEnd = inst.toward
    if (prev && sameRoadSet(prev, inst)) {
      prev.claimedMiles += inst.miles ?? 0
      prev.sources.push(inst.index)
      if (inst.dir) prev.dir = inst.dir
      continue
    }
    legs.push({
      index: legs.length,
      kind: inst.roads.length ? 'road' : 'street',
      roads: inst.roads,
      streetName: inst.streetName,
      label: inst.roads.length ? inst.roads.map((r) => r.label).join(' / ') : inst.streetName!,
      dir: inst.dir,
      claimedMiles: inst.miles ?? 0,
      sources: [inst.index],
      annotations: [],
    })
  }
  return legs
}

function sameRoadSet(leg: Leg, inst: Instruction): boolean {
  if (leg.kind === 'street' || inst.roads.length === 0) return false
  const a = new Set(leg.roads.map((r) => r.key))
  return inst.roads.length === leg.roads.length && inst.roads.every((r) => a.has(r.key))
}

/* ------------------------------------------------------------------ */
/* permit route tables                                                 */
/* ------------------------------------------------------------------ */

const VERB_RE = /(DETOUR:|Arrive at destination|Take exit\b|Take Exit\b|Take ramp\b|Take\b|Continue straight on\b|Continue on\b|Merge onto\b|Turn left onto\b|Turn right onto\b|Bear left onto\b|Bear right onto\b|Hard left onto\b|Hard right onto\b|Keep [Ll]eft\b|Keep [Rr]ight\b)/

/** Fix TxDOT long-form names into parseable codes before tokenizing. */
function normalizeRoadText(s: string): string {
  return s
    .replace(/IH\s*HIGHWAY-?\s*(\d+)/gi, 'IH$1')
    .replace(/-?FRONTAGE-?\s*ROAD/gi, '')
    .replace(/FARM[- ]TO[- ]MARKET(?:[- ]ROAD)?[- ](\d+)/gi, 'FM$1')
    .replace(/RANCH[- ]TO[- ]MARKET(?:[- ]ROAD)?[- ](\d+)/gi, 'RM$1')
    .replace(/STATE\s+LOOP\s+(\d+)/gi, 'SL$1')
    .replace(/STATE\s+SPUR\s+(\d+)/gi, 'SS$1')
}

export function parsePermitText(lines: string[]): ParsedRoute {
  const problems: string[] = []
  let origin: EndpointSpec = { type: 'unknown', raw: '' }
  let destination: EndpointSpec = { type: 'unknown', raw: '' }

  // Collect origin/destination specs anywhere in the document.
  for (const line of lines) {
    const o = line.match(/Origin:\s*(.+?)(?:\s*\]|$)/i)
    if (o && origin.type === 'unknown') origin = parseEndpointSpec(o[1])
    const d = line.match(/Destination:\s*(.+?)(?:\s*\]|$)/i)
    if (d && destination.type === 'unknown' && !/Permit Destination/i.test(line)) {
      destination = parseEndpointSpec(d[1])
    }
  }

  // Stitch instruction rows back together (PDF text wraps continuation lines).
  const rows: { miles: number; text: string }[] = []
  let inTable = false
  for (const raw of lines) {
    const line = raw.trim()
    if (/^Miles\s+Route/i.test(line)) { inTable = true; continue }
    if (/^\[Loaded Route/i.test(line)) { inTable = true; continue }
    if (/^Final Destination/i.test(line)) { inTable = false; continue }
    if (/^(PAGE \d|--- page|Texas Oversize|General Conditions)/i.test(line)) continue
    const m = line.match(/^(\d+\.\d+|<\s*0\.1)\s+(.+)$/)
    if (m) {
      inTable = true
      const miles = m[1].startsWith('<') ? 0.05 : parseFloat(m[1])
      rows.push({ miles, text: m[2] })
    } else if (inTable && rows.length && line && !/^(Origin:|Destination:)/i.test(line)) {
      rows[rows.length - 1].text += ' ' + line
    }
  }

  const instructions: Instruction[] = rows.map((row, index) => {
    // Strip the trailing cumulative-miles + time columns ("112.60 00:00"),
    // which the PDF sometimes glues straight onto the text.
    let text = row.text.replace(/\s*\d+\.\d{2}\s+\d{1,2}:\d{2}\s*$/g, '').trim()
    // Repeated column pairs can survive mid-text after line stitching.
    text = text.replace(/\s\d+\.\d{2}\s+\d{1,2}:\d{2}(?=\s)/g, ' ')
    const vm = text.match(VERB_RE)
    const inst: Instruction = { index, raw: row.text, kind: 'turn', roads: [], miles: row.miles, problems: [] }
    if (!vm || vm.index === undefined) {
      inst.problems.push('No maneuver recognized')
      return inst
    }
    const maneuver = text.slice(vm.index).trim()
    // FROM column: the road being travelled when this row begins. Permits can
    // switch roads with no "onto" line at all — the next row's FROM column is
    // then the only evidence (e.g. "22.70 IH410 sw Take Exit 53 …").
    const fromText = text.slice(0, vm.index).trim()
    if (fromText) {
      inst.fromIsConnector = /\b(Ramp|Connector)\b/i.test(fromText)
      const fromList = parseRoadList(normalizeRoadText(fromText.replace(/\b(Ramp|Connector)\b/gi, '')))
      if (fromList) inst.fromRoads = fromList.refs
    }
    if (/^DETOUR:/i.test(maneuver)) {
      inst.kind = 'note'
      inst.detour = maneuver.replace(/^DETOUR:\s*/i, '')
      return inst
    }
    if (/^Arrive at destination/i.test(maneuver)) {
      inst.kind = 'note'
      return inst
    }
    const ex = maneuver.match(/\bExit\s+(\d+[A-Z]?)\b/i)
    if (ex) inst.exitRef = ex[1]
    const tw = maneuver.match(/\btoward\s+([^[\]]+?)(?:\s*\[|$)/i)
    if (tw) inst.toward = tw[1].trim()

    const brackets = [...maneuver.matchAll(/\[([^\]]+)\]/g)].map((b) => b[1])
    let target: string | undefined
    const onto = maneuver.match(/(?:onto|straight on|Merge onto|Continue on)\s+(.+?)(?:\s*\[|\s*;|$)/i)
    if (onto) target = onto[1].trim()
    else {
      const ramp = maneuver.match(/^Take\s+(\S+)\s+Ramp/i)
      if (ramp) { target = ramp[1]; inst.isRamp = true }
    }
    if (!target) return inst // pure exit/keep line: hints only

    // Permit text is uppercase; the lowercase compass token ends the target.
    // Cutting at the FIRST one also drops junk glued on by PDF line wraps.
    const dm = target.match(/\s+([nsew]{1,2})(?:[\s.,;]|$)/)
    if (dm && dm.index !== undefined) {
      inst.dir = parseCardinal(dm[1])
      target = target.slice(0, dm.index).trim()
    }
    target = normalizeRoadText(target).replace(/\s+(?:ramp)$/i, '').trim()
    const list = parseRoadList(target)
    if (list) {
      inst.roads = list.refs
      inst.isFrontage = list.frontage
      if (!inst.dir) inst.dir = list.dir
    } else if (/[A-Za-z]{3}/.test(target)) {
      inst.streetName = titleCase(target)
    }
    // Bracketed co-signed routes ("[US82]", "[SL338]") extend the road set.
    for (const b of brackets) {
      const extra = parseRoadList(normalizeRoadText(b))
      if (extra) {
        for (const r of extra.refs) {
          if (!inst.roads.some((x) => x.key === r.key)) inst.roads.push(r)
        }
      }
    }
    return inst
  })

  const legs = legsFromPermitInstructions(instructions, origin)
  const claimedTotal = rows.reduce((s, r) => s + r.miles, 0)
  const stateHint = inferStateFromBorders(origin, destination, legs) ?? 'TX'
  return {
    format: 'permit-text', instructions, legs, origin, destination,
    stateHint, claimedTotalMiles: claimedTotal, problems,
  }
}

/**
 * Permit rows fold into legs by target road: the row's miles are travel on
 * the CURRENT road up to the maneuver; the target then opens the next leg
 * unless it is a ramp/frontage/connector of the same parent road.
 */
function legsFromPermitInstructions(instructions: Instruction[], origin: EndpointSpec): Leg[] {
  const legs: Leg[] = []
  const originRoad = origin.type === 'offset' ? origin.road : origin.type === 'border' ? origin.road : undefined
  const open = (roads: RoadRef[], streetName: string | undefined, dir: Cardinal | undefined): Leg => {
    const leg: Leg = {
      index: legs.length,
      kind: roads.length ? 'road' : 'street',
      roads, streetName,
      label: roads.length ? roads.map((r) => r.label).join(' / ') : streetName ?? '?',
      dir, claimedMiles: 0, sources: [], annotations: [],
    }
    legs.push(leg)
    return leg
  }
  let current: Leg | undefined = originRoad ? open([originRoad], undefined, undefined) : undefined

  for (const inst of instructions) {
    if (inst.kind === 'note') {
      if (inst.detour && current) current.annotations.push(`Detour: ${inst.detour}`)
      if (current && inst.miles) {
        current.claimedMiles += inst.miles
        current.sources.push(inst.index)
      }
      continue
    }
    // Implicit road switch: this row starts on a mainline road that is not
    // part of the current leg — the transition happened without an "onto".
    if (
      current &&
      current.kind === 'road' &&
      current.roads.length > 0 &&
      inst.fromRoads?.length &&
      !inst.fromIsConnector &&
      !inst.fromRoads.some((r) => current!.roads.some((x) => x.key === r.key))
    ) {
      current = open(inst.fromRoads, undefined, undefined)
    }
    if (current && inst.miles) {
      current.claimedMiles += inst.miles
      current.sources.push(inst.index)
    }
    if (inst.exitRef && current && !current.exitAtEnd) current.exitAtEnd = inst.exitRef
    if (inst.toward && current) current.towardAtEnd = inst.toward

    const hasTarget = inst.roads.length > 0 || !!inst.streetName
    if (!hasTarget) continue

    if (current && !current.roads.length && !inst.streetName) {
      // current leg was opened without a road (rare) — adopt this road
      current.roads = inst.roads
      current.kind = 'road'
      current.label = inst.roads.map((r) => r.label).join(' / ')
      continue
    }

    // Leg identity follows the PRIMARY target (the "onto X" road). Bracketed
    // co-signs are secondary: "US82 [US380]" after "US62 [US82]" is a new leg
    // (leaving the 62/82 concurrency), not a continuation of it.
    const samePrimary =
      current &&
      current.kind === 'road' &&
      inst.roads.length > 0 &&
      current.roads.length > 0 &&
      inst.roads[0].key === current.roads[0].key

    if (samePrimary) {
      // ramp / frontage / repeated mainline mention of the same road
      if (inst.isFrontage) current!.annotations.push('runs on frontage road here')
      for (const r of inst.roads) {
        if (!current!.roads.some((x) => x.key === r.key)) {
          current!.roads.push(r)
          current!.label = current!.roads.map((x) => x.label).join(' / ')
        }
      }
      if (inst.dir) current!.dir = inst.dir
      continue
    }
    current = open(inst.roads, inst.streetName, inst.dir)
  }
  return legs.filter((l) => l.claimedMiles > 0 || l.kind === 'street' || legs.length <= 2)
}

/* ------------------------------------------------------------------ */
/* endpoint specs                                                      */
/* ------------------------------------------------------------------ */

/**
 * "IH0030 AR Line"                          → border with Arkansas on I-30
 * "SH0176 NM Line"                          → border with New Mexico on TX-176
 * "BU0059T, 2.3mi SW of BU0059T & US0059"   → offset from an intersection
 * "Laredo"                                  → city
 */
export function parseEndpointSpec(rawIn: string): EndpointSpec {
  const raw = rawIn.trim().replace(/\s*\]\s*$/, '')
  const offset = raw.match(/^(.+?),\s*([\d.]+)\s*mi\s*([NSEW]{1,2})?\s*of\s+(.+?)\s*[&+]\s*(.+)$/i)
  if (offset) {
    const road = parseRoadToken(normalizeRoadText(offset[1]))?.ref
    const a = parseRoadToken(normalizeRoadText(offset[4]))?.ref
    const b = parseRoadToken(normalizeRoadText(offset[5]))?.ref
    if (road && a && b) {
      return { type: 'offset', road, miles: parseFloat(offset[2]), dir: parseCardinal(offset[3]), ofA: a, ofB: b }
    }
  }
  const border = raw.match(/^(.+?)\s+([A-Z]{2})\s+Line$/i)
  if (border) {
    const road = parseRoadToken(normalizeRoadText(border[1]))?.ref
    const place = resolvePlace(border[2])
    if (place) return { type: 'border', place, road }
  }
  const justBorder = raw.match(/^([A-Z]{2})\s+Line$/i)
  if (justBorder) {
    const place = resolvePlace(justBorder[1])
    if (place) return { type: 'border', place }
  }
  if (/^[A-Za-z .'-]+$/.test(raw)) return { type: 'city', name: raw }
  return { type: 'unknown', raw }
}

function inferStateFromBorders(origin: EndpointSpec, destination: EndpointSpec, _legs: Leg[]): string | undefined {
  const a = origin.type === 'border' ? resolvePlace(origin.place) : undefined
  const b = destination.type === 'border' ? resolvePlace(destination.place) : undefined
  if (a && b) {
    const candidates = statesBetween(a, b)
    // With two or more candidates the caller disambiguates against live data.
    if (candidates.length === 1) return candidates[0]
  }
  return undefined
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\s+/g, ' ').trim()
}
