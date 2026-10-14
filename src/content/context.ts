/** hook 与 inject 之间的契约，以及上报时的采集工具。 */

import { newId } from '../shared/rules'
import type { FeedEntry } from '../shared/protocol'
import type { Rule } from '../shared/rules'

export type ReportPatch = Partial<FeedEntry> & { id: string }

export type HookContext = {
  /** 命中则返回规则，否则 null。必须是同步的——XHR 的同步模式不允许 await。 */
  match(input: { url: string; method: string }): Rule | null
  /** 上报一次请求。同 id 会被合并，所以可以先报元数据、稍后补 body。 */
  report(patch: ReportPatch): void
  captureBodies(): boolean
}

/** 单个 body 最多采集多少字节。 */
export const MAX_CAPTURED_BYTES = 128 * 1024

export function newEntryId(): string {
  return newId()
}

export function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, name) => {
    out[name] = value
  })
  return out
}

export function truncate(text: string, limit = MAX_CAPTURED_BYTES): {
  text: string
  truncatedFrom?: number
} {
  if (text.length <= limit) return { text }
  return { text: text.slice(0, limit), truncatedFrom: text.length }
}

/** SSE 这类流式响应不能缓冲，一旦读下去就会把流吃掉。 */
export function isStreamingType(contentType: string | null): boolean {
  if (!contentType) return false
  return contentType.includes('text/event-stream')
}

/** 只采集文本类响应，二进制（图片/字体/压缩包）读了也没意义。 */
export function isTextualType(contentType: string | null): boolean {
  if (!contentType) return true
  return (
    contentType.includes('json') ||
    contentType.startsWith('text/') ||
    contentType.includes('xml') ||
    contentType.includes('javascript') ||
    contentType.includes('x-www-form-urlencoded')
  )
}

/** 从 content-length 判断会不会太大，读之前就能拦下来。 */
function declaredTooLarge(headers: Headers, limit: number): boolean {
  const raw = headers.get('content-length')
  if (!raw) return false
  const size = Number(raw)
  return Number.isFinite(size) && size > limit
}

export type ClampedRead = { text: string; truncatedFrom?: number }

/**
 * 读一个响应体，最多读 limit 字节。
 *
 * 注意：调用方传进来的 response 必须是自己 clone 出来的副本，
 * 否则会把应用要用的那份流吃掉。
 */
export async function readClamped(
  response: Response,
  limit = MAX_CAPTURED_BYTES,
): Promise<ClampedRead | null> {
  try {
    if (declaredTooLarge(response.headers, limit)) return null
    if (!isTextualType(response.headers.get('content-type'))) return null

    const reader = response.body?.getReader()
    if (!reader) {
      const text = await response.text()
      return truncate(text, limit)
    }

    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          chunks.push(value)
          total += value.byteLength
          if (total >= limit) {
            truncated = true
            break
          }
        }
      }
    } finally {
      if (truncated) await reader.cancel().catch(() => {})
    }

    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    const text = new TextDecoder().decode(merged)
    return truncated ? { text, truncatedFrom: total } : { text }
  } catch {
    return null
  }
}

/** 采集请求体。必须在原始 fetch/XHR 发出之前启动，否则 body 已被消费。 */
export async function captureRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  limit = MAX_CAPTURED_BYTES,
): Promise<{ headers: Record<string, string>; body?: string; truncatedFrom?: number } | null> {
  try {
    if (typeof Request === 'function' && input instanceof Request) {
      const headers = headersToObject(input.headers)
      if (declaredTooLarge(input.headers, limit)) return { headers }
      const text = await input.clone().text()
      const clamped = truncate(text, limit)
      return { headers, body: clamped.text, truncatedFrom: clamped.truncatedFrom }
    }

    const headers = headersToObject(new Headers(init?.headers))
    const body = init?.body
    // 只有字符串 body 能安全地顺手读出来；FormData / Blob / ReadableStream
    // 要么读不动，要么读了会干扰真正的请求。
    if (typeof body === 'string') {
      const clamped = truncate(body, limit)
      return { headers, body: clamped.text, truncatedFrom: clamped.truncatedFrom }
    }
    return { headers }
  } catch {
    return null
  }
}
