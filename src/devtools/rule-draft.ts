/**
 * 规则编辑器里的「草稿」模型。
 *
 * 表单里数字要能留空、响应头要能一行行手打，直接绑到 Rule 上会处处别扭，
 * 所以中间隔一层 Draft：编辑期用字符串，保存时才换算成 Rule。
 * 这些换算和校验都是纯函数，可以脱离 React 单测。
 */

import { parseJson } from '../shared/json'
import { ANY_METHOD, type BodyMode, type Failure, type MockMode, type Rule } from '../shared/rules'
import type { PatternType } from '../shared/url-match'

export type Draft = {
  name: string
  patternType: PatternType
  urlPattern: string
  method: string
  mode: MockMode
  /** 留空 = 不改状态码。 */
  statusText: string
  /** 留空 = 不延迟。 */
  delayText: string
  failure: Failure
  bodyMode: BodyMode
  /** 关掉 = 不动响应体。 */
  bodyEnabled: boolean
  bodyText: string
  /** 每行一条 `Name: value`。 */
  headerSetText: string
  /** 每行一个名字。 */
  headerRemoveText: string
}

export type DraftField = 'urlPattern' | 'status' | 'delay' | 'body' | 'headers'
export type DraftIssue = { field: DraftField; message: string; blocking: boolean }

export function toDraft(rule: Rule): Draft {
  return {
    name: rule.name,
    patternType: rule.match.patternType,
    urlPattern: rule.match.urlPattern,
    method: rule.match.method || ANY_METHOD,
    mode: rule.action.mode,
    statusText: rule.action.status === undefined ? '' : String(rule.action.status),
    delayText: rule.action.delayMs ? String(rule.action.delayMs) : '',
    failure: rule.action.failure,
    bodyMode: rule.action.bodyMode,
    bodyEnabled: rule.action.body !== undefined,
    bodyText: rule.action.body?.text ?? '',
    headerSetText: formatHeaderSet(rule.action.headers?.set),
    headerRemoveText: (rule.action.headers?.remove ?? []).join('\n'),
  }
}

export function fromDraft(rule: Rule, draft: Draft): Rule {
  const set = parseHeaderSet(draft.headerSetText)
  const remove = draft.headerRemoveText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const hasHeaderPatch = Object.keys(set).length > 0 || remove.length > 0

  return {
    ...rule,
    name: draft.name.trim(),
    match: {
      patternType: draft.patternType,
      urlPattern: draft.urlPattern.trim(),
      method: draft.method,
    },
    action: {
      mode: draft.mode,
      status: draft.statusText.trim() === '' ? undefined : Number(draft.statusText),
      delayMs: draft.delayText.trim() === '' ? 0 : Number(draft.delayText),
      failure: draft.failure,
      bodyMode: draft.bodyMode,
      body: draft.bodyEnabled ? { text: draft.bodyText } : undefined,
      headers: hasHeaderPatch ? { set, remove } : undefined,
    },
  }
}

export function validateDraft(draft: Draft): DraftIssue[] {
  const issues: DraftIssue[] = []

  const pattern = draft.urlPattern.trim()
  if (!pattern) {
    issues.push({ field: 'urlPattern', message: '必填', blocking: true })
  } else if (draft.patternType === 'regex') {
    try {
      new RegExp(pattern)
    } catch (error) {
      issues.push({
        field: 'urlPattern',
        message: `正则非法：${error instanceof Error ? error.message : String(error)}`,
        blocking: true,
      })
    }
  }

  if (draft.statusText.trim() !== '') {
    const status = Number(draft.statusText)
    // Fetch 规范只允许构造 200–599：1xx 和 0 造不出来，不必让用户白试。
    if (!Number.isInteger(status) || status < 200 || status > 599) {
      issues.push({
        field: 'status',
        message: '只能是 200–599 的整数（规范不允许构造其他状态码）',
        blocking: true,
      })
    }
  }

  if (draft.delayText.trim() !== '') {
    const delay = Number(draft.delayText)
    if (!Number.isFinite(delay) || delay < 0) {
      issues.push({ field: 'delay', message: '必须是不小于 0 的数字', blocking: true })
    }
  }

  if (draft.bodyEnabled && draft.bodyMode === 'merge-json') {
    const parsed = parseJson(draft.bodyText)
    if (!parsed.ok) {
      issues.push({
        field: 'body',
        message: '不是合法 JSON，合并会退化成整段替换',
        blocking: false,
      })
    }
  }

  for (const line of draft.headerSetText.split('\n')) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.includes(':')) {
      issues.push({
        field: 'headers',
        message: `「${trimmed}」少了冒号，格式应为 Name: value`,
        blocking: false,
      })
      break
    }
  }

  return issues
}

export function parseHeaderSet(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf(':')
    if (index === -1) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

export function formatHeaderSet(set: Record<string, string> | undefined): string {
  if (!set) return ''
  return Object.entries(set)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}
