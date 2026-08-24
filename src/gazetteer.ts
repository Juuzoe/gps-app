import crossingsData from "./data/border-crossings.json";
import type { BorderStep, ResolvedAnchor } from "./types";
import { destination } from "./geo";
import { stateName } from "./states";

export type Crossing = {
  states: string[];
  road: string;
  label: string;
  crossing: { lat: number; lng: number };
  bearingAtoB: number;
};

const CROSSINGS = crossingsData as Crossing[];

/** How far past the border line the route endpoint is pushed, so the crossing is fully driven. */
const END_OVERSHOOT_M = 450;

export class GazetteerError extends Error {}

function otherState(c: Crossing, neighbor: string): string | null {
  if (c.states[0] === neighbor) return c.states[1] ?? null;
  if (c.states[1] === neighbor) return c.states[0] ?? null;
  return null;
}

function candidatesFor(step: BorderStep): Crossing[] {
  if (!step.stateAbbrev) return [];
  const roadKeys = new Set(step.roads.map((r) => r.key));
  return CROSSINGS.filter(
    (c) => c.states.includes(step.stateAbbrev!) && roadKeys.has(c.road),
  );
}

function describe(step: BorderStep): string {
  return `${step.state} + ${step.roads.map((r) => r.raw).join("/") || "?"}`;
}

function noEntryError(step: BorderStep): GazetteerError {
  return new GazetteerError(
    `No border crossing known for ${describe(step)}. ` +
      `Add an entry to src/data/border-crossings.json (see npm run anchors), ` +
      `or append coordinates to the instruction: "... - ${step.roads[0]?.raw ?? "I-00"} @39.4367,-87.5312"`,
  );
}

/** Travel bearing through a crossing, moving from `from` state into the other one. */
function travelBearing(c: Crossing, from: string): number {
  return c.states[0] === from ? c.bearingAtoB : (c.bearingAtoB + 180) % 360;
}

export function resolveAnchors(
  start: BorderStep,
  end: BorderStep,
): { start: ResolvedAnchor; end: ResolvedAnchor; traversedState: string | null } {
  const roadLabel = (s: BorderStep) => s.roads[0]?.raw ?? "route";

  // Inline coordinates short-circuit gazetteer lookup entirely.
  const startCands = start.coord ? [] : candidatesFor(start);
  const endCands = end.coord ? [] : candidatesFor(end);

  if (!start.coord && startCands.length === 0) throw noEntryError(start);
  if (!end.coord && endCands.length === 0) throw noEntryError(end);

  let startCross: Crossing | null = null;
  let endCross: Crossing | null = null;
  let traversedState: string | null = null;

  if (startCands.length > 0 && endCands.length > 0) {
    // Pick the pair of crossings that agree on which state is being traversed.
    outer: for (const cs of startCands) {
      for (const ce of endCands) {
        const ts = otherState(cs, start.stateAbbrev!);
        const te = otherState(ce, end.stateAbbrev!);
        if (ts && ts === te) {
          startCross = cs;
          endCross = ce;
          traversedState = ts;
          break outer;
        }
      }
    }
    if (!startCross || !endCross) {
      throw new GazetteerError(
        `Could not find a pair of border crossings sharing one traversed state for ` +
          `${describe(start)} and ${describe(end)}.`,
      );
    }
  } else {
    if (startCands.length > 1 || endCands.length > 1) {
      const amb = startCands.length > 1 ? start : end;
      const cands = startCands.length > 1 ? startCands : endCands;
      throw new GazetteerError(
        `Ambiguous border for ${describe(amb)}: ${cands.map((c) => c.label).join(" | ")}. ` +
          `Append @lat,lng to pick one.`,
      );
    }
    startCross = startCands[0] ?? null;
    endCross = endCands[0] ?? null;
    traversedState =
      (startCross && otherState(startCross, start.stateAbbrev!)) ??
      (endCross && endCross.states.find((s) => s !== end.stateAbbrev) ) ??
      null;
  }

  const startAnchor: ResolvedAnchor = start.coord
    ? { point: start.coord, marker: start.coord, label: `${start.state} line · ${roadLabel(start)}` }
    : {
        point: startCross!.crossing,
        marker: startCross!.crossing,
        bearing: travelBearing(startCross!, start.stateAbbrev!),
        label: `${stateName(start.stateAbbrev!)} line · ${roadLabel(start)}`,
      };

  let endAnchor: ResolvedAnchor;
  if (end.coord) {
    endAnchor = { point: end.coord, marker: end.coord, label: `${end.state} line · ${roadLabel(end)}` };
  } else {
    // End border: traversed -> neighbor. Push the routing point past the line so
    // the crossing (e.g. the river bridge) is fully driven.
    const brg = travelBearing(endCross!, traversedState ?? endCross!.states[0]!);
    endAnchor = {
      point: destination(endCross!.crossing, brg, END_OVERSHOOT_M),
      marker: endCross!.crossing,
      bearing: brg,
      label: `${stateName(end.stateAbbrev!)} line · ${roadLabel(end)}`,
    };
  }

  return { start: startAnchor, end: endAnchor, traversedState };
}
