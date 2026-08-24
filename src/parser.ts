import type { LatLng, ParseResult, ParsedStep, RoadRef } from "./types";
import { MI } from "./types";
import { toStateAbbrev } from "./states";

/** "I-70" / "US 50" / "IL-15" / "I70 W" -> normalized RoadRef, or null if not road-shaped. */
export function parseRoadToken(tokenIn: string): RoadRef | null {
  const token = tokenIn.trim();
  const m = token.match(/^([A-Za-z]{1,4})[\s-]*(\d{1,4}[A-Za-z]?)\s*([NSEW])?\.?$/i);
  if (!m) return null;
  const system = m[1]!.toUpperCase();
  const num = m[2]!.toUpperCase();
  const dir = m[3]?.toUpperCase();
  return { key: `${system}${num}`, system, num, dir, raw: token };
}

/** OSRM refs come as "I 70; US 40" etc. Normalize each to a match key. */
export function normalizeRefKey(ref: string): string {
  return ref.replace(/[\s.-]/g, "").toUpperCase();
}

function parseDistance(body: string): { rest: string; meters?: number } {
  const m = body.match(/\(([\d.]+)\s*(mi|miles?|km)?\.?\)\s*$/i);
  if (!m) return { rest: body.trim() };
  const value = parseFloat(m[1]!);
  const unit = (m[2] ?? "mi").toLowerCase();
  const meters = unit.startsWith("k") ? value * 1000 : value * MI;
  return { rest: body.slice(0, m.index).trim(), meters };
}

function parseRoadList(text: string): { roads: RoadRef[]; leftover: string[] } {
  const roads: RoadRef[] = [];
  const leftover: string[] = [];
  for (const part of text.split("/")) {
    const road = parseRoadToken(part);
    if (road) roads.push(road);
    else if (part.trim()) leftover.push(part.trim());
  }
  return { roads, leftover };
}

function parseCoord(text: string): { rest: string; coord?: LatLng } {
  const m = text.match(/@\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/);
  if (!m) return { rest: text };
  return {
    rest: (text.slice(0, m.index) + text.slice(m.index! + m[0].length)).trim(),
    coord: { lat: parseFloat(m[1]!), lng: parseFloat(m[2]!) },
  };
}

function parseLine(raw: string, index: number, errors: string[]): ParsedStep | null {
  const border = raw.match(/^Border\s*(Start|End)\s*:\s*(.+?)\s*[-–]\s*(.+)$/i);
  if (border) {
    const kind = border[1]!.toLowerCase() === "start" ? "border-start" : "border-end";
    const state = border[2]!.trim();
    const { rest, coord } = parseCoord(border[3]!.trim());
    const { roads } = parseRoadList(rest);
    const stateAbbrev = toStateAbbrev(state);
    if (!stateAbbrev && !coord) {
      errors.push(`Line ${index + 1}: unknown state "${state}"`);
    }
    if (roads.length === 0 && !coord) {
      errors.push(`Line ${index + 1}: no road recognized in border "${raw}"`);
    }
    return { kind, state, stateAbbrev, roads, coord, raw, index };
  }

  const { rest: afterDist, meters } = parseDistance(raw);
  let body = afterDist;

  let toward: string | undefined;
  const towardM = body.match(/\btowards?\s+(.+)$/i);
  if (towardM) {
    toward = towardM[1]!.trim();
    body = body.slice(0, towardM.index).trim();
  }

  let exit: string | undefined;
  const exitM = body.match(/\bExit\s+([0-9]+[A-Za-z]?)\b/i);
  if (exitM) {
    exit = exitM[1]!;
    body = (body.slice(0, exitM.index) + body.slice(exitM.index! + exitM[0].length)).trim();
  }

  const { roads, leftover } = parseRoadList(body);
  if (roads.length === 0) {
    errors.push(`Line ${index + 1}: no road recognized in "${raw}"${leftover.length ? ` (unparsed: ${leftover.join(", ")})` : ""}`);
    return null;
  }
  return { kind: "step", roads, claimedMeters: meters, toward, exit, raw, index };
}

/**
 * Accepts flexible input:
 *  - JSON object {"turns": [...]} or bare JSON array (tolerates // comments and trailing commas)
 *  - plain text, one instruction per line
 */
export function extractLines(input: string): string[] {
  const stripped = input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n"]*$/gm, "")
    .replace(/,\s*([\]}])/g, "$1")
    .trim();
  const jsonish = stripped.replace(/^[^[{]*/, "");
  if (jsonish.startsWith("{") || jsonish.startsWith("[")) {
    try {
      const parsed = JSON.parse(jsonish);
      const arr = Array.isArray(parsed) ? parsed : parsed?.turns;
      if (Array.isArray(arr)) return arr.map(String);
    } catch {
      // fall through to line mode
    }
  }
  return stripped
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^["']|["'],?$/g, ""))
    .filter(Boolean);
}

export function parseInstructions(input: string): ParseResult {
  const errors: string[] = [];
  const lines = extractLines(input);
  const steps: ParsedStep[] = [];
  for (let i = 0; i < lines.length; i++) {
    const step = parseLine(lines[i]!, i, errors);
    if (step) steps.push(step);
  }

  const starts = steps.filter((s) => s.kind === "border-start");
  const ends = steps.filter((s) => s.kind === "border-end");
  if (starts.length !== 1) errors.push(`Expected exactly one "Border Start" line, found ${starts.length}`);
  if (ends.length !== 1) errors.push(`Expected exactly one "Border End" line, found ${ends.length}`);
  if (steps.length > 0 && steps[0]!.kind !== "border-start") {
    errors.push(`"Border Start" should be the first instruction`);
  }
  if (steps.length > 0 && steps[steps.length - 1]!.kind !== "border-end") {
    errors.push(`"Border End" should be the last instruction`);
  }
  if (steps.filter((s) => s.kind === "step").length === 0) {
    errors.push("No drive steps found between the borders");
  }
  return { steps, errors };
}
