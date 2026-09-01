/**
 * Serve the production bundle WITH the api/ functions, Vercel-style, for local
 * end-to-end testing of the same-origin proxy: node scripts/serve-prod.mjs
 * (run `npx vite build` first). Not part of the deployment.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const opMod = await import('../api/op.ts')
const rtMod = await import('../api/rt.ts')
const PORT = 5176
const DIST = new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.svg': 'image/svg+xml' }

function shim(req, res, raw) {
  const url = new URL(req.url, 'http://localhost')
  const q = Object.fromEntries(url.searchParams)
  const vreq = { method: req.method, url: req.url, query: q, body: raw }
  const vres = {
    _status: 200,
    status(c) { this._status = c; return this },
    setHeader(k, v) { res.setHeader(k, v); return this },
    json(o) { res.writeHead(this._status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)) },
    send(t) { res.writeHead(this._status); res.end(t) },
  }
  return { vreq, vres }
}

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname
  try {
    if (path === '/api/op' || path === '/api/rt') {
      let raw = ''
      for await (const c of req) raw += c
      const { vreq, vres } = shim(req, res, raw)
      await (path === '/api/op' ? opMod.default : rtMod.default)(vreq, vres)
      return
    }
    const file = path === '/' ? '/index.html' : path
    const data = await readFile(join(DIST, file))
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}).listen(PORT, () => console.log(`prod+api on http://localhost:${PORT}`))
