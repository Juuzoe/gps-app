/**
 * Route harness: runs the engine on fixture inputs and prints a scorecard.
 *
 *   npm run test:routes            — all fixtures
 *   npm run test:routes -- tx1     — fixtures whose filename contains "tx1"
 *
 * Network responses cache to .cache/ so reruns are fast and gentle on the
 * public Overpass/OSRM instances.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { buildRoute } from '../src/engine/engine'
import { setCache, type Cache } from '../src/engine/overpass'
import { MI } from '../src/engine/geo'

const CACHE_DIR = path.join(process.cwd(), '.cache')
fs.mkdirSync(CACHE_DIR, { recursive: true })

class DiskCache implements Cache {
  private file(key: string) {
    return path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json')
  }
  async get(key: string) {
    try {
      return fs.readFileSync(this.file(key), 'utf8')
    } catch {
      return undefined
    }
  }
  async set(key: string, value: string) {
    fs.writeFileSync(this.file(key), value)
  }
}
setCache(new DiskCache())

const filter = process.argv[2]?.toLowerCase()
const roots = ['fixtures/own', 'fixtures/actual']
const files = roots
  .flatMap((r) => (fs.existsSync(r) ? fs.readdirSync(r).map((f) => path.join(r, f)) : []))
  .filter((f) => /\.(json|txt)$/.test(f))
  .filter((f) => !filter || f.toLowerCase().includes(filter))

const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n))

let failures = 0

for (const file of files) {
  const name = path.basename(file)
  const expectError = name.includes('err')
  const input = fs.readFileSync(file, 'utf8')
  console.log(`\n━━━ ${file} ${'━'.repeat(Math.max(1, 58 - file.length))}`)
  const t0 = Date.now()
  try {
    const result = await buildRoute(input, {
      onProgress: (e) => {
        if (e.phase === 'fetch' || e.phase === 'resolve') process.stdout.write(`  · ${e.message}\r`)
      },
    })
    process.stdout.write(' '.repeat(78) + '\r')
    const claimed = result.parsed.claimedTotalMiles
    const routed = result.totalMeters / MI
    console.log(
      `  state=${result.state}  format=${result.parsed.format}  legs=${result.parsed.legs.length}` +
        `  waypoints=${result.waypoints.length}  ${(Date.now() - t0) / 1000 | 0}s`,
    )
    console.log(
      `  routed ${routed.toFixed(1)} mi in ${(result.durationSec / 3600).toFixed(1)} h` +
        (claimed ? `  (claimed ${claimed.toFixed(1)} mi, Δ ${(routed - claimed).toFixed(1)})` : ''),
    )
    console.log('  leg  status  match  claimed  routed   road')
    for (const r of result.legReports) {
      const badge = r.status === 'ok' ? ' ok ' : r.status === 'warn' ? 'WARN' : r.status.toUpperCase()
      console.log(
        `  ${String(r.leg.index).padStart(3)}  ${badge}   ${
          r.refMatch === undefined ? '  — ' : (r.refMatch * 100).toFixed(0).padStart(3) + '%'
        }  ${r.claimedMiles.toFixed(1).padStart(7)}  ${(r.routedMiles ?? 0).toFixed(1).padStart(6)}   ${pad(
          r.leg.label,
          34,
        )}${r.note ? ' · ' + r.note : ''}`,
      )
    }
    const wpBad = result.waypoints.filter((w) => w.status === 'failed' || w.status === 'skipped')
    for (const w of wpBad) console.log(`  ✗ waypoint: ${w.label} — ${w.note ?? w.status}`)
    for (const w of result.warnings) console.log(`  ⚠ ${w}`)
    for (const e of result.errors) console.log(`  ✗ ${e}`)
    const badLegs = result.legReports.filter(
      (r) =>
        r.claimedMiles > 2 &&
        (r.status === 'failed' || r.status === 'skipped' || (r.status === 'warn' && (r.refMatch ?? 1) < 0.45)),
    )
    const structuralBad = result.errors.length > 0 || badLegs.length > 0
    // "err" fixtures must either fail cleanly or degrade visibly: flagged
    // waypoints/warnings count — silently swallowing a bad road would not.
    const degraded = structuralBad || wpBad.length > 0
    if (expectError && !degraded) {
      console.log('  ✘ EXPECTED problems, but the route came out clean')
      failures++
    } else if (!expectError && structuralBad) {
      console.log(`  ✘ ROUTE HAS PROBLEMS (${badLegs.length} flagged legs, ${result.errors.length} errors)`)
      failures++
    } else {
      console.log(expectError ? '  ✔ degraded gracefully, as expected' : '  ✔ clean')
    }
    // GeoJSON dump for eyeballing in geojson.io or the app
    const out = {
      type: 'Feature',
      properties: { name, routedMiles: +routed.toFixed(1) },
      geometry: { type: 'LineString', coordinates: result.geometry },
    }
    fs.mkdirSync('fixtures/out', { recursive: true })
    fs.writeFileSync(`fixtures/out/${name.replace(/\.\w+$/, '')}.geojson`, JSON.stringify(out))
  } catch (e) {
    process.stdout.write(' '.repeat(78) + '\r')
    if (expectError) {
      console.log(`  ✔ failed as expected: ${e instanceof Error ? e.message : e}`)
    } else {
      console.log(`  ✘ FAILED: ${e instanceof Error ? e.stack ?? e.message : e}`)
      failures++
    }
  }
}

console.log(`\n${files.length} fixtures, ${failures} unexpected outcomes`)
process.exit(failures ? 1 : 0)
