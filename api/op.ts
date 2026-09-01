/**
 * Same-origin Overpass proxy.
 *
 * The page sends the raw Overpass QL as text/plain; this function forwards it
 * to the chosen public instance and streams the answer back. Routing all map
 * data through the app's own domain means a client network only has to reach
 * the site itself — no third-party hosts to block, no CORS in the browser at
 * all. The client keeps its own mirror rotation: ?u=N picks the upstream, so
 * the browser-side breaker and health probes drive failover exactly as they
 * do against the instances directly.
 *
 * The app still works without this function (a static host returns 404, the
 * health check fails in a moment, and the browser falls back to talking to
 * the public instances directly).
 */

// Server-side upstream set. It differs from the browser's direct list on
// purpose: openstreetmap.fr's filter only admits browser-like traffic, so it
// stays a direct-path mirror, while kumi.systems sends no CORS headers so
// browsers can never use it directly — but a server can.
const UPSTREAMS = [
  'https://overpass-api.de/api/interpreter',
  'https://z.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
// Silent second try when the picked upstream is unreachable at the network
// level (its answers, including errors, pass through untouched).
const EXTRA = 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'
const UA = 'route-navigator/1.0 (oversize permit routing; proxy)'

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' })
    return
  }
  const body = typeof req.body === 'string' ? req.body : ''
  if (body === 'health') {
    res.status(200).json({ ok: true })
    return
  }
  if (!body || body.length > 200_000) {
    res.status(400).json({ error: 'missing or oversized query' })
    return
  }
  const u = Math.min(UPSTREAMS.length - 1, Math.max(0, Number(req.query?.u ?? 0) || 0))
  for (const target of UPSTREAMS[u] === EXTRA ? [EXTRA] : [UPSTREAMS[u], EXTRA]) {
    try {
      const upstream = await fetch(target, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(body),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        signal: AbortSignal.timeout(140_000),
      })
      const text = await upstream.text()
      // Pass status through untouched: the client's breaker reads 429/5xx.
      res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text)
      return
    } catch {
      // network-level failure only — try the extra upstream, then report
    }
  }
  res.status(504).json({ error: 'all upstreams unreachable' })
}
