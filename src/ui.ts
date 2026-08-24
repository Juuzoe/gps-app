import type { GpsFix, NavRoute, ParsedStep, Segment } from "./types";
import { fmtMi } from "./types";
import { shieldRow, escapeXml } from "./shields";
import { stateName } from "./states";

export function fmtDuration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.round((s - h * 3600) / 60);
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")} m` : `${m} min`;
}

export function fmtCoord(lat: number, lng: number): string {
  const ns = lat >= 0 ? "N" : "S";
  const ew = lng >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(5)}° ${ns}  ${Math.abs(lng).toFixed(5)}° ${ew}`;
}

function segmentFor(nav: NavRoute, parsedIndex: number): Segment | undefined {
  return nav.alignment.segments.find((s) => s.stepIndex === parsedIndex);
}

function stepTitle(step: ParsedStep): string {
  if (step.kind !== "step") {
    const which = step.kind === "border-start" ? "Enter from" : "Exit into";
    const name = step.stateAbbrev ? stateName(step.stateAbbrev) : step.state;
    return `${which} ${name}`;
  }
  let title = step.roads.map((r) => r.raw).join(" / ");
  if (step.exit) title += `, exit ${step.exit}`;
  if (step.toward) title += ` toward ${step.toward}`;
  return title;
}

export function renderSteps(
  listEl: HTMLElement,
  nav: NavRoute,
  onSeek: (meters: number) => void,
): Map<number, HTMLElement> {
  listEl.innerHTML = "";
  const rows = new Map<number, HTMLElement>();

  for (const step of nav.parsed) {
    const li = document.createElement("li");
    li.className = "step";
    li.dataset.index = String(step.index);
    li.tabIndex = 0;
    li.setAttribute("role", "button");

    const seg = step.kind === "step" ? segmentFor(nav, step.index) : undefined;
    const seekTo =
      step.kind === "border-start" ? 0 :
      step.kind === "border-end" ? nav.route.totalMeters :
      seg?.startM ?? 0;

    if (step.kind !== "step") {
      li.classList.add("step-line");
      const name = step.stateAbbrev ?? step.state;
      li.innerHTML = `
        <span class="line-mark" aria-hidden="true"><span></span><span></span><span></span></span>
        <div class="step-body">
          <div class="step-title">${escapeXml(stepTitle(step))}</div>
          <div class="step-meta">state line, ${escapeXml(step.roads[0]?.raw ?? "")}</div>
        </div>
        <div class="step-dist">${step.kind === "border-start" ? "start" : fmtMi(nav.route.totalMeters)}</div>`;
      li.setAttribute("aria-label", `${stepTitle(step)}, ${name} state line`);
    } else {
      if (seg && seg.level !== "ok") li.classList.add(`step-${seg.level}`);
      const about = seg?.approxBoundary ? "≈" : "";
      const claimed = step.claimedMeters !== undefined ? `${fmtMi(step.claimedMeters)} mi stated` : "no distance stated";
      const actual = seg && seg.measuredMeters > 0 ? `${about}${fmtMi(seg.measuredMeters)} mi driven` : null;
      const notes = (seg?.notes ?? [])
        .map((n) => `<div class="step-note step-note-${seg!.level}">${escapeXml(n)}</div>`)
        .join("");
      li.innerHTML = `
        <span class="step-shields">${shieldRow(step.roads.slice(0, 2))}</span>
        <div class="step-body">
          <div class="step-title">${escapeXml(stepTitle(step))}</div>
          <div class="step-meta">${escapeXml(claimed)}${actual ? `, ${escapeXml(actual)}` : ""}</div>
          ${notes}
        </div>
        <div class="step-dist">${seg ? about + fmtMi(seg.measuredMeters) : "?"}<span>mi</span></div>`;
    }

    const activate = () => onSeek(seekTo);
    li.addEventListener("click", activate);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });
    listEl.appendChild(li);
    rows.set(step.index, li);
  }
  return rows;
}

export function renderTotals(el: HTMLElement, nav: NavRoute): void {
  const drive = nav.parsed.filter((s) => s.kind === "step");
  const flagged = nav.alignment.segments.filter((s) => s.level !== "ok").length;
  const driveTimeS = (nav.route.totalMeters / 1609.344 / 65) * 3600;
  el.innerHTML = `
    <div class="totals-item"><span class="totals-label">Stated</span><span class="totals-value">${fmtMi(nav.claimedTotalMeters)} mi</span></div>
    <div class="totals-item"><span class="totals-label">Driven</span><span class="totals-value">${fmtMi(nav.route.totalMeters)} mi</span></div>
    <div class="totals-item"><span class="totals-label">At 65 mph</span><span class="totals-value">${fmtDuration(driveTimeS)}</span></div>
    <div class="totals-item"><span class="totals-label">Steps</span><span class="totals-value">${drive.length}${flagged ? ` <em class="totals-flag">${flagged} flagged</em>` : ""}</span></div>`;
  el.hidden = false;
}

export type HudRefs = {
  hud: HTMLElement;
  shields: HTMLElement;
  mph: HTMLElement;
  nextDist: HTMLElement;
  nextText: HTMLElement;
  eta: HTMLElement;
  coord: HTMLElement;
  odo: HTMLElement;
  progressFill: HTMLElement;
  gpsDot: HTMLElement;
};

export function updateHud(refs: HudRefs, fix: GpsFix, nav: NavRoute): void {
  const cur = nav.parsed.find((s) => s.index === fix.stepIndex);
  refs.mph.textContent = String(Math.round(fix.speedMph));

  if (cur) {
    const roads = cur.roads.slice(0, 2);
    const html = shieldRow(roads);
    if (refs.shields.dataset.key !== cur.raw) {
      refs.shields.dataset.key = cur.raw;
      refs.shields.innerHTML = html;
    }
  }

  const nextSeg = nav.alignment.segments.find((s) => s.startM > fix.odometerM + 1);
  if (nextSeg) {
    const nextStep = nav.parsed.find((s) => s.index === nextSeg.stepIndex);
    refs.nextDist.textContent = `${fmtMi(nextSeg.startM - fix.odometerM)} mi`;
    refs.nextText.textContent = nextStep ? stepTitle(nextStep) : "";
  } else {
    const end = nav.parsed[nav.parsed.length - 1];
    refs.nextDist.textContent = `${fmtMi(nav.route.totalMeters - fix.odometerM)} mi`;
    refs.nextText.textContent = end && end.kind !== "step" ? stepTitle(end) : "route end";
  }

  const remainS = ((nav.route.totalMeters - fix.odometerM) / 1609.344 / 65) * 3600;
  refs.eta.textContent = fix.done ? "arrived" : fmtDuration(remainS);
  refs.coord.textContent = fmtCoord(fix.lat, fix.lng);
  refs.odo.textContent = `mi ${fmtMi(fix.odometerM)} of ${fmtMi(nav.route.totalMeters)}`;
  refs.progressFill.style.transform = `scaleX(${(fix.odometerM / nav.route.totalMeters).toFixed(4)})`;
  refs.gpsDot.classList.toggle("live", fix.speedMph > 0);
}
