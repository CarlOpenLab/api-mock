/**
 * 端到端验证：起本地服务器 + 无头 Chrome 跑 demo/harness.html，等结果回来。
 *
 * 依赖构建产物，所以先跑 build。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const port = process.env.PORT ?? '8787'
const HARD_TIMEOUT_MS = 60_000

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (!chrome) {
  console.error('找不到 Chrome/Chromium。用 CHROME_PATH 环境变量指定可执行文件。')
  process.exit(2)
}

if (!existsSync(resolve(root, 'dist/content/inject.js'))) {
  console.error('dist/ 还没构建。先跑 pnpm build。')
  process.exit(2)
}

const server = spawn(process.execPath, ['demo/server.mjs'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, PORT: port },
})

let serverOutput = ''
server.stdout.on('data', (chunk) => {
  serverOutput += chunk.toString()
  process.stdout.write(chunk)
})

function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000
    const tick = setInterval(() => {
      if (serverOutput.includes('harness:')) {
        clearInterval(tick)
        resolve()
      } else if (Date.now() > deadline) {
        clearInterval(tick)
        reject(new Error('服务器 10s 内没起来'))
      }
    }, 50)
  })
}

/** 当前正在跑的浏览器进程，便于在超时兜底里一并清掉。 */
let activeBrowser = null

/**
 * 删临时 profile。刚 kill 掉的 Chrome 还在收尾，删不掉是常态，
 * 别让它把整个验证流程带崩。
 */
function removeProfile(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch {
    /* 临时目录留着也无所谓 */
  }
}

function cleanup() {
  activeBrowser?.kill('SIGKILL')
  server.kill('SIGKILL')
}

/** 一个套件 = 一个页面 = 一次浏览器进程。 */
const SUITES = [
  { name: 'harness', page: 'harness.html', title: '改写行为（真实浏览器 + 真实网络）' },
  { name: 'panel', page: 'panel-smoke.html', title: '面板 UI 渲染与交互' },
]

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// 兜底：任何一步卡死都别让脚本永远挂着。
const bail = setTimeout(() => {
  console.error(`\n验证超时（${HARD_TIMEOUT_MS / 1000}s），强制结束。`)
  cleanup()
  process.exit(1)
}, HARD_TIMEOUT_MS)

/**
 * 轮询而不是等浏览器退出 —— 页面无论卡住还是崩掉，
 * 都能拿到已经跑出来的部分，而不是一片沉默。
 */
async function pollResults(suite, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://localhost:${port}/__results?suite=${encodeURIComponent(suite)}`,
      )
      if (response.ok) return await response.json()
    } catch {
      /* 服务器还没起来，继续等 */
    }
    await sleep(250)
  }
  return null
}

async function runSuite(suite, timeoutMs) {
  console.log(`\n▶ ${suite.title}`)

  const profile = mkdtempSync(resolve(tmpdir(), 'api-mock-verify-'))
  const browser = spawn(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      `--user-data-dir=${profile}`,
      `http://localhost:${port}/${suite.page}`,
    ],
    { stdio: 'ignore' },
  )
  activeBrowser = browser

  try {
    return await pollResults(suite.name, timeoutMs)
  } finally {
    browser.kill('SIGKILL')
    activeBrowser = null
    // 等它真的退出，否则临时目录删不干净。
    await new Promise((done) => {
      if (browser.exitCode !== null || browser.signalCode !== null) return done()
      browser.once('exit', done)
      setTimeout(done, 2000)
    })
    removeProfile(profile)
  }
}

/**
 * manifest 里声明的每个路径都必须真的存在。
 *
 * 扩展最典型的翻车方式就是这里：改了构建出口文件名，manifest 没跟着改，
 * 装上之后一片安静 —— 不报错，就是什么都不发生。
 */
function preflightManifest() {
  const manifest = JSON.parse(readFileSync(resolve(root, 'dist/manifest.json'), 'utf8'))
  const problems = []

  const referenced = []
  if (manifest.devtools_page) referenced.push(manifest.devtools_page)
  if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker)
  for (const script of manifest.content_scripts ?? []) {
    referenced.push(...(script.js ?? []), ...(script.css ?? []))
  }
  for (const entry of manifest.web_accessible_resources ?? []) {
    referenced.push(...(entry.resources ?? []))
  }

  for (const path of referenced) {
    if (!existsSync(resolve(root, 'dist', path))) problems.push(`manifest 指向的文件不存在：${path}`)
  }

  if (manifest.manifest_version !== 3) problems.push('manifest_version 必须是 3')
  if (!manifest.devtools_page) problems.push('缺少 devtools_page —— 面板不会有入口')

  // MAIN world 的 content script 是自造轮子改 fetch 的前提，缺了整套改写都不生效。
  const hasMainWorld = (manifest.content_scripts ?? []).some(
    (script) => script.world === 'MAIN' && (script.js ?? []).some((file) => file.includes('inject')),
  )
  if (!hasMainWorld) problems.push('content_scripts 里没有 world: "MAIN" 的 inject 脚本')

  // content script 是经典脚本，混进 import 会在加载时静默失败。
  for (const script of manifest.content_scripts ?? []) {
    for (const file of script.js ?? []) {
      const source = readFileSync(resolve(root, 'dist', file), 'utf8')
      if (/^\s*(import|export)\s/m.test(source)) {
        problems.push(`content script 含有 ESM 语句，会被浏览器拒绝：${file}`)
      }
    }
  }

  return problems
}

try {
  await waitForServer()

  console.log('\n▶ manifest 与产物一致性')
  const problems = preflightManifest()
  if (problems.length) {
    for (const problem of problems) console.error(`  ✗ ${problem}`)
    console.error('\nmanifest 预检未通过，后续验证没有意义，先停下。')
    cleanup()
    process.exit(1)
  }
  console.log('  ✓ manifest 引用的文件齐全，content script 都是经典脚本')

  const summary = []
  let exitCode = 0

  for (const suite of SUITES) {
    // 面板冒烟要读构建产物里的 panel.js，所以每个套件都重新加载一次。
    const results = await runSuite(suite, 40_000)
    if (!results) {
      console.error(`\n套件「${suite.name}」没有交回结果。`)
      exitCode = 1
      break
    }
    const failed = results.filter((item) => !item.ok)
    summary.push({ suite: suite.name, total: results.length, failed: failed.length })
    if (failed.length) exitCode = 1
  }

  clearTimeout(bail)
  console.log('\n══ 汇总 ══')
  for (const item of summary) {
    console.log(
      `${item.failed ? '✗' : '✓'} ${item.suite}: ${item.total - item.failed}/${item.total}`,
    )
  }

  cleanup()
  process.exit(exitCode)
} catch (error) {
  clearTimeout(bail)
  console.error(error instanceof Error ? error.message : String(error))
  cleanup()
  process.exit(1)
}
