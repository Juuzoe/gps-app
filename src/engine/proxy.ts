/**
 * Same-origin data proxy detection.
 *
 * When the app is hosted somewhere that runs api/op.ts (Vercel), all map data
 * flows through the app's own domain: a client network that can load the page
 * can run the app, whatever else it blocks, and the browser never makes a
 * cross-origin request. On a plain static host the health check fails within
 * a moment and everything talks to the public instances directly, as before.
 *
 * Checked once per session, memoized, answered in at most ~2.5s.
 */

const IN_BROWSER = typeof document !== 'undefined'
let memo: Promise<boolean> | undefined

export function proxyHealthy(): Promise<boolean> {
  if (!IN_BROWSER) return Promise.resolve(false)
  memo ??= (async () => {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2500)
      const res = await fetch('/api/op', {
        method: 'POST',
        body: 'health',
        headers: { 'Content-Type': 'text/plain' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) return false
      const json = await res.json().catch(() => null)
      return !!json?.ok
    } catch {
      return false
    }
  })()
  return memo
}
