import { describe, expect, it } from 'vitest'
import { compilePattern, matchesUrl } from '../src/shared/url-match'

describe('compilePattern', () => {
  it('把空模式当作无效，而不是匹配一切', () => {
    expect(compilePattern('wildcard', '')).toBeNull()
    expect(compilePattern('wildcard', '   ')).toBeNull()
  })

  it('返回 null 表示不匹配，而不是抛错', () => {
    expect(compilePattern('regex', '[')).toBeNull()
  })
})

describe('通配匹配', () => {
  it('整体锚定，不做子串匹配', () => {
    expect(matchesUrl('wildcard', '/api/list', 'https://x.com/api/list')).toBe(false)
    expect(matchesUrl('wildcard', 'https://x.com/api/list', 'https://x.com/api/list')).toBe(true)
  })

  it('* 匹配任意长度', () => {
    expect(matchesUrl('wildcard', 'https://x.com/api/*', 'https://x.com/api/list')).toBe(true)
    expect(
      matchesUrl('wildcard', 'https://x.com/api/*', 'https://x.com/api/v1/list?page=2'),
    ).toBe(true)
  })

  it('? 只匹配单个字符', () => {
    expect(matchesUrl('wildcard', 'https://x.com/v?/list', 'https://x.com/v1/list')).toBe(true)
    expect(matchesUrl('wildcard', 'https://x.com/v?/list', 'https://x.com/v12/list')).toBe(false)
  })

  it('正则元字符在通配模式下是字面量', () => {
    // 不转义的话这里的 . 会变成通配，把 xcom 也放进来。
    expect(matchesUrl('wildcard', 'https://x.com/a', 'https://x.com/a')).toBe(true)
    expect(matchesUrl('wildcard', 'https://x.com/a', 'https://xXcom/a')).toBe(false)
    expect(matchesUrl('wildcard', 'https://x.com/a?b=1', 'https://x.com/a?b=1')).toBe(true)
    expect(matchesUrl('wildcard', 'https://x.com/a?b=1', 'https://x.com/a?b=2')).toBe(false)
  })
})

describe('包含匹配', () => {
  it('不锚定，任何位置命中即可', () => {
    expect(matchesUrl('contains', '/api/', 'https://x.com/api/list')).toBe(true)
    expect(matchesUrl('contains', '/api/', 'https://x.com/other')).toBe(false)
  })

  it('同样把正则元字符当字面量', () => {
    expect(matchesUrl('contains', 'a.b', 'https://x.com/axb')).toBe(false)
    expect(matchesUrl('contains', 'a.b', 'https://x.com/a.b')).toBe(true)
  })
})

describe('正则匹配', () => {
  it('按原样编译', () => {
    expect(matchesUrl('regex', '^https://x\\.com/v\\d+/', 'https://x.com/v2/list')).toBe(true)
    expect(matchesUrl('regex', '^https://x\\.com/v\\d+/', 'https://x.com/list')).toBe(false)
  })

  it('非法正则不匹配任何东西，也不抛错', () => {
    expect(matchesUrl('regex', '[', 'https://x.com/')).toBe(false)
  })

  it('同一个正则被重复使用时不带 lastIndex 状态', () => {
    // 若误用了带 g 标志的正则，第二次调用会从上次位置继续，这里就是在钉这一点。
    const pattern = '(?<n>list)'
    expect(matchesUrl('regex', pattern, '/api/list/list')).toBe(true)
    expect(matchesUrl('regex', pattern, '/api/list/list')).toBe(true)
  })
})
