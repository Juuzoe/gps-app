export type LatLng = { lat: number; lng: number };

/** A single road reference parsed from an instruction, e.g. "I-70 W". */
export type RoadRef = {
  /** Normalized match key: "I70", "US50", "IL15"... */
  key: string;
  system: string;
  num: string;
  dir?: string;
  raw: string;
};

export type BorderStep = {
  kind: "border-start" | "border-end";
  /** State on the far side of the border (the neighbor), as written. */
  state: string;
  stateAbbrev: string | null;
  roads: RoadRef[];
  /** Optional inline coordinate escape hatch: "Border Start: Indiana - I-70 @39.44,-87.53" */
  coord?: LatLng;
  raw: string;
  index: number;
};

export type DriveStep = {
  kind: "step";
  roads: RoadRef[];
  claimedMeters?: number;
  toward?: string;
  exit?: string;
  raw: string;
  index: number;
};

export type ParsedStep = BorderStep | DriveStep;

export type ParseResult = {
  steps: ParsedStep[];
  errors: string[];
};

/** One OSRM step flattened onto the master polyline. */
export type FlatStep = {
  refs: string[];
  name: string;
  distance: number;
  isRamp: boolean;
  startIdx: number;
  endIdx: number;
  startM: number;
  endM: number;
};

export type RouteData = {
  latlngs: LatLng[];
  /** Cumulative meters at each vertex of latlngs. */
  cum: number[];
  totalMeters: number;
  flatSteps: FlatStep[];
  source: "live" | "fallback";
  serverLabel: string;
};

/** Slice of the route assigned to one instruction step. */
export type Segment = {
  stepIndex: number;
  startM: number;
  endM: number;
  startIdx: number;
  endIdx: number;
  measuredMeters: number;
  /** True when the boundary was placed by claimed distance, not a road change. */
  approxBoundary: boolean;
  notes: string[];
  level: "ok" | "warn" | "error";
};

export type Alignment = {
  segments: Segment[];
  warnings: string[];
};

export type ResolvedAnchor = {
  point: LatLng;
  marker: LatLng;
  bearing?: number;
  label: string;
};

export type NavRoute = {
  parsed: ParsedStep[];
  route: RouteData;
  alignment: Alignment;
  start: ResolvedAnchor;
  end: ResolvedAnchor;
  claimedTotalMeters: number;
};

export type GpsFix = {
  lat: number;
  lng: number;
  headingDeg: number;
  speedMph: number;
  odometerM: number;
  simTimeS: number;
  /** Index into parsed steps (instruction currently being driven). */
  stepIndex: number;
  done: boolean;
};

export const MI = 1609.344;
export const mi = (meters: number): number => meters / MI;
export const fmtMi = (meters: number, digits = 1): string => mi(meters).toFixed(digits);
