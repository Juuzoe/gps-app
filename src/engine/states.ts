import type { LatLng } from './types'

export interface StateInfo {
  code: string
  name: string
  centroid: LatLng
  /** [minLat, minLng, maxLat, maxLng] — scopes Overpass queries.
   *  A bbox hits the spatial index directly; the equivalent
   *  area["ISO3166-2"] lookup is far slower and frequently times out. */
  bbox: [number, number, number, number]
  neighbors: string[] // state codes; MX / CA_INTL for international
}

/** State extents from OSM administrative boundaries, rounded to 0.01°. */
const BBOX: Record<string, [number, number, number, number]> = {
  AL: [30.14, -88.47, 35.01, -84.89],
  AZ: [31.33, -114.82, 37, -109.04],
  AR: [33, -94.62, 36.5, -89.64],
  CA: [32.53, -124.48, 42.01, -114.13],
  CO: [36.99, -109.06, 41, -102.04],
  CT: [40.95, -73.73, 42.05, -71.79],
  DE: [38.45, -75.79, 39.84, -74.98],
  FL: [24.4, -87.63, 31, -79.97],
  GA: [30.36, -85.61, 35, -80.75],
  ID: [41.99, -117.24, 49, -111.04],
  IL: [36.97, -91.51, 42.51, -87.02],
  IN: [37.77, -88.1, 41.76, -84.78],
  IA: [40.38, -96.64, 43.5, -90.14],
  KS: [36.99, -102.05, 40, -94.59],
  KY: [36.5, -89.57, 39.15, -81.96],
  LA: [28.85, -94.04, 33.02, -88.76],
  ME: [42.92, -71.08, 47.46, -66.89],
  MD: [37.89, -79.49, 39.72, -74.99],
  MA: [41.19, -73.51, 42.89, -69.86],
  MI: [41.7, -90.42, 48.31, -82.12],
  MN: [43.5, -97.24, 49.38, -89.48],
  MS: [30.14, -91.66, 35, -88.1],
  MO: [36, -95.77, 40.61, -89.1],
  MT: [44.36, -116.05, 49, -104.04],
  NE: [40, -104.05, 43, -95.31],
  NV: [35, -120.01, 42, -114.04],
  NH: [42.7, -72.56, 45.31, -70.56],
  NJ: [38.79, -75.56, 41.36, -73.89],
  NM: [31.33, -109.05, 37, -103],
  NY: [40.48, -79.76, 45.02, -71.79],
  NC: [33.75, -84.32, 36.59, -75.4],
  ND: [45.93, -104.05, 49, -96.55],
  OH: [38.4, -84.82, 42.32, -80.52],
  OK: [33.62, -103, 37, -94.43],
  OR: [41.99, -124.7, 46.29, -116.46],
  PA: [39.72, -80.52, 42.52, -74.69],
  RI: [41.1, -71.91, 42.02, -71.09],
  SC: [32.03, -83.35, 35.22, -78.54],
  SD: [42.48, -104.06, 45.95, -96.44],
  TN: [34.98, -90.31, 36.68, -81.65],
  TX: [25.84, -106.65, 36.5, -93.51],
  UT: [37, -114.05, 42, -109.04],
  VT: [42.73, -73.44, 45.02, -71.47],
  VA: [36.54, -83.68, 39.47, -75.17],
  WA: [45.54, -124.84, 49, -116.92],
  WV: [37.2, -82.64, 40.64, -77.72],
  WI: [42.49, -92.89, 47.31, -86.25],
  WY: [40.99, -111.06, 45.01, -104.05]
}

const S = (code: string, name: string, lat: number, lng: number, neighbors: string[]): StateInfo => ({
  code, name, centroid: { lat, lng }, bbox: BBOX[code], neighbors,
})

export const STATES: StateInfo[] = [
  S('AL', 'Alabama', 32.8, -86.8, ['FL', 'GA', 'MS', 'TN']),
  S('AZ', 'Arizona', 34.2, -111.9, ['CA', 'NV', 'UT', 'NM', 'MX']),
  S('AR', 'Arkansas', 34.9, -92.4, ['LA', 'MS', 'MO', 'OK', 'TN', 'TX']),
  S('CA', 'California', 37.2, -119.3, ['AZ', 'NV', 'OR', 'MX']),
  S('CO', 'Colorado', 39.0, -105.5, ['KS', 'NE', 'NM', 'OK', 'UT', 'WY']),
  S('CT', 'Connecticut', 41.6, -72.7, ['MA', 'NY', 'RI']),
  S('DE', 'Delaware', 39.0, -75.5, ['MD', 'NJ', 'PA']),
  S('FL', 'Florida', 28.6, -82.4, ['AL', 'GA']),
  S('GA', 'Georgia', 32.6, -83.4, ['AL', 'FL', 'NC', 'SC', 'TN']),
  S('ID', 'Idaho', 44.4, -114.6, ['MT', 'NV', 'OR', 'UT', 'WA', 'WY', 'CA_INTL']),
  S('IL', 'Illinois', 40.0, -89.2, ['IN', 'IA', 'KY', 'MO', 'WI']),
  S('IN', 'Indiana', 39.9, -86.3, ['IL', 'KY', 'MI', 'OH']),
  S('IA', 'Iowa', 42.0, -93.5, ['IL', 'MN', 'MO', 'NE', 'SD', 'WI']),
  S('KS', 'Kansas', 38.5, -98.4, ['CO', 'MO', 'NE', 'OK']),
  S('KY', 'Kentucky', 37.5, -85.3, ['IL', 'IN', 'MO', 'OH', 'TN', 'VA', 'WV']),
  S('LA', 'Louisiana', 31.0, -92.0, ['AR', 'MS', 'TX']),
  S('ME', 'Maine', 45.4, -69.2, ['NH', 'CA_INTL']),
  S('MD', 'Maryland', 39.0, -76.8, ['DE', 'PA', 'VA', 'WV', 'DC']),
  S('MA', 'Massachusetts', 42.3, -71.8, ['CT', 'NH', 'NY', 'RI', 'VT']),
  S('MI', 'Michigan', 44.3, -85.4, ['IN', 'OH', 'WI', 'CA_INTL']),
  S('MN', 'Minnesota', 46.3, -94.3, ['IA', 'ND', 'SD', 'WI', 'CA_INTL']),
  S('MS', 'Mississippi', 32.7, -89.7, ['AL', 'AR', 'LA', 'TN']),
  S('MO', 'Missouri', 38.4, -92.5, ['AR', 'IL', 'IA', 'KS', 'KY', 'NE', 'OK', 'TN']),
  S('MT', 'Montana', 47.0, -109.6, ['ID', 'ND', 'SD', 'WY', 'CA_INTL']),
  S('NE', 'Nebraska', 41.5, -99.8, ['CO', 'IA', 'KS', 'MO', 'SD', 'WY']),
  S('NV', 'Nevada', 39.3, -116.6, ['AZ', 'CA', 'ID', 'OR', 'UT']),
  S('NH', 'New Hampshire', 43.7, -71.6, ['ME', 'MA', 'VT', 'CA_INTL']),
  S('NJ', 'New Jersey', 40.2, -74.7, ['DE', 'NY', 'PA']),
  S('NM', 'New Mexico', 34.4, -106.1, ['AZ', 'CO', 'OK', 'TX', 'MX']),
  S('NY', 'New York', 42.9, -75.5, ['CT', 'MA', 'NJ', 'PA', 'VT', 'CA_INTL']),
  S('NC', 'North Carolina', 35.5, -79.4, ['GA', 'SC', 'TN', 'VA']),
  S('ND', 'North Dakota', 47.4, -100.5, ['MN', 'MT', 'SD', 'CA_INTL']),
  S('OH', 'Ohio', 40.3, -82.8, ['IN', 'KY', 'MI', 'PA', 'WV']),
  S('OK', 'Oklahoma', 35.6, -97.5, ['AR', 'CO', 'KS', 'MO', 'NM', 'TX']),
  S('OR', 'Oregon', 43.9, -120.6, ['CA', 'ID', 'NV', 'WA']),
  S('PA', 'Pennsylvania', 40.9, -77.8, ['DE', 'MD', 'NJ', 'NY', 'OH', 'WV']),
  S('RI', 'Rhode Island', 41.7, -71.6, ['CT', 'MA']),
  S('SC', 'South Carolina', 33.9, -80.9, ['GA', 'NC']),
  S('SD', 'South Dakota', 44.4, -100.2, ['IA', 'MN', 'MT', 'NE', 'ND', 'WY']),
  S('TN', 'Tennessee', 35.8, -86.4, ['AL', 'AR', 'GA', 'KY', 'MS', 'MO', 'NC', 'VA']),
  S('TX', 'Texas', 31.5, -99.3, ['AR', 'LA', 'NM', 'OK', 'MX']),
  S('UT', 'Utah', 39.3, -111.7, ['AZ', 'CO', 'ID', 'NV', 'WY']),
  S('VT', 'Vermont', 44.0, -72.7, ['MA', 'NH', 'NY', 'CA_INTL']),
  S('VA', 'Virginia', 37.5, -78.9, ['KY', 'MD', 'NC', 'TN', 'WV', 'DC']),
  S('WA', 'Washington', 47.4, -120.5, ['ID', 'OR', 'CA_INTL']),
  S('WV', 'West Virginia', 38.6, -80.6, ['KY', 'MD', 'OH', 'PA', 'VA']),
  S('WI', 'Wisconsin', 44.6, -89.7, ['IL', 'IA', 'MI', 'MN']),
  S('WY', 'Wyoming', 43.0, -107.5, ['CO', 'ID', 'MT', 'NE', 'SD', 'UT']),
]

export const INTL: Record<string, { name: string; aliases: string[] }> = {
  MX: { name: 'Mexico', aliases: ['mexico', 'mx'] },
  CA_INTL: { name: 'Canada', aliases: ['canada'] },
}

const byCode = new Map(STATES.map((s) => [s.code, s]))
const byName = new Map(STATES.map((s) => [s.name.toLowerCase(), s]))

/** Resolve "NM", "New Mexico", "Mexico", "Canada" → a place key (state code, MX, or CA_INTL). */
export function resolvePlace(raw: string): string | undefined {
  const t = raw.trim().toLowerCase().replace(/\s+line$/, '').trim()
  for (const [k, v] of Object.entries(INTL)) if (v.aliases.includes(t)) return k
  const up = t.toUpperCase()
  if (byCode.has(up)) return up
  const s = byName.get(t)
  return s?.code
}

export function stateInfo(code: string): StateInfo | undefined {
  return byCode.get(code)
}

export function placeName(key: string): string {
  return INTL[key]?.name ?? byCode.get(key)?.name ?? key
}

/**
 * The state a route traverses, given the two border places it runs between.
 * Returns candidates (usually one) — states adjacent to both.
 */
export function statesBetween(placeA: string, placeB: string): string[] {
  return STATES.filter((s) => s.neighbors.includes(placeA) && s.neighbors.includes(placeB)).map((s) => s.code)
}
