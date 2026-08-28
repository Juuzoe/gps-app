/** Core types shared by the parsing, resolution and routing layers. */

export type LatLng = { lat: number; lng: number }

/** A road as named in the instructions, normalized for OSM matching. */
export interface RoadRef {
  /** Token as it appeared in the input, e.g. "IH10", "I-70", "SL463". */
  raw: string
  /** Human label, e.g. "I-10", "US-77 Alt", "Loop 463". */
  label: string
  /** POSIX regex matching the OSM `ref` value (one alternative among `;`-separated refs). */
  osmRefRegex: string
  /** Cache key — identical roads across instructions share a network fetch. */
  key: string
}

export type Cardinal = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

/** One parsed input line (before simplification into legs). */
export interface Instruction {
  index: number
  raw: string
  kind: 'origin' | 'destination' | 'turn' | 'note'
  roads: RoadRef[]
  /** Street-name target when the line names a local street instead of a coded road. */
  streetName?: string
  dir?: Cardinal
  exitRef?: string
  toward?: string
  miles?: number
  isRamp?: boolean
  isFrontage?: boolean
  isConnector?: boolean
  detour?: string
  /** Roads in the permit row's FROM column (current road when the row starts). */
  fromRoads?: RoadRef[]
  /** FROM column names a ramp/connector rather than a mainline. */
  fromIsConnector?: boolean
  problems: string[]
}

/** Endpoint spec (route origin or destination). */
export type EndpointSpec =
  | { type: 'border'; place: string; road?: RoadRef }
  | { type: 'city'; name: string }
  | { type: 'offset'; road: RoadRef; miles: number; dir?: Cardinal; ofA: RoadRef; ofB: RoadRef }
  | { type: 'unknown'; raw: string }

/** A major leg: a stretch of travel along one road (or one named street). */
export interface Leg {
  index: number
  kind: 'road' | 'street'
  roads: RoadRef[]
  streetName?: string
  label: string
  dir?: Cardinal
  /** Exit used to LEAVE this leg (from the boundary instruction), e.g. "607". */
  exitAtEnd?: string
  towardAtEnd?: string
  claimedMiles: number
  /** Indexes of source instructions folded into this leg. */
  sources: number[]
  annotations: string[]
}

export interface ParsedRoute {
  format: 'turns-json' | 'permit-text' | 'lines'
  instructions: Instruction[]
  legs: Leg[]
  origin: EndpointSpec
  destination: EndpointSpec
  /** State being traversed, if declared or inferable from the input alone. */
  stateHint?: string
  claimedTotalMiles?: number
  problems: string[]
}

export type WaypointStatus = 'ok' | 'approx' | 'skipped' | 'failed'

export interface Waypoint {
  pos: LatLng
  /** Bearing of travel at this waypoint, degrees, if known. */
  bearing?: number
  /** Leg transition this waypoint represents: end of legs[legBefore], start of legs[legAfter]. */
  legBefore: number
  legAfter: number
  label: string
  status: WaypointStatus
  note?: string
  kind: 'origin' | 'junction' | 'destination' | 'via'
}

export interface LegReport {
  leg: Leg
  claimedMiles: number
  routedMiles?: number
  /** Fraction of routed distance whose OSM ref/name matched the leg's road. */
  refMatch?: number
  status: 'ok' | 'warn' | 'skipped' | 'failed'
  note?: string
}

export interface RouteResult {
  parsed: ParsedRoute
  state: string
  waypoints: Waypoint[]
  /** Full route geometry (lng,lat pairs — GeoJSON order). */
  geometry: [number, number][]
  /** Cumulative meters at each geometry vertex. */
  cumulative: number[]
  totalMeters: number
  durationSec: number
  legReports: LegReport[]
  /** Geometry index ranges per routed leg (aligned with waypoint pairs). */
  legGeometry: { legIndex: number; from: number; to: number }[]
  warnings: string[]
  errors: string[]
}

export interface ProgressEvent {
  phase: 'parse' | 'state' | 'fetch' | 'resolve' | 'route' | 'validate' | 'done' | 'error'
  message: string
  /** 0..1 overall estimate. */
  ratio?: number
}

export type ProgressFn = (e: ProgressEvent) => void
