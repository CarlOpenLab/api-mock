/** 包装 window.fetch：命中规则时改写响应，未命中时纯放行。 */

import type { Rule } from '../shared/rules'
import {
  type ClampedRead,
  type HookContext,
  captureRequest,
  headersToObject,
  isStreamingType,
  newEntryId,
  readClamped,
  truncate,
} from './context'
import {
  abortError,
  buildMockedResponse,
  buildResponseSpec,
  buildRewrittenResponse,
  failureError,
  needsRealBody,
  sleep,
} from './rewriter'

type OriginalFetch = typeof fetch

type Described = {
  url: string
  method: string
  request: Request | null
}

function toAbsoluteUrl(raw: string): string {
  try {
    return new URL(raw, location.href).href
  } catch {
    return raw
  }
}

function describeRequest(input: RequestInfo | URL, init?: RequestInit): Described {
  const isRequest = typeof Request === 'function' && input instanceof Request
  const request = isRequest ? (input as Request) : null
  const rawUrl = request ? request.url : String(input)
  const rawMethod = init?.method ?? request?.method ?? 'GET'
  return { url: toAbsoluteUrl(rawUrl), method: rawMethod.toUpperCase(), request }
}

/** 页面可能把 signal 放在 init 上，也可能挂在 Request 上。 */
function signalOf(described: Described, init?: RequestInit): AbortSignal | null {
  return init?.signal ?? described.request?.signal ?? null
}

export function installFetchHook(ctx: HookContext): void {
  const original = window.fetch
  // 环境没有 fetch，或已被别的工具包过，就不要再叠一层。
  if (typeof original !== 'function') return

  const patched = async function fetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    let described: Described
    try {
      described = describeRequest(input, init)
    } catch {
      // 连 URL 都解析不出来的调用，交给原生实现去抛错，报错信息更准。
      return original.call(this, input, init)
    }

    const rule = ctx.match({ url: described.url, method: described.method })
    return rule
      ? runIntercepted(original, this, input, init, described, rule, ctx)
      : runPassthrough(original, this, input, init, described, ctx)
  }

  // 有些库会检查 fetch.name / fetch.toString() 来判断自己是不是被劫持了。
  Object.defineProperty(patched, 'name', { value: 'fetch', configurable: true })
  Object.defineProperty(patched, 'toString', {
    value: () => original.toString(),
    configurable: true,
  })

  window.fetch = patched as typeof fetch
}

async function runPassthrough(
  original: OriginalFetch,
  thisArg: unknown,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  described: Described,
  ctx: HookContext,
): Promise<Response> {
  const capture = ctx.captureBodies()
  // 请求体必须在发出去之前读：fetch 一旦执行，body 就被消费了。
  const requestPromise = capture ? captureRequest(input, init) : null

  const started = performance.now()
  const response = await original.call(thisArg, input, init)
  const durationMs = Math.round(performance.now() - started)

  const id = newEntryId()
  ctx.report({
    id,
    ts: Date.now(),
    url: described.url,
    method: described.method,
    transport: 'fetch',
    outcome: 'passthrough',
    status: response.status,
    durationMs,
    totalMs: durationMs,
    // 响应头一律采集：读它不碰 body，不受「采集 Body」开关影响。
    responseHeaders: headersToObject(response.headers),
  })

  void requestPromise?.then((captured) => {
    if (!captured) return
    ctx.report({ id, requestHeaders: captured.headers, requestBody: captured.body })
  })

  if (capture) captureResponseBody(response, id, ctx)
  return response
}

async function runIntercepted(
  original: OriginalFetch,
  thisArg: unknown,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  described: Described,
  rule: Rule,
  ctx: HookContext,
): Promise<Response> {
  const id = newEntryId()
  const started = performance.now()
  const signal = signalOf(described, init)
  const capture = ctx.captureBodies()
  const requestPromise = capture ? captureRequest(input, init) : null

  const reportRequest = () => {
    void requestPromise?.then((captured) => {
      if (!captured) return
      ctx.report({ id, requestHeaders: captured.headers, requestBody: captured.body })
    })
  }

  const base = {
    id,
    ts: Date.now(),
    url: described.url,
    method: described.method,
    transport: 'fetch' as const,
    ruleId: rule.id,
    ruleName: rule.name,
  }

  try {
    if (signal?.aborted) throw abortError()

    const earlySpec = buildResponseSpec(rule, null)
    if (earlySpec.delayMs > 0) await sleep(earlySpec.delayMs, signal)

    if (earlySpec.failure !== 'none') {
      reportRequest()
      ctx.report({
        ...base,
        outcome: 'failed',
        status: 0,
        error: earlySpec.failure,
        totalMs: Math.round(performance.now() - started),
      })
      throw failureError(earlySpec.failure)
    }

    let real: Response | null = null
    let realText: string | null = null

    if (rule.action.mode === 'rewrite') {
      real = await original.call(thisArg, input, init)
      if (needsRealBody(rule)) {
        // clone 出来读，原始那份留给应用；两条 tee 分支互不影响。
        realText = (await readClamped(real.clone()))?.text ?? null
      }
    }

    const spec = buildResponseSpec(rule, realText)
    const response = real
      ? buildRewrittenResponse(real, spec, described.url)
      : buildMockedResponse(spec, described.url)

    reportRequest()

    const totalMs = Math.round(performance.now() - started)
    const patch: Parameters<HookContext['report']>[0] = {
      ...base,
      outcome: rule.action.mode === 'mock' ? 'mocked' : 'rewritten',
      status: response.status,
      realStatus: real?.status,
      totalMs,
      // 真实网络耗时里已经含了人为延迟，扣掉才是纯网络时间。
      durationMs: real ? Math.max(0, totalMs - spec.delayMs) : undefined,
      responseHeaders: headersToObject(response.headers),
    }

    if (spec.bodyReplaced) {
      const clamped = truncate(spec.body ?? '')
      patch.responseBody = clamped.text
      patch.truncatedFrom = clamped.truncatedFrom
    }

    ctx.report(patch)

    if (!spec.bodyReplaced && capture) captureResponseBody(response, id, ctx)
    return response
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      ctx.report({
        ...base,
        outcome: 'failed',
        status: 0,
        error: 'aborted',
        totalMs: Math.round(performance.now() - started),
      })
    }
    throw err
  }
}

/** 采集「应用最终会看到」的响应体，作为同 id 的补丁上报。 */
function captureResponseBody(response: Response, id: string, ctx: HookContext): void {
  if (!response.body) return
  if (isStreamingType(response.headers.get('content-type'))) return

  let clone: Response
  try {
    clone = response.clone()
  } catch {
    return
  }

  void readClamped(clone)
    .then((clamped: ClampedRead | null) => {
      if (!clamped) return
      ctx.report({
        id,
        responseBody: clamped.text,
        truncatedFrom: clamped.truncatedFrom,
      })
    })
    .catch(() => {})
}
