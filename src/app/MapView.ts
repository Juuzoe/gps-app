import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { LatLng, RouteResult } from '../engine/types'

/** Imperative MapLibre wrapper: route layers, waypoints, puck, camera modes. */

const DARK = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json'
const LIGHT = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

export type Basemap = 'dark' | 'light'

export class MapView {
  readonly map: maplibregl.Map
  private route?: RouteResult
  private puckMarker?: maplibregl.Marker
  private puckEl: HTMLElement
  private arrowEl: SVGElement
  private drawAnimation?: number
  basemap: Basemap = 'dark'
  private popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 })

  constructor(container: HTMLElement) {
    this.map = new maplibregl.Map({
      container,
      style: DARK,
      center: [-99.3, 31.4],
      zoom: 5.2,
      attributionControl: { compact: true },
      preserveDrawingBuffer: true, // allows canvas snapshots (proof/export)
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'bottom-right')
    this.map.on('style.load', () => this.applyLayers())

    this.puckEl = document.createElement('div')
    this.puckEl.className = 'puck'
    this.puckEl.innerHTML =
      `<svg viewBox="0 0 24 24"><path d="M12 2.5 18.5 20 12 15.8 5.5 20Z" fill="#FFB020" stroke="#0F1114" stroke-width="1.4" stroke-linejoin="round"/></svg>`
    this.arrowEl = this.puckEl.querySelector('svg')!
  }

  setBasemap(b: Basemap) {
    if (b === this.basemap) return
    this.basemap = b
    this.map.setStyle(b === 'dark' ? DARK : LIGHT)
    // layers re-applied by the style.load handler
  }

  private src(id: string, data: GeoJSON.GeoJSON) {
    const existing = this.map.getSource(id) as maplibregl.GeoJSONSource | undefined
    if (existing) existing.setData(data)
    else this.map.addSource(id, { type: 'geojson', data })
  }

  private emptyFC(): GeoJSON.FeatureCollection {
    return { type: 'FeatureCollection', features: [] }
  }

  /** (Re)create sources and layers — runs on load and after style switches. */
  private applyLayers() {
    const casing = this.basemap === 'dark' ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.9)'
    this.src('route', this.routeGeojson())
    this.src('route-progress', this.emptyFC())
    this.src('waypoints', this.waypointGeojson())
    this.src('offroute', this.emptyFC())

    if (!this.map.getLayer('route-casing')) {
      this.map.addLayer({
        id: 'route-casing', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': casing, 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 5, 14, 11] },
      })
      this.map.addLayer({
        id: 'route-line', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#FFB020',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 14, 6],
        },
      })
      this.map.addLayer({
        id: 'route-progress-line', type: 'line', source: 'route-progress',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': this.basemap === 'dark' ? '#7d6a3c' : '#c9a35c',
          'line-width': ['interpolate', ['linear'], ['zoom'], 5, 2.5, 14, 6],
        },
      })
      this.map.addLayer({
        id: 'route-arrows', type: 'symbol', source: 'route',
        layout: {
          'symbol-placement': 'line', 'symbol-spacing': 120,
          'text-field': '›', 'text-size': 13, 'text-keep-upright': false,
          'text-font': ['Noto Sans Regular'], 'text-allow-overlap': true,
        },
        paint: { 'text-color': '#241a05', 'text-opacity': 0.85 },
      })
      this.map.addLayer({
        id: 'wp-circles', type: 'circle', source: 'waypoints',
        paint: {
          'circle-radius': ['case', ['in', ['get', 'kind'], ['literal', ['origin', 'destination']]], 6.5, 4.5],
          'circle-color': [
            'match', ['get', 'kind'],
            'origin', '#58C08B',
            'destination', '#FFFFFF',
            '#0F1114',
          ],
          'circle-stroke-width': 2,
          'circle-stroke-color': [
            'match', ['get', 'status'],
            'ok', '#FFB020',
            'approx', '#FFB020',
            '#FF8075',
          ],
        },
      })
    } else {
      this.map.setPaintProperty('route-casing', 'line-color', casing)
      this.map.setPaintProperty(
        'route-progress-line', 'line-color', this.basemap === 'dark' ? '#7d6a3c' : '#c9a35c',
      )
    }

    this.map.off('mouseenter', 'wp-circles', this.onWpEnter)
    this.map.off('mouseleave', 'wp-circles', this.onWpLeave)
    this.map.on('mouseenter', 'wp-circles', this.onWpEnter)
    this.map.on('mouseleave', 'wp-circles', this.onWpLeave)
  }

  private onWpEnter = (e: maplibregl.MapLayerMouseEvent) => {
    const f = e.features?.[0]
    if (!f) return
    this.map.getCanvas().style.cursor = 'pointer'
    const [lng, lat] = (f.geometry as GeoJSON.Point).coordinates
    this.popup.setLngLat([lng, lat]).setText(String(f.properties?.label ?? '')).addTo(this.map)
  }
  private onWpLeave = () => {
    this.map.getCanvas().style.cursor = ''
    this.popup.remove()
  }

  private routeGeojson(coords?: [number, number][]): GeoJSON.GeoJSON {
    const c = coords ?? this.route?.geometry ?? []
    if (c.length < 2) return this.emptyFC()
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: c } }
  }

  private waypointGeojson(): GeoJSON.GeoJSON {
    if (!this.route) return this.emptyFC()
    return {
      type: 'FeatureCollection',
      features: this.route.waypoints
        .filter((w) => w.status === 'ok' || w.status === 'approx')
        .map((w) => ({
          type: 'Feature',
          properties: { label: w.label, kind: w.kind, status: w.status },
          geometry: { type: 'Point', coordinates: [w.pos.lng, w.pos.lat] },
        })),
    }
  }

  setRoute(route: RouteResult | undefined, animate = true) {
    this.route = route
    if (this.drawAnimation) cancelAnimationFrame(this.drawAnimation)
    // isStyleLoaded() lies in throttled/hidden tabs — apply optimistically and
    // defer only if the style truly isn't there yet (applyLayers re-reads
    // this.route on style.load anyway).
    try {
      if (!this.map.getSource('route')) this.applyLayers()
    } catch {
      return
    }
    this.src('waypoints', this.waypointGeojson())
    this.src('route-progress', this.emptyFC())
    if (!route || route.geometry.length < 2) {
      this.src('route', this.emptyFC())
      return
    }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!animate || reduce || document.hidden) {
      this.src('route', this.routeGeojson())
      return
    }
    // draw-in start→end: communicates travel direction
    const coords = route.geometry
    const t0 = performance.now()
    const dur = 900
    let finished = false
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / dur)
      const eased = 1 - Math.pow(1 - k, 3)
      const n = Math.max(2, Math.floor(coords.length * eased))
      this.src('route', this.routeGeojson(coords.slice(0, n)))
      if (k < 1) this.drawAnimation = requestAnimationFrame(tick)
      else finished = true
    }
    this.drawAnimation = requestAnimationFrame(tick)
    // backstop: rAF stalls in hidden tabs — the full line must land regardless
    window.setTimeout(() => {
      if (!finished && this.route === route) this.src('route', this.routeGeojson())
    }, dur + 200)
  }

  fitRoute(pad = 70) {
    if (!this.route || this.route.geometry.length < 2) return
    const b = new maplibregl.LngLatBounds()
    for (const c of this.route.geometry) b.extend(c)
    const el = this.map.getContainer()
    const horizontal = Math.min(pad, el.clientWidth * 0.2)
    this.map.fitBounds(b, {
      padding: { top: pad, bottom: pad, left: horizontal, right: horizontal },
      duration: 700, pitch: 0, bearing: 0,
    })
  }

  fitSlice(from: number, to: number) {
    if (!this.route) return
    const b = new maplibregl.LngLatBounds()
    for (let i = from; i <= Math.min(to, this.route.geometry.length - 1); i++) b.extend(this.route.geometry[i])
    this.map.fitBounds(b, { padding: 90, duration: 650, pitch: 0, bearing: 0 })
  }

  /** Show progress overlay: driven part of the route in a dimmed tone. */
  setProgress(uptoIndex: number) {
    if (!this.route) return
    const coords = this.route.geometry.slice(0, Math.max(2, uptoIndex + 1))
    this.src('route-progress', {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: coords },
    })
  }

  setPuck(pos: LatLng | undefined, heading = 0) {
    if (!pos) {
      this.puckMarker?.remove()
      this.puckMarker = undefined
      return
    }
    if (!this.puckMarker) {
      this.puckMarker = new maplibregl.Marker({ element: this.puckEl, rotationAlignment: 'map', pitchAlignment: 'map' })
        .setLngLat([pos.lng, pos.lat])
        .addTo(this.map)
    } else {
      this.puckMarker.setLngLat([pos.lng, pos.lat])
    }
    this.puckMarker.setRotation(heading)
    this.arrowEl.style.transform = ''
  }

  followFirstPerson(pos: LatLng, heading: number, durationMs: number) {
    this.map.easeTo({
      center: [pos.lng, pos.lat],
      bearing: heading,
      pitch: 60,
      zoom: 15.6,
      padding: { top: Math.round(this.map.getContainer().clientHeight * 0.42), bottom: 0, left: 0, right: 0 },
      duration: durationMs,
      easing: (t) => t,
      essential: true,
    })
  }

  exitFirstPerson() {
    this.map.easeTo({ pitch: 0, bearing: 0, padding: { top: 0, bottom: 0, left: 0, right: 0 }, duration: 500 })
  }

  setOffRouteLine(from: LatLng | undefined, to: LatLng | undefined) {
    if (!from || !to) {
      this.src('offroute', this.emptyFC())
      return
    }
    this.src('offroute', {
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: [[from.lng, from.lat], [to.lng, to.lat]] },
    })
    if (!this.map.getLayer('offroute-line')) {
      this.map.addLayer({
        id: 'offroute-line', type: 'line', source: 'offroute',
        paint: { 'line-color': '#FF8075', 'line-width': 2.5, 'line-dasharray': [1.2, 1.6] },
      })
    }
  }

  destroy() {
    if (this.drawAnimation) cancelAnimationFrame(this.drawAnimation)
    this.map.remove()
  }
}
