import { describe, expect, it } from 'vitest'
import {
  ANY_METHOD,
  createRule,
  matchRule,
  patternFromUrl,
  type Rule,
} from '../src/shared/rules'

function rule(patch: Parameters<typeof createRule>[0]): Rule {
  return createRule(patch)
}

describe('matchRule', () => {
  it('返回第一条启用的命中规则', () => {
    const first = rule({ name: 'first', match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: ANY_METHOD } })
    const second = rule({ name: 'second', match: { patternType: 'contains', urlPattern: 'list', method: ANY_METHOD } })

    const hit = matchRule([first, second], { url: 'https://x.com/list', method: 'GET' })
    expect(hit?.name).toBe('first')
  })

  it('跳过停用的规则，让后面的规则顶上', () => {
    const disabled = rule({
      name: 'off',
      enabled: false,
      match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: ANY_METHOD },
    })
    const enabled = rule({
      name: 'on',
      match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: ANY_METHOD },
    })

    expect(matchRule([disabled, enabled], { url: 'https://x.com/a', method: 'GET' })?.name).toBe('on')
  })

  it('没有命中时返回 null', () => {
    const only = rule({ match: { patternType: 'wildcard', urlPattern: 'https://y.com/*', method: ANY_METHOD } })
    expect(matchRule([only], { url: 'https://x.com/a', method: 'GET' })).toBeNull()
  })

  it('ANY 不限方法，大小写不敏感', () => {
    const any = rule({ match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: ANY_METHOD } })
    expect(matchRule([any], { url: 'https://x.com/a', method: 'POST' })?.id).toBe(any.id)
  })

  it('限定方法时必须一致', () => {
    const postOnly = rule({ match: { patternType: 'wildcard', urlPattern: 'https://x.com/*', method: 'post' } })
    expect(matchRule([postOnly], { url: 'https://x.com/a', method: 'POST' })).not.toBeNull()
    expect(matchRule([postOnly], { url: 'https://x.com/a', method: 'GET' })).toBeNull()
  })

  it('URL 模式为空的规则不会命中任何请求', () => {
    const blank = rule({ match: { patternType: 'wildcard', urlPattern: '', method: ANY_METHOD } })
    expect(matchRule([blank], { url: 'https://x.com/a', method: 'GET' })).toBeNull()
  })
})

describe('createRule', () => {
  it('深合并 match / action，没给的字段保留默认值', () => {
    const base = createRule()
    const created = { ...base, action: { ...base.action, status: 500 } }
    expect(created.action.status).toBe(500)
    expect(created.action.bodyMode).toBe('merge-json')
    expect(created.action.failure).toBe('none')
    expect(created.match.method).toBe(ANY_METHOD)
  })

  it('每次生成的 id 都不同', () => {
    expect(createRule().id).not.toBe(createRule().id)
  })
})

describe('patternFromUrl', () => {
  it('丢掉 query —— 带时间戳/分页参数的 query 会让规则永远命中不了', () => {
    expect(patternFromUrl('https://api.x.com/v1/list?page=2&_t=1730000')).toBe(
      'https://api.x.com/v1/list*',
    )
  })

  it('保留 hash 之前的部分', () => {
    expect(patternFromUrl('https://api.x.com/v1/list#frag')).toBe('https://api.x.com/v1/list*')
  })

  it('解析不了的字符串原样返回', () => {
    expect(patternFromUrl('not a url')).toBe('not a url')
  })
})
