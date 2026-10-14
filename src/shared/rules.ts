/** 规则的数据模型与匹配决策。纯函数，无 chrome 依赖，便于单测。 */

import type { PatternType } from './url-match'
import { matchesUrl } from './url-match'

/** 命中规则后怎么处理这个请求。 */
export type MockMode =
  /** 穿透改写：真实请求照发，拿到响应后在最后一刻改掉。 */
  | 'rewrite'
  /** 直接伪造：完全不发请求，现造一个响应。 */
  | 'mock'

/** 响应体怎么处理。 */
export type BodyMode =
  /** 整段替换。 */
  | 'replace'
  /** 深合并到真实响应上，其余字段保持真实。 */
  | 'merge-json'

export type Failure =
  | 'none'
  /** 网络层失败：fetch 抛 TypeError，和真的断网表现一致。 */
  | 'network-error'
  /** 超时：等待 delayMs 后以 AbortError 失败。 */
  | 'timeout'

export type RuleMatch = {
  patternType: PatternType
  urlPattern: string
  /** 具体方法名，或 'ANY' 表示不限。 */
  method: string
}

export type RuleAction = {
  mode: MockMode
  /** 不改状态码时留空。 */
  status?: number
  headers?: { set?: Record<string, string>; remove?: string[] }
  /** 留空表示不动响应体。 */
  body?: { text: string }
  bodyMode: BodyMode
  delayMs?: number
  failure: Failure
}

export type Rule = {
  id: string
  name: string
  enabled: boolean
  match: RuleMatch
  action: RuleAction
  createdAt: number
}

export const ANY_METHOD = 'ANY'

export const HTTP_METHODS = [
  ANY_METHOD,
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const

export function createRule(patch: Partial<Rule> = {}): Rule {
  const base: Rule = {
    id: newId(),
    name: '',
    enabled: true,
    match: { patternType: 'wildcard', urlPattern: '', method: ANY_METHOD },
    action: { mode: 'rewrite', bodyMode: 'merge-json', failure: 'none' },
    createdAt: Date.now(),
  }
  return {
    ...base,
    ...patch,
    match: { ...base.match, ...patch.match },
    action: { ...base.action, ...patch.action },
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `r_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export type MatchInput = { url: string; method: string }

/**
 * 按列表顺序返回第一条命中的启用规则；没有则返回 null。
 * 顺序即优先级 —— 列表里排前面的先赢。
 */
export function matchRule(rules: Rule[], input: MatchInput): Rule | null {
  for (const rule of rules) {
    if (!rule.enabled) continue
    if (!methodMatches(rule.match.method, input.method)) continue
    if (!matchesUrl(rule.match.patternType, rule.match.urlPattern, input.url)) continue
    return rule
  }
  return null
}

function methodMatches(ruleMethod: string, requestMethod: string): boolean {
  const want = ruleMethod.trim().toUpperCase()
  if (want === ANY_METHOD || want === '') return true
  return want === requestMethod.trim().toUpperCase()
}

/** 从一条具体请求反推一条通配模式，供「以此请求建规则」用。 */
export function patternFromUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  // 保留 origin + pathname，丢掉 query 和 hash —— query 里常带时间戳/分页参数，
  // 带上它规则几乎永远命中不了。
  return `${parsed.origin}${parsed.pathname}*`
}
