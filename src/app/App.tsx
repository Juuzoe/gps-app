import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { buildRoute } from '../engine/engine'
import { abortAll, mirrorHealth } from '../engine/overpass'
import { parseInput } from '../engine/parse'
import { routeChain } from '../engine/osrm'
import { MI } from '../engine/geo'
import { STATES, placeName } from '../engine/states'
import type { ProgressEvent, RouteResult } from '../engine/types'
import { MapView } from './MapView'
import { GpsSource, NavController, Simulator, fmtMi, type NavState } from './nav'

import sampleTx1 from '../../fixtures/actual/tx1.txt?raw'
import sampleTx3 from '../../fixtures/actual/tx3.txt?raw'
import sampleTx5 from '../../fixtures/actual/tx5.txt?raw'
import sampleTx5Turns from '../../fixtures/actual/tx5-turns.json?raw'
import sampleIl from '../../fixtures/own/il-sample.json?raw'

const SAMPLES: { label: string; text: string }[] = [
  { label: 'TX permit — Victoria → NM line (582 mi)', text: sampleTx1 },
  { label: 'TX permit — US-285 → Pecos, FM roads (130 mi)', text: sampleTx3 },
  { label: 'TX permit — I-40 OK line → US-380 NM line (315 mi)', text: sampleTx5 },
  { label: 'Turns JSON — same route as the I-40 permit', text: sampleTx5Turns },
  { label: 'Turns JSON — Illinois I-70 (offer example)', text: sampleIl },
]

type Phase = 'idle' | 'building' | 'ready' | 'failed'
type DriveMode = 'off' | 'sim' | 'gps'

export default function App() {
  const mapRef = useRef<MapView>()
  const mapDiv = useRef<HTMLDivElement>(null)
  const [input, setInput] = useState('')
  const [stateSel, setStateSel] = useState('auto')
  const [phase, setPhase] = useState<Phase>('idle')
  const [progress, setProgress] = useState<ProgressEvent>()
  const [result, setResult] = useState<RouteResult>()
  const [error, setError] = useState<string>()
  const [toast, setToast] = useState<string>()
  const [basemap, setBasemap] = useState<'dark' | 'light'>('dark')
  const [drive, setDrive] = useState<DriveMode>('off')
  const [firstPerson, setFirstPerson] = useState(true)
  const [nav, setNav] = useState<NavState>()
  const [simSpeed, setSimSpeed] = useState(20)
  const [wander, setWander] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [mirrors, setMirrors] = useState({ live: 0, total: 0 })
  const navRef = useRef<NavController>()
  const simRef = useRef<Simulator>()
  const gpsRef = useRef<GpsSource>()
  const fileRef = useRef<HTMLInputElement>(null)
  /** Background build started as soon as the input parses; Build adopts it. */
  const bgRef = useRef<{ key: string; promise: Promise<RouteResult> } | null>(null)
  const bgProgress = useRef<((e: ProgressEvent) => void) | null>(null)
  /** Last progress event from a background build, replayed when it is adopted. */
  const bgLast = useRef<ProgressEvent | undefined>(undefined)
  /** When the background build began, so elapsed counts real work, not clicks. */
  const bgStartedAt = useRef<number | undefined>(undefined)
  const [bgActive, setBgActive] = useState(false)

  useEffect(() => {
    if (!mapDiv.current) return
    const mv = new MapView(mapDiv.current)
    mapRef.current = mv
    return () => mv.destroy()
  }, [])

  // dev hook: lets tests inject a prebuilt RouteResult without the network
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as Record<string, unknown>).__mapview = () => mapRef.current
    ;(window as unknown as Record<string, unknown>).__setRoute = (r: RouteResult) => {
      setResult(r)
      setPhase('ready')
      const mv = mapRef.current
      if (mv) {
        mv.setRoute(r)
        mv.fitRoute()
      }
    }
  }, [])

  useEffect(() => {
    mapRef.current?.setBasemap(basemap)
  }, [basemap])

  useEffect(() => {
    if (phase !== 'building') return
    // Count from when the work actually began. Adopting a prefetch that has
    // been running for a while and restarting the clock at zero understates
    // the wait and delays the "servers are slow" note past the point it helps.
    const t0 = bgStartedAt.current ?? Date.now()
    const tick = () => {
      setElapsed(Math.round((Date.now() - t0) / 1000))
      setMirrors(mirrorHealth())
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [phase])

  // Start fetching while the user is still reading the parse chips. By the
  // time they press Build, the route is often already half-downloaded — the
  // click then adopts the running build instead of starting one.
  useEffect(() => {
    if (phase !== 'idle') return
    const text = input
    if (!text.trim()) return
    if (bgRef.current?.key === text) return
    const t = window.setTimeout(() => {
      let parsedOk = false
      try {
        parsedOk = parseInput(text).legs.length >= 2
      } catch { /* not parseable yet */ }
      if (!parsedOk || bgRef.current?.key === text) return
      if (bgRef.current) {
        // a prefetch for superseded input would hold mirror slots; drop it
        bgRef.current = null
        abortAll()
      }
      bgLast.current = undefined
      bgStartedAt.current = Date.now()
      const promise = buildRoute(text, {
        state: stateSel === 'auto' ? undefined : stateSel,
        // Remember the latest event even while nobody is listening: a build
        // adopted mid-lookup would otherwise show a blank line with a ticking
        // clock until that lookup finished, which reads as a hang.
        onProgress: (e) => {
          bgLast.current = e
          bgProgress.current?.(e)
        },
      })
      bgRef.current = { key: text, promise }
      setBgActive(true)
      promise.catch(() => undefined).finally(() => {
        if (bgRef.current?.key === text) setBgActive(false)
      })
    }, 1500)
    return () => window.clearTimeout(t)
  }, [input, phase, stateSel])

  const say = useCallback((msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast((t) => (t === msg ? undefined : t)), 3600)
  }, [])

  const preview = useMemo(() => {
    if (!input.trim()) return undefined
    try {
      const p = parseInput(input)
      return {
        format: p.format,
        legs: p.legs.length,
        state: p.stateHint,
        unparsed: p.instructions.filter((i) => i.problems.length > 0).length,
      }
    } catch {
      return undefined
    }
  }, [input])

  const stopDrive = useCallback(() => {
    simRef.current?.stop()
    gpsRef.current?.stop()
    setDrive('off')
    setNav(undefined)
    const mv = mapRef.current
    if (mv) {
      mv.setPuck(undefined)
      mv.setOffRouteLine(undefined, undefined)
      mv.exitFirstPerson()
      mv.fitRoute()
    }
  }, [])

  const build = useCallback(async () => {
    if (!input.trim() || phase === 'building') return
    stopDrive()
    const adopting = bgRef.current?.key === input
    setProgress(adopting ? bgLast.current : undefined)
    setPhase('building')
    setError(undefined)
    setResult(undefined)
    mapRef.current?.setRoute(undefined)
    try {
      let r: RouteResult
      if (adopting && bgRef.current) {
        // Adopt the build that started when the input was pasted, replaying
        // its latest progress so the panel is never blank while a long lookup
        // that began before the click finishes.
        bgProgress.current = (e) => setProgress(e)
        r = await bgRef.current.promise
      } else {
        if (bgRef.current) {
          // a stale prefetch for different input is holding mirror slots
          bgRef.current = null
          abortAll()
        }
        bgStartedAt.current = undefined
        r = await buildRoute(input, {
          state: stateSel === 'auto' ? undefined : stateSel,
          onProgress: (e) => setProgress(e),
        })
      }
      setResult(r)
      setPhase('ready')
      const mv = mapRef.current
      if (mv) {
        mv.setRoute(r)
        mv.fitRoute()
      }
    } catch (e) {
      bgRef.current = null
      if (e instanceof Error && e.name === 'CancelledError') {
        setPhase('idle')
        return
      }
      setPhase('failed')
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [input, phase, stateSel, stopDrive])

  const cancelBuild = useCallback(() => {
    bgRef.current = null
    bgProgress.current = null
    setBgActive(false)
    abortAll()
    setPhase('idle')
    setProgress(undefined)
  }, [])

  const startDrive = useCallback(
    (mode: 'sim' | 'gps') => {
      if (!result) return
      simRef.current?.stop()
      gpsRef.current?.stop()
      const controller = new NavController(result)
      navRef.current = controller
      const mv = mapRef.current!
      let lastT = performance.now()
      controller.onUpdate((s) => {
        setNav({ ...s })
        const now = performance.now()
        const dt = Math.max(80, Math.min(1200, now - lastT))
        lastT = now
        mv.setPuck(s.pos, s.heading)
        mv.setProgress(s.geomIndex)
        if (firstPersonRef.current) mv.followFirstPerson(s.pos, s.heading, dt)
        if (s.offRoute) mv.setOffRouteLine(s.pos, controller.nearestOnRoute(s.pos))
        else mv.setOffRouteLine(undefined, undefined)
        if (s.done && simRef.current?.running === false && drive === 'sim') {
          say('Arrived. End of route.')
        }
      })
      if (mode === 'sim') {
        const sim = new Simulator(controller, result)
        sim.multiplier = simSpeed
        simRef.current = sim
        sim.start(0)
        if (import.meta.env.DEV) {
          ;(window as unknown as Record<string, unknown>).__sim = sim
          ;(window as unknown as Record<string, unknown>).__nav = controller
        }
      } else {
        const gps = new GpsSource()
        gpsRef.current = gps
        gps.start(controller, (msg) => {
          say(msg)
          setDrive('off')
        })
      }
      setDrive(mode)
    },
    [result, simSpeed, drive, say],
  )

  // keep latest firstPerson in a ref for the nav listener
  const firstPersonRef = useRef(firstPerson)
  useEffect(() => {
    firstPersonRef.current = firstPerson
    if (!firstPerson) mapRef.current?.exitFirstPerson()
  }, [firstPerson])

  useEffect(() => {
    if (simRef.current) simRef.current.multiplier = simSpeed
  }, [simSpeed])
  useEffect(() => {
    if (simRef.current) simRef.current.wander = wander
  }, [wander])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && drive !== 'off') stopDrive()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drive, stopDrive])

  const reroute = useCallback(async () => {
    const controller = navRef.current
    const s = controller?.state
    if (!result || !controller || !s) return
    const rest = result.waypoints
      .slice(s.nextWaypointIdx ?? result.waypoints.length - 1)
      .filter((w) => w.status === 'ok' || w.status === 'approx')
    if (!rest.length) return
    say('Rerouting from your position…')
    try {
      const osrm = await routeChain([{ pos: s.pos }, ...rest.map((w) => ({ pos: w.pos }))])
      const latlngs = osrm.geometry.map(([lng, lat]) => ({ lat, lng }))
      const cumulative: number[] = [0]
      for (let i = 1; i < latlngs.length; i++) {
        const a = latlngs[i - 1], b = latlngs[i]
        const kx = Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180) * 111320
        cumulative.push(cumulative[i - 1] + Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * 110540))
      }
      const r2: RouteResult = { ...result, geometry: osrm.geometry, cumulative, totalMeters: osrm.distance, durationSec: osrm.duration, legGeometry: [] }
      setResult(r2)
      mapRef.current?.setRoute(r2, false)
      const wasSim = drive === 'sim'
      simRef.current?.stop()
      const c2 = new NavController(r2)
      navRef.current = c2
      c2.onUpdate((st) => {
        setNav({ ...st })
        const mv = mapRef.current!
        mv.setPuck(st.pos, st.heading)
        mv.setProgress(st.geomIndex)
        if (firstPersonRef.current) mv.followFirstPerson(st.pos, st.heading, 120)
        if (st.offRoute) mv.setOffRouteLine(st.pos, c2.nearestOnRoute(st.pos))
        else mv.setOffRouteLine(undefined, undefined)
      })
      if (wasSim) {
        setWander(false)
        const sim = new Simulator(c2, r2)
        sim.multiplier = simSpeed
        simRef.current = sim
        sim.start(0)
      }
      say('Back on a drivable path.')
    } catch {
      say('Reroute failed. Check the connection.')
    }
  }, [result, drive, simSpeed, say])

  const onFile = useCallback((f: File | undefined) => {
    if (!f) return
    f.text().then((t) => setInput(t))
  }, [])

  const legRows = result?.legReports ?? []
  const okLegs = legRows.filter((r) => r.status === 'ok').length
  const claimed = result?.parsed.claimedTotalMiles

  return (
    <div className="app">
      <header className="topbar">
        <span className="wordmark">Route navigator</span>
        {result && <span className="statebadge">{placeName(result.state).toUpperCase()}</span>}
        <span className="spacer" />
        {drive === 'off' && result && (
          <>
            <button className="btn small" onClick={() => startDrive('sim')}>Simulate drive</button>
            <button className="btn small" onClick={() => startDrive('gps')}>Follow GPS</button>
          </>
        )}
        {drive !== 'off' && (
          <button className="btn small" onClick={stopDrive}>Exit drive</button>
        )}
        <button
          className="btn small ghost"
          onClick={() => setBasemap((b) => (b === 'dark' ? 'light' : 'dark'))}
          aria-label="Switch basemap"
        >
          {basemap === 'dark' ? 'Light map' : 'Dark map'}
        </button>
      </header>

      <div className="main">
        <aside className="panel" style={drive !== 'off' ? { display: 'none' } : undefined}>
          <div className="panel-scroll">
            <section>
              <p className="h">Route instructions</p>
              <textarea
                className={'input' + (dragOver ? ' dragover' : '')}
                placeholder={'Paste a turns JSON or a TxDMV permit route table…\n\n{ "turns": ["Border Start: Oklahoma - I-40", "I-40 W (91 mi)", …] }'}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); onFile(e.dataTransfer.files[0]) }}
                spellCheck={false}
              />
              <div className="row" style={{ marginTop: 8 }}>
                {phase === 'building' ? (
                  <button className="btn" onClick={cancelBuild}>Cancel</button>
                ) : (
                  <button className="btn primary" onClick={build} disabled={!input.trim()}>
                    Build route
                  </button>
                )}
                <button className="btn" onClick={() => fileRef.current?.click()} disabled={phase === 'building'}>
                  Load file
                </button>
                <input ref={fileRef} type="file" accept=".json,.txt" hidden onChange={(e) => onFile(e.target.files?.[0] ?? undefined)} />
                <span className="spacer" style={{ flex: 1 }} />
                <select className="sel" value={stateSel} onChange={(e) => setStateSel(e.target.value)} aria-label="State">
                  <option value="auto">State: auto</option>
                  {STATES.map((s) => (
                    <option key={s.code} value={s.code}>{s.code}</option>
                  ))}
                </select>
              </div>
              <div className="row" style={{ marginTop: 8 }}>
                <select
                  className="sel" style={{ width: '100%' }} value=""
                  onChange={(e) => {
                    const s = SAMPLES[Number(e.target.value)]
                    if (s) setInput(s.text)
                  }}
                  aria-label="Load a sample"
                >
                  <option value="" disabled>Load a sample…</option>
                  {SAMPLES.map((s, i) => (
                    <option key={s.label} value={i}>{s.label}</option>
                  ))}
                </select>
              </div>
              {preview && (
                <div className="chips" style={{ marginTop: 10 }}>
                  <span className="chip on">{preview.format === 'permit-text' ? 'permit table' : preview.format === 'turns-json' ? 'turns JSON' : 'plain lines'}</span>
                  <span className="chip">{preview.legs} legs</span>
                  {preview.state && <span className="chip">{preview.state}</span>}
                  {preview.unparsed > 0 && <span className="chip">{preview.unparsed} lines not understood</span>}
                  {bgActive && phase === 'idle' && <span className="chip on">prefetching roads…</span>}
                </div>
              )}
            </section>

            {phase === 'building' && (
              <section className="progress" aria-live="polite">
                <div className="progress-bar"><i style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} /></div>
                <div className="progress-msg">
                  {progress?.message ?? 'Starting…'}
                  {elapsed > 3 && <span className="elapsed"> · {elapsed}s</span>}
                </div>
                {mirrors.total > 0 && mirrors.live < mirrors.total && (
                  <div className="note">
                    {mirrors.live === 0
                      ? 'None of the public OpenStreetMap servers are answering right now.'
                      : `Only ${mirrors.live} of ${mirrors.total} public OpenStreetMap servers ${mirrors.live === 1 ? 'is' : 'are'} reachable right now.`}{' '}
                    This is the shared free infrastructure, not this machine — everyone sees it. The
                    build continues on what is left, and everything fetched is cached.
                  </div>
                )}
                {elapsed > 25 && mirrors.live === mirrors.total && (
                  <div className="note">
                    Public OpenStreetMap servers are answering slowly. Everything fetched is cached, so
                    a retry picks up where this left off.
                  </div>
                )}
              </section>
            )}

            {phase === 'failed' && error && (
              <section className="notes">
                <div className="note bad">{error}</div>
              </section>
            )}

            {phase === 'idle' && (
              <section className="empty">
                This tool turns written route instructions into a drivable line on the map.
                It reads both permit dialects, the coarse{' '}
                <code>"I-70 (58.3 mi)"</code> turns list and the full TxDMV route table,
                finds every junction on OpenStreetMap, and routes the chain road by road.
                Distances in the source are hints: a wrong figure flags a leg, it never breaks the route.
              </section>
            )}

            {result && phase === 'ready' && (
              <>
                <section>
                  <p className="h">Route</p>
                  <div className="stats">
                    <div className="stat">
                      <b>{(result.totalMeters / MI).toFixed(0)}<em> mi</em></b>
                      <span>routed{claimed ? ` / ${claimed.toFixed(0)} claimed` : ''}</span>
                    </div>
                    <div className="stat">
                      <b>{(result.durationSec / 3600).toFixed(1)}<em> h</em></b>
                      <span>drive time</span>
                    </div>
                    <div className="stat">
                      <b>{okLegs}<em>/{legRows.length}</em></b>
                      <span>legs matched</span>
                    </div>
                  </div>
                </section>

                <section>
                  <p className="h">Legs</p>
                  <div className="legs">
                    {legRows.map((r) => {
                      const slice = result.legGeometry.filter((g) => g.legIndex === r.leg.index)
                      const dot = r.status === 'ok' ? 'ok' : r.status === 'warn' ? 'warn' : r.status === 'failed' ? 'bad' : 'mute'
                      return (
                        <button
                          key={r.leg.index}
                          className="legrow"
                          onClick={() => {
                            if (slice.length) mapRef.current?.fitSlice(slice[0].from, slice[slice.length - 1].to)
                          }}
                        >
                          <span className={`dot ${dot}`} />
                          <span className="name">
                            {r.leg.label}
                            {(r.note || r.leg.annotations.length > 0) && (
                              <small>{[r.note, ...r.leg.annotations].filter(Boolean).join(' · ')}</small>
                            )}
                          </span>
                          <span className="nums">
                            {r.claimedMiles > 0 ? `${r.claimedMiles.toFixed(1)} → ` : ''}
                            <b>{r.routedMiles !== undefined ? r.routedMiles.toFixed(1) : '—'}</b> mi
                            {r.refMatch !== undefined ? ` ${Math.round(r.refMatch * 100)}%` : ''}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </section>

                {(result.warnings.length > 0 || result.errors.length > 0) && (
                  <section className="notes">
                    <p className="h">Flags</p>
                    {result.errors.map((e, i) => <div key={`e${i}`} className="note bad">{e}</div>)}
                    {result.warnings.map((w, i) => <div key={`w${i}`} className="note">{w}</div>)}
                  </section>
                )}
              </>
            )}
          </div>
        </aside>

        <div className="mapwrap">
          <div ref={mapDiv} style={{ position: 'absolute', inset: 0 }} />

          {drive !== 'off' && nav && (
            <>
              {nav.nextLabel && nav.distToNextM !== undefined && (
                <div className="hud-next">
                  <div className="dist">{fmtMi(nav.distToNextM)} mi</div>
                  <div className="what">{nav.nextLabel}</div>
                  <div className="then">{fmtMi(nav.remainingM)} mi to destination</div>
                </div>
              )}
              <div className="hud-bottom">
                <div className="speed">
                  {Math.round(nav.speedMps * 2.23694)}
                  <em>mph</em>
                </div>
                <div className="hud-progress">
                  <div className="track"><i style={{ width: `${Math.min(100, (nav.alongM / Math.max(1, result?.totalMeters ?? 1)) * 100)}%` }} /></div>
                  <div className="lbl">
                    <span>{fmtMi(nav.alongM)} mi</span>
                    <span>{fmtMi(nav.remainingM)} mi left</span>
                  </div>
                </div>
                {drive === 'sim' && (
                  <div className="simbox">
                    <input
                      type="range" min={1} max={60} value={simSpeed}
                      onChange={(e) => setSimSpeed(Number(e.target.value))}
                      aria-label="Simulation speed"
                    />
                    <span className="x">×{simSpeed}</span>
                    <button className={'btn small' + (wander ? ' primary' : '')} onClick={() => setWander((w) => !w)}>
                      {wander ? 'Return' : 'Drift off'}
                    </button>
                  </div>
                )}
                <button className="btn small" onClick={() => setFirstPerson((f) => !f)}>
                  {firstPerson ? 'Overview' : 'First-person'}
                </button>
              </div>
              {nav.offRoute && (
                <div className="offroute" role="alert">
                  Off route: {fmtMi(nav.offRouteM)} mi from the line
                  <button className="btn small" onClick={reroute}>Reroute</button>
                </div>
              )}
            </>
          )}

          {toast && <div className="toast">{toast}</div>}
        </div>
      </div>
    </div>
  )
}
