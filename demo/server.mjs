/**
 * 零依赖的本地测试服务器：既给 demo 页面提供接口，也承载自动化验证页。
 *
 * 之所以要有个真服务器而不是打桩 fetch，是因为要验证的东西恰恰在网络层：
 * 状态码、响应头、流式分块、以及「伪造模式到底有没有真的发出请求」。
 * 这些用 mock 是测不出来的。
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.PORT ?? 8787)

/** 每个路径被真实打到过几次。「伪造模式不发请求」这条就靠它证伪。 */
const hits = new Map()

/** 各验证套件最近一次交上来的结果，按套件名分开存。 */
const resultsBySuite = new Map()

function countHit(pathname) {
  hits.set(pathname, (hits.get(pathname) ?? 0) + 1)
}

function json(res, body, init = {}) {
  res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...init,
  })
  res.end(JSON.stringify(body))
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function serveFile(res, filePath) {
  try {
    const body = await readFile(filePath)
    res.writeHead(200, {
      'content-type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  const pathname = url.pathname
  countHit(pathname)

  // ── 自动化验证页用的收集口 ──
  // 结果留在内存里等验证脚本轮询，而不是收到就退出：这样即使浏览器那边的
  // 页面卡住或崩了，也还能看到已经跑出来的部分和失败原因。
  if (pathname === '/__results' && req.method === 'POST') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const { suite, results } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    resultsBySuite.set(suite, results)
    report(suite, results)
    res.writeHead(204).end()
    return
  }

  if (pathname === '/__results') {
    const suite = url.searchParams.get('suite')
    const results = resultsBySuite.get(suite)
    if (!results) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('null')
      return
    }
    json(res, results)
    return
  }

  if (pathname === '/__hits') {
    json(res, Object.fromEntries(hits))
    return
  }

  if (pathname === '/__reset') {
    hits.clear()
    res.writeHead(204).end()
    return
  }

  // ── 被测接口 ──
  if (pathname === '/api/plain') return json(res, { ok: true })
  if (pathname === '/api/status') return json(res, { ok: true, from: 'real' })
  if (pathname === '/api/body') return json(res, { ok: true, from: 'real' })
  if (pathname === '/api/merge') return json(res, { ok: true, data: [1, 2, 3] })
  if (pathname === '/api/delay') return json(res, { ok: true })
  if (pathname === '/api/neterr') return json(res, { ok: true })
  if (pathname === '/api/timeout') return json(res, { ok: true })
  if (pathname === '/api/mock') return json(res, { ok: true, from: 'real' })
  if (pathname === '/api/xhr') return json(res, { ok: true, data: [1, 2, 3] })

  if (pathname === '/api/headers') {
    json(res, { ok: true }, { 'x-drop': 'gone', 'x-keep': 'yes' })
    return
  }

  // 分两块发、中间隔 500ms。改写时若把 body 缓冲了，第一块就出不来这么快。
  // 回显请求体，用来验「请求体有没有被正确抓到 / 转发」。
  if (pathname === '/api/echo') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const raw = Buffer.concat(chunks).toString('utf8')
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* 不是 JSON 就只回原文 */
    }
    return json(res, { method: req.method, received: parsed ?? raw, echoedAt: Date.now() })
  }

  if (pathname === '/api/stream') {
    res.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.write('first\n')
    await sleep(500)
    res.end('second\n')
    return
  }

  // ── 静态文件 ──
  if (pathname.startsWith('/dist/')) {
    const target = join(root, normalize(pathname))
    if (!target.startsWith(join(root, 'dist'))) {
      res.writeHead(403).end()
      return
    }
    return serveFile(res, target)
  }

  const STATIC = {
    '/': 'demo/index.html',
    '/index.html': 'demo/index.html',
    '/harness.html': 'demo/harness.html',
    '/harness.js': 'demo/harness.js',
    '/panel-smoke.html': 'demo/panel-smoke.html',
    '/panel-smoke.js': 'demo/panel-smoke.js',
    '/panel-preview.html': 'demo/panel-preview.html',
    '/chrome-stub.js': 'demo/chrome-stub.js',
  }
  const relative = STATIC[pathname]
  if (relative) return serveFile(res, join(root, relative))

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('404')
})

function report(suite, results) {
  const failed = results.filter((item) => !item.ok)
  console.log(`\n── ${suite} ──`)
  for (const item of results) {
    console.log(`${item.ok ? '  ✓' : '  ✗'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
}

server.listen(port, () => {
  console.log(`[demo] http://localhost:${port}`)
  console.log(`[demo] harness: http://localhost:${port}/harness.html`)
})
