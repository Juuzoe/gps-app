import type { RoadRef } from "./types";

/**
 * Inline SVG route markers, loosely following real US sign shapes so the step
 * list reads like signage: Interstate shield, US route shield, state square.
 */
export function shieldSvg(road: RoadRef): string {
  const num = road.num;
  const fontSize = num.length >= 3 ? 12.5 : 15;
  const label = escapeXml(road.raw);

  if (road.system === "I") {
    return `<svg class="shield shield-i" viewBox="0 0 40 36" role="img" aria-label="${label}">
  <path d="M20 1.2 C25.4 4.4 32.4 5.8 38.8 5.2 C38.4 19.6 31.4 29.6 20 34.6 C8.6 29.6 1.6 19.6 1.2 5.2 C7.6 5.8 14.6 4.4 20 1.2 Z" fill="#b01c31"/>
  <path d="M20 3 C24.9 5.7 31 7 36.9 6.7 C36.4 19 30.2 27.9 20 32.6 C9.8 27.9 3.6 19 3.1 6.7 C9 7 15.1 5.7 20 3 Z" fill="#003f87" stroke="#f4f6f8" stroke-width="1.1"/>
  <text x="20" y="23.5" text-anchor="middle" font-size="${fontSize}" font-weight="700" fill="#f4f6f8">${num}</text>
</svg>`;
  }

  if (road.system === "US") {
    return `<svg class="shield shield-us" viewBox="0 0 40 36" role="img" aria-label="${label}">
  <path d="M6 3 H34 C34 8 37 9 37 14 C37 25 29 31.5 20 33.6 C11 31.5 3 25 3 14 C3 9 6 8 6 3 Z" fill="#f4f6f8" stroke="#1a212b" stroke-width="1.6"/>
  <text x="20" y="23.5" text-anchor="middle" font-size="${fontSize}" font-weight="700" fill="#1a212b">${num}</text>
</svg>`;
  }

  const sysLabel = escapeXml(road.system);
  return `<svg class="shield shield-state" viewBox="0 0 40 36" role="img" aria-label="${label}">
  <rect x="2.5" y="2.5" width="35" height="31" rx="5" fill="#f4f6f8" stroke="#1a212b" stroke-width="1.6"/>
  <text x="20" y="15" text-anchor="middle" font-size="8.5" font-weight="600" fill="#1a212b">${sysLabel}</text>
  <text x="20" y="28" text-anchor="middle" font-size="${num.length >= 3 ? 10.5 : 12.5}" font-weight="700" fill="#1a212b">${num}</text>
</svg>`;
}

export function shieldRow(roads: RoadRef[]): string {
  return roads.map(shieldSvg).join("");
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
