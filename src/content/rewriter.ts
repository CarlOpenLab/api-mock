/**
 * 依据规则算出「最终响应应该长什么样」。
 *
 * 这里刻意全是纯函数：不碰 network、不碰 chrome API，只做「输入规则 + 真实响应
 * → 输出响应描述」的换算，所以可以被 Vitest 直接覆盖。真正发请求的部分在
 * fetch-hook.ts / xhr-hook.ts。
 */

import { mergeJsonText } from '../shared/json'
import type { Rule, RuleAction } from '../shared/rules'

export type ResponseSpec = {
  /** 未指定表示沿用真实响应的状态码。 */
  status?: number
  /** 最终响应体。undefined 表示保留真实响应体。 */
  body?: string
  /** 是否要替换掉真实响应体。 */
  bodyReplaced: boolean
  headerPatch?: RuleAction['headers']
  delayMs: number
  failure: RuleAction['failure']
}

/**
 * 这两个状态码在 Fetch 规范里不允许带 body，`new Response(body, {status})` 会直接抛错。
 * 101 是协议切换，204/205 是「无内容」，304 是「未修改」。
 */
export function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304
}

/** 这些头描述的是「网络上传的字节」，body 一旦被替换就必须删掉，否则下游解析出错。 */
const BODY_DESCRIBING_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding']

export function stripBodyHeaders(headers: Headers): void {
  for (const name of BODY_DESCRIBING_HEADERS) headers.delete(name)
}

export function applyHeaderPatch(headers: Headers, patch: RuleAction['headers']): void {
  if (!patch) return
  for (const name of patch.remove ?? []) headers.delete(name)
  for (const [name, value] of Object.entries(patch.set ?? {})) headers.set(name, value)
}

/**
 * merge-json 模式必须先读到真实响应体才能合并；
 * replace / mock 模式则完全不需要读——这是个重要的性能分界点，
 * 因为读 body 意味着把流缓冲下来，会破坏 SSE。
 */
export function needsRealBody(rule: Rule): boolean {
  return (
    rule.action.mode === 'rewrite' &&
    rule.action.body !== undefined &&
    rule.action.bodyMode === 'merge-json'
  )
}

/**
 * @param realText 真实响应体，仅当 needsRealBody(rule) 为 true 时才有意义。
 */
export function buildResponseSpec(rule: Rule, realText: string | null): ResponseSpec {
  const action = rule.action
  const spec: ResponseSpec = {
    status: action.status,
    body: undefined,
    bodyReplaced: false,
    headerPatch: action.headers,
    delayMs: Math.max(0, action.delayMs ?? 0),
    failure: action.failure,
  }

  if (action.mode === 'mock') {
    // 伪造模式下 body 是该存在的，没填就当作空响应体。
    spec.bodyReplaced = true
    spec.body = action.body?.text ?? ''
    return spec
  }

  if (action.body !== undefined) {
    spec.bodyReplaced = true
    spec.body =
      action.bodyMode === 'merge-json' && realText !== null
        ? mergeJsonText(realText, action.body.text)
        : action.body.text
  }

  return spec
}

/** 伪造响应时若没指定 content-type，给一个合理的默认值。 */
export const DEFAULT_MOCK_CONTENT_TYPE = 'application/json; charset=utf-8'

/**
 * 把规格套到真实响应上，产出一个最终 Response。
 *
 * 关键点：只改状态码/响应头时，body 用 `new Response(real.body, …)` 把原始流
 * 原样转出去，**不做缓冲**，所以 SSE 这类流式响应不会被破坏。只有真的替换了
 * body 才会退化成整段缓冲。
 */
export function buildRewrittenResponse(
  real: Response,
  spec: ResponseSpec,
  url: string,
): Response {
  const headers = new Headers(real.headers)
  applyHeaderPatch(headers, spec.headerPatch)

  const status = spec.status ?? real.status
  const statusText = spec.status === undefined ? real.statusText : ''
  let body: BodyInit | null = real.body

  if (spec.bodyReplaced) {
    stripBodyHeaders(headers)
    body = spec.body ?? ''
    // 真实 body 我们已经不要了，主动取消，别把连接挂着等 GC。
    real.body?.cancel().catch(() => {})
  }

  if (isNullBodyStatus(status)) body = null

  const out = new Response(body, { status, statusText, headers })
  defineResponseIdentity(out, { url, redirected: real.redirected, type: real.type })
  return out
}

/** 直接伪造一个响应，完全不发请求。 */
export function buildMockedResponse(spec: ResponseSpec, url: string): Response {
  const headers = new Headers()
  applyHeaderPatch(headers, spec.headerPatch)
  if (!headers.has('content-type')) {
    headers.set('content-type', DEFAULT_MOCK_CONTENT_TYPE)
  }

  const status = spec.status ?? 200
  const body = isNullBodyStatus(status) ? null : (spec.body ?? '')

  const out = new Response(body, { status, headers })
  defineResponseIdentity(out, { url, redirected: false, type: 'default' })
  return out
}

/**
 * `new Response()` 造出来的对象 url / redirected / type 都是空的，而应用代码真的
 * 会去读 `response.url`、判 `response.redirected`。不补齐的话，你测出来的「通过」
 * 是假的。
 */
export function defineResponseIdentity(
  response: Response,
  identity: { url: string; redirected: boolean; type: ResponseType },
): void {
  Object.defineProperty(response, 'url', { value: identity.url, configurable: true })
  Object.defineProperty(response, 'redirected', {
    value: identity.redirected,
    configurable: true,
  })
  Object.defineProperty(response, 'type', { value: identity.type, configurable: true })
}

/** 网络层失败应该抛什么：和浏览器真失败时的错误类型保持一致。 */
export function failureError(failure: Exclude<RuleAction['failure'], 'none'>): Error {
  if (failure === 'timeout') {
    // fetch 超时（AbortSignal.timeout）抛的就是这个。
    return new DOMException('The operation was aborted.', 'AbortError')
  }
  // 断网/DNS 失败时 fetch 抛的是 TypeError，不是 Error。
  return new TypeError('Failed to fetch')
}

/** 可被 AbortSignal 中断的 sleep。 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  // 信号「已经」中止时必须立刻 reject：abort 事件早已发过，
  // 这时再 addEventListener 永远等不到回调，会白白等到超时。
  if (signal?.aborted) return Promise.reject(abortError())
  if (ms <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function abortError(): DOMException {
  return new DOMException('The user aborted a request.', 'AbortError')
}
