import type { Alignment, DriveStep, ParsedStep, RouteData, Segment } from "./types";
import { MI, fmtMi } from "./types";
import { indexAtDist } from "./geo";

/**
 * Assigns each drive instruction a slice of the routed polyline.
 *
 * OSRM only reports road refs at maneuvers, so most instruction boundaries
 * (concurrency bookkeeping like "I-55" then "I-55/I-70") are invisible in the
 * data. The model used here:
 *
 *  1. Pin an instruction where a road distinctive to it first appears in the
 *     refs (hard evidence, e.g. the merge onto I-255).
 *  2. Between pins, place boundaries by the stated distances, rescaled to the
 *     actual distance of the region.
 *  3. Snap a placed boundary to a nearby physical maneuver (fork, ramp) when
 *     one sits within tolerance; snapped and pinned boundaries are exact,
 *     the rest are estimates and are marked as such.
 */
export function alignRoute(parsed: ParsedStep[], route: RouteData): Alignment {
  const drive = parsed.filter((s): s is DriveStep => s.kind === "step");
  const segments: Segment[] = [];
  const warnings: string[] = [];
  const n = drive.length;
  if (n === 0) return { segments, warnings };

  const total = route.totalMeters;
  const sets = drive.map((s) => new Set(s.roads.map((r) => r.key)));

  // Roads that appear in a flat step's refs for the first time.
  const flatNew: string[][] = [];
  {
    let prev = new Set<string>();
    for (const f of route.flatSteps) {
      flatNew.push(f.refs.filter((r) => !prev.has(r)));
      if (f.refs.length > 0) prev = new Set(f.refs);
    }
  }

  // --- 1. pins -------------------------------------------------------------
  const pinned = new Map<number, number>(); // drive index -> boundary meters
  let searchFrom = 0;
  let lastPinM = -1;
  for (let j = 0; j < n; j++) {
    const roads = sets[j]!;
    const prevRoads = j > 0 ? sets[j - 1]! : new Set<string>();
    for (let k = searchFrom; k < route.flatSteps.length; k++) {
      const distinct = flatNew[k]!.some((r) => roads.has(r) && !prevRoads.has(r));
      if (!distinct) continue;
      const m = route.flatSteps[k]!.startM;
      const roomNeeded = Math.max(500, (n - 1 - j) * 150);
      if (m > lastPinM && (j === 0 || m > 0) && m < total - roomNeeded) {
        pinned.set(j, m);
        lastPinM = m;
        searchFrom = k + 1;
      }
      break; // only the first appearance counts
    }
  }

  // --- 2 + 3. distribute and snap ------------------------------------------
  const bounds = new Array<number>(n + 1).fill(-1);
  bounds[0] = 0;
  bounds[n] = total;
  for (const [j, m] of pinned) if (j > 0) bounds[j] = m;

  const maneuvers = route.flatSteps.map((f) => f.startM).filter((m) => m > 0 && m < total);
  const exact = new Set<number>([0, n]);
  for (const j of pinned.keys()) exact.add(j);

  const weight = (j: number): number => drive[j]!.claimedMeters ?? 0;

  let a = 0;
  while (a < n) {
    let b = a + 1;
    while (b <= n && bounds[b] === -1) b++;
    // region: boundaries a..b fixed at ends, place a+1..b-1
    if (b - a > 1) {
      let regionClaims = 0;
      for (let j = a; j < b; j++) regionClaims += weight(j);
      const fallbackW = regionClaims > 0 ? regionClaims / (b - a) : 1;
      const w = (j: number) => weight(j) > 0 ? weight(j) : fallbackW;

      for (let j = a + 1; j < b; j++) {
        let remainClaims = 0;
        for (let k = j - 1; k < b; k++) remainClaims += w(k);
        const scale = (bounds[b]! - bounds[j - 1]!) / (remainClaims || 1);
        let m = bounds[j - 1]! + w(j - 1) * scale;

        // snap to a physical maneuver when one is close
        const segApprox = w(j - 1) * scale;
        const tol = Math.max(2 * MI, segApprox * 0.25);
        let best: number | null = null;
        for (const cand of maneuvers) {
          if (cand <= bounds[j - 1]! + 150 || cand >= bounds[b]! - 150) continue;
          if (Math.abs(cand - m) <= tol && (best === null || Math.abs(cand - m) < Math.abs(best - m))) {
            best = cand;
          }
        }
        if (best !== null) {
          m = best;
          exact.add(j);
        }
        bounds[j] = m;
      }
    }
    a = b;
  }

  // --- segments + verification --------------------------------------------
  for (let j = 0; j < n; j++) {
    const step = drive[j]!;
    const startM = bounds[j]!;
    const endM = bounds[j + 1]!;
    const measured = endM - startM;
    const approx = !exact.has(j) || !exact.has(j + 1);
    const notes: string[] = [];
    let level: Segment["level"] = "ok";

    if (step.claimedMeters !== undefined) {
      const diff = Math.abs(measured - step.claimedMeters);
      if (diff > Math.max(2 * MI, step.claimedMeters * 0.15)) {
        notes.push(`Stated ${fmtMi(step.claimedMeters)} mi, driven ${approx ? "about " : ""}${fmtMi(measured)} mi`);
        level = "warn";
      }
    }

    segments.push({
      stepIndex: step.index,
      startM,
      endM,
      startIdx: indexAtDist(route.cum, startM),
      endIdx: indexAtDist(route.cum, endM),
      measuredMeters: measured,
      approxBoundary: approx,
      notes,
      level,
    });
  }

  const claimedTotal = drive.reduce((s, d) => s + (d.claimedMeters ?? 0), 0);
  if (claimedTotal > 0) {
    const diff = Math.abs(total - claimedTotal);
    if (diff > Math.max(3 * MI, claimedTotal * 0.1)) {
      warnings.push(
        `Stated total ${fmtMi(claimedTotal)} mi differs from the driven ${fmtMi(total)} mi`,
      );
    }
  }
  for (const seg of segments) {
    const step = drive.find((d) => d.index === seg.stepIndex);
    for (const note of seg.notes) warnings.push(`"${step?.raw ?? seg.stepIndex}": ${note}`);
  }

  return { segments, warnings };
}

/** Parsed-step index of the instruction being driven at a given odometer reading. */
export function stepIndexAt(segments: Segment[], odoM: number): number {
  let found = segments[0]?.stepIndex ?? 0;
  for (const seg of segments) {
    if (odoM >= seg.startM) found = seg.stepIndex;
    else break;
  }
  return found;
}
