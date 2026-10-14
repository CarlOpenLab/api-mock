/**
 * 包装 XMLHttpRequest。
 *
 * 命中规则时**不走应用这个 xhr 对象去发请求**，而是用原生 fetch 发真实请求，
 * 拿到结果后往应用的 xhr 对象上「重放」一遍完整生命周期（readystatechange →
 * load → loadend），中间的响应值按规则改写。
 *
 * 这么做是因为反过来做不通：Response 的 status/headers 在 fetch 里还能重建，
 * 但 XHR 的 responseText/status 是原型上的只读 getter，读的是内部状态，
 * 没有 API 能改。而想「抑制真实事件、稍后重放」又得连 addEventListener 一起
 * 劫持，任何一处漏掉都会让应用看到两次响应。换个对象发请求干净得多。
 *
 * 代价：命中规则的 XHR 必须把整个响应体缓冲下来（因为 responseText 本身就是
 * 字符串），所以 XHR 场景下做不到像 fetch 那样流式透传。
 */

import type { Rule } from '../shared/rules'
import { type HookContext, newEntryId, truncate } from './context'
import { nativeFetch } from './native'
import { type ResponseSpec, buildResponseSpec, sleep } from './rewriter'

type XhrState = {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
  async: boolean
  /** 命中规则、走重放路径。 */
  hijacked: boolean
  aborted: boolean
  controller: AbortController | null
}

type RealResult = {
  status: number
  statusText: string
  headerText: string
  contentType: string
  bodyText: string
  url: string
}

const states = new WeakMap<XMLHttpRequest, XhrState>()

const XHR_PROTO = XMLHttpRequest.prototype
const origOpen = XHR_PROTO.open
const origSend = XHR_PROTO.send
const origSetRequestHeader = XHR_PROTO.setRequestHeader
const origAbort = XHR_PROTO.abort

/** 我们自己往实例上盖的属性，重新 open 时要清掉。 */
const SHADOW_PROPS = [
  'readyState',
  'status',
  'statusText',
  'response',
  'responseText',
  'responseURL',
  'getAllResponseHeaders',
  'getResponseHeader',
] as const

const BODYLESS_METHODS = new Set(['GET', 'HEAD'])

function toAbsoluteUrl(raw: string): string {
  try {
    return new URL(raw, location.href).href
  } catch {
    return raw
  }
}

function shadow(target: object, prop: string, value: unknown): void {
  Object.defineProperty(target, prop, { value, configurable: true, writable: true })
}

function clearShadows(xhr: XMLHttpRequest): void {
  for (const prop of SHADOW_PROPS) {
    try {
      delete (xhr as unknown as Record<string, unknown>)[prop]
    } catch {
      /* 删不掉就算了，下一次 shadow 会覆盖 */
    }
  }
}

function fire(xhr: XMLHttpRequest, type: string): void {
  xhr.dispatchEvent(new Event(type))
}

function fireProgress(xhr: XMLHttpRequest, type: string, loaded: number): void {
  xhr.dispatchEvent(
    new ProgressEvent(type, { lengthComputable: true, loaded, total: loaded }),
  )
}

function serializeHeaders(headers: Headers): string {
  const lines: string[] = []
  headers.forEach((value, name) => {
    lines.push(`${name}: ${value}`)
  })
  return lines.length ? `${lines.join('\r\n')}\r\n` : ''
}

function getHeader(headerText: string, name: string): string | null {
  if (!headerText) return null
  const wanted = name.trim().toLowerCase()
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    if (line.slice(0, idx).trim().toLowerCase() === wanted) {
      return line.slice(idx + 1).trim()
    }
  }
  return null
}

/** Document body 得先序列化成字符串，fetch 不认 Document。 */
function serializeBody(body: unknown, method: string): BodyInit | undefined {
  if (body === undefined || body === null) return undefined
  if (BODYLESS_METHODS.has(method)) return undefined
  if (typeof Document !== 'undefined' && body instanceof Document) {
    return new XMLSerializer().serializeToString(body)
  }
  return body as BodyInit
}

/** 把实例上真实响应的值读成文本，仅用于未命中规则时的上报。 */
function readXhrBody(xhr: XMLHttpRequest): string | null {
  try {
    if (xhr.responseType === '' || xhr.responseType === 'text') {
      return xhr.responseText
    }
    if (xhr.responseType === 'json') {
      return xhr.response == null ? null : JSON.stringify(xhr.response, null, 2)
    }
    return null
  } catch {
    return null
  }
}

export function installXhrHook(ctx: HookContext): void {
  if (typeof XMLHttpRequest === 'undefined') return

  XHR_PROTO.open = function (
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    async: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    states.set(this, {
      method: String(method).toUpperCase(),
      url: toAbsoluteUrl(String(url)),
      headers: {},
      body: undefined,
      async: async !== false,
      hijacked: false,
      aborted: false,
      controller: null,
    })
    // 同一个 xhr 对象被复用（open 第二次）时，上一轮盖上去的响应属性要清掉。
    clearShadows(this)
    origOpen.call(this, method, url, async, username, password)
  }

  XHR_PROTO.setRequestHeader = function (
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const state = states.get(this)
    if (state) state.headers[name] = value
    origSetRequestHeader.call(this, name, value)
  }

  XHR_PROTO.send = function (
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const state = states.get(this)
    if (!state) {
      origSend.call(this, body)
      return
    }

    state.body = body
    const rule = ctx.match({ url: state.url, method: state.method })

    if (!rule) {
      reportPassthrough(this, state, ctx)
      origSend.call(this, body)
      return
    }

    state.hijacked = true
    state.controller = new AbortController()
    void runHijacked(this, state, rule, ctx)
  }

  XHR_PROTO.abort = function (this: XMLHttpRequest): void {
    const state = states.get(this)
    if (!state?.hijacked) {
      origAbort.call(this)
      return
    }
    if (state.aborted) return
    state.aborted = true
    state.controller?.abort()

    shadow(this, 'readyState', 4)
    fire(this, 'readystatechange')
    shadow(this, 'readyState', 0)
    fire(this, 'readystatechange')
    fire(this, 'abort')
    fire(this, 'loadend')
  }
}

function reportPassthrough(xhr: XMLHttpRequest, state: XhrState, ctx: HookContext): void {
  const started = performance.now()
  const id = newEntryId()
  const capture = ctx.captureBodies()

  xhr.addEventListener(
    'loadend',
    () => {
      const durationMs = Math.round(performance.now() - started)
      ctx.report({
        id,
        ts: Date.now(),
        url: state.url,
        method: state.method,
        transport: 'xhr',
        outcome: 'passthrough',
        status: xhr.status,
        durationMs,
        totalMs: durationMs,
        requestHeaders: state.headers,
        requestBody: capture && typeof state.body === 'string' ? truncate(state.body).text : undefined,
        // 响应头一律采集：读它不碰 body，不受「采集 Body」开关影响。
        responseHeaders: parseHeaderText(xhr.getAllResponseHeaders()),
      })

      if (!capture) return
      const text = readXhrBody(xhr)
      if (text === null) return
      const clamped = truncate(text)
      ctx.report({
        id,
        responseBody: clamped.text,
        truncatedFrom: clamped.truncatedFrom,
      })
    },
    { once: true },
  )
}

function parseHeaderText(headerText: string): Record<string, string> {
  const out: Record<string, string> = {}
  if (!headerText) return out
  for (const line of headerText.split('\r\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return out
}

async function performRealRequest(
  state: XhrState,
  headers: Record<string, string>,
): Promise<RealResult | null> {
  if (!nativeFetch) return null

  const response = await nativeFetch(state.url, {
    method: state.method,
    headers,
    body: serializeBody(state.body, state.method),
    credentials: undefined, // 用默认的 same-origin，与不带 withCredentials 的 XHR 一致
    redirect: 'follow',
    signal: state.controller?.signal,
  })

  const headerText = serializeHeaders(response.headers)
  const bodyText = await response.text()

  return {
    status: response.status,
    statusText: response.statusText,
    headerText,
    contentType: response.headers.get('content-type') ?? '',
    bodyText,
    url: response.url || state.url,
  }
}

async function runHijacked(
  xhr: XMLHttpRequest,
  state: XhrState,
  rule: Rule,
  ctx: HookContext,
): Promise<void> {
  const id = newEntryId()
  const started = performance.now()
  const base = {
    id,
    ts: Date.now(),
    url: state.url,
    method: state.method,
    transport: 'xhr' as const,
    ruleId: rule.id,
    ruleName: rule.name,
    requestHeaders: state.headers,
    requestBody:
      typeof state.body === 'string' ? truncate(state.body).text : undefined,
  }

  const elapsed = () => Math.round(performance.now() - started)

  try {
    const earlySpec = buildResponseSpec(rule, null)

    // 应用自己设了 timeout，就别越过它——这才是真实行为。
    if (xhr.timeout > 0 && earlySpec.delayMs >= xhr.timeout) {
      await sleep(xhr.timeout, state.controller?.signal)
      if (state.aborted) return
      ctx.report({ ...base, outcome: 'failed', status: 0, error: 'timeout', totalMs: elapsed() })
      fireFailure(xhr, 'timeout')
      return
    }

    if (earlySpec.delayMs > 0) await sleep(earlySpec.delayMs, state.controller?.signal)
    if (state.aborted) return

    if (earlySpec.failure !== 'none') {
      ctx.report({
        ...base,
        outcome: 'failed',
        status: 0,
        error: earlySpec.failure,
        totalMs: elapsed(),
      })
      fireFailure(xhr, earlySpec.failure)
      return
    }

    let real: RealResult | null = null
    if (rule.action.mode === 'rewrite') {
      real = await performRealRequest(state, state.headers)
    }
    if (state.aborted) return

    const spec = buildResponseSpec(rule, real?.bodyText ?? null)
    const data = composeResult(spec, real, state.url)

    replay(xhr, data)
    ctx.report({
      ...base,
      outcome: rule.action.mode === 'mock' ? 'mocked' : 'rewritten',
      status: data.status,
      realStatus: real?.status,
      durationMs: real ? Math.max(0, elapsed() - spec.delayMs) : undefined,
      totalMs: elapsed(),
      responseHeaders: parseHeaderText(data.headerText),
      responseBody: truncate(data.bodyText).text,
      truncatedFrom: truncate(data.bodyText).truncatedFrom,
    })
  } catch (err) {
    // abort 触发的 reject 属于预期路径，事件已经在 abort() 里发过了。
    if (err instanceof DOMException && err.name === 'AbortError') return
    if (state.aborted) return

    ctx.report({
      ...base,
      outcome: 'failed',
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      totalMs: elapsed(),
    })
    fireFailure(xhr, 'network-error')
  }
}

type ReplayData = {
  status: number
  statusText: string
  headerText: string
  contentType: string
  bodyText: string
  url: string
}

function composeResult(
  spec: ResponseSpec,
  real: RealResult | null,
  requestUrl: string,
): ReplayData {
  let headers = new Map<string, string>()
  if (real) headers = new Map(Object.entries(parseHeaderText(real.headerText)))

  for (const name of spec.headerPatch?.remove ?? []) {
    headers.delete(name.toLowerCase())
    for (const key of [...headers.keys()]) {
      if (key.toLowerCase() === name.toLowerCase()) headers.delete(key)
    }
  }
  for (const [name, value] of Object.entries(spec.headerPatch?.set ?? {})) {
    headers.set(name, value)
  }

  let bodyText = real?.bodyText ?? ''
  if (spec.bodyReplaced) {
    bodyText = spec.body ?? ''
    // body 换了，描述「网络字节」的头必须删掉，否则下游解析出错。
    for (const key of [...headers.keys()]) {
      const lower = key.toLowerCase()
      if (lower === 'content-length' || lower === 'content-encoding' || lower === 'transfer-encoding') {
        headers.delete(key)
      }
    }
  }

  const status = spec.status ?? real?.status ?? 200
  const contentType =
    [...headers.entries()].find(([k]) => k.toLowerCase() === 'content-type')?.[1] ??
    (real ? real.contentType : 'application/json; charset=utf-8')

  const headerText = headers.size
    ? `${[...headers.entries()].map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n`
    : ''

  return {
    status,
    statusText: spec.status === undefined ? (real?.statusText ?? '') : '',
    headerText,
    contentType,
    bodyText,
    url: real?.url ?? requestUrl,
  }
}

function installResponseValue(xhr: XMLHttpRequest, data: ReplayData): void {
  const type = xhr.responseType
  let response: unknown = data.bodyText

  if (type === 'json') {
    try {
      response = JSON.parse(data.bodyText)
    } catch {
      response = null
    }
  } else if (type === 'arraybuffer') {
    response = new TextEncoder().encode(data.bodyText).buffer
  } else if (type === 'blob') {
    response = new Blob([data.bodyText], { type: data.contentType })
  } else if (type === 'document') {
    // 不做 HTML 解析，返回 null 而不是假装成功。
    response = null
  }

  shadow(xhr, 'response', response)

  if (type === '' || type === 'text') {
    shadow(xhr, 'responseText', data.bodyText)
    return
  }

  // 规范要求：responseType 不是 ''/'text' 时读 responseText 必须抛 InvalidStateError。
  Object.defineProperty(xhr, 'responseText', {
    configurable: true,
    get() {
      throw new DOMException(
        `Failed to read the 'responseText' property from 'XMLHttpRequest': The value is only accessible if the object's 'responseType' is '' or 'text' (was '${type}').`,
        'InvalidStateError',
      )
    },
  })
}

function replay(xhr: XMLHttpRequest, data: ReplayData): void {
  shadow(xhr, 'status', data.status)
  shadow(xhr, 'statusText', data.statusText)
  shadow(xhr, 'responseURL', data.url)
  shadow(xhr, 'getAllResponseHeaders', () => data.headerText)
  shadow(xhr, 'getResponseHeader', (name: string) => getHeader(data.headerText, name))
  installResponseValue(xhr, data)

  for (const readyState of [2, 3, 4]) {
    shadow(xhr, 'readyState', readyState)
    fire(xhr, 'readystatechange')
  }
  fireProgress(xhr, 'load', data.bodyText.length)
  fireProgress(xhr, 'loadend', data.bodyText.length)
}

function fireFailure(xhr: XMLHttpRequest, failure: 'network-error' | 'timeout'): void {
  shadow(xhr, 'status', 0)
  shadow(xhr, 'statusText', '')
  shadow(xhr, 'readyState', 4)
  fire(xhr, 'readystatechange')
  fire(xhr, failure === 'timeout' ? 'timeout' : 'error')
  fire(xhr, 'loadend')
}
