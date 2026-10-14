/** 面板里的纯展示辅助。 */

import type { FeedEntry } from '../shared/protocol'
import type { Rule } from '../shared/rules'

/** 列表里只显示 path + query，origin 太长且通常都一样。 */
export function shortUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

export type OutcomeTone = 'idle' | 'ok' | 'warn' | 'bad'

export function outcomeTone(entry: FeedEntry): OutcomeTone {
  if (entry.outcome === 'failed') return 'bad'
  if (entry.outcome === 'mocked') return 'warn'
  if (entry.outcome === 'rewritten') return 'warn'
  const status = entry.status ?? 0
  if (status >= 500) return 'bad'
  if (status >= 400) return 'warn'
  return 'idle'
}

/** 右下角那个小标签：这条请求到底经历了什么。 */
export function outcomeLabel(entry: FeedEntry): string {
  switch (entry.outcome) {
    case 'mocked':
      return '伪造'
    case 'rewritten':
      return '改写'
    case 'failed':
      return failureLabel(entry.error)
    default:
      return '放行'
  }
}

function failureLabel(error: string | undefined): string {
  switch (error) {
    case 'network-error':
      return '网络错误'
    case 'timeout':
      return '超时'
    case 'aborted':
      return '已取消'
    default:
      return error ? '失败' : '失败'
  }
}

/** 状态列：失败时没有状态码，显示 0 会让人以为是真值。 */
export function statusText(entry: FeedEntry): string {
  if (entry.outcome === 'failed') return 'ERR'
  return entry.status === undefined ? '—' : String(entry.status)
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function formatTime(ts: number): string {
  const date = new Date(ts)
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function formatBytes(count: number): string {
  if (count < 1024) return `${count} B`
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(1)} KB`
  return `${(count / 1024 / 1024).toFixed(1)} MB`
}

/** 规则在列表里的一行摘要。 */
export function ruleSummary(rule: Rule): string {
  const parts: string[] = []
  const action = rule.action

  if (action.mode === 'mock') parts.push('伪造响应')
  if (action.failure === 'network-error') parts.push('网络错误')
  else if (action.failure === 'timeout') parts.push('超时')
  if (action.status !== undefined) parts.push(`→ ${action.status}`)
  if (action.body !== undefined) {
    parts.push(action.bodyMode === 'merge-json' ? '合并 body' : '替换 body')
  }
  if (action.delayMs) parts.push(`延迟 ${action.delayMs}ms`)
  if (action.headers?.set || action.headers?.remove) parts.push('改响应头')

  return parts.length ? parts.join(' · ') : '未设置任何动作'
}

/** 规则是否有实际效果——全空的规则会让人以为插件坏了。 */
export function ruleIsNoop(rule: Rule): boolean {
  const action = rule.action
  if (action.mode === 'mock') return false
  return (
    action.status === undefined &&
    action.body === undefined &&
    !action.delayMs &&
    action.failure === 'none' &&
    !action.headers?.set &&
    !action.headers?.remove?.length
  )
}
