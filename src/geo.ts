import type { LatLng } from "./types";

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export function haversineM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(a: LatLng, bearing: number, distM: number): LatLng {
  const br = rad(bearing);
  const dr = distM / R;
  const lat1 = rad(a.lat);
  const lng1 = rad(a.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dr) + Math.cos(lat1) * Math.sin(dr) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(dr) * Math.cos(lat1),
      Math.cos(dr) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: deg(lat2), lng: ((deg(lng2) + 540) % 360) - 180 };
}

export function buildCum(latlngs: LatLng[]): number[] {
  const cum = new Array<number>(latlngs.length);
  cum[0] = 0;
  for (let i = 1; i < latlngs.length; i++) {
    cum[i] = cum[i - 1]! + haversineM(latlngs[i - 1]!, latlngs[i]!);
  }
  return cum;
}

/** Largest index i with cum[i] <= d (binary search). */
export function indexAtDist(cum: number[], d: number): number {
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid]! <= d) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function pointAtDist(
  latlngs: LatLng[],
  cum: number[],
  d: number,
): { point: LatLng; heading: number; idx: number } {
  const total = cum[cum.length - 1]!;
  const dd = Math.max(0, Math.min(d, total));
  const i = Math.min(indexAtDist(cum, dd), latlngs.length - 2);
  const a = latlngs[i]!;
  const b = latlngs[i + 1]!;
  const segLen = cum[i + 1]! - cum[i]!;
  const t = segLen > 0 ? (dd - cum[i]!) / segLen : 0;
  return {
    point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
    heading: bearingDeg(a, b),
    idx: i,
  };
}

/** Shortest-path angular interpolation, factor f in [0,1]. */
export function lerpAngle(from: number, to: number, f: number): number {
  let diff = ((to - from + 540) % 360) - 180;
  return (from + diff * f + 360) % 360;
}
