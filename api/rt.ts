/**
 * Same-origin OSRM proxy. See api/op.ts for why proxying exists.
 *
 * GET /api/rt?u=N&p=<encoded "/route/v1/driving/...">. The path prefix is
 * enforced so this cannot be used as an open proxy to arbitrary URLs.
 */

const UPSTREAMS = ['https://routing.openstreetmap.de/routed-car', 'https://router.project-osrm.org']
const UA = 'route-navigator/1.0 (oversize permit routing; proxy)'

export default async function handler(req: any, res: any) {
  const p = String(req.query?.p ?? '')
  if (!p.startsWith('/route/v1/driving/') || p.length > 40_000) {
    res.status(400).json({ error: 'bad path' })
    return
  }
  const u = Math.min(UPSTREAMS.length - 1, Math.max(0, Number(req.query?.u ?? 0) || 0))
  try {
    const upstream = await fetch(UPSTREAMS[u] + p, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(55_000),
    })
    const text = await upstream.text()
    res.status(upstream.status).setHeader('Content-Type', 'application/json').send(text)
  } catch {
    res.status(504).json({ error: 'upstream unreachable' })
  }
}
