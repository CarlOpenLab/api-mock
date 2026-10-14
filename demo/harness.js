/**
 * 端到端验证：在真实浏览器里，对构建产物跑一遍真实的 fetch / XHR。
 *
 * 单测覆盖了「决策」这类纯逻辑，但下面这些东西只有真浏览器 + 真网络能证：
 *   - window.fetch 被替换后，应用侧到底收到了什么
 *   - new Response(real.body) 是不是真的保住了流（第一块能立刻出来）
 *   - 伪造模式下请求到底有没有溜出去（靠服务端计数）
 *   - XHR 的生命周期事件、responseType 语义、abort 时序
 *   - hook → postMessage → bridge → Port 这条上报链路通不通
 */

const MSG_KEY = '__api_mock__'
const ORIGIN = location.origin
const harness = window.__harness
const results = []

function record(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : String(detail ?? '') })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function rule(id, path, action, method = 'ANY') {
  return {
    id,
    name: id,
    enabled: true,
    createdAt: Date.now(),
    match: { patternType: 'wildcard', urlPattern: `${ORIGIN}${path}`, method },
    action: { mode: 'rewrite', bodyMode: 'replace', failure: 'none', ...action },
  }
}

const RULES = [
  // 只改状态码、不碰 body —— 这条专门用来验流式透传
  rule('r-status', '/api/status', { status: 503 }),
  rule('r-body', '/api/body', { body: { text: '{"replaced":true,"from":"mock"}' } }),
  rule('r-merge', '/api/merge', { bodyMode: 'merge-json', body: { text: '{"data":[],"patched":1}' } }),
  rule('r-headers', '/api/headers', { headers: { set: { 'x-mock': 'yes' }, remove: ['x-drop'] } }),
  rule('r-delay', '/api/delay', { delayMs: 400 }),
  rule('r-neterr', '/api/neterr', { failure: 'network-error' }),
  rule('r-timeout', '/api/timeout', { failure: 'timeout', delayMs: 100 }),
  rule('r-mock', '/api/mock', {
    mode: 'mock',
    status: 418,
    body: { text: '{"i":"teapot"}' },
    headers: { set: { 'content-type': 'application/json' } },
  }),
  rule('r-stream', '/api/stream', { status: 500 }),
  rule('r-xhr', '/api/xhr', {
    status: 202,
    body: { text: '{"from":"mock"}' },
    headers: { set: { 'x-xhr': 'yes' } },
  }),
  rule('r-xhrmock', '/api/xhrmock', { mode: 'mock', status: 203, body: { text: '{"from":"mock"}' } }),
  rule('r-xhrabort', '/api/xhrabort', { delayMs: 2000 }),
  rule('r-xhrerr', '/api/xhrerr', { failure: 'network-error' }),
]

/** 扮演 background 下发一份新配置，并等它走完 postMessage 的那几跳。 */
async function setConfig(config) {
  harness.config = config
  harness.port?.__pushConfig(config)
  await sleep(80)
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}

/* ── fetch 路径 ─────────────────────────────────────────── */

async function testPassthrough() {
  const res = await fetch('/api/plain')
  const body = await res.json()
  record('未命中规则：原样放行', res.status === 200 && body.ok === true && body.from === undefined)
}

async function testStatusOnly() {
  const res = await fetch('/api/status')
  const body = await res.json()
  record('只改状态码：状态码变了', res.status === 503, String(res.status))
  record('只改状态码：body 保持真实', body.from === 'real', JSON.stringify(body))
  record('只改状态码：response.url 被补回原值', res.url.endsWith('/api/status'), res.url)
  record('只改状态码：response.ok 跟着状态码走', res.ok === false, String(res.ok))
}

async function testBodyReplace() {
  const body = await fetch('/api/body').then((res) => res.json())
  record('整段替换 body', body.replaced === true && body.from === 'mock', JSON.stringify(body))
}

async function testBodyMerge() {
  const body = await fetch('/api/merge').then((res) => res.json())
  record(
    '合并 JSON：真实字段保留、写到的字段被覆盖、新增字段加上',
    body.ok === true && Array.isArray(body.data) && body.data.length === 0 && body.patched === 1,
    JSON.stringify(body),
  )
}

async function testHeaders() {
  const res = await fetch('/api/headers')
  await res.text()
  record('响应头：新增生效', res.headers.get('x-mock') === 'yes', String(res.headers.get('x-mock')))
  record('响应头：删除生效', res.headers.get('x-drop') === null, String(res.headers.get('x-drop')))
  record('响应头：没提到的保留', res.headers.get('x-keep') === 'yes', String(res.headers.get('x-keep')))
}

async function testDelay() {
  const started = performance.now()
  await fetch('/api/delay').then((res) => res.text())
  const elapsed = performance.now() - started
  record('延迟生效', elapsed >= 350, `${Math.round(elapsed)}ms`)
}

async function testNetworkError() {
  let error = null
  try {
    await fetch('/api/neterr')
  } catch (err) {
    error = err
  }
  // 真断网时 fetch 抛的就是 TypeError，测试代码里 catch 的也是它。
  record('网络错误：抛 TypeError', error instanceof TypeError, error?.name ?? '没有抛错')
}

async function testTimeout() {
  let error = null
  try {
    await fetch('/api/timeout')
  } catch (err) {
    error = err
  }
  record('超时：抛 AbortError', error?.name === 'AbortError', error?.name ?? '没有抛错')
}

async function testMock() {
  const res = await fetch('/api/mock')
  const body = await res.json()
  record('伪造模式：状态码与 body 都来自规则', res.status === 418 && body.i === 'teapot', `${res.status} ${JSON.stringify(body)}`)

  const hits = await fetch('/__hits').then((r) => r.json())
  record('伪造模式：请求确实没有发出去', (hits['/api/mock'] ?? 0) === 0, `服务端收到 ${hits['/api/mock'] ?? 0} 次`)
}

async function testStreamPreserved() {
  const started = performance.now()
  const res = await fetch('/api/stream')
  const reader = res.body.getReader()
  const first = await reader.read()
  const firstAt = performance.now() - started
  const text = new TextDecoder().decode(first.value)

  record('流式响应：状态码被改写', res.status === 500, String(res.status))
  // 服务端发完第一块要等 500ms 才发第二块。若实现把 body 缓冲了，这里必然 >= 500ms。
  record(
    '流式响应：第一块立刻到达，说明没被缓冲',
    text.includes('first') && firstAt < 400,
    `第一块 ${Math.round(firstAt)}ms`,
  )
  await reader.cancel().catch(() => {})
}

/* ── XHR 路径 ───────────────────────────────────────────── */

function xhrRequest(url, options = {}) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url)
    if (options.responseType) xhr.responseType = options.responseType
    xhr.onloadend = () => resolve(xhr)
    xhr.send()
  })
}

async function testXhr() {
  const xhr = await xhrRequest('/api/xhr')
  record('XHR：状态码被改写', xhr.status === 202, String(xhr.status))
  record('XHR：responseText 被替换', xhr.responseText.includes('mock'), xhr.responseText.slice(0, 60))
  record('XHR：单个响应头被改写', xhr.getResponseHeader('x-xhr') === 'yes', String(xhr.getResponseHeader('x-xhr')))
  record('XHR：getAllResponseHeaders 可用', xhr.getAllResponseHeaders().includes('x-xhr'), xhr.getAllResponseHeaders().slice(0, 80))
  record('XHR：responseURL 被补回', xhr.responseURL.endsWith('/api/xhr'), xhr.responseURL)
  record('XHR：loadend 派发过、readyState 到位', xhr.readyState === 4, String(xhr.readyState))

  const json = await xhrRequest('/api/xhr', { responseType: 'json' })
  record('XHR：responseType=json 时 response 是解析后的对象', json.response?.from === 'mock', JSON.stringify(json.response))

  let threw = false
  try {
    void json.responseText
  } catch {
    threw = true
  }
  record('XHR：responseType=json 时读 responseText 抛错（符合规范）', threw)

  const buffer = await xhrRequest('/api/xhr', { responseType: 'arraybuffer' })
  record('XHR：responseType=arraybuffer 拿到 ArrayBuffer', buffer.response instanceof ArrayBuffer, typeof buffer.response)
}

async function testXhrMock() {
  const xhr = await xhrRequest('/api/xhrmock')
  record('XHR 伪造：状态码来自规则', xhr.status === 203, String(xhr.status))
  const hits = await fetch('/__hits').then((r) => r.json())
  record('XHR 伪造：请求没有发出去', (hits['/api/xhrmock'] ?? 0) === 0, `服务端收到 ${hits['/api/xhrmock'] ?? 0} 次`)
}

async function testXhrAbort() {
  const events = []
  const done = new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', '/api/xhrabort')
    xhr.onabort = () => events.push('abort')
    xhr.onloadend = () => {
      events.push('loadend')
      resolve(xhr)
    }
    xhr.send()
    setTimeout(() => xhr.abort(), 60)
  })
  const xhr = await done
  record('XHR：abort 派发 abort + loadend', events.includes('abort') && events.includes('loadend'), events.join(','))
  record('XHR：abort 后 readyState 归零', xhr.readyState === 0, String(xhr.readyState))
}

async function testXhrNetworkError() {
  const events = []
  const xhr = await new Promise((resolve) => {
    const request = new XMLHttpRequest()
    request.open('GET', '/api/xhrerr')
    request.onerror = () => events.push('error')
    request.onloadend = () => {
      events.push('loadend')
      resolve(request)
    }
    request.send()
  })
  record('XHR：网络错误派发 error 事件', events.includes('error'), events.join(','))
  record('XHR：网络错误时 status 为 0', xhr.status === 0, String(xhr.status))
}

/* ── 上报链路 ───────────────────────────────────────────── */

async function testReporting() {
  const entries = harness.reports.filter((m) => m && m.t === 'report').map((m) => m.entry)
  const statusId = entries.find((e) => e.url && e.url.includes('/api/status'))?.id
  record('上报：请求会经过 bridge 送到 Port', statusId !== undefined, `共 ${entries.length} 条`)

  const merged = Object.assign({}, ...entries.filter((e) => e.id === statusId))
  record('上报：命中规则的请求带上了 ruleId', merged.ruleId === 'r-status', String(merged.ruleId))
  record('上报：outcome 标为 rewritten', merged.outcome === 'rewritten', String(merged.outcome))
  record('上报：应用看到的状态码是改写后的', merged.status === 503, String(merged.status))
  record('上报：两段式补上了响应体', typeof merged.responseBody === 'string' && merged.responseBody.includes('real'), String(merged.responseBody).slice(0, 40))

  const mocked = Object.assign(
    {},
    ...entries.filter((e) => e.url && e.url.includes('/api/mock')),
  )
  record('上报：伪造模式的 outcome 是 mocked', mocked.outcome === 'mocked', String(mocked.outcome))
  record('上报：伪造模式没有 realStatus', mocked.realStatus === undefined, String(mocked.realStatus))
}

/* ── 响应头采集 ─────────────────────────────────────────── */

/**
 * 响应头一律采集，不受「采集 Body」开关影响——读头不碰 body，没理由省。
 * 放行路径尤其要紧：面板里绝大多数请求都是放行的，头看不到等于没这个功能。
 */
async function testHeaderCapture() {
  const grab = () => harness.reports.filter((m) => m && m.t === 'report').map((m) => m.entry)

  /**
   * 后补的上报只带 id，既没有 url 也没有 outcome，所以先按 url 找到 id，
   * 再按 id 合并——直接按 url 过滤会把补上来的 body 全丢掉。
   */
  const findBy = (needle) => {
    const id = grab().find((e) => e.url && e.url.includes(needle))?.id
    return id === undefined ? {} : Object.assign({}, ...grab().filter((e) => e.id === id))
  }

  // 放行，采集 Body 开着：头和体都该有
  await fetch('/api/plain?case=on')
  await sleep(80)
  const withBody = findBy('case=on')
  record(
    '放行请求也上报响应头',
    typeof withBody.responseHeaders?.['content-type'] === 'string',
    JSON.stringify(withBody.responseHeaders),
  )
  record('放行请求上报响应体（采集 Body 开着）', typeof withBody.responseBody === 'string', String(withBody.responseBody))

  // 放行，采集 Body 关掉：体没道理留着，头必须还在
  await setConfig({ ...harness.config, captureBodies: false })

  await fetch('/api/plain?case=off')
  await sleep(80)
  const noBody = findBy('case=off')
  record(
    '关掉采集 Body：放行请求仍上报响应头',
    typeof noBody.responseHeaders?.['content-type'] === 'string',
    JSON.stringify(noBody.responseHeaders),
  )
  record('关掉采集 Body：放行请求不再上报响应体', noBody.responseBody === undefined, String(noBody.responseBody))

  // XHR 放行走的是另一条上报路径，同样只该少 body
  await new Promise((done) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', `${ORIGIN}/api/plain?case=xhr`)
    xhr.onloadend = () => done()
    xhr.send()
  })
  await sleep(80)
  const xhrEntry = findBy('case=xhr')
  record(
    '关掉采集 Body：XHR 放行请求仍上报响应头',
    typeof xhrEntry.responseHeaders?.['content-type'] === 'string',
    JSON.stringify(xhrEntry.responseHeaders),
  )
  record('关掉采集 Body：XHR 放行请求不再上报响应体', xhrEntry.responseBody === undefined, String(xhrEntry.responseBody))

  await setConfig({ ...harness.config, captureBodies: true })
}

/* ── 开关 ───────────────────────────────────────────────── */

async function testMasterSwitch() {
  await setConfig({ ...harness.config, enabled: false })
  const res = await fetch('/api/status')
  const body = await res.json()
  record('总开关关闭：规则全部失效，请求原样放行', res.status === 200 && body.from === 'real', `${res.status} ${JSON.stringify(body)}`)

  await setConfig({ rules: RULES, enabled: true, captureBodies: true })
  const restored = await fetch('/api/status')
  record('总开关打开：规则恢复生效', restored.status === 503, String(restored.status))
}

/* ── 跑 ─────────────────────────────────────────────────── */

async function main() {
  const bridgeUp = await waitFor(() => harness.configured, 3000)
  if (!bridgeUp) throw new Error('bridge 没能和假 background 建立连接')

  await setConfig({ rules: RULES, enabled: true, captureBodies: true })

  await fetch('/__reset')

  await testPassthrough()
  await testStatusOnly()
  await testBodyReplace()
  await testBodyMerge()
  await testHeaders()
  await testDelay()
  await testNetworkError()
  await testTimeout()
  await testMock()
  await testStreamPreserved()
  await testXhr()
  await testXhrMock()
  await testXhrAbort()
  await testXhrNetworkError()
  await testMasterSwitch()
  await testReporting()
  await testHeaderCapture()
}

async function finish(error) {
  if (error) record('执行过程没有抛异常', false, error?.stack ?? String(error))

  const failed = results.filter((item) => !item.ok)
  document.getElementById('out').textContent = [
    ...results.map((item) => `${item.ok ? '✓' : '✗'} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`),
    '',
    `${results.length - failed.length}/${results.length} 通过`,
  ].join('\n')

  try {
    await window.fetch('/__results', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ suite: 'harness', results }),
    })
  } catch {
    /* 服务器已经不在就算了 */
  }
}

// 看门狗：任何一步卡死也要把已有结果交出去，而不是让验证挂到超时。
const watchdog = setTimeout(() => void finish(new Error('超时：15s 内没跑完')), 15000)

main()
  .then(() => finish())
  .catch((error) => finish(error))
  .finally(() => clearTimeout(watchdog))
