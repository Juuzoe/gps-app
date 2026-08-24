import type { GpsFix, NavRoute } from "./types";
import { lerpAngle, pointAtDist } from "./geo";
import { stepIndexAt } from "./aligner";

const MPH_TO_MPS = 0.44704;

/** Drives a virtual vehicle along the routed polyline and emits GPS fixes. */
export class Simulator {
  odoM = 0;
  playing = false;
  multiplier = 50;
  cruiseMph = 65;
  /** Capture mode: report cruise speed on the HUD while stepping frames paused. */
  forceLiveSpeed = false;

  private heading = 0;
  private headingInit = false;
  private simTimeS = 0;

  constructor(private nav: NavRoute) {}

  get totalM(): number {
    return this.nav.route.totalMeters;
  }

  get done(): boolean {
    return this.odoM >= this.totalM - 0.5;
  }

  seekMeters(m: number): void {
    this.odoM = Math.max(0, Math.min(m, this.totalM));
    this.simTimeS = this.odoM / (this.cruiseMph * MPH_TO_MPS);
    this.headingInit = false;
  }

  seekFrac(f: number): void {
    this.seekMeters(this.totalM * f);
  }

  /** Advance by real elapsed seconds (scaled by the sim multiplier). */
  advance(dtRealS: number): void {
    if (!this.playing) return;
    const dtSim = Math.min(dtRealS, 0.25) * this.multiplier;
    this.odoM = Math.min(this.odoM + this.cruiseMph * MPH_TO_MPS * dtSim, this.totalM);
    this.simTimeS += dtSim;
    if (this.done) this.playing = false;
  }

  fix(): GpsFix {
    const { route, alignment } = this.nav;
    const { point, heading } = pointAtDist(route.latlngs, route.cum, this.odoM);
    if (!this.headingInit) {
      this.heading = heading;
      this.headingInit = true;
    } else {
      this.heading = lerpAngle(this.heading, heading, 0.3);
    }
    return {
      lat: point.lat,
      lng: point.lng,
      headingDeg: this.heading,
      speedMph: this.playing || this.forceLiveSpeed ? this.cruiseMph : 0,
      odometerM: this.odoM,
      simTimeS: this.simTimeS,
      stepIndex: stepIndexAt(alignment.segments, this.odoM),
      done: this.done,
    };
  }
}
