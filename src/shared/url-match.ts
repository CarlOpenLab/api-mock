/** URL 匹配：通配 / 包含 / 正则。纯函数，无副作用，便于单测。 */

export type PatternType = 'wildcard' | 'contains' | 'regex'

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g

function escapeRegex(input: string): string {
  return input.replace(REGEX_SPECIALS, '\\$&')
}

/**
 * 把规则里的模式编译成正则。模式为空或正则非法时返回 null，
 * 调用方应把 null 当作「不匹配」而不是「匹配所有」。
 */
export function compilePattern(type: PatternType, pattern: string): RegExp | null {
  const raw = pattern.trim()
  if (!raw) return null

  try {
    if (type === 'regex') return new RegExp(raw)
    if (type === 'contains') return new RegExp(escapeRegex(raw))
    // 通配：* 匹配任意长度，? 匹配单个字符。整体锚定，避免子串误命中。
    const body = escapeRegex(raw).replace(/\*/g, '.*').replace(/\?/g, '.')
    return new RegExp(`^${body}$`)
  } catch {
    return null
  }
}

/** 用模式校验 URL 是否匹配。 */
export function matchesUrl(type: PatternType, pattern: string, url: string): boolean {
  const re = compilePattern(type, pattern)
  if (!re) return false
  re.lastIndex = 0
  return re.test(url)
}
